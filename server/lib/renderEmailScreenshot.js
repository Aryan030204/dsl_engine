const fs = require('fs');
const net = require('net');

// Renders the exact email HTML to images with a headless browser, so a Telegram
// report looks like the email it accompanies. Opt-in (TELEGRAM_RENDER_MODE=
// email_screenshot); callers fall back to renderTelegramImage.js when this throws.
//
// Env:
//   CHROME_PATH / PUPPETEER_EXECUTABLE_PATH  browser binary (auto-detected if unset)
//   CHROME_NO_SANDBOX=true                   needed when running as root in a container
//   EMAIL_SCREENSHOT_TIMEOUT_MS              per-render budget (default 20000)
//   EMAIL_SCREENSHOT_CONCURRENCY             parallel renders (default 2)

const VIEWPORT_WIDTH = 760;
const SCALE = 1.5;
// Telegram photos need width + height <= 10000 px; 3000 css px * 1.5 = 4500 px tall.
const MAX_SLICE_CSS_HEIGHT = 3000;
const MAX_TOTAL_CSS_HEIGHT = 15000;
const MAX_IMAGE_BYTES = 9 * 1024 * 1024;
const IDLE_CLOSE_MS = 60 * 1000;

const BROWSER_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

let browserPromise = null;
let idleTimer = null;
let active = 0;
const waiters = [];

function findBrowserPath() {
  const configured = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured) return configured;
  return BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

function getBrowser() {
  if (!browserPromise) {
    const executablePath = findBrowserPath();
    if (!executablePath) {
      return Promise.reject(new Error('no Chrome/Chromium found; set CHROME_PATH'));
    }
    const puppeteer = require('puppeteer-core');
    const args = ['--disable-gpu', '--disable-dev-shm-usage'];
    if (process.env.CHROME_NO_SANDBOX === 'true') args.push('--no-sandbox', '--disable-setuid-sandbox');
    browserPromise = puppeteer.launch({ executablePath, headless: true, args })
      .then((browser) => {
        browser.on('disconnected', () => { browserPromise = null; });
        return browser;
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }
  return browserPromise;
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (active > 0 || !browserPromise) return;
    const pending = browserPromise;
    browserPromise = null;
    pending.then((browser) => browser.close()).catch(() => {});
  }, IDLE_CLOSE_MS);
  idleTimer.unref();
}

async function acquire() {
  const limit = Math.max(1, Number(process.env.EMAIL_SCREENSHOT_CONCURRENCY) || 2);
  if (active >= limit) await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function release() {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
  if (active === 0) scheduleIdleClose();
}

// The email HTML is self-contained except for an optional brand logo URL. Only
// public http(s) images may load, so a configured logo URL can't reach internal hosts.
function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  const kind = net.isIP(host);
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (kind === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80');
  return false;
}

function isAllowedRequest(url, isNavigation) {
  if (isNavigation) return url === 'about:blank' || url.startsWith('data:');
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:') return true;
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !isPrivateHost(parsed.hostname);
  } catch (error) {
    return false;
  }
}

async function captureSlices(page, html) {
  await page.setViewport({ width: VIEWPORT_WIDTH, height: 900, deviceScaleFactor: SCALE });
  await page.setContent(html, { waitUntil: 'load', timeout: 10000 });
  const height = await page.evaluate(() => Math.ceil(Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0
  )));
  if (!height) throw new Error('email rendered with no content');
  const totalHeight = Math.min(height, MAX_TOTAL_CSS_HEIGHT);

  const images = [];
  for (let y = 0; y < totalHeight; y += MAX_SLICE_CSS_HEIGHT) {
    const sliceHeight = Math.min(MAX_SLICE_CSS_HEIGHT, totalHeight - y);
    const buffer = await page.screenshot({
      type: 'jpeg',
      quality: 88,
      captureBeyondViewport: true,
      clip: { x: 0, y, width: VIEWPORT_WIDTH, height: sliceHeight }
    });
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`email screenshot exceeds ${MAX_IMAGE_BYTES} bytes`);
    images.push(`data:image/jpeg;base64,${Buffer.from(buffer).toString('base64')}`);
  }
  return images;
}

// Returns an array of "data:image/jpeg;base64,..." pages (one unless the email is
// taller than MAX_SLICE_CSS_HEIGHT), in reading order.
async function renderEmailScreenshots({ html }) {
  if (!html || typeof html !== 'string') throw new Error('no email HTML to screenshot');
  const timeoutMs = Number(process.env.EMAIL_SCREENSHOT_TIMEOUT_MS) || 20000;

  await acquire();
  let page;
  let timer;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (isAllowedRequest(request.url(), request.isNavigationRequest())) request.continue();
      else request.abort();
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`email screenshot timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return await Promise.race([captureSlices(page, html), timeout]);
  } finally {
    clearTimeout(timer);
    if (page) await page.close().catch(() => {});
    release();
  }
}

async function closeEmailScreenshotBrowser() {
  clearTimeout(idleTimer);
  const pending = browserPromise;
  browserPromise = null;
  if (pending) await pending.then((browser) => browser.close()).catch(() => {});
}

function isEmailScreenshotMode() {
  return process.env.TELEGRAM_RENDER_MODE === 'email_screenshot';
}

module.exports = {
  renderEmailScreenshots,
  closeEmailScreenshotBrowser,
  isEmailScreenshotMode,
  isAllowedRequest,
  isPrivateHost
};

const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'datum-logo.png');
const LOGO_CID = 'konvert-apps-brand-logo';
let logoDataUri;

function getLogoDataUri() {
  if (!logoDataUri) {
    logoDataUri = `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}`;
  }
  return logoDataUri;
}

function applyEmailFooter(message = {}) {
  const html = String(message.html || '');
  const text = String(message.text || '');
  if (html.includes('data-konvert-email-footer')) return { ...message, html, text };

  const footer = `<table data-konvert-email-footer="true" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;margin:0 auto;border-collapse:collapse;"><tr><td align="left" valign="middle" style="padding:18px 24px;"><img src="${getLogoDataUri()}" alt="Datum - Your data. Decoded." width="180" style="display:block;width:180px;height:auto;border:0;"></td><td align="right" valign="middle" style="padding:18px 24px;font-family:Arial,sans-serif;font-size:12px;color:#64748b;white-space:nowrap;">Powered by Konvert Apps</td></tr></table>`;
  const withFooter = /<\/body\s*>/i.test(html)
    ? html.replace(/<\/body\s*>/i, `${footer}</body>`)
    : `${html}${footer}`;
  const footerText = 'Powered by Konvert Apps';
  return { ...message, html: withFooter, text: text.includes(footerText) ? text : [text, footerText].filter(Boolean).join('\n\n') };
}

// When EMAIL_ASSET_BASE_URL is set (the public address of this server), the logo is linked from the
// /email-assets route so it shows inside the body with no attachment. Without it, it falls back to an inline attachment.
function prepareInlineLogo(html) {
  const image = getLogoDataUri();
  if (!String(html || '').includes(image)) return { html, attachments: [] };
  const baseUrl = String(process.env.EMAIL_ASSET_BASE_URL || '').trim().replace(/\/+$/, '');
  if (baseUrl) {
    return { html: String(html).split(image).join(`${baseUrl}/email-assets/datum-logo.png`), attachments: [] };
  }
  return {
    html: String(html).split(image).join(`cid:${LOGO_CID}`),
    attachments: [{ filename: 'datum-logo.png', content: Buffer.from(image.split(',')[1], 'base64'), cid: LOGO_CID, contentDisposition: 'inline' }]
  };
}

module.exports = { applyEmailFooter, prepareInlineLogo, LOGO_PATH };

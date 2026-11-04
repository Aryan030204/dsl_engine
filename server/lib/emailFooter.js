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

  // The logo keeps a fixed pixel size (and its exact height, with the brand name as its alt text, so it still
  // looks right where images are blocked, e.g. in Spam) (mail apps handle that reliably, including the inline attachment
  // version) and is kept small enough that the text still fits beside it on a phone, where it wraps at
  // its spaces. The <style> rule only trims the padding to match the content on small screens.
  const footerStyle = '<style>@media only screen and (max-width:600px){.konvert-footer-cell{padding:14px 16px !important;}}</style>';
  const footer = `<table data-konvert-email-footer="true" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:760px;margin:0 auto;border-collapse:collapse;background:#ffffff;"><tr><td class="konvert-footer-cell" align="left" valign="middle" bgcolor="#ffffff" style="padding:18px 30px;background:#ffffff;"><img src="${getLogoDataUri()}" alt="Datum" width="140" height="46" style="display:block;width:140px;height:46px;border:0;font-family:Arial,sans-serif;font-size:26px;line-height:46px;font-weight:700;color:#4a9b82;"></td><td class="konvert-footer-cell" align="right" valign="middle" bgcolor="#ffffff" style="padding:18px 30px;background:#ffffff;font-family:Arial,sans-serif;font-size:12px;line-height:1.4;color:#64748b;">Powered by Konvert Apps</td></tr></table>`;
  const withStyle = /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, `${footerStyle}</head>`) : html;
  const withFooter = /<\/body\s*>/i.test(withStyle)
    ? withStyle.replace(/<\/body\s*>/i, `${footer}</body>`)
    : `${withStyle}${footerStyle}${footer}`;
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

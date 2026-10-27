const DEFAULT_EMAIL_BRANDING = Object.freeze({
  displayName: 'Datum',
  logoUrl: '',
  tagline: 'Your data. Decoded.',
  primaryColor: '#66c61c',
  footerText: 'Powered by Konvert apps',
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validateEmailBranding(value, label = 'email branding') {
  const errors = [];
  if (value === undefined) return errors;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${label} must be an object`];
  }

  const allowed = new Set(['displayName', 'logoUrl', 'tagline', 'primaryColor', 'footerText']);
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) errors.push(`${label} contains unsupported field ${key}`);
  });

  ['displayName', 'tagline', 'footerText'].forEach((field) => {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].trim() === '')) {
      errors.push(`${label}.${field} must be a non-empty string`);
    }
  });
  if (value.primaryColor !== undefined && !HEX_COLOR_RE.test(value.primaryColor)) {
    errors.push(`${label}.primaryColor must be a six-digit hex color`);
  }
  if (value.logoUrl !== undefined) {
    if (typeof value.logoUrl !== 'string') {
      errors.push(`${label}.logoUrl must be an HTTPS URL`);
    } else if (value.logoUrl && !/^https:\/\//i.test(value.logoUrl)) {
      errors.push(`${label}.logoUrl must be an HTTPS URL`);
    }
  }
  return errors;
}

function resolveEmailBranding(tenantBranding, override) {
  const resolved = { ...DEFAULT_EMAIL_BRANDING };
  for (const source of [tenantBranding, override]) {
    if (!source || typeof source !== 'object') continue;
    ['displayName', 'tagline', 'footerText'].forEach((field) => {
      if (typeof source[field] === 'string' && source[field].trim()) resolved[field] = source[field].trim();
    });
    if (typeof source.primaryColor === 'string' && HEX_COLOR_RE.test(source.primaryColor)) {
      resolved.primaryColor = source.primaryColor;
    }
    if (typeof source.logoUrl === 'string' && /^https:\/\//i.test(source.logoUrl)) {
      resolved.logoUrl = source.logoUrl;
    }
  }
  return resolved;
}

module.exports = {
  DEFAULT_EMAIL_BRANDING,
  HEX_COLOR_RE,
  validateEmailBranding,
  resolveEmailBranding,
};

// Small color helpers for the report layouts that derive their shades from a tenant's brand color.

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

function parse(hex) {
  const match = HEX_RE.exec(String(hex || ''));
  if (!match) return null;
  const value = match[1];
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
}

function toHex(channels) {
  return `#${channels.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

// A pale version of the color: `strength` is how much of the color is kept (0 = white, 1 = the color).
// tint('#66c61c', 0.08) -> '#f3faed'
function tint(hex, strength) {
  const rgb = parse(hex);
  if (!rgb) return '#ffffff';
  const keep = Math.max(0, Math.min(1, strength));
  return toHex(rgb.map((c) => 255 - (255 - c) * keep));
}

// A darker version of the color: `amount` is how much to darken (0 = unchanged, 1 = black).
// shade('#66c61c', 0.4) -> '#3d7711'
function shade(hex, amount) {
  const rgb = parse(hex);
  if (!rgb) return '#000000';
  const factor = 1 - Math.max(0, Math.min(1, amount));
  return toHex(rgb.map((c) => c * factor));
}

module.exports = { tint, shade };

const MAX_SKUS_SHOWN = 3;

// A product can carry many variant SKUs; the report shows the first few and a count
// of the rest instead of one long joined string. `skuCount` is the true distinct
// count from SQL, since the joined list itself can be cut off by group_concat_max_len.
function summarizeSkus(skuList, skuCount, maxShown = MAX_SKUS_SHOWN) {
  const skus = String(skuList || '')
    .split(',')
    .map((sku) => sku.trim())
    .filter(Boolean);
  if (!skus.length) return '—';
  const total = Math.max(Number(skuCount) || 0, skus.length);
  const shown = skus.slice(0, maxShown);
  const hidden = total - shown.length;
  return hidden > 0 ? `${shown.join(', ')} +${hidden} more` : shown.join(', ');
}

module.exports = { summarizeSkus, MAX_SKUS_SHOWN };

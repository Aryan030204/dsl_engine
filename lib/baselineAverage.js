// Day-averaged baselines. A schedule in "today vs 7-day average" mode asks for the same time-of-day range on each
// of the N days before today. The metric node runs the normal metric query once per baseline day and this module
// folds those daily rows into the `baseline_*` fields the node already reads.
//
// Legacy parity (cod_monitor / discount_monitor):
//   - sums (orders, sessions, sales, discount amount, ...) are averaged over the days that had orders, `n = days || 1`;
//   - COD / prepaid / partial % are the AVERAGE OF THE DAILY percentages;
//   - discount rate and usage rate are the ratio of the averaged sums.

const SUM_FIELDS = [
  'sessions', 'atc_sessions', 'adjusted_sessions', 'orders',
  'cod_orders', 'ppcod_orders', 'prepaid_orders',
  'sales', 'sales_orders',
  'discount_orders', 'discounted_orders', 'discount_amount', 'gross_sales', 'unique_discount_codes'
];

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : null);

function mean(values) {
  const usable = values.filter((value) => value != null && Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

// dayRows: one metric-query row per baseline day, read through its `current_*` columns.
function averageBaselineRows(dayRows) {
  const rows = Array.isArray(dayRows) ? dayRows : [];
  const days = rows.filter((row) => num(row.current_orders) > 0 || num(row.current_discount_orders) > 0);
  const n = days.length || 1;
  const averaged = { baseline_days_seen: days.length };

  for (const field of SUM_FIELDS) {
    const key = `current_${field}`;
    if (!rows.some((row) => row[key] !== undefined)) continue;
    averaged[`baseline_${field}`] = days.reduce((sum, row) => sum + num(row[key]), 0) / n;
  }

  const paymentTotal = (row) => num(row.current_cod_orders) + num(row.current_ppcod_orders) + num(row.current_prepaid_orders);
  if (rows.some((row) => row.current_cod_orders !== undefined)) {
    averaged.baseline_cod_pct = mean(days.map((row) => pct(num(row.current_cod_orders), paymentTotal(row))));
    averaged.baseline_prepaid_pct = mean(days.map((row) => pct(num(row.current_prepaid_orders), paymentTotal(row))));
    averaged.baseline_partial_pct = mean(days.map((row) => pct(num(row.current_ppcod_orders), paymentTotal(row))));
  }
  return averaged;
}

// Relative change: (current - baseline) / baseline * 100, null without a usable baseline.
function relativeDeltaPct(current, baseline) {
  if (current == null || baseline == null || !Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}

module.exports = { averageBaselineRows, relativeDeltaPct, pct };

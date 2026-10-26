# COD and Discount monitors

Ports of the legacy `cod_monitor` and `discount_monitor` scripts. Both are ordinary workflows
(`workflows/cod_monitor.json`, `workflows/discount_monitor.json`; import them from the workflow list) that use the state
engine unchanged: one finding value, thresholds `normal 1 / critical 2`, the engine's cooldowns and quiet hours.

## Schedule
Use the window mode **Today Until Scheduled Time vs 7-Day Average** (`day_to_date_vs_7day_average`). The current window
is midnight to the scheduled hour; the baseline is the same hours on each of the 7 days before today, averaged (a day
only counts if it had orders). Minutes of the schedule time are ignored (hour resolution). Other window modes still work,
with the single baseline window.

## Metrics added to Metric Compare
| Metric | Output (`current_*`, `baseline_*`, delta) |
|---|---|
| `cod_pct`, `prepaid_pct`, `partial_pct` | share of orders by payment type, %; baseline = average of the daily shares; `*_delta_pct` is relative |
| `discount_amount`, `gross_sales`, `discounted_orders`, `unique_discount_codes` | sums from `shopify_orders` (`SUM(discount_amount)`, `SUM(total_price)`); baseline = daily average |
| `discount_rate`, `usage_rate` | discount / gross sales and discounted orders / orders, %, ratios of the averaged sums |
| derived | `discount_amount_delta_pct`, `gross_sales_delta_pct`, `discount_vs_sales_gap_pct` |

## The two breakdown modes (dimension breakdown node, "Analysis Source")
- **COD share by product** (`payment_mix`): whitelisted `product_ids`; today's COD share vs the average of the daily
  shares; products need `min_orders` (20) orders on the day and `min_baseline_days` (4) baseline days. Writes
  `breakdowns.<key>` (all checked), `breakdowns.<key>_flagged` and `metrics.cod_alert_score`.
- **Discount drill-down** (`discount`): rules for rate spike (per-brand absolute % or relative +10), usage spike (+10),
  discount growth ahead of sales growth, and a new code (>= 15% of discounted orders, absent from the baseline). When
  something fires it also reports UTM source shares vs their usual share (flagged: share >= 5% and uplift >= 30%, max 2)
  and the top campaign and codes of each flagged source. Codes that look generated per order (> 15% unique) skip the code
  checks. Skips a brand under 50 orders so far. Writes `breakdowns.discount_*` and `metrics.discount_alert_score`.

## Alert score
Each rule is expressed as value / threshold, and the finding is the largest: 1 = at the legacy threshold (TRIGGERED), 2 =
double (CRITICAL, legacy's 2x). COD: `max(overall change / 7, worst product change / 11)`, rises only. No finding (an
inconclusive run) when there is not enough data.

## Differences from legacy
- One email per brand, no cross-brand digest.
- Emails use the performance report layout (max four tables), not the legacy HTML.
- COD per-product baseline uses the same time-of-day window as today (legacy used whole previous days).
- Recipients in the shipped JSON are the two addresses from the legacy emails; change `to` before going live.

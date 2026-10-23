# Daily dashboard report layout

A report layout for the Email / Messaging node (*Report Layout* -> **Daily dashboard report**,
preset `dashboard_report_v1`). The existing *Performance report* and *Inventory alert* layouts are unchanged.

Top to bottom: brand header, two large hero KPI cards, a strip of KPI cells, performer tables with a
share bar, an inventory-health block, and a footer.

## Template (everything is editable in the node's properties)
```
{ preset: 'dashboard_report_v1', headerLabel: 'Daily Report', heroCount: 2,
  period: { current: 'meta.window', comparison: 'meta.baselineWindow' },
  metrics: [ ...cards ],            // the first `heroCount` cards are large, the rest fill the strip
  tables:  [ { title, source, tone, limit, columns: [ { label, path, format, of? } ] } ],
  inventory: { enabled, title?, listTitle? } }
```
- **Cards**: same shape as the performance layout (`label`, `value` path, optional `change` path, `format`, `icon`).
  There is no limit on how many. The strip shows four per row and wraps.
- **Formats**: the usual ones plus `currency_whole` (rupees without decimals, for AOV) and, for table
  columns only, `share_bar`: the row's value as a share of the total at path `of` (default
  `metrics.current_sessions`), drawn as a bar and a percentage. Bars are scaled to the largest share in the
  whole report.
- **Tables**: `tone` colors the heading (positive = brand green, negative = red, neutral = dark).
- **Inventory block** (needs a Dimension Breakdown node in *Inventory coverage* mode that runs earlier in
  the chain, the same rule as other inventory data): product count, red / orange / green bar, counts, and the
  lowest-DOH products with SKU, DRR and DOH. DOH is colored by status; the product with the highest DRR gets
  the HIGHEST RUN RATE badge.

## Colors
Greens follow the tenant's brand color (`settings.emailBranding.primaryColor`, default `#66c61c`): the
hero tint, dot, share bars and pills use the color and its shades. Status colors are fixed (red `#dc2626`,
orange `#ea580c`, green `#059669`). Ink `#0f172a`, secondary gray `#4b5563`, hairlines `#e5e7eb`.

## Phones
Media queries (<= 600 px): header and hero cards stack, the strip becomes two per row, tables size to their
content. At <= 420 px the share bar is dropped (the percentage stays), and at <= 360 px text tightens.
Clients that ignore media queries keep the desktop layout. With `TELEGRAM_RENDER_MODE=email_screenshot`
Telegram receives a screenshot of this same email.

Code: `server/lib/renderDashboardEmail.js`, `server/lib/colorUtils.js`, validation in
`server/validation/workflowDefinition.js` (`validateDashboardTemplate`), editor defaults in
`ui/src/utils/reportTemplates.js` (`createDashboardTemplate`).

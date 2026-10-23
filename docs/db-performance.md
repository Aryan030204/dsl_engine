# Workflow query performance

## What the engine does now

- **Query timeout.** Every pooled connection gets `SET SESSION max_execution_time`, so MySQL kills a
  workflow SELECT that runs too long instead of letting it pile up. A killed query fails the run with
  `Query timed out after Ns (...)`.
  - `DB_QUERY_TIMEOUT_MS` (default `180000`, `0` disables)
  - `DB_SLOW_QUERY_MS` (default `5000`): queries slower than this are logged as
    `[QueryExecutor] slow query tenant=... type=... <ms>ms rows=...`. Failures are logged with their duration.
- **Payment-type order counts** (COD / PPCOD / Prepaid) are only queried when the metric_compare node
  lists `cod_orders`, `ppcod_orders` or `prepaid_orders`. Otherwise those columns come back as 0.
- **`shopify_orders.created_date` is `varchar(10)`.** It is compared as a string (`LEFT(?, 10)`), not with
  `DATE(?)`, so the `created_date` indexes are used. The metric query also adds a `created_date` range next to
  the exact `created_at` bounds (no index starts with `created_at`).
- **Hourly tables** (`date` + `hour` columns) add a plain `date` range in front of the exact
  `CONCAT(date, ' ', LPAD(hour, 2, '0'), ':00:00')` bounds so an index on `date` can be used.

Do **not** switch these filters to `created_dt`: it is a generated column (`CAST(created_at AS DATE)`) and is
NULL for rows that have no `created_at`, so those orders would silently disappear from the counts.

## Index changes for a DBA to review (not applied by the app)

Run on the primary, off-peak: the `shopify_orders` table has about 2M rows and these add write cost. Check
`SHOW INDEX` first in case an equivalent already exists. Replace `<tenant_db>` with each tenant database.

```sql
-- hour_wise_sales has no index at all.
ALTER TABLE <tenant_db>.hour_wise_sales ADD INDEX idx_hws_date_hour (date, hour);

-- Covering indexes for the per-dimension order counts (COUNT(DISTINCT order_name) GROUP BY dimension).
ALTER TABLE <tenant_db>.shopify_orders ADD INDEX idx_so_created_date_utm_source_order (created_date, utm_source, order_name);
ALTER TABLE <tenant_db>.shopify_orders ADD INDEX idx_so_created_date_product_order (created_date, product_id, order_name);
```

## Things outside the app

- If the database is a read replica, a long replication DDL (`CREATE TABLE IF NOT EXISTS ...`) can hold
  table metadata and stall other queries. That has to be resolved on the database side.
- `innodb_buffer_pool_size` was 1 GB when checked, small for several tenant databases of this size.

# Inventory report: ranking by sales (Redis)

The inventory breakdown node can rank its top products by **sales over the last 7 days** instead of
units sold. The sales ranking comes from Redis, is free of gift/bundle line items, and only picks *which*
products are analysed: stock, DRR and DOH still come from the `top_products_inventory` table.

## Turning it on
1. **`REDIS_URI`** in `.env` (`redis://` or `rediss://`). Restart the backend and worker after adding it.
2. **Tenant -> Shopify store**: Settings -> the tenant -> *Shopify store* (for example
   `ajmal-perfumes-india.myshopify.com`). Redis is keyed by store, so each tenant needs its own.
3. **Inventory node**: *Rank top products by* -> *Sales, last 7 days (from Redis)*.

A node without this setting keeps ranking by units sold, exactly as before.

## Where the data comes from
Key `inventory_top_product_sales:<store>.myshopify.com` (string, refreshed daily, about 33 h TTL):

```
{ window_start_date, window_end_date_exclusive, updated_at,
  products: [ { product_id, product_title, sales, rank, source_rows: [ { gross_sales, ... } ] } ] }
```

Redis holds **at most the top 20 products per store**, so a sales-ranked report analyses up to 20 products
(the node's *Top products to analyze* can only lower that). *Products analysed* and the Critical / Low stock /
Healthy counts therefore cover those products.

## Fallback
If the sales ranking cannot be used, the node ranks by units sold (the old behaviour) so the report still
goes out. It logs `[inventory] sales ranking unavailable ...` and records why in the run's context at
`scratch.inventoryReport.ranking_fallback_reason` (`ranking_source` is `"units"`). Reasons: no `REDIS_URI`,
tenant has no Shopify store, Redis unreachable or too slow, key missing or expired, unexpected data, data
older than 3 days, or none of the ranked products found in the inventory table.

In sales mode the report also carries `ranking_source: "sales"`, the sales window, and
`missing_from_inventory` (ranked products that have no row in the inventory table; they are skipped).
Each product gets `gross_sales` and `sales_rank`, so `gross_sales` can be used as a table column.

## Notes
- The first read after a restart is slow here (about 8-14 s: connect, auth, read); the connection is then
  kept and later reads take about 1 s. Timeouts are 30 s.
- Code: `lib/redisSales.js` (reader), `nodes/RecursiveDimensionBreakdownNode.js` (`runInventoryBreakdown`),
  `sql/QueryBuilder.js` (`buildInventoryProductQuery` with `productIds`).

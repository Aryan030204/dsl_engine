# Workflow Authoring Guide

This document is the repo-accurate reference for creating, editing, validating, running, and scheduling workflows in the DSL engine.

It is based on the current implementation in:

- `server/validation/workflowDefinition.js`
- `server/validation/runContext.js`
- `server/validation/productPartialDayCompatibility.js`
- `engine/WorkflowRunner.js`
- `nodes/*.js`
- `server/routes/workflows.js`
- `server/routes/runs.js`
- `server/routes/schedules.js`
- `scheduler/app/schedulerService.js`

## 1. Mental Model

A workflow is a versioned JSON definition stored in two records:

- `Workflow`: metadata such as `workflowId`, `latestVersion`, `isActive`, `scope`
- `WorkflowVersion`: the concrete `definitionJson` for one version

Execution model:

1. The engine starts at `definition.nodes[0]`
2. It executes one node at a time
3. Each node returns a `status`, optional `delta`, and optional `next`
4. `delta` is merged into the shared execution context
5. Execution stops when there is no `next`, a node terminates, or an error occurs

Important implications:

- The first item in the `nodes` array is the true entrypoint
- There is no separate explicit trigger node in runtime
- Cycles are rejected at runtime
- Nested workflow references are allowed, but capped

## 2. Top-Level JSON Shape

Minimum required fields:

```json
{
  "workflow_id": "wf_example_rca",
  "workflow_type": "root_cause_analysis",
  "version": "1.0",
  "trigger": {
    "type": "alert",
    "alertType": "cvr_drop",
    "brandScope": "single",
    "brandIds": ["brand_a"]
  },
  "nodes": []
}
```

Validation rules:

- `workflow_type` must be exactly `root_cause_analysis`
- `version` is required
- `nodes` must be a non-empty array
- `trigger` must be an object
- `workflow_id` is optional on create; the server auto-generates one if omitted

Server-side trigger normalization during create/version APIs:

- If `trigger.alertType` is missing, it falls back to `trigger.metric` or `default_alert`
- If `trigger.brandScope` is missing:
  - tenant workflows default to `single`
  - global workflows default to `global`
- If `brandScope` is `single` or `multiple` and `brandIds` is empty, the tenant id is injected
- `trigger.type` defaults to `alert`

This means older JSON examples that use `trigger.metric` still work through API creation, but the persisted validated shape should be thought of as `alertType` + `brandScope` + `brandIds`.

## 3. Trigger Rules

Supported trigger semantics in the definition validator:

```json
{
  "trigger": {
    "type": "alert",
    "alertType": "cvr_drop",
    "brandScope": "single",
    "brandIds": ["tenant_a"]
  }
}
```

Rules:

- `trigger.type`, if provided, must be `alert`
- `trigger.alertType` is required and must be a string
- `trigger.brandScope` must be one of:
  - `single`
  - `multiple`
  - `global`
- `trigger.brandIds` is required for `single` and `multiple`
- `trigger.brandIds` must be empty for `global`

Operational note:

- Trigger matching for event-driven runs is based on tenant/global active workflows and alert matching logic in the scheduler
- Manual runs do not use trigger matching, but the definition must still validate

## 4. Supported Node Types

Allowed node types:

- `validation`
- `metric_compare`
- `branch`
- `recursive_dimension_breakdown`
- `composite`
- `workflow_ref`
- `insight`

Every node must have:

- `id` as a unique string
- `type` as one of the supported values

Runtime limits:

- Total execution steps per run are capped at `100`
- Nested `workflow_ref` depth is capped at `8`

## 5. Node-by-Node Authoring Rules

### 5.1 `validation`

Minimum shape:

```json
{
  "id": "validate",
  "type": "validation",
  "checks": [
    { "field": "sessions", "condition": "current > 0" }
  ],
  "next": "compare"
}
```

Validator requirement:

- `checks` must be a non-empty array

Runtime reality:

- The current node implementation does not interpret `checks`
- It validates `context.meta.tenantId`, `context.meta.metric`, `context.meta.window`, and baseline presence
- It sets:
  - `metrics.data_valid = true`
  - `metrics.baseline_available = true|false`

Authoring advice:

- Keep `checks` populated for schema compatibility and future intent
- Do not rely on the current `checks` array to enforce business validation
- Use `on_fail.action = "terminate"` if failure should stop the workflow cleanly

### 5.2 `metric_compare`

Minimum shape:

```json
{
  "id": "compare",
  "type": "metric_compare",
  "metrics": ["orders", "sessions", "cvr"],
  "next": "route"
}
```

Validator requirement:

- `metrics` must be a non-empty array

Runtime behavior:

- Queries current and baseline aggregates
- Fails if result rows are missing
- Fails if current or baseline sessions are zero
- Writes these metrics into `context.metrics`:
  - `current_orders`, `baseline_orders`
  - `current_sessions`, `baseline_sessions`
  - `current_atc_sessions`, `baseline_atc_sessions`
  - `current_cvr`, `baseline_cvr`
  - `current_atc_rate`, `baseline_atc_rate`
  - `orders_delta_pct`, `sessions_delta_pct`, `atc_sessions_delta_pct`
  - `cvr_delta_pct`, `atc_rate_delta_pct`

Authoring advice:

- Put `metric_compare` before any branch or insight logic that reads delta metrics
- If downstream nodes depend on `cvr_delta_pct`, this node is effectively mandatory

### 5.3 `branch`

Supported rule families:

- Metric rules via `all` and `any`
- Breakdown existence rules via `any_in_breakdowns` or `all_in_breakdowns`
- Breakdown filtering rules via `filter_in_breakdowns`

Simple metric branch example:

```json
{
  "id": "route",
  "type": "branch",
  "rules": [
    {
      "all": [
        { "metric": "sessions_delta_pct", "op": "<", "value": -10 }
      ],
      "then": "breakdown"
    }
  ],
  "default": {
    "then": "insight"
  }
}
```

Validation rules:

- `rules` must be a non-empty array
- Condition `op` must be one of:
  - `>`
  - `>=`
  - `<`
  - `<=`
  - `==`
  - `!=`
- A single rule cannot define more than one of:
  - `any_in_breakdowns`
  - `all_in_breakdowns`
  - `filter_in_breakdowns`

Breakdown rule requirements:

- `dimension` is required
- `conditions` must be a non-empty array
- `limit`, if provided, must be a positive number
- `entry_logic`, if provided, must be `and` or `or`
- `filter_in_breakdowns.mode`, if provided, must be `any` or `all`
- `filter_in_breakdowns.match_scope`, if provided, must be `any` or `all`
- `filter_in_breakdowns.write_matches_to` is required

Runtime behavior worth remembering:

- The branch node requires `context.metrics` to exist
- Metric rules read `context.metrics[condition.metric]`
- Breakdown rules read `context.breakdowns[dimension]`
- On a `filter_in_breakdowns` match:
  - matching entries are written to `delta.breakdowns[write_matches_to]`
  - the first match is also written to `context.scratch.matched_breakdown`
- On an `any_in_breakdowns` match:
  - the matched entry is written to `context.scratch.matched_breakdown`
- If no rule matches and no `default.then` exists, the node fails

Authoring advice:

- Always define a `default.then` unless failure is intentional
- Use `filter_in_breakdowns.write_matches_to` when a later node needs a narrowed evidence set
- Keep condition metric names aligned with outputs from `metric_compare` or breakdown entries

### 5.4 `recursive_dimension_breakdown`

This is the most important authoring surface in the system.

Example:

```json
{
  "id": "source_breakdown",
  "type": "recursive_dimension_breakdown",
  "dimensions": ["utm_source", "utm_medium", "utm_campaign"],
  "base_metric": "cvr",
  "filter_mode": "drop",
  "rank_by": "delta",
  "rank_order": "desc",
  "stop_conditions": {
    "max_depth": 3,
    "min_sessions": 100,
    "min_impact_pct": 5,
    "top_k": 5
  },
  "output_key": "cvr_source_drops"
}
```

Allowed dimensions:

- `product_id`
- `utm_source`
- `utm_medium`
- `utm_campaign`
- `utm_content`
- `utm_term`
- `landing_page_path`
- `landing_page_type`
- `referrer_name`

Validation rules:

- Must define `dimensions` with at least one entry, or legacy `dimension`
- Each dimension must be from the allowed set
- `output_key`, if provided, must be a non-empty string
- `input_scope`, if provided, must be `global` or `breakdown`
- `input_scope = "breakdown"` requires `input_key`
- `input_key` and `output_key` cannot be the same string

Runtime defaults:

- `base_metric` defaults to `cvr`
- `rank_by` defaults to `delta`
- `rank_order` defaults to `desc`
- `filter_mode` defaults to `drop`
- `min_sessions_mode` defaults to `both_low`
- `input_scope` defaults to `global`
- `stop_conditions.max_depth` defaults to `1`
- `stop_conditions.top_k` defaults to `1`

What it does:

1. Runs one breakdown query per recursion level
2. Filters candidates based on session thresholds and metric availability
3. Keeps only drops or increases depending on `filter_mode`
4. Ranks candidates
5. Stores evidence in `context.breakdowns[output_key]`
6. Publishes summary metrics for the top-ranked evidence
7. Recurses by appending dimension filters

Metric behavior:

- For `base_metric = "cvr"`, candidates require valid current and baseline CVR and baseline CVR must be non-zero
- For `base_metric = "atc_rate"`, candidates require valid current and baseline ATC rate and baseline ATC rate must be non-zero
- For `base_metric = "sessions"` or `orders`, the logic does not require valid CVR for candidate inclusion

Threshold behavior:

- `min_sessions_mode = "both_low"` drops candidates only when both current and baseline are below threshold
- `min_sessions_mode = "either_low"` drops if either side is below threshold
- `min_sessions_mode = "baseline_only"` uses only baseline thresholding

Output behavior:

- If `output_key` is omitted, the engine auto-generates one using:
  - metric
  - primary dimension
  - filter mode
- Example generated keys:
  - `cvr_product_id_drops`
  - `orders_utm_campaign_increases`
- The node also emits top evidence metrics such as:
  - `top_dimension`
  - `top_value`
  - `top_display_value`
  - `top_current_sessions`
  - `top_baseline_sessions`
  - `top_current_orders`
  - `top_baseline_orders`
  - `top_cvr_delta_pct`

Important implementation details:

- `min_impact_pct` is accepted in JSON but is not currently enforced in node runtime
- If `output_key` is omitted, the primary dimension key may also be populated for backward compatibility
- `input_scope = "breakdown"` converts existing breakdown entries into one inherited filter:
  - it uses the first breakdown dimension it sees
  - it converts matched values into `operator: "="`
  - multiple values become an array value

Authoring advice:

- Prefer explicit `output_key` names; this makes branching and insight templates more stable
- Use `top_k > 1` only when downstream consumers are prepared for multiple evidence rows
- Treat `min_impact_pct` as documentary only until runtime implements it

### 5.5 `composite`

Example:

```json
{
  "id": "root_cause_pack",
  "type": "composite",
  "steps": ["source_breakdown", "campaign_breakdown"],
  "next": "final_insight"
}
```

Validation rule:

- `steps` must be a non-empty array

Runtime behavior:

- Executes each listed step in order
- Merges each step delta into the shared context immediately
- Ignores the child step's own `next` for composite flow control
- After all steps finish, continues to `composite.next`

Critical authoring rule:

- Do not rely on `next` inside nodes that are meant to be composite-only steps
- The composite drives the sequence, not the child node's `next`

### 5.6 `workflow_ref`

Example:

```json
{
  "id": "brand_specific_child",
  "type": "workflow_ref",
  "ref": {
    "workflow_id": "shared_breakdown_pack",
    "version": "3.2",
    "scope": "global"
  },
  "next": "final_insight"
}
```

Validation rules:

- `ref` is required
- `ref.workflow_id` is required
- `ref.version` is required
- `ref.scope`, if provided, must be `tenant` or `global`

Runtime behavior:

- Resolves the referenced workflow by tenant + scope rules
- Executes the nested workflow against the same shared context
- Propagates nested termination outward
- Fails if the referenced workflow is inactive or missing
- Detects reference cycles
- Enforces max nested depth `8`

Authoring advice:

- Always pin a version intentionally
- Use `scope: "global"` only when you need to force global resolution
- Remember that referenced workflows mutate the same metrics, breakdowns, filters, and scratch context

### 5.7 `insight`

Example:

```json
{
  "id": "final_insight",
  "type": "insight",
  "output_key": "cvr_product_drops",
  "template": {
    "summary": "CVR dropped by {{cvr_delta_pct_fmt}}. Top driver: {{dimension}} = {{value}}.",
    "details": [
      "Segment CVR: {{top_baseline_cvr_pct}} -> {{top_current_cvr_pct}} ({{top_cvr_delta_pct_fmt}})",
      "Sessions: {{top_baseline_sessions}} -> {{top_current_sessions}}"
    ]
  },
  "email": {
    "enabled": true,
    "subject": "Workflow alert for {{brand_name}}",
    "to": ["team@example.com"]
  }
}
```

Validation rules:

- `template` is required and must be an object or string
- `output_key`, if provided, must be a non-empty string
- `email`, if provided, must be an object
- `email.enabled`, if provided, must be boolean
- `email.subject`, if provided, must be a non-empty string
- `email.to`, if provided, must be an array
- If `email.enabled = true`, recipients must pass email validation

Runtime behavior:

- Flattens evidence from breakdowns
- If `output_key` is set, it prioritizes `context.breakdowns[output_key]`
- Otherwise it scans all breakdown evidence
- Prefers `product_id` evidence when available
- Uses `context.scratch.matched_breakdown` as the top evidence if a prior branch populated it
- Writes final result to `context.scratch.finalInsight`
- Writes detail rendering metadata to `context.scratch.finalInsightMeta`
- If `persist` exists, it also sets `context.scratch.persistedInsight`
- If email is enabled, it sends the rendered email and records `context.scratch.finalInsightEmail`
- If `template.details` was configured but every detail row renders empty, email delivery is skipped and `context.scratch.finalInsightEmail.status` is set to `skipped`

Template behavior:

- String templates become `{ summary: "...", details: [] }`
- Missing tokens in `summary` render as `unknown`
- Missing or unknown tokens in `details` cause that detail line to be dropped

Authoring advice:

- Set `output_key` when you want the insight to summarize a specific evidence family
- Keep summary templates resilient to missing tokens
- Use details only for tokens you know are available from prior nodes

### 5.8 `email`

Use a dedicated email node when delivery should be independent from insight generation. Existing `insight.email` configurations remain supported.

Insight example:

```json
{
  "id": "send_insight",
  "type": "email",
  "format": "insight",
  "to": ["team@example.com"],
  "subject": "{{meta.brandName}}: Workflow insight",
  "template": { "insightSource": "scratch.finalInsight" },
  "on_fail": { "action": "terminate", "reason": "Insight email failed" }
}
```

Report example:

```json
{
  "id": "send_report",
  "type": "email",
  "format": "report",
  "to": ["team@example.com"],
  "subject": "{{meta.brandName}}: Daily report",
  "template": {
    "preset": "performance_report_v1",
    "eyebrow": "UTM Source Report",
    "title": "Top & Bottom UTM Sources",
    "description": "Traffic and conversion performance by source.",
    "period": {
      "current": "meta.window",
      "comparison": "meta.baselineWindow"
    },
    "metrics": [
      {
        "label": "Sessions",
        "value": "metrics.current_sessions",
        "change": "metrics.sessions_delta_pct",
        "format": "integer",
        "icon": "sessions"
      }
    ],
    "tables": [
      {
        "title": "Top Sources",
        "source": "breakdowns.top_utm_sources",
        "tone": "positive",
        "limit": 3,
        "columns": [
          { "label": "Source", "path": "display_value", "format": "text" },
          { "label": "CVR", "path": "current.cvr", "format": "percent_ratio" }
        ]
      }
    ]
  }
}
```

Binding and runtime behavior:

- Context bindings are safe dot-separated paths; arbitrary expressions and HTML are not evaluated
- Report table sources must already exist as arrays in the run context
- Missing bindings fail the node; existing empty arrays render a `No data available` row
- Supported value formats are `text`, `integer`, `decimal`, `percent_ratio`, `percent`, and `delta_percent`
- Successful deliveries are recorded at `context.scratch.emailDeliveries.<node_id>`
- Dedicated email subjects render exactly as configured; legacy insight emails keep their tenant prefix
- Branding precedence is node override, then tenant `settings.emailBranding`, then platform defaults


## Connecting one node to several nodes (fan-out)

A node's `next` is one node id, or a list of ids:

```json
{ "id": "metrics", "type": "metric_compare", "metrics": ["sessions"], "next": ["utm_report", "inventory_report"] }
```

- **Every listed node runs.** They run one after another in the listed order, not at the same time, and each branch is
  followed to its end before the next one starts.
- **Joining.** If several branches lead into the same node, that node runs once, after every branch that can still
  reach it has finished (for example one email that shows results from two branches).
- **One shared context.** The branches share the run's context, so a later branch can read what an earlier one produced.
- **Failures.** A failing branch fails the run, and a `terminate` on_fail ends the whole run, the same as in a single chain.
- Limits: at most 10 targets per node; no repeats, no self-reference, and every id must be a node in the workflow.
  A branch (`type: branch`) still routes through its rules and default path, one target each, not through `next`.
- In the builder, draw another line from the same node to add a target; delete a line to remove one. A single line
  is still saved as a plain id.

## 6. `on_fail` Semantics

Nodes can define:

```json
{
  "on_fail": {
    "action": "terminate",
    "reason": "Human-readable reason"
  }
}
```

Runtime behavior:

- If a node returns `status = "fail"` and `on_fail.action = "terminate"`, the workflow terminates cleanly
- Otherwise the run throws and is marked failed

Use this when:

- No-data conditions are expected and should stop analysis without being treated as operational failure

## 7. Execution Context Contract

Manual run context must be an object with:

```json
{
  "meta": {
    "tenantId": "brand_a",
    "metric": "cvr",
    "timezone": "Asia/Kolkata",
    "window": {
      "start": "2026-03-26 00:00:00",
      "end": "2026-03-27 00:00:00"
    },
    "baselineWindow": {
      "start": "2026-03-25 00:00:00",
      "end": "2026-03-26 00:00:00"
    }
  },
  "filters": [],
  "metrics": {},
  "rootCausePath": [],
  "scratch": {}
}
```

Validation rules:

- `context.meta` is required
- `context.meta.tenantId` is required
- `context.meta.timezone` is resolved by the server and must be a supported IANA timezone
- `context.meta.window.start/end` are required
- `context.meta.baselineWindow.start/end` are required
- `baselineWindow.type` is explicitly not allowed
- Both windows must:
  - be valid SQL datetime strings
  - be hour-aligned
  - have `end > start`

Accepted datetime style:

- `YYYY-MM-DD HH:MM:SS`
- `YYYY-MM-DDTHH:MM:SS`

Required alignment:

- minutes must be `00`
- seconds must be `00`

Rerun note:

- `POST /runs` with `rerun: true` floors window and baseline endpoints down to the hour before validation

## 8. Merge Semantics

Every node writes a `delta`, which is merged by `MergeContext`.

Merge rules:

- `meta` is immutable and cannot be merged
- `filters` append
- `metrics` shallow-merge by key
- `rootCausePath` appends
- `scratch` is overwritten, not deep-merged
- `breakdowns[key]` appends to existing arrays

Critical implication:

- Multiple nodes writing `scratch` can replace each other's values unless they preserve prior fields themselves
- Breakdown arrays accumulate over time; they are not replaced

## 9. Partial-Day Analysis Rules

This is the most important limitation area when authoring workflows.

### 9.1 What counts as partial-day

A window is partial-day when:

- it is hour-aligned
- but it is not midnight-to-midnight across a whole number of days
- its boundaries have first been normalized into `context.meta.timezone`

Examples:

- `2026-03-27 00:00:00` to `2026-03-27 13:00:00` is partial-day
- `2026-03-26 00:00:00` to `2026-03-27 00:00:00` is full-day

### 9.2 Special routing paths

The query layer has three behaviors:

1. Partial-day `product_id`
2. Partial-day `landing_page_path`
3. Default daily path

Partial-day special handling exists only for:

- `product_id`
- `landing_page_path`

Everything else falls back to daily analysis logic.

### 9.3 Partial-day `product_id` constraints

For partial-day windows:

- only `product_id` filters are supported safely
- workflows are rejected if `product_id` appears after unsupported dimensions in a reachable recursive path

Invalid example:

```json
{
  "type": "recursive_dimension_breakdown",
  "dimensions": ["utm_source", "product_id"],
  "stop_conditions": { "max_depth": 2 }
}
```

Why invalid:

- partial-day product analysis cannot safely run after UTM dimensions

Valid fixes:

- put `product_id` first
- or reduce `max_depth` so the `product_id` level is never reached

### 9.4 Partial-day `landing_page_path` constraints

For partial-day windows:

- only `product_id` filters are supported safely
- `landing_page_path` can be first
- or it can be preceded only by `product_id`
- it cannot be preceded by UTM or referrer dimensions

Invalid examples:

- `utm_source -> landing_page_path`
- `utm_campaign -> landing_page_path`
- `referrer_name -> landing_page_path`

Valid example:

- `product_id -> landing_page_path`

### 9.5 Root filter constraints

If a manual run context includes `filters`, then for partial-day runs:

- partial-day product analysis rejects any filter dimension other than `product_id`
- partial-day landing-page analysis also rejects any filter dimension other than `product_id`

Practical consequence:

- A workflow that works for full-day windows can still be rejected for partial-day windows because of run filters or recursive dimension ordering

### 9.6 Authoring recommendations for partial-day-safe workflows

- Put `product_id` first if the workflow may ever be run on hourly windows
- Put `landing_page_path` first, or only after `product_id`
- Avoid UTM-first recursive chains if you expect partial-day execution
- Keep root filters to `product_id` for hourly-compatible runs

## 10. Schedules and Window Modes

Schedules are separate records attached to a workflow.

Schedule payload fields:

- `cronExpr`
- `timezone`
- `windowMode`
- `overlapPolicy`
- `retryPolicy`
- `isActive`
- `name`

Supported `windowMode` values:

- `previous_complete_day`
- `day_to_date_vs_previous_day`

### 10.1 `previous_complete_day`

If a scheduled run fires on March 27 in the schedule timezone:

- `window` = March 26 00:00 to March 27 00:00
- `baselineWindow` = March 25 00:00 to March 26 00:00

This mode is safest for daily workflows.

### 10.2 `day_to_date_vs_previous_day`

If a scheduled run fires at 13:37 local time:

- `window` = today 00:00 to today 13:00
- `baselineWindow` = yesterday 00:00 to yesterday 13:00

Important implementation details:

- Minutes are truncated to the top of the hour
- The current partial hour is excluded
- This mode intentionally produces partial-day windows

Critical edge case:

- If this mode fires at local hour `00`, then both windows become zero-length:
  - `00:00` to `00:00`
- That is not a useful analysis window and would fail manual run validation
- Avoid midnight cron schedules for `day_to_date_vs_previous_day`

Practical recommendation:

- Use top-of-hour daytime schedules for this mode, for example `0 8-23 * * *`

## 11. Cron Expression Support

Cron support is custom and expects exactly 5 fields:

- minute
- hour
- day
- month
- weekday

Supported forms in each field:

- `*`
- `*/n`
- `a-b`
- comma-separated explicit integers

Notable limitation:

- Validation is minimal and custom, not full cron-parser compatibility
- If you need unusual cron syntax, verify it against the implementation before relying on it

## 12. Overlap Policies

Supported overlap policies on schedules and queued runs:

- `queue_one_pending`
- `skip_if_running`
- `allow_parallel`

Behavior:

- `allow_parallel`: always queue
- `skip_if_running`: skip if an active run exists
- `queue_one_pending`: if a run is active:
  - queue one deferred run if none is pending
  - otherwise skip additional triggers

Use `queue_one_pending` as the safe default for expensive workflows.

## 13. Versioning and Scope

### 13.1 Tenant vs global

Workflow scope can be:

- tenant
- global

Resolution rules:

- Tenant workflow lookup happens first
- Global lookup is used as fallback when allowed
- `workflow_ref.scope = "tenant"` disables global fallback

### 13.2 Version creation

When creating a new version:

- `definition.workflow_id` must match the route `:workflowId`
- The new version becomes `latestVersion`
- If `definition.name` is present, workflow display name is updated too

Authoring advice:

- Treat versions as immutable snapshots
- Use explicit semantic version strings like `1.0`, `1.1`, `2.0`
- When using `workflow_ref`, decide whether child workflows should be pinned or updated intentionally

## 14. Runtime Failure Modes to Remember

Common reasons a workflow fails:

- node id missing or duplicated
- unsupported node type
- branch rule has no default and nothing matches
- metric compare returns no rows
- metric compare gets zero current or baseline sessions
- recursive breakdown has no valid dimension
- recursive breakdown with `input_scope = "breakdown"` cannot find `input_key`
- workflow reference is missing, inactive, or cyclic
- execution exceeds step limit
- partial-day compatibility validation rejects the run

## 15. Practical Authoring Checklist

- Start the `nodes` array with the real entrypoint node
- Always include `workflow_type = "root_cause_analysis"`
- Give every node a unique `id`
- Put `metric_compare` before any node that branches on global deltas
- Always give `branch` a `default.then`, unless a failure is desired
- Use explicit `output_key` values on breakdown nodes
- Keep `composite.steps` authoritative; do not rely on child `next`
- Pin `workflow_ref.version` intentionally
- Remember that `scratch` overwrites, while `breakdowns` append
- Design recursive dimensions to be safe for partial-day if the workflow may run hourly
- Avoid midnight schedules with `day_to_date_vs_previous_day`

## 16. Good Example

```json
{
  "workflow_id": "wf_cvr_drop_rca",
  "workflow_type": "root_cause_analysis",
  "version": "1.0",
  "name": "CVR Drop RCA",
  "trigger": {
    "type": "alert",
    "alertType": "cvr_drop",
    "brandScope": "single",
    "brandIds": ["brand_a"]
  },
  "nodes": [
    {
      "id": "validate",
      "type": "validation",
      "checks": [
        { "field": "sessions", "condition": "current > 0" }
      ],
      "on_fail": {
        "action": "terminate",
        "reason": "Missing baseline or invalid input"
      },
      "next": "compare"
    },
    {
      "id": "compare",
      "type": "metric_compare",
      "metrics": ["orders", "sessions", "cvr"],
      "next": "route"
    },
    {
      "id": "route",
      "type": "branch",
      "rules": [
        {
          "all": [
            { "metric": "cvr_delta_pct", "op": "<", "value": -10 }
          ],
          "then": "product_breakdown"
        }
      ],
      "default": {
        "then": "final_insight"
      }
    },
    {
      "id": "product_breakdown",
      "type": "recursive_dimension_breakdown",
      "dimensions": ["product_id", "landing_page_path"],
      "base_metric": "cvr",
      "filter_mode": "drop",
      "output_key": "cvr_product_drops",
      "stop_conditions": {
        "max_depth": 2,
        "min_sessions": 100,
        "top_k": 5
      },
      "next": "final_insight"
    },
    {
      "id": "final_insight",
      "type": "insight",
      "output_key": "cvr_product_drops",
      "template": {
        "summary": "CVR changed by {{cvr_delta_pct_fmt}}. Top driver: {{dimension}} = {{value}}.",
        "details": [
          "Segment CVR: {{top_baseline_cvr_pct}} -> {{top_current_cvr_pct}} ({{top_cvr_delta_pct_fmt}})",
          "Sessions: {{top_baseline_sessions}} -> {{top_current_sessions}}",
          "Orders: {{top_baseline_orders}} -> {{top_current_orders}}"
        ]
      }
    }
  ]
}
```

Why this example is safe:

- valid top-level contract
- explicit entrypoint
- branch has a default path
- breakdown is partial-day compatible because `product_id` is first
- insight targets an explicit evidence key

## 17. Things That Look Supported But Are Not Fully Implemented

These are the main footguns when reading only the JSON:

- `validation.checks` exist in schema, but runtime validation does not interpret them yet
- `recursive_dimension_breakdown.stop_conditions.min_impact_pct` is accepted but not enforced in runtime
- `insight.persist` is not true DB persistence; the actual persistent insight record comes from final run persistence logic after execution
- Trigger examples using `metric`, `condition`, and `window` are legacy-style inputs, not the canonical validator contract

## 18. Suggested Workflow Creation Process

1. Start from the trigger shape and decide tenant/global scope
2. Define the entrypoint node first because runtime uses array order
3. Add `metric_compare` early if any later logic depends on deltas
4. Add branch logic with a guaranteed default path
5. Add breakdown nodes with explicit `output_key`s
6. Review recursive dimensions for partial-day compatibility
7. Add insight nodes with only the tokens you know upstream nodes produce
8. Create the workflow
9. Test one full-day manual run
10. Test one partial-day manual run if the workflow may be scheduled hourly
11. Only then attach schedules

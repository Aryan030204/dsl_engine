# State-Based Alerting Design

Status: superseded by `docs/workflow-state-engine.md` (per-workflow
NORMAL/TRIGGERED/CRITICAL state engine). This per-finding proposal was not
implemented on this line; kept for background only.

This document specifies the revamp of workflow notifications from run-scoped
unconditional email into a stateful, per-finding alerting system.

## 1. Problem Statement

### 1.1 Current behavior

There is no notification state anywhere in the engine today. Every run that
reaches an email-capable node sends mail unconditionally.

1. `nodes/InsightNode.js:131` sends whenever `email.enabled` is true.
2. `nodes/EmailNode.js:21` sends whenever the node is reached.
3. Neither consults history, prior deliveries, or prior findings.

The only existing suppression is the empty-details guard at
`nodes/InsightNode.js:116`. That instinct is correct and is subsumed by this design.

### 1.2 The five spam sources

1. Daily cron against a persistent problem produces an identical mail every day.
   The insight is regenerated from scratch with no diff against yesterday
   (`scheduler/app/schedulerService.js:353`).
2. One `alert.fired` fans out to every matching brand workflow, and each match
   enqueues its own run and its own mail
   (`scheduler/app/schedulerService.js:263`, `scheduler/domain/triggerMatcher.js:44`).
3. Retries re-send. Email is sent mid-execution, before the run is persisted, so
   `maxAttempts: 3` and lease-expiry recovery re-run the workflow from node one
   and re-send. Execution happens at
   `server/services/workflowExecutionService.js:57` and the run is only saved at
   `:70`, so every send inside that window is repeated on the next attempt
   (`scheduler/app/runQueueService.js:255`).
4. `AlertShadow.cooldownMinutes` is synced from the upstream alerts system and
   then never read (`server/models/AlertShadow.js:18`).
5. Bulk schedule creation replicates one workflow across many tenants
   (`server/routes/workflowBulk.js`).

### 1.3 Why history cannot be the state store

`pruneWorkflowRuns(model, tenantId, workflowId, keep = 4)` deletes all but the
four most recent terminal runs and cascades to `Insight`
(`server/lib/retention.js`, `server/services/workflowExecutionService.js:79`).
`WorkflowRun` additionally carries a seven-day TTL
(`server/models/WorkflowRun.js:47`).

All state introduced by this design therefore lives in new collections with
independent retention, and the UI reads state from those collections rather than
from run history.

## 2. Core Reframe

Today the unit of notification is the **run**. It becomes the **finding**.

- A finding (also called an issue) is a durable, stateful entity with a lifecycle.
- A run becomes an **observation** that updates findings.
- Mail is generated from **state transitions**, not from run completion.

Three layers are required, and they are independent:

1. **Finding state** — "product 12345 ATC is down." Drives what gets said.
2. **Signal state** — "CVR-drop RCA for brand X." Drives cooldown, caps, digests.
3. **Delivery idempotency** — a unique dedupe key per send. Kills retry re-sends
   on its own, without any of the rest.

## 3. Decisions Locked

| # | Decision | Value |
|---|---|---|
| 1 | Notification unit | Per finding. Each finding gets its own mail aggregating its state, evidence and history. |
| 2 | Recovery mail | Sent by default when a finding resolves. |
| 3 | State scope | Configurable: per workflow (default), per named group, or per tenant + alert type. |
| 4 | Existing workflows | Backward compatible. Legacy email paths keep working and gain default suppression without JSON edits. |
| 5 | Delivery failure | Reflected on the run. Mechanism in §11.3. |
| 6 | Human controls | Ack, snooze and mute in v1, with signed action links and a UI surface. |
| 7 | Observation series | Yes. Per-finding time series in v1, powering trend text and the UI timeline. |
| 8 | Burst handling | Cap immediate sends per run, roll the overflow into one digest mail. |

## 4. Architecture

Delivery moves out of node execution and into a post-run notifier.

```
run executes
  nodes declare notification intents into context.notifications[]
  no SMTP call happens during execution
run persists (WorkflowRun saved)
  |
  v
NotificationService.processRun(run)
  1. resolve policy
  2. classify observation conclusiveness
  3. load/create AlertState per fingerprint
  4. apply observation (idempotent per observationKey)
  5. compute transitions
  6. run the suppression pipeline (§7)
  7. insert NotificationLedger rows (unique dedupeKey wins the race)
  8. render and send per surviving intent
  9. record delivery outcome, update AlertState notify counters
```

Why post-run rather than in-node:

1. It fixes the retry re-send bug structurally. The send happens once, after the
   run is durable, behind a unique dedupe key.
2. `server/services/workflowExecutionService.js:32` `executeRun` is the single
   choke point shared by the synchronous API path
   (`server/routes/runs.js:102`) and the worker path, so both converge for free.
3. State mutation happens in one place instead of inside nodes, which keeps nodes
   re-runnable and testable.

Nodes remain the **declaration** surface. The `alert_state` node computes
fingerprints and transitions as pure functions of the run context plus loaded
state; the notifier owns writes and delivery.

## 5. Fingerprinting

### 5.1 Inputs

The seed already exists: `makeEvidenceKey(entry)` in
`server/lib/insightUtils.js:126` produces `dimension::value::path`, and breakdown
entries carry stable `dimension`, `value`, `ancestry` and `path`
(`nodes/RecursiveDimensionBreakdownNode.js:309`).

```
fingerprint = {
  scopeKey,          // per §5.3
  metric,            // base_metric of the producing breakdown
  direction,         // 'drop' | 'increase', from filter_mode
  outputKey,         // producing breakdown output_key
  ruleId,            // matched branch rule, when routed by branch
  dimension,
  value,             // normalized raw value, never display_value
  path,              // [{dimension, value}] ancestry
  windowMode         // optional, per §5.3
}

fingerprintHash = sha1(canonicalJson(fingerprint))
stateKey         = `${scopeKey}:${fingerprintHash}`
```

`sha1` matches the existing hashing idiom at
`scheduler/app/handlers/handleAlertConfigEvent.js:5`.

### 5.2 Deliberately excluded

Magnitudes, window timestamps, `runId`, `confidence`, `display_value`,
`sessionShare`. Including any of these makes every observation a new finding.

### 5.3 Scope configuration

```json
"state_scope": {
  "mode": "workflow",
  "group": null,
  "include_window_mode": true
}
```

| mode | scopeKey | Use |
|---|---|---|
| `workflow` (default) | `${tenantId}/${workflowId}` | Independent state per workflow. |
| `group` | `${tenantId}/group:${group}` | Several workflows share one suppression stream. Answers the alert fan-out problem in §1.2.2. |
| `tenant_alert_type` | `${tenantId}/alert:${alertType}` | Broadest sharing; all workflows for an alert type dedupe against each other. |

`include_window_mode` appends the schedule window mode to `scopeKey`. Default
`true`: a `day_to_date_vs_previous_day` hourly run and a
`previous_complete_day` daily run observe different windows
(`scheduler/app/scheduleWindowModes.js`,
`scheduler/app/schedulerService.js:133`), so sharing a stream makes
`consecutiveClean` meaningless.

### 5.4 Normalization rules

These are correctness-critical. Each one, if skipped, either merges distinct
findings (missed alerts) or splits identical ones (worse spam than today).

1. Key on `value`, never `display_value`. A product title edit must not open a
   new finding (`nodes/RecursiveDimensionBreakdownNode.js:295`).
2. `landing_page_path`: strip query string and fragment, collapse duplicate
   slashes, strip trailing slash, lowercase the host-relative path.
3. Null, empty and literal `unknown` dimension values collapse to `__unknown__`.
4. Numeric-like ids (`product_id`) normalize to string form to avoid `123` and
   `"123"` splitting.
5. Workflow version changes do **not** reset state by default. A threshold change
   arguably should; expose `reset_state_on: "never" | "workflow_version"` and
   default to `never`.

### 5.5 Why fingerprints ship in shadow mode first

Fingerprint stability cannot be validated by unit tests alone. Phase 1 (§14)
computes fingerprints and logs transitions against live traffic while still
sending everything, so drift is observable before it gates any mail.

## 6. State Machine

### 6.1 States

| State | Meaning |
|---|---|
| `new` | First breaching observation of a fresh episode. |
| `active` | Still breaching. |
| `recovering` | No longer breaching, but has not yet met the clear threshold. |
| `resolved` | Cleared. Retained for recurrence detection and history. |
| `stale` | No observations at all for a configured interval. Data stopped arriving, schedule paused, or workflow deactivated. |
| `snoozed` | Human-suppressed until `snoozedUntil`. |
| `muted` | Human-suppressed indefinitely. |

`acked` is a flag rather than a state: an acked finding stays `active` but stops
producing reminder mail while still producing escalation mail.

### 6.2 Counters

Stored per finding: `firstSeenAt`, `lastSeenAt`, `lastNotifiedAt`,
`notifyCount`, `consecutiveBreach`, `consecutiveClean`, `inconclusiveStreak`,
`episodeCount`, `severityTier`, `flapCount`, and
`currentEpisode.lastNotifiedMetrics` for magnitude comparison.

### 6.3 Transition to notification matrix

| Transition | Default action |
|---|---|
| absent → `new` | Notify. |
| `active` → `active`, magnitude within band | Suppress, bump counters. |
| `active` → `active`, worsened past `significance.delta_pct` or crossed a severity tier | Notify as escalation. |
| `active` → `active`, `reminder_after` elapsed | Optional reminder ("still open, day 7"). Off by default. |
| `active` → `resolved` | Notify recovery (decision #2). |
| `resolved` → `new` within `recurrence_window` | Notify as **recurrence**, not as new. Increments `episodeCount`. |
| `flapCount > flap.max_episodes` within `flap.window` | Demote the finding to digest delivery until `forcedDigestUntil`. |
| any → `stale` | Optional operational notice, off by default. Surfaced in the UI regardless. |

### 6.4 Hysteresis and flap control

A metric hovering at the threshold otherwise produces new/resolved/new/resolved
pairs, which is worse than today. Four mandatory mitigations:

1. Separate `breach.enter` and `breach.exit` conditions. `exit` must be strictly
   weaker than `enter`.
2. `for_observations` — N consecutive breaching observations required to open,
   in the spirit of Prometheus `for:`. Default 1 for alert-triggered workflows,
   2 for cron workflows.
3. `clear_after_observations` — N consecutive clean observations required to
   resolve. Default 2.
4. `flapCount` within a rolling window demotes the finding to digest.

### 6.5 Inconclusive observations

This is the most dangerous trap in the current engine shape.

`on_fail: { action: 'terminate' }` returns a `terminated` run
(`engine/WorkflowRunner.js:144`), used for no-data and sanity-check failures.
`MetricCompareNode` returns `fail` when sessions are zero
(`nodes/MetricCompareNode.js:47`). `RecursiveDimensionBreakdownNode` returns
early with no evidence when a query yields no rows
(`nodes/RecursiveDimensionBreakdownNode.js:121`).

None of these are clean observations. If treated as clean, a broken query
silently resolves every open finding and then re-opens them all on the next run,
producing a full resolve-plus-reopen mail storm.

Classification:

| Run outcome | Observation |
|---|---|
| `completed`, findings present | conclusive, breaching for the present findings |
| `completed`, no findings, analysis actually ran | conclusive, clean |
| `terminated` | inconclusive |
| `failed`, `dead_letter` | inconclusive |
| node-level `fail` upstream of the state node | inconclusive |

Inconclusive observations update `lastSeenAt` and `inconclusiveStreak` only. They
never touch `consecutiveClean` or `consecutiveBreach`, and never notify. A long
`inconclusiveStreak` transitions the finding to `stale` rather than `resolved`.

## 7. Suppression Pipeline

Evaluated in this order per candidate notification. Order matters: human intent
outranks policy, and caps apply after significance so that caps consume real
notifications rather than suppressed ones.

1. **Dry run** — manual/rerun context flag (§10.2). Record `dry_run`, stop.
2. **Conclusiveness** — inconclusive observation, stop (§6.5).
3. **Policy resolution** — node → workflow → tenant → platform default. Mirrors
   the existing branding precedence in `server/lib/emailBranding.js`.
4. **Transition gate** — does the transition map to a notification at all (§6.3)?
5. **Human overrides** — `muted` drops; `snoozed` holds until `snoozedUntil`;
   `acked` suppresses reminders but allows escalation.
6. **Flap demotion** — route to digest instead of immediate.
7. **Cooldown** — `min_interval` since `lastNotifiedAt` for this episode, and
   `AlertShadow.cooldownMinutes` when present, taking the larger value.
8. **Significance** — compare against `currentEpisode.lastNotifiedMetrics`;
   suppress if the change is within `significance.delta_pct`.
9. **Quiet hours** — evaluated in `context.meta.timezone`, holding non-critical
   mail until the window opens. Critical severity bypasses.
10. **Burst cap** — per run and scope, send the top `burst_cap.max_immediate`
    ranked by the existing evidence score (`computeEvidenceScore`,
    `server/lib/insightUtils.js:7`); the remainder rolls into one overflow digest
    (decision #8).
11. **Rate cap** — per tenant, per workflow and per recipient per 24h; overflow
    rolls into digest.
12. **Content dedupe** — identical `contentHash` for the same finding and
    transition suppresses.
13. **Ledger insert** — unique `(tenantId, dedupeKey)` insert. Losing the race
    means another attempt already owns this send.
14. **Send** — render, deliver via `server/services/emailService.js`, record
    outcome, update `AlertState` notify counters.

Every suppression writes a ledger row with `status: 'suppressed'` and a
`suppressedReason`. "Why did I not get an email?" must be answerable from data.

### 7.1 Dedupe key

```
observationKey = `${windowMode}|${window.end}`
dedupeKey      = sha1(`${stateKey}|${transition}|${episodeId}|${observationKey}|${contentHash}`)
```

Same-run retries produce an identical key and collide, so the unique index blocks
the second send. A legitimate next-day escalation has a different
`observationKey` and proceeds.

### 7.2 Idempotent state application

`AlertState` stores `lastObservationKey`. Re-applying the same `observationKey`
is a no-op for counters, so a retried run cannot double-increment
`consecutiveBreach` or falsely satisfy `for_observations`.

## 8. Data Model

New Mongo collections. None of them are touched by `pruneWorkflowRuns` or the
`WorkflowRun` TTL.

### 8.1 `AlertState`

One document per finding.

```
tenantId, stateKey                      // unique together
stateScope { mode, group, includeWindowMode }
workflowId, workflowIdsSeen[]           // populated when scope is shared
fingerprint { hash, metric, direction, outputKey, ruleId,
              dimension, value, path[], windowMode }
displayLabel, displayPath               // human-readable, refreshed each observation
status                                  // §6.1
severity, severityTier
firstSeenAt, lastSeenAt
lastObservationRunId, lastObservationKey
consecutiveBreach, consecutiveClean, inconclusiveStreak
episodeCount
currentEpisode {
  id, startedAt, openedByRunId,
  peakMetrics, notifyCount,
  lastNotifiedAt, lastNotifiedMetrics, lastNotifiedTransition
}
resolvedAt, resolutionNotifiedAt
flapCount, flapWindowStartedAt, forcedDigestUntil
snoozedUntil, snoozedBy, ackedAt, ackedBy, mutedAt, mutedBy
retentionExpiresAt                      // set only once resolved, ~90d
```

Indexes: unique `(tenantId, stateKey)`;
`(tenantId, status, lastSeenAt: -1)` for the Issues list;
`(tenantId, workflowId, status)`;
`(retentionExpiresAt)` TTL, following the pattern at
`server/models/WorkflowRun.js:63`. `retentionExpiresAt` is null while a finding
is not resolved, so active findings never expire.

### 8.2 `NotificationLedger`

One document per send decision, sent or suppressed.

```
tenantId, dedupeKey                     // unique together
stateKey, stateKeys[]                   // array for digest rows
workflowId, runId, nodeId
transition, episodeId, observationKey
channel: 'email'
recipients[], subject, contentHash
status: pending | sent | failed | suppressed | held | superseded
suppressedReason
heldUntil                               // quiet hours / snooze
required                                // §11.3
attempt, nextAttemptAt, lastError
provider, messageId, sentAt
```

`suppressedReason` enum: `dry_run`, `inconclusive`, `no_transition`, `muted`,
`snoozed`, `acked`, `flapping_digest`, `cooldown`, `not_significant`,
`quiet_hours`, `burst_cap`, `rate_cap`, `duplicate_content`, `no_findings`.

Indexes: unique `(tenantId, dedupeKey)`; `(tenantId, runId)`;
`(tenantId, stateKey, createdAt: -1)`;
`(status, nextAttemptAt)` for the delivery retry sweep.

This collection deliberately mirrors `server/models/ProcessedBrokerEvent.js`, so
it reads as native to the codebase.

### 8.3 `AlertObservation`

Per-finding time series (decision #7). Powers "day 4, was -12% now -22%", trend
text, and the UI timeline.

```
tenantId, stateKey, runId, observationKey, observedAt
windowMode, window, baselineWindow
breaching, conclusive
metrics { current, baseline, delta_pct, sessions, share, ... }
severityTier, transition, notified
expiresAt                               // TTL, default 90d
```

Indexes: unique `(tenantId, stateKey, observationKey)`;
`(tenantId, stateKey, observedAt: -1)`; `(expiresAt)` TTL.

### 8.4 `NotificationSpool`

Only needed for digest and burst overflow.

```
tenantId, digestKey                     // scope + mode + windowStart
windowStart, windowEnd, mode
items[] { stateKey, transition, snapshot, evidence }
status: open | flushing | flushed
flushedAt, ledgerId
```

Flushed by a loop hung off the existing worker tick
(`scheduler/infra/workerLoop.js`).

### 8.5 `NotificationPolicy`

Tenant-level and workflow-level policy documents so operations can tune
suppression without editing workflow JSON. Same shape as the node-level
`notify_policy` in §9.2.

### 8.6 `Tenant.settings.notifications`

Extends `server/models/Tenant.js`:

```
notifications {
  quietHours { start: "22:00", end: "07:00", severityBypass: ["critical"] },
  maxEmailsPerDay,
  digestHour,
  defaultRecipients[]
}
```

Timezone is already present at `settings.timezone` and is reused.

## 9. DSL Surface

### 9.1 New node type: `alert_state`

Added to `ALLOWED_NODE_TYPES` in `server/validation/workflowDefinition.js:1`, to
the runner registry at `engine/WorkflowRunner.js:12`, and to the composite
registry at `nodes/CompositeNode.js:10`.

```json
{
  "id": "evaluate_state",
  "type": "alert_state",
  "sources": [
    {
      "output_key": "atc_rate_product_drops",
      "metric": "atc_rate",
      "direction": "drop",
      "limit": 20
    }
  ],
  "state_scope": { "mode": "workflow", "group": null, "include_window_mode": true },
  "breach": {
    "enter": [{ "metric": "atc_rate_delta_pct", "op": "<", "value": -10 }],
    "exit":  [{ "metric": "atc_rate_delta_pct", "op": ">", "value": -5 }],
    "for_observations": 2,
    "clear_after_observations": 2
  },
  "severity_tiers": [
    { "name": "critical", "when": [{ "metric": "atc_rate_delta_pct", "op": "<", "value": -30 }] },
    { "name": "warning",  "when": [{ "metric": "atc_rate_delta_pct", "op": "<", "value": -10 }] }
  ],
  "notify_policy": { "$ref": "see 9.2" },
  "emit_to": ["send_finding_email"],
  "then": "final_insight",
  "then_no_changes": null
}
```

Condition syntax reuses the existing `{ metric, op, value }` shape and the
`ALLOWED_OPS` set from `server/validation/workflowDefinition.js:24`, and metric
resolution reuses `resolveEntryMetric` semantics from `nodes/BranchNode.js:270`
so authors do not learn a second condition dialect.

`then_no_changes` gives branch-style routing when a run produced no transitions,
so authors can skip downstream work entirely.

### 9.2 `notify_policy`

Attachable to `alert_state`, `email` and `insight` nodes, and to workflow and
tenant policy documents.

```json
"notify_policy": {
  "delivery": "per_finding",
  "on": ["new", "recurrence", "escalation", "resolved"],
  "min_interval": "24h",
  "reminder_after": null,
  "significance": { "delta_pct": 25, "tier_change": true },
  "recurrence_window": "7d",
  "flap": { "window": "72h", "max_episodes": 3, "action": "digest" },
  "burst_cap": { "max_immediate": 5, "overflow": "digest" },
  "rate_cap": { "per_workflow_per_day": 20, "per_recipient_per_day": 40 },
  "quiet_hours": "inherit",
  "digest": { "mode": "daily", "hour": 9 },
  "stale_after": "72h",
  "respect_upstream_cooldown": true
}
```

Validation follows the strict style already used for email nodes: explicit
allowlists plus `rejectUnknownFields`
(`server/validation/workflowDefinition.js:58`).

### 9.3 Per-finding fan-out without graph loops

The runner's `visited` set means a node executes at most once per definition
(`engine/WorkflowRunner.js:97`), so per-finding mail cannot be a graph loop.

Instead, an `email` node in per-finding mode becomes a **template declaration**:

```json
{
  "id": "send_finding_email",
  "type": "email",
  "format": "finding",
  "for_each": "alertStates.transitions",
  "to": ["team@example.com"],
  "subject": "{{finding.state_badge}} {{meta.brandName}}: {{finding.label}}",
  "template": { "preset": "finding_v1" },
  "notify_policy": { "delivery": "per_finding" }
}
```

The node declares one intent per item in `for_each`; the notifier renders and
sends N mails. One node, N mails, no loops. `format: "finding"` joins the
existing `insight` and `report` formats in
`server/validation/workflowDefinition.js:33`.

### 9.4 Backward compatibility (decision #4)

Existing `email` and `insight.email` nodes are untouched by authors and keep
sending their single composed mail. They gain an implicit signal-level state
stream keyed on `(tenantId, workflowId, contentHash)` plus a default policy:

```json
{
  "delivery": "per_run",
  "on": ["new", "escalation", "resolved"],
  "min_interval": "24h",
  "significance": { "delta_pct": 25 },
  "suppress_when_empty": true
}
```

This is opt-out, not opt-in: the identical-mail-every-day complaint disappears
for every existing workflow with no JSON edits. `suppress_when_empty` generalizes
the hack at `nodes/InsightNode.js:116`.

## 10. Context Contract Changes

### 10.1 A new top-level bucket, not `scratch`

`scratch` is overwritten wholesale by `mergeContext` rule 5
(`engine/MergeContext.js:31`). Anything writing state into `scratch` must spread
prior scratch or it destroys `finalInsight`, which is exactly the fragility
`nodes/InsightNode.js:157` and `nodes/EmailNode.js:34` already work around by
hand.

Two new top-level buckets with explicit merge rules:

```
context.alertStates = {
  transitions: [ { stateKey, transition, finding, snapshot, history } ],
  new: [], escalated: [], resolved: [], ongoing: [], suppressed: []
}
context.notifications = [ { intentId, nodeId, channel, format, forEach, policy, ... } ]
```

`mergeContext` gains: `alertStates` replaced by the last writer (same rule as
`breakdowns` per `engine/MergeContext.js:39`), `notifications` appended.
`meta` remains immutable (`engine/MergeContext.js:6`).

Note: `docs/workflow-authoring-guide.md:658` still claims `breakdowns[key]`
appends. The code overwrites. That doc section needs correcting alongside this
work.

### 10.2 Dry run for manual runs and reruns

Manual and rerun executions must not mutate state or send mail by default.
Otherwise someone debugging a workflow silently resolves live findings and burns
cooldowns.

```
context.meta.notifications = { mode: "dry_run" | "live" }
```

- `POST /runs` manual and `rerun: true` default to `dry_run`
  (`server/routes/runs.js:15`).
- `RunWorkflowModal.jsx` gains an explicit "send notifications for real" toggle.
- Cron and event runs default to `live`.
- Dry runs still compute transitions and write ledger rows with
  `suppressedReason: 'dry_run'`, so authors can see exactly what would have been
  sent.

`normalizeRerunContext` already clears derived analysis state
(`lib/timeWindowUtils.js`, asserted in `tests/rerun-state.test.js:14`) and must
also clear `alertStates` and `notifications`.

## 11. Engine Integration Points and Hazards

### 11.1 Nested workflows

`workflow_ref` shares the same context object across frames
(`engine/WorkflowRunner.js:236`), so nested email nodes emit intents into the
parent's `context.notifications`. Each intent records its originating
`workflowIdentity`.

Nested findings must key state on the **root** workflow identity, or on an
explicit `state_scope.group`. Otherwise refactoring a monolithic workflow into
`workflow_ref` children silently resets every open finding.

### 11.2 Composite nodes

`CompositeNode` runs its steps inline and controls flow itself, discarding step
`next` values (`nodes/CompositeNode.js:56`). An `alert_state` node used as a
composite step therefore cannot route via `then` / `then_no_changes`. The
validator must reject a routing `alert_state` node inside `composite.steps`.

### 11.3 Delivery failure and run status (decision #5)

The user asked that delivery failure be reflected on the run. Naively marking the
run `failed` would make it eligible for re-execution
(`scheduler/app/runQueueService.js:93` claims `queued` and `retrying`), which
re-runs the whole analysis and is both expensive and a spam risk.

Proposed mechanism, which honors the decision without re-running analysis:

1. Email nodes gain `required: true|false`, derived from existing
   `on_fail: { action: 'terminate' }` when present.
2. Delivery retries live on the ledger, not the run: `status: 'failed'` with
   `attempt` and `nextAttemptAt`, swept by the worker with the same backoff shape
   as `scheduler/domain/retryPolicy.js`.
3. Once a required delivery exhausts its ledger attempts, the run takes a new
   terminal status `delivery_failed`, and `notificationError` is recorded on the
   run. The run is **not** re-queued.
4. `WorkflowRun.triggerType` is unaffected; new fields
   `notificationStatus` and `notificationError` are added.

Adding a terminal status touches two lists that must stay in sync:
`server/models/WorkflowRun.js:3` and `server/lib/retention.js:1`.

Alternative, if a distinct status is unwanted: keep the run `completed` and
surface delivery failure only through `notificationStatus` and the ledger. Worth
a second look during implementation.

### 11.4 Synchronous run path latency

`POST /runs?mode=sync` executes in the API process
(`server/routes/runs.js:102`). Post-run notification adds SMTP latency to the
HTTP response. Preference: the notifier writes ledger rows synchronously
(cheap, gives an immediate accurate response) and leaves actual SMTP delivery to
the worker sweep.

### 11.5 Timezone

All day boundaries, quiet hours, digest windows, `min_interval` day buckets and
"day N of this drop" arithmetic use `context.meta.timezone`, already propagated
per recent commits and asserted in `tests/timezone-routing.test.js`. Doing any of
this in UTC gives IST brands two mails on one local day.

### 11.6 Multi-tenant and global workflows

Global and multi-tenant workflows (`server/lib/workflowKind.js`) plus bulk
schedule creation produce independent state streams per tenant, which is
correct. The Issues UI aggregates across tenants for operators;
`state_scope.mode: "group"` is the escape hatch when cross-workflow dedupe is
wanted.

## 12. Email Content

State is what lets the mail read differently each time. Half the perceived spam
problem is that today's mail is textually identical.

### 12.1 Subject

`[NEW]`, `[WORSENING] day 4`, `[RECURRENCE]`, `[RESOLVED]`, `[DIGEST]` prefixes,
followed by the finding label and the driving delta.

### 12.2 Body, `finding_v1` preset

1. Finding label and evidence path, using
   `formatEvidencePath(entry, { includeLabels: true })`
   (`server/lib/insightUtils.js:112`).
2. State block: first seen, days open, episode number, current severity tier.
3. Trend line from `AlertObservation`: "-12% → -18% → -22% over 3 observations."
4. Current versus baseline metrics for this finding only.
5. What changed since the last mail about this finding.
6. Action footer: Snooze 24h / Snooze 7d / Mute / Ack / View in UI.

### 12.3 Digest preset

One mail listing burst overflow and flap-demoted findings, grouped by transition,
one line per finding, linking into the UI.

### 12.4 Renderer constraint

`renderReportEmail` throws on any missing binding via `requireBinding`
(`server/lib/renderReportEmail.js:12`). Every new state binding must be
optional-safe or all existing report workflows break. Add
`resolveOptionalBinding` rather than loosening `requireBinding`.

## 13. Human Controls (decision #6)

### 13.1 Endpoints

```
GET    /tenants/:tenantId/findings                 ?status=&workflowId=&severity=
GET    /tenants/:tenantId/findings/:stateKey       includes observation timeline
POST   /tenants/:tenantId/findings/:stateKey/ack
POST   /tenants/:tenantId/findings/:stateKey/snooze     { until | duration }
POST   /tenants/:tenantId/findings/:stateKey/mute
POST   /tenants/:tenantId/findings/:stateKey/unmute
POST   /tenants/:tenantId/findings/:stateKey/resolve    manual close
GET    /tenants/:tenantId/notifications                 ledger, with suppressedReason
GET    /tenants/:tenantId/notifications/:id
```

### 13.2 Signed action links

Email action links must work without a UI session. Short-lived signed tokens via
the already-present `jsonwebtoken` dependency, scoped to
`(tenantId, stateKey, action)` with an expiry, following the shared-secret
precedent of `ALERTS_INGEST_TOKEN` in `server/routes/alertsIngest.js`.

Links are one-click POST-equivalents behind a confirmation page, never bare GETs
that mail scanners can trigger.

## 14. Phased Rollout

### Phase 0 — Stop the bleeding

No DSL changes, default on.

1. `NotificationLedger` with the unique dedupe key, wrapping both existing send
   paths. Kills retry re-sends (§1.2.3).
2. `suppress_when_empty` for runs that produced no findings.
3. Content-hash plus 24h cooldown on the legacy default policy (§9.4).

Outcome: the identical-mail-every-day complaint and the retry duplicate both
disappear.

### Phase 1 — Fingerprints in shadow mode

`AlertState`, `AlertObservation`, fingerprint computation, transition
calculation, full ledger rows including what *would* have been suppressed.
Everything still sends. Validates fingerprint stability against live traffic
before it gates any mail (§5.5).

### Phase 2 — Enforce

Transitions gate delivery. Per-finding delivery, burst cap and digest overflow,
recovery mail, `finding_v1` preset, state-aware subjects.

### Phase 3 — DSL surface

`alert_state` node, `notify_policy`, workflow and tenant policy documents, quiet
hours, digest modes, configurable state scope. Touches the validator
(`server/validation/workflowDefinition.js`), its UI mirror
(`ui/src/utils/workflowValidation.js`), `PropertiesPanel.jsx`,
`workflowTransformers.js` and `NodeSidebar.jsx`. The validator/UI pair is kept
deliberately in sync, so budget for both.

### Phase 4 — Humans

Ack, snooze, mute, signed links, Issues UI page, flap detection tuning,
escalation tiers, stale detection.

## 15. UI Surface

1. **Issues page** — findings list with status, severity, days open, last
   notified; modeled on the existing `ui/src/pages/InsightsPage.jsx`.
2. **Finding detail** — observation timeline, episode history, notification
   history, action buttons.
3. **Run detail** — a "notifications" panel on
   `ui/src/pages/RunDetailPage.jsx` showing sent versus suppressed with reasons.
   This is the primary debugging affordance.
4. **Properties panel** — `notify_policy` editor and the `alert_state` node form
   in `ui/src/components/workflow-builder/PropertiesPanel.jsx`.
5. **Settings** — tenant notification defaults and quiet hours in
   `ui/src/pages/SettingsPage.jsx`.
6. **Run modal** — the live-versus-dry-run toggle in `RunWorkflowModal.jsx`.

## 16. Observability

1. Structured logs prefixed `[notify]`, matching the `[run-queue]` and
   `[scheduler]` conventions.
2. `DEBUG_NOTIFICATIONS` env flag, matching `DEBUG_ALERT_EVENTS` and
   `DEBUG_RECURSIVE_BREAKDOWN` (`docs/dsl-engine-handover.md` §11.6).
3. Per-run counters: intents, sent, suppressed by reason, held, failed.
4. Ledger-backed answers to "why did I get this?" and "why did I not get this?"

## 17. Test Plan

Extends `tests/` and `npm test` (`node --test tests/*.test.js`).

1. Fingerprint stability: display-value change, product title edit, path
   normalization, unknown bucketing, numeric coercion.
2. Fingerprint separation: same value under different metric, direction,
   output key and window mode.
3. Transition matrix, one case per row of §6.3.
4. Hysteresis: threshold-hovering series produces one open, not four.
5. Flap demotion after N episodes.
6. Inconclusive runs never resolve findings; `terminated` and `failed` cases.
7. Ledger idempotency: same run retried three times sends once.
8. State idempotency: replayed `observationKey` does not double-increment.
9. Dry run mutates nothing and sends nothing but records intent.
10. Quiet hours and day bucketing in a non-UTC timezone.
11. Burst cap plus overflow digest composition.
12. Legacy compatibility: an unmodified existing workflow sends day one and
    suppresses day two.
13. Optional bindings: existing report workflows still render.

## 18. Explicit Non-Goals

1. No new notification channels in v1. Email only, though the ledger carries a
   `channel` field so Slack or webhooks can follow.
2. No cross-tenant correlation or root-cause grouping of findings.
3. No ML-based anomaly detection. Thresholds stay author-declared.
4. No change to breakdown SQL or the analysis path
   (`docs/alert-analysis-routing.md` stays valid).
5. No retroactive backfill of state from existing runs; §1.3 makes it impossible
   anyway.

## 19. Open Questions

1. `delivery_failed` as a new terminal run status versus surfacing delivery
   failure only via `notificationStatus` (§11.3).
2. Default `for_observations` for cron workflows: 1 (faster alerts, more flap
   exposure) or 2 (one period of delay, much steadier).
3. Whether resolution mail should be suppressed for findings that were never
   notified in the first place. Leaning yes — a silent open should close silently.
4. `AlertObservation` retention: 90 days proposed; longer retention makes trend
   text richer but grows unbounded with wide dimensions like `product_id`.
5. Whether `state_scope.mode: "tenant_alert_type"` should be the default for
   alert-triggered workflows, since fan-out (§1.2.2) is a per-alert problem
   rather than a per-workflow one.

# Workflow State Engine

Status: implemented. This replaces the per-finding design in
`docs/state-based-alerting-design.md`, which was never built on this line.

The state engine decides whether an RCA workflow run sends an email. The workflow
still does all the analysis. The engine turns one number from the run into a state
(NORMAL, TRIGGERED or CRITICAL), always records that state, and then decides
separately whether this run is worth notifying about.

```text
workflow run -> finding value -> state transition -> notification decision -> email / no email
```

Cooldowns and quiet hours only ever block the **email**. They never block a
**state change**.

## 1. Which workflows use it

Every workflow definition has a `workflow_purpose`, set in the visual builder under
**Workflow type**:

| `workflow_purpose` | Behaviour |
|---|---|
| `daily_insight` | Daily insight or report. No state, cooldowns or quiet hours. Emails go out inline on every run, as they always have. It may not enable `state_config` (validation rejects it). |
| `rca` (default when missing) | Uses the state engine **only if** `state_config.enabled` is `true`. Otherwise it behaves as before, sending inline on every run. |

When the engine is on, the workflow's `email` and `insight` nodes still render their
emails, but the sends are captured instead of delivered
(`server/lib/notificationCapture.js`). After the run, the engine sends at most
**one** email: the captured content, with the subject and body exactly as the
workflow rendered them. The engine only decides whether it goes out. It never invents
a notification: if the run's path reached no email or messaging node (a deliberate
silent branch, such as "CVR is stable"), nothing is sent. The evaluation shows delivery
`none` with the reason `no_notification_on_path`, and the cooldown is handed back so
the next run that does reach a notifier still sends.

**Telegram** (messaging nodes with the Telegram channel on) is gated the same way.
Its messages are captured during the run and sent only when the engine decides to
notify: same cooldowns, same quiet hours, one decision per run. The delivery is
recorded as `sent` (every channel got through), `partial` (some did) or `failed`
(none did), and the cooldown is handed back only when nothing was delivered. A
Telegram-only messaging node sends no email.
Without alert state (daily insights, or RCA workflows with it off) a messaging node
sends email and Telegram on every run.

## 2. Configuration

```json
"workflow_purpose": "rca",
"state_config": {
  "enabled": true,
  "finding":     { "metric": "cvr_delta_pct" },
  "thresholds":  { "normal": -10, "critical": -20 },
  "cooldown":    { "triggered_minutes": 60, "critical_minutes": 30 },
  "quiet_hours": { "enabled": true, "start": "23:00", "end": "07:00" }
}
```

### Finding value and thresholds

`finding.metric` is a key in the run's final `context.metrics`, normally a signed
percent from `metric_compare` such as `cvr_delta_pct`. It is compared **as is**: a
17% CVR drop is `-17`.

The thresholds are signed values of that same metric. Which direction counts as
"worse" comes from their order, so there is no separate direction setting that could
contradict them:

| Thresholds | Alerts on | NORMAL | TRIGGERED | CRITICAL |
|---|---|---|---|---|
| normal −10, critical −20 (critical below normal) | **drops** | above −10 | −10 down to just above −20 | −20 or lower |
| normal 10, critical 20 (critical above normal) | **rises** | below 10 | 10 up to just below 20 | 20 or higher |

Both boundaries are inclusive (−10 is TRIGGERED, −20 is CRITICAL). The two
thresholds must differ.

A run that throws, or finishes without a finite value for the metric, is
**inconclusive**. It is recorded but doesn't change state. A `terminated` run that
did produce the metric is evaluated normally.

Configs saved before this shape existed (`finding.direction: "drop"` with positive
thresholds such as 15 / 25) are still read as their signed equivalent (−15 / −25).
Saving such a workflow from the builder rewrites it to the new shape. The server
rejects `direction` and `recovery` in new saves.

### Quiet hours

Quiet hours use the run's timezone (`context.meta.timezone`, or UTC) at minute
resolution, and both ends are inclusive: with 23:00–07:00, 07:00 is quiet and 07:01
is not. A window may wrap midnight.

## 3. Transitions and notifications

The state is keyed by **(tenantId, workflowId)**. Global and multi-tenant workflows
keep separate state per tenant, and editing a workflow (a new version) keeps its
state. Scheduled (cron) and alert-triggered (event) runs are **live**: they move the
state, start cooldowns and send. **Manual runs are dry runs by default**: the run page
shows what the engine would decide (`Dry run, nothing sent`), but the state, the
cooldown and the audit trail are untouched and nothing is emailed. Tick "Send
notifications and update alert state" in the Run Workflow dialog (API: `notify: true`
in the run request body) to make a manual run live.

| previous → result | notification | cooldown | quiet hours |
|---|---|---|---|
| NORMAL → NORMAL | none | – | – |
| TRIGGERED/CRITICAL → NORMAL | **none**: the state changes silently | – | – |
| NORMAL → TRIGGERED | INITIAL_TRIGGER | TRIGGERED | applies |
| NORMAL → CRITICAL | ESCALATION | **bypassed** | applies |
| TRIGGERED → CRITICAL | ESCALATION | **bypassed** | applies |
| TRIGGERED → TRIGGERED | REMINDER | TRIGGERED | applies |
| CRITICAL → CRITICAL | REMINDER | CRITICAL | applies |
| CRITICAL → TRIGGERED | DE_ESCALATION | TRIGGERED | applies |

There are **no recovery emails**. A drop-triggered workflow usually only runs while
the metric is bad, so it would rarely see the healthy runs a recovery needs.

The reason is recorded in the audit trail and shown in the UI; it is not added to
the email's subject or body.

### Cooldown

- It is timestamp-based: `{ state, duration_minutes, started_at }`. It is
  (re)started whenever an email is sent, with the duration for the resulting state.
- A candidate email is blocked while the active time since `started_at` is less than
  the duration for **that candidate's** cooldown state (the "cooldown" column above).
- **The clock pauses during quiet hours.** A 60-minute cooldown started at 22:50 has
  used 10 minutes by 23:00, resumes at 07:01, and expires at 07:51.
- Returning to NORMAL doesn't clear the cooldown. If the metric goes bad again while
  it is still running, the new INITIAL_TRIGGER waits for it to expire.
- A suppressed email leaves the cooldown untouched. Nothing is queued. The next real
  run evaluates from scratch (no retroactive sends).

## 4. Persistence, concurrency and idempotency

| Collection | Contents |
|---|---|
| `workflow_states` (`server/models/WorkflowState.js`) | One doc per (tenant, workflow): state, cooldown, `last_alert_at`, `last_evaluated_at`, `last_execution_id`, `last_decision`, `version`. |
| `workflow_state_evaluations` (`server/models/WorkflowStateEvaluation.js`) | One audit row per execution: previous/resulting state, finding, decision, and delivery status. 90-day TTL. |
| `WorkflowRun.stateEvaluation` | A summary for the run page. Runs are pruned to 4 per workflow and expire after 7 days, so they are not the audit trail. |

- **Concurrency:** every state write is a compare-and-set on `version`. If another
  execution got there first, the engine re-reads and recomputes from its result, up
  to 5 times, rather than overwriting it. The first write for a workflow relies on
  the unique index.
- **Idempotency:** the execution id is the run id. A retried run re-executes the
  workflow, but the engine replays the decision already recorded for that run (from
  the audit row, or from `last_decision` if the audit write never landed). It never
  transitions twice.
- **Delivery is at-most-once:** the audit row is claimed (`pending → sending`)
  before SMTP. A retry that finds it still `sending` marks it `uncertain` and does
  not resend.
- **SMTP failure:** the state change stands, but the previous cooldown and
  `last_alert_at` are restored. A failed send therefore doesn't use up the cooldown,
  and the next eligible run tries again. The rollback is skipped if a later run has
  alerted since.
- A state-engine error never fails or re-queues the run. It is recorded in
  `WorkflowRun.stateEvaluationError`.

## 5. Code map

| File | Role |
|---|---|
| `server/lib/stateEngine/defaults.js` | Constants, defaults, legacy-config conversion, `workflow_purpose` and trigger helpers |
| `server/lib/stateEngine/severity.js` | Finding value and signed threshold classification |
| `server/lib/stateEngine/quietHours.js` | Quiet-minute check and the quiet-paused cooldown clock |
| `server/lib/stateEngine/evaluateState.js` | Pure transition and notification decision |
| `server/services/stateEngineService.js` | Versioned writes, audit rows, delivery, rollback |
| `server/lib/renderStateEmail.js` | Sends the captured email as rendered (the built-in fallback message is no longer used) |
| `server/services/workflowExecutionService.js` | `prepareNotificationMode` / `applyStateEngine` hook into `executeRun` |
| `ui/src/components/workflow-builder/AlertStatePanel.jsx` | Builder settings |
| `ui/src/components/StateEngineViews.jsx` | Workflow and run state views |

API:

- `GET /tenants/:tenantId/workflows/:workflowId/state`
- `GET /tenants/:tenantId/workflows/:workflowId/state/evaluations?limit=`

## Testing mode (manual runs)

Testing an alert used to mean clearing the workflow's state in MongoDB. The **Run Workflow** dialog now has a
**Testing mode** switch:

- The run executes normally and **emails whatever its nodes produced**, ignoring the alert state, cooldown, quiet hours
  and the threshold. The subject starts with `[TEST]`.
- It **saves nothing**: no state change, no cooldown started, no audit row (`stateEngineService.deliverTestExecution`
  never touches the state store). Test as often as you like.
- **Send the test to**: *Only me* (the signed-in user's email; pause/mute does not apply; Telegram is not sent) or
  *The workflow's real recipients* (same list as a live alert; pause/mute still applies; Telegram is sent).
- If the run's path reaches no email node, nothing is sent and the run page says so.
- Testing mode replaces "Send notifications and update alert state", and only manual runs can be test runs (scheduled and
  alert-triggered runs never are). A rerun of a test run is a normal run again.
- The run page shows a "Test run" note and the runs list a "Test" badge.

## Alert storm protection (optional, per workflow)

`state_config.storm_protection` adds a daily quota and an exceptional-deterioration bypass **after** the existing cooldown and quiet-hours gates. It never changes state classification, cooldowns or thresholds. Absent or `enabled: false` = behaviour identical to before.

```json
"storm_protection": {
  "enabled": true,
  "daily_limits": { "triggered": 3, "critical": 3, "total": 6 },
  "exceptional_alerts": {
    "enabled": true,
    "absolute": { "enabled": true, "value": -50 },
    "difference": { "enabled": true, "value": 15 }
  }
}
```

- Limits are `null` (unlimited) or whole numbers >= 1, counted per **tenant-local calendar day** (resets at local midnight, not a rolling 24h). Only delivered alerts count: a send nobody received hands the quota and latches back, like the cooldown.
- A candidate that passes cooldown and quiet hours but hits an exhausted limit is held with `suppressed_by: "daily_limit"`; the state transition is still saved and no cooldown starts. Escalations still bypass cooldown but are subject to the quota.
- Exceptional bypass (only when the quota is exhausted; cooldown and quiet hours still apply): `absolute` fires when the value is at/beyond the configured value in the workflow's worse direction; `difference` fires when deterioration from the previous conclusive finding (`prev - current` for drops, `current - prev` for rises) is >= the configured value. Each kind fires at most once per local day (latch). Both true in one run = one notification with both reasons. Exceptional sends are marked `notification.exceptional` and still count toward the counters.
- Runtime state lives in `WorkflowState.storm` (`day`, `*_count`, `absolute_fired`, `difference_fired`) and `last_value`. It is backend-owned, written in the same version-CAS as the state transition (so concurrent workers cannot over-consume), and is never part of workflow config or editable from the UI.
- UI: Workflow builder -> Alert state panel -> Storm protection.

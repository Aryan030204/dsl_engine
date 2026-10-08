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
workflow rendered them. The engine only decides whether it goes out. If no email
node ran, it sends a short built-in message.

**Telegram** (messaging nodes with the Telegram channel on) is gated the same way.
Its messages are captured during the run and sent only when the engine decides to
notify: same cooldowns, same quiet hours, one decision per run. The delivery is
recorded as `sent` (every channel got through), `partial` (some did) or `failed`
(none did), and the cooldown is handed back only when nothing was delivered. A
Telegram-only messaging node sends no email, not even the built-in message.
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
state. Manual, scheduled and alert-triggered runs all follow the same rules.

| previous → result | notification | cooldown | quiet hours |
|---|---|---|---|
| NORMAL → NORMAL | none | – | – |
| TRIGGERED/CRITICAL → NORMAL | **none**: the state changes silently | – | – |
| NORMAL → TRIGGERED | INITIAL_TRIGGER | TRIGGERED | applies |
| NORMAL → CRITICAL | ESCALATION | **bypassed** | **bypassed** |
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
| `server/lib/renderStateEmail.js` | Sends the captured email as rendered, or the built-in fallback message |
| `server/services/workflowExecutionService.js` | `prepareNotificationMode` / `applyStateEngine` hook into `executeRun` |
| `ui/src/components/workflow-builder/AlertStatePanel.jsx` | Builder settings |
| `ui/src/components/StateEngineViews.jsx` | Workflow and run state views |

API:

- `GET /tenants/:tenantId/workflows/:workflowId/state`
- `GET /tenants/:tenantId/workflows/:workflowId/state/evaluations?limit=`

# PRD: Alert Storm Protection

## Overview

Alert Storm Protection is an optional, per-workflow safeguard that limits how many notifications a workflow can send per tenant-local calendar day. It sits on top of the existing alert state engine (Normal / Triggered / Critical, cooldown, quiet hours) and only decides whether a notification that would otherwise be sent is actually delivered.

It also provides a controlled escape hatch: when the daily quota is exhausted, an *exceptional alert* can still get through if the metric becomes severely bad. Each kind of exception can do this at most once per day.

## Problem

A persistent problem can stay in Triggered or Critical for many hours. The cooldown correctly stops alerts from firing on every run, but once it expires, the same unchanged problem produces another reminder.

Example: CVR stays below the alert threshold all day. The engine sends a reminder after every cooldown period (09:00, 10:00, 11:00, 12:00 ...). Each alert is technically correct, but the volume is noisy and lowers the value of the alerting system.

Reminders are still useful, so the answer is not to remove them. It is to cap them, while making sure a genuinely severe deterioration is never hidden behind the cap.

## Goals

- Reduce repetitive alert noise from long-running incidents.
- Preserve existing state-engine behavior exactly.
- Cap ordinary notification volume per tenant per day.
- Let genuinely severe deterioration break through the cap.
- Make the behavior configurable per workflow.
- Keep behavior deterministic and concurrency-safe.

## Non-goals

Storm Protection does not:

- replace the state machine or change severity classification
- replace the cooldown
- globally bypass quiet hours
- automatically reset or close incidents
- create a separate alerting engine
- provide a global (cross-workflow) configuration

## How a notification is decided

```text
Severity / state  ->  Cooldown  ->  Quiet hours  ->  Storm Protection  ->  Delivery
```

The state engine first works out the state and whether a notification is a candidate (initial trigger, reminder, escalation, de-escalation). Cooldown and quiet hours apply as they do today. Only a notification that has passed both is evaluated by Storm Protection. Storm Protection never changes the state, only whether that notification goes out.

## User-facing configuration

Configured per workflow, in the workflow builder's Alert State section.

```text
Storm Protection
├── Enabled
├── Daily Limits
│   ├── Triggered
│   ├── Critical
│   └── Total
└── Exceptional Alerts
    ├── Enabled
    ├── Absolute Value
    │   ├── Enabled
    │   └── Value
    └── Difference / Deterioration
        ├── Enabled
        └── Value
```

| Setting | Meaning |
|---|---|
| Enabled | Turns Storm Protection on for this workflow. Off by default. |
| Daily limit (Triggered / Critical / Total) | Maximum ordinary notifications per tenant-local day. A whole number of at least 1, or *unlimited* (no limit). |
| Exceptional alerts: Enabled | Master switch for the two exception mechanisms. |
| Absolute value | The extreme metric value at which an alert may bypass an exhausted quota. Any number. |
| Difference | Minimum deterioration from the previous valid finding. Must be greater than 0. |

Each toggle keeps its value when switched off, so re-enabling restores it. The counters and latches that track daily usage are runtime state maintained by the system. They are not configuration and cannot be edited.

## Daily quota behavior

- Quotas are per tenant (and per workflow) and count notifications in one **tenant-local calendar day**.
- They reset at the tenant's local midnight. They are not a rolling 24-hour window, and not UTC midnight.
- Triggered, Critical and Total limits are independent. A notification must be under both its state's limit (by resulting state) and the Total limit.
- Only notifications that were actually delivered consume quota. These do not:
  - notifications held by cooldown or quiet hours
  - notifications blocked by the daily limit itself
  - candidates with no notification
  - sends where nobody received anything (failed, no notifier on the run's path, all recipients muted or paused)
- If at least one channel delivers, the notification counts as delivered (partial delivery counts).

The quota gates notification delivery, not state calculation.

```text
Critical daily limit = 3

Alert 1 -> sent
Alert 2 -> sent
Alert 3 -> sent
Alert 4 -> blocked by daily limit
```

The workflow can still be in Critical. Only the notification is suppressed, and the run is recorded as held by the daily limit.

## Exceptional alerts

Exceptional alerts exist so a full daily quota cannot hide a genuinely severe deterioration. An **exceptional alert** is a notification that bypasses an exhausted daily quota because an exceptional condition was met. There are two independent mechanisms. They only matter when the quota is exhausted.

### Absolute exception

The current value has reached the configured extreme value, in the workflow's worse direction.

- Lower-is-worse metric: current value <= absolute threshold.
- Higher-is-worse metric: current value >= absolute threshold.

The direction comes from the workflow's existing thresholds (critical below normal means lower is worse). Example: threshold -50, current value -51 qualifies.

### Difference exception

The metric has deteriorated by at least the configured amount compared with the immediately previous valid finding for the same workflow and tenant.

- Lower-is-worse: previous value - current value >= configured difference.
- Higher-is-worse: current value - previous value >= configured difference.

Example (lower-is-worse, difference 15): previous -20, current -38 gives a deterioration of 18, which qualifies. If there is no previous valid finding (first run), the difference exception cannot trigger. The previous value is the previous conclusive finding, whether or not a notification was sent for it.

## Exception latch behavior

Each mechanism has its own once-per-day **latch**:

- The absolute and difference latches are independent.
- A latch is consumed only when that exception is actually used to bypass an exhausted quota. A condition that is true while quota is still available does **not** consume it, because the alert goes out as a normal notification.
- Repeated qualifying values therefore cannot produce unlimited exceptional alerts.
- Both latches reset at the tenant-local midnight, together with the counters. Recovery to Normal is not required.
- If both conditions qualify in the same run, **one** notification is sent, both reasons are recorded, and both latches are consumed.

```text
10:00  absolute condition true, quota still available
       -> normal alert sent, absolute latch NOT consumed
15:00  quota exhausted, absolute condition still true
       -> exceptional alert sent, absolute latch consumed
16:00  same condition still true
       -> no second exceptional alert
```

## Exceptional alerts and counters

An exceptional notification still increments the Total count and the count for its resulting state. Counters therefore reflect notifications actually delivered, including exceptional ones. Limits gate only ordinary notifications, so after an exceptional alert the usage may be above the configured limit (for example 4 of 3).

An exceptional notification is marked as exceptional with its reasons, is treated as Critical severity for the notification, and keeps its normal reason (such as Reminder). The workflow's resulting state is unchanged.

## Interaction with cooldown and quiet hours

- Storm Protection runs after cooldown and quiet hours.
- An exceptional condition does **not** bypass an active cooldown.
- An exceptional condition does **not** bypass quiet hours.
- Quiet hours hold every notification, Critical included. A direct Normal to Critical escalation no longer bypasses them. It is held, no cooldown starts, and the next run after quiet hours can send.
- An escalation still ignores cooldown, as before.
- An escalation that the state engine lets through is still subject to the daily quota, unless it qualifies for an exceptional bypass.

Exceptional does not mean "ignore all other alert rules".

## State behavior when the quota blocks a notification

- The state still transitions normally and the finding is still evaluated.
- The latest valid finding is still recorded (it is the "previous value" for the next run).
- Only the notification is suppressed.
- No cooldown starts, because only a delivered notification starts one.

## Delivery failure and retry

If nobody receives the notification (every channel failed, the run had no notifier, or all recipients were muted or paused), the quota and any exception latch that send used are handed back, in the same way the cooldown is. Partial delivery counts as delivered and keeps them used. A retried or replayed execution does not count twice, change the latches twice, or send again.

## Timezone behavior

The tenant's configured timezone decides when a day starts. A tenant in Asia/Kolkata resets at midnight India time. A tenant in America/New_York resets at midnight New York time. UTC midnight is not used, and there is no rolling 24-hour window.

## Backward compatibility

Storm Protection is disabled by default. Existing workflows without the configuration behave exactly as before. Cooldown, quiet hours and state-machine behavior are unchanged. Daily insight / report workflows do not use the state engine and are unaffected.

## Configuration examples

**1. Conservative protection.** Small limits, no exceptions.

```text
Enabled: on
Daily limits: Triggered 2, Critical 2, Total 3
Exceptional alerts: off
```

Once the day's allowance is used, nothing more is sent until local midnight, however bad the metric gets.

**2. Protection with an emergency escape.** Limits plus both exceptions.

```text
Enabled: on
Daily limits: Triggered 3, Critical 3, Total 6
Exceptional alerts: on
  Absolute: on, -50
  Difference: on, 15
```

After the quota is exhausted, the first time CVR reaches -50 (or drops 15 points from the previous finding) one exceptional alert is sent for each mechanism.

**3. One category unlimited.** Cap only Critical.

```text
Enabled: on
Daily limits: Triggered unlimited, Critical 3, Total unlimited
Exceptional alerts: off
```

Triggered reminders keep their normal cooldown-paced behavior. Critical notifications stop after three.

## Success criteria

- Persistent incidents no longer generate unlimited ordinary reminders within a day.
- Severe deterioration can still surface after the quota is exhausted.
- One exception mechanism cannot repeatedly bypass the quota in the same day.
- Workflows with Storm Protection disabled or unconfigured behave unchanged.
- Concurrent executions cannot consume the same final quota slot or exception latch twice.

## Risks and edge cases

| Case | Behavior |
|---|---|
| Concurrent executions | Cannot consume the same final quota slot or latch twice. |
| Duplicate or replayed executions | Replay the original decision. No double count, no second send. |
| Delivery failure | Quota and latch are handed back if nobody received it. |
| Timezone boundaries | Day is the tenant-local calendar day. Reset happens at local midnight. |
| First finding, no previous value | Difference exception cannot trigger. Absolute still can. |
| Both exceptions at once | One notification, both reasons, both latches consumed. |
| Condition persists after its latch is consumed | Suppressed until the next local day. |
| Absolute value set on the non-alerting side of the thresholds | Not rejected on save. It follows the workflow's direction, so it should be set beyond the Critical threshold to be meaningful. |
| Manual (dry-run) runs | Show what Storm Protection would decide. They change no counters or latches. |

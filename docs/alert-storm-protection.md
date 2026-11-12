# Alert Storm Protection

## What it does

Alert Storm Protection caps how many notifications a workflow sends per **tenant-local calendar day**, and lets a severe deterioration break through the cap a limited number of times. It is optional, configured per workflow, and **disabled by default**.

It does not change how state is calculated. It only decides whether a notification that would otherwise be sent is delivered.

## Why it exists

A persistent problem can stay Triggered or Critical for hours. Cooldown stops constant alerts, but once it expires the same problem sends another reminder, all day (09:00, 10:00, 11:00 ...). Every alert is correct, but the volume is noise. Reminders are still useful, so they are capped rather than removed.

## How it works

```text
Severity / state -> Cooldown -> Quiet hours -> Storm Protection -> Delivery
```

Storm Protection is the last gate. A notification reaches it only if cooldown and quiet hours already allow it.

| Situation | Result |
|---|---|
| Quota available | Normal notification |
| Quota exhausted, no exception qualifies | Suppress (`daily_limit`) |
| Quota exhausted + absolute exception qualifies, latch unused | Exceptional notification |
| Quota exhausted + difference exception qualifies, latch unused | Exceptional notification |
| Same exception already used today | Suppress |
| Both exceptions qualify | One notification, two reasons |

When a notification is suppressed, the workflow's state still changes normally and the finding is still recorded. Only the notification is held, and no cooldown starts.

## Daily quotas

Three independent limits, each a whole number >= 1 or unlimited:

| Limit | Applies to notifications whose resulting state is |
|---|---|
| Triggered | TRIGGERED (initial triggers, reminders, de-escalations) |
| Critical | CRITICAL (escalations, reminders) |
| Total | Either |

A notification needs room under its state's limit **and** the Total limit.

**What counts:** only delivered notifications. If at least one channel delivers, it counts (partial delivery counts).

**What does not count:** notifications held by cooldown, quiet hours or the daily limit; failed sends where nobody received anything; runs with no notifier on their path; sends where every recipient is muted or paused.

```text
Critical daily limit = 3
Alerts 1-3 -> sent        Alert 4 -> blocked (workflow stays CRITICAL)
```

## Exceptional alerts

An **exceptional alert** bypasses an exhausted daily quota because an exceptional condition was met. Two independent mechanisms; both direction-aware, using the workflow's existing thresholds to decide which way is "worse".

| | Lower-is-worse | Higher-is-worse |
|---|---|---|
| **Absolute exception** | current <= absolute value | current >= absolute value |
| **Difference exception** | previous - current >= difference | current - previous >= difference |

Example (lower-is-worse): absolute -50 and current -51 qualifies. Difference 15, previous -20, current -38 (deterioration 18) qualifies.

"Previous" is the previous valid finding for the same workflow and tenant, whether or not a notification was sent for it. With no previous finding, the difference exception cannot trigger; the absolute exception still can.

## Exception latches

Each mechanism has its own once-per-day **latch**.

- A latch is consumed **only when that exception is used to bypass an exhausted quota**. If the condition is true while quota remains, the alert is an ordinary one and the latch is untouched.
- A used latch blocks further bypasses by that mechanism until the next tenant-local day.
- The two latches are independent: absolute can fire once and difference can fire once on the same day.
- If both qualify in the same run, one notification is sent, both reasons are recorded, both latches are consumed.

```text
10:00 absolute true, quota available -> normal alert, latch NOT consumed
15:00 quota exhausted, absolute true -> exceptional alert, latch consumed
16:00 still true                     -> suppressed
```

An exceptional notification increments the Total count and its resulting-state count, so usage can exceed the configured limit (for example 4 of 3). It is marked exceptional, treated as Critical severity for the notification, and the workflow's resulting state is unchanged.

## Cooldown and quiet hours

- Cooldown and quiet hours run first and are not bypassed by an exceptional condition.
- Quiet hours hold every notification, Critical included (a direct Normal to Critical escalation no longer bypasses them). Escalations still ignore cooldown.
- Escalations are still subject to the daily quota unless they qualify for an exceptional bypass.

## Daily reset

Counters and latches reset at the tenant's **local midnight**: Asia/Kolkata at midnight India time, America/New_York at midnight New York time. It is not UTC midnight and not a rolling 24-hour window. Recovery to Normal is not needed for a reset.

## Configuration

Per workflow, in the workflow builder: Alert state > Storm protection.

| Setting | Values |
|---|---|
| Storm protection: Enabled | on / off (default off) |
| Daily limits: Triggered, Critical, Total | whole number >= 1, or unlimited |
| Exceptional alerts: Enabled | on / off |
| Absolute value: Enabled, Value | any number; set beyond the Critical threshold in the worse direction |
| Difference: Enabled, Value | number > 0 |

Switching a toggle off keeps its value for when it is re-enabled. Counters and latches are runtime state maintained by the system and cannot be edited.

## Examples

| Goal | Configuration |
|---|---|
| Conservative | Limits 2 / 2 / 3, exceptional alerts off |
| With emergency escape | Limits 3 / 3 / 6, absolute -50, difference 15 |
| One category unlimited | Triggered unlimited, Critical 3, Total unlimited |

## Delivery behavior

- If nobody receives the notification, the quota and any exception latch it used are handed back, like the cooldown.
- Partial delivery counts as delivered and keeps them used.
- A replayed or retried execution does not count twice, change a latch twice, or send again.
- Concurrent executions cannot consume the same final quota slot or exception latch twice.
- Manual dry runs show what would be decided and change nothing.

## Backward compatibility

Workflows without the configuration, or with it disabled, behave exactly as before. State classification, cooldown, quiet hours, escalation and delivery semantics are unchanged. Daily insight / report workflows do not use the state engine and are unaffected.

## Important rules

1. Storm Protection gates notifications, never state.
2. Day = tenant-local calendar day, never a rolling 24 hours.
3. Only delivered notifications consume quota.
4. A latch is consumed only when it bypasses an exhausted quota.
5. Each exception mechanism fires at most once per day.
6. Both exceptions in one run produce one notification.
7. Exceptional alerts bypass the quota only, not cooldown or quiet hours.
8. Exceptional sends count toward the counters.

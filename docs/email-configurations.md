# Email Configurations

The **Email Configurations** page (sidebar) shows who receives which workflow's emails and lets you set per-person
rules. It has two tabs: **People** (open a person to see and change their workflows and settings) and **By workflow**
(each workflow with its recipients).

## Where the data lives
- **Who is on a workflow** stays inside the workflow's JSON: `email` nodes (`to`), `insight` nodes with Email Insight on
  (`email.to`) and `messaging` nodes with the email channel on (`email.to`). Adding or removing a person on the page edits
  those lists and saves a **new workflow version** (one per workflow touched).
- **Per-person settings** are stored separately (`email_recipient_preferences`) and applied when an email is sent. Every
  change is recorded in `email_config_events` (who, what, when), shown under "Recent changes".

## Per-person settings
| Setting | Effect |
|---|---|
| Pause all emails (optional resume date) | Nothing is sent to that person until resumed or the date passes. |
| Which alerts: All / Critical only | Alert-state workflows only: "Critical only" skips TRIGGERED alerts. Daily reports and workflows without alert state are not filtered by severity. |
| Receive switch per workflow (mute) | Stops that workflow's emails for that person; they stay on the workflow. |

## How it is applied
- **Alert-state workflows:** after the state engine decides to send, the recipients are filtered per person using the alert's
  state (TRIGGERED / CRITICAL) as the severity. If nobody is left, nothing is sent and the cooldown is handed back
  (delivery `none`, reason `recipients_opted_out`). Filtered people are listed on the evaluation
  (`delivery.suppressed_recipients`).
- **Other workflows** (daily reports, RCA without alert state): the send is filtered the same way (pause and mute only). If
  everyone opted out the node passes with status `skipped`; the run does not fail.
- Manual runs are still dry runs for alert-state workflows. Telegram is not affected.
- Settings are cached for about 30 seconds per process (API and worker), so a change can take up to that long to apply.
- If the settings cannot be read (database problem), the email is sent unfiltered rather than lost.

## API (all under `/email-config`, signed-in admins)
`GET /recipients`, `GET /recipients/:email`, `GET /workflows`, `GET /events`,
`PUT /recipients/:email/preferences`, `PUT /recipients/:email/workflows/:workflowKey/mute`,
`POST /recipients/:email/workflows` (`{ add: [keys], remove: [keys] }`).

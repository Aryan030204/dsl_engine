# Telegram notifications

Messaging nodes with the **Telegram** channel on send alerts to Telegram through
the engine's own bot. This used to be a separate message service; its code now lives
in the engine:

| File | Role |
|---|---|
| `server/services/telegramBot.js` | Bot API client (send, bot identity), link creation, and the `/start` link bot |
| `server/services/telegramService.js` | `sendTelegram()`: resolves recipients, formats, sends, reports `sent` / `partial` / `failed` |
| `server/routes/telegram.js` | `GET /telegram/link?username=…`: the builder's **Copy Telegram link** |
| `server/models/TelegramUser.js` | `users` collection: `{ username, chatId }` for each linked person |
| `server/models/PendingTelegramLink.js` | `pending_telegram_links` collection: single-use link tokens, 10-minute TTL |

The collections are the same ones the standalone service used in this database, so
people who linked through it keep receiving alerts.

## Setup

Add to the engine's `.env`, then restart the API:

```
TELEGRAM_BOT_TOKEN=<the bot's token from @BotFather>
```

`TELEGRAM_SERVICE_URL` and `TELEGRAM_SERVICE_SECRET` are no longer used.

Optional: `TELEGRAM_LINK_BOT_ENABLED=false` turns off the `/start` link bot while
sending still works (see below).

## Linking a person (once per person)

1. In a Messaging node, type their Telegram username under **Telegram Users** and
   click **Copy Telegram link**.
2. Send them the link. They open it in Telegram and press **Start**.
3. The bot replies "You're linked as …". Alerts for that username now reach them.

Links are single use and expire after 10 minutes. Asking for a new link for the
same username replaces the old one. A numeric chat ID can be entered instead of a
username; it needs no linking.

## The link bot and polling

The link bot receives `/start` by long polling, and Telegram allows **only one
poller per bot token**. So:

- It runs in the **API server only**. The worker never starts it.
- If more than one API instance runs, set `TELEGRAM_LINK_BOT_ENABLED=false` on all
  but one.
- Stop the old standalone message service before starting the engine with the
  same token. Otherwise the two pollers conflict and links may not complete.

## Delivery

- With alert state on (RCA workflows), Telegram is sent only when the state engine
  decides to notify, together with email. See `docs/workflow-state-engine.md`.
- Otherwise a Messaging node sends on every run.
- Each recipient is delivered independently. An unlinked username or a user who
  blocked the bot is reported as a failure without stopping the others (`partial`).
- The message is `[SEVERITY] <subject>` followed by the email's plain-text
  version, cut to Telegram's 4096-character limit.

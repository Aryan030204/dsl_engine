const express = require('express');
const telegramBot = require('../services/telegramBot');

const router = express.Router();

// "Copy Telegram link" in the builder: issues a single-use, 10-minute t.me link that
// links this username to whoever presses Start on it (handled by the link bot in
// server/services/telegramBot.js). Formerly proxied to the standalone message
// service; now done in-process.
router.get('/link', async (req, res, next) => {
  try {
    const username = String(req.query.username || '').trim().replace(/^@/, '');
    if (!username) return res.status(400).json({ error: 'username is required' });

    if (!telegramBot.isTelegramConfigured()) {
      return res.status(503).json({ error: 'Telegram is not configured: set TELEGRAM_BOT_TOKEN on the server' });
    }

    const url = await telegramBot.createLink(username);
    res.json({ username, url });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

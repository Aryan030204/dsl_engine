const dns = require("dns");

// Force Node.js to use public DNS instead of the local 127.0.0.1 resolver
dns.setServers(["8.8.8.8", "1.1.1.1"]);

console.log("Node DNS servers:", dns.getServers());

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const authRoutes = require('./server/routes/auth');
const workflowRoutes = require('./server/routes/workflows');
const globalWorkflowRoutes = require('./server/routes/globalWorkflows');
const workflowBulkRoutes = require('./server/routes/workflowBulk');
const runRoutes = require('./server/routes/runs');
const insightRoutes = require('./server/routes/insights');
const tenantRoutes = require('./server/routes/tenants');
const scheduleRoutes = require('./server/routes/schedules');
const triggerRoutes = require('./server/routes/triggers');
const schedulerRoutes = require('./server/routes/scheduler');
const alertsIngestRoutes = require('./server/routes/alertsIngest');
const { requireAuth, requireTenantAccess, allowIngestToken } = require('./server/middleware/auth');
const telegramRoutes = require('./server/routes/telegram');
const { startLinkBot } = require('./server/services/telegramBot');

const app = express();
app.set('trust proxy', 1);

// CORS configuration for UI
const allowedOrigins = (process.env.UI_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser or same-origin requests without an Origin header.
    if (!origin) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Version check endpoint - update this timestamp on each deploy to verify
app.get('/version', (req, res) => {
  res.json({
    version: '1.0.1',
    deployedAt: '2026-02-13T17:00:00Z',
    features: ['atc_sessions_delta_pct', 'branch_rule_evaluations']
  });
});

app.use('/auth', authRoutes);

// Machine-to-machine alert ingestion authenticates with ALERTS_INGEST_TOKEN, not a user session.
app.use('/tenants', alertsIngestRoutes);
app.use('/tenants/:tenantId/triggers/events', allowIngestToken);

// Everything below requires a logged-in user; tenant-scoped routes also require tenant access.
app.use('/tenants', requireAuth);
app.use('/tenants/:tenantId', requireTenantAccess);
app.use('/workflows', requireAuth);
app.use('/telegram', requireAuth);

app.use('/tenants', tenantRoutes);
app.use('/workflows/global', globalWorkflowRoutes);
app.use('/workflows', workflowBulkRoutes);
app.use('/tenants/:tenantId/workflows', workflowRoutes);
app.use('/tenants/:tenantId/workflows', runRoutes);
app.use('/tenants/:tenantId/workflows', scheduleRoutes);
app.use('/tenants/:tenantId/insights', insightRoutes);
app.use('/tenants/:tenantId/triggers', triggerRoutes);
app.use('/tenants/:tenantId/scheduler', schedulerRoutes);
app.use('/telegram', telegramRoutes);

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'internal_error'
  });
});

async function start() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is required');
  }

  await mongoose.connect(mongoUri);

  // Completes "Copy Telegram link" links (/start <token>). API server only: Telegram
  // allows one poller per bot token, so the worker never starts it.
  startLinkBot();

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on ${port}`);
  });

}
  
  start().catch(err => {
    console.error(err);
    process.exit(1);
  });
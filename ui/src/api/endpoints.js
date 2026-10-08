import api from './client';

// Tenant APIs
export const tenantApi = {
  // List all tenants
  list: async () => {
    const { data } = await api.get('/tenants');
    return data.tenants;
  },

  // Get a single tenant
  get: async (tenantId) => {
    const { data } = await api.get(`/tenants/${tenantId}`);
    return data.tenant;
  },

  // Create a new tenant
  create: async (tenantData) => {
    const { data } = await api.post('/tenants', tenantData);
    return data.tenant;
  },

  // Update a tenant
  update: async (tenantId, tenantData) => {
    const { data } = await api.patch(`/tenants/${tenantId}`, tenantData);
    return data.tenant;
  },

  // Delete a tenant
  delete: async (tenantId) => {
    const { data } = await api.delete(`/tenants/${tenantId}`);
    return data;
  },
};

// Workflow APIs
export const workflowApi = {
  // List all workflows for a tenant
  list: async (tenantId, { includeGlobal = true } = {}) => {
    const { data } = await api.get(`/tenants/${tenantId}/workflows`, {
      params: includeGlobal ? { includeGlobal: true } : {}
    });
    return data.workflows;
  },

  // Get a single workflow with its latest version
  get: async (tenantId, workflowId, { includeGlobal = true } = {}) => {
    const { data } = await api.get(`/tenants/${tenantId}/workflows/${workflowId}`, {
      params: includeGlobal ? { includeGlobal: true } : {}
    });
    return data;
  },

  // Create a new workflow
  create: async (tenantId, definition) => {
    const { data } = await api.post(`/tenants/${tenantId}/workflows`, definition);
    return data;
  },

  // Create one tenant-scoped workflow for multiple tenants
  createForTenants: async ({ tenantIds, definition, name }) => {
    const { data } = await api.post('/workflows/bulk', { tenantIds, definition, name });
    return data;
  },

  getJob: async (jobId) => {
    const { data } = await api.get(`/workflows/jobs/${jobId}`);
    return data.job;
  },

  // Create a new global workflow
  createGlobal: async (definition) => {
    const { data } = await api.post('/workflows/global', definition);
    return data;
  },

  // Create a new version of an existing workflow
  createVersion: async (tenantId, workflowId, definition) => {
    const { data } = await api.post(
      `/tenants/${tenantId}/workflows/${workflowId}/versions`,
      definition
    );
    return data;
  },

  // Create a new version of a global workflow
  createGlobalVersion: async (workflowId, definition) => {
    const { data } = await api.post(
      `/workflows/global/${workflowId}/versions`,
      definition
    );
    return data;
  },

  // List all versions of a workflow
  listVersions: async (tenantId, workflowId, { includeGlobal = true } = {}) => {
    const { data } = await api.get(`/tenants/${tenantId}/workflows/${workflowId}/versions`, {
      params: includeGlobal ? { includeGlobal: true } : {}
    });
    return data.versions;
  },

  // Update workflow metadata
  update: async (tenantId, workflowId, updates) => {
    const { data } = await api.patch(
      `/tenants/${tenantId}/workflows/${workflowId}`,
      updates
    );
    return data.workflow;
  },

  // Update global workflow metadata
  updateGlobal: async (workflowId, updates) => {
    const { data } = await api.patch(`/workflows/global/${workflowId}`, updates);
    return data.workflow;
  },

  // Delete a workflow
  delete: async (tenantId, workflowId) => {
    const { data } = await api.delete(`/tenants/${tenantId}/workflows/${workflowId}`);
    return data;
  },

  // Delete a global workflow
  deleteGlobal: async (workflowId) => {
    const { data } = await api.delete(`/workflows/global/${workflowId}`);
    return data;
  },
};

// Run APIs
export const runApi = {
  // List recent runs across all workflows for a tenant
  listRecent: async (tenantId, limit = 50) => {
    const { data } = await api.get(`/tenants/${tenantId}/runs`, {
      params: { limit }
    });
    return data.runs;
  },

  // List runs for a workflow
  list: async (tenantId, workflowId) => {
    const { data } = await api.get(`/tenants/${tenantId}/workflows/${workflowId}/runs`);
    return data.runs;
  },

  // Get a single run
  get: async (tenantId, workflowId, runId) => {
    const { data } = await api.get(
      `/tenants/${tenantId}/workflows/${workflowId}/runs/${runId}`
    );
    return data.run;
  },

  // Execute a workflow run
  execute: async (tenantId, workflowId, payload, { mode } = {}) => {
    const { data } = await api.post(
      `/tenants/${tenantId}/workflows/${workflowId}/runs`,
      payload,
      {
        params: mode ? { mode } : {}
      }
    );
    return data;
  },
};

// Workflow state engine: current incident state and its decision history.
export const stateApi = {
  get: async (tenantId, workflowId) => {
    const { data } = await api.get(`/tenants/${tenantId}/workflows/${workflowId}/state`);
    return data.state;
  },

  listEvaluations: async (tenantId, workflowId, limit = 20) => {
    const { data } = await api.get(
      `/tenants/${tenantId}/workflows/${workflowId}/state/evaluations`,
      { params: { limit } }
    );
    return data.evaluations;
  },
};

export const scheduleApi = {
  list: async (tenantId, workflowId) => {
    const { data } = await api.get(
      `/tenants/${tenantId}/workflows/${workflowId}/schedules`
    );
    return data.schedules;
  },

  create: async (tenantId, workflowId, payload) => {
    const { data } = await api.post(
      `/tenants/${tenantId}/workflows/${workflowId}/schedules`,
      payload
    );
    return data.schedule;
  },

  createBulk: async (workflowId, payload) => {
    const { data } = await api.post(
      `/workflows/${workflowId}/schedules/bulk`,
      payload
    );
    return data;
  },

  update: async (tenantId, workflowId, scheduleId, payload) => {
    const { data } = await api.patch(
      `/tenants/${tenantId}/workflows/${workflowId}/schedules/${scheduleId}`,
      payload
    );
    return data.schedule;
  },

  remove: async (tenantId, workflowId, scheduleId) => {
    const { data } = await api.delete(
      `/tenants/${tenantId}/workflows/${workflowId}/schedules/${scheduleId}`
    );
    return data;
  },

  pause: async (tenantId, workflowId, scheduleId) => {
    const { data } = await api.post(
      `/tenants/${tenantId}/workflows/${workflowId}/schedules/${scheduleId}/pause`
    );
    return data.schedule;
  },

  resume: async (tenantId, workflowId, scheduleId) => {
    const { data } = await api.post(
      `/tenants/${tenantId}/workflows/${workflowId}/schedules/${scheduleId}/resume`
    );
    return data.schedule;
  },

  replayMissed: async (tenantId, workflowId, scheduleId) => {
    const { data } = await api.post(
      `/tenants/${tenantId}/workflows/${workflowId}/schedules/${scheduleId}/replay-missed`
    );
    return data;
  },
};

export const schedulerApi = {
  queue: async (tenantId) => {
    const { data } = await api.get(`/tenants/${tenantId}/scheduler/queue`);
    return data.queue;
  },

  retryRun: async (tenantId, runId) => {
    const { data } = await api.post(`/tenants/${tenantId}/scheduler/runs/${runId}/retry`);
    return data;
  },

  cancelRun: async (tenantId, runId) => {
    const { data } = await api.post(`/tenants/${tenantId}/scheduler/runs/${runId}/cancel`);
    return data;
  },
};

export const triggerApi = {
  listEvents: async (tenantId) => {
    const { data } = await api.get(`/tenants/${tenantId}/triggers/events`);
    return data.events;
  },

  listUnmatched: async (tenantId) => {
    const { data } = await api.get(`/tenants/${tenantId}/triggers/unmatched`);
    return data.alerts;
  },

  ingestEvent: async (tenantId, payload) => {
    const { data } = await api.post(
      `/tenants/${tenantId}/triggers/events`,
      payload
    );
    return data;
  },
};

// Insight APIs
export const insightApi = {
  // List insights for a tenant
  list: async (tenantId) => {
    const { data } = await api.get(`/tenants/${tenantId}/insights`);
    return data.insights;
  },
};

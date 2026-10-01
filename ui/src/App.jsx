import { Navigate, Route, Routes, useBlocker } from 'react-router-dom';
import { useState } from 'react';
import { UnsavedChangesContext } from './context/UnsavedChangesContext';
import Layout from './components/Layout';
import WorkflowsPage from './pages/WorkflowsPage';
import WorkflowDetailPage from './pages/WorkflowDetailPage';
import WorkflowRunsPage from './pages/WorkflowRunsPage';
import RunsPage from './pages/RunsPage';
import RunDetailPage from './pages/RunDetailPage';
import InsightsPage from './pages/InsightsPage';
import SettingsPage from './pages/SettingsPage';
import ShopifyHubPage from './pages/ShopifyHubPage';
import WorkflowBuilderPage from './pages/WorkflowBuilderPage';
import Login from './pages/Login';
import Signup from './pages/Signup';
import { useAuth } from './context/AuthContext';

function App() {
  const { user, loading } = useAuth();
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const blocker = useBlocker(hasUnsavedChanges);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  // Unauthenticated routes
  if (!user) {
    return (
      <UnsavedChangesContext.Provider value={{ hasUnsavedChanges, setHasUnsavedChanges, blocker }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </UnsavedChangesContext.Provider>
    );
  }

  // Authenticated routes
  return (
    <UnsavedChangesContext.Provider value={{ hasUnsavedChanges, setHasUnsavedChanges, blocker }}>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/workflows" replace />} />
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/new/visual" element={<WorkflowBuilderPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
          <Route path="/workflows/:workflowId/edit/visual" element={<WorkflowBuilderPage />} />
          <Route path="/workflows/:workflowId/runs" element={<WorkflowRunsPage />} />
          <Route path="/workflows/:workflowId/runs/:runId" element={<RunDetailPage />} />
          <Route path="/insights" element={<InsightsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/shopify-hub" element={<ShopifyHubPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </UnsavedChangesContext.Provider>
  );
}

export default App;

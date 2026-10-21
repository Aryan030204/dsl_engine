import { Navigate, Route, Routes, useBlocker } from 'react-router-dom';
import { useCallback, useRef, useState } from 'react';
import { UnsavedChangesContext } from './context/UnsavedChangesContext';
import { shouldBlockNavigation } from './utils/unsavedChanges';
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
  const { user, loading, authUnavailable, retryAuth } = useAuth();
  const [hasUnsavedChanges, setHasUnsavedChangesState] = useState(false);
  // The ref is updated synchronously so a navigation fired right after a save sees the
  // cleared flag instead of the previous render's state.
  const hasUnsavedChangesRef = useRef(false);
  const setHasUnsavedChanges = useCallback((value) => {
    hasUnsavedChangesRef.current = Boolean(value);
    setHasUnsavedChangesState(Boolean(value));
  }, []);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => shouldBlockNavigation({
    isDirty: hasUnsavedChangesRef.current,
    currentPathname: currentLocation.pathname,
    nextPathname: nextLocation.pathname,
  }));

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-500"></div>
      </div>
    );
  }

  // The session could not be checked (server unreachable). Signed-in users must not be dropped to the
  // login page for that: offer a retry instead.
  if (authUnavailable) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
        <div className="max-w-sm text-center text-slate-200">
          <h1 className="text-lg font-semibold mb-2">Can&apos;t reach the server</h1>
          <p className="text-sm text-slate-400 mb-5">
            Your session is not affected. The API did not answer; it may be restarting. Try again in a moment.
          </p>
          <button
            type="button"
            onClick={retryAuth}
            className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-medium"
          >
            Try again
          </button>
        </div>
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

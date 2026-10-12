// Pure decisions behind the editor's unsaved-changes handling, kept free of React
// so they can be unit tested with node --test.

// Prompt only when there are unsaved edits and the navigation leaves the current page.
// Same-path navigations (e.g. a query-string change) never prompt.
export function shouldBlockNavigation({ isDirty, currentPathname, nextPathname }) {
  return Boolean(isDirty) && currentPathname !== nextPathname;
}

// Saving an existing workflow with no edits would only mint an identical version and show
// a misleading "Changes saved". New workflows, and historical versions being restored as
// the latest, are real saves even without edits.
export function canSaveWorkflow({ isEditing, isDirty, allowSaveWithoutChanges = false }) {
  if (!isEditing || allowSaveWithoutChanges) return true;
  return Boolean(isDirty);
}

// A refetch of the same workflow must not wipe edits the user has not saved yet.
export function shouldResetFromServer({ isDirty, loadedWorkflowId, incomingWorkflowId }) {
  if (!isDirty) return true;
  return (loadedWorkflowId || null) !== (incomingWorkflowId || null);
}

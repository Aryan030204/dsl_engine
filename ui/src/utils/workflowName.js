// A name typed in the Create Workflow dialog wins over the "name" inside pasted JSON.
// With no typed name the JSON keeps its own. Returns a copy; the input is not modified.
export function applyTypedWorkflowName(definition, typedName) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return definition;
  const name = typeof typedName === 'string' ? typedName.trim() : '';
  return name ? { ...definition, name } : definition;
}

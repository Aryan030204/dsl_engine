import { createContext, useContext } from 'react';

export const UnsavedChangesContext = createContext(null);

export function useUnsavedChangesNavigation() {
  const context = useContext(UnsavedChangesContext);
  if (!context) {
    throw new Error('useUnsavedChangesNavigation must be used within UnsavedChangesContext');
  }
  return context;
}

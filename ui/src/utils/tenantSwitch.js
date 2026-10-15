// What the header's tenant picker does when the tenant changes, kept free of React so it
// can be unit tested with node --test.
//
// Pages like /workflows/:id/edit/visual belong to one tenant, so showing them under another
// tenant ends in a 404. After a switch the user lands on the workflow list instead.
export const TENANT_HOME_PATH = '/workflows';

const isHome = (pathname) => String(pathname || '').replace(/\/+$/, '') === TENANT_HOME_PATH;

// Returns { setTenantNow, navigateTo, deferTenantChange }.
//  - setTenantNow: change the tenant immediately.
//  - navigateTo: path to open, or null to stay.
//  - deferTenantChange: with unsaved edits the navigation may be blocked by the "unsaved
//    changes" prompt. The tenant must then change only once the list page is reached,
//    otherwise the editor would unmount (its workflow 404s) and take the prompt with it.
export function planTenantSwitch({ nextTenantId, currentTenantId, pathname, isDirty }) {
  const nothing = { setTenantNow: false, navigateTo: null, deferTenantChange: false };
  if (!nextTenantId || nextTenantId === currentTenantId) return nothing;
  if (isHome(pathname)) return { ...nothing, setTenantNow: true };
  if (isDirty) return { ...nothing, navigateTo: TENANT_HOME_PATH, deferTenantChange: true };
  return { ...nothing, setTenantNow: true, navigateTo: TENANT_HOME_PATH };
}

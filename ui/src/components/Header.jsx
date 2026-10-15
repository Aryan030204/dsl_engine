import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTenant } from '../context/TenantContext';
import { useUnsavedChangesNavigation } from '../context/UnsavedChangesContext';
import { useTenants } from '../api/hooks';
import { Building2, ChevronDown, Plus } from 'lucide-react';
import CreateTenantModal from './CreateTenantModal';
import { TENANT_HOME_PATH, planTenantSwitch } from '../utils/tenantSwitch';

export default function Header() {
  const { tenantId, setTenantId } = useTenant();
  const { data: tenants, isLoading } = useTenants();
  const navigate = useNavigate();
  const location = useLocation();
  const { hasUnsavedChanges, blocker } = useUnsavedChangesNavigation();
  const [isOpen, setIsOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // A tenant waiting for the "unsaved changes" prompt to be resolved before it is applied.
  const [pendingTenantId, setPendingTenantId] = useState(null);
  const sawBlockedRef = useRef(false);

  const tenantList = tenants || [];

  const switchTenant = (nextTenantId) => {
    const plan = planTenantSwitch({
      nextTenantId,
      currentTenantId: tenantId,
      pathname: location.pathname,
      isDirty: hasUnsavedChanges,
    });
    sawBlockedRef.current = false;
    setPendingTenantId(plan.deferTenantChange ? nextTenantId : null);
    if (plan.setTenantNow) setTenantId(nextTenantId);
    if (plan.navigateTo) navigate(plan.navigateTo);
  };

  // Apply a deferred switch once the list page is reached; drop it if the user cancels the prompt.
  useEffect(() => {
    if (!pendingTenantId) return;
    if (location.pathname.replace(/\/+$/, '') === TENANT_HOME_PATH) {
      setTenantId(pendingTenantId);
      setPendingTenantId(null);
      return;
    }
    if (blocker.state === 'blocked') sawBlockedRef.current = true;
    else if (sawBlockedRef.current) {
      sawBlockedRef.current = false;
      setPendingTenantId(null);
    }
  }, [pendingTenantId, location.pathname, blocker.state, setTenantId]);

  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 fixed top-0 left-64 right-0 z-10">
      <div>
        {/* Breadcrumb can be added here */}
      </div>

      {/* Tenant Selector */}
      <div className="relative">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Building2 className="w-4 h-4 text-gray-500" />
          <span className="font-medium">{tenantId || 'Select Tenant'}</span>
          <ChevronDown className="w-4 h-4 text-gray-400" />
        </button>

        {isOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setIsOpen(false)}
            />
            <div className="absolute right-0 mt-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden">
              {isLoading ? (
                <div className="px-4 py-3 text-sm text-gray-500">Loading...</div>
              ) : tenantList.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-500">No tenants found</div>
              ) : (
                tenantList.map((tenant) => (
                  <button
                    key={tenant.tenantId}
                    onClick={() => {
                      switchTenant(tenant.tenantId);
                      setIsOpen(false);
                    }}
                    className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 ${
                      tenant.tenantId === tenantId ? 'bg-primary-50 text-primary-600' : ''
                    }`}
                  >
                    <div className="font-medium">{tenant.tenantId}</div>
                    <div className="text-xs text-gray-500">{tenant.name}</div>
                  </button>
                ))
              )}
              <div className="border-t border-gray-200">
                <button
                  onClick={() => {
                    setIsOpen(false);
                    setShowCreateModal(true);
                  }}
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center gap-2 text-primary-600"
                >
                  <Plus className="w-4 h-4" />
                  <span className="font-medium">Add Tenant</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Create Tenant Modal */}
      {showCreateModal && (
        <CreateTenantModal onClose={() => setShowCreateModal(false)} />
      )}
    </header>
  );
}

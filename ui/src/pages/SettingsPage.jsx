import { useState } from 'react';
import { Settings, Save, Trash2, Plus } from 'lucide-react';
import { useTenant } from '../context/TenantContext';
import { useTenants, useDeleteTenant, useUpdateTenant } from '../api/hooks';
import { Card, CardHeader, CardContent, CardTitle, Button, Badge, PageSpinner } from '../components/ui';
import CreateTenantModal from '../components/CreateTenantModal';
import { CURRENCY_OPTIONS } from '../constants/currencies';
import toast from 'react-hot-toast';

const TIMEZONE_OPTIONS = [
  'UTC',
  'Asia/Kolkata',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo'
];

export default function SettingsPage() {
  const { tenantId, setTenantId } = useTenant();
  const { data: tenants, isLoading } = useTenants();
  const deleteTenant = useDeleteTenant();
  const updateTenant = useUpdateTenant();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [timezoneDrafts, setTimezoneDrafts] = useState({});
  const [currencyDrafts, setCurrencyDrafts] = useState({});
  const [brandingDrafts, setBrandingDrafts] = useState({});

  const handleDeleteTenant = async (tid) => {
    if (!confirm(`Are you sure you want to deactivate tenant '${tid}'?`)) return;
    
    try {
      await deleteTenant.mutateAsync(tid);
      toast.success(`Tenant '${tid}' deactivated`);
      if (tenantId === tid && tenants?.length > 1) {
        const remaining = tenants.find(t => t.tenantId !== tid);
        if (remaining) setTenantId(remaining.tenantId);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete tenant');
    }
  };

  if (isLoading) return <PageSpinner />;

  const getDraftTimezone = (tenant) => timezoneDrafts[tenant.tenantId] ?? tenant.settings?.timezone ?? 'UTC';

  const handleSaveTimezone = async (tenant) => {
    const nextTimezone = getDraftTimezone(tenant);
    try {
      await updateTenant.mutateAsync({
        tenantId: tenant.tenantId,
        updates: {
          settings: {
            ...(tenant.settings || {}),
            timezone: nextTimezone
          }
        }
      });
      toast.success(`Timezone updated for '${tenant.tenantId}'`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update tenant timezone');
    }
  };

  const getDraftCurrency = (tenant) => currencyDrafts[tenant.tenantId] ?? tenant.settings?.currency ?? 'USD';

  const handleSaveCurrency = async (tenant) => {
    const nextCurrency = getDraftCurrency(tenant);
    try {
      await updateTenant.mutateAsync({
        tenantId: tenant.tenantId,
        updates: {
          settings: {
            ...(tenant.settings || {}),
            currency: nextCurrency
          }
        }
      });
      toast.success(`Currency updated for '${tenant.tenantId}'`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update tenant currency');
    }
  };

  const getBrandingDraft = (tenant) => brandingDrafts[tenant.tenantId] || tenant.settings?.emailBranding || {};
  const updateBrandingDraft = (tenant, field, value) => {
    setBrandingDrafts((prev) => ({
      ...prev,
      [tenant.tenantId]: { ...getBrandingDraft(tenant), [field]: value }
    }));
  };
  const handleSaveBranding = async (tenant) => {
    try {
      const emailBranding = Object.fromEntries(
        Object.entries(getBrandingDraft(tenant)).filter(([, value]) => String(value || '').trim() !== '')
      );
      await updateTenant.mutateAsync({
        tenantId: tenant.tenantId,
        updates: {
          settings: {
            ...(tenant.settings || {}),
            emailBranding
          }
        }
      });
      toast.success(`Email branding updated for '${tenant.tenantId}'`);
    } catch (err) {
      toast.error(err.response?.data?.errors?.join(', ') || err.response?.data?.error || 'Failed to update email branding');
    }
  };

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-gray-500 mt-1">
          Manage tenants and configure your workflow engine
        </p>
      </div>

      <div className="max-w-3xl space-y-6">
        {/* Tenant Management */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center">
              <Settings className="w-5 h-5 mr-2" />
              Tenant Management
            </CardTitle>
            <Button size="sm" onClick={() => setShowCreateModal(true)}>
              <Plus className="w-4 h-4 mr-1" />
              Add Tenant
            </Button>
          </CardHeader>
          <CardContent>
            {tenants?.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <p>No tenants found. Create your first tenant to get started.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {tenants?.map((tenant) => (
                  <div
                    key={tenant.tenantId}
                    className={`flex items-center justify-between p-4 rounded-lg border ${
                      tenant.tenantId === tenantId
                        ? 'border-primary-200 bg-primary-50'
                        : 'border-gray-200 bg-gray-50'
                    }`}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{tenant.tenantId}</span>
                        {tenant.tenantId === tenantId && (
                          <Badge status="active">Current</Badge>
                        )}
                      </div>
                      <p className="text-sm text-gray-600">{tenant.name}</p>
                      {tenant.description && (
                        <p className="text-xs text-gray-500 mt-1">{tenant.description}</p>
                      )}
                      <div className="flex gap-4 mt-2 text-xs text-gray-500">
                        <span>Currency: {tenant.settings?.currency || 'USD'}</span>
                        <span>Timezone: {tenant.settings?.timezone || 'UTC'}</span>
                      </div>
                      <div className="mt-3 flex items-end gap-2">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Scheduler Timezone</label>
                          <select
                            value={getDraftTimezone(tenant)}
                            onChange={(e) => setTimezoneDrafts((prev) => ({
                              ...prev,
                              [tenant.tenantId]: e.target.value
                            }))}
                            className="h-9 border border-gray-300 rounded-lg px-3 text-sm bg-white"
                          >
                            {TIMEZONE_OPTIONS.map((timeZone) => (
                              <option key={timeZone} value={timeZone}>{timeZone}</option>
                            ))}
                          </select>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleSaveTimezone(tenant)}
                          loading={updateTenant.isPending}
                        >
                          <Save className="w-4 h-4 mr-1" />
                          Save Timezone
                        </Button>
                      </div>
                      <div className="mt-3 flex items-end gap-2">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Currency</label>
                          <select
                            value={getDraftCurrency(tenant)}
                            onChange={(e) => setCurrencyDrafts((prev) => ({
                              ...prev,
                              [tenant.tenantId]: e.target.value
                            }))}
                            className="h-9 border border-gray-300 rounded-lg px-3 text-sm bg-white"
                          >
                            {/* Keep an unlisted saved code selectable rather than silently showing another. */}
                            {!CURRENCY_OPTIONS.some((option) => option.value === getDraftCurrency(tenant)) && (
                              <option value={getDraftCurrency(tenant)}>{getDraftCurrency(tenant)}</option>
                            )}
                            {CURRENCY_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleSaveCurrency(tenant)}
                          loading={updateTenant.isPending}
                        >
                          <Save className="w-4 h-4 mr-1" />
                          Save Currency
                        </Button>
                      </div>
                      <div className="mt-4 border-t border-gray-200 pt-3">
                        <div className="text-xs font-semibold text-gray-700 mb-2">Email Branding</div>
                        <div className="grid grid-cols-2 gap-2">
                          <input className="border rounded px-2 py-1.5 text-xs" placeholder="Display name" value={getBrandingDraft(tenant).displayName || ''} onChange={(e) => updateBrandingDraft(tenant, 'displayName', e.target.value)} />
                          <input className="border rounded px-2 py-1.5 text-xs" placeholder="Primary color (#66c61c)" value={getBrandingDraft(tenant).primaryColor || ''} onChange={(e) => updateBrandingDraft(tenant, 'primaryColor', e.target.value)} />
                          <input className="col-span-2 border rounded px-2 py-1.5 text-xs" placeholder="HTTPS logo URL" value={getBrandingDraft(tenant).logoUrl || ''} onChange={(e) => updateBrandingDraft(tenant, 'logoUrl', e.target.value)} />
                          <input className="col-span-2 border rounded px-2 py-1.5 text-xs" placeholder="Tagline" value={getBrandingDraft(tenant).tagline || ''} onChange={(e) => updateBrandingDraft(tenant, 'tagline', e.target.value)} />
                          <input className="col-span-2 border rounded px-2 py-1.5 text-xs" placeholder="Footer text" value={getBrandingDraft(tenant).footerText || ''} onChange={(e) => updateBrandingDraft(tenant, 'footerText', e.target.value)} />
                        </div>
                        <Button size="sm" variant="secondary" className="mt-2" onClick={() => handleSaveBranding(tenant)} loading={updateTenant.isPending}>
                          <Save className="w-4 h-4 mr-1" /> Save Branding
                        </Button>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {tenant.tenantId !== tenantId && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setTenantId(tenant.tenantId)}
                        >
                          Switch
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteTenant(tenant.tenantId)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* About */}
        <Card>
          <CardHeader>
            <CardTitle>About</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Version</dt>
                <dd className="font-medium">1.0.0</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Environment</dt>
                <dd className="font-medium">Development</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Active Tenant</dt>
                <dd className="font-medium">{tenantId || 'None'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Total Tenants</dt>
                <dd className="font-medium">{tenants?.length || 0}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>

      {/* Create Tenant Modal */}
      {showCreateModal && (
        <CreateTenantModal onClose={() => setShowCreateModal(false)} />
      )}
    </div>
  );
}

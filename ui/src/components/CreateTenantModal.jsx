import { useState } from 'react';
import { X, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useCreateTenant } from '../api/hooks';
import { useTenant } from '../context/TenantContext';
import { Button } from './ui';
import { CURRENCY_OPTIONS } from '../constants/currencies';

export default function CreateTenantModal({ onClose }) {
  const createTenant = useCreateTenant();
  const { setTenantId } = useTenant();

  const [formData, setFormData] = useState({
    tenantId: '',
    name: '',
    description: '',
    currency: 'USD',
    timezone: 'UTC',
  });

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!formData.tenantId.trim()) {
      toast.error('Tenant ID is required');
      return;
    }

    if (!formData.name.trim()) {
      toast.error('Tenant name is required');
      return;
    }

    try {
      const tenant = await createTenant.mutateAsync({
        tenantId: formData.tenantId.toUpperCase().trim(),
        name: formData.name.trim(),
        description: formData.description.trim(),
        settings: {
          currency: formData.currency,
          timezone: formData.timezone,
        },
      });
      toast.success(`Tenant '${tenant.tenantId}' created successfully`);
      setTenantId(tenant.tenantId);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create tenant');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold">Create Tenant</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-4 space-y-4">
            {/* Tenant ID */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tenant ID *
              </label>
              <input
                type="text"
                value={formData.tenantId}
                onChange={(e) =>
                  setFormData({ ...formData, tenantId: e.target.value })
                }
                placeholder="e.g., ACME"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 uppercase"
                required
              />
              <p className="text-xs text-gray-500 mt-1">
                Unique identifier, will be converted to uppercase
              </p>
            </div>

            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Name *
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) =>
                  setFormData({ ...formData, name: e.target.value })
                }
                placeholder="e.g., Acme Corporation"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                required
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) =>
                  setFormData({ ...formData, description: e.target.value })
                }
                placeholder="Optional description"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
            </div>

            {/* Currency */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Currency
              </label>
              <select
                value={formData.currency}
                onChange={(e) =>
                  setFormData({ ...formData, currency: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              >
                {CURRENCY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            {/* Timezone */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Timezone
              </label>
              <select
                value={formData.timezone}
                onChange={(e) =>
                  setFormData({ ...formData, timezone: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              >
                <option value="UTC">UTC</option>
                <option value="America/New_York">America/New_York</option>
                <option value="America/Los_Angeles">America/Los_Angeles</option>
                <option value="Europe/London">Europe/London</option>
                <option value="Europe/Paris">Europe/Paris</option>
                <option value="Asia/Tokyo">Asia/Tokyo</option>
                <option value="Asia/Kolkata">Asia/Kolkata</option>
              </select>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={createTenant.isPending}>
              <Plus className="w-4 h-4 mr-2" />
              Create Tenant
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

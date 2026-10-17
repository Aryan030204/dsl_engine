const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String },
    isActive: { type: Boolean, default: true },
    settings: {
      currency: { type: String, default: 'USD' },
      timezone: { type: String, default: 'UTC' },
      // Shopify store domain (e.g. the-man-company.myshopify.com): key for per-store cached data.
      shopifyDomain: { type: String, default: '' },
      emailBranding: {
        displayName: { type: String },
        logoUrl: { type: String },
        tagline: { type: String },
        primaryColor: { type: String },
        footerText: { type: String }
      }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Tenant', TenantSchema);

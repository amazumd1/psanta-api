function addTenantScope(schema, options = {}) {
  const required = options.required !== false;

  schema.add({
    tenantId: {
      type: String,
      trim: true,
      required,
      index: true,
    },
  });

  if (schema.path("createdAt")) {
    schema.index({ tenantId: 1, createdAt: -1 });
  }

  if (schema.path("status")) {
    schema.index({ tenantId: 1, status: 1, createdAt: -1 });
  }

  if (schema.path("propertyId")) {
    schema.index({ tenantId: 1, propertyId: 1, createdAt: -1 });
  }

  if (schema.path("customerId")) {
    schema.index({ tenantId: 1, customerId: 1, createdAt: -1 });
  }

  if (schema.path("userId")) {
    schema.index({ tenantId: 1, userId: 1, createdAt: -1 });
  }

  if (schema.path("fsId")) {
    schema.index({ tenantId: 1, fsId: 1 }, { sparse: true });
  }

  if (Array.isArray(options.extraIndexes)) {
    for (const idx of options.extraIndexes) {
      if (idx && idx.fields) {
        schema.index(idx.fields, idx.options || {});
      }
    }
  }
}

module.exports = {
  addTenantScope,
};
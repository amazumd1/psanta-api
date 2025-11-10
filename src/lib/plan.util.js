// TODO: wire this to your real plan/subscription store.
// Called with either propertyId or customerId.
async function getPlanSnapshot({ propertyId, customerId }) {
  // Minimal safe fallback
  return {
    planId: null,
    planName: '—',
    activeServices: [], // e.g. ['shampoo','deep-clean','fragrance']
  };
}
module.exports = { getPlanSnapshot };

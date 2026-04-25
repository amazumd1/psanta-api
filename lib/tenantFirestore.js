function tenantCollection(db, tenantId, name) {
  return db.collection("tenants").doc(String(tenantId)).collection(String(name));
}

function tenantDoc(db, tenantId, name, docId) {
  return tenantCollection(db, tenantId, name).doc(String(docId));
}

module.exports = {
  tenantCollection,
  tenantDoc,
};
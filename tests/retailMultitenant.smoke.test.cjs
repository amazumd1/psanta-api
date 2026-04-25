const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildRetailOwnedPayload,
  buildRetailReceiptDocId,
  buildRetailFailureDocId,
  buildRetailRunDocId,
  retailReceiptDoc,
  retailFailureDoc,
  retailRunDoc,
  retailConnectionDoc,
  retailSettingsDoc,
  retailReceiptsCollection,
  retailFailuresCollection,
  retailRunsCollection,
  retailAllowlistCollection,
  retailAllowlistDoc,
} = require("../lib/retailPaths");

function createFakeDb() {
  return {
    doc(path) {
      const clean = String(path || "").replace(/^\/+|\/+$/g, "");
      const segments = clean.split("/").filter(Boolean);
      return {
        path: clean,
        id: segments[segments.length - 1],
        parent: { path: segments.slice(0, -1).join("/") },
      };
    },
    collection(path) {
      const clean = String(path || "").replace(/^\/+|\/+$/g, "");
      return { path: clean };
    },
  };
}

class RetailMemoryStore {
  constructor(db) {
    this.db = db;
    this.docs = new Map();
  }

  set(ref, data) {
    this.docs.set(ref.path, { ...data });
    return ref;
  }

  get(ref) {
    const data = this.docs.get(ref.path);
    return data ? { ...data } : null;
  }

  update(ref, patch) {
    const prev = this.get(ref) || {};
    this.set(ref, { ...prev, ...patch });
  }

  delete(ref) {
    this.docs.delete(ref.path);
  }

  list(collectionRef) {
    const prefix = `${collectionRef.path}/`;
    return [...this.docs.entries()]
      .filter(
        ([path]) =>
          path.startsWith(prefix) && !path.slice(prefix.length).includes("/")
      )
      .map(([path, data]) => ({
        path,
        id: path.slice(prefix.length),
        data: { ...data },
      }));
  }
}

function promoteFailure(store, db, tenantId, row, overrides = {}) {
  const failureRef = retailFailureDoc(db, tenantId, row.docId || row.id);
  const rawId = String(row.rawId || row.id || row.messageId).trim();
  const promotedDocId = buildRetailReceiptDocId(tenantId, rawId);
  const receiptRef = retailReceiptDoc(db, tenantId, promotedDocId);

  const payload = buildRetailOwnedPayload(tenantId, {
    id: rawId,
    messageId: row.messageId || rawId,
    merchant: String(overrides.merchant ?? row.merchant ?? "").trim(),
    category: String(overrides.category ?? row.category ?? "Other").trim() || "Other",
    vendorAddress: String(overrides.vendorAddress ?? row.vendorAddress ?? "").trim(),
    orderId: String(overrides.orderId ?? row.orderId ?? "").trim(),
    orderDate: String(overrides.orderDate ?? row.orderDate ?? "").trim(),
    subtotal: Number(overrides.subtotal ?? row.subtotal ?? 0),
    tax: Number(overrides.tax ?? row.tax ?? 0),
    shipping: Number(overrides.shipping ?? row.shipping ?? 0),
    total: Number(overrides.total ?? row.total ?? 0),
    status: "UNVERIFIED",
    promotedFromFailureDocId: failureRef.id,
    promotedFromFailureRawId: rawId,
  });

  store.set(receiptRef, payload);
  store.update(failureRef, {
    reviewStatus: "PROMOTED",
    promotedReceiptDocId: receiptRef.id,
    promotedReceiptRawId: rawId,
  });

  return {
    receiptRef,
    failureRef,
  };
}

function migrateLegacySources(store, db, tenantId, actorUid, legacy) {
  for (const row of legacy.root.receipts) {
    store.set(
      retailReceiptDoc(db, tenantId, row.id),
      buildRetailOwnedPayload(tenantId, {
        ...row,
        migratedFromRoot: true,
      })
    );
  }

  for (const row of legacy.root.failures) {
    store.set(
      retailFailureDoc(db, tenantId, row.id),
      buildRetailOwnedPayload(tenantId, {
        ...row,
        migratedFromRoot: true,
      })
    );
  }

  for (const row of legacy.root.runs) {
    store.set(
      retailRunDoc(db, tenantId, row.runId),
      buildRetailOwnedPayload(tenantId, {
        ...row,
        migratedFromRoot: true,
      })
    );
  }

  for (const row of legacy.root.allowlist) {
    store.set(
      retailAllowlistDoc(db, tenantId, row.docId),
      buildRetailOwnedPayload(tenantId, {
        ...row,
        migratedFromRoot: true,
      })
    );
  }

  store.set(
    retailConnectionDoc(db, tenantId),
    buildRetailOwnedPayload(tenantId, {
      ...legacy.retailUsers.connection,
      connectedByUid: actorUid,
      migratedFromRetailUsers: true,
    })
  );

  store.set(
    retailSettingsDoc(db, tenantId),
    buildRetailOwnedPayload(tenantId, {
      ...legacy.retailUsers.settings,
      migratedFromRetailUsers: true,
    })
  );
}

test("tenant A receipts tenant B ko nahi dikhte aur sync canonical tenant path me write karta hai", () => {
  const db = createFakeDb();
  const store = new RetailMemoryStore(db);

  const tenantARef = retailReceiptDoc(db, "tenant-a", "gmail-msg-1");
  const tenantBRef = retailReceiptDoc(db, "tenant-b", "gmail-msg-1");

  store.set(
    tenantARef,
    buildRetailOwnedPayload("tenant-a", {
      id: "gmail-msg-1",
      merchant: "Amazon",
      total: 42,
    })
  );
  store.set(
    tenantBRef,
    buildRetailOwnedPayload("tenant-b", {
      id: "gmail-msg-1",
      merchant: "Target",
      total: 55,
    })
  );

  assert.equal(
    tenantARef.path,
    `tenants/tenant-a/retailReceipts/${buildRetailReceiptDocId(
      "tenant-a",
      "gmail-msg-1"
    )}`
  );
  assert.equal(
    tenantBRef.path,
    `tenants/tenant-b/retailReceipts/${buildRetailReceiptDocId(
      "tenant-b",
      "gmail-msg-1"
    )}`
  );

  const tenantAReceipts = store.list(retailReceiptsCollection(db, "tenant-a"));
  const tenantBReceipts = store.list(retailReceiptsCollection(db, "tenant-b"));

  assert.equal(tenantAReceipts.length, 1);
  assert.equal(tenantBReceipts.length, 1);
  assert.equal(tenantAReceipts[0].data.tenantId, "tenant-a");
  assert.equal(tenantBReceipts[0].data.tenantId, "tenant-b");
  assert.notEqual(tenantAReceipts[0].path, tenantBReceipts[0].path);
});

test("failure queue visible hai aur promote failure expected receipt doc create karta hai", () => {
  const db = createFakeDb();
  const store = new RetailMemoryStore(db);

  const failureRef = retailFailureDoc(db, "tenant-a", "gmail-failed-1");
  store.set(
    failureRef,
    buildRetailOwnedPayload("tenant-a", {
      id: "gmail-failed-1",
      messageId: "gmail-failed-1",
      merchant: "Best Buy",
      status: "PARSE_FAILED",
      category: "Other",
      total: 88,
    })
  );

  const visibleFailures = store
    .list(retailFailuresCollection(db, "tenant-a"))
    .filter((row) => String(row.data.status).toUpperCase() === "PARSE_FAILED");

  assert.equal(visibleFailures.length, 1);
  assert.equal(
    visibleFailures[0].id,
    buildRetailFailureDocId("tenant-a", "gmail-failed-1")
  );

  const result = promoteFailure(
    store,
    db,
    "tenant-a",
    {
      ...visibleFailures[0].data,
      docId: visibleFailures[0].id,
      rawId: visibleFailures[0].data.id,
    },
    {
      category: "Electronics",
    }
  );

  const promotedReceipt = store.get(result.receiptRef);
  const updatedFailure = store.get(result.failureRef);

  assert.equal(
    result.receiptRef.id,
    buildRetailReceiptDocId("tenant-a", "gmail-failed-1")
  );
  assert.equal(promotedReceipt.category, "Electronics");
  assert.equal(promotedReceipt.tenantId, "tenant-a");
  assert.equal(updatedFailure.reviewStatus, "PROMOTED");
  assert.equal(updatedFailure.promotedReceiptDocId, result.receiptRef.id);
});

test("edit aur delete docId-based receipt path par work karte hain", () => {
  const db = createFakeDb();
  const store = new RetailMemoryStore(db);
  const receiptRef = retailReceiptDoc(db, "tenant-a", "gmail-edit-1");

  store.set(
    receiptRef,
    buildRetailOwnedPayload("tenant-a", {
      id: "gmail-edit-1",
      merchant: "Whole Foods",
      category: "Groceries",
      total: 25,
    })
  );

  store.update(receiptRef, {
    category: "Food",
    total: 30,
    vendorAddress: "123 Main St",
  });

  const edited = store.get(receiptRef);
  assert.equal(edited.category, "Food");
  assert.equal(edited.total, 30);
  assert.equal(edited.vendorAddress, "123 Main St");

  store.delete(receiptRef);
  assert.equal(store.get(receiptRef), null);
});

test("migration root -> tenant canonical tenant docs, allowlist, runs, connection aur settings create karta hai", () => {
  const db = createFakeDb();
  const store = new RetailMemoryStore(db);

  migrateLegacySources(store, db, "tenant-cutover", "actor-1", {
    root: {
      receipts: [{ id: "r-1", merchant: "Amazon", total: 19 }],
      failures: [
        { id: "f-1", status: "PARSE_FAILED", merchant: "Unknown", total: 0 },
      ],
      runs: [{ runId: "run-1", type: "sync", requested: 10, matched: 2 }],
      allowlist: [
        { docId: "allow-1", type: "email", pattern: "orders@amazon.com" },
      ],
    },
    retailUsers: {
      connection: {
        gmailEmail: "owner@company.com",
        scopes: ["gmail.readonly"],
      },
      settings: {
        daysDefault: 30,
        receiptsLabel: "Retail Receipts",
        processedLabel: "Processed",
      },
    },
  });

  const receipts = store.list(retailReceiptsCollection(db, "tenant-cutover"));
  const failures = store.list(retailFailuresCollection(db, "tenant-cutover"));
  const runs = store.list(retailRunsCollection(db, "tenant-cutover"));
  const allowlist = store.list(retailAllowlistCollection(db, "tenant-cutover"));
  const connection = store.get(retailConnectionDoc(db, "tenant-cutover"));
  const settings = store.get(retailSettingsDoc(db, "tenant-cutover"));

  assert.equal(receipts.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(runs.length, 1);
  assert.equal(allowlist.length, 1);
  assert.ok(connection);
  assert.ok(settings);

  assert.equal(receipts[0].data.tenantId, "tenant-cutover");
  assert.equal(failures[0].data.workspaceId, "tenant-cutover");
  assert.equal(runs[0].id, buildRetailRunDocId("tenant-cutover", "run-1"));
  assert.equal(connection.connectedByUid, "actor-1");
  assert.equal(settings.retailOwnerId, "tenant-cutover");
});
const express = require("express");
const router = express.Router();


const { getFirestore, serverTimestamp } = require("../lib/firebaseAdminApp");
const {
  requireTenantAccess,
  requireTenantRole,
  normString,
} = require("../middleware/tenantAccess");
const { tenantCollection, tenantDoc } = require("../lib/tenantFirestore");


function cleanUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(cleanUndefined).filter((v) => v !== undefined);
  }

  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const next = cleanUndefined(v);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }

  return value === undefined ? undefined : value;
}

function pickAllowed(source, allowed) {
  const out = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) {
      out[key] = source[key];
    }
  }
  return cleanUndefined(out);
}


function normNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeEditedFields(fields = []) {
  const arr = Array.isArray(fields) ? fields : [fields];
  return Array.from(new Set(arr.map((x) => String(x || "").trim()).filter(Boolean)));
}

function normEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

function slugKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeTxStatus(v, fallback = "UNVERIFIED") {
  const s = String(v || fallback).trim().toUpperCase();
  return ["VERIFIED", "UNVERIFIED", "FLAGGED"].includes(s) ? s : fallback;
}

function normalize1099LineStatus(v, fallback = "UNVERIFIED") {
  const s = String(v || fallback).trim().toUpperCase();
  return ["UNVERIFIED", "PAID", "FLAGGED", "READY", "FILED"].includes(s)
    ? s
    : fallback;
}

function normalizePaymentRefs(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((item) => ({
      paymentId: normString(item?.paymentId || ""),
      amount: normNumber(item?.amount, 0),
      at: normString(item?.at || ""),
      source: normString(item?.source || ""),
      note: normString(item?.note || ""),
    }))
    .filter((item) => item.paymentId || item.amount || item.at || item.source || item.note);
}

function build1099HeaderId({ contractorId, email, year, businessName }) {
  const emailNorm = normEmail(email);
  const base = contractorId
    ? `biz_${contractorId}`
    : emailNorm
      ? `email_${slugKey(emailNorm)}`
      : `adhoc_${slugKey(businessName) || "unknown"}`;

  return `${base}_${year}`;
}

async function findContractorByEmail(db, tenantId, email) {
  const key = normEmail(email);
  if (!key) return null;

  {
    const snap = await tenantCollection(db, tenantId, "contractBusinesses")
      .where("emailLower", "==", key)
      .limit(1)
      .get();

    if (!snap.empty) {
      const doc = snap.docs[0];
      const row = doc.data() || {};
      return {
        id: doc.id,
        businessName: row.businessName || "",
        city: row.city || "",
        state: (row.state || "").toUpperCase(),
        zip: row.zip || "",
        email: row.email || key,
      };
    }
  }

  {
    let snap = await tenantCollection(db, tenantId, "w9Info")
      .where("emailLower", "==", key)
      .limit(1)
      .get();

    if (snap.empty) {
      snap = await tenantCollection(db, tenantId, "w9Info")
        .where("email", "==", key)
        .limit(1)
        .get();
    }

    if (!snap.empty) {
      const doc = snap.docs[0];
      const row = doc.data() || {};
      return {
        id: doc.id,
        businessName: row.businessName || row.name || "",
        city: row.city || "",
        state: (row.state || "").toUpperCase(),
        zip: row.zip || "",
        email: row.email || key,
      };
    }
  }

  return null;
}

async function ensure1099Header(db, tenantId, { contractorId = null, email = "", year, businessName = "" }) {
  const emailNorm = normEmail(email);
  const headerId = build1099HeaderId({
    contractorId,
    email: emailNorm,
    year,
    businessName,
  });

  const ref = tenantDoc(db, tenantId, "submitted1099Headers", headerId);
  const snap = await ref.get();
  const prev = snap.exists ? snap.data() || {} : {};
  const complianceStatus = contractorId ? "ok" : prev.complianceStatus || "unregistered";

  await ref.set(
    {
      contractorId: contractorId || null,
      sourceEmail: emailNorm || prev.sourceEmail || "",
      businessName:
        businessName ||
        prev.businessName ||
        (emailNorm ? emailNorm.split("@")[0] : "Contractor"),
      year,
      status: "live",
      headerType: contractorId ? "contractor" : "email",
      complianceStatus,
      totalAmount: Number(prev.totalAmount || 0),
      ...(snap.exists ? {} : { createdAt: serverTimestamp() }),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return { headerId, wasCreated: !snap.exists };
}

router.use(requireTenantRole(["owner", "admin", "ops", "accountant"]));

async function addAuditLog(req, payload) {
  const db = getFirestore();
  await tenantCollection(db, req.tenantId, "auditLogs").add({
    actorUserId: req.userId || null,
    actorEmail: req.userDoc?.email || null,
    action: payload.action || null,
    entityType: payload.entityType || null,
    entityId: payload.entityId || null,
    targetCollection: payload.targetCollection || null,
    tenantId: payload.tenantId || null,
    meta: cleanUndefined(payload.meta || {}),
    createdAt: serverTimestamp(),
  });
}

/* =========================
   Invoice boundary
   ========================= */

const INVOICE_FIELDS = [
  "title",
  "summary",
  "number",
  "po",
  "issueDate",
  "dueDate",
  "currency",
  "invoiceType",
  "cleaningType",
  "profitChannel",
  "taxPercent",
  "discountTotal",
  "subtotal",
  "taxTotal",
  "total",
  "amountDue",
  "amountPaid",
  "balanceDue",
  "notes",
  "footer",
  "status",
  "pdfURL",
  "paymentLink",
  "mongoInvoiceId",
  "issuerSnapshot",
  "customerSnapshot",
  "logo",
  "attachments",
  "customerName",
  "customerId",
  "lineItems",
  "tenantId",
];

router.post("/invoices", async (req, res) => {
  try {
    const db = getFirestore();
    const payload = pickAllowed(req.body || {}, INVOICE_FIELDS);

    if (!payload.number) {
      return res.status(400).json({ success: false, message: "number is required" });
    }

    const ref = tenantCollection(db, req.tenantId, "invoices").doc();
    await ref.set({
      ...payload,
      tenantId: req.tenantId,
      status: payload.status || "draft",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: req.userId || null,
      updatedByUid: req.userId || null,
    });

    await addAuditLog(req, {
      action: "invoice.create",
      entityType: "invoice",
      entityId: ref.id,
      targetCollection: "invoices",
      tenantId: req.tenantId,
      meta: {
        number: payload.number,
        status: payload.status || "draft",
      },
    });

    return res.status(201).json({
      success: true,
      id: ref.id,
    });
  } catch (e) {
    console.error("POST /api/business/invoices failed:", e);
    return res.status(500).json({ success: false, message: "Could not create invoice." });
  }
});

router.put("/invoices/:id", async (req, res) => {
  try {
    const db = getFirestore();
    const invoiceId = normString(req.params.id);
    const patch = pickAllowed(req.body || {}, INVOICE_FIELDS);

    if (!invoiceId) {
      return res.status(400).json({ success: false, message: "invoice id is required" });
    }

    await tenantDoc(db, req.tenantId, "invoices", invoiceId).set(
      {
        ...patch,
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "invoice.update",
      entityType: "invoice",
      entityId: invoiceId,
      targetCollection: "invoices",
      tenantId: req.tenantId,
      meta: {
        patchKeys: Object.keys(patch || {}),
      },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("PUT /api/business/invoices/:id failed:", e);
    return res.status(500).json({ success: false, message: "Could not update invoice." });
  }
});

router.post("/invoices/:id/status", async (req, res) => {
  try {
    const db = getFirestore();
    const invoiceId = normString(req.params.id);
    const status = normString(req.body?.status).toLowerCase();

    const allowed = new Set(["draft", "sent", "paid", "void", "overdue", "issued"]);
    if (!allowed.has(status)) {
      return res.status(400).json({ success: false, message: "Invalid invoice status." });
    }

    await tenantDoc(db, req.tenantId, "invoices", invoiceId).set(
      {
        status,
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await tenantDoc(db, req.tenantId, "invoiceActivity", invoiceId)
      .collection("events")
      .add({
        type: "status_change",
        tenantId: req.tenantId,
        message: `Status → ${status}`,
        at: serverTimestamp(),
        actorUserId: req.userId || null,
        actorEmail: req.userDoc?.email || null,
      });

    await addAuditLog(req, {
      action: "invoice.status",
      entityType: "invoice",
      entityId: invoiceId,
      targetCollection: "invoices",
      tenantId: req.tenantId,
      meta: { status },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/business/invoices/:id/status failed:", e);
    return res.status(500).json({ success: false, message: "Could not update invoice status." });
  }
});

router.post("/invoices/:id/activity", async (req, res) => {
  try {
    const db = getFirestore();
    const invoiceId = normString(req.params.id);
    const type = normString(req.body?.type);
    const message = normString(req.body?.message);

    if (!type || !message) {
      return res.status(400).json({ success: false, message: "type and message are required" });
    }

    await tenantDoc(db, req.tenantId, "invoiceActivity", invoiceId)
  .collection("events")
  .add({
        type,
        message,
        tenantId: req.tenantId,
        meta: cleanUndefined(req.body?.meta || {}),
        at: serverTimestamp(),
        actorUserId: req.userId || null,
        actorEmail: req.userDoc?.email || null,
      });

    await addAuditLog(req, {
      action: "invoice.activity",
      entityType: "invoice",
      entityId: invoiceId,
      targetCollection: "invoiceActivity",
      tenantId: req.tenantId,
      meta: { type, message },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/business/invoices/:id/activity failed:", e);
    return res.status(500).json({ success: false, message: "Could not log invoice activity." });
  }
});

router.delete("/invoices/:id", async (req, res) => {
  try {
    const db = getFirestore();
    const invoiceId = String(req.params.id || "").trim();

    if (!invoiceId) {
      return res.status(400).json({
        success: false,
        message: "invoice id is required",
      });
    }

    await tenantDoc(db, req.tenantId, "invoices", invoiceId).delete();

    await addAuditLog(req, {
      action: "invoice.delete",
      entityType: "invoice",
      entityId: invoiceId,
      targetCollection: "invoices",
      tenantId: req.tenantId,
    });

    return res.json({
      success: true,
      id: invoiceId,
    });
  } catch (e) {
    console.error("DELETE /api/business/invoices/:id failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not delete invoice.",
    });
  }
});

/* =========================
   Payroll boundary
   ========================= */

const PAYSTUB_FIELDS = [
  "employeeId",
  "employeeName",
  "name",
  "email",
  "address",
  "state",
  "payType",
  "paySchedule",
  "periodStart",
  "periodEnd",
  "payDate",
  "rate",
  "hours",
  "overtimeHours",
  "overtimeMultiplier",
  "annualSalary",
  "bonus",
  "commission",
  "reimbursements",
  "preTax401kPct",
  "preTaxHealth",
  "postTaxGarnishment",
  "gross",
  "federal",
  "stateTax",
  "ss",
  "medicare",
  "netPay",
  "net",
  "employerTaxes",
  "grossProfit",
  "pdfUrl",
  "ytdGross",
  "ytdDeductions",
  "ytdNet",
  "approveDate",
  "year",
  "tenantId",
];

router.put("/payroll/paystubs/:stubId", async (req, res) => {
  try {
    const db = getFirestore();
    const stubId = normString(req.params.stubId);
    const patch = pickAllowed(req.body || {}, PAYSTUB_FIELDS);

    const payDateStr = patch.payDate || new Date().toISOString().slice(0, 10);
    const parsedYear = Number(String(payDateStr).slice(0, 4));
    const year =
      Number.isFinite(parsedYear) && parsedYear > 2000
        ? parsedYear
        : new Date().getFullYear();

    await tenantDoc(db, req.tenantId, "paystubs", stubId).set(
      {
        ...patch,
        year,
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
        createdByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "payroll.paystub.save",
      entityType: "paystub",
      entityId: stubId,
      targetCollection: "paystubs",
      tenantId: req.tenantId,
      meta: { patchKeys: Object.keys(patch || {}), year },
    });

    return res.json({ success: true, stubId, year });
  } catch (e) {
    console.error("PUT /api/business/payroll/paystubs/:stubId failed:", e);
    return res.status(500).json({ success: false, message: "Could not save paystub." });
  }
});

router.put("/payroll/ytd/:employeeId", async (req, res) => {
  try {
    const db = getFirestore();
    const employeeId = normString(req.params.employeeId);
    const patch = pickAllowed(req.body || {}, ["gross", "deductions", "net"]);

    await tenantDoc(db, req.tenantId, "ytd", employeeId).set(
      {
        gross: normNumber(patch.gross, 0),
        deductions: normNumber(patch.deductions, 0),
        net: normNumber(patch.net, 0),
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "payroll.ytd.save",
      entityType: "ytd",
      entityId: employeeId,
      targetCollection: "ytd",
      tenantId: req.tenantId,
      meta: {
        gross: normNumber(patch.gross, 0),
        deductions: normNumber(patch.deductions, 0),
        net: normNumber(patch.net, 0),
      },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("PUT /api/business/payroll/ytd/:employeeId failed:", e);
    return res.status(500).json({ success: false, message: "Could not save YTD." });
  }
});

router.post("/payroll/company-metrics/:year/gross-profit-bump", async (req, res) => {
  try {
    const db = getFirestore();
    const year = Number(req.params.year);
    const deltaGP = normNumber(req.body?.deltaGP, 0);
    const tenantId = req.tenantId;

    if (!Number.isFinite(year) || year < 2000) {
      return res.status(400).json({ success: false, message: "Invalid year." });
    }

    const docId = `gp_${year}`;
    const ref = tenantDoc(db, req.tenantId, "companyMetrics", docId);
    const snap = await ref.get();
    const prev = snap.exists ? Number(snap.data()?.grossProfitYTD || 0) : 0;
    const next = prev + deltaGP;

    await ref.set(
      {
        year,
        grossProfitYTD: next,
        tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "payroll.companyMetrics.bumpGrossProfit",
      entityType: "companyMetric",
      entityId: docId,
      targetCollection: "companyMetrics",
      tenantId,
      meta: { year, previous: prev, deltaGP, next },
    });

    return res.json({ success: true, grossProfitYTD: next });
  } catch (e) {
    console.error("POST /api/business/payroll/company-metrics/:year/gross-profit-bump failed:", e);
    return res.status(500).json({ success: false, message: "Could not update company metrics." });
  }
});

/* =========================
   Receipt edit boundary
   ========================= */

const RECEIPT_PATCH_FIELDS = [
  "merchant",
  "senderEmail",
  "orderId",
  "category",
  "categorySource",
  "vendorAddress",
  "vendorAddressSource",
  "receiptUrl",
  "status",
  "items",
  "notes",
  "orderDate",
  "total",
  "tenantId",
];

router.patch("/receipts/:id", async (req, res) => {
  try {
    const db = getFirestore();
    const receiptId = normString(req.params.id);
    const patch = pickAllowed(req.body || {}, RECEIPT_PATCH_FIELDS);
    const editedFields = normalizeEditedFields(req.body?.editedFields || []);

    await tenantDoc(db, req.tenantId, "retailReceipts", receiptId).set(
      {
        ...patch,
        tenantId: req.tenantId,
        uiCorrected: true,
        uiCorrectedAt: serverTimestamp(),
        ...(editedFields.length ? { uiCorrectedFields: editedFields } : {}),
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "receipt.patch",
      entityType: "receipt",
      entityId: receiptId,
      targetCollection: "retailReceipts",
      tenantId: req.tenantId,
      meta: { patchKeys: Object.keys(patch || {}), editedFields },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("PATCH /api/business/receipts/:id failed:", e);
    return res.status(500).json({ success: false, message: "Could not update receipt." });
  }
});

router.post("/receipts/:id/status", async (req, res) => {
  try {
    const db = getFirestore();
    const receiptId = normString(req.params.id);
    const status = normString(req.body?.status).toUpperCase();

    await tenantDoc(db, req.tenantId, "retailReceipts", receiptId).set(
      {
        status,
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "receipt.status",
      entityType: "receipt",
      entityId: receiptId,
      targetCollection: "retailReceipts",
      tenantId: req.tenantId,
      meta: { status },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/business/receipts/:id/status failed:", e);
    return res.status(500).json({ success: false, message: "Could not update receipt status." });
  }
});

router.post("/receipts/:id/category", async (req, res) => {
  try {
    const db = getFirestore();
    const receiptId = normString(req.params.id);
    const category = normString(req.body?.category);

    await tenantDoc(db, req.tenantId, "retailReceipts", receiptId).set(
      {
        category,
        categorySource: "manual",
        uiCorrected: true,
        uiCorrectedAt: serverTimestamp(),
        uiCorrectedFields: ["category"],
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "receipt.category",
      entityType: "receipt",
      entityId: receiptId,
      targetCollection: "retailReceipts",
      tenantId: req.tenantId,
      meta: { category },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/business/receipts/:id/category failed:", e);
    return res.status(500).json({ success: false, message: "Could not update receipt category." });
  }
});

router.post("/receipts/:id/vendor-address", async (req, res) => {
  try {
    const db = getFirestore();
    const receiptId = normString(req.params.id);
    const vendorAddress = normString(req.body?.vendorAddress);

    await tenantDoc(db, req.tenantId, "retailReceipts", receiptId).set(
      {
        vendorAddress,
        vendorAddressSource: "manual",
        uiCorrected: true,
        uiCorrectedAt: serverTimestamp(),
        uiCorrectedFields: ["vendorAddress"],
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "receipt.vendorAddress",
      entityType: "receipt",
      entityId: receiptId,
      targetCollection: "retailReceipts",
      tenantId: req.tenantId,
      meta: { vendorAddress },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/business/receipts/:id/vendor-address failed:", e);
    return res.status(500).json({ success: false, message: "Could not update vendor address." });
  }
});

router.post("/receipts/:id/attach-url", async (req, res) => {
  try {
    const db = getFirestore();
    const receiptId = normString(req.params.id);
    const url = normString(req.body?.url);

    await tenantDoc(db, req.tenantId, "retailReceipts", receiptId).set(
      {
        receiptUrl: url,
        uiCorrected: true,
        uiCorrectedAt: serverTimestamp(),
        uiCorrectedFields: ["receiptUrl"],
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "receipt.attachUrl",
      entityType: "receipt",
      entityId: receiptId,
      targetCollection: "retailReceipts",
      tenantId: req.tenantId,
      meta: { url },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/business/receipts/:id/attach-url failed:", e);
    return res.status(500).json({ success: false, message: "Could not attach receipt URL." });
  }
});

router.delete("/receipts/:id", async (req, res) => {
  try {
    const db = getFirestore();
    const receiptId = normString(req.params.id);

    await addAuditLog(req, {
      action: "receipt.delete",
      entityType: "receipt",
      entityId: receiptId,
      targetCollection: "retailReceipts",
      tenantId: req.tenantId,
      meta: {},
    });

    await tenantDoc(db, req.tenantId, "retailReceipts", receiptId).delete();

    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/business/receipts/:id failed:", e);
    return res.status(500).json({ success: false, message: "Could not delete receipt." });
  }
});

/* =========================
   Bank transactions boundary
   ========================= */

const BANK_TRANSACTION_FIELDS = [
  "date",
  "txnDate",
  "amount",
  "descriptor",
  "merchant",
  "description",
  "referenceId",
  "paymentMethod",
  "sourceEmail",
  "source",
  "proofUrl",
  "ocrText",
  "emailPermalink",
  "status",
  "matchedLineId",
  "headerId",
  "notes",
  "tenantId",
];

router.post("/transactions/bank/import", async (req, res) => {
  try {
    const db = getFirestore();
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "rows[] is required",
      });
    }

    let batch = db.batch();
    let ops = 0;
    let inserted = 0;

    for (const raw of rows) {
      const date = normString(raw?.txnDate || raw?.date || "");
      const amount = normNumber(raw?.amount, 0);
      const descriptor = normString(raw?.descriptor || raw?.merchant || raw?.description || "");
      const ref = tenantCollection(db, req.tenantId, "bankTransactions").doc();

      batch.set(ref, {
        date,
        txnDate: date,
        amount,
        descriptor,
        merchant: normString(raw?.merchant || descriptor),
        description: normString(raw?.description || descriptor),
        referenceId: normString(raw?.referenceId || ""),
        paymentMethod: normString(raw?.paymentMethod || ""),
        sourceEmail: normEmail(raw?.sourceEmail || ""),
        source: normString(raw?.source || "manual-csv"),
        proofUrl: normString(raw?.proofUrl || ""),
        ocrText: normString(raw?.ocrText || ""),
        emailPermalink: normString(raw?.emailPermalink || ""),
        status: normalizeTxStatus(raw?.status, "UNVERIFIED"),
        matchedLineId: normString(raw?.matchedLineId || ""),
        headerId: normString(raw?.headerId || ""),
        notes: normString(raw?.notes || ""),
        tenantId: req.tenantId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdByUid: req.userId || null,
        updatedByUid: req.userId || null,
      });

      inserted += 1;
      ops += 1;

      if (ops >= 350) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
    }

    await addAuditLog(req, {
      action: "bankTransaction.import",
      entityType: "bankTransaction",
      entityId: null,
      targetCollection: "bankTransactions",
      tenantId: req.tenantId,
      meta: { inserted },
    });

    return res.json({
      success: true,
      inserted,
    });
  } catch (e) {
    console.error("POST /api/business/transactions/bank/import failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not import bank transactions.",
    });
  }
});

router.post("/transactions/bank", async (req, res) => {
  try {
    const db = getFirestore();
    const payload = pickAllowed(req.body || {}, BANK_TRANSACTION_FIELDS);

    const ref = tenantCollection(db, req.tenantId, "bankTransactions").doc();

    await ref.set({
      ...payload,
      amount: normNumber(payload.amount, 0),
      status: normalizeTxStatus(payload.status, "UNVERIFIED"),
      sourceEmail: normEmail(payload.sourceEmail || ""),
      tenantId: req.tenantId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdByUid: req.userId || null,
      updatedByUid: req.userId || null,
    });

    await addAuditLog(req, {
      action: "bankTransaction.create",
      entityType: "bankTransaction",
      entityId: ref.id,
      targetCollection: "bankTransactions",
      tenantId: req.tenantId,
      meta: {
        amount: normNumber(payload.amount, 0),
        merchant: normString(payload.merchant || ""),
        status: normalizeTxStatus(payload.status, "UNVERIFIED"),
      },
    });

    return res.status(201).json({
      success: true,
      id: ref.id,
    });
  } catch (e) {
    console.error("POST /api/business/transactions/bank failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not create bank transaction.",
    });
  }
});

router.patch("/transactions/bank/:id", async (req, res) => {
  try {
    const db = getFirestore();
    const txId = normString(req.params.id);
    const patch = pickAllowed(req.body || {}, BANK_TRANSACTION_FIELDS);

    if (!txId) {
      return res.status(400).json({
        success: false,
        message: "transaction id is required",
      });
    }

    if (Object.prototype.hasOwnProperty.call(patch, "amount")) {
      patch.amount = normNumber(patch.amount, 0);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      patch.status = normalizeTxStatus(patch.status, "UNVERIFIED");
    }

    if (Object.prototype.hasOwnProperty.call(patch, "sourceEmail")) {
      patch.sourceEmail = normEmail(patch.sourceEmail || "");
    }

    await tenantDoc(db, req.tenantId, "bankTransactions", txId).set(
      {
        ...patch,
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "bankTransaction.update",
      entityType: "bankTransaction",
      entityId: txId,
      targetCollection: "bankTransactions",
      tenantId: req.tenantId,
      meta: { patchKeys: Object.keys(patch || {}) },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("PATCH /api/business/transactions/bank/:id failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not update bank transaction.",
    });
  }
});

router.post("/transactions/bank/:id/status", async (req, res) => {
  try {
    const db = getFirestore();
    const txId = normString(req.params.id);
    const status = normalizeTxStatus(req.body?.status, "UNVERIFIED");

    await tenantDoc(db, req.tenantId, "bankTransactions", txId).set(
      {
        status,
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "bankTransaction.status",
      entityType: "bankTransaction",
      entityId: txId,
      targetCollection: "bankTransactions",
      tenantId: req.tenantId,
      meta: { status },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/business/transactions/bank/:id/status failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not update bank transaction status.",
    });
  }
});

router.post("/transactions/bank/:id/link-1099", async (req, res) => {
  try {
    const db = getFirestore();
    const txId = normString(req.params.id);
    const headerId = normString(req.body?.headerId || "");
    const matchedLineId = normString(req.body?.matchedLineId || "");
    const status = normalizeTxStatus(
      req.body?.status,
      matchedLineId ? "VERIFIED" : "UNVERIFIED"
    );

    await tenantDoc(db, req.tenantId, "bankTransactions", txId).set(
      {
        headerId: headerId || null,
        matchedLineId: matchedLineId || null,
        status,
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "bankTransaction.link1099",
      entityType: "bankTransaction",
      entityId: txId,
      targetCollection: "bankTransactions",
      tenantId: req.tenantId,
      meta: { headerId, matchedLineId, status },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/business/transactions/bank/:id/link-1099 failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not link bank transaction to 1099.",
    });
  }
});

router.delete("/transactions/bank/:id", async (req, res) => {
  try {
    const db = getFirestore();
    const txId = normString(req.params.id);

    await addAuditLog(req, {
      action: "bankTransaction.delete",
      entityType: "bankTransaction",
      entityId: txId,
      targetCollection: "bankTransactions",
      tenantId: req.tenantId,
      meta: {},
    });

    await tenantDoc(db, req.tenantId, "bankTransactions", txId).delete();

    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/business/transactions/bank/:id failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not delete bank transaction.",
    });
  }
});

router.post("/reconcile/confirm-match", async (req, res) => {
  try {
    const db = getFirestore();
    const lineId = normString(req.body?.lineId);
    const txId = normString(req.body?.txId);

    if (!lineId || !txId) {
      return res.status(400).json({
        success: false,
        message: "lineId and txId are required",
      });
    }

    const lineRef = tenantDoc(db, req.tenantId, "submitted1099Lines", lineId);
    const txRef = tenantDoc(db, req.tenantId, "bankTransactions", txId);

    const [lineSnap, txSnap] = await Promise.all([lineRef.get(), txRef.get()]);
    if (!lineSnap.exists || !txSnap.exists) {
      return res.status(404).json({
        success: false,
        message: "Matching line or transaction not found",
      });
    }

    const line = lineSnap.data() || {};
    const tx = txSnap.data() || {};
    const amount = normNumber(
      req.body?.amount,
      Number(line.amount || tx.amount || 0)
    );

    const nextPaymentRefs = [
      ...normalizePaymentRefs(line.paymentRefs || []),
      {
        paymentId: txId,
        amount,
        at: normString(req.body?.txnDate || tx.txnDate || tx.date || ""),
        source: normString(tx.source || "bank"),
        note: normString(tx.descriptor || tx.description || ""),
      },
    ];

    await lineRef.set(
      {
        status: "PAID",
        paid: true,
        amountPaid:
          Number(line.amountPaid || 0) > 0
            ? Number(line.amountPaid || 0)
            : amount,
        paidAt: serverTimestamp(),
        paymentRefs: nextPaymentRefs,
        updatedAt: serverTimestamp(),
        tenantId: req.tenantId,
      },
      { merge: true }
    );

    await txRef.set(
      {
        matchedLineId: lineId,
        headerId: normString(line.headerId || tx.headerId || ""),
        status: "VERIFIED",
        updatedAt: serverTimestamp(),
        updatedByUid: req.userId || null,
        reconciledAt: serverTimestamp(),
        reconciledByUid: req.userId || null,
        tenantId: req.tenantId,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "reconcile.confirmMatch",
      entityType: "1099Line",
      entityId: lineId,
      targetCollection: "submitted1099Lines",
      tenantId: req.tenantId,
      meta: {
        txId,
        amount,
        headerId: normString(line.headerId || ""),
      },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("POST /api/business/reconcile/confirm-match failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not confirm reconciliation match.",
    });
  }
});

/* =========================
   1099 compliance boundary
   ========================= */

const COMPLIANCE_1099_LINE_FIELDS = [
  "headerId",
  "year",
  "businessName",
  "state",
  "contractorId",
  "sourceEmail",
  "category",
  "description",
  "amount",
  "billDate",
  "pdfUrl",
  "status",
  "paid",
  "paidAt",
  "amountPaid",
  "paymentRefs",
  "emailPermalink",
  "source",
  "sourcePaymentId",
  "jobId",
  "propertyId",
  "tenantId",
];

router.post("/compliance/1099/import-parsed-emails", async (req, res) => {
  try {
    const db = getFirestore();
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    let inserted = 0;
    let duplicates = 0;
    let linked = 0;
    let unregistered = 0;

    for (const raw of rows) {
      const email = normEmail(raw?.email || raw?.from || raw?.sender || "");
      const amount = normNumber(raw?.amount, 0);
      const billDate =
        normString(raw?.billDate || raw?.date || "") ||
        new Date().toISOString().slice(0, 10);
      const year =
        Number(String(billDate).slice(0, 4)) || new Date().getFullYear();
      const category = normString(raw?.category || "Other");
      const description =
        normString(raw?.description || "") ||
        `${category} on ${billDate}`;
      const emailPermalink = normString(raw?.emailPermalink || raw?.permalink || "");

      let contractor = null;
      if (email) {
        contractor = await findContractorByEmail(db, req.tenantId, email);
      }

      const displayName =
        normString(raw?.businessName || "") ||
        normString(contractor?.businessName || "") ||
        (email ? email.split("@")[0] : "Contractor");

      const { headerId } = await ensure1099Header(db, req.tenantId, {
        contractorId: contractor?.id || null,
        email,
        year,
        businessName: displayName,
      });

      if (contractor?.id) linked += 1;
      else unregistered += 1;

      const dupSnap = await tenantCollection(db, req.tenantId, "submitted1099Lines")
        .where("headerId", "==", headerId)
        .where("amount", "==", amount)
        .where("billDate", "==", billDate)
        .where("category", "==", category)
        .limit(1)
        .get();

      if (!dupSnap.empty) {
        duplicates += 1;
        continue;
      }

      await tenantCollection(db, req.tenantId, "submitted1099Lines").add({
        headerId,
        year,
        businessName: displayName,
        state: normString(contractor?.state || "").toUpperCase(),
        contractorId: contractor?.id || null,
        sourceEmail: email,
        category,
        description,
        amount,
        billDate,
        emailPermalink,
        status: "UNVERIFIED",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        tenantId: req.tenantId,
      });

      inserted += 1;

      if (!contractor?.id) {
        const flagId = `1099_unregistered_${headerId}`;
        await tenantDoc(db, req.tenantId, "aiComplianceFlags", flagId).set(
          {
            type: "1099-unregistered-contractor",
            severity: "WARN",
            status: "open",
            title: "1099 line for unregistered contractor",
            message:
              "A 1099 line was created from email, but the contractor is not registered. Review and link or onboard.",
            headerId,
            key: email || displayName,
            refId: headerId,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            tenantId: req.tenantId,
          },
          { merge: true }
        );
      }
    }

    await addAuditLog(req, {
      action: "1099.importParsedEmails",
      entityType: "1099Line",
      entityId: null,
      targetCollection: "submitted1099Lines",
      tenantId: req.tenantId,
      meta: { inserted, duplicates, linked, unregistered },
    });

    return res.json({
      success: true,
      data: { inserted, duplicates, linked, unregistered },
    });
  } catch (e) {
    console.error("POST /api/business/compliance/1099/import-parsed-emails failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not import parsed 1099 emails.",
    });
  }
});

router.post("/compliance/1099/headers/ensure", async (req, res) => {
  try {
    const db = getFirestore();
    const contractorId = normString(req.body?.contractorId || "");
    const email = normEmail(req.body?.email || "");
    const year = Number(req.body?.year || new Date().getFullYear());
    const businessName = normString(req.body?.businessName || "");

    const { headerId, wasCreated } = await ensure1099Header(db, req.tenantId, {
      contractorId: contractorId || null,
      email,
      year,
      businessName,
    });

    await addAuditLog(req, {
      action: "1099.header.ensure",
      entityType: "1099Header",
      entityId: headerId,
      targetCollection: "submitted1099Headers",
      tenantId: req.tenantId,
      meta: { wasCreated, contractorId: contractorId || null, email, year },
    });

    return res.json({
      success: true,
      data: { headerId, wasCreated },
    });
  } catch (e) {
    console.error("POST /api/business/compliance/1099/headers/ensure failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not ensure 1099 header.",
    });
  }
});

router.post("/compliance/1099/headers/:headerId/total-bump", async (req, res) => {
  try {
    const db = getFirestore();
    const headerId = normString(req.params.headerId);
    const delta = normNumber(req.body?.delta, 0);

    const ref = tenantDoc(db, req.tenantId, "submitted1099Headers", headerId);
    const snap = await ref.get();
    const prev = snap.exists ? Number(snap.data()?.totalAmount || 0) : 0;
    const next = prev + delta;

    await ref.set(
      {
        totalAmount: next,
        updatedAt: serverTimestamp(),
        tenantId: req.tenantId,
      },
      { merge: true }
    );

    return res.json({
      success: true,
      data: { headerId, totalAmount: next },
    });
  } catch (e) {
    console.error("POST /api/business/compliance/1099/headers/:headerId/total-bump failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not update 1099 header total.",
    });
  }
});

router.post("/compliance/1099/headers/:headerId/link-contractor", async (req, res) => {
  try {
    const db = getFirestore();
    const headerId = normString(req.params.headerId);
    const contractorId = normString(req.body?.contractorId || "");
    const businessName = normString(req.body?.businessName || "");

    if (!headerId || !contractorId) {
      return res.status(400).json({
        success: false,
        message: "headerId and contractorId are required",
      });
    }

    const headerRef = tenantDoc(db, req.tenantId, "submitted1099Headers", headerId);
    await headerRef.set(
      {
        contractorId,
        ...(businessName ? { businessName } : {}),
        complianceStatus: "ok",
        updatedAt: serverTimestamp(),
        tenantId: req.tenantId,
      },
      { merge: true }
    );

    const snap = await tenantCollection(db, req.tenantId, "submitted1099Lines")
      .where("headerId", "==", headerId)
      .get();

    let batch = db.batch();
    let ops = 0;

    for (const docSnap of snap.docs) {
      batch.set(
        docSnap.ref,
        {
          contractorId,
          ...(businessName ? { businessName } : {}),
          updatedAt: serverTimestamp(),
          tenantId: req.tenantId,
        },
        { merge: true }
      );
      ops += 1;

      if (ops >= 350) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
    }

    await addAuditLog(req, {
      action: "1099.header.linkContractor",
      entityType: "1099Header",
      entityId: headerId,
      targetCollection: "submitted1099Headers",
      tenantId: req.tenantId,
      meta: { contractorId, businessName, affectedLines: snap.size || 0 },
    });

    return res.json({
      success: true,
      data: { headerId, contractorId, affectedLines: snap.size || 0 },
    });
  } catch (e) {
    console.error("POST /api/business/compliance/1099/headers/:headerId/link-contractor failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not link contractor to 1099 header.",
    });
  }
});

router.post("/compliance/1099/lines", async (req, res) => {
  try {
    const db = getFirestore();
    const payload = pickAllowed(req.body || {}, COMPLIANCE_1099_LINE_FIELDS);

    const headerId = normString(payload.headerId || "");
    const amount = normNumber(payload.amount, 0);

    if (!headerId) {
      return res.status(400).json({
        success: false,
        message: "headerId is required",
      });
    }

    const ref = tenantCollection(db, req.tenantId, "submitted1099Lines").doc();

    await ref.set({
      ...payload,
      amount,
      year: Number(payload.year || new Date().getFullYear()),
      sourceEmail: normEmail(payload.sourceEmail || ""),
      status: normalize1099LineStatus(payload.status, "UNVERIFIED"),
      paymentRefs: normalizePaymentRefs(payload.paymentRefs || []),
      paid: Boolean(payload.paid),
      ...(payload.paid ? { paidAt: payload.paidAt || serverTimestamp() } : {}),
      tenantId: req.tenantId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const headerRef = tenantDoc(db, req.tenantId, "submitted1099Headers", headerId);
    const headerSnap = await headerRef.get();
    const prevTotal = headerSnap.exists ? Number(headerSnap.data()?.totalAmount || 0) : 0;

    await headerRef.set(
      {
        totalAmount: prevTotal + amount,
        updatedAt: serverTimestamp(),
        tenantId: req.tenantId,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "1099.line.create",
      entityType: "1099Line",
      entityId: ref.id,
      targetCollection: "submitted1099Lines",
      tenantId: req.tenantId,
      meta: { headerId, amount },
    });

    return res.status(201).json({
      success: true,
      id: ref.id,
    });
  } catch (e) {
    console.error("POST /api/business/compliance/1099/lines failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not create 1099 line.",
    });
  }
});

router.patch("/compliance/1099/headers/:headerId/open", async (req, res) => {
  try {
    const db = getFirestore();
    const headerId = normString(req.params.headerId);
    const openedBy = normString(req.body?.openedBy || req.userId || "system");

    await tenantDoc(db, req.tenantId, "submitted1099Headers", headerId).set(
      {
        openedBy,
        openedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        tenantId: req.tenantId,
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "1099.header.open",
      entityType: "1099Header",
      entityId: headerId,
      targetCollection: "submitted1099Headers",
      tenantId: req.tenantId,
      meta: { openedBy },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("PATCH /api/business/compliance/1099/headers/:headerId/open failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not update 1099 header open state.",
    });
  }
});

router.patch("/compliance/1099/lines/:lineId", async (req, res) => {
  try {
    const db = getFirestore();
    const lineId = normString(req.params.lineId);
    const patch = pickAllowed(req.body || {}, COMPLIANCE_1099_LINE_FIELDS);

    if (!lineId) {
      return res.status(400).json({
        success: false,
        message: "line id is required",
      });
    }

    if (Object.prototype.hasOwnProperty.call(patch, "amount")) {
      patch.amount = normNumber(patch.amount, 0);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "sourceEmail")) {
      patch.sourceEmail = normEmail(patch.sourceEmail || "");
    }

    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      patch.status = normalize1099LineStatus(patch.status, "UNVERIFIED");
    }

    if (Object.prototype.hasOwnProperty.call(patch, "paymentRefs")) {
      patch.paymentRefs = normalizePaymentRefs(patch.paymentRefs || []);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "paid")) {
      if (patch.paid === true && !Object.prototype.hasOwnProperty.call(patch, "paidAt")) {
        patch.paidAt = serverTimestamp();
      }
      if (patch.paid === false && !Object.prototype.hasOwnProperty.call(patch, "paidAt")) {
        patch.paidAt = null;
      }
    }

    await tenantDoc(db, req.tenantId, "submitted1099Lines", lineId).set(
      {
        ...patch,
        tenantId: req.tenantId,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    await addAuditLog(req, {
      action: "1099.line.patch",
      entityType: "1099Line",
      entityId: lineId,
      targetCollection: "submitted1099Lines",
      tenantId: req.tenantId,
      meta: { patchKeys: Object.keys(patch || {}) },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("PATCH /api/business/compliance/1099/lines/:lineId failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not update 1099 line.",
    });
  }
});

router.delete("/compliance/1099/lines/:lineId", async (req, res) => {
  try {
    const db = getFirestore();
    const lineId = normString(req.params.lineId);
    const ref = tenantDoc(db, req.tenantId, "submitted1099Lines", lineId);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({
        success: false,
        message: "1099 line not found",
      });
    }

    const row = snap.data() || {};
    const headerId = normString(row.headerId || "");
    const amount = normNumber(row.amount, 0);

    await ref.delete();

    if (headerId) {
      const headerRef = tenantDoc(db, req.tenantId, "submitted1099Headers", headerId);
      const headerSnap = await headerRef.get();
      const prevTotal = headerSnap.exists ? Number(headerSnap.data()?.totalAmount || 0) : 0;

      await headerRef.set(
        {
          totalAmount: prevTotal - amount,
          updatedAt: serverTimestamp(),
          tenantId: req.tenantId,
        },
        { merge: true }
      );
    }

    await addAuditLog(req, {
      action: "1099.line.delete",
      entityType: "1099Line",
      entityId: lineId,
      targetCollection: "submitted1099Lines",
      tenantId: req.tenantId,
      meta: { headerId, amount },
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/business/compliance/1099/lines/:lineId failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not delete 1099 line.",
    });
  }
});

router.delete("/compliance/1099/headers/:headerId/cascade", async (req, res) => {
  try {
    const db = getFirestore();
    const headerId = normString(req.params.headerId);

    const snap = await tenantCollection(db, req.tenantId, "submitted1099Lines")
      .where("headerId", "==", headerId)
      .get();

    let batch = db.batch();
    let ops = 0;

    for (const docSnap of snap.docs) {
      batch.delete(docSnap.ref);
      ops += 1;

      if (ops >= 350) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }

    if (ops > 0) {
      await batch.commit();
    }

    await tenantDoc(db, req.tenantId, "submitted1099Headers", headerId).delete();

    await addAuditLog(req, {
      action: "1099.header.cascadeDelete",
      entityType: "1099Header",
      entityId: headerId,
      targetCollection: "submitted1099Headers",
      tenantId: req.tenantId,
      meta: { deletedLines: snap.size || 0 },
    });

    return res.json({
      success: true,
      deletedLines: snap.size || 0,
    });
  } catch (e) {
    console.error("DELETE /api/business/compliance/1099/headers/:headerId/cascade failed:", e);
    return res.status(500).json({
      success: false,
      message: "Could not delete 1099 header and lines.",
    });
  }
});

module.exports = router;
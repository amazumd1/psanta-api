const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const User1099Transaction = require("../models/User1099Transaction");
const UserPayeeAlias = require("../models/UserPayeeAlias");
const PCPersona = require("../models/PCPersona");

function normStr(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function normEmail(v) {
  const s = normStr(v);
  return s ? s.toLowerCase() : null;
}

function normAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normStatus(v) {
  const s = String(v || "UNVERIFIED").trim().toUpperCase();
  return ["VERIFIED", "UNVERIFIED", "FLAGGED"].includes(s) ? s : "UNVERIFIED";
}

function slugKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function serialize(doc) {
  const row = doc && typeof doc.toObject === "function"
    ? doc.toObject({ versionKey: false })
    : { ...(doc || {}) };

  row.id = String(row._id);
  delete row._id;
  delete row.__v;
  return row;
}

function toObjectId(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;

  const s = String(v || "").trim();
  if (!mongoose.Types.ObjectId.isValid(s)) return null;

  return new mongoose.Types.ObjectId(s);
}

async function syncProUsdSpent(userIdLike) {
  const userId = toObjectId(userIdLike);
  if (!userId) return 0;

  const rows = await User1099Transaction.aggregate([
    { $match: { userId } },
    {
      $group: {
        _id: "$userId",
        totalSpent: { $sum: { $ifNull: ["$amount", 0] } },
      },
    },
  ]);

  const totalSpent = Number(rows?.[0]?.totalSpent || 0) || 0;

  await PCPersona.findOneAndUpdate(
    { userId, kind: "pro" },
    { $set: { usdSpent: totalSpent } },
    { new: false }
  );

  return totalSpent;
}

router.get("/transactions", async (req, res) => {
  try {
    const items = await User1099Transaction.find({ userId: req.userId })
      .sort({ txnDate: -1, createdAt: -1, _id: -1 })
      .lean();

    return res.json({
      success: true,
      items: items.map(serialize),
    });
  } catch (e) {
    console.error("GET /finance/transactions failed:", e);
    return res.status(500).json({ success: false, message: "Could not load transactions." });
  }
});

router.post("/transactions", async (req, res) => {
  try {
    const amount = normAmount(req.body?.amount);
    const txnDate = normStr(req.body?.txnDate);
    const merchant = normStr(req.body?.merchant);

    if (!txnDate || !merchant || !amount) {
      return res.status(400).json({
        success: false,
        message: "txnDate, merchant, and amount are required.",
      });
    }

    const row = await User1099Transaction.create({
      userId: req.userId,
      ownerAuthId: String(req.userId),
      ownerEmail: normEmail(req.userDoc?.email),
      ownerName: normStr(req.body?.ownerName),

      txnDate,
      date: normStr(req.body?.date) || txnDate,
      amount,
      merchant,
      description: normStr(req.body?.description),
      referenceId: normStr(req.body?.referenceId),
      paymentMethod: normStr(req.body?.paymentMethod),
      sourceEmail: normEmail(req.body?.sourceEmail),

      source: normStr(req.body?.source) || "payment-screenshot",
      sourceApp: normStr(req.body?.sourceApp) || "ops-app",

      proofUrl: normStr(req.body?.proofUrl),
      ocrText: normStr(req.body?.ocrText),

      status: normStatus(req.body?.status),
      matchedLineId: normStr(req.body?.matchedLineId),
      headerId: normStr(req.body?.headerId),
    });

    await syncProUsdSpent(row.userId);

    return res.status(201).json({
      success: true,
      item: serialize(row),
    });
  } catch (e) {
    console.error("POST /finance/transactions failed:", e);
    return res.status(500).json({ success: false, message: "Could not save transaction." });
  }
});

router.patch("/transactions/:id", async (req, res) => {
  try {
    const patch = {};
    const allowed = [
      "txnDate",
      "date",
      "merchant",
      "description",
      "referenceId",
      "paymentMethod",
      "sourceEmail",
      "source",
      "sourceApp",
      "proofUrl",
      "ocrText",
      "matchedLineId",
      "headerId",
      "status",
    ];

    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        if (key === "sourceEmail") patch[key] = normEmail(req.body[key]);
        else if (key === "status") patch[key] = normStatus(req.body[key]);
        else patch[key] = normStr(req.body[key]);
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "amount")) {
      patch.amount = normAmount(req.body.amount);
    }

    const row = await User1099Transaction.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: patch },
      { new: true }
    );

    if (!row) {
      return res.status(404).json({ success: false, message: "Transaction not found." });
    }

    await syncProUsdSpent(row.userId);

    return res.json({ success: true });
  } catch (e) {
    console.error("PATCH /finance/transactions/:id failed:", e);
    return res.status(500).json({ success: false, message: "Could not update transaction." });
  }
});

router.delete("/transactions/:id", async (req, res) => {
  try {
    const row = await User1099Transaction.findOneAndDelete({
      _id: req.params.id,
      userId: req.userId,
    });

    if (!row) {
      return res.status(404).json({ success: false, message: "Transaction not found." });
    }

    return res.json({ success: true });
  } catch (e) {
    console.error("DELETE /finance/transactions/:id failed:", e);
    return res.status(500).json({ success: false, message: "Could not delete transaction." });
  }
});

router.get("/payee-alias", async (req, res) => {
  try {
    const merchant = normStr(req.query?.merchant);
    if (!merchant) {
      return res.json({ success: true, item: null });
    }

    const alias = await UserPayeeAlias.findOne({
      userId: req.userId,
      merchantKey: slugKey(merchant),
    }).lean();

    return res.json({
      success: true,
      item: alias ? serialize(alias) : null,
    });
  } catch (e) {
    console.error("GET /finance/payee-alias failed:", e);
    return res.status(500).json({ success: false, message: "Could not load payee alias." });
  }
});

router.put("/payee-alias", async (req, res) => {
  try {
    const merchant = normStr(req.body?.merchant);
    const sourceEmail = normEmail(req.body?.sourceEmail);

    if (!merchant || !sourceEmail) {
      return res.status(400).json({
        success: false,
        message: "merchant and sourceEmail are required.",
      });
    }

    const alias = await UserPayeeAlias.findOneAndUpdate(
      {
        userId: req.userId,
        merchantKey: slugKey(merchant),
      },
      {
        $set: {
          userId: req.userId,
          ownerAuthId: String(req.userId),
          merchantKey: slugKey(merchant),
          merchant,
          sourceEmail,
        },
      },
      { upsert: true, new: true }
    );

    return res.json({
      success: true,
      item: serialize(alias),
    });
  } catch (e) {
    console.error("PUT /finance/payee-alias failed:", e);
    return res.status(500).json({ success: false, message: "Could not save payee alias." });
  }
});

module.exports = router;
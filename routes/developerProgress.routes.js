const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { v2: cloudinary } = require("cloudinary");

const DeveloperProgressUpdate = require("../models/DeveloperProgressUpdate");

const router = express.Router();

const MAX_FILE_MB = Number(process.env.DEV_PROGRESS_MAX_UPLOAD_MB || 50);
const MAX_FILES = Number(process.env.DEV_PROGRESS_MAX_FILES || 8);

const CLOUDINARY_READY = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

const IS_VERCEL = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "",
  api_key: process.env.CLOUDINARY_API_KEY || "",
  api_secret: process.env.CLOUDINARY_API_SECRET || "",
});

const allowedExtensions = new Set([
  ".ppt",
  ".pptx",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".txt",
  ".csv",
]);

const allowedMimeTypes = new Set([
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/plain",
  "text/csv",
]);

function publicApiOrigin(req) {
  const configured = String(
    process.env.PUBLIC_API_ORIGIN || process.env.API_PUBLIC_URL || ""
  ).trim();

  if (configured) return configured.replace(/\/+$/, "");

  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("host");

  return `${proto}://${host}`;
}

function sanitizeFilename(name) {
  const ext = path.extname(name || "").toLowerCase();

  const base = path
    .basename(name || "developer-progress-file", ext)
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

  return `${base || "developer-progress-file"}${ext || ""}`;
}

function getFileType(file) {
  const ext = path.extname(file.originalname || "").replace(".", "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();

  if (ext === "ppt" || ext === "pptx" || mime.includes("powerpoint")) {
    return ext || "pptx";
  }

  if (ext === "pdf" || mime.includes("pdf")) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (ext === "doc" || ext === "docx") return ext;
  if (ext === "xls" || ext === "xlsx") return ext;
  if (ext === "csv") return "csv";
  if (ext === "txt") return "txt";

  return ext || "file";
}

function getRequiredWriteToken() {
  return String(
    process.env.DEVELOPER_PROGRESS_WRITE_TOKEN ||
      process.env.DEVELOPER_PROGRESS_UPLOAD_TOKEN ||
      ""
  ).trim();
}

function requireDeveloperProgressToken(req, res, next) {
  const requiredToken = getRequiredWriteToken();

  if (!requiredToken) return next();

  const providedToken = String(req.get("x-developer-progress-token") || "").trim();

  if (providedToken !== requiredToken) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized developer progress write. Token is invalid.",
    });
  }

  return next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_MB * 1024 * 1024,
    files: MAX_FILES,
  },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();

    if (allowedMimeTypes.has(file.mimetype) || allowedExtensions.has(ext)) {
      return cb(null, true);
    }

    return cb(
      new Error(
        "Unsupported file type. Use PPT, PPTX, PDF, image, Word, Excel, TXT, or CSV."
      )
    );
  },
});

function uploadToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const folder =
      process.env.CLOUDINARY_DEVELOPER_PROGRESS_FOLDER ||
      "propertysanta/developer-progress";

    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "auto",
        use_filename: true,
        unique_filename: true,
        filename_override: sanitizeFilename(file.originalname),
        context: {
          source: "developer-progress",
          original_filename: file.originalname || "developer-progress-file",
        },
      },
      (error, result) => {
        if (error) return reject(error);

        return resolve({
          url: result.secure_url,
          publicId: result.public_id,
          provider: "cloudinary",
        });
      }
    );

    stream.end(file.buffer);
  });
}

async function saveToLocalDev(req, file) {
  const uploadDir = path.join(__dirname, "..", "uploads", "developer-progress");

  await fs.promises.mkdir(uploadDir, { recursive: true });

  const safeName = sanitizeFilename(file.originalname);
  const filename = `${Date.now()}-${crypto
    .randomBytes(6)
    .toString("hex")}-${safeName}`;
  const finalPath = path.join(uploadDir, filename);

  await fs.promises.writeFile(finalPath, file.buffer);

  return {
    url: `${publicApiOrigin(req)}/uploads/developer-progress/${encodeURIComponent(
      filename
    )}`,
    publicId: filename,
    provider: "local-dev",
  };
}

function cleanString(value, fallback = "", max = 12000) {
  const text = String(value ?? fallback).trim();
  return text.slice(0, max);
}

function cleanStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanString(item, "", 1200))
      .filter(Boolean)
      .slice(0, 200);
  }

  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => cleanString(line, "", 1200))
      .filter(Boolean)
      .slice(0, 200);
  }

  return [];
}

function cleanLinks(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => ({
      label: cleanString(item?.label, "Open link", 180),
      url: cleanString(item?.url, "", 2000),
    }))
    .filter((item) => item.url)
    .slice(0, 100);
}

function cleanAttachments(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => ({
      type: cleanString(item?.type, "file", 80),
      title: cleanString(item?.title || item?.originalName, "Attachment", 240),
      url: cleanString(item?.url, "", 2000),
      publicId: cleanString(item?.publicId, "", 500),
      provider: cleanString(item?.provider, "", 120),
      mimeType: cleanString(item?.mimeType, "", 200),
      sizeBytes: Number(item?.sizeBytes || 0),
      originalName: cleanString(item?.originalName, "", 240),
    }))
    .filter((item) => item.url)
    .slice(0, 100);
}

function normalizeDate(value) {
  const raw = cleanString(value, "", 20);

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const fallback = new Date();
  const year = fallback.getFullYear();
  const month = String(fallback.getMonth() + 1).padStart(2, "0");
  const day = String(fallback.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function makeUpdateId(value) {
  const existing = cleanString(value, "", 120);
  if (existing) return existing;

  return `dev-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function buildUpdatePayload(body) {
  const title = cleanString(body?.title, "Untitled developer update", 240);

  return {
    updateId: makeUpdateId(body?.id || body?.updateId),
    date: normalizeDate(body?.date),
    title,
    phase: cleanString(body?.phase, "Daily Build", 120),
    category: cleanString(body?.category, "Development", 120),
    status: cleanString(body?.status, "In Progress", 80),
    summary: cleanString(body?.summary, "", 12000),
    businessValue: cleanString(body?.businessValue, "", 12000),
    technicalDetails: cleanStringArray(body?.technicalDetails),
    links: cleanLinks(body?.links),
    attachments: cleanAttachments(body?.attachments),
    createdBy: cleanString(body?.createdBy, "developer-progress-page", 160),
  };
}

function formatUpdate(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc || {};

  return {
    id: String(raw.updateId || raw.id || raw._id || ""),
    date: raw.date || "",
    title: raw.title || "",
    phase: raw.phase || "",
    category: raw.category || "",
    status: raw.status || "",
    summary: raw.summary || "",
    businessValue: raw.businessValue || "",
    technicalDetails: Array.isArray(raw.technicalDetails) ? raw.technicalDetails : [],
    links: Array.isArray(raw.links) ? raw.links : [],
    attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
    createdAt: raw.createdAt ? new Date(raw.createdAt).toISOString() : "",
    updatedAt: raw.updatedAt ? new Date(raw.updatedAt).toISOString() : "",
  };
}

router.get("/health", (req, res) => {
  res.json({
    ok: true,
    route: "developer-progress",
    uploadReady: true,
    updatesReady: true,
    mongoReady: mongoose.connection.readyState === 1,
    cloudinaryReady: CLOUDINARY_READY,
    isVercel: IS_VERCEL,
    maxFileMb: MAX_FILE_MB,
    maxFiles: MAX_FILES,
  });
});

router.get("/updates", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 250), 500);

    const docs = await DeveloperProgressUpdate.find({})
      .sort({ date: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      source: "mongodb",
      count: docs.length,
      updates: docs.map(formatUpdate),
    });
  } catch (error) {
    console.error("❌ Developer progress updates fetch failed:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Developer progress updates fetch failed.",
    });
  }
});

router.post("/updates", requireDeveloperProgressToken, async (req, res) => {
  try {
    const payload = buildUpdatePayload(req.body);

    if (!payload.title) {
      return res.status(400).json({
        ok: false,
        error: "Title is required.",
      });
    }

    const doc = await DeveloperProgressUpdate.findOneAndUpdate(
      { updateId: payload.updateId },
      { $set: payload },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    return res.status(201).json({
      ok: true,
      source: "mongodb",
      update: formatUpdate(doc),
    });
  } catch (error) {
    console.error("❌ Developer progress update save failed:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Developer progress update save failed.",
    });
  }
});

router.post("/updates/import", requireDeveloperProgressToken, async (req, res) => {
  try {
    const rawUpdates = Array.isArray(req.body?.updates) ? req.body.updates : [];

    if (!rawUpdates.length) {
      return res.status(400).json({
        ok: false,
        error: "No local developer progress updates received for import.",
      });
    }

    const uniqueById = new Map();

    for (const item of rawUpdates.slice(0, 1000)) {
      const payload = buildUpdatePayload(item);

      if (!payload.title) continue;

      uniqueById.set(payload.updateId, payload);
    }

    const updatesToImport = Array.from(uniqueById.values());

    if (!updatesToImport.length) {
      return res.status(400).json({
        ok: false,
        error: "No valid developer progress updates found for import.",
      });
    }

    const operations = updatesToImport.map((payload) => ({
      updateOne: {
        filter: { updateId: payload.updateId },
        update: { $set: payload },
        upsert: true,
      },
    }));

    const result = await DeveloperProgressUpdate.bulkWrite(operations, {
      ordered: false,
    });

    const importedIds = updatesToImport.map((item) => item.updateId);

    const docs = await DeveloperProgressUpdate.find({
      updateId: { $in: importedIds },
    })
      .sort({ date: -1, createdAt: -1 })
      .lean();

    return res.json({
      ok: true,
      source: "mongodb",
      imported: updatesToImport.length,
      matchedCount: result.matchedCount || 0,
      modifiedCount: result.modifiedCount || 0,
      upsertedCount: result.upsertedCount || 0,
      updates: docs.map(formatUpdate),
    });
  } catch (error) {
    console.error("❌ Developer progress local import failed:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Developer progress local import failed.",
    });
  }
});

router.delete(
  "/updates/:id",
  requireDeveloperProgressToken,
  async (req, res) => {
    try {
      const id = cleanString(req.params.id, "", 160);

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: "Update id is required.",
        });
      }

      const deleted = await DeveloperProgressUpdate.findOneAndDelete({
        updateId: id,
      });

      return res.json({
        ok: true,
        deleted: Boolean(deleted),
        id,
      });
    } catch (error) {
      console.error("❌ Developer progress delete failed:", error);

      return res.status(500).json({
        ok: false,
        error: error.message || "Developer progress delete failed.",
      });
    }
  }
);

router.post(
  "/upload",
  requireDeveloperProgressToken,
  upload.array("files", MAX_FILES),
  async (req, res) => {
    try {
      const files = req.files || [];

      if (!files.length) {
        return res.status(400).json({
          ok: false,
          error: "No files received by backend.",
        });
      }

      if (IS_VERCEL && !CLOUDINARY_READY) {
        return res.status(500).json({
          ok: false,
          error:
            "Cloudinary env is missing on Vercel. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.",
        });
      }

      const savedFiles = [];

      for (const file of files) {
        const saved = CLOUDINARY_READY
          ? await uploadToCloudinary(file)
          : await saveToLocalDev(req, file);

        savedFiles.push({
          type: getFileType(file),
          title: file.originalname || "Developer progress attachment",
          url: saved.url,
          publicId: saved.publicId,
          provider: saved.provider,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          originalName: file.originalname,
        });
      }

      return res.json({
        ok: true,
        files: savedFiles,
      });
    } catch (error) {
      console.error("❌ Developer progress upload failed:", {
        message: error.message,
        stack: error.stack,
        cloudinaryReady: CLOUDINARY_READY,
        isVercel: IS_VERCEL,
      });

      return res.status(500).json({
        ok: false,
        error: error.message || "Developer progress upload failed.",
      });
    }
  }
);

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      ok: false,
      error: error.message,
    });
  }

  if (error) {
    return res.status(400).json({
      ok: false,
      error: error.message || "Upload failed.",
    });
  }

  return next();
});

module.exports = router;
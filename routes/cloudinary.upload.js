// services/api/routes/cloudinary.upload.js
const express = require("express");
const router = express.Router();
const { v2: cloudinary } = require("cloudinary");
const sharp = require("sharp");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
}

router.post("/cloudinary", async (req, res) => {
  try {
    const { imageDataUrl, folder, publicId } = req.body || {};
    const parsed = parseDataUrl(imageDataUrl);
    if (!parsed) return res.status(400).json({ ok: false, error: "Invalid imageDataUrl" });

    const inputBuf = Buffer.from(parsed.base64, "base64");

    // ✅ Convert to JPEG (bypasses png-not-allowed forever)
    const jpegBuf = await sharp(inputBuf)
      .resize({ width: 1800, withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();

    const up = await cloudinary.uploader.upload(
      `data:image/jpeg;base64,${jpegBuf.toString("base64")}`,
      {
        folder: folder || process.env.CLOUDINARY_FOLDER || "paymentScreenshots",
        public_id: publicId || undefined,
        resource_type: "image",
        format: "jpg",

        // ✅ IMPORTANT: apply your preset (even though signed upload)
        upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET || "payment_screenshots_unsigned",
      }
    );

    return res.json({
      ok: true,
      data: {
        url: up.secure_url,
        publicId: up.public_id,
        format: up.format,
        bytes: up.bytes,
        width: up.width,
        height: up.height,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

module.exports = router;

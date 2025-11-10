const router = require("express").Router();
const net = require("net");
const { zplBin, zplItem, zplPsQr, zplSscc, buildSSCC } = require("../lib/zpl");

function sendRaw(ip, zpl) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(8000);
    sock
      .on("error", reject)
      .on("timeout", () => reject(new Error("Printer timeout")))
      .on("close", () => resolve({ ok: true }));
    sock.connect(9100, ip, () => sock.write(zpl, () => sock.end()));
  });
}

// --- RAW ---
router.post("/raw", async (req, res) => {
  const { zpl, ip } = req.body || {};
  if (!zpl || !ip) return res.status(400).json({ error: "zpl & ip required" });
  try {
    await sendRaw(ip, zpl);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- BIN ---
router.post("/bin", async (req, res) => {
  const { warehouseCode, binCode, ip } = req.body || {};
  const target = ip || process.env.PRINTER_BIN_IP || process.env.PRINTER_ITEM_IP;
  if (!warehouseCode || !binCode || !target)
    return res.status(400).json({ error: "warehouseCode, binCode, printer IP required" });
  try {
    const zpl = zplBin({ warehouseCode, binCode });
    await sendRaw(target, zpl);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ITEM ---
router.post("/item", async (req, res) => {
  const { sku, name = "", barcode = "", reorderPoint = "", ip } = req.body || {};
  const target = ip || process.env.PRINTER_ITEM_IP || process.env.PRINTER_BIN_IP;
  if (!sku || !target) return res.status(400).json({ error: "sku and printer IP required" });
  try {
    const zpl = zplItem({ sku, name, barcode, reorderPoint });
    await sendRaw(target, zpl);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- PS-QR (carton) ---
router.post("/psqr", async (req, res) => {
  const { sku, qty = 1, lot = "", exp = "", ip } = req.body || {};
  const target = ip || process.env.PRINTER_PSQR_IP || process.env.PRINTER_ITEM_IP;
  if (!sku || !target) return res.status(400).json({ error: "sku and printer IP required" });
  try {
    const zpl = zplPsQr({ sku, qty, lot, exp });
    await sendRaw(target, zpl);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- SSCC (pallet) ---
router.post("/sscc", async (req, res) => {
  const { sscc, ext, companyPrefix, serialRef, shipToName = "", palletId = "", orderId = "", ip } = req.body || {};
  const target = ip || process.env.PRINTER_SSCC_IP || process.env.PRINTER_ITEM_IP;
  const code = sscc || buildSSCC({ ext, companyPrefix, serialRef }); // either provide sscc or parts
  if (!code || !target) return res.status(400).json({ error: "sscc (or parts) and printer IP required" });
  try {
    const zpl = zplSscc({ sscc: code, shipToName, palletId, orderId });
    await sendRaw(target, zpl);
    res.json({ ok: true, sscc: code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

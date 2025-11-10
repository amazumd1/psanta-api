// Simple ZPL builders (203 dpi defaults)

function esc(s = "") {
  return String(s || "").replace(/[\^~\\]/g, " "); // keep ZPL safe
}

// BIN label (2" x 1")
function zplBin({ warehouseCode = "", binCode = "" }) {
  return `^XA
^PW406
^LL203
^CF0,30
^FO20,10^FD${esc(warehouseCode)}^FS
^CF0,60
^FO20,45^FD${esc(binCode)}^FS
^BY2,3,60
^BCN,60,Y,N,N
^FO20,110^FD${esc(binCode)}^FS
^XZ`;
}

// Item shelf label (2" x 1.25")
function zplItem({ sku = "", name = "", barcode = "", reorderPoint = "" }) {
  return `^XA
^PW406
^LL254
^CF0,28
^FO20,10^FD${esc(name)}^FS
^CF0,26
^FO20,40^FDSKU: ${esc(sku)}^FS
^BY2,3,90
^BCN,90,Y,N,N
^FO20,70^FD${esc(barcode)}^FS
^CF0,24
^FO20,170^FDReorder: ${esc(String(reorderPoint || ""))}^FS
^XZ`;
}

// PS-QR (2" x 2") — auto-receive payload
function zplPsQr({ sku = "", qty = 1, lot = "", exp = "" }) {
  const payload = `PS|SKU:${sku}|QTY:${qty}|LOT:${lot}|EXP:${exp}`;
  return `^XA
^PW406
^LL406
^FO40,20^BQN,2,7
^FDQA,${esc(payload)}^FS
^CF0,30
^FO40,240^FDSKU: ${esc(sku)}^FS
^CF0,28
^FO40,275^FDQty ${esc(String(qty))}  Lot ${esc(lot)}^FS
^FO40,305^FDExp ${esc(exp)}^FS
^XZ`;
}

// GS1 check digit (mod-10)
function gs1CheckDigit(num) {
  const s = String(num).replace(/\D/g, "");
  let sum = 0, alt = true;
  for (let i = s.length - 1; i >= 0; i--) {
    const n = s.charCodeAt(i) - 48;
    sum += n * (alt ? 3 : 1);
    alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}

// Build SSCC from components (optional helper)
function buildSSCC({ ext = "0", companyPrefix = "", serialRef = "" }) {
  const body = `${ext}${companyPrefix}${serialRef}`; // len 17
  return body + gs1CheckDigit(body);
}

// SSCC pallet label (4" x 6")
function zplSscc({ sscc = "", shipToName = "", palletId = "", orderId = "" }) {
  const pretty = sscc ? `(00) ${sscc}` : "";
  return `^XA
^PW812
^LL1218
^CF0,60
^FO60,40^FDSSCC (00)^FS
^BY3,3,220
^BCN,220,Y,N,N
^FO60,120^FD>;00${esc(sscc)}^FS
^CF0,48
^FO60,360^FD${esc(pretty)}^FS
^CF0,36
^FO60,420^FDShip To: ${esc(shipToName)}^FS
^FO60,460^FDPallet: ${esc(palletId)}  Order: ${esc(orderId)}^FS
^XZ`;
}

module.exports = { zplBin, zplItem, zplPsQr, zplSscc, buildSSCC, gs1CheckDigit };

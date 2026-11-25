// Stamps a thin "Licensed to <email> · Order <id> · Do not distribute" line
// on every page of a PDF right before it's handed to the buyer. Pure
// anti-leak traceability, not DRM — it doesn't stop someone from re-sharing
// the file, but a leaked copy can be traced back to the order it came from.
// Runs on the fly at download time (no extra storage, no pre-processing step
// to keep in sync with the 18 source PDFs).
'use strict';
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

async function watermarkPdf(originalBytes, { email, orderId }) {
  const pdfDoc = await PDFDocument.load(originalBytes, { updateMetadata: false });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const label = `Licensed to ${email} · Order ${orderId.slice(0, 8)} · Do not distribute`;
  const fontSize = 7.5;
  const textWidth = font.widthOfTextAtSize(label, fontSize);

  for (const page of pdfDoc.getPages()) {
    const { width } = page.getSize();
    // Bottom-center footer strip — unobtrusive on a reading page, but present
    // on every single page so a cropped screenshot still usually shows it.
    page.drawText(label, {
      x: Math.max(18, (width - textWidth) / 2),
      y: 14,
      size: fontSize,
      font,
      color: rgb(0.55, 0.55, 0.55),
      opacity: 0.6,
    });
  }
  return Buffer.from(await pdfDoc.save());
}

module.exports = { watermarkPdf };

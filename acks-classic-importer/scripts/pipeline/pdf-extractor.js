/**
 * PDF extraction. Foundry ships pdf.js (used by its journal PDF pages); we
 * load it lazily from the core distribution. Falls back to a CDN copy if the
 * core path moves between Foundry versions.
 *
 * Output:
 *   { pages: [{page, text}], pageImages: [{page, dataUrl, isLikelyMap}] }
 *
 * "Likely map" heuristic: pages with very little extractable text but lots of
 * rendered ink are usually map plates in TSR-era scans.
 */

import { log, warn } from "../util/logger.js";

let _pdfjs = null;

async function getPdfJs() {
  if (_pdfjs) return _pdfjs;
  const candidates = [
    "scripts/pdfjs/pdf.mjs",                       // Foundry v12+
    "scripts/pdfjs/pdf.js",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.min.mjs"
  ];
  for (const src of candidates) {
    try {
      const mod = await import(/* @vite-ignore */ src);
      const lib = mod.default ?? mod;
      if (lib?.getDocument) {
        if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
          lib.GlobalWorkerOptions.workerSrc = src.replace(/pdf(\.min)?\.m?js$/, "pdf.worker$1.mjs");
        }
        _pdfjs = lib;
        log(`pdf.js loaded from ${src}`);
        return lib;
      }
    } catch (_e) { /* try next */ }
  }
  throw new Error("Could not load pdf.js");
}

export async function extractPdf(file, { renderScale = 1.5, onProgress } = {}) {
  const pdfjs = await getPdfJs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;

  const pages = [];
  const pageImages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(`Reading page ${i}/${doc.numPages}`, i / doc.numPages);
    const page = await doc.getPage(i);

    // ---- text ----
    const tc = await page.getTextContent();
    // Reassemble text with primitive line detection (pdf.js gives items with transforms).
    let lastY = null, out = [];
    for (const item of tc.items) {
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) out.push("\n");
      else if (out.length && !out[out.length - 1].endsWith("\n")) out.push(" ");
      out.push(item.str);
      lastY = y;
    }
    const text = out.join("").replace(/[ \t]+\n/g, "\n");
    pages.push({ page: i, text });

    // ---- render for map detection / later vision passes ----
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;

    const inkRatio = estimateInkRatio(ctx, canvas.width, canvas.height);
    const isLikelyMap = text.replace(/\s/g, "").length < 600 && inkRatio > 0.04;
    pageImages.push({ page: i, dataUrl: canvas.toDataURL("image/png"), isLikelyMap, inkRatio });
  }

  log(`Extracted ${doc.numPages} pages; candidate map plates: ${pageImages.filter(p => p.isLikelyMap).map(p => p.page).join(", ") || "none"}`);
  return { pages, pageImages };
}

function estimateInkRatio(ctx, w, h) {
  try {
    const sample = ctx.getImageData(0, 0, w, h).data;
    let dark = 0, n = 0;
    for (let i = 0; i < sample.length; i += 40) { // sparse sampling
      const lum = 0.299 * sample[i] + 0.587 * sample[i + 1] + 0.114 * sample[i + 2];
      if (lum < 128) dark++;
      n++;
    }
    return dark / n;
  } catch (e) {
    warn("Ink ratio sampling failed", e);
    return 0;
  }
}

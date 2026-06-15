/**
 * PDF extraction. Foundry ships pdf.js (used by its journal PDF pages); we
 * load it lazily from the core distribution. Falls back to a CDN copy if the
 * core path moves between Foundry versions.
 *
 * Output:
 *   { pages: [{page, text}], pageImages: [{page, dataUrl, isLikelyMap}] }
 *
 * "Likely map" heuristic: see isLikelyMapPage — TSR-era map plates are scanned
 * images with almost no embedded text but real ink, whereas keyed text pages
 * carry thousands of characters (and often MORE ink than a sparse line map, so
 * ink ratio alone is a poor discriminator — text length is the real signal).
 */

import { log, warn } from "../util/logger.js";

/**
 * Decide whether a rendered page is probably a map plate worth a vision pass.
 * Biased toward recall: a false positive costs one vision call that simply
 * answers "not a map", but a false negative loses a map entirely.
 *
 * @param {string} text       extracted page text
 * @param {number} inkRatio   fraction of dark sampled pixels (0..1)
 */
export function isLikelyMapPage(text, inkRatio) {
  const compact = String(text ?? "").replace(/\s/g, "").length;
  if (inkRatio <= 0.02) return false;   // effectively blank (title/divider) → not a plate
  if (compact < 200) return true;       // image-only page with real ink → almost certainly a scanned plate
  // Vector maps can embed short keyed labels or a printed scale note; allow a
  // keyword escape, but only for pages that aren't dense prose.
  const mapKeyword = /\bmap\b|\bscale\b|\d\s*(?:square|hex|inch)e?s?\s*=|=\s*\d+\s*(?:feet|ft|mile|yard)/i.test(text ?? "");
  return mapKeyword && compact < 1500;
}

let _pdfjs = null;

async function getPdfJs() {
  if (_pdfjs) return _pdfjs;
  const candidates = [
    "scripts/pdfjs/pdf.mjs",                       // Foundry v12+
    "scripts/pdfjs/pdf.js"
    // "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.min.mjs"
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
    const isLikelyMap = isLikelyMapPage(text, inkRatio);
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

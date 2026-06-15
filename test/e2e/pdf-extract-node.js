/**
 * Node-side PDF extraction for the e2e harness. Mirrors the shape the in-app
 * pdf-extractor produces ({pages:[{page,text}], pageImages:[{page,dataUrl,
 * isLikelyMap,inkRatio}]}) so the real pipeline consumes it unchanged — but
 * uses pdfjs-dist's legacy build + @napi-rs/canvas, which run under Node.
 */

import { createCanvas } from "@napi-rs/canvas";
import { isLikelyMapPage } from "../../scripts/pipeline/pdf-extractor.js";

export async function extractPdfNode(path, { renderScale = 1.5, maxPages = Infinity, pageSet = null } = {}) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array((await import("node:fs")).readFileSync(path));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

  const pages = [], pageImages = [];
  // Either an explicit set of page numbers (preserving their real page indices)
  // or the first `maxPages` pages. Real page numbers are kept either way so
  // sourcePages / plate.page references downstream stay correct.
  const wanted = pageSet
    ? [...pageSet].filter((p) => p >= 1 && p <= doc.numPages).sort((a, b) => a - b)
    : Array.from({ length: Math.min(doc.numPages, maxPages) }, (_, k) => k + 1);
  for (const i of wanted) {
    const page = await doc.getPage(i);

    // text
    const tc = await page.getTextContent();
    let lastY = null, out = [];
    for (const item of tc.items) {
      const y = item.transform?.[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) out.push("\n");
      else if (out.length && !out[out.length - 1].endsWith("\n")) out.push(" ");
      out.push(item.str ?? "");
      lastY = y;
    }
    const text = out.join("").replace(/[ \t]+\n/g, "\n");
    pages.push({ page: i, text });

    // render for map detection / vision passes
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const inkRatio = estimateInk(ctx, canvas.width, canvas.height);
    const isLikelyMap = isLikelyMapPage(text, inkRatio);
    pageImages.push({ page: i, dataUrl: canvas.toDataURL("image/png"), isLikelyMap, inkRatio });
  }
  return { pages, pageImages, numPages: doc.numPages };
}

function estimateInk(ctx, w, h) {
  try {
    const d = ctx.getImageData(0, 0, w, h).data;
    let dark = 0, tot = 0;
    for (let i = 0; i < d.length; i += 40) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum < 128) dark++; tot++;
    }
    return dark / tot;
  } catch { return 0; }
}

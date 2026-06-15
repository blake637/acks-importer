/**
 * End-to-end pipeline test (headless, no Foundry, no manual intervention).
 *
 *   node test/e2e/run-e2e.js <path-to.pdf> [--pages N] [--out DIR]
 *
 * Configuration via environment (so keys never live in the repo):
 *   ACKS_LLM_PROVIDER   anthropic | openai | custom        (default: custom)
 *   ACKS_LLM_ENDPOINT   e.g. http://localhost:8080         (OpenAI-compatible)
 *   ACKS_LLM_KEY        API key (optional for local)
 *   ACKS_LLM_MODEL      model name
 *   ACKS_IMG_PROVIDER   none | comfyui | openai | stability | custom  (default: none)
 *   ACKS_IMG_ENDPOINT   e.g. http://127.0.0.1:8188
 *   ACKS_IMG_KEY        image API key
 *   ACKS_IMG_MODEL      checkpoint / model
 *   ACKS_COMFY_CONTROLNET / ACKS_COMFY_WORKFLOW   optional
 *   ACKS_EDITION        auto | classic | 5e               (default: auto)
 *   ACKS_ENC_PER_TERRAIN  integer                          (default: 1)
 *
 * The run drives the REAL ImporterApp.run() with live LLM/image calls, with
 * all Foundry document creation recorded. It then writes a full artifact tree
 * for offline inspection. It does NOT assert pass/fail on content quality
 * (that needs human judgment) — it asserts the pipeline COMPLETED and emits
 * the paper trail; a crash or zero actors sets a non-zero exit code.
 */

import "./recording-shim.js";
import { REC } from "./recording-shim.js";
import { extractPdfNode } from "./pdf-extract-node.js";
import { DebugLog } from "../../scripts/util/debug-log.js";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const pdfPath = args.find((a) => !a.startsWith("--"));
const pagesLimit = num(flag("--pages")) ?? Infinity;
// --page-range <spec>: run on specific pages, e.g. "1,2,7" or "3-10" or
// "1,5-8,12". Overrides --pages (which is a count of leading pages). Real page
// numbers are preserved so plate/sourcePage references stay correct.
const pageSpec = flag("--page-range") ?? flag("--pages-list");
const pageSet = pageSpec ? parsePageSpec(pageSpec) : null;
const outDir = flag("--out") ?? path.join("test", "e2e", "artifacts", `run-${stamp()}`);
// --only <stage[,stage...]>: run just part of the pipeline. Extraction +
// conversion always run (prereqs). Stages: actors | maps | journals.
// Aliases: scenes→maps, tables→journals. Default (no flag) = everything.
const STAGE_ALIASES = { actors: "actors", maps: "maps", scenes: "maps", journals: "journals", tables: "journals" };
const onlyArg = flag("--only");
const stages = onlyArg
  ? new Set(onlyArg.split(",").map((s) => STAGE_ALIASES[s.trim().toLowerCase()]).filter(Boolean))
  : null;

if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error("Usage: node test/e2e/run-e2e.js <path-to.pdf> [--pages N] [--page-range 1,5-8] [--out DIR] [--only actors|maps|journals]");
  process.exit(2);
}
if (onlyArg && (!stages || !stages.size)) {
  console.error(`Unknown --only value "${onlyArg}". Use: actors, maps, journals (comma-separated).`);
  process.exit(2);
}
if (pageSpec && (!pageSet || !pageSet.size)) {
  console.error(`Unknown --page-range value "${pageSpec}". Use page numbers/ranges, e.g. "1,2,7" or "3-10".`);
  process.exit(2);
}

// ---- configure settings from env (read by getSetting via the shim) ----
const S = globalThis.__ACKS_SETTINGS;
Object.assign(S, {
  llmProvider: env("ACKS_LLM_PROVIDER", "custom"),
  llmEndpoint: env("ACKS_LLM_ENDPOINT", ""),
  llmApiKey: env("ACKS_LLM_KEY", ""),
  llmModel: env("ACKS_LLM_MODEL", "gpt-4o-mini"),
  llmTimeoutSec: Number(env("ACKS_LLM_TIMEOUT", "600")),
  imgProvider: env("ACKS_IMG_PROVIDER", "none"),
  imgEndpoint: env("ACKS_IMG_ENDPOINT", ""),
  imgApiKey: env("ACKS_IMG_KEY", ""),
  imgModel: env("ACKS_IMG_MODEL", "flux-2-klein-base-9b-fp8.safetensors"),
  fluxUnet: env("ACKS_IMG_MODEL", "flux-2-klein-base-9b-fp8.safetensors"),
  fluxClip: env("ACKS_FLUX_CLIP", "qwen_3_8b_fp8mixed.safetensors"),
  fluxVae: env("ACKS_FLUX_VAE", "flux2-vae.safetensors"),
  comfyWorkflow: env("ACKS_COMFY_WORKFLOW", ""),
  generateTokenArt: env("ACKS_IMG_PROVIDER", "none") !== "none",
  generateMapArt: env("ACKS_IMG_PROVIDER", "none") !== "none",
  reviewBeforeCreate: false,        // unattended: no checkpoints
  sourceEdition: env("ACKS_EDITION", "auto"),
  gridSizePx: 100, feetPerSquare: 10,
  encounterMapsPerTerrain: Number(env("ACKS_ENC_PER_TERRAIN", "1")),
  monsterCompendiums: "", itemCompendiums: ""
});

const startedAt = Date.now();
console.log(`E2E: ${pdfPath}`);
console.log(`  LLM:   ${S.llmProvider} ${S.llmModel} @ ${S.llmEndpoint || "(provider default)"}`);
console.log(`  Image: ${S.imgProvider} ${S.imgModel} @ ${S.imgEndpoint || "-"}`);
console.log(`  Stages:${stages ? " " + [...stages].join(", ") + " only" : " all"}`);
console.log(`  Out:   ${outDir}\n`);

// Incrementally flush the AI-call log so that even a hard crash — e.g. a
// native canvas abort that bypasses JS try/catch AND process exit hooks —
// still leaves a paper trail. Between LLM/image calls the event loop is idle
// long enough for this to fire; writeArtifacts() later overwrites it with the
// richer version on a clean finish.
mkdir(outDir);
const callsPath = path.join(outDir, "ai-calls.json");
const slimCall = (e) => ({
  ...e,
  thumbnail: e.thumbnail ? "(see ai-call-images/)" : undefined,
  inputImages: e.inputImages?.length ? `(${e.inputImages.length} input image(s) — see ai-call-images/)` : undefined
});
const flushCalls = () => {
  try {
    fs.writeFileSync(callsPath, JSON.stringify(DebugLog.entries.map(slimCall), null, 2));
  } catch { /* best effort — never let logging crash the run */ }
};
// Flush synchronously the moment any call is recorded or settles — the render
// stages run synchronously right after a layout call returns, so a native
// crash there would otherwise lose that call's response (the timer can't fire
// mid-stack). The timer stays as a coarse backstop.
DebugLog.onChange = flushCalls;
const flushTimer = setInterval(flushCalls, 400);
flushTimer.unref?.();
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flushCalls(); process.exit(130); });

let pipelineError = null;
try {
  // Extract with the Node extractor, then drive the real pipeline.
  console.log("Extracting PDF (pdfjs + canvas)…");
  const preExtracted = await extractPdfNode(pdfPath, pageSet ? { pageSet } : { maxPages: pagesLimit });
  console.log(`  ${preExtracted.pages.length} pages (of ${preExtracted.numPages})` +
    (pageSet ? ` [pages ${preExtracted.pages.map((p) => p.page).join(", ")}]` : "") + "; " +
    `${preExtracted.pageImages.filter((p) => p.isLikelyMap).length} candidate map plates\n`);

  // Import the real app AFTER the shim is installed.
  const { ImporterApp } = await import("../../scripts/apps/importer-app.js");
  const { registerSettings } = await import("../../scripts/settings.js");
  registerSettings(); // no-op registrations under the shim

  const app = new ImporterApp();
  // Mirror the live status log to the console so progress is visible.
  const origStatus = app["_ImporterApp__status"] ?? null;
  app.render = () => app; // suppress UI render

  console.log("Running pipeline (live LLM/image calls)…\n");
  await app.run({ name: path.basename(pdfPath) }, { preExtracted, stages });
  console.log(`\nPipeline finished: stage = ${app.state?.stage}`);
} catch (e) {
  pipelineError = e;
  REC.errors.push({ where: "pipeline", error: String(e?.stack ?? e) });
  console.error("\nPipeline threw:", e?.message ?? e);
}

// ---- write artifact tree ----
clearInterval(flushTimer);
flushCalls(); // capture the final settled state before the rich rewrite
await writeArtifacts(outDir);

const ms = Date.now() - startedAt;
// Success: pipeline didn't throw, and when actors were in scope it produced
// some (the original smoke signal). maps-only/journals-only runs just need to
// complete without error.
const wants = (n) => !stages || stages.has(n);
const ok = !pipelineError && (!wants("actors") || REC.actors.length > 0);
console.log(`\n${"─".repeat(56)}`);
console.log(`  actors: ${REC.actors.length}  scenes: ${REC.scenes.length}  ` +
  `journals: ${REC.journals.length}  tables: ${REC.tables.length}`);
console.log(`  maps written: ${REC.files.filter((f) => f.name?.startsWith("map-") || f.name?.startsWith("enc-")).length}  ` +
  `tokens: ${REC.files.filter((f) => f.name?.startsWith("token-")).length}`);
console.log(`  errors: ${REC.errors.length}  duration: ${(ms / 1000).toFixed(1)}s`);
console.log(`  artifacts: ${outDir}`);
console.log(`  result: ${ok ? `\x1b[32mPASS\x1b[0m (${stages ? [...stages].join("+") + " stage(s)" : "pipeline"} completed)` : "\x1b[31mFAIL\x1b[0m"}`);
process.exitCode = ok ? 0 : 1;

/* ---------- artifact writer ---------- */
async function writeArtifacts(dir) {
  mkdir(dir);
  const sub = (n) => { const p = path.join(dir, n); mkdir(p); return p; };

  // 1. AI call log (full prompts + responses) from the DebugLog
  let calls = [];
  try {
    const { DebugLog } = await import("../../scripts/util/debug-log.js");
    calls = DebugLog.entries.map(slimCall);
    // save both the generated-result thumbnail and every input image we sent
    const imgDir = sub("ai-call-images");
    for (const e of DebugLog.entries) {
      if (e.thumbnail) writeDataUrl(path.join(imgDir, `call-${e.id}.png`), e.thumbnail);
      (e.inputImages ?? []).forEach((t, n) => writeDataUrl(path.join(imgDir, `call-${e.id}-input-${n + 1}.jpg`), t));
    }
  } catch (e) { REC.errors.push({ where: "DebugLog export", error: String(e?.message ?? e) }); }
  writeJson(path.join(dir, "ai-calls.json"), calls);

  // human-readable call transcript
  const transcript = calls.map((c) =>
    `### #${c.id} [${c.kind}] ${c.label}  —  ${c.status}${c.ms ? ` (${(c.ms / 1000).toFixed(1)}s)` : ""}\n` +
    `provider: ${c.provider ?? ""} ${c.model ?? ""}\n` +
    (c.system ? `\n-- system --\n${trunc(c.system)}\n` : "") +
    (c.user ? `\n-- user --\n${trunc(c.user)}\n` : "") +
    (c.prompt ? `\n-- prompt --\n${trunc(c.prompt)}\n` : "") +
    (c.response ? `\n-- response --\n${trunc(c.response)}\n` : "") +
    (c.error ? `\n-- error --\n${c.error}\n` : "") +
    (c.note ? `\nnote: ${c.note}\n` : "")
  ).join("\n" + "=".repeat(70) + "\n");
  fs.writeFileSync(path.join(dir, "ai-calls.transcript.txt"), transcript);

  // 2. actors (with embedded items) + 3. scenes (with walls/lights/tokens) etc.
  writeJson(path.join(dir, "actors.json"), REC.actors.map(strip));
  writeJson(path.join(dir, "scenes.json"), REC.scenes.map((s) => ({
    ...strip(s),
    embedded: REC.embedded.filter((e) => e.parent === s.uuid)
  })));
  writeJson(path.join(dir, "journals.json"), REC.journals.map(strip));
  writeJson(path.join(dir, "tables.json"), REC.tables.map(strip));
  writeJson(path.join(dir, "folders.json"), REC.folders.map(strip));
  writeJson(path.join(dir, "embedded.json"), REC.embedded);
  writeJson(path.join(dir, "notifications.json"), REC.notifications);
  writeJson(path.join(dir, "errors.json"), REC.errors);

  // 4. generated images (maps, encounter maps, tokens)
  const mapsDir = sub("maps"), tokensDir = sub("tokens");
  for (const f of REC.files) {
    if (f.bytes) {
      const target = f.name?.startsWith("token-") ? tokensDir
        : (f.name?.startsWith("map-") || f.name?.startsWith("enc-")) ? mapsDir : sub("other-files");
      fs.writeFileSync(path.join(target, f.name), f.bytes);
    } else if (f.text) {
      fs.writeFileSync(path.join(sub("exports"), f.name), f.text);
    }
  }

  // 5. summary
  const summary = {
    pdf: pdfPath,
    finishedStage: pipelineError ? "error" : "complete",
    durationMs: Date.now() - startedAt,
    counts: {
      actors: REC.actors.length, scenes: REC.scenes.length,
      journals: REC.journals.length, tables: REC.tables.length, folders: REC.folders.length,
      aiCalls: calls.length, errors: REC.errors.length,
      mapImages: REC.files.filter((f) => f.name?.startsWith("map-") || f.name?.startsWith("enc-")).length,
      tokenImages: REC.files.filter((f) => f.name?.startsWith("token-")).length
    },
    aiCallBreakdown: tally(calls, (c) => `${c.kind}:${c.status}`),
    scenes: REC.scenes.map((s) => ({
      name: s.name, hex: !!s.flags?.["acks-classic-importer"]?.hex,
      walls: REC.embedded.filter((e) => e.parent === s.uuid && e.type === "Wall").length,
      lights: REC.embedded.filter((e) => e.parent === s.uuid && e.type === "AmbientLight").length,
      tokens: REC.embedded.filter((e) => e.parent === s.uuid && e.type === "Token").length,
      notes: REC.embedded.filter((e) => e.parent === s.uuid && e.type === "Note").length
    })),
    actorSample: REC.actors.slice(0, 5).map((a) => ({ name: a.name, type: a.type, items: a.items?.length ?? 0 })),
    errors: REC.errors
  };
  writeJson(path.join(dir, "summary.json"), summary);

  // index
  fs.writeFileSync(path.join(dir, "README.txt"),
    `E2E artifacts for ${pdfPath}\nGenerated ${new Date().toISOString()}\n\n` +
    `summary.json            — counts, per-scene wall/light/token tallies, errors\n` +
    `ai-calls.json           — every LLM/image call: full prompts + responses + timing\n` +
    `ai-calls.transcript.txt — same, human-readable\n` +
    `ai-call-images/         — thumbnails of generated images, by call id\n` +
    `actors.json             — every actor with converted stats + embedded items\n` +
    `scenes.json             — scenes with their walls/lights/tokens/notes\n` +
    `journals.json tables.json folders.json embedded.json\n` +
    `maps/ tokens/           — generated PNGs (if an image provider was configured)\n` +
    `errors.json notifications.json\n`);
}

/* ---------- helpers ---------- */
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function parsePageSpec(spec) {
  const set = new Set();
  for (const part of String(spec).split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
  }
  return set;
}
function num(v) { return v === undefined ? undefined : Number(v); }
function env(k, d) { return process.env[k] ?? d; }
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function writeDataUrl(p, dataUrl) { fs.writeFileSync(p, Buffer.from(dataUrl.split(",")[1], "base64")); }
function strip(doc) { const o = { ...doc }; delete o._embedded; return o; }
function trunc(s, n = 12000) { const str = String(s ?? ""); return str.length > n ? str.slice(0, n) + `\n…[${str.length - n} more chars]` : str; }
function tally(arr, keyFn) { const m = {}; for (const x of arr) { const k = keyFn(x); m[k] = (m[k] ?? 0) + 1; } return m; }

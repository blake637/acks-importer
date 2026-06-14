/**
 * Image generation client + deterministic fallbacks.
 *
 * Two asset types are produced:
 *   - Tokens/portraits for actors
 *   - Top-down battlemap backgrounds for scenes
 *
 * If no image provider is configured, fallbacks are used:
 *   - Tokens: generated letter-disc PNGs (initial on a colored disc)
 *   - Maps:   the deterministic line-map renderer in scene-builder.js
 *
 * Generated files are uploaded to the world's data directory under
 * worlds/<world>/acks-importer/.
 */

import { getSetting } from "../settings.js";
import { warn } from "../util/logger.js";
import { buildMapWorkflow, buildPortraitWorkflow, FLUX_DEFAULTS } from "./comfy-workflow.js";
import { DebugLog, makeThumbnail } from "../util/debug-log.js";

export class ImageClient {
  constructor() {
    this.provider = getSetting("imgProvider");
    this.key = getSetting("imgApiKey");
    this.model = getSetting("imgModel");
    this.endpoint = getSetting("imgEndpoint");
  }

  get enabled() { return this.provider !== "none" && (!!this.key || this.provider === "comfyui"); }

  /**
   * @param {string} prompt
   * @param {object} opts
   *   width/height        — output size
   *   referenceImageDataUrl — for MAP generation: a labeled reference image
   *                           Flux redraws via img2img (no ControlNet). When
   *                           absent, generation is plain txt2img (portraits).
   *   denoise             — img2img strength for maps (default 0.72)
   * @returns {Promise<string>} dataUrl of a generated PNG
   */
  async generate(prompt, { width = 1024, height = 1024, referenceImageDataUrl = null, denoise = 0.72, negative = "text, letters, numbers, labels, watermark, blurry, photo, perspective view, 3d render", label = "Image generation" } = {}) {
    if (!this.enabled) throw new Error("Image provider not configured");
    const entry = DebugLog.record({
      kind: "image", label,
      provider: this.provider, model: this.model,
      prompt,
      images: referenceImageDataUrl ? 1 : 0,
      note: referenceImageDataUrl ? "Flux img2img redraw of a labeled reference image" : "txt2img"
    });
    const started = Date.now();
    try {
      const dataUrl = await this.#generateInner(prompt, { width, height, referenceImageDataUrl, denoise, negative });
      entry.status = "ok";
      entry.ms = Date.now() - started;
      entry.thumbnail = await makeThumbnail(dataUrl);
      return dataUrl;
    } catch (e) {
      entry.status = "error";
      entry.error = String(e?.message ?? e);
      entry.ms = Date.now() - started;
      throw e;
    }
  }

  async #generateInner(prompt, { width, height, referenceImageDataUrl, denoise, negative }) {
    if (this.provider === "comfyui") return this.#comfy(prompt, { width, height, referenceImageDataUrl, denoise, negative });
    if (this.provider === "openai") {
      const res = await fetch(this.endpoint || "https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
        body: JSON.stringify({
          model: this.model || "gpt-image-1",
          prompt, size: `${width}x${height}`, n: 1, response_format: "b64_json"
        })
      });
      if (!res.ok) throw new Error(`Image API ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return `data:image/png;base64,${data.data[0].b64_json}`;
    }
    if (this.provider === "stability") {
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("output_format", "png");
      form.append("aspect_ratio", width >= height ? "16:9" : "1:1");
      const res = await fetch(this.endpoint || "https://api.stability.ai/v2beta/stable-image/generate/core", {
        method: "POST",
        headers: { authorization: `Bearer ${this.key}`, accept: "image/*" },
        body: form
      });
      if (!res.ok) throw new Error(`Stability API ${res.status}: ${await res.text()}`);
      const blob = await res.blob();
      return blobToDataUrl(blob);
    }
    // custom: POST {prompt,width,height} → {image: base64}
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ prompt, width, height, model: this.model })
    });
    if (!res.ok) throw new Error(`Image API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return `data:image/png;base64,${data.image}`;
  }

  /* ---------- ComfyUI ----------
   * Two paths:
   *   - Built-in (default): the workflow graph is constructed in code per
   *     map (ControlNet on the blueprint + N regional prompts), because a
   *     static JSON cannot express a variable number of regions.
   *   - Custom override: a user-pasted API-format workflow with placeholder
   *     substitution (%%PROMPT%% etc.), for non-Flux or exotic pipelines.
   */
  async #comfy(prompt, { width, height, referenceImageDataUrl, denoise, negative }) {
    const base = (this.endpoint || "http://127.0.0.1:8188").replace(/\/+$/, "");
    const customSrc = getSetting("comfyWorkflow")?.trim();

    try {
      let workflow;
      if (customSrc) {
        let initName = null;
        if (customSrc.includes("%%INIT_IMAGE%%")) {
          initName = referenceImageDataUrl ? await this.#comfyUpload(base, referenceImageDataUrl) : "";
          if (!referenceImageDataUrl) warn("Custom workflow expects %%INIT_IMAGE%% but no reference image was provided.");
        }
        workflow = substitutePlaceholders(JSON.parse(customSrc), {
          "%%PROMPT%%": prompt,
          "%%NEGATIVE%%": negative,
          "%%WIDTH%%": width,
          "%%HEIGHT%%": height,
          "%%SEED%%": Math.floor(Math.random() * 2 ** 31),
          "%%CHECKPOINT%%": this.model || FLUX_DEFAULTS.unet,
          "%%INIT_IMAGE%%": initName
        });
      } else {
        // Built-in Flux 2 Klein graphs. Loader filenames come from settings,
        // falling back to common defaults; the model field overrides the UNet.
        const flux = {
          unet: getSetting("fluxUnet")?.trim() || this.model || FLUX_DEFAULTS.unet,
          clipL: getSetting("fluxClipL")?.trim() || FLUX_DEFAULTS.clipL,
          t5: getSetting("fluxT5")?.trim() || FLUX_DEFAULTS.t5,
          vae: getSetting("fluxVae")?.trim() || FLUX_DEFAULTS.vae
        };
        const seed = Math.floor(Math.random() * 2 ** 31);
        if (referenceImageDataUrl) {
          // MAP: img2img redraw of the labeled reference image.
          const referenceImage = await this.#comfyUpload(base, referenceImageDataUrl);
          workflow = buildMapWorkflow({ prompt, referenceImage, width, height, seed, denoise: denoise ?? 0.72, ...flux });
        } else {
          // PORTRAIT: plain txt2img.
          workflow = buildPortraitWorkflow({ prompt, width, height, seed, ...flux });
        }
      }
      return await this.#comfyRun(base, workflow);
    } catch (e) {
      // "Failed to fetch" in ~0.1s = the browser never reached the server.
      // For ComfyUI that is almost always missing CORS headers: unlike
      // llama-server, ComfyUI does not send them by default.
      if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(e?.message ?? e))) {
        throw new Error(
          `Cannot reach ComfyUI at ${base} from the browser. Most common cause: ComfyUI is not sending CORS headers — relaunch it with --enable-cors-header "*" (llama-server enables CORS by default, ComfyUI does not, which is why LLM calls can work while image calls fail). Also confirm the server is running and listening on that address. Original error: ${e.message}`
        );
      }
      throw e;
    }
  }

  async #comfyUpload(base, dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    const form = new FormData();
    form.append("image", new File([blob], `aci-blueprint-${Date.now()}.png`, { type: "image/png" }));
    form.append("overwrite", "true");
    const up = await fetch(`${base}/upload/image`, { method: "POST", body: form });
    if (!up.ok) throw new Error(`ComfyUI upload ${up.status}: ${await up.text()}`);
    const upData = await up.json();
    return upData.subfolder ? `${upData.subfolder}/${upData.name}` : upData.name;
  }

  async #comfyRun(base, workflow) {
    const clientId = `acks-importer-${foundry.utils.randomID?.() ?? Math.random().toString(36).slice(2)}`;
    const queued = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: clientId })
    });
    if (!queued.ok) throw new Error(`ComfyUI queue ${queued.status}: ${await queued.text()}`);
    const { prompt_id } = await queued.json();

    const deadline = Date.now() + 5 * 60 * 1000;
    let outputs = null;
    while (Date.now() < deadline) {
      await sleep(1500);
      const h = await fetch(`${base}/history/${prompt_id}`);
      if (!h.ok) continue;
      const hist = await h.json();
      const entry = hist?.[prompt_id];
      if (entry?.status?.status_str === "error") {
        throw new Error(`ComfyUI execution error: ${JSON.stringify(entry.status?.messages ?? []).slice(0, 500)}`);
      }
      if (entry?.outputs && Object.keys(entry.outputs).length) { outputs = entry.outputs; break; }
    }
    if (!outputs) throw new Error("ComfyUI render timed out (5 min)");

    for (const node of Object.values(outputs)) {
      const img = node?.images?.find((i) => i.type === "output" || i.type === "temp");
      if (!img) continue;
      const view = await fetch(`${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? "")}&type=${img.type}`);
      if (!view.ok) continue;
      return blobToDataUrl(await view.blob());
    }
    throw new Error("ComfyUI finished but produced no image outputs");
  }
}

/** Walk a workflow object, replacing placeholder strings; numeric
 *  placeholders (%%WIDTH%% etc.) become numbers when they fill a whole value. */
function substitutePlaceholders(obj, map) {
  if (typeof obj === "string") {
    if (obj in map) return map[obj]; // whole-value: preserve type (numbers)
    let s = obj;
    for (const [k, v] of Object.entries(map)) s = s.split(k).join(String(v));
    return s;
  }
  if (Array.isArray(obj)) return obj.map((v) => substitutePlaceholders(v, map));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = substitutePlaceholders(v, map);
    return out;
  }
  return obj;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------- Fallback letter token ---------- */
const PALETTE = ["#7a3b2e", "#2e5d4b", "#2f4a6e", "#6e5a2f", "#5a2f6e", "#3b6e2f", "#6e2f3b", "#2f6e6a"];
export function letterToken(name, kind = "npc") {
  const c = document.createElement("canvas");
  c.width = c.height = 400;
  const ctx = c.getContext("2d");
  const hue = PALETTE[hashCode(name) % PALETTE.length];
  ctx.fillStyle = kind === "monster" ? "#3a3a3a" : hue;
  ctx.beginPath(); ctx.arc(200, 200, 190, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#d8cba6"; ctx.lineWidth = 14; ctx.stroke();
  ctx.fillStyle = "#f2ead3";
  ctx.font = "bold 200px serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText((name?.[0] ?? "?").toUpperCase(), 200, 215);
  return c.toDataURL("image/png");
}
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < (s ?? "").length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/* ---------- Upload helpers ---------- */
export async function uploadDataUrl(dataUrl, filename) {
  const dir = `worlds/${game.world.id}/acks-importer`;
  await ensureDir(dir);
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], filename, { type: "image/png" });
  const res = await FilePicker.upload("data", dir, file, {}, { notify: false });
  return res.path;
}

async function ensureDir(dir) {
  try { await FilePicker.createDirectory("data", dir); }
  catch (e) { if (!String(e).includes("EEXIST") && !String(e?.message ?? "").includes("already exists")) warn("createDirectory:", e); }
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

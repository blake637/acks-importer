/**
 * Programmatic ComfyUI workflow builder — Flux 2 Klein.
 *
 * Flux 2 Klein uses its own node stack (distinct from Flux 1 / SDXL):
 *   - UNETLoader              the diffusion model (flux-2-klein-base-9b-fp8)
 *   - CLIPLoader (type flux2) a SINGLE text encoder — Qwen3
 *   - VAELoader               flux2-vae
 *   - CLIPTextEncode ×2       positive + (empty) negative conditioning
 *   - CFGGuider               cfg-based guidance
 *   - KSamplerSelect          sampler (euler)
 *   - RandomNoise             seed
 *   - SamplerCustomAdvanced   the sampler
 *   - VAEDecode → SaveImage
 *
 * The image pipeline is IMAGE-FIRST (see docs/map-generation.md): the map
 * picture is produced first, then walls/lights are placed by a vision model
 * that looks at it. So there are three graph shapes:
 *
 *  buildPortraitWorkflow()  — txt2img for character/monster tokens.
 *  buildTextToImageMap()    — txt2img for described-only & encounter maps
 *                             (no source plate — paint from the prompt).
 *  buildColorizeWorkflow()  — low-denoise img2img: take a scanned map plate,
 *                             upscale it, and re-paint it in colour while
 *                             keeping its structure (rooms, corridors, labels)
 *                             intact. Uses BasicScheduler's `denoise` so only
 *                             the tail of the schedule runs — the source is
 *                             preserved, not reimagined.
 *
 * Node ids are strings; class_types are stock ComfyUI Flux 2 nodes.
 */

// ---- Flux 2 Klein loader defaults (overridable via settings) ----
export const FLUX_DEFAULTS = {
  unet: "flux-2-klein-base-9b-fp8.safetensors",
  clip: "qwen_3_8b_fp8mixed.safetensors",
  vae: "flux2-vae.safetensors",
  steps: 20,
  cfg: 5
};

/** Shared Flux 2 loaders + positive/negative text-encode. Returns node ids. */
function fluxBase(node, ref, { unet, clip, vae, prompt }) {
  const unetNode = node("UNETLoader", { unet_name: unet, weight_dtype: "default" });
  const clipNode = node("CLIPLoader", { clip_name: clip, type: "flux2", device: "default" });
  const vaeNode = node("VAELoader", { vae_name: vae });
  const positive = node("CLIPTextEncode", { clip: ref(clipNode), text: prompt });
  // Flux runs without a real negative; an empty conditioning satisfies CFGGuider.
  const negative = node("CLIPTextEncode", { clip: ref(clipNode), text: "" });
  return { unetNode, clipNode, vaeNode, positive, negative };
}

/** Make the per-graph `node`/`ref` helpers and the graph object. */
function graph() {
  const g = {};
  let id = 0;
  const node = (t, i) => { g[String(++id)] = { class_type: t, inputs: i }; return String(id); };
  const ref = (n, s = 0) => [n, s];
  return { g, node, ref };
}

/**
 * Shared txt2img builder (Flux2Scheduler + EmptyFlux2LatentImage). Used by
 * both the portrait and text-to-image-map graphs.
 */
function txt2img({ prompt, width, height, seed, unet, clip, vae, steps, cfg, filename }) {
  const { g, node, ref } = graph();
  const W = snap16(width), H = snap16(height);
  const { unetNode, vaeNode, positive, negative } = fluxBase(node, ref, { unet, clip, vae, prompt });
  const latent = node("EmptyFlux2LatentImage", { width: W, height: H, batch_size: 1 });
  const samplerSel = node("KSamplerSelect", { sampler_name: "euler" });
  const noise = node("RandomNoise", { noise_seed: seed });
  const sigmas = node("Flux2Scheduler", { steps, width: W, height: H });
  const guider = node("CFGGuider", { cfg, model: ref(unetNode), positive: ref(positive), negative: ref(negative) });
  const sampled = node("SamplerCustomAdvanced", {
    noise: ref(noise), guider: ref(guider), sampler: ref(samplerSel), sigmas: ref(sigmas), latent_image: ref(latent)
  });
  const decoded = node("VAEDecode", { samples: ref(sampled), vae: ref(vaeNode) });
  node("SaveImage", { images: ref(decoded), filename_prefix: filename });
  return g;
}

/** Character/monster portrait (txt2img). @returns {object} API-format workflow */
export function buildPortraitWorkflow(opts) {
  return txt2img({ width: 1024, height: 1024, ...defaults(opts), filename: "acks-importer-token" });
}

/**
 * Map painted from a text description (txt2img) — used for described-only maps
 * and wilderness encounter maps, where there is no source plate to colour.
 * @returns {object} API-format workflow
 */
export function buildTextToImageMap(opts) {
  return txt2img({ width: 1024, height: 1024, ...defaults(opts), filename: "acks-importer-map" });
}

/**
 * Colorize + upscale a scanned map plate (low-denoise img2img). The plate is
 * loaded, upscaled to a megapixel budget, VAE-encoded, and partially denoised
 * — BasicScheduler's `denoise` keeps only the tail of the schedule, so the
 * structure of the original map survives and only colour/detail is added.
 *
 * @param {object} opts
 * @param {string} opts.prompt       what to paint (incl. per-room descriptions)
 * @param {string} opts.sourceImage  uploaded ComfyUI image name (the plate)
 * @param {number} opts.denoise      0.2–0.6; lower preserves the plate more
 * @param {number} opts.upscaleMP    target megapixels for the upscale
 * @returns {object} API-format workflow
 */
export function buildColorizeWorkflow({
  prompt, sourceImage, seed, denoise = 0.4, upscaleMP = 2,
  unet = FLUX_DEFAULTS.unet, clip = FLUX_DEFAULTS.clip, vae = FLUX_DEFAULTS.vae,
  steps = FLUX_DEFAULTS.steps, cfg = FLUX_DEFAULTS.cfg
}) {
  const { g, node, ref } = graph();
  const { unetNode, vaeNode, positive, negative } = fluxBase(node, ref, { unet, clip, vae, prompt });

  // Load the plate, upscale to the megapixel budget, and encode it as the
  // starting latent for a partial-denoise img2img.
  const loaded = node("LoadImage", { image: sourceImage });
  const scaled = node("ImageScaleToTotalPixels", {
    upscale_method: "lanczos", megapixels: upscaleMP, resolution_steps: 1, image: ref(loaded)
  });
  const encoded = node("VAEEncode", { pixels: ref(scaled), vae: ref(vaeNode) });

  const samplerSel = node("KSamplerSelect", { sampler_name: "euler" });
  const noise = node("RandomNoise", { noise_seed: seed });
  // BasicScheduler's denoise truncates the sigma schedule → img2img strength.
  const sigmas = node("BasicScheduler", {
    model: ref(unetNode), scheduler: "simple", steps, denoise: clampDenoise(denoise)
  });
  const guider = node("CFGGuider", { cfg, model: ref(unetNode), positive: ref(positive), negative: ref(negative) });
  const sampled = node("SamplerCustomAdvanced", {
    noise: ref(noise), guider: ref(guider), sampler: ref(samplerSel), sigmas: ref(sigmas), latent_image: ref(encoded)
  });
  const decoded = node("VAEDecode", { samples: ref(sampled), vae: ref(vaeNode) });
  node("SaveImage", { images: ref(decoded), filename_prefix: "acks-importer-map" });
  return g;
}

/** Apply Flux loader/sampler defaults to a partial options object. */
function defaults(o = {}) {
  return {
    unet: FLUX_DEFAULTS.unet, clip: FLUX_DEFAULTS.clip, vae: FLUX_DEFAULTS.vae,
    steps: FLUX_DEFAULTS.steps, cfg: FLUX_DEFAULTS.cfg, ...o
  };
}
function clampDenoise(d) { const n = Number(d); return Number.isFinite(n) ? Math.min(0.9, Math.max(0.1, n)) : 0.4; }

// Flux prefers dimensions that are multiples of 16.
export function snap16(v) { return Math.max(16, Math.round(v / 16) * 16); }
export function snap8(v) { return Math.max(8, Math.round(v / 8) * 8); }

/** Fit scene dimensions into a generation budget, preserving aspect. */
export function fitGenerationSize(sceneW, sceneH, maxDim = 1536) {
  const scale = Math.min(1, maxDim / Math.max(sceneW, sceneH));
  return { genW: snap16(sceneW * scale), genH: snap16(sceneH * scale), scale };
}

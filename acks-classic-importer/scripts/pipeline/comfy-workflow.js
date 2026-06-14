/**
 * Programmatic ComfyUI workflow builder — Flux 2 Klein.
 *
 * Flux uses a different stack from SDXL: a UNet (diffusion model) loader, a
 * DUAL CLIP loader (clip_l + a T5 text encoder), and a separate VAE — not a
 * single all-in-one checkpoint. Flux's T5 encoder follows natural-language
 * instructions well, which is what we lean on here.
 *
 * Two graph shapes:
 *
 *  buildPortraitWorkflow()  — plain txt2img for character/monster tokens.
 *
 *  buildMapWorkflow()       — IMG2IMG redraw. We hand Flux a rendered
 *    reference image that ALREADY has each sub-area outlined and labeled with
 *    its description (drawn by the scene builder), plus a text prompt that
 *    lists the areas. Flux repaints each labeled region in place as the thing
 *    the label says. No ControlNet, no regional-conditioning nodes — the
 *    labels in the reference image carry the spatial information, and a
 *    moderate denoise keeps the layout while replacing the flat labels with
 *    painted terrain/rooms. (Foundry map-note pins still provide the
 *    player-facing keyed labels; the labels baked into the reference are only
 *    guidance for the model and are painted over.)
 *
 * Node ids are strings; class_types are stock ComfyUI Flux nodes.
 */

// ---- Flux loader defaults (overridable via settings) ----
export const FLUX_DEFAULTS = {
  unet: "flux2-klein.safetensors",
  clipL: "clip_l.safetensors",
  t5: "t5xxl_fp16.safetensors",
  vae: "ae.safetensors",
  steps: 28,
  guidance: 3.5
};

/** Shared Flux loader + text-encode preamble. Returns node ids. */
function fluxBase(node, ref, { unet, clipL, t5, vae, prompt, guidance }) {
  const unetNode = node("UNETLoader", { unet_name: unet, weight_dtype: "default" });
  const clip = node("DualCLIPLoader", { clip_name1: clipL, clip_name2: t5, type: "flux" });
  const vaeNode = node("VAELoader", { vae_name: vae });
  const cond = node("CLIPTextEncode", { clip: ref(clip), text: prompt });
  const guided = node("FluxGuidance", { conditioning: ref(cond), guidance });
  // Flux is distilled and runs without a real negative; an empty cond keeps
  // the KSampler node's negative input satisfied.
  const empty = node("CLIPTextEncode", { clip: ref(clip), text: "" });
  return { unetNode, clip, vaeNode, guided, empty };
}

/**
 * Character/monster portrait (txt2img).
 * @returns {object} API-format workflow
 */
export function buildPortraitWorkflow({
  prompt, width = 1024, height = 1024, seed,
  unet = FLUX_DEFAULTS.unet, clipL = FLUX_DEFAULTS.clipL, t5 = FLUX_DEFAULTS.t5,
  vae = FLUX_DEFAULTS.vae, steps = FLUX_DEFAULTS.steps, guidance = FLUX_DEFAULTS.guidance
}) {
  const g = {};
  let id = 0;
  const node = (t, i) => { g[String(++id)] = { class_type: t, inputs: i }; return String(id); };
  const ref = (n, s = 0) => [n, s];

  const { unetNode, vaeNode, guided, empty } = fluxBase(node, ref, { unet, clipL, t5, vae, prompt, guidance });
  const latent = node("EmptyLatentImage", { width: snap16(width), height: snap16(height), batch_size: 1 });
  const sampler = node("KSampler", {
    model: ref(unetNode), positive: ref(guided), negative: ref(empty), latent_image: ref(latent),
    seed, steps, cfg: 1.0, sampler_name: "euler", scheduler: "simple", denoise: 1.0
  });
  const decoded = node("VAEDecode", { samples: ref(sampler), vae: ref(vaeNode) });
  node("SaveImage", { images: ref(decoded), filename_prefix: "acks-importer-token" });
  return g;
}

/**
 * Map (img2img redraw of a labeled reference image).
 * @param {object} opts
 * @param {string} opts.prompt          text listing the areas + global style
 * @param {string} opts.referenceImage  uploaded ComfyUI image name (the
 *                                       labeled blueprint the scene builder
 *                                       rendered and uploaded)
 * @param {number} opts.denoise         0.55–0.85: lower preserves the labeled
 *                                       layout more, higher repaints harder
 * @returns {object} API-format workflow
 */
export function buildMapWorkflow({
  prompt, referenceImage, width = 1024, height = 1024, seed,
  denoise = 0.72,
  unet = FLUX_DEFAULTS.unet, clipL = FLUX_DEFAULTS.clipL, t5 = FLUX_DEFAULTS.t5,
  vae = FLUX_DEFAULTS.vae, steps = FLUX_DEFAULTS.steps, guidance = FLUX_DEFAULTS.guidance
}) {
  const g = {};
  let id = 0;
  const node = (t, i) => { g[String(++id)] = { class_type: t, inputs: i }; return String(id); };
  const ref = (n, s = 0) => [n, s];

  const { unetNode, vaeNode, guided, empty } = fluxBase(node, ref, { unet, clipL, t5, vae, prompt, guidance });

  // Load the labeled reference image and scale it to the generation size, then
  // encode to a latent we partially denoise (img2img).
  const loaded = node("LoadImage", { image: referenceImage });
  const scaled = node("ImageScale", {
    image: ref(loaded), width: snap16(width), height: snap16(height),
    upscale_method: "lanczos", crop: "disabled"
  });
  const encoded = node("VAEEncode", { pixels: ref(scaled), vae: ref(vaeNode) });
  const sampler = node("KSampler", {
    model: ref(unetNode), positive: ref(guided), negative: ref(empty), latent_image: ref(encoded),
    seed, steps, cfg: 1.0, sampler_name: "euler", scheduler: "simple", denoise
  });
  const decoded = node("VAEDecode", { samples: ref(sampler), vae: ref(vaeNode) });
  node("SaveImage", { images: ref(decoded), filename_prefix: "acks-importer-map" });
  return g;
}

// Flux prefers dimensions that are multiples of 16.
export function snap16(v) { return Math.max(16, Math.round(v / 16) * 16); }
export function snap8(v) { return Math.max(8, Math.round(v / 8) * 8); }

/** Fit scene dimensions into a generation budget, preserving aspect. */
export function fitGenerationSize(sceneW, sceneH, maxDim = 1536) {
  const scale = Math.min(1, maxDim / Math.max(sceneW, sceneH));
  return { genW: snap16(sceneW * scale), genH: snap16(sceneH * scale), scale };
}

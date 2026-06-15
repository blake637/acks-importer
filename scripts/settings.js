/** Module settings: LLM + image generation providers, pipeline behavior. */

export const MODULE_ID = "acks-classic-importer";

export function registerSettings() {
  const S = (key, data) => game.settings.register(MODULE_ID, key, data);

  // ---- LLM provider ----
  S("llmProvider", {
    name: "LLM Provider",
    hint: "Provider used for structure extraction and conversion assistance.",
    scope: "world", config: true, type: String, default: "anthropic",
    choices: { anthropic: "Anthropic", openai: "OpenAI-compatible", custom: "Custom endpoint" }
  });
  S("llmEndpoint", {
    name: "LLM Endpoint URL",
    hint: "Leave blank to use the provider default. For custom/self-hosted, supply a full /v1/messages or /v1/chat/completions URL.",
    scope: "world", config: true, type: String, default: ""
  });
  S("llmApiKey", {
    name: "LLM API Key",
    scope: "world", config: true, type: String, default: ""
  });
  S("llmModel", {
    name: "LLM Model",
    hint: "e.g. claude-sonnet-4-5, gpt-4.1, or a local model name.",
    scope: "world", config: true, type: String, default: "claude-sonnet-4-5"
  });
  S("llmTimeoutSec", {
    name: "LLM request timeout (seconds)",
    hint: "How long to wait for a single LLM response before giving up. Local reasoning models running uncapped can take several minutes per call — raise this if calls abort early.",
    scope: "world", config: true, type: Number, default: 600,
    range: { min: 30, max: 3600, step: 30 }
  });

  // ---- Image generation provider ----
  S("imgProvider", {
    name: "Image Generation Provider",
    scope: "world", config: true, type: String, default: "none",
    choices: {
      none: "None (programmatic maps, letter tokens)",
      comfyui: "ComfyUI (local)",
      openai: "OpenAI Images",
      stability: "Stability AI",
      custom: "Custom endpoint (POST, returns base64 PNG)"
    }
  });
  S("imgEndpoint", { name: "Image Endpoint URL", hint: "For ComfyUI this is the server root, e.g. http://127.0.0.1:8188", scope: "world", config: true, type: String, default: "" });
  S("imgApiKey",   { name: "Image API Key",      scope: "world", config: true, type: String, default: "" });
  S("imgModel",    { name: "Flux UNet / diffusion model filename", hint: "The Flux 2 Klein diffusion model (UNETLoader). Defaults to flux-2-klein-base-9b-fp8.safetensors. Overrides the Flux UNet setting below if both are set.", scope: "world", config: true, type: String, default: "flux-2-klein-base-9b-fp8.safetensors" });

  // ---- Flux 2 Klein loaders (built-in ComfyUI workflow) ----
  S("fluxUnet", { name: "Flux UNet model", hint: "Diffusion model for UNETLoader (e.g. flux-2-klein-base-9b-fp8.safetensors).", scope: "world", config: true, type: String, default: "flux-2-klein-base-9b-fp8.safetensors" });
  S("fluxClip", { name: "Flux CLIP (text encoder)", hint: "Single CLIP for CLIPLoader, type flux2 (e.g. qwen_3_8b_fp8mixed.safetensors). Flux 2 Klein uses one Qwen3 encoder, not a clip_l + T5 pair.", scope: "world", config: true, type: String, default: "qwen_3_8b_fp8mixed.safetensors" });
  S("fluxVae",  { name: "Flux VAE", hint: "VAE for VAELoader (e.g. flux2-vae.safetensors).", scope: "world", config: true, type: String, default: "flux2-vae.safetensors" });

  S("comfyWorkflow", {
    name: "ComfyUI workflow JSON (API format) — custom override",
    hint: "Leave blank to use the built-in Flux 2 Klein workflows (portrait txt2img; map image-edit of a labeled reference). Paste your own API-format workflow to override: placeholders %%PROMPT%%, %%NEGATIVE%%, %%WIDTH%%, %%HEIGHT%%, %%SEED%%, %%CHECKPOINT%%, %%INIT_IMAGE%% are substituted at run time.",
    scope: "world", config: true, type: String, default: ""
  });

  // ---- Pipeline behavior ----
  S("sourceEdition", {
    name: "Source edition",
    hint: "Which ruleset the PDF was written for. Auto-detect scores the text against stat-block conventions and logs its choice; override here if it guesses wrong.",
    scope: "world", config: true, type: String, default: "auto",
    choices: { auto: "Auto-detect", classic: "Classic (B/X, AD&D 1e/2e)", "5e": "5th Edition" }
  });
  S("generateTokenArt", {
    name: "Generate token/portrait art",
    hint: "If off (or provider is None), actors get generated letter-disc tokens.",
    scope: "world", config: true, type: Boolean, default: true
  });
  S("generateMapArt", {
    name: "Generate scene maps",
    hint: "Maps are image-first and REQUIRE an image provider: scanned plates are colorized & upscaled, described areas are painted from text, and walls/lights are then placed by a vision pass on the image. With no image provider (or this off), no scenes are created.",
    scope: "world", config: true, type: Boolean, default: true
  });
  S("mapDenoise", {
    name: "Plate colorize strength (img2img denoise)",
    hint: "0.2–0.6. How much the image model may repaint a scanned map plate. Lower keeps the original linework/structure more faithfully; higher gives a more finished look but can drift.",
    scope: "world", config: true, type: Number, default: 0.4,
    range: { min: 0.1, max: 0.9, step: 0.05 }
  });
  S("colorizeUpscaleMP", {
    name: "Plate colorize upscale (megapixels)",
    hint: "Target resolution when colorizing a scanned plate, in megapixels. Higher = sharper/larger maps but slower generation. 4 MP ≈ 2048×2048, near Flux 2 Klein's sweet-spot ceiling.",
    scope: "world", config: true, type: Number, default: 4,
    range: { min: 1, max: 4, step: 0.5 }
  });
  S("reviewBeforeCreate", {
    name: "Review extracted data before creating documents",
    hint: "Strongly recommended. Shows the parsed JSON for each stage and lets you edit it before Foundry documents are created.",
    scope: "world", config: true, type: Boolean, default: true
  });
  S("gridSizePx", {
    name: "Scene grid size (px per square)",
    scope: "world", config: true, type: Number, default: 100
  });
  S("feetPerSquare", {
    name: "Feet per map square",
    hint: "Classic dungeon maps are usually 10' per square; wilderness/town maps vary and are read from the map key when possible.",
    scope: "world", config: true, type: Number, default: 10
  });
  S("itemCompendiums", {
    name: "Item compendium packs to check before creating gear",
    hint: "Comma-separated pack ids (e.g. 'acks.items,world.my-gear'). Matched items are linked instead of re-created; the importer's parsed bonuses/charges are merged in.",
    scope: "world", config: true, type: String, default: ""
  });
  S("encounterMapsPerTerrain", {
    name: "Tactical encounter maps per wilderness terrain type",
    hint: "When a wilderness map is imported, paint this many square-grid 'zoom-in' battle maps for each distinct terrain type found (forest, hills, swamp…). Outdoor — background only, no walls. 0 disables.",
    scope: "world", config: true, type: Number, default: 1,
    range: { min: 0, max: 2, step: 1 }
  });
  S("monsterCompendiums", {
    name: "Monster compendium packs to check before creating",
    hint: "Comma-separated pack ids (e.g. 'acks.monsters,world.my-bestiary'). The importer's own 'imported-monsters' pack is always checked.",
    scope: "world", config: true, type: String, default: ""
  });
}

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

/**
 * Scene builder — IMAGE-FIRST (see docs/map-generation.md).
 *
 * The picture is produced first; geometry is read back off it afterwards:
 *
 *   1. BACKGROUND. If the PDF has a scanned map plate, we COLORIZE + UPSCALE it
 *      (low-denoise img2img that keeps the original structure). If not, we paint
 *      the map from the text description (txt2img). An image provider is
 *      REQUIRED — there is no deterministic drawn fallback.
 *   2. INDOOR vs OUTDOOR. From the plate's detected mapType, or a small
 *      classification call for described-only maps.
 *   3. PLACEMENT. Outdoor maps get NOTHING but a background + grid. Indoor maps
 *      get a vision pass: the model LOOKS at the finished image (with a pixel
 *      ruler overlaid) plus the keyed-area descriptions, and returns walls,
 *      doors, windows, lights, token spots, and keyed-room centers — all in
 *      IMAGE PIXELS, which map straight onto the Foundry scene.
 *
 * There is no authored geometry to keep the art faithful to: the art is the
 * source of truth, so placement may freely follow whatever was painted.
 */

import { LLMClient } from "./llm-client.js";
import { ImageClient, uploadDataUrl } from "./image-client.js";
import { normalizeTerrain, terrainPrompt } from "./encounter-maps.js";
import { getSetting } from "../settings.js";
import { slug } from "./actor-builder.js";
import { warn } from "../util/logger.js";

const INDOOR_MAP_TYPES = new Set(["dungeon", "building"]);
const OUTDOOR_MAP_TYPES = new Set(["wilderness", "region", "town"]);

// txt2img map sizes (the scene is sized to the produced image; the grid is a
// measurement aid, walls are pixel-accurate to the art). Flux 2 Klein renders
// well up to ~2048 px on a side — maps want the resolution for legibility.
const DESCRIBED_SIZE = { w: 2048, h: 2048 };
const ENCOUNTER_SIZE = { w: 2048, h: 1536 };

const DESCRIBE_SYSTEM = `You design a top-down tabletop battlemap from a written location description. Output JSON only:
{
  "imagePrompt": str,   // a vivid prompt for an orthographic TOP-DOWN battlemap of this place — describe the layout, surfaces, and contents; no text, labels, grid lines, characters, or perspective
  "setting": "indoor" | "outdoor"  // indoor = a roofed interior (building, cave, dungeon) that needs walls; outdoor = open air (clearing, courtyard, wilderness) that needs none
}`;

const PLACE_SYSTEM = `You are a battlemap analyst. You see a TOP-DOWN map image with a cyan pixel-coordinate ruler overlaid (numbers along the top and left are PIXELS), and a list of keyed areas with their descriptions. Read the walls and contents off the IMAGE and return their positions in PIXELS. Output JSON only:
{
  "walls":   [ { "x1":n,"y1":n,"x2":n,"y2":n } ],                       // solid walls (block sight + movement)
  "doors":   [ { "x1":n,"y1":n,"x2":n,"y2":n, "state":"closed"|"open"|"locked"|"barred"|"secret" } ],
  "windows": [ { "x1":n,"y1":n,"x2":n,"y2":n } ],                       // see-through, no passage
  "lights":  [ { "x":n,"y":n, "radiusFeet":n } ],                       // hearths, braziers, magical light the descriptions mention
  "tokenSpots": [ { "ref":str, "x":n,"y":n } ],                          // one per keyed area's occupant reference, at its center
  "keyPositions": [ { "key":str, "x":n,"y":n } ]                         // the center of each keyed area (match the labels to the descriptions)
}
Trace walls along the painted room boundaries. Use the descriptions to set door states (barred/locked/secret) and to place light sources. Coordinates must lie within the image.`;

const TERRAIN_LIST_SYSTEM = `List the distinct terrain types depicted on this wilderness/overland map. Output JSON only: { "terrains": [str] } using terms from: forest, hills, mountains, grassland, swamp, desert, water, road.`;

export class SceneBuilder {
  constructor() {
    this.llm = new LLMClient();
    this.img = new ImageClient();
    this.gridPx = getSetting("gridSizePx");
    // Maps require an image provider; there is no drawn fallback.
    this.enabled = getSetting("generateMapArt") && this.img.enabled;
  }

  /**
   * @param {object} mapGroup  { name, locations, sourceText, mapPlateDataUrl|null, plateMeta|null }
   * @param {Map<string,{actorId,count}>} occupants  locationRef → actor info
   * @returns {Promise<Scene|null>} null when no image provider is configured
   */
  async buildScene(mapGroup, occupants, { onProgress } = {}) {
    if (!this.enabled) {
      warn(`No image provider configured; skipping map "${mapGroup.name}".`);
      return null;
    }

    const { indoor, gridType, imagePrompt } = await this.#resolveSetting(mapGroup, { onProgress });

    // ---- background ----
    onProgress?.(`Generating map art for "${mapGroup.name}"`);
    const bgDataUrl = mapGroup.mapPlateDataUrl
      ? await this.img.generate(this.#colorizePrompt(mapGroup, indoor), {
          mode: "colorize", sourceImageDataUrl: mapGroup.mapPlateDataUrl,
          denoise: getSetting("mapDenoise"), upscaleMP: getSetting("colorizeUpscaleMP"),
          label: `Map colorize — ${mapGroup.name}`
        })
      : await this.img.generate(imagePrompt, {
          mode: "txt2img", width: DESCRIBED_SIZE.w, height: DESCRIBED_SIZE.h,
          label: `Map art — ${mapGroup.name}`
        });
    const bgPath = await uploadDataUrl(bgDataUrl, `map-${slug(mapGroup.name)}.png`);
    const { width: W, height: H } = await imageSize(bgDataUrl);

    // ---- placement (indoor only): read walls/lights/keys off the image ----
    let placement = null;
    if (indoor) {
      try {
        onProgress?.(`Reading walls & lights from "${mapGroup.name}"`);
        placement = await this.#placeFromImage(bgDataUrl, mapGroup, { width: W, height: H });
      } catch (e) { warn(`Wall/light placement failed for ${mapGroup.name}; scene kept without them`, e); }
    }

    // ---- scene ----
    const grid = gridType === "hex"
      ? (() => { const d = parseScaleNote(mapGroup.plateMeta?.scaleNote) ?? { value: 0.5, units: "mi" };
                 return { type: CONST.GRID_TYPES.HEXODDR, size: this.gridPx, distance: d.value, units: d.units }; })()
      : { type: CONST.GRID_TYPES.SQUARE, size: this.gridPx, distance: getSetting("feetPerSquare"), units: "ft" };

    const scene = await Scene.create({
      name: mapGroup.name,
      width: W, height: H,
      grid,
      background: { src: bgPath },
      padding: 0,
      tokenVision: indoor,
      fogExploration: indoor,
      globalLight: !indoor,
      flags: { "acks-classic-importer": {
        setting: indoor ? "indoor" : "outdoor",
        hex: gridType === "hex",
        keyPositions: placement?.keyPositions ?? []
      } }
    });

    if (placement) await this.#embedPlacement(scene, placement, occupants);
    return scene;
  }

  /** Tactical "zoom-in" encounter maps for a wilderness map: one txt2img
   *  battlemap per distinct terrain. Outdoor — no walls, no geometry. */
  async buildEncounterScenes(mapGroup, { folderId = null, onProgress } = {}) {
    if (!this.enabled) return [];
    const per = getSetting("encounterMapsPerTerrain") ?? 1;
    if (per <= 0) return [];
    const terrains = await this.#listTerrains(mapGroup);
    if (!terrains.length) return [];

    const { w: W, h: H } = ENCOUNTER_SIZE;
    const out = [];
    for (const terrain of terrains) {
      for (let i = 1; i <= per; i++) {
        const name = `Encounter — ${titleCase(terrain)}${per > 1 ? ` (${i})` : ""} [${mapGroup.name}]`;
        onProgress?.(`Building encounter map: ${name}`);
        try {
          const prompt = `Top-down fantasy battlemap, orthographic, no perspective: ${terrainPrompt(terrain)}. Natural ground texture, painterly, crisp detail, no grid lines, no labels, no text, no characters.`;
          const dataUrl = await this.img.generate(prompt, { mode: "txt2img", width: W, height: H, label: `Encounter art — ${name}` });
          const bgPath = await uploadDataUrl(dataUrl, `enc-${slug(mapGroup.name)}-${terrain}-${i}.png`);
          const scene = await Scene.create({
            name, folder: folderId,
            width: W, height: H,
            grid: { type: CONST.GRID_TYPES.SQUARE, size: this.gridPx, distance: getSetting("feetPerSquare"), units: "ft" },
            background: { src: bgPath },
            padding: 0,
            tokenVision: true,
            fogExploration: false,
            globalLight: true, // daylight; nighttime is a GM toggle
            flags: { "acks-classic-importer": { encounter: true, terrain, parentMap: mapGroup.name } }
          });
          out.push({ terrain, scene });
        } catch (e) { warn(`Encounter map failed for ${name}`, e); }
      }
    }
    return out;
  }

  // ---- setting resolution ----
  async #resolveSetting(mapGroup, { onProgress } = {}) {
    if (mapGroup.mapPlateDataUrl) {
      const mt = String(mapGroup.plateMeta?.mapType ?? "").toLowerCase();
      const gridType = mapGroup.plateMeta?.gridType === "hex" ? "hex" : "square";
      let indoor;
      if (INDOOR_MAP_TYPES.has(mt)) indoor = true;
      else if (OUTDOOR_MAP_TYPES.has(mt)) indoor = false;
      else indoor = gridType !== "hex"; // unknown plate type: square→indoor, hex→outdoor
      return { indoor, gridType, imagePrompt: null };
    }
    // described-only: classify + build the txt2img prompt in one call.
    onProgress?.(`Designing map for "${mapGroup.name}"`);
    const text = `Map/area name: ${mapGroup.name}\n\nDescription:\n${(mapGroup.sourceText ?? "").slice(0, 16000)}\n\nKeyed locations:\n${this.#keyedDescriptions(mapGroup)}`;
    const out = await this.llm.completeJSON(DESCRIBE_SYSTEM, [{ type: "text", text }], 4000, { label: `Map description — ${mapGroup.name}` });
    return {
      indoor: out?.setting !== "outdoor",
      gridType: "square",
      imagePrompt: out?.imagePrompt || `Top-down fantasy battlemap of ${mapGroup.name}, orthographic, no text, no grid`
    };
  }

  // ---- prompts ----
  #keyedDescriptions(mapGroup) {
    return (mapGroup.locations ?? [])
      .map((l) => {
        const desc = String(l.summary ?? "").split(/[.;]/)[0].slice(0, 100).trim();
        return `${l.key}: ${l.name ?? ""}${desc ? ` — ${desc}` : ""}`.trim();
      })
      .join("\n");
  }

  #colorizePrompt(mapGroup, indoor) {
    const base = indoor
      ? "Colorize and add detail to this hand-drawn top-down dungeon map. Keep every room, corridor, wall, door, and label exactly where it is; only add color, stone texture, and shading. Aged-parchment cartography, muted colors."
      : "Colorize and add detail to this hand-drawn top-down overland map. Keep all coastlines, terrain, rivers, roads, and labels exactly where they are; only add color and natural texture. Painted-atlas cartography, muted natural colors.";
    const keyed = this.#keyedDescriptions(mapGroup);
    return keyed ? `${base}\nThe keyed areas on the map are:\n${keyed}` : base;
  }

  // ---- vision placement (indoor) ----
  async #placeFromImage(bgDataUrl, mapGroup, dims) {
    const overlay = await overlayPixelRuler(bgDataUrl);
    const out = await this.llm.completeJSON(PLACE_SYSTEM, [
      { type: "image", dataUrl: overlay },
      { type: "text", text: `Image size: ${dims.width} x ${dims.height} pixels.\nKeyed areas:\n${this.#keyedDescriptions(mapGroup)}` }
    ], 16000, { label: `Wall/light placement — ${mapGroup.name}` });
    return sanitizePlacement(out, dims);
  }

  async #embedPlacement(scene, placement, occupants) {
    const wallDocs = [];
    for (const w of placement.walls) wallDocs.push({ c: [w.x1, w.y1, w.x2, w.y2] });
    for (const d of placement.doors) {
      wallDocs.push({
        c: [d.x1, d.y1, d.x2, d.y2],
        door: d.state === "secret" ? CONST.WALL_DOOR_TYPES.SECRET : CONST.WALL_DOOR_TYPES.DOOR,
        ds: d.state === "open" ? CONST.WALL_DOOR_STATES.OPEN
          : (d.state === "locked" || d.state === "barred") ? CONST.WALL_DOOR_STATES.LOCKED
          : CONST.WALL_DOOR_STATES.CLOSED
      });
    }
    for (const w of placement.windows) {
      wallDocs.push({ c: [w.x1, w.y1, w.x2, w.y2], sight: CONST.WALL_SENSE_TYPES.NONE, move: CONST.WALL_MOVEMENT_TYPES.NORMAL });
    }
    if (wallDocs.length) await scene.createEmbeddedDocuments("Wall", wallDocs);

    const lightDocs = placement.lights.map((l) => ({
      x: l.x, y: l.y,
      config: { bright: (l.radiusFeet ?? 20) / 2, dim: l.radiusFeet ?? 20, color: l.color ?? "#ffb066", animation: { type: "torch", speed: 2, intensity: 3 } }
    }));
    if (lightDocs.length) await scene.createEmbeddedDocuments("AmbientLight", lightDocs);

    const tokenDocs = [];
    for (const spot of placement.tokenSpots) {
      const occ = occupants.get(normRef(spot.ref));
      if (!occ) continue;
      const actor = game.actors.get(occ.actorId);
      if (!actor) continue;
      tokenDocs.push({ ...actor.prototypeToken.toObject(), actorId: actor.id, x: Math.round(spot.x), y: Math.round(spot.y) });
    }
    if (tokenDocs.length) await scene.createEmbeddedDocuments("Token", tokenDocs);
  }

  // ---- terrain enumeration (for encounter maps) ----
  async #listTerrains(mapGroup) {
    const content = [];
    if (mapGroup.mapPlateDataUrl) content.push({ type: "image", dataUrl: mapGroup.mapPlateDataUrl });
    content.push({ type: "text", text: `Map: ${mapGroup.name}\n\n${(mapGroup.sourceText ?? "").slice(0, 8000)}` });
    let list = [];
    try {
      const out = await this.llm.completeJSON(TERRAIN_LIST_SYSTEM, content, 2000, { label: `Terrain list — ${mapGroup.name}` });
      list = Array.isArray(out?.terrains) ? out.terrains : (Array.isArray(out) ? out : []);
    } catch (e) { warn(`Terrain enumeration failed for ${mapGroup.name}`, e); }
    const norm = [...new Set(list.map(normalizeTerrain))];
    return norm.length ? norm : ["grassland"];
  }
}

/* ---------- helpers ---------- */

function titleCase(t) { return String(t).replace(/\b\w/g, (c) => c.toUpperCase()); }

/** Coerce vision placement output to finite, in-bounds pixel coordinates. */
export function sanitizePlacement(out, dims) {
  const W = dims.width, H = dims.height;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const clampN = (v, max) => { const n = num(v); return n === null ? null : Math.min(Math.max(n, 0), max); };
  const seg = (s) => {
    const x1 = clampN(s?.x1, W), y1 = clampN(s?.y1, H), x2 = clampN(s?.x2, W), y2 = clampN(s?.y2, H);
    return (x1 === null || y1 === null || x2 === null || y2 === null) ? null : { ...s, x1, y1, x2, y2 };
  };
  const pt = (o, fx = "x", fy = "y") => {
    const x = clampN(o?.[fx], W), y = clampN(o?.[fy], H);
    return (x === null || y === null) ? null : { ...o, [fx]: x, [fy]: y };
  };
  const o = (out && typeof out === "object") ? out : {};
  return {
    walls: (o.walls ?? []).map(seg).filter(Boolean),
    doors: (o.doors ?? []).map(seg).filter(Boolean),
    windows: (o.windows ?? []).map(seg).filter(Boolean),
    lights: (o.lights ?? []).map((l) => pt(l)).filter(Boolean).map((l) => ({ ...l, radiusFeet: num(l.radiusFeet) ?? 20 })),
    tokenSpots: (o.tokenSpots ?? []).map((t) => pt(t)).filter(Boolean),
    keyPositions: (o.keyPositions ?? []).map((k) => pt(k)).filter(Boolean)
  };
}

/** Composite a labeled pixel-coordinate ruler over the map so the vision model
 *  can return wall/light positions in image pixels. Returns a data URL. */
export async function overlayPixelRuler(bgDataUrl) {
  const img = await loadImage(bgDataUrl);
  const c = makeCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const step = Math.max(64, Math.round(Math.max(img.width, img.height) / 12 / 16) * 16);
  ctx.strokeStyle = "rgba(0,255,255,0.5)";
  ctx.fillStyle = "rgba(0,255,255,0.95)";
  ctx.font = `${Math.max(13, Math.round(step * 0.16))}px monospace`;
  for (let x = 0; x <= img.width; x += step) {
    ctx.lineWidth = x % (step * 5) === 0 ? 2 : 0.7;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, img.height); ctx.stroke();
    ctx.fillText(String(x), x + 2, 16);
  }
  for (let y = 0; y <= img.height; y += step) {
    ctx.lineWidth = y % (step * 5) === 0 ? 2 : 0.7;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(img.width, y); ctx.stroke();
    ctx.fillText(String(y), 2, y + 16);
  }
  return c.toDataURL("image/png");
}

export function parseScaleNote(note) {
  if (!note) return null;
  const m = String(note).match(/(\d+(?:[./]\d+)?)\s*(mile|mi|feet|ft|yard)/i);
  if (!m) return null;
  const v = m[1].includes("/") ? Number(m[1].split("/")[0]) / Number(m[1].split("/")[1]) : Number(m[1]);
  const units = /mi|mile/i.test(m[2]) ? "mi" : "ft";
  return { value: v, units };
}

async function imageSize(dataUrl) {
  const img = await loadImage(dataUrl);
  return { width: img.width, height: img.height };
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

/* ---------- canvas factory (panic guard) ----------
 * Skia (browser canvas and @napi-rs/canvas) aborts the whole process for a
 * zero/negative/NaN/oversized surface, so the one canvas we still build (the
 * pixel-ruler overlay) is sized through here. */
const MAX_CANVAS_PX = 8192;
export function makeCanvas(w, h) {
  const clamp = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_CANVAS_PX);
  };
  const c = document.createElement("canvas");
  c.width = clamp(w); c.height = clamp(h);
  return c;
}

function normRef(s) { return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
export { normRef };

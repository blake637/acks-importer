/**
 * Scene builder.
 *
 * Design decision: LAYOUT-FIRST. Asking an image model for a battlemap and
 * then guessing wall coordinates from the picture is unreliable. Instead:
 *
 *   1. The LLM produces a geometric LAYOUT JSON (rooms as grid-aligned
 *      polygons, door/window segments, stairs, light sources) from the keyed
 *      location text — and, when a scanned map plate exists, a vision pass
 *      over that plate grounds the geometry in the original cartography.
 *   2. Walls, doors, windows, and lights are derived DETERMINISTICALLY from
 *      that layout, so they always line up with the background.
 *   3. The background is either (a) rendered programmatically from the layout
 *      (clean old-school blue/white line map — always works), or (b) generated
 *      by the image model using the layout as a textual blueprint, accepting
 *      some artistic drift the GM can nudge afterward.
 *
 * Layout schema (grid units, 1 unit = 1 map square or 1 hex):
 * {
 *   "name": str, "gridType": "square"|"hex", "gridWidth": int, "gridHeight": int,
 *   "feetPerSquare": int,            // square maps
 *   "distancePerHex": {"value": n, "units": "mi"|"ft"}|null,   // hex maps
 *   "rooms": [{ "key": str, "polygon": [[x,y],...], "label": str }],
 *   "doors": [{ "from": str|null, "to": str|null, "x1":n,"y1":n,"x2":n,"y2":n,
 *               "state": "closed"|"locked"|"secret"|"open"|"barred" }],
 *   "windows": [{ "x1":n,"y1":n,"x2":n,"y2":n, "barred": bool }],
 *   "lights": [{ "x":n,"y":n, "radiusFeet": n, "color": str|null, "note": str }],
 *   "stairs": [{ "x":n,"y":n, "direction": "up"|"down", "label": str }],
 *   "tokenSpots": [{ "ref": str, "x":n, "y":n }],
 *   // hex maps only:
 *   "terrainRegions": [{ "terrain": "forest"|"hills"|"mountains"|"water"|"swamp"|"grassland"|"desert"|"road"|"river", "polygon": [[col,row],...] }],
 *   "features": [{ "col": n, "row": n, "name": str, "kind": "settlement"|"ruin"|"lair"|"landmark"|"camp" }]
 * }
 */

import { LLMClient } from "./llm-client.js";
import { ImageClient, uploadDataUrl } from "./image-client.js";
import { fitGenerationSize } from "./comfy-workflow.js";
import { generateEncounterLayout, renderEncounterMap, wallsForEncounter, encounterRegions, normalizeTerrain } from "./encounter-maps.js";
import { getSetting } from "../settings.js";
import { slug } from "./actor-builder.js";
import { warn } from "../util/logger.js";

function titleCaseTerrain(t) { return String(t).replace(/\b\w/g, (c) => c.toUpperCase()); }
function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const LAYOUT_SYSTEM = `You are a cartography engine. Given the keyed text describing a group of locations from a classic dungeon module (and possibly an image of the original scanned map), output a geometric layout JSON per the provided schema. Rules:
- Use grid units; one unit is one map square. Align room polygons to the grid where the original map does.
- Every door mentioned in the text must appear in "doors" with the correct state (locked, secret, barred, stuck → "locked"; default "closed"). Door segments must lie ON a shared wall edge between the two spaces, spanning exactly 1 grid unit unless the text says double doors (2 units).
- Windows (including barred windows) go in "windows" on exterior walls.
- "lights": only place light sources the text supports (hearths, braziers, magical light, daylight through breaches). Torch/candle ≈ 20' radius, hearth/brazier ≈ 30', magical light per spell (Light ≈ 30').
- "tokenSpots": one entry per occupant reference (NPC or monster group) at a sensible position inside its room.
- If you have the scanned map image, reproduce its topology faithfully (room adjacency, corridor routing, relative sizes). If not, this is a DESCRIBED-ONLY location: derive geometry from the text — use stated dimensions and exits verbatim where given; otherwise size rooms by function (bedroom ~2x2 to 3x3 squares at 10'/square, common room ~4x6, great hall ~6x10) and arrange them compactly with shared walls and a sensible entrance on an exterior wall. Buildings get rectilinear footprints; caves and lairs get irregular 6-10 vertex polygons connected by short passages.
- HEX / WILDERNESS MAPS: if the source map uses hexes or depicts overland terrain (scale notes like "1 hex = 1/2 mile" are the tell), set gridType "hex", read distancePerHex from the scale note, and emit terrainRegions (coarse polygons in col/row units covering forests, hills, rivers, roads, water) and features (one entry per named place: settlements, ruins, lairs, peaks, glades) INSTEAD of rooms/doors/windows. Leave lights empty — wilderness scenes use daylight. tokenSpots may still reference lairs.
- Output JSON only.`;

export class SceneBuilder {
  constructor() {
    this.llm = new LLMClient();
    this.img = new ImageClient();
    this.gridPx = getSetting("gridSizePx");
    this.useImgMaps = getSetting("generateMapArt") && this.img.enabled;
  }

  /**
   * @param {object} mapGroup  { name, locations:[...extracted locations], sourceText, mapPlateDataUrl|null, plateMeta|null }
   * @param {Map<string,{actorId,count}>} occupants locationRef → actor info
   */
  async buildScene(mapGroup, occupants, { onProgress } = {}) {
    onProgress?.(`Laying out "${mapGroup.name}"`);
    const layout = await this.#getLayout(mapGroup);
    if (layout.gridType === "hex") return this.#buildHexScene(mapGroup, layout, occupants, { onProgress });

    const feet = layout.feetPerSquare || getSetting("feetPerSquare");
    const px = this.gridPx;
    const W = (layout.gridWidth + 2) * px, H = (layout.gridHeight + 2) * px;
    const off = px; // 1-square margin
    const G = (u) => off + u * px;

    // ---- background ----
    onProgress?.(`Rendering map for "${mapGroup.name}"`);
    // Blueprint (player-facing fallback) is always rendered. For Flux image
    // generation we render a LABELED REFERENCE — each room filled and stamped
    // with its key + description — and hand it to Flux for an img2img redraw.
    const blueprintDataUrl = renderLineMap(layout, px, off, W, H);
    let bgPath, bgDataUrl = null;
    if (this.useImgMaps) {
      try {
        const { genW, genH, scale } = fitGenerationSize(W, H);
        const referenceDataUrl = renderLabeledReference(layout, mapGroup, px * scale, off * scale, genW, genH);
        const prompt = this.#mapPrompt(mapGroup, layout);
        bgDataUrl = await this.img.generate(prompt, {
          width: genW, height: genH,
          referenceImageDataUrl: referenceDataUrl,
          denoise: getSetting("mapDenoise") ?? 0.72,
          label: `Map art — ${mapGroup.name}`
        });
        bgPath = await uploadDataUrl(bgDataUrl, `map-${slug(mapGroup.name)}.png`);
      } catch (e) { warn("Image-gen map failed; falling back to line map", e); }
    }
    if (!bgPath) {
      bgPath = await uploadDataUrl(blueprintDataUrl, `map-${slug(mapGroup.name)}.png`);
    }

    // ---- optional vision refinement: reconcile walls with generated art ----
    let finalLayout = layout;
    if (bgDataUrl && getSetting("visionRefineWalls")) {
      try {
        onProgress?.(`Vision pass: aligning walls to art for "${mapGroup.name}"`);
        finalLayout = await this.#refineLayoutWithVision(layout, bgDataUrl, px, off);
      } catch (e) { warn("Vision wall refinement failed; using blueprint layout", e); }
    }

    // ---- scene ----
    const scene = await Scene.create({
      name: mapGroup.name,
      width: W, height: H,
      grid: { type: CONST.GRID_TYPES.SQUARE, size: px, distance: feet, units: "ft" },
      background: { src: bgPath },
      padding: 0,
      tokenVision: true,
      fogExploration: true,
      flags: { "acks-classic-importer": { layout: finalLayout, blueprintLayout: layout } }
    });

    // ---- walls (room polygons), doors, windows ----
    const wallDocs = [];
    const doorSegs = (finalLayout.doors ?? []).map((d) => segKey(G(d.x1), G(d.y1), G(d.x2), G(d.y2)));
    const windowSegs = (finalLayout.windows ?? []).map((w) => segKey(G(w.x1), G(w.y1), G(w.x2), G(w.y2)));
    const seen = new Set();
    for (const room of finalLayout.rooms ?? []) {
      const poly = room.polygon;
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
        // split each edge into unit segments so doors/windows can punch through
        for (const [x1, y1, x2, y2] of unitSegments(ax, ay, bx, by)) {
          const k = segKey(G(x1), G(y1), G(x2), G(y2));
          if (seen.has(k)) continue;
          seen.add(k);
          if (doorSegs.includes(k)) continue;     // handled below
          if (windowSegs.includes(k)) continue;   // handled below
          wallDocs.push({ c: [G(x1), G(y1), G(x2), G(y2)] });
        }
      }
    }
    for (const d of finalLayout.doors ?? []) {
      const secret = d.state === "secret";
      wallDocs.push({
        c: [G(d.x1), G(d.y1), G(d.x2), G(d.y2)],
        door: secret ? CONST.WALL_DOOR_TYPES.SECRET : CONST.WALL_DOOR_TYPES.DOOR,
        ds: d.state === "open" ? CONST.WALL_DOOR_STATES.OPEN
          : (d.state === "locked" || d.state === "barred") ? CONST.WALL_DOOR_STATES.LOCKED
          : CONST.WALL_DOOR_STATES.CLOSED
      });
    }
    for (const w of finalLayout.windows ?? []) {
      wallDocs.push({
        c: [G(w.x1), G(w.y1), G(w.x2), G(w.y2)],
        sight: CONST.WALL_SENSE_TYPES.NONE,      // see through
        move: CONST.WALL_MOVEMENT_TYPES.NORMAL    // can't walk through
      });
    }
    if (wallDocs.length) await scene.createEmbeddedDocuments("Wall", wallDocs);

    // ---- lights ----
    const lightDocs = (finalLayout.lights ?? []).map((l) => ({
      x: G(l.x), y: G(l.y),
      config: {
        bright: (l.radiusFeet ?? 20) / 2,
        dim: l.radiusFeet ?? 20,
        color: l.color ?? "#ffb066",
        animation: { type: "torch", speed: 2, intensity: 3 }
      }
    }));
    if (lightDocs.length) await scene.createEmbeddedDocuments("AmbientLight", lightDocs);

    // ---- tokens at layout spots ----
    const tokenDocs = [];
    for (const spot of finalLayout.tokenSpots ?? []) {
      const occ = occupants.get(normRef(spot.ref));
      if (!occ) continue;
      const actor = game.actors.get(occ.actorId);
      if (!actor) continue;
      const proto = actor.prototypeToken.toObject();
      tokenDocs.push({ ...proto, actorId: actor.id, x: G(spot.x), y: G(spot.y) });
    }
    if (tokenDocs.length) await scene.createEmbeddedDocuments("Token", tokenDocs);

    // ---- map notes linking rooms to journal pages added later by journal-builder ----
    return scene;
  }

  async #getLayout(mapGroup) {
    const metaLine = mapGroup.plateMeta
      ? `Plate metadata read from the scan: ${JSON.stringify({ title: mapGroup.plateMeta.title, mapType: mapGroup.plateMeta.mapType, gridType: mapGroup.plateMeta.gridType, scaleNote: mapGroup.plateMeta.scaleNote })}\n\n`
      : "";
    const content = [{
      type: "text",
      text: `Map/area name: ${mapGroup.name}\n\n${metaLine}Keyed location text:\n${mapGroup.sourceText.slice(0, 40000)}\n\nLocations summary JSON:\n${JSON.stringify(mapGroup.locations).slice(0, 20000)}`
    }];
    if (mapGroup.mapPlateDataUrl) content.unshift({ type: "image", dataUrl: mapGroup.mapPlateDataUrl });
    const layout = await this.llm.completeJSON(LAYOUT_SYSTEM, content, 16000, { label: `Map layout — ${mapGroup.name}` });
    if (layout === null) {
      warn(`Layout skipped for ${mapGroup.name}; using a minimal empty layout (blueprint will be a bare field)`);
      return { gridType: "square", gridWidth: 30, gridHeight: 20, rooms: [], doors: [], windows: [], lights: [], stairs: [], tokenSpots: [] };
    }
    layout.gridWidth ??= 40; layout.gridHeight ??= 30;
    layout.gridType ??= mapGroup.plateMeta?.gridType === "hex" ? "hex" : "square";
    return layout;
  }

  /** Per-room regional prompts: each keyed room's bbox + a terse description
   *  drawn from its extracted location summary. This is what makes a single
   *  generation render the chapel AS a chapel and the barracks AS a barracks
   *  — no tiling, no seams, no baked-in text. */
  #regionPrompts(mapGroup, layout, px, off) {
    const byKey = new Map((mapGroup.locations ?? []).map((l) => [String(l.key).trim().toLowerCase(), l]));
    const regions = [];
    for (const room of layout.rooms ?? []) {
      const loc = byKey.get(String(room.key).trim().toLowerCase());
      const desc = (loc?.summary ?? room.label ?? "").split(/[.;]/)[0].slice(0, 120).trim();
      if (!desc) continue;
      const xs = room.polygon.map((p) => p[0]), ys = room.polygon.map((p) => p[1]);
      regions.push({
        x: off + Math.min(...xs) * px,
        y: off + Math.min(...ys) * px,
        w: (Math.max(...xs) - Math.min(...xs)) * px,
        h: (Math.max(...ys) - Math.min(...ys)) * px,
        prompt: `top-down dungeon floor: ${desc}, stone interior, no text`
      });
    }
    // Largest rooms first; the workflow builder caps the count.
    return regions.sort((a, b) => b.w * b.h - a.w * a.h);
  }

  /** Hex wilderness scenes: terrain background, hex grid, feature pins via
   *  layout flags (journal-builder pins features like it pins rooms). No
   *  walls — overland maps navigate by sight, not occlusion. */
  async #buildHexScene(mapGroup, layout, occupants, { onProgress } = {}) {
    const px = this.gridPx;
    const cols = layout.gridWidth ?? 30, rows = layout.gridHeight ?? 24;
    // Pointy-top, odd-row offset (Foundry HEXODDR). Approximate pixel field.
    const W = Math.round((cols + 1.5) * px);
    const H = Math.round((rows + 1.5) * px * 0.866 + px);
    const off = px * 0.75;

    onProgress?.(`Rendering hex map for "${mapGroup.name}"`);
    const blueprintDataUrl = renderHexMap(layout, px, off, W, H);
    let bgPath, bgDataUrl = null;
    if (this.useImgMaps) {
      try {
        const { genW, genH, scale } = fitGenerationSize(W, H);
        const referenceDataUrl = renderHexLabeledReference(layout, px * scale, off * scale, genW, genH);
        bgDataUrl = await this.img.generate(
          `Top-down fantasy overland wilderness map, painted-atlas cartography style, orthographic, repaint each labeled region as that terrain (${(layout.terrainRegions ?? []).map((t) => t.terrain).join(", ") || "grassland"}), muted natural colors, crisp coastlines, no hex grid lines, no labels, no text, no compass.`,
          { width: genW, height: genH, referenceImageDataUrl: referenceDataUrl, denoise: getSetting("mapDenoise") ?? 0.72, label: `Hex map art — ${mapGroup.name}` }
        );
        bgPath = await uploadDataUrl(bgDataUrl, `map-${slug(mapGroup.name)}.png`);
      } catch (e) { warn("Hex image-gen failed; falling back to drawn hex map", e); }
    }
    if (!bgPath) bgPath = await uploadDataUrl(blueprintDataUrl, `map-${slug(mapGroup.name)}.png`);

    const dist = layout.distancePerHex ?? parseScaleNote(mapGroup.plateMeta?.scaleNote) ?? { value: 0.5, units: "mi" };
    const scene = await Scene.create({
      name: mapGroup.name,
      width: W, height: H,
      grid: { type: CONST.GRID_TYPES.HEXODDR, size: px, distance: dist.value, units: dist.units },
      background: { src: bgPath },
      padding: 0,
      tokenVision: false,
      fogExploration: false,
      globalLight: true,
      flags: { "acks-classic-importer": { layout, hex: true } }
    });

    // Token spots for lairs that have actors.
    const tokenDocs = [];
    for (const spot of layout.tokenSpots ?? []) {
      const occ = occupants.get(normRef(spot.ref));
      if (!occ) continue;
      const actor = game.actors.get(occ.actorId);
      if (!actor) continue;
      const { x, y } = hexToPixel(spot.x ?? spot.col ?? 0, spot.y ?? spot.row ?? 0, px, off);
      tokenDocs.push({ ...actor.prototypeToken.toObject(), actorId: actor.id, x, y });
    }
    if (tokenDocs.length) await scene.createEmbeddedDocuments("Token", tokenDocs);
    return scene;
  }

  /**
   * Tactical "zoom-in" battle maps for a wilderness hex group: identify the
   * distinct terrain types present, then generate N square-grid encounter
   * scenes per terrain with procedural obstacle scatter and obstacle walls.
   * @returns {Array<{terrain, scene}>}
   */
  async buildEncounterScenes(mapGroup, layout, { folderId = null, onProgress } = {}) {
    const per = getSetting("encounterMapsPerTerrain") ?? 1;
    if (per <= 0) return [];

    // Distinct terrains, normalized; always include grassland as the open-
    // country default if the map had any terrain at all.
    const terrains = [...new Set([
      ...(layout.terrainRegions ?? []).map((t) => normalizeTerrain(t.terrain)),
      ...((layout.terrainRegions ?? []).length ? ["grassland"] : [])
    ])];
    if (!terrains.length) return [];

    const cols = 30, rows = 20;
    const px = this.gridPx;
    const W = cols * px, H = rows * px;
    const feet = getSetting("feetPerSquare");
    const out = [];

    for (const terrain of terrains) {
      for (let i = 1; i <= per; i++) {
        const name = `Encounter — ${titleCaseTerrain(terrain)}${per > 1 ? ` (${i})` : ""} [${mapGroup.name}]`;
        onProgress?.(`Building encounter map: ${name}`);
        // Seed from terrain+index+map name → reproducible across re-imports.
        const seed = hashSeed(`${mapGroup.name}|${terrain}|${i}`);
        const enc = generateEncounterLayout(terrain, cols, rows, seed);

        let bgPath = null;
        if (this.useImgMaps) {
          try {
            const { genW, genH, scale } = fitGenerationSize(W, H);
            const referenceDataUrl = renderEncounterMap(enc, px * scale, genW, genH, { control: true });
            const dataUrl = await this.img.generate(
              `Top-down fantasy battlemap, orthographic, no perspective, repaint the colored regions as ${enc.prompt}, natural ground texture, painterly, crisp detail, no grid lines, no labels, no text, no characters.`,
              { width: genW, height: genH, referenceImageDataUrl: referenceDataUrl, label: `Encounter art — ${name}` }
            );
            bgPath = await uploadDataUrl(dataUrl, `enc-${slug(mapGroup.name)}-${terrain}-${i}.png`);
          } catch (e) { warn(`Encounter art failed for ${name}; using drawn map`, e); }
        }
        if (!bgPath) {
          bgPath = await uploadDataUrl(renderEncounterMap(enc, px, W, H), `enc-${slug(mapGroup.name)}-${terrain}-${i}.png`);
        }

        const scene = await Scene.create({
          name,
          folder: folderId,
          width: W, height: H,
          grid: { type: CONST.GRID_TYPES.SQUARE, size: px, distance: feet, units: "ft" },
          background: { src: bgPath },
          padding: 0,
          tokenVision: true,
          fogExploration: false,
          globalLight: true, // daylight; nighttime is a GM toggle
          flags: { "acks-classic-importer": { encounterLayout: enc, terrain, parentMap: mapGroup.name } }
        });
        const walls = wallsForEncounter(enc, px);
        if (walls.length) await scene.createEmbeddedDocuments("Wall", walls);
        out.push({ terrain, scene });
      }
    }
    return out;
  }

  /**
   * art and ask the (multimodal) LLM to nudge the layout where the painting
   * drifted from the blueprint. Topology is locked — the model may only move
   * existing vertices/segments by small amounts, never add or remove rooms or
   * doors — so a hallucinating vision pass can't wreck a valid layout.
   */
  async #refineLayoutWithVision(layout, bgDataUrl, px, off) {
    const overlay = await overlayCoordinateGrid(bgDataUrl, px, off, layout.gridWidth, layout.gridHeight);
    const refined = await this.llm.completeJSON(REFINE_SYSTEM, [
      { type: "image", dataUrl: overlay },
      { type: "text", text: `Current layout JSON (grid units, matching the labeled overlay):\n${JSON.stringify(layout)}` }
    ], 16000, { label: `Vision wall refinement — uses generated art` });
    return sanitizeRefinement(layout, refined); // null-safe: falsy refined returns the original
  }

  #mapPrompt(mapGroup, layout) {
    const rooms = (layout.rooms ?? []).map((r) => `${r.key}: polygon ${JSON.stringify(r.polygon)}`).join("; ");
    return `Top-down fantasy battlemap, orthographic, no perspective, aged-parchment dungeon floor plan with stone texture, grid-aligned, ${layout.gridWidth}x${layout.gridHeight} squares. Rooms and corridors exactly per this blueprint (grid coordinates): ${rooms}. Doors at: ${JSON.stringify(layout.doors ?? [])}. Style: classic dungeon crawl cartography, muted colors, crisp walls, no labels, no text, no compass, no characters.`;
  }
}

/* ---------- deterministic old-school line map ---------- */
export function renderLineMap(layout, px, off, W, H) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const G = (u) => off + u * px;
  // field
  ctx.fillStyle = "#0e2a47"; ctx.fillRect(0, 0, W, H);
  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += px) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += px) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  // rooms
  for (const room of layout.rooms ?? []) {
    ctx.beginPath();
    room.polygon.forEach(([x, y], i) => i ? ctx.lineTo(G(x), G(y)) : ctx.moveTo(G(x), G(y)));
    ctx.closePath();
    ctx.fillStyle = "#dfe7ee"; ctx.fill();
    ctx.strokeStyle = "#0b2138"; ctx.lineWidth = Math.max(4, px * 0.08); ctx.stroke();
    // faint interior grid
    ctx.save(); ctx.clip();
    ctx.strokeStyle = "rgba(14,42,71,0.25)"; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += px) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += px) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.restore();
    // key label
    ctx.fillStyle = "#0b2138"; ctx.font = `bold ${Math.round(px * 0.5)}px serif`;
    const cx = room.polygon.reduce((s, p) => s + p[0], 0) / room.polygon.length;
    const cy = room.polygon.reduce((s, p) => s + p[1], 0) / room.polygon.length;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(room.key, G(cx), G(cy));
  }
  // doors drawn as gaps with a bar
  for (const d of layout.doors ?? []) {
    ctx.strokeStyle = d.state === "secret" ? "#b8860b" : "#7a4a21";
    ctx.lineWidth = Math.max(6, px * 0.12);
    ctx.beginPath(); ctx.moveTo(G(d.x1), G(d.y1)); ctx.lineTo(G(d.x2), G(d.y2)); ctx.stroke();
  }
  // stairs
  ctx.fillStyle = "#0b2138"; ctx.font = `${Math.round(px * 0.4)}px serif`;
  for (const s of layout.stairs ?? []) ctx.fillText(s.direction === "up" ? "▲" : "▼", G(s.x), G(s.y));
  return c.toDataURL("image/png");
}

/* ---------- Flux img2img labeled-reference renders ----------
 * The OPPOSITE of a ControlNet line image: each region is filled with a base
 * tint and stamped with its key + a short description IN the image. Flux reads
 * the labels and repaints each region as the labeled thing; a moderate
 * denoise keeps the layout while painting over the flat labels. Walls/doors
 * still come from the layout geometry, not from this picture. */
export function renderLabeledReference(layout, mapGroup, px, off, W, H) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const G = (u) => off + u * px;
  // neutral stone field
  ctx.fillStyle = "#9b9286"; ctx.fillRect(0, 0, W, H);

  const byKey = new Map((mapGroup?.locations ?? []).map((l) => [String(l.key).trim().toLowerCase(), l]));
  for (const room of layout.rooms ?? []) {
    const xs = room.polygon.map((p) => p[0]), ys = room.polygon.map((p) => p[1]);
    const loc = byKey.get(String(room.key).trim().toLowerCase());
    const tint = roomTint(loc?.summary ?? room.label ?? "");
    ctx.beginPath();
    room.polygon.forEach(([x, y], i) => i ? ctx.lineTo(G(x), G(y)) : ctx.moveTo(G(x), G(y)));
    ctx.closePath();
    ctx.fillStyle = tint; ctx.fill();
    ctx.strokeStyle = "#2b2620"; ctx.lineWidth = Math.max(3, px * 0.1); ctx.stroke();
    // label: key + short description, centered
    const cx = G(xs.reduce((a, b) => a + b, 0) / xs.length);
    const cy = G(ys.reduce((a, b) => a + b, 0) / ys.length);
    const desc = (loc?.summary ?? room.label ?? "").split(/[.;]/)[0].slice(0, 48);
    drawLabel(ctx, cx, cy, `${room.key}`, desc, px);
  }
  // doors as openings in the wall stroke
  for (const d of layout.doors ?? []) {
    ctx.strokeStyle = d.state === "secret" ? "#9b9286" : "#6b4a28";
    ctx.lineWidth = Math.max(5, px * 0.16);
    ctx.beginPath(); ctx.moveTo(G(d.x1), G(d.y1)); ctx.lineTo(G(d.x2), G(d.y2)); ctx.stroke();
  }
  return c.toDataURL("image/png");
}

export function renderHexLabeledReference(layout, px, off, W, H) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = TERRAIN_COLORS.grassland; ctx.fillRect(0, 0, W, H);
  paintTerrain(ctx, layout, px, off);
  // stamp each terrain region with its name so Flux paints the right biome
  for (const t of layout.terrainRegions ?? []) {
    if ((t.polygon ?? []).length < 3) continue;
    const cols = t.polygon.map((p) => p[0]), rows = t.polygon.map((p) => p[1]);
    const { x, y } = hexToPixel(
      cols.reduce((a, b) => a + b, 0) / cols.length,
      rows.reduce((a, b) => a + b, 0) / rows.length, px, off);
    drawLabel(ctx, x, y, "", t.terrain, px);
  }
  for (const f of layout.features ?? []) {
    const { x, y } = hexToPixel(f.col, f.row, px, off);
    ctx.fillStyle = "#1d1a14"; ctx.beginPath(); ctx.arc(x, y, px * 0.12, 0, Math.PI * 2); ctx.fill();
    drawLabel(ctx, x, y - px * 0.3, "", f.name, px);
  }
  return c.toDataURL("image/png");
}

function drawLabel(ctx, cx, cy, key, desc, px) {
  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(20,16,12,0.55)";
  const fs = Math.max(11, Math.round(px * 0.22));
  ctx.font = `bold ${fs}px sans-serif`;
  const text = desc || key;
  const w = ctx.measureText(text).width + 12;
  ctx.fillRect(cx - w / 2, cy - fs * 0.7, w, fs * 1.4);
  ctx.fillStyle = "#fdf4e0";
  if (key) { ctx.font = `bold ${fs}px sans-serif`; ctx.fillText(key, cx, cy - (desc ? fs * 0.55 : 0)); }
  if (desc) { ctx.font = `${Math.round(fs * 0.78)}px sans-serif`; ctx.fillText(desc, cx, cy + (key ? fs * 0.45 : 0)); }
  ctx.restore();
}

// crude base tint by room function, so the reference already hints at content
function roomTint(summary) {
  const s = String(summary).toLowerCase();
  if (/chapel|temple|altar|shrine/.test(s)) return "#7c6a8a";
  if (/kitchen|pantry|larder|food/.test(s)) return "#8a7a5a";
  if (/barrack|guard|armory|weapon/.test(s)) return "#6a6f78";
  if (/prison|cell|dungeon|jail/.test(s)) return "#5d5650";
  if (/throne|hall|court/.test(s)) return "#8a7048";
  if (/water|pool|cistern|well/.test(s)) return "#4a6f86";
  if (/library|study|lab|workshop/.test(s)) return "#6f6a52";
  return "#8d8478";
}

/* ---------- ControlNet conditioning render ----------
 * Clean black-on-white linework at GENERATION resolution: walls as heavy
 * black strokes, doors as gaps with thin jamb ticks, no grid, no labels,
 * no color. Lineart/scribble/canny ControlNets read this far more reliably
 * than the player-facing blue/white blueprint. */
export function renderControlImage(layout, px, off, W, H) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const G = (u) => off + u * px;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  // room outlines
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = Math.max(3, px * 0.12);
  ctx.lineJoin = "miter";
  for (const room of layout.rooms ?? []) {
    ctx.beginPath();
    room.polygon.forEach(([x, y], i) => i ? ctx.lineTo(G(x), G(y)) : ctx.moveTo(G(x), G(y)));
    ctx.closePath(); ctx.stroke();
  }
  // doors: erase a gap, then draw thin jamb ticks
  for (const d of layout.doors ?? []) {
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(5, px * 0.2);
    ctx.beginPath(); ctx.moveTo(G(d.x1), G(d.y1)); ctx.lineTo(G(d.x2), G(d.y2)); ctx.stroke();
    ctx.restore();
    if (d.state !== "secret") { // secret doors stay visually seamless
      ctx.strokeStyle = "#000000"; ctx.lineWidth = Math.max(1, px * 0.04);
      const mx = (G(d.x1) + G(d.x2)) / 2, my = (G(d.y1) + G(d.y2)) / 2;
      const dx = G(d.x2) - G(d.x1), dy = G(d.y2) - G(d.y1);
      const nx = -dy, ny = dx; // normal
      const L = Math.hypot(nx, ny) || 1, t = px * 0.18;
      ctx.beginPath();
      ctx.moveTo(mx - (nx / L) * t, my - (ny / L) * t);
      ctx.lineTo(mx + (nx / L) * t, my + (ny / L) * t);
      ctx.stroke();
    }
  }
  // stairs as chevrons (a strong shape cue for the model)
  ctx.fillStyle = "#000000"; ctx.font = `${Math.round(px * 0.5)}px sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const s of layout.stairs ?? []) ctx.fillText(s.direction === "up" ? "^" : "v", G(s.x), G(s.y));
  return c.toDataURL("image/png");
}

/* ---------- hex map renderers ---------- */
const TERRAIN_COLORS = {
  forest: "#2f5d3a", hills: "#8a7a4d", mountains: "#6e6a66", water: "#2e5d8a",
  swamp: "#4d5d3a", grassland: "#7da05a", desert: "#cdb273", road: "#9c7a4f", river: "#3f76a8"
};

export function hexToPixel(col, row, px, off) {
  // pointy-top, odd rows offset right (Foundry HEXODDR approximation)
  const x = off + (col + (row % 2 ? 0.5 : 0)) * px;
  const y = off + row * px * 0.866;
  return { x: Math.round(x), y: Math.round(y) };
}

export function renderHexMap(layout, px, off, W, H) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = TERRAIN_COLORS.grassland; ctx.fillRect(0, 0, W, H);
  paintTerrain(ctx, layout, px, off);
  // hex grid
  ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1;
  const cols = layout.gridWidth ?? 30, rows = layout.gridHeight ?? 24;
  for (let r = 0; r <= rows; r++) {
    for (let q = 0; q <= cols; q++) {
      const { x, y } = hexToPixel(q, r, px, off);
      drawHex(ctx, x, y, px / 1.732);
    }
  }
  // features
  ctx.fillStyle = "#1d1a14";
  ctx.font = `bold ${Math.round(px * 0.32)}px serif`;
  ctx.textAlign = "center";
  for (const f of layout.features ?? []) {
    const { x, y } = hexToPixel(f.col, f.row, px, off);
    ctx.beginPath(); ctx.arc(x, y, px * 0.14, 0, Math.PI * 2); ctx.fill();
    ctx.fillText(f.name, x, y - px * 0.2);
  }
  return c.toDataURL("image/png");
}

/** Hex control image: flat terrain color fields, no grid, no labels —
 *  a segmentation-style conditioning that terrain painting follows well. */
export function renderHexControlImage(layout, px, off, W, H) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = TERRAIN_COLORS.grassland; ctx.fillRect(0, 0, W, H);
  paintTerrain(ctx, layout, px, off);
  return c.toDataURL("image/png");
}

function paintTerrain(ctx, layout, px, off) {
  for (const t of layout.terrainRegions ?? []) {
    ctx.fillStyle = TERRAIN_COLORS[t.terrain] ?? TERRAIN_COLORS.grassland;
    if ((t.polygon ?? []).length < 3) continue;
    ctx.beginPath();
    t.polygon.forEach(([qc, qr], i) => {
      const { x, y } = hexToPixel(qc, qr, px, off);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    if (t.terrain === "road" || t.terrain === "river") {
      ctx.lineWidth = px * (t.terrain === "river" ? 0.3 : 0.18);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.stroke();
    } else ctx.fill();
  }
}

function drawHex(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath(); ctx.stroke();
}

export function parseScaleNote(note) {
  if (!note) return null;
  const m = String(note).match(/(\d+(?:[./]\d+)?)\s*(mile|mi|feet|ft|yard)/i);
  if (!m) return null;
  let v = m[1].includes("/") ? Number(m[1].split("/")[0]) / Number(m[1].split("/")[1]) : Number(m[1]);
  const units = /mi|mile/i.test(m[2]) ? "mi" : "ft";
  return { value: v, units };
}

/* ---------- vision refinement helpers ---------- */

const REFINE_SYSTEM = `You are a map-alignment engine. You receive (1) a generated battlemap image with a labeled coordinate grid overlaid (cyan lines; axis labels are GRID UNITS) and (2) the layout JSON that was used as its blueprint. The painting may have drifted slightly from the blueprint. Return the SAME layout JSON with coordinates adjusted so walls, doors, windows, and lights sit on the painted features. Hard rules:
- Do NOT add or remove rooms, doors, windows, lights, stairs, or tokenSpots.
- Do NOT rename keys. Keep every field you do not adjust.
- Move any vertex or segment by at most 2 grid units from its current value.
- Keep door segments exactly 1 unit long (2 for double doors) and on a wall edge.
- Snap to half-unit increments.
Output JSON only.`;

/** Enforce the refinement contract: same topology, bounded movement. */
export function sanitizeRefinement(original, refined) {
  if (!refined || typeof refined !== "object") return original;
  const out = foundry.utils.deepClone(original);
  const clampPair = (orig, next) => {
    const dx = Number(next?.[0]) - orig[0], dy = Number(next?.[1]) - orig[1];
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return orig;
    return [orig[0] + clamp(dx, -2, 2), orig[1] + clamp(dy, -2, 2)].map(halfSnap);
  };
  (out.rooms ?? []).forEach((room, ri) => {
    const rRoom = refined.rooms?.[ri];
    if (!rRoom?.polygon || rRoom.polygon.length !== room.polygon.length) return;
    room.polygon = room.polygon.map((pt, pi) => clampPair(pt, rRoom.polygon[pi]));
  });
  const clampSeg = (list, rlist) => (list ?? []).forEach((seg, i) => {
    const r = rlist?.[i];
    if (!r) return;
    for (const k of ["x1", "y1", "x2", "y2", "x", "y"]) {
      if (seg[k] === undefined || r[k] === undefined) continue;
      seg[k] = halfSnap(seg[k] + clamp(Number(r[k]) - seg[k], -2, 2));
    }
  });
  clampSeg(out.doors, refined.doors);
  clampSeg(out.windows, refined.windows);
  clampSeg(out.lights, refined.lights);
  clampSeg(out.tokenSpots, refined.tokenSpots);
  return out;
}

/** Composite a labeled grid over map art so a vision model can return
 *  coordinates anchored to grid units rather than guessing pixels. */
export async function overlayCoordinateGrid(bgDataUrl, px, off, gridW, gridH) {
  const img = await loadImage(bgDataUrl);
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  // The art was generated at scene dimensions; map grid units → pixels.
  const sx = img.width / ((gridW + 2) * px), sy = img.height / ((gridH + 2) * px);
  ctx.strokeStyle = "rgba(0,255,255,0.55)";
  ctx.fillStyle = "rgba(0,255,255,0.9)";
  ctx.font = `${Math.max(14, Math.round(px * sx * 0.35))}px monospace`;
  for (let u = 0; u <= gridW; u++) {
    const x = (off + u * px) * sx;
    ctx.lineWidth = u % 5 === 0 ? 2 : 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, img.height); ctx.stroke();
    if (u % 5 === 0) ctx.fillText(String(u), x + 3, 18);
  }
  for (let v = 0; v <= gridH; v++) {
    const y = (off + v * px) * sy;
    ctx.lineWidth = v % 5 === 0 ? 2 : 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(img.width, y); ctx.stroke();
    if (v % 5 === 0) ctx.fillText(String(v), 3, y + 16);
  }
  return c.toDataURL("image/png");
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function halfSnap(v) { return Math.round(v * 2) / 2; }
function roundTo8(v) { return Math.max(256, Math.round(v / 8) * 8); }

/* ---------- geometry helpers ---------- */
function unitSegments(ax, ay, bx, by) {
  const out = [];
  const dx = Math.sign(bx - ax), dy = Math.sign(by - ay);
  if (dx !== 0 && dy !== 0) return [[ax, ay, bx, by]]; // diagonal: keep whole
  let x = ax, y = ay;
  while (x !== bx || y !== by) {
    const nx = x + dx, ny = y + dy;
    out.push([x, y, nx, ny]);
    x = nx; y = ny;
    if (out.length > 500) break; // safety
  }
  return out.length ? out : [[ax, ay, bx, by]];
}
function segKey(x1, y1, x2, y2) {
  return x1 < x2 || (x1 === x2 && y1 <= y2) ? `${x1},${y1}-${x2},${y2}` : `${x2},${y2}-${x1},${y1}`;
}
function normRef(s) { return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
export { normRef };

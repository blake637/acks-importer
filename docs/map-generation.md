# Map Generation

How the importer turns a classic adventure PDF into Foundry scenes. The
pipeline is **image-first**: the map picture is produced first, and walls/lights
are then placed by a vision model that *looks at the finished image*. There is
no authored geometry to keep the art faithful to — the art is the source of
truth.

- [Shared design](#shared-design)
- [How a map's type is decided](#how-a-maps-type-is-decided)
- Map types:
  1. [Wilderness (plate)](#1-wilderness-plate)
  2. [Described-only](#2-described-only)
  3. [Plate-backed dungeon](#3-plate-backed-dungeon)
  4. [Wilderness encounter](#4-wilderness-encounter)
- [Indoor placement (the vision pass)](#indoor-placement-the-vision-pass)
- [Image graphs](#image-graphs)
- [Robustness](#robustness)
- [Settings](#settings)
- [Function reference](#function-reference)

Core code: `scripts/pipeline/scene-builder.js`. Terrain vocabulary:
`scripts/pipeline/encounter-maps.js`. Flux graphs:
`scripts/pipeline/comfy-workflow.js`. Plate↔text assignment:
`scripts/pipeline/plate-matcher.js`. Orchestration: `scripts/apps/importer-app.js`.

---

## Shared design

**Image-first, in three steps:**

1. **Background.** If the PDF has a scanned map plate, **colorize + upscale** it
   (a low-denoise img2img that keeps the original structure — rooms, corridors,
   coastlines, labels). If not, **paint it from the text description** (txt2img).
2. **Indoor vs outdoor.** Outdoor maps get a background + grid and *nothing
   else*. Indoor maps additionally get walls, lights, and notes.
3. **Placement (indoor only).** A vision model looks at the finished image with
   a pixel-coordinate ruler overlaid, plus the keyed-area descriptions, and
   returns walls/doors/windows/lights/tokens/keyed-room-centers **in image
   pixels**. Foundry walls are pixel-space, so they align to the art exactly.

**An image provider is REQUIRED.** There is no deterministic drawn fallback. If
none is configured (or `generateMapArt` is off), no scenes are created (token
art is unaffected).

**The grid is for measurement only.** Scene dimensions equal the produced
image's dimensions, so placement pixels map 1:1 onto the scene. The Foundry grid
size is `gridSizePx` (hex `HEXODDR` + scale-note distance for wilderness; square
+ `feetPerSquare` otherwise) — a measurement aid, GM-adjustable; it is *not*
guaranteed to line up with the painted squares. Walls do not depend on it.

---

## How a map's type is decided

### Grouping — `ImporterApp#groupLocations`
Keyed locations are bucketed by `parentMap` (default **"Keyed Locations"**).
Each group carries its `locations`, `sourceText` (concatenated source pages),
and — via `matchPlate` / proximity — an optional scanned plate
(`mapPlateDataUrl` + `plateMeta`).

### Branch — `SceneBuilder#resolveSetting`
- **Has a plate** → background is **colorize**; indoor/outdoor from
  `plateMeta.mapType` (`dungeon`/`building` → indoor; `wilderness`/`region`/
  `town` → outdoor; unknown → square=indoor, hex=outdoor); grid hex iff the
  plate is hex.
- **No plate (described-only)** → one `DESCRIBE_SYSTEM` call returns
  `{ imagePrompt, setting }`; background is **txt2img** from that prompt; square
  grid.

The four sections below are the four resulting cases.

---

## 1. Wilderness (plate)

A scanned overland/hex map exists. **Background:** colorize + upscale the plate
("keep all coastlines, terrain, roads, and labels; only add color"). **Outdoor**
→ `HEXODDR` grid, distance from the plate's scale note (`parseScaleNote`),
`globalLight` on, no walls/lights/notes/tokens. Sets `flags.hex = true`, which
triggers **[encounter maps](#4-wilderness-encounter)**.

## 2. Described-only

The PDF describes an area but prints no map. `#resolveSetting` calls
`DESCRIBE_SYSTEM` (text → `{ imagePrompt, setting }`) and the background is
**txt2img** painted from `imagePrompt`. If `setting` is **indoor**, it gets the
[placement pass](#indoor-placement-the-vision-pass); if **outdoor**, background
+ grid only. Square grid.

## 3. Plate-backed dungeon

A scanned dungeon/building map exists. **Background:** colorize + upscale the
plate; the prompt includes the **keyed room descriptions** (via
`#keyedDescriptions`) so each labeled region is painted consistent with what it
is (the chapel as a chapel, the kitchen as a kitchen) while the plate's
structure is preserved. **Indoor** → the [placement pass](#indoor-placement-the-vision-pass).

## 4. Wilderness encounter

`SceneBuilder.buildEncounterScenes`, triggered after a wilderness scene.
`#listTerrains` enumerates the distinct terrain types on the map (vision over
the plate, else text). For each terrain, `encounterMapsPerTerrain` square
battlemaps are **txt2img**-painted from the terrain's prompt (`terrainPrompt`).
Always **outdoor** — daylight, no walls, no geometry. Linked from a "Wilderness
Encounters" journal by terrain.

---

## Indoor placement (the vision pass)

`SceneBuilder#placeFromImage` (used by types 2-indoor and 3):

1. `overlayPixelRuler` composites a labeled cyan pixel ruler over the finished
   background.
2. `PLACE_SYSTEM` is called with that image **plus** the keyed-area descriptions
   (`#keyedDescriptions`). The model matches each labeled region to its
   description and returns, **in pixels**:
   `walls[]`, `doors[]` (with `state`), `windows[]`, `lights[]` (with
   `radiusFeet`), `tokenSpots[]` (occupant ref), `keyPositions[]` (room-key
   centers). Descriptions inform door states and light placement.
3. `sanitizePlacement` coerces every coordinate to a finite, in-bounds pixel and
   drops the unsalvageable.
4. `#embedPlacement` creates the `Wall` / `AmbientLight` / `Token` documents
   directly at those pixels. Doors become door-walls (secret/locked/open/closed);
   windows block movement but not sight. `keyPositions` is stored in scene flags,
   and **`journal-builder.js`** pins each location's journal note there.

Outdoor maps skip all of this.

---

## Image graphs

`comfy-workflow.js` builds three Flux 2 Klein graphs:

| Builder | Use | Shape |
|---|---|---|
| `buildPortraitWorkflow` | actor token art | txt2img (EmptyFlux2LatentImage) |
| `buildTextToImageMap` | described-only + encounter maps | txt2img |
| `buildColorizeWorkflow` | colorize+upscale a plate | **img2img**: LoadImage → ImageScaleToTotalPixels (upscale) → VAEEncode → `BasicScheduler` with `denoise` (only the schedule tail runs → structure preserved) |

`ImageClient.generate(prompt, { mode, … })` routes by `mode`:
`"portrait"` | `"txt2img"` | `"colorize"` (with `sourceImageDataUrl`, `denoise`,
`upscaleMP`). Non-ComfyUI providers (OpenAI/Stability/custom) only do txt2img;
`colorize` degrades to txt2img there.

---

## Robustness

`overlayPixelRuler` is the only canvas we still draw; it goes through
`makeCanvas` (clamps size to `[1, 8192]` so a bad dimension can't abort the
process — Skia panics are native and uncatchable). Vision output is run through
`sanitizePlacement` before any document is created. Each scene is built inside a
try/catch, and the AI-call log flushes on every settle so a crash still leaves a
paper trail.

---

## Settings

| Setting | Default | Effect |
|---|---|---|
| `generateMapArt` | on | Generate scenes at all (requires an image provider) |
| `mapDenoise` | 0.4 | Colorize strength (img2img denoise); lower preserves the plate |
| `colorizeUpscaleMP` | 2 | Target megapixels when colorizing a plate |
| `gridSizePx` | 100 | Foundry grid size (measurement aid) |
| `feetPerSquare` | 10 | Square-map scale |
| `encounterMapsPerTerrain` | 1 | Encounter battlemaps per terrain (0 disables) |

---

## Function reference

| Function (`scene-builder.js` unless noted) | Role |
|---|---|
| `SceneBuilder.buildScene` | Entry point: classify → background → (indoor) placement → scene |
| `SceneBuilder#resolveSetting` | Indoor/outdoor + grid type + (described) image prompt |
| `SceneBuilder#colorizePrompt` / `#keyedDescriptions` | Plate colorize prompt incl. keyed descriptions |
| `SceneBuilder#placeFromImage` / `#embedPlacement` | Vision wall/light placement and document creation |
| `SceneBuilder#listTerrains` | Enumerate terrains for encounter maps |
| `SceneBuilder.buildEncounterScenes` | Per-terrain txt2img encounter battlemaps |
| `sanitizePlacement` | Coerce vision output to finite in-bounds pixels |
| `overlayPixelRuler` / `makeCanvas` | Pixel ruler overlay (the one render canvas) |
| `parseScaleNote` | Hex distance from a map's scale note |
| `buildColorizeWorkflow` / `buildTextToImageMap` / `buildPortraitWorkflow` (`comfy-workflow.js`) | Flux 2 Klein graphs |
| `normalizeTerrain` / `terrainPrompt` (`encounter-maps.js`) | Terrain vocabulary + painting prompts |
| `matchPlate` / `identifyMapPlates` (`plate-matcher.js`) | Assign scanned plates to map groups |

# ACKS Classic Module Importer (Foundry VTT)

Imports classic TSR-era adventure module PDFs — Basic/Expert, AD&D 1e, AD&D 2e —
and generates a playable Foundry world for the **Adventurer Conqueror King
System (ACKS)**:

- **Actors** for every NPC and monster, with stats converted to ACKS, embedded
  items/spells, generated token art, and an audit trail of conversion notes.
- **Monster deduplication** against your world, the module's own compendium,
  and any bestiary packs you list — new actors are created only for monsters
  that don't already exist (including unique monsters from module appendices).
- **Scenes** for every mapped area, with walls, doors (normal, secret,
  locked/barred), windows, and ambient lights placed deterministically from a
  geometric layout, plus pre-placed tokens and pinned journal notes.
- **Journals** for every keyed location (summary, occupants, traps, treasure,
  exits) and **RollTables** for rumor, wandering-monster, and encounter tables.

> Use this only with PDFs you legally own. The importer stores concise
> summaries and mechanical data, not page reproductions.

## Requirements

- Foundry VTT v11+ with the `acks` system installed.
- An LLM API key (Anthropic or any OpenAI-compatible endpoint, including local
  models) — used for structure extraction and map layout.
- Optionally an image-generation API key (OpenAI Images, Stability, or a
  custom endpoint) for token portraits and painted map backgrounds. Without
  one, the module still works: actors get letter-disc tokens and scenes use a
  built-in old-school blue/white line-map renderer.

## Setup

1. Install into `Data/modules/acks-classic-importer` and enable it in an ACKS world.
2. Configure API providers under **Settings → ACKS Classic Module Importer**.
3. Open the **Actors** sidebar → **Import Classic Module** → drop your PDF.
4. With *Review before create* enabled (recommended), you'll get editable JSON
   checkpoints after extraction and after conversion — fix OCR misreads or
   conversion choices there before any documents are created.

## Pipeline

```
PDF ──► pdf.js text + page renders ──► section-aware chunking
     ──► LLM structure extraction (strict JSON schema, original-edition stats)
     ──► deterministic ACKS conversion layer
     ──► Actors (dedup, token art)  ──► Scenes (layout → walls/doors/lights)
     ──► Journals + RollTables
```

### Why "layout-first" maps?

Generating a battlemap image and then guessing wall coordinates from pixels is
fragile. Instead the LLM (with a vision pass over the scanned map plate when
one is detected) emits a **geometric layout JSON** — rooms as grid-aligned
polygons, door segments with states, windows, light sources, token spots.
Walls/doors/lights are derived *from the layout itself*, so they always line
up with the rendered background. The background is either:

- the deterministic line-map renderer (always consistent), or
- a Flux img2img painting that redraws a labeled reference rendered from the
  same layout (see ComfyUI below). Either way the walls come from the layout,
  never from the pixels.

### Described-only locations (no map in the PDF)

Classic modules describe many areas — building interiors, lairs, shrines —
without printing a map. The importer detects these (a scanned plate is only
attached to a location group when it's named for the group or sits within 3
pages of its keyed text) and switches the layout prompt into described-only
mode: stated dimensions and exits are used verbatim, and missing geometry is
inferred by room function (rectilinear footprints for buildings, irregular
polygons for caves). Everything downstream — art, walls, doors, lights,
tokens — works identically from there.

### ComfyUI (Flux 2 Klein)

Set provider to **ComfyUI (local)** and the endpoint to your server root
(default `http://127.0.0.1:8188`). The built-in workflows target **Flux 2
Klein**; the loader filenames are settings with sensible defaults
(`flux2-klein.safetensors`, `clip_l.safetensors`, `t5xxl_fp16.safetensors`,
`ae.safetensors`) — adjust them to match your ComfyUI `models/` folders.

**Portraits (txt2img).** Character and monster tokens are generated with a
plain Flux text-to-image graph: `UNETLoader` + `DualCLIPLoader` (clip_l + T5)
+ `VAELoader` → `FluxGuidance` → `KSampler` (cfg 1.0, euler/simple) → decode.

**Maps (img2img redraw of a labeled reference).** No ControlNet. The importer
renders a **labeled reference image** from the layout — each room filled with
a base tint and stamped with its key and a short description (the chapel says
"chapel", the guard room says "guard post") — uploads it, and hands it to Flux
for an img2img redraw. Flux's T5 encoder reads the labels and repaints each
region as the thing it's labeled, in place. The redraw strength (img2img
denoise, default 0.72) is configurable: lower keeps the labeled layout more
faithfully, higher gives a more finished repaint. The flat labels are painted
over in the result; the player-facing keyed labels remain as toggleable
Foundry map-note pins. Walls/doors/lights still come from the layout geometry,
never from the painted pixels, so they always line up.

Hex/wilderness and tactical encounter maps use the same approach: a labeled
terrain reference (each region stamped with its biome) is redrawn by Flux.

Scene canvases can exceed sane diffusion sizes, so generation is fitted to a
1536px budget (aspect preserved, snapped to multiples of 16 for Flux) and
Foundry stretches the background to the scene.

For a different model or a hand-tuned graph, paste a custom API-format
workflow into the workflow setting — an annotated Flux example ships at
`assets/workflows/acks-map-flux.example.json` with placeholders `%%PROMPT%%`,
`%%WIDTH%%`, `%%HEIGHT%%`, `%%SEED%%`, `%%CHECKPOINT%%` (the UNet filename),
and `%%INIT_IMAGE%%` (the labeled reference, for an img2img chain).

### Matching map plates to their keyed text

Classic PDFs routinely print maps far from the text that keys them — inside
the cover or in an appendix. Page proximity is therefore weak evidence, so
when a vision-capable LLM is configured the importer runs a **plate
identification pass**: one vision call per candidate plate reads what's on it
(printed title, map type, square vs. hex grid, scale note, visible key
letters/numbers). Location groups are then matched to plates by scored
evidence — key overlap weighted highest (a plate showing rooms A–Z plus
AA–BP is near-proof), then title token overlap and a grid-type sanity check,
with page proximity demoted to a low-weight tiebreaker. Each plate is
assigned to at most one group, best matches first. Text-only LLMs fall back
to the conservative proximity heuristic.

### Matching map plates to their keyed text

Classic PDFs routinely print maps far from the text that keys them — inside
the cover or in an appendix. Page proximity is therefore weak evidence, so
when a vision-capable LLM is configured the importer runs a **plate
identification pass**: one vision call per candidate plate reads what's on it
(printed title, map type, square vs. hex grid, scale note, visible key
letters/numbers). Location groups are then matched to plates by scored
evidence — key overlap weighted highest (a plate showing rooms A–Z plus
AA–BP is near-proof), then title token overlap and a grid-type sanity check,
with page proximity demoted to a low-weight tiebreaker. Each plate is
assigned to at most one group, best matches first. Text-only LLMs fall back
to the conservative proximity heuristic.

### Hex / wilderness maps

Overland hex maps are first-class: the layout schema carries
`gridType: "hex"` with terrain regions (forest, hills, water, roads, rivers…)
and named features instead of rooms and doors. The scene is created with
Foundry's hex grid, distance-per-hex parsed from the plate's scale note
(e.g. ½ mile per hex), global light on, and no walls — overland play
navigates by sight, not occlusion. The background is either the built-in hex
terrain renderer (colored terrain fields + hex grid + feature markers) or a
painted-atlas Flux img2img redraw of a labeled terrain reference. Named
features become pinned
journal notes, and lair token spots still place actors.

### Conversion rules (D&D → ACKS)

These systems are close cousins but not interchangeable. The converter applies:

| Mechanic | Rule |
|---|---|
| Armor Class | descending → ascending: `ACKS AC = 9 − old AC` (so old AC 5 → ACKS 4) |
| Saving throws | ACKS five-category saves derived from HD ("saves as fighter of level = HD"); NPC class saves flagged for fine-tuning |
| XP | **recomputed** from the ACKS monster XP table (base by HD + bonus per special ability), never copied |
| Movement | inches → feet: `9"` → `90'(30')` exploration/combat |
| Morale | B/X 2d6, 1e, or 2e scales → ACKS −6…+6 modifier |
| Alignment | nine-point grid → Law / Neutral / Chaos |
| Classes | magic-user→Mage, ranger→Explorer, druid→Shaman, illusionist→Mage (flagged), etc.; levels capped at 14; multi-class collapsed to primary + notes |
| Spells | name-mapping table; anything without a clean ACKS equivalent is tagged `[UNMAPPED]` or "review" |
| Carried gear | classified into typed items (armor/shield/weapon/wand/staff/ring/potion/scroll); magic bonuses and remaining charges parsed; armor AC restated on the ascending scale; named AD&D items without an ACKS analogue (e.g. flame-tongue-style sword powers, AD&D wondrous items) get review notes; matched against your item compendia before creating new documents |
| Carried coin | dice-range notation in stat blocks (`2-8 pp`, `3-30 ep`) is rolled at import and written to the actor's currency fields, with the original formula preserved in the notes |
| Attack throws | approximated from HD per the ACKS monster progression |

Every converted actor carries its `conversionNotes` in flags and in the
biography tab, so nothing is changed silently.

### 5th-edition adventures

The importer also accepts 5e adventure PDFs. The edition is auto-detected by
scoring the text against stat-block conventions (challenge-rating lines and
ability arrays with modifiers vs. THAC0-era markers like movement in inches
and descending AC) — the pipeline log shows the scores, and a settings
override is available if it guesses wrong. 5e gets its own extraction schema
(traits, actions, legendary actions, senses, spellcasting blocks) and its own
conversion rules, because the math is *lossier* than classic→ACKS:

| 5e mechanic | Rule |
|---|---|
| Armor Class | rescaled, not copied: `ACKS AC = 5e AC − 10` |
| Hit Dice | derived from **CR** (≈ CR + 1 for CR 1+; fractional CRs map to ½–1½ HD), since 5e HP pools are inflated; the 5e pool is deliberately dropped and hp is rerolled on d8s |
| Speed | feet/round → exploration/combat: 30 ft → `120'(40')`, per-mode (fly/swim/burrow) preserved |
| Ability scores | clamped to the ACKS 3–18 range with notes |
| Morale | no 5e source value; defaults to 0 with a prompt to adjust |
| Traits / legendary actions / resistances | preserved as special abilities & defenses for GM adjudication (they also count toward the ACKS XP special-ability bonus) |
| Spells | levels 1–6 map through the spell table; levels 7–9 are dropped with notes (ACKS arcane casting stops at 6); cantrips are flagged `[CANTRIP]` and dropped |
| Classes | rogue→Thief, warlock/sorcerer/artificer→Mage (flagged), plus the classic mappings; stat-block NPCs without class levels get a level derived from CR |

Every 5e actor carries an explicit note that bounded-accuracy math was
rescaled rather than copied — treat the output as a strong first draft, not a
faithful port.

### Monster deduplication

Names are normalized (`Rat, Giant` ≡ `giant rats`), checked against the world,
the module's `imported-monsters` pack, and any packs listed in settings.
Monsters flagged as new/unique in the source (e.g. appendix creatures) are
always built from the module's own write-up.

### Tactical encounter maps (wilderness "zoom-in")

Hex maps drive overland travel and random encounters, but combat wants a
square grid. After building a wilderness scene, the importer identifies the
distinct terrain types present in the hex layout and generates 1–2 tactical
battle maps per terrain (configurable, 0 disables): 30×20-square scenes with
**procedurally scattered obstacles** — seeded from the map name and terrain,
so re-imports reproduce the same maps. Procedural scatter was chosen over LLM
layout deliberately: an encounter clearing needs believable, instant,
reproducible cover, not judgment.

Obstacles are tactically real, not just painted:

- boulders & rock outcrops → walls blocking sight **and** movement
- tree clusters → **limited-sight** walls (see into the treeline, not
  through it), movement unblocked
- cliff lines → movement-blocking walls that sight crosses
- pools, dunes, ridges, roads, rivers → painted only (difficult/clear
  terrain is a table ruling, not a wall)

Terrain coverage: forest, hills, mountains, grassland, swamp, desert,
river/water edge, and road — unknown terrain strings normalize to the nearest
type. Backgrounds use the same generation path as everything else (flat-color
labeled reference redrawn by Flux img2img, drawn renderer as fallback).
Scenes land in a "— Encounter Maps" folder, and a **Wilderness Encounters**
journal links each terrain type to its scenes for one-click activation when a
random encounter fires.

## Adjusting for your ACKS system version

All `system.*` data paths used when writing actors live in one map,
`SYSTEM_PATHS` in `scripts/pipeline/actor-builder.js`. If your ACKS build's
template differs, edit that one object. Any field that can't be written safely
is still preserved in the actor biography, so no data is lost.

## Testing

The pure pipeline core has an automated test suite that runs without Foundry
(a minimal globals shim lets the modules import under Node):

```
npm test          # or: node test/run.js
```

It covers conversion math (classic and 5e: AC, HD, saves, XP, morale,
movement, alignment, classes, spells), item classification and coin rolling,
edition detection, text chunking, ComfyUI workflow assembly (node-graph
validity, portrait vs img2img-map graph shape), plate matching by evidence,
procedural encounter generation (determinism, bounds, obstacle wall typing),
and JSON-recovery parsing (think-block stripping, empty-output safety). No
network, no API keys, no Foundry runtime. The harness is zero-dependency
(`test/harness.js`); add a case by dropping an `it(...)` into a file under
`test/suite/`. A non-zero exit code on failure makes it CI-friendly.

Foundry-interaction code (document creation, scene/wall placement, file
uploads) is intentionally out of scope for the unit suite — but the
end-to-end harness below exercises all of it.

### End-to-end pipeline test

A headless harness runs the **real pipeline** — live LLM and image-generation
calls included — against an actual PDF, with no Foundry and no manual
intervention. Foundry document creation is *recorded* rather than mocked, so
the output is the genuine data the pipeline produced (actors with converted
stats and items, scenes with their walls/lights/tokens/notes, journals,
tables) plus a complete AI-call paper trail.

```
# point at your own LLM (and optionally image) endpoints via env vars:
ACKS_LLM_PROVIDER=custom ACKS_LLM_ENDPOINT=http://localhost:8080 \
ACKS_LLM_MODEL=your-model \
ACKS_IMG_PROVIDER=comfyui ACKS_IMG_ENDPOINT=http://127.0.0.1:8188 \
ACKS_IMG_MODEL=flux2-klein.safetensors \
node test/e2e/run-e2e.js path/to/adventure.pdf --pages 20 --out test/e2e/artifacts/run1
```

It writes a full artifact tree to the `--out` directory for offline
inspection:

- `summary.json` — counts, per-scene wall/light/token/note tallies, AI-call
  breakdown, actor sample, and errors
- `ai-calls.json` / `ai-calls.transcript.txt` — every LLM and image call with
  full prompts, responses, timing, and status (human-readable transcript too)
- `ai-call-images/` — thumbnails of every generated image, by call id
- `actors.json` — each actor with converted ACKS stats and embedded items
- `scenes.json` — scenes with their recorded walls, lights, tokens, and notes
- `maps/`, `tokens/` — the generated PNGs
- `journals.json`, `tables.json`, `folders.json`, `errors.json`,
  `notifications.json`

The run exits non-zero if the pipeline throws or produces no actors, so it
works in CI as a smoke test. Review checkpoints and malformed-output recovery
dialogs auto-resolve to their non-blocking default, so it never blocks.

Env vars: `ACKS_LLM_PROVIDER/ENDPOINT/KEY/MODEL`,
`ACKS_IMG_PROVIDER/ENDPOINT/KEY/MODEL`, `ACKS_FLUX_CLIPL/T5/VAE`, `ACKS_MAP_DENOISE`,
`ACKS_COMFY_WORKFLOW`, `ACKS_EDITION`, `ACKS_ENC_PER_TERRAIN`. With
`ACKS_IMG_PROVIDER=none` the run still exercises everything except image
generation (programmatic maps + letter tokens).

**Offline self-check.** To validate the harness itself without any real APIs,
`test/e2e/mock-servers.js` provides a mock OpenAI-compatible LLM and a mock
ComfyUI; `node test/e2e/selfcheck.mjs <pdf>` wires them up and runs the full
harness against them.

## Debugging AI calls

Every LLM and image-generation request is recorded in a session-scoped **AI
Call Inspector** (button on the importer window): stage label, provider and
model, the full system and user prompts, the raw response (or a thumbnail for
generated images), duration, and status. Long texts are clipped in the dialog
view; **Export JSON** saves the complete log for bug reports. Statuses
distinguish `ok`, `error`, `skipped` (GM chose to continue without a result),
and `aborted`.

When an LLM returns output that can't be parsed as JSON — after one automatic
repair pass — a recovery dialog opens with the raw response in an editable
box and four choices:

1. **Retry generation** — re-runs the same call (useful for flaky local models)
2. **Use my fix** — hand-edit the JSON; the edit is validated before
   acceptance and re-opens if still invalid
3. **Continue without it** — the call resolves empty and downstream stages
   degrade gracefully (a skipped extraction chunk logs which pages may be
   missing entities; a skipped layout falls back to a bare field)
4. **Stop pipeline** — aborts the import cleanly; documents already created
   are kept, and the call log remains available for inspection

## Troubleshooting

- **No "Import Classic Module" button in the Actors sidebar:** Foundry v13
  rebuilt the sidebar on ApplicationV2 (the render hook now passes a native
  element instead of jQuery, and the header DOM changed). Version 0.1.1+
  handles v11–v13; if your build's header still differs, use either fallback:
  **Settings → Configure Settings → ACKS Classic Module Importer → Import
  Classic Module**, or run
  `game.modules.get("acks-classic-importer").api.open()` from a script macro
  or the console (F12).
- **Button appears twice:** shouldn't happen (re-render dedupe is in place),
  but if a theme module clones the header, the duplicate is harmless.

- **Local models (llama.cpp / Ollama / LM Studio / vLLM):** set provider to
  *OpenAI-compatible* or *Custom* and point the endpoint at your server — a
  bare `http://localhost:8080` is auto-normalized to
  `/v1/chat/completions`, and the API key may be left blank. If you see
  `key 'prompt' not found`, your endpoint was hitting llama.cpp's **native**
  `/completion` route, which speaks a different protocol; v0.1.2+ either
  normalizes you onto the OpenAI route or, if you explicitly end the URL in
  `/completion`, speaks the native protocol directly. Note the native route
  is text-only — map-plate vision needs the OpenAI route with a multimodal
  model, and small local models may need a few passes through the review
  checkpoint to correct extraction slips.

- **Reasoning/thinking models return empty output (chunks silently lose
  data):** models like Qwen3-thinking or DeepSeek-R1 may spend their whole
  token budget on a hidden reasoning phase and return empty `content` (or
  wrap visible reasoning in `<think>…</think>`). v0.7+ strips think tags
  before parsing, refuses to feed empty output to the JSON-repair pass (which
  otherwise returned `{}` and lost the chunk under an "ok" status), and the
  recovery dialog now explains when output was consumed by reasoning. The
  inspector annotates such calls with their `finish_reason`. Best fix: raise
  the token limit, or run the model with thinking reduced/disabled (e.g.
  `/no_think`, or your server's reasoning-effort setting).
- **Image generation fails instantly with "Failed to fetch" (~0.1s):** the
  browser never reached ComfyUI — almost always missing CORS headers. Unlike
  llama-server, ComfyUI does not send them by default; relaunch it with
  `--enable-cors-header "*"`. The error message now says this explicitly.
- **ComfyUI errors at a loader node:** the built-in workflows expect Flux 2
  Klein files (UNet + dual CLIP + VAE). Make sure the Flux loader filenames in
  settings match what's actually in your ComfyUI `models/` folders
  (`models/unet`, `models/clip`, `models/vae`). For a non-Flux model, paste a
  custom workflow into the workflow setting.
- **One bad actor no longer aborts the import:** actor creation (and token
  art) is failure-isolated — a failure is logged, the actor is skipped, and
  the run continues; the final status reports how many were skipped.

## Known limitations

- OCR-era scans are noisy; the review checkpoints exist precisely so you can
  catch misread numbers before documents are created.
- Cavern-style (non-rectilinear) maps get approximated polygon layouts; expect
  to hand-tune walls on organic cave systems.
- Spell/class equivalence is judgment-calling by design — flagged, not hidden.
- Image-generated map art will not match the layout pixel-perfectly; use the
  line-map renderer when wall fidelity matters more than looks.
- API keys are world-scope settings; treat your world data accordingly.

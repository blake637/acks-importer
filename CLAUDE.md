# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run unit tests (no Foundry, no API keys needed)
npm test
# or
node test/run.js

# End-to-end test against a real PDF with live API calls
ACKS_LLM_PROVIDER=custom ACKS_LLM_ENDPOINT=http://localhost:8080 \
ACKS_LLM_MODEL=your-model \
node test/e2e/run-e2e.js path/to/adventure.pdf --pages 20 --out test/e2e/artifacts/run1

# E2E self-check with mock servers (no real APIs, validates harness wiring)
node test/e2e/selfcheck.mjs path/to/adventure.pdf
```

There is no build step — this is a plain ES module project loaded directly by Foundry.

## Architecture

The module is a Foundry VTT v11–v13 module targeting the `acks` game system. It runs entirely in the browser (Foundry's client-side JS environment) with two exceptions: the test suite and e2e harness, which run under Node with a shim (`test/foundry-shim.js`) that stubs the Foundry globals needed for imports.

### Pipeline stages

`ImporterApp` (`scripts/apps/importer-app.js`) orchestrates everything. The stages flow sequentially with optional GM review checkpoints between them:

1. **PDF extraction** (`pipeline/pdf-extractor.js`) — pdf.js parses text and renders pages as images for the vision pass.
2. **Edition detection** (`pipeline/edition-detect.js`) — scores text against B/X/AD&D vs 5e stat-block conventions.
3. **Plate identification** (`pipeline/plate-matcher.js`) — vision LLM reads each map image; plates are scored and assigned to location groups by key overlap, title tokens, and grid type (page proximity is a low-weight tiebreaker).
4. **Chunking** (`util/chunker.js`) — section-aware text splitting before LLM calls.
5. **Structure extraction** (`pipeline/structure-extractor.js`) — LLM calls with strict JSON schemas extract monsters, NPCs, locations, tables, etc. in original-edition terms.
6. **ACKS conversion** (`pipeline/acks-converter.js`) — deterministic math: descending AC → ascending (`9 − oldAC`), saves from HD table, XP recomputed from ACKS table, movement inches → feet, morale rescaled, class/alignment mapped. 5e gets separate rules (CR-derived HD, AC rescaled, spell levels 7–9 dropped).
7. **Actor creation** (`pipeline/actor-builder.js`) — monsters are deduped via `MonsterIndex` (`pipeline/monster-dedup.js`) against the world, the `imported-monsters` compendium, and configured bestiary packs. Token art is generated if an image provider is configured.
8. **Scene creation** (`pipeline/scene-builder.js`) — LLM emits a geometric layout JSON (rooms as polygons, doors with states, windows, lights, token spots); walls/doors/lights are derived from that geometry, never from pixels. Hex/wilderness maps get Foundry hex grid scenes with terrain regions. Tactical encounter maps (`pipeline/encounter-maps.js`) are generated procedurally (seeded, deterministic).
9. **Journals & tables** (`pipeline/journal-builder.js`) — keyed location journals and RollTables for rumors, wandering monsters, and encounters.

### LLM client (`pipeline/llm-client.js`)

Supports three dialects auto-detected from the endpoint URL and provider setting: `anthropic` (Messages API), `openai` (chat completions, also covers local servers — Ollama, LM Studio, vLLM), and `llamacpp` (native `/completion` protocol). All calls request strict JSON. On parse failure, one automatic repair pass runs; if that fails, a recovery dialog opens in the UI with retry/edit/skip/abort options.

Think-block stripping (`<think>…</think>`) and empty-output detection are handled before the JSON parser is invoked.

### Image client (`pipeline/comfy-workflow.js`, `pipeline/image-client.js`)

ComfyUI workflow graphs are built programmatically (Flux 2 Klein node graph for both txt2img portraits and img2img map redraw). Maps use a **labeled reference image** approach: the importer renders a flat labeled image from the layout geometry, uploads it as the init image, and Flux redraws it. Walls always come from the layout geometry, not the painted image. A custom workflow JSON can be pasted into settings with placeholders `%%PROMPT%%`, `%%WIDTH%%`, `%%HEIGHT%%`, `%%SEED%%`, `%%CHECKPOINT%%`, `%%INIT_IMAGE%%`.

### Settings (`scripts/settings.js`)

All settings are `scope: "world"` and registered under `MODULE_ID = "acks-classic-importer"`. Key settings: `llmProvider`, `llmApiKey`, `llmModel`, `llmEndpoint`, `imgProvider`, `imgEndpoint`, `fluxUnet/ClipL/T5/Vae`, `mapDenoise`, `comfyWorkflow`, `sourceEdition`, `generateTokenArt`, `generateMapArt`, `reviewBeforeCreate`.

### System data paths (`pipeline/actor-builder.js`)

All `system.*` field assignments for ACKS actor data go through `SYSTEM_PATHS` at the top of `actor-builder.js`. If the ACKS system template changes, this is the only place to update. Any field that can't be placed safely falls back to the actor biography, so no data is silently lost.

### Test suite

The harness (`test/harness.js`) is zero-dependency — no Jest/Vitest/Mocha. Suites live under `test/suite/` and cover conversion math, stat parsing, edition detection, item classification, coin rolling, plate matching, ComfyUI workflow graph shape, procedural encounter determinism, and JSON recovery. The Foundry globals shim is in `test/foundry-shim.js`. Add a test by dropping an `it(...)` into an existing suite file or a new `*.test.js` imported in `test/run.js`.

E2E artifacts are written to the `--out` directory: `summary.json`, `ai-calls.json`, `ai-calls.transcript.txt`, `actors.json`, `scenes.json`, `maps/`, `tokens/`, `journals.json`, `tables.json`, `errors.json`.

### Dual-copy layout

The repository has two copies of the module code: the root (`scripts/`, `templates/`, `styles/`, `module.json`) and `acks-classic-importer/` (a subdirectory with the same structure). Edits should be made to the root copy, which is the active Foundry module path (`Data/modules/acks-importer`).

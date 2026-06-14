/**
 * Importer application: the GM-facing UI that orchestrates the pipeline.
 *
 * Stages (each with an optional review checkpoint when reviewBeforeCreate
 * is enabled):
 *   1. Read PDF       → text + page images, map plate candidates
 *   2. Extract        → normalized entity JSON (LLM)
 *   3. Convert        → ACKS-ready entities (deterministic)
 *   4. Create actors  → dedup monsters, build NPCs, token art
 *   5. Create scenes  → layout JSON, background, walls/doors/lights, tokens
 *   6. Journals/tables
 */

import { extractPdf } from "../pipeline/pdf-extractor.js";
import { detectEdition } from "../pipeline/edition-detect.js";
import { identifyMapPlates, matchPlate } from "../pipeline/plate-matcher.js";
import { chunkText } from "../util/chunker.js";
import { extractStructure } from "../pipeline/structure-extractor.js";
import { convertMonster, convertNPC } from "../pipeline/acks-converter.js";
import { ActorBuilder } from "../pipeline/actor-builder.js";
import { MonsterIndex } from "../pipeline/monster-dedup.js";
import { SceneBuilder, normRef } from "../pipeline/scene-builder.js";
import { buildJournals, buildRollTables } from "../pipeline/journal-builder.js";
import { getSetting, MODULE_ID } from "../settings.js";
import { log, warn } from "../util/logger.js";
import { DebugLog, PipelineAbortError } from "../util/debug-log.js";

export class ImporterApp extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "acks-classic-importer",
      title: "ACKS Classic Module Importer",
      template: `modules/${MODULE_ID}/templates/importer.hbs`,
      width: 640, height: "auto", resizable: true
    });
  }

  constructor() {
    super();
    this.state = { stage: "idle", progress: 0, message: "Drop a module PDF to begin.", logLines: [] };
  }

  getData() { return { ...this.state, aiCalls: DebugLog.count }; }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".aci-inspect").on("click", () => DebugLog.openInspector());
    html.find(".aci-export-log").on("click", () => DebugLog.export());
    const drop = html.find(".aci-dropzone");
    drop.on("dragover", (e) => { e.preventDefault(); drop.addClass("hover"); });
    drop.on("dragleave", () => drop.removeClass("hover"));
    drop.on("drop", (e) => {
      e.preventDefault(); drop.removeClass("hover");
      const file = e.originalEvent.dataTransfer?.files?.[0];
      if (file?.type === "application/pdf") this.run(file);
      else ui.notifications.error("Please drop a PDF file.");
    });
    html.find("input[type=file]").on("change", (e) => {
      const file = e.target.files?.[0];
      if (file) this.run(file);
    });
  }

  #status(message, progress = null) {
    this.state.message = message;
    if (progress !== null) this.state.progress = Math.round(progress * 100);
    this.state.logLines.push(message);
    if (this.state.logLines.length > 200) this.state.logLines.shift();
    this.render(false);
    log(message);
  }

  async run(file, { preExtracted = null } = {}) {
    try {
      this.state.stage = "running";

      // ---------- 1. Read PDF ----------
      // The e2e harness can inject already-extracted pages (bypassing pdf.js,
      // which needs a browser worker) while still exercising the real
      // pipeline from extraction onward.
      this.#status(`Reading ${file?.name ?? "document"}…`, 0.02);
      const { pages, pageImages } = preExtracted ?? await extractPdf(file, {
        onProgress: (m, p) => this.#status(m, 0.02 + p * 0.13)
      });

      // ---------- 2. Detect edition & extract structure ----------
      let edition = getSetting("sourceEdition");
      if (edition === "auto") {
        const det = detectEdition(pages);
        edition = det.edition;
        this.#status(`Detected edition: ${edition === "5e" ? "5th Edition" : "Classic (B/X / AD&D)"} (markers — 5e: ${det.scores.fiveE}, classic: ${det.scores.classic}). Override in settings if wrong.`, 0.155);
      } else {
        this.#status(`Source edition (from settings): ${edition}`, 0.155);
      }
      const chunks = chunkText(pages);
      this.#status(`Sending ${chunks.length} chunks for extraction…`, 0.16);
      let extracted = await extractStructure(chunks, {
        edition,
        onProgress: (m, p) => this.#status(m, 0.16 + p * 0.24)
      });
      extracted = await this.#review("Extracted entities", extracted);

      // ---------- 3. Convert to ACKS ----------
      this.#status("Converting to ACKS…", 0.42);
      let converted = {
        npcs: (extracted.npcs ?? []).map(convertNPC),
        monsters: (extracted.monsters ?? []).map(convertMonster)
      };
      converted = await this.#review("ACKS conversions (with notes)", converted);

      // ---------- 4. Actors ----------
      const moduleName = file.name.replace(/\.pdf$/i, "");
      const folders = await this.#folders(moduleName);
      const builder = await new ActorBuilder().prepare();
      const monsterIndex = await new MonsterIndex().build();
      const occupants = new Map(); // normalized locationRef → {actorId}

      let i = 0, failed = 0;
      for (const npc of converted.npcs) {
        this.#status(`Creating NPC ${++i}/${converted.npcs.length}: ${npc.name}`, 0.45 + 0.15 * (i / Math.max(1, converted.npcs.length)));
        try {
          const actor = await builder.buildActor(npc, { folderId: folders.npcs.id });
          if (!actor?.id) throw new Error("Actor.create returned no document");
          if (npc.locationRef) occupants.set(normRef(npc.locationRef) + "|" + normRef(npc.name), { actorId: actor.id });
          occupants.set(normRef(npc.name), { actorId: actor.id });
        } catch (e) {
          failed++;
          warn(`NPC "${npc.name}" failed; skipping`, e);
          this.#status(`⚠ NPC "${npc.name}" failed (${e.message}) — skipped. See AI Call Inspector.`);
        }
      }

      i = 0;
      let reused = 0;
      for (const mon of converted.monsters) {
        i++;
        try {
          const existing = monsterIndex.find(mon.name);
          if (existing && !this.#isUnique(mon)) {
            reused++;
            const doc = await fromUuid(existing.uuid);
            const actor = existing.source === "world" ? doc : await game.actors.importFromCompendium(game.packs.get(existing.source), doc.id);
            if (actor?.id) occupants.set(normRef(mon.name), { actorId: actor.id });
            this.#status(`Reusing existing monster: ${mon.name} (${existing.source})`, 0.60 + 0.12 * (i / converted.monsters.length));
            continue;
          }
          this.#status(`Creating monster ${i}/${converted.monsters.length}: ${mon.name}`, 0.60 + 0.12 * (i / converted.monsters.length));
          const actor = await builder.buildActor(mon, { folderId: folders.monsters.id });
          if (!actor?.id) throw new Error("Actor.create returned no document");
          monsterIndex.register(mon.name, actor.uuid);
          occupants.set(normRef(mon.name), { actorId: actor.id });
        } catch (e) {
          failed++;
          warn(`Monster "${mon.name}" failed; skipping`, e);
          this.#status(`⚠ Monster "${mon.name}" failed (${e.message}) — skipped. See AI Call Inspector.`);
        }
      }
      this.#status(`Actors done (${converted.npcs.length} NPCs, ${converted.monsters.length - reused} new monsters, ${reused} reused${failed ? `, ${failed} skipped` : ""}).`, 0.72);

      // ---------- 5. Scenes ----------
      // Identify what each candidate map plate actually depicts (vision pass)
      // so plates printed far from their keyed text — covers, appendices —
      // match by title/key evidence rather than page proximity.
      let plates = [];
      try {
        plates = await identifyMapPlates(pageImages, { onProgress: (m) => this.#status(m) });
        this.#status(`Identified ${plates.length} map plate(s): ${plates.map((p) => `p${p.page}${p.title ? ` "${p.title}"` : ""}`).join(", ") || "none"}`);
      } catch (e) {
        warn("Plate identification unavailable (text-only LLM?); falling back to page proximity", e);
      }

      const sceneBuilder = new SceneBuilder();
      const sceneByMap = new Map();
      const encounterIndex = []; // {parentMap, terrain, scene}
      const mapGroups = this.#groupLocations(extracted, pages, pageImages, plates);
      let s = 0;
      for (const grp of mapGroups) {
        s++;
        this.#status(`Building scene ${s}/${mapGroups.length}: ${grp.name}`, 0.72 + 0.2 * (s / mapGroups.length));
        try {
          const scene = await sceneBuilder.buildScene(grp, occupants, { onProgress: (m) => this.#status(m) });
          sceneByMap.set(grp.name, scene);
          // Wilderness hex map → tactical "zoom-in" encounter maps per terrain.
          if (scene.flags?.["acks-classic-importer"]?.hex) {
            const layout = scene.flags["acks-classic-importer"].layout;
            const encs = await sceneBuilder.buildEncounterScenes(grp, layout, {
              folderId: folders.encounterScenes.id,
              onProgress: (m) => this.#status(m)
            });
            for (const e of encs) encounterIndex.push({ parentMap: grp.name, ...e });
          }
        } catch (e) {
          warn(`Scene failed for ${grp.name}`, e);
          this.#status(`⚠ Scene failed for ${grp.name}: ${e.message}`);
        }
      }

      // GM quick-reference: terrain → encounter scene links, next to the
      // random-encounter tables it will be used with.
      if (encounterIndex.length) {
        const byTerrain = new Map();
        for (const e of encounterIndex) {
          if (!byTerrain.has(e.terrain)) byTerrain.set(e.terrain, []);
          byTerrain.get(e.terrain).push(e);
        }
        const rows = [...byTerrain.entries()].map(([terrain, list]) =>
          `<tr><th>${terrain}</th><td>${list.map((e) => `@UUID[Scene.${e.scene.id}]{${e.scene.name}}`).join(" &nbsp; ")}</td></tr>`
        ).join("");
        await JournalEntry.create({
          name: `Wilderness Encounters — ${moduleName}`,
          folder: folders.journals.id,
          pages: [{
            name: "Tactical maps by terrain",
            type: "text",
            text: {
              format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
              content: `<p>When a random encounter fires on the wilderness map, activate the matching terrain scene below and drop the rolled monsters in. Tree clusters limit sight but not movement; boulders and outcrops block both; cliff lines block movement only.</p><table>${rows}</table>`
            }
          }]
        });
        this.#status(`Created ${encounterIndex.length} tactical encounter map(s) across ${byTerrain.size} terrain type(s).`);
      }

      // ---------- 6. Journals & tables ----------
      this.#status("Creating journals and roll tables…", 0.95);
      await buildJournals(extracted, sceneByMap, folders.journals.id);
      await buildRollTables(extracted, folders.tables.id);

      this.state.stage = "done";
      this.#status(`Import complete: ${moduleName}. Review actors and scenes in their "${moduleName}" folders.`, 1);
      ui.notifications.info("ACKS import complete.");
    } catch (e) {
      if (e instanceof PipelineAbortError) {
        this.state.stage = "stopped";
        this.#status("Pipeline stopped by user. Documents created before the stop remain in the world; use the AI Call Inspector to review what was sent.");
        ui.notifications.info("Import stopped. Partial results were kept.");
        return;
      }
      console.error(e);
      this.state.stage = "error";
      this.#status(`Import failed: ${e.message}`);
      ui.notifications.error(`Import failed: ${e.message}`);
    }
  }

  #isUnique(mon) {
    return (mon.conversionNotes ?? []).some((n) => n.includes("New/unique"));
  }

  /** Group keyed locations by parent map; attach plates by evidence. */
  #groupLocations(extracted, pages, pageImages, plates = []) {
    const groups = new Map();
    for (const loc of extracted.locations ?? []) {
      const name = loc.parentMap ?? "Keyed Locations";
      if (!groups.has(name)) groups.set(name, { name, locations: [], pagesUsed: new Set() });
      const g = groups.get(name);
      g.locations.push(loc);
      for (const p of loc.sourcePages ?? []) g.pagesUsed.add(p);
    }
    const out = [];
    for (const g of groups.values()) {
      const pageNums = [...g.pagesUsed].sort((a, b) => a - b);
      g.sourceText = pages.filter((p) => pageNums.includes(p.page)).map((p) => p.text).join("\n\n");
      out.push(g);
    }

    if (plates.length) {
      // Evidence-based assignment, best matches first, each plate used once.
      const claimed = new Set();
      const scored = out
        .map((g) => ({ g, m: matchPlate(g, plates, claimed) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m.score - a.m.score);
      for (const { g, m } of scored) {
        if (claimed.has(m.plate.page)) {
          const re = matchPlate(g, plates, claimed); // re-match minus claimed plates
          if (re) { g.mapPlateDataUrl = re.plate.dataUrl; g.plateMeta = re.plate; claimed.add(re.plate.page); }
          continue;
        }
        g.mapPlateDataUrl = m.plate.dataUrl;
        g.plateMeta = m.plate;
        claimed.add(m.plate.page);
      }
    } else {
      // Fallback (text-only LLM): conservative page proximity.
      for (const g of out) {
        const pageNums = [...g.pagesUsed].sort((a, b) => a - b);
        const mapHint = (extracted.maps ?? []).find((m) => m.name === g.name)?.pageGuess;
        let plate = pageImages.find((p) => p.page === mapHint && p.isLikelyMap) ?? null;
        if (!plate) {
          const nearest = pageImages.filter((p) => p.isLikelyMap)
            .sort((a, b) => dist(a.page, pageNums) - dist(b.page, pageNums))[0];
          if (nearest && dist(nearest.page, pageNums) <= 3) plate = nearest;
        }
        g.mapPlateDataUrl = plate?.dataUrl ?? null;
      }
    }
    for (const g of out) g.describedOnly = !g.mapPlateDataUrl;
    return out;

    function dist(page, nums) {
      return Math.min(...nums.map((n) => Math.abs(n - page)), 999);
    }
  }

  async #folders(moduleName) {
    const mk = async (name, type) =>
      game.folders.find((f) => f.name === name && f.type === type) ??
      Folder.create({ name, type });
    return {
      npcs: await mk(`${moduleName} — NPCs`, "Actor"),
      monsters: await mk(`${moduleName} — Monsters`, "Actor"),
      journals: await mk(`${moduleName}`, "JournalEntry"),
      tables: await mk(`${moduleName}`, "RollTable"),
      encounterScenes: await mk(`${moduleName} — Encounter Maps`, "Scene")
    };
  }

  /** Review checkpoint: show editable JSON, let the GM correct before continuing. */
  async #review(title, data) {
    if (!getSetting("reviewBeforeCreate")) return data;
    return new Promise((resolve) => {
      const json = JSON.stringify(data, null, 2);
      new Dialog({
        title: `Review: ${title}`,
        content: `<p>Edit if needed, then continue. (Cancel keeps the data unchanged.)</p>
                  <textarea class="aci-review" style="width:100%;height:420px;font-family:monospace;">${json.replace(/</g, "&lt;")}</textarea>`,
        buttons: {
          ok: {
            label: "Continue",
            callback: (html) => {
              try { resolve(JSON.parse(html.find("textarea").val())); }
              catch (_e) { ui.notifications.warn("Invalid JSON — using original data."); resolve(data); }
            }
          },
          skip: { label: "Continue unchanged", callback: () => resolve(data) }
        },
        default: "ok",
        close: () => resolve(data)
      }, { width: 760 }).render(true);
    });
  }
}

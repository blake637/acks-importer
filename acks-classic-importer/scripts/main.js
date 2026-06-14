/**
 * ACKS Classic Module Importer — main entry point.
 *
 * Pipeline overview:
 *   PDF → text + page images → LLM structure extraction → AD&D/Basic → ACKS
 *   conversion → Foundry documents (Actors, Scenes w/ walls+lights, Journals,
 *   RollTables) → token & map art via image-generation API.
 *
 * UI entry points (any of these opens the importer):
 *   1. "Import Classic Module" button in the Actors sidebar header
 *   2. Settings → Configure Settings → module section → "Import Classic Module"
 *   3. Macro/console: game.modules.get("acks-classic-importer").api.open()
 */

import { registerSettings, MODULE_ID } from "./settings.js";
import { ImporterApp } from "./apps/importer-app.js";
import { log, warn } from "./util/logger.js";

Hooks.once("init", () => {
  registerSettings();

  // Settings-menu launcher (works on every Foundry version regardless of
  // sidebar DOM changes).
  game.settings.registerMenu(MODULE_ID, "openImporter", {
    name: "Classic Module Importer",
    label: "Import Classic Module",
    hint: "Open the PDF importer (also available from the Actors sidebar).",
    icon: "fas fa-scroll",
    type: ImporterApp,
    restricted: true
  });

  log("Initialized");
});

Hooks.once("ready", () => {
  // Macro/console API.
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { open: () => new ImporterApp().render(true) };

  if (game.system.id !== "acks") {
    ui.notifications.warn(
      "ACKS Classic Importer: active system is not 'acks'. Imported actors will use a generic data layout and may need manual mapping."
    );
  }
});

/**
 * Add a launch button to the Actors directory header (GM only).
 *
 * Compatibility note: on Foundry v11/v12 this hook receives a jQuery object;
 * on v13+ (ApplicationV2 sidebar) it receives a native HTMLElement. We
 * normalize to a DOM node and walk a selector fallback chain because the
 * header structure has shifted between versions.
 */
Hooks.on("renderActorDirectory", (app, html) => {
  try {
    if (!game.user.isGM) return;
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html?.get?.(0));
    if (!root?.querySelector) return;

    // The sidebar re-renders often; don't stack duplicate buttons.
    if (root.querySelector(".acks-importer-launch")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "acks-importer-launch";
    btn.innerHTML = `<i class="fas fa-scroll"></i> Import Classic Module`;
    btn.addEventListener("click", () => new ImporterApp().render(true));

    const target =
      root.querySelector(".header-actions.action-buttons") ??    // v11/v12
      root.querySelector(".directory-header .header-actions") ?? // v12 variants
      root.querySelector("header.directory-header") ??           // v13 header
      root.querySelector(".directory-header") ??
      root;                                                      // last resort: top of tab
    target.append(btn);
  } catch (e) {
    warn("Could not add sidebar button; use Settings → Import Classic Module instead.", e);
  }
});

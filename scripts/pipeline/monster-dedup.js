/**
 * Monster deduplication.
 *
 * Before creating a monster actor, we check (in order):
 *   1. World actors
 *   2. The module's own "imported-monsters" pack
 *   3. Any compendium packs listed in settings (e.g. an ACKS bestiary)
 *
 * Matching is by normalized name with a small alias table for spelling
 * variants between editions. Unique/new monsters (module appendices) always
 * skip the bestiary check by name *variant* but still de-duplicate against
 * prior imports of the same module.
 */

import { getSetting } from "../settings.js";
import { MODULE_ID } from "../settings.js";
import { log } from "../util/logger.js";

const ALIASES = {
  "giant rat": ["rat, giant", "rats, giant"],
  "giant constrictor snake": ["snake, giant constrictor"],
  "giant poisonous snake": ["snake, giant poisonous", "poisonous viper", "viper, poisonous"],
  "giant spider": ["spider, giant"],
  "giant centipede": ["centipede, giant"],
  "giant bombardier beetle": ["beetle, giant, bombardier"],
  "giant worker ant": ["ant, giant, worker"],
  "carnivorous ape": ["ape, carnivorous"],
  "gray ooze": ["grey ooze"],
  "dire wolf": ["wolf, dire", "dire wolves"],
  "worg": ["worgs"],
  "wolf": ["wolves"],
  "skeleton": ["skeletons", "normal skeleton"],
  "zombie": ["zombies", "normal zombie"]
};

function normalize(name) {
  let n = String(name ?? "").toLowerCase().trim()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z, ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // singularize crude plurals
  n = n.replace(/ies$/, "y").replace(/([^s])s$/, "$1");
  // canonicalize "X, giant" → "giant x"
  const parts = n.split(",").map((p) => p.trim());
  if (parts.length > 1) n = [...parts.slice(1).reverse(), parts[0]].join(" ");
  for (const [canon, vars] of Object.entries(ALIASES)) {
    if (n === canon || vars.includes(n)) return canon;
  }
  return n;
}

export class MonsterIndex {
  async build() {
    this.index = new Map(); // normName → {source, ref}
    for (const a of game.actors) {
      if (a.type === "monster" || a.type === "npc") this.index.set(normalize(a.name), { source: "world", uuid: a.uuid, name: a.name });
    }
    const packIds = [`${MODULE_ID}.imported-monsters`,
      ...getSetting("monsterCompendiums").split(",").map((s) => s.trim()).filter(Boolean)];
    for (const pid of packIds) {
      const pack = game.packs.get(pid);
      if (!pack) continue;
      const idx = await pack.getIndex();
      for (const e of idx) {
        const k = normalize(e.name);
        if (!this.index.has(k)) this.index.set(k, { source: pid, uuid: e.uuid, name: e.name });
      }
    }
    log(`Monster index built: ${this.index.size} entries`);
    return this;
  }

  /** @returns {{source,uuid,name}|null} */
  find(name) {
    return this.index.get(normalize(name)) ?? null;
  }

  register(name, uuid) {
    this.index.set(normalize(name), { source: "world", uuid, name });
  }
}

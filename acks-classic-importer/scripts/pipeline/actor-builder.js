/**
 * Actor builder for the ACKS system.
 *
 * The ACKS Foundry system stores most monster/character mechanics under
 * `system.*`. Because field paths have shifted between system releases, all
 * path assignments funnel through SYSTEM_PATHS below — if your ACKS build
 * differs, this is the one place to adjust. Anything we can't place safely
 * lands in the actor biography as a formatted stat block, so no extracted
 * data is ever silently dropped.
 */

import { ImageClient, letterToken, uploadDataUrl } from "./image-client.js";
import { classifyGear, buildItemData, parseCoins, ItemIndex } from "./item-builder.js";
import { getSetting } from "../settings.js";
import { warn } from "../util/logger.js";

const SYSTEM_PATHS = {
  ac:        "system.aac.value",          // ACKS system uses ascending AC ("aac")
  hpValue:   "system.hp.value",
  hpMax:     "system.hp.max",
  hdRaw:     "system.hp.hd",
  move:      "system.movement.base",
  alignment: "system.details.alignment",
  morale:    "system.details.morale",
  xp:        "system.details.xp",
  level:     "system.details.level",
  className: "system.details.class",
  saveDeath:     "system.saves.death.value",
  saveWand:      "system.saves.wand.value",
  saveParalysis: "system.saves.paralysis.value",
  saveBreath:    "system.saves.breath.value",
  saveSpell:     "system.saves.spell.value",
  coinPP:    "system.currency.pp",
  coinGP:    "system.currency.gp",
  coinEP:    "system.currency.ep",
  coinSP:    "system.currency.sp",
  coinCP:    "system.currency.cp",
  bio:       "system.details.biography"
};

const ABILITY_PATH = (k) => `system.scores.${k}.value`;

export class ActorBuilder {
  constructor() {
    this.img = new ImageClient();
    this.makeArt = getSetting("generateTokenArt") && this.img.enabled;
  }

  async buildActor(entity, { folderId = null } = {}) {
    const a = entity.acks;
    const isMonster = entity.type === "monster";
    const data = {
      name: entity.name,
      type: game.system.id === "acks" ? (isMonster ? "monster" : "character") : "npc",
      folder: folderId,
      flags: { "acks-classic-importer": { sourcePages: entity.sourcePages, conversionNotes: entity.conversionNotes } }
    };

    // ---- portrait/token art ----
    let imgPath = null;
    try {
      if (this.makeArt) {
        const prompt = this.#artPrompt(entity);
        const dataUrl = await this.img.generate(prompt, { width: 1024, height: 1024, label: `Token art — ${entity.name}` });
        imgPath = await uploadDataUrl(dataUrl, `token-${slug(entity.name)}.png`);
      }
    } catch (e) { warn(`Token art failed for ${entity.name}; falling back to letter token`, e); }
    if (!imgPath) {
      // Fallback upload is itself guarded: a broken upload path must not stop
      // actor creation. Worst case the actor is created with the system's
      // default icon and the GM can set art later.
      try {
        imgPath = await uploadDataUrl(letterToken(entity.name, entity.type), `token-${slug(entity.name)}.png`);
      } catch (e) {
        warn(`Letter-token upload failed for ${entity.name}; creating actor with default icon`, e);
        imgPath = null;
      }
    }
    if (imgPath) data.img = imgPath;
    data.prototypeToken = {
      ...(imgPath ? { texture: { src: imgPath } } : {}),
      name: entity.name,
      displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
      displayBars: CONST.TOKEN_DISPLAY_MODES.OWNER,
      bar1: { attribute: "hp" },
      disposition: isMonster ? CONST.TOKEN_DISPOSITIONS.HOSTILE : CONST.TOKEN_DISPOSITIONS.NEUTRAL
    };

    // ---- mechanical fields via safe set ----
    const upd = {};
    const set = (path, v) => { if (v !== null && v !== undefined) foundry.utils.setProperty(upd, path, v); };
    set(SYSTEM_PATHS.ac, a.ac);
    const hp = a.hp ?? a.hpList?.[0] ?? null;
    set(SYSTEM_PATHS.hpValue, hp);
    set(SYSTEM_PATHS.hpMax, hp);
    set(SYSTEM_PATHS.hdRaw, a.hd ?? null);
    set(SYSTEM_PATHS.move, a.move);
    set(SYSTEM_PATHS.alignment, a.alignment);
    set(SYSTEM_PATHS.morale, a.morale);
    set(SYSTEM_PATHS.xp, a.xp);
    set(SYSTEM_PATHS.level, a.level);
    set(SYSTEM_PATHS.className, a.class);
    if (a.saves) {
      set(SYSTEM_PATHS.saveDeath, a.saves.death);
      set(SYSTEM_PATHS.saveWand, a.saves.wand);
      set(SYSTEM_PATHS.saveParalysis, a.saves.paralysis);
      set(SYSTEM_PATHS.saveBreath, a.saves.breath);
      set(SYSTEM_PATHS.saveSpell, a.saves.spell);
    }
    for (const [k, v] of Object.entries(a.abilities ?? {})) set(ABILITY_PATH(k), v);

    // ---- carried coinage (rolled from dice-range notation in the source) ----
    const purse = parseCoins(a.treasure);
    if (purse) {
      set(SYSTEM_PATHS.coinPP, purse.coins.pp);
      set(SYSTEM_PATHS.coinGP, purse.coins.gp);
      set(SYSTEM_PATHS.coinEP, purse.coins.ep);
      set(SYSTEM_PATHS.coinSP, purse.coins.sp);
      set(SYSTEM_PATHS.coinCP, purse.coins.cp);
      entity.conversionNotes = [...(entity.conversionNotes ?? []), `Carried coin rolled from source: ${purse.formula}`];
    }

    set(SYSTEM_PATHS.bio, this.#biography(entity, purse));
    foundry.utils.mergeObject(data, upd);

    const actor = await Actor.create(data);

    // ---- embedded items: typed gear, natural attacks, spells ----
    const items = [];

    // Gear: classify, dedup against item compendia, build typed item data.
    const gearStrings = [
      ...(a.equipment ?? []).map((g) => ({ raw: g, magicHint: false })),
      ...(a.magicItems ?? []).map((g) => ({ raw: g, magicHint: true }))
    ];
    let bestArmorEquipped = false, shieldEquipped = false, firstWeapon = null;
    for (const { raw, magicHint } of gearStrings) {
      const gear = classifyGear(raw, { isMagicHint: magicHint });

      // Compendium hit? Link it, then merge our parsed bonus/charges on top.
      const fromPack = await this.itemIndex?.find(
        gear.bonus ? `${gear.base} ${gear.bonus > 0 ? "+" : ""}${gear.bonus}` : gear.base
      );
      if (fromPack) {
        const merged = foundry.utils.mergeObject(fromPack, buildItemData(gear).data, { insertKeys: true, overwrite: false });
        items.push(merged);
      } else {
        const { data: itemData } = buildItemData(gear, {
          equipped: gear.kind === "armor" ? !bestArmorEquipped
                  : gear.kind === "shield" ? !shieldEquipped
                  : gear.kind === "weapon" ? firstWeapon === null
                  : false
        });
        items.push(itemData);
      }
      if (gear.kind === "armor") bestArmorEquipped = true;
      if (gear.kind === "shield") shieldEquipped = true;
      if (gear.kind === "weapon" && firstWeapon === null) firstWeapon = gear;
    }

    // Monsters (and gearless NPCs) still need their stat-block attack line.
    const hasWeapon = items.some((it) => it.type === "weapon");
    if (a.damage && (isMonster || !hasWeapon)) {
      items.push({
        name: isMonster ? "Natural Attack" : "Attack",
        type: "weapon",
        system: { damage: a.damage, description: a.attacks ? `Attacks/round: ${a.attacks}` : "" }
      });
    }

    if (a.spells) {
      for (const [lvl, list] of Object.entries(a.spells)) {
        for (const sp of list) items.push({ name: sp, type: "spell", system: { lvl: Number(lvl) } });
      }
    }
    if (items.length) {
      try { await actor.createEmbeddedDocuments("Item", items); }
      catch (e) { warn(`Embedded items failed for ${entity.name} (system schema mismatch); data preserved in biography.`, e); }
    }
    return actor;
  }

  /** Call once per import run so compendium item indexes are shared. */
  async prepare() {
    this.itemIndex = await new ItemIndex().build();
    return this;
  }

  #artPrompt(entity) {
    const a = entity.acks;
    const desc = [a.description, a.behavior].filter(Boolean).join(". ");
    if (entity.type === "monster") {
      return `Fantasy RPG monster token portrait, top-lit, painterly, dark neutral background, centered bust: ${entity.name}. ${desc || ""} Old-school dungeon crawl aesthetic, no text, no border.`;
    }
    const cls = [a.race, a.class, a.level ? `level ${a.level}` : null].filter(Boolean).join(" ");
    return `Fantasy RPG character token portrait, painterly, parchment-toned background, centered bust: ${entity.name}, a ${cls || "villager"}. ${desc || ""} Carrying: ${(a.equipment ?? []).slice(0, 3).join(", ")}. No text, no border.`;
  }

  #biography(entity, purse = null) {
    const a = entity.acks;
    const rows = [];
    const row = (k, v) => { if (v !== null && v !== undefined && v !== "") rows.push(`<tr><th>${k}</th><td>${v}</td></tr>`); };
    row("AC (ACKS, ascending)", a.ac);
    row("HD", a.hd); row("HP roster", a.hpList?.join(", "));
    row("Move", a.move);
    row("Attacks", a.attacks); row("Damage", a.damage);
    row("Attack Throw", a.attackThrow !== undefined && a.attackThrow !== null ? `${a.attackThrow}+` : null);
    row("Morale", a.morale); row("Alignment", a.alignment); row("XP", a.xp);
    row("Special Attacks", a.specialAttacks); row("Special Defenses", a.specialDefenses);
    row("Treasure", purse ? `${purse.raw} → rolled: ${Object.entries(purse.coins).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}` : a.treasure);
    row("Class/Level", a.class ? `${a.class} ${a.level ?? ""}` : null);
    row("Secondary class", a.secondaryClass ? `${a.secondaryClass.class} ${a.secondaryClass.level}` : null);
    const notes = (entity.conversionNotes ?? []).map((n) => `<li>${n}</li>`).join("");
    return `
      <p>${a.description ?? ""}</p>
      <p><em>${a.behavior ?? ""}</em></p>
      <table>${rows.join("")}</table>
      ${notes ? `<h3>Conversion notes</h3><ul>${notes}</ul>` : ""}
      <p><small>Imported from pages ${entity.sourcePages?.join(", ") || "?"} by ACKS Classic Importer.</small></p>`;
  }
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

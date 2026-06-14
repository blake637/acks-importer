/**
 * Item builder.
 *
 * Turns the raw gear strings extracted from stat blocks ("chain mail +2",
 * "wand of fear with 5 charges left", "ring of protection +1", "longbow",
 * "potion of extra healing") into properly typed ACKS Item documents:
 *
 *   1. classifyGear()  — deterministic regex classification into kind
 *                        (armor/shield/weapon/wand/staff/ring/potion/scroll/
 *                        ammo/misc), with parsed magic bonus and charges.
 *   2. convertMagicItem() — AD&D→ACKS magic-item mapping with review notes
 *                        for items that have no clean ACKS equivalent.
 *   3. ItemIndex       — dedup lookup against configured item compendia, so
 *                        a "Sword +1" already in your ACKS gear pack is
 *                        linked rather than re-created.
 *   4. parseCoins()    — rolls dice-range coinage ("2-8 pp", "3-30 ep") into
 *                        concrete amounts for the actor's currency fields,
 *                        preserving the original formula in a note.
 *
 * Like the actor builder, all system data paths go through ITEM_PATHS so a
 * differing ACKS system version is a one-object fix.
 */

import { getSetting } from "../settings.js";
import { warn } from "../util/logger.js";

export const ITEM_PATHS = {
  weaponDamage: "system.damage",
  armorAC:      "system.aac.value",   // ascending AC bonus of the armor piece
  armorType:    "system.type",        // light/heavy/shield where supported
  bonus:        "system.bonus",       // generic magic bonus if the schema has one
  charges:      "system.charges.value",
  chargesMax:   "system.charges.max",
  equipped:     "system.equipped",
  description:  "system.description",
  cost:         "system.cost",
  weight:       "system.weight"
};

/* ---------- base-item knowledge (ACKS values) ---------- */
// Ascending AC bonus granted by armor in ACKS (leather 2, chain 4, plate 6, shield +1).
const ARMOR_TABLE = {
  "padded": 1, "leather": 2, "studded leather": 3, "ring mail": 3,
  "scale": 4, "scale mail": 4, "chain": 4, "chain mail": 4, "chainmail": 4,
  "splint": 5, "splint mail": 5, "banded": 5, "banded mail": 5,
  "plate": 6, "plate mail": 6, "plate armor": 6
};
const WEAPON_DAMAGE = {
  "dagger": "1d4", "dart": "1d3", "club": "1d4", "staff": "1d6", "quarterstaff": "1d6",
  "sling": "1d4", "short sword": "1d6", "shortsword": "1d6", "hand axe": "1d6",
  "mace": "1d6", "flail": "1d6", "morning star": "1d6", "war hammer": "1d6", "hammer": "1d6",
  "spear": "1d6", "javelin": "1d6", "short bow": "1d6", "shortbow": "1d6",
  "long bow": "1d6", "longbow": "1d6", "light crossbow": "1d6", "lt. crossbow": "1d6",
  "heavy crossbow": "1d8", "crossbow": "1d6",
  "sword": "1d6", "longsword": "1d6", "long sword": "1d6", "broadsword": "1d6", "broad sword": "1d6",
  "battleaxe": "1d6", "battle axe": "1d6", "scimitar": "1d6", "trident": "1d6",
  "two-handed sword": "1d10", "two handed sword": "1d10", "halberd": "1d10",
  "pole axe": "1d10", "lance": "1d6", "whip": "1d2", "net": "0"
};

/* ---------- AD&D → ACKS magic-item notes ---------- */
// Items that exist in ACKS map silently; the rest get review notes. Matching
// is by lowercase substring against the base name (bonus already stripped).
const MAGIC_ITEM_MAP = [
  // Specific named weapon powers MUST precede the generic plain-weapon rule:
  // this is a first-match table, and "flame tongue" also contains a weapon
  // noun, so a generic /^sword/ rule placed first would swallow it.
  [/flame tongue|frost ?brand/, "Named AD&D sword power — ACKS has no direct equivalent; treat as Sword +1 with a flaming special ability (review)."],
  [/of speed/, "Weapon/item of speed — approximate with ACKS initiative bonus; review."],
  [/of venom/, "Dagger of venom — model as +1 dagger with poison charges; review vs. ACKS poison rules."],
  [/of seeking/, "Sling/weapon of seeking — approximate as +2 to attack throws; review."],
  [/of (wounding|sharpness|life ?stealing|dancing|defending)/, "Named AD&D weapon power — no direct ACKS equivalent; treat as +1 base weapon plus the named special ability (review)."],
  // Generic plain +N weapons map directly.
  [/^(sword|long ?sword|short ?sword|broad ?sword|battle ?axe|mace|flail|dagger|spear|hammer|quarter ?staff|bow|crossbow|arrow|bolt|sling)\b/, null],
  [/ring of protection/, null],
  [/ring of free action|ring of spell turning|ring of spell storing|ring of djinni|ring of elemental command|ring of feather fall|ring of invisibility|ring of shocking grasp/, "AD&D ring — check ACKS treasure tables for the analogue; effects kept as written pending review."],
  [/bracers of defense/, "Bracers of defense — ACKS analogue is Bracers of Armor; AC recomputed on the ascending scale (review)."],
  [/cloak of protection|amulet of protection/, null],
  [/boots of elvenkind|cloak of elvenkind/, "Elvenkind gear — keep stealth bonus; map to ACKS Move Silently/Hide bonuses (review)."],
  [/boots of levitation|boots of speed|boots of striding/, "AD&D boots — keep effect as written; review vs. ACKS item lists."],
  [/girdle of (ogre|giant)/, "Girdle of giant strength — apply ACKS strength-bonus item rules; review the +hit/+damage numbers."],
  [/horn of valhalla/, "Horn of Valhalla — summoned warriors converted as 2 HD fighters with ACKS saves; review alignment restriction."],
  [/incense of meditation|amulet of inescapable location|brooch of shielding|beaker of (plentiful|multiple) potions|net of entrapment|crystal ball|libram|deck of many things|medallion/, "AD&D wondrous item — no core ACKS equivalent; effect preserved in description for GM adjudication (review)."],
  [/staff of striking|wand of (fear|magic missiles?|lightning|enemy detection)|staff of/, "Wand/staff — charges tracked; verify spell effect against the ACKS arcane list (review)."],
  [/potion of/, null],   // ACKS has a close potion list
  [/scroll/, null],
  [/horseshoes|medallion of esp/, "Review vs. ACKS item lists."]
];

/* ---------- classification ---------- */
export function classifyGear(raw, { isMagicHint = false } = {}) {
  const original = String(raw ?? "").trim();
  let s = original.toLowerCase()
    .replace(/\(magic\)$/, "")
    .replace(/\s+/g, " ")
    .trim();

  // magic bonus: "+2", "+1/+3 vs ...", "+1 to hit"
  let bonus = 0, bonusNote = null;
  const bm = s.match(/([+-]\d)(?:\s*\/\s*[+-]\d[^,]*)?/);
  if (bm) {
    bonus = parseInt(bm[1], 10);
    if (/\//.test(bm[0])) bonusNote = `Conditional bonus: "${bm[0]}" — kept in description.`;
  }

  // charges: "with 5 charges left", "(34 charges)", "11 charges"
  let charges = null;
  const cm = s.match(/(\d+)\s*charges?/);
  if (cm) charges = parseInt(cm[1], 10);

  const base = s
    .replace(/[+-]\d(\s*\/\s*[+-]\d[^,]*)?/g, "")
    .replace(/\(?\s*\d+\s*charges?\s*(left|remaining)?\s*\)?/g, "")
    .replace(/\bwith\b\s*$/,"")
    .replace(/\s+/g, " ").trim();

  let kind = "misc";
  if (/^shield/.test(base) || / shield$/.test(base)) kind = "shield";
  else if (Object.keys(ARMOR_TABLE).some((a) => base.includes(a)) && /(mail|armor|plate|leather|scale|banded|splint|padded|barding)/.test(base)) kind = "armor";
  else if (/^potion|potion of/.test(base)) kind = "potion";
  else if (/^scroll|scroll of/.test(base)) kind = "scroll";
  else if (/^wand/.test(base)) kind = "wand";
  else if (/^staff|^stave/.test(base) && /of /.test(base)) kind = "staff";
  else if (/^ring/.test(base)) kind = "ring";
  else if (/^(arrow|bolt|dart)s?\b/.test(base)) kind = "ammo";
  else if (Object.keys(WEAPON_DAMAGE).some((w) => base === w || base.startsWith(w + " ") || base.endsWith(" " + w))) kind = "weapon";
  else if (/sword|axe|bow|mace|flail|spear|dagger|hammer|halberd|trident|sling|club|whip|net/.test(base)) kind = "weapon";

  const isMagic = isMagicHint || bonus !== 0 || charges !== null ||
    ["potion", "scroll", "wand", "staff", "ring"].includes(kind) || / of /.test(base);

  return { original, base, kind, bonus, bonusNote, charges, isMagic };
}

export function convertMagicItem(gear) {
  if (!gear.isMagic) return { notes: [] };
  for (const [re, note] of MAGIC_ITEM_MAP) {
    if (re.test(gear.base)) return { notes: note ? [note] : [] };
  }
  return { notes: [`Magic item '${gear.original}' has no mapping entry — review against ACKS treasure tables.`] };
}

/* ---------- Foundry item data ---------- */
export function buildItemData(gear, { equipped = false } = {}) {
  const conv = convertMagicItem(gear);
  const notes = [...conv.notes];
  if (gear.bonusNote) notes.push(gear.bonusNote);

  const name = gear.bonus
    ? `${titleCase(gear.base)} ${gear.bonus > 0 ? "+" : ""}${gear.bonus}`
    : titleCase(gear.base || gear.original);

  // ACKS item types: weapon, armor, item, spell (and ability). Shields ride
  // the armor type; consumables/wondrous fall back to "item".
  const type = gear.kind === "weapon" || gear.kind === "ammo" ? "weapon"
             : gear.kind === "armor" || gear.kind === "shield" ? "armor"
             : "item";

  const data = { name, type, system: {} };
  const set = (path, v) => { if (v !== null && v !== undefined) foundry.utils.setProperty(data, path, v); };

  if (type === "weapon") {
    const dmgKey = Object.keys(WEAPON_DAMAGE).find((w) => gear.base.includes(w));
    let dmg = dmgKey ? WEAPON_DAMAGE[dmgKey] : "1d6";
    if (gear.bonus) dmg += `${gear.bonus > 0 ? "+" : ""}${gear.bonus}`;
    set(ITEM_PATHS.weaponDamage, dmg);
    set(ITEM_PATHS.bonus, gear.bonus || undefined);
  }
  if (type === "armor") {
    const armorKey = Object.keys(ARMOR_TABLE).find((a) => gear.base.includes(a));
    const baseAC = gear.kind === "shield" ? 1 : (armorKey ? ARMOR_TABLE[armorKey] : 0);
    set(ITEM_PATHS.armorAC, baseAC + Math.max(0, gear.bonus));
    set(ITEM_PATHS.armorType, gear.kind === "shield" ? "shield" : undefined);
  }
  if (gear.charges !== null) {
    set(ITEM_PATHS.charges, gear.charges);
    set(ITEM_PATHS.chargesMax, gear.charges);
  }
  set(ITEM_PATHS.equipped, equipped);

  const descBits = [
    `<p>Source text: <em>${escapeHtml(gear.original)}</em></p>`,
    gear.charges !== null ? `<p>Charges remaining at import: ${gear.charges}</p>` : "",
    notes.length ? `<ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""
  ].join("");
  set(ITEM_PATHS.description, descBits);

  return { data, notes, isMagic: gear.isMagic };
}

/* ---------- coinage ---------- */
const COIN_KEYS = { pp: "pp", gp: "gp", ep: "ep", sp: "sp", cp: "cp" };
export function parseCoins(str) {
  if (!str) return null;
  const out = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  const formulas = [];
  let matched = false;
  // patterns: "2-8 pp", "2-40 gp", "110 ep", "3-30 s.p.", "50+1-100 sp"
  const re = /(\d+)(?:\s*[-–]\s*(\d+))?\s*(p\.?p\.?|g\.?p\.?|e\.?p\.?|s\.?p\.?|c\.?p\.?)\b/gi;
  let m;
  while ((m = re.exec(str)) !== null) {
    matched = true;
    const lo = parseInt(m[1], 10);
    const hi = m[2] ? parseInt(m[2], 10) : lo;
    const denom = COIN_KEYS[m[3].replace(/\./g, "").toLowerCase()];
    if (!denom) continue;
    const rolled = hi > lo ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo;
    out[denom] += rolled;
    formulas.push(`${m[1]}${m[2] ? "-" + m[2] : ""} ${denom}${hi > lo ? ` (rolled ${rolled})` : ""}`);
  }
  if (!matched) return null;
  return { coins: out, formula: formulas.join(", "), raw: str };
}

/* ---------- compendium dedup ---------- */
export class ItemIndex {
  async build() {
    this.index = new Map();
    const packIds = getSetting("itemCompendiums").split(",").map((s) => s.trim()).filter(Boolean);
    for (const pid of packIds) {
      const pack = game.packs.get(pid);
      if (!pack || pack.documentName !== "Item") { if (pid) warn(`Item pack '${pid}' not found or not an Item pack`); continue; }
      const idx = await pack.getIndex();
      for (const e of idx) {
        const k = normName(e.name);
        if (!this.index.has(k)) this.index.set(k, { pack: pid, id: e._id, name: e.name });
      }
    }
    return this;
  }
  /** Return full item data from a compendium match, or null. */
  async find(name) {
    const hit = this.index?.get(normName(name));
    if (!hit) return null;
    const doc = await game.packs.get(hit.pack).getDocument(hit.id);
    return doc?.toObject() ?? null;
  }
}

function normName(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9+]/g, "");
}
function titleCase(s) { return String(s).replace(/\b\w/g, (c) => c.toUpperCase()); }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

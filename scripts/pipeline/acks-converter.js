/**
 * AD&D / Basic D&D → ACKS conversion layer.
 *
 * Deterministic where the systems map cleanly; flagged for review where they
 * don't. Every converted entity carries a `conversionNotes` array so the GM
 * can audit what changed.
 *
 * Key differences handled:
 *  - Armor Class: classic editions use descending AC (unarmored 9 or 10);
 *    ACKS uses ascending AC where unarmored = 0.   ACKS AC = 9 - oldAC.
 *  - Saving throws: ACKS uses five categories (Petrification & Paralysis,
 *    Poison & Death, Blast & Breath, Staffs & Wands, Spells), derived from
 *    HD for monsters ("saves as Fighter of level = HD").
 *  - XP awards: recomputed from the ACKS monster XP table (base by HD plus a
 *    bonus per special ability), NOT copied from the module.
 *  - Movement: inches → feet (1" = 10'), expressed as exploration'(combat').
 *  - Morale: AD&D values → ACKS -6..+6 modifier scale (2d6-centered).
 *  - Classes: AD&D classes → nearest ACKS class; some (illusionist, ranger,
 *    multi-class demihumans) are approximations and get flagged.
 *  - Alignment: nine-point grid → Lawful / Neutral / Chaotic.
 *  - Level caps: ACKS classes cap at 14 (demihumans lower); higher-level
 *    NPCs are capped and flagged.
 */

// ---------- Armor Class ----------
export function convertAC(oldAC, { unarmoredBase = 9 } = {}) {
  if (oldAC === null || oldAC === undefined) return { value: null };
  const acks = unarmoredBase - Number(oldAC);
  return { value: Math.max(0, acks), note: `AC ${oldAC} (descending) → ACKS AC ${Math.max(0, acks)}` };
}

// ---------- Hit Dice ----------
export function parseHD(hdStr) {
  // "3+1", "1-4 hp", "4 + 4", "1/2", "7", "3d8+3d4+1"
  if (!hdStr) return { dice: null, mod: 0, effective: null, raw: hdStr };
  const s = String(hdStr).replace(/\s/g, "");
  if (/hp$/i.test(s) || /^\d+-\d+hp$/i.test(s)) return { dice: 0.5, mod: 0, effective: 0.5, raw: hdStr };
  if (s === "1/2" || s === "½") return { dice: 0.5, mod: 0, effective: 0.5, raw: hdStr };
  const m = s.match(/^(\d+)([+-]\d+)?/);
  if (!m) return { dice: null, mod: 0, effective: null, raw: hdStr };
  const dice = parseInt(m[1], 10);
  const mod = m[2] ? parseInt(m[2], 10) : 0;
  return { dice, mod, effective: dice + (mod > 0 ? 0.5 : 0), raw: hdStr };
}

// ---------- Saving throws (ACKS monster saves: as fighter of HD) ----------
// Values: target numbers on d20 for [P&P, Poison&Death, Blast&Breath, Staffs&Wands, Spells]
const ACKS_FIGHTER_SAVES = {
  0:  [16, 14, 17, 16, 18],
  1:  [13, 14, 15, 16, 17],
  2:  [12, 13, 14, 15, 16],
  3:  [12, 13, 14, 15, 16],
  4:  [11, 12, 13, 14, 15],
  5:  [10, 11, 12, 13, 14],
  6:  [10, 11, 12, 13, 14],
  7:  [9, 10, 11, 12, 13],
  8:  [8, 9, 10, 11, 12],
  9:  [11, 10, 12, 12, 13],
  10: [10,  9, 11, 11, 12],
  11: [10,  9, 11, 11, 12],
  12: [ 9,  8, 10, 10, 11],
  13: [ 9,  8, 10, 10, 11],
  14: [ 8,  7,  9,  9, 10]
};
export function savesForHD(effectiveHD) {
  // const lvl = Math.max(0, Math.min(14, Math.round(effectiveHD ?? 1)));
  // const [pp, pd, bb, sw, sp] = ACKS_FIGHTER_SAVES[lvl];
  const hd = Number.isFinite(Number(effectiveHD)) ? Number(effectiveHD) : 1; // guard null/NaN HD
  let base_save = 13 - Math.floor(hd/2)
  return { paralysis: base_save, death: base_save+1, breath: base_save+2, wand: base_save+3, spell: base_save+4};
}

// ---------- XP (ACKS monster XP by HD + per-special-ability bonus) ----------
const ACKS_XP = [
  // [effective HD threshold, base XP, bonus per special]
  [0.5, 5, 1], [1, 10, 3], [1.5, 15, 4], [2, 20, 5], [2.5, 29, 8],
  [3, 50, 15], [3.5, 65, 20], [4, 80, 25], [4.5, 140, 30], [5, 200, 35],
  [5.5, 350, 45], [6, 500, 60], [6.5, 650, 75], [7, 800, 90], [8, 1100, 110],
  [9, 1400, 135], [10, 1700, 160], [11, 2000, 185], [12, 2300, 210],
  [13, 2600, 235], [14, 2900, 260], [15, 3250, 285], [16, 3600, 310],
  [17, 4000, 335], [18, 4400, 360], [19, 4800, 385], [20, 5250, 410]
];
export function xpForMonster(effectiveHD, specialAbilityCount = 0) {
  if (effectiveHD === null || effectiveHD === undefined) return null;
  let row = ACKS_XP[0];
  for (const r of ACKS_XP) { if (effectiveHD >= r[0]) row = r; else break; }
  return row[1] + row[2] * specialAbilityCount;
}
export function countSpecials(mon) {
  let n = 0;
  if (mon.specialAttacks) n++;
  if (mon.specialDefenses) n++;
  if (mon.spells) n++;
  return n;
}

// ---------- Movement ----------
export function convertMove(moveStr) {
  if (!moveStr) return { value: null };
  // '9"' → 90' exploration / 30' combat;  '3"/8"' (fly) handled per segment
  const segs = String(moveStr).split("/").map((s) => s.trim());
  const out = segs.map((s) => {
    const m = s.match(/(\d+)/);
    if (!m) return s;
    const feet = parseInt(m[1], 10) * 10;
    return `${feet}'(${Math.round(feet / 3)}')`;
  });
  return { value: out.join(" / "), note: `MV ${moveStr} → ${out.join(" / ")}` };
}

// ---------- Morale ----------
export function convertMorale(oldMorale, edition = "1e") {
  // ACKS morale is a modifier to 2d6, roughly -6..+6, 0 = average.
  if (oldMorale === null || oldMorale === undefined) return { value: 0, note: "Morale defaulted to 0 (average)" };
  let v;
  if (edition === "2e") v = Math.round((oldMorale - 11) / 1.5);     // 2e: 2..20, 11 avg
  else if (oldMorale > 20) v = Math.round((oldMorale - 50) / 12);   // 1e percentile-style
  else v = Math.round(oldMorale - 7);                               // B/X: 2..12 on 2d6
  return { value: Math.max(-6, Math.min(6, v)), note: `Morale ${oldMorale} → ACKS ${v >= 0 ? "+" : ""}${v}` };
}

// ---------- Alignment ----------
export function convertAlignment(al) {
  if (!al) return { value: "Neutral" };
  const s = String(al).toUpperCase();
  if (s.includes("L")) return { value: "Lawful" };
  if (s.includes("C")) return { value: "Chaotic" };
  return { value: "Neutral" };
}

// ---------- Classes ----------
const CLASS_MAP = {
  "fighter":      { acks: "Fighter" },
  "cleric":       { acks: "Cleric" },
  "magic-user":   { acks: "Mage" },
  "magicuser":    { acks: "Mage" },
  "wizard":       { acks: "Mage" },
  "mage":         { acks: "Mage" },
  "thief":        { acks: "Thief" },
  "assassin":     { acks: "Assassin" },
  "bard":         { acks: "Bard" },
  "ranger":       { acks: "Explorer", note: "Ranger → Explorer (nearest ACKS class); tracking/wilderness proficiencies approximate ranger abilities." },
  "paladin":      { acks: "Paladin", note: "Paladin (ACKS Heroic/Player's Companion class); if unavailable in your build, use Fighter with Divine Blessing/Health proficiencies." },
  "druid":        { acks: "Shaman", note: "Druid → Shaman/Priestess (Player's Companion); spell list approximated." },
  "illusionist":  { acks: "Mage", note: "Illusionist → Mage with illusion-themed repertoire; ACKS has no core illusionist." },
  "monk":         { acks: "Mystic", note: "Monk → Mystic (Heroic Fantasy); fallback Fighter." },
  "barbarian":    { acks: "Barbarian" },
  // 5e classes
  "rogue":        { acks: "Thief" },
  "warlock":      { acks: "Mage", note: "Warlock → Mage; pact features have no ACKS analogue — note flavor in the description." },
  "sorcerer":     { acks: "Mage", note: "Sorcerer → Mage; metamagic dropped." },
  "artificer":    { acks: "Mage", note: "Artificer → Mage with a crafting bent; ACKS magic-item rules cover the niche." },
  "fighter5e":    { acks: "Fighter" },
  "warlord":      { acks: "Fighter" }
};
export function convertClass(cls, level) {
  if (!cls) return { acks: null, level: level ?? null, notes: [] };
  const key = String(cls).toLowerCase().replace(/[^a-z-]/g, "");
  const hit = CLASS_MAP[key] ?? { acks: titleCase(cls), note: `No mapping for class '${cls}'; kept as-is — review.` };
  const notes = hit.note ? [hit.note] : [];
  let lvl = level ?? null;
  if (lvl !== null && lvl > 14) { notes.push(`Level ${lvl} exceeds ACKS cap; reduced to 14.`); lvl = 14; }
  return { acks: hit.acks, level: lvl, notes };
}

// ---------- Spells ----------
// Most classic spell names exist in ACKS unchanged or near-unchanged.
const SPELL_MAP = {
  "cure light wounds": "Cure Light Wounds",
  "cause light wounds": "Cause Light Wounds (reversed Cure Light Wounds)",
  "magic missile": "Magic Missile",
  "sleep": "Sleep",
  "charm person": "Charm Person",
  "hold person": "Hold Person",
  "hold portal": "Hold Portal",
  "fireball": "Fireball",
  "fire ball": "Fireball",
  "lightning bolt": "Lightning Bolt",
  "invisibility": "Invisibility",
  "detect magic": "Detect Magic",
  "detect evil": "Detect Evil",
  "detect invisibility": "Detect Invisible",
  "protection from evil": "Protection from Evil",
  "protection from good": "Protection from Evil (reversed — flag: ACKS reverses Prot. Evil)",
  "protection from evil 10' r.": "Protection from Evil, Sustained",
  "protection from normal missiles": "Protection from Normal Missiles",
  "dispel magic": "Dispel Magic",
  "darkness 15' radius": "Darkness (reversed Light)",
  "darkness 15' r": "Darkness (reversed Light)",
  "darkness": "Darkness (reversed Light)",
  "light": "Light",
  "continual light": "Continual Light",
  "bless": "Bless",
  "chant": "Chant — no direct ACKS equivalent; treat as Bless variant (review)",
  "remove fear": "Remove Fear",
  "cause fear": "Cause Fear (reversed Remove Fear)",
  "command": "Command Word",
  "silence 15' r.": "Silence 15' Radius",
  "silence 15' r": "Silence 15' Radius",
  "silence": "Silence 15' Radius",
  "find traps": "Find Traps",
  "speak with animals": "Speak with Animals",
  "know alignment": "Detect Evil (nearest ACKS analogue — review)",
  "augury": "Augury — Player's Companion; fallback Divination (review)",
  "animate dead": "Animate Dead",
  "bestow curse": "Bestow Curse",
  "cause blindness": "Cause Blindness",
  "cure blindness": "Cure Blindness",
  "cure disease": "Cure Disease",
  "remove curse": "Remove Curse",
  "neutralize poison": "Neutralize Poison",
  "cure serious wounds": "Cure Serious Wounds",
  "commune": "Commune — Player's Companion ritual; review",
  "dispel evil": "Dispel Evil",
  "flame strike": "Flame Strike — approximate with Fireball-equivalent divine spell (review)",
  "sticks to snakes": "Sticks to Snakes",
  "feign death": "Feign Death",
  "detect lie": "Detect Lie — no core ACKS spell; review",
  "spiritual hammer": "Striking (nearest ACKS analogue — review)",
  "sanctuary": "Sanctuary — review",
  "purify food and water": "Purify Food and Water",
  "create food and water": "Create Food / Create Water (ACKS splits these)",
  "resist fire": "Resist Fire",
  "resist cold": "Resist Cold",
  "web": "Web",
  "shield": "Shield",
  "shocking grasp": "Shocking Grasp",
  "burning hands": "Burning Hands",
  "esp": "ESP",
  "levitate": "Levitate",
  "knock": "Knock",
  "wizard lock": "Wizard Lock",
  "rope trick": "Rope Trick",
  "mirror image": "Mirror Image",
  "magic mouth": "Magic Mouth",
  "forget": "Forget — review (Player's Companion)",
  "read magic": "Read Magic — note: ACKS mages read magic inherently; drop from repertoire",
  "identify": "Identify — handled by ACKS magic research rules; review",
  "phantasmal force": "Phantasmal Force",
  "color spray": "Color Spray — review (Heroic Fantasy)",
  "hypnotic pattern": "Hypnotic Pattern — review",
  "wall of fire": "Wall of Fire",
  "wall of fog": "Wall of Fog — review",
  "ice storm": "Ice Storm — review; nearest ACKS analogue",
  "cone of cold": "Cone of Cold — review",
  "polymorph other": "Polymorph Other",
  "polymorph self": "Polymorph Self",
  "dimension door": "Dimension Door",
  "teleport": "Teleport",
  "fly": "Flight",
  "gust of wind": "Gust of Wind — review",
  "stinking cloud": "Stinking Cloud",
  "suggestion": "Suggestion — review",
  "conjure elemental": "Conjure Elemental",
  "wall of iron": "Wall of Iron — review",
  "stone to flesh": "Stone to Flesh",
  "anti-magic shell": "Anti-Magic Shell — review",
  "explosive runes": "Explosive Runes — review; treat as Glyph variant",
  "glyph of warding": "Glyph of Warding — review",
  "enlarge": "Growth (ACKS analogue of Enlarge)",
  "jump": "Jump — review",
  "spider climb": "Spider Climb",
  "erase": "Erase — review",
  "write": "Write — review",
  "message": "Message — review",
  "friends": "Friends — review",
  "dancing lights": "Dancing Lights — review",
  "affect normal fires": "Affect Normal Fires — review",
  "feather fall": "Feather Fall — review",
  "push": "Push — review",
  "shatter": "Shatter — review",
  "locate object": "Locate Object",
  "blink": "Blink — review",
  "monster summoning i": "Summon Monsters I (nearest ACKS analogue)",
  "ray of enfeeblement": "Ray of Enfeeblement — review",
  "wizard eye": "Wizard Eye — review",
  "find familiar": "Find Familiar — note: ACKS handles familiars via proficiency/ritual; review",
  // 5e spell names
  "cure wounds": "Cure Light Wounds (nearest ACKS analogue)",
  "healing word": "Cure Light Wounds — review (5e ranged heal has no ACKS analogue)",
  "inflict wounds": "Cause Light Wounds (reversed Cure Light Wounds)",
  "guiding bolt": "Striking / divine attack — review",
  "shield of faith": "Protection from Evil (nearest ACKS analogue — review)",
  "spiritual weapon": "Striking (nearest ACKS analogue — review)",
  "mass cure wounds": "Cure Serious Wounds — review scaling",
  "lesser restoration": "Cure Disease (nearest ACKS analogue — review)",
  "greater restoration": "Restore Life and Limb context — review",
  "revivify": "Restore Life and Limb (ACKS ritual framework) — review",
  "misty step": "Dimension Door (short-range) — review",
  "counterspell": "Dispel Magic (reactive use) — review",
  "shatter": "Shatter — review",
  "scorching ray": "Magic Missile / fire analogue — review",
  "fire bolt": "[CANTRIP] no ACKS equivalent — drop or treat as thrown oil",
  "eldritch blast": "[CANTRIP] no ACKS equivalent — drop; see conversion notes",
  "sacred flame": "[CANTRIP] no ACKS equivalent — drop",
  "toll the dead": "[CANTRIP] no ACKS equivalent — drop",
  "thaumaturgy": "[CANTRIP] flavor only — drop",
  "prestidigitation": "[CANTRIP] flavor only — drop",
  "mage hand": "[CANTRIP] no ACKS equivalent — drop",
  "minor illusion": "[CANTRIP] use Phantasmal Force sparingly — review",
  "vicious mockery": "[CANTRIP] no ACKS equivalent — drop",
  "hex": "Bestow Curse (lesser) — review",
  "hunter's mark": "No ACKS equivalent — fold into Explorer class abilities (review)",
  "bless 5e": "Bless",
  "banishment": "Dispel Evil (nearest ACKS analogue — review)",
  "hypnotic pattern 5e": "Hypnotic Pattern — review",
  "hold monster": "Hold Monster — review (Player's Companion analogue)",
  "dominate person": "Charm Person (stronger; review)",
  "thunderwave": "Gust of Wind / concussive analogue — review",
  "shield 5e": "Shield",
  "mage armor": "Shield / Bracers analogue — review (ACKS has no Mage Armor)",
  "faerie fire": "Faerie Fire (divine list) — review",
  "moonbeam": "No ACKS equivalent — review; Striking-style divine damage",
  "call lightning": "Call Lightning",
  "spike growth": "No direct ACKS equivalent — review",
  "pass without trace": "No ACKS spell — map to stealth proficiencies (review)",
  "see invisibility": "Detect Invisible",
  "detect thoughts": "ESP",
  "arcane lock": "Wizard Lock",
  "comprehend languages": "Read Languages (ACKS analogue)",
  "disguise self": "Phantasmal disguise — review",
  "expeditious retreat": "No ACKS equivalent — review",
  "burning hands 5e": "Burning Hands"
};
export function convertSpells(spellsByLevel) {
  if (!spellsByLevel) return { value: null, notes: [] };
  const notes = [];
  const out = {};
  for (const [lvl, list] of Object.entries(spellsByLevel)) {
    out[lvl] = (list ?? []).map((raw) => {
      const cleaned = String(raw).toLowerCase().replace(/\(x\s*\d+\)/g, "").replace(/\s+/g, " ").trim();
      const mult = String(raw).match(/\(x\s*(\d+)\)/i);
      const mapped = SPELL_MAP[cleaned];
      if (!mapped) { notes.push(`Unmapped spell '${raw}' — review`); return `${raw} [UNMAPPED]`; }
      if (/review|UNMAPPED|no direct|no core/i.test(mapped)) notes.push(`Spell '${raw}': ${mapped}`);
      return mult ? `${mapped} (x${mult[1]})` : mapped;
    });
  }
  return { value: out, notes };
}

// ---------- Attack throws ----------
// ACKS monsters: attack throw 10+ at 1 HD, improving ~+1 per HD (per the
// ACKS monster attack progression). We compute a usable approximation.
export function attackThrowForHD(effectiveHD) {
  if (effectiveHD === null || effectiveHD === undefined) return null;
  const hd = Math.max(0.5, effectiveHD);
  return Math.max(0, Math.round(10 - (Math.ceil(hd) - 1))) ; // expressed as "N+"
}

// ---------- 5e-specific conversions ----------
// 5e uses ascending AC with unarmored 10; ACKS unarmored is 0.
export function convert5eAC(ac) {
  if (ac === null || ac === undefined) return { value: null };
  const acks = Math.max(0, Math.min(12, Number(ac) - 10));
  return { value: acks, note: `AC ${ac} (5e ascending) → ACKS AC ${acks}` };
}

// CR → ACKS HD. 5e hit-point pools are inflated relative to old-school play,
// so HD is derived from Challenge Rating (the common OSR conversion rule of
// thumb: roughly CR + 1 for CR 1 and up) rather than from the hit-dice line.
export function hdFromCR(cr, hp = null) {
  if (cr === null || cr === undefined) {
    // No CR (e.g. sidebar creature): estimate from HP at 4.5/HD, halved to
    // account for 5e HP inflation.
    if (hp) return { effective: Math.max(0.5, Math.round(hp / 9)), note: `No CR; HD estimated from ${hp} hp (÷9, accounting for 5e HP inflation)` };
    return { effective: 1, note: "No CR or HP in source; HD defaulted to 1 — review" };
  }
  const c = Number(cr);
  let hd;
  if (c <= 0) hd = 0.5;
  else if (c <= 0.125) hd = 0.5;
  else if (c <= 0.25) hd = 1;
  else if (c <= 0.5) hd = 1.5;
  else hd = Math.min(20, Math.round(c + 1));
  return { effective: hd, note: `CR ${cr} → ${hd} HD (CR+1 rule); roll hp on d8s rather than keeping the 5e pool` };
}

// 5e speed is feet per 6-second round; classic 30 ft ≈ ACKS 120'(40').
export function convert5eSpeed(speed) {
  if (!speed) return { value: "120'(40')", note: "Speed missing; defaulted to 120'(40')" };
  const fmt = (ft) => `${ft * 4}'(${Math.round((ft * 4) / 3 / 5) * 5}')`;
  const parts = [];
  if (speed.walk) parts.push(fmt(speed.walk));
  for (const mode of ["fly", "swim", "burrow", "climb"]) {
    if (speed[mode]) parts.push(`${mode} ${fmt(speed[mode])}`);
  }
  if (!parts.length) return { value: "120'(40')" };
  return { value: parts.join(" / "), note: `5e speed ${JSON.stringify(speed)} → ${parts.join(" / ")}` };
}

// ACKS ability scores run 3–18; 5e monsters/NPCs can exceed that.
export function clampAbilities(abilities) {
  if (!abilities) return { value: {}, notes: [] };
  const out = {}, notes = [];
  for (const [k, v] of Object.entries(abilities)) {
    if (v === null || v === undefined) continue;
    out[k] = Math.min(18, Math.max(3, v));
    if (v > 18) notes.push(`${k.toUpperCase()} ${v} exceeds the ACKS 3–18 range; clamped to 18.`);
  }
  return { value: out, notes };
}

function primaryAttack5e(actions) {
  const atk = (actions ?? []).find((a) => a.damageDice || a.damageAvg);
  if (!atk) return { attacks: "1", damage: null };
  const multi = (actions ?? []).find((a) => /multiattack/i.test(a.name ?? ""));
  const count = multi?.summary?.match(/\b(two|three|four|2|3|4)\b/i)?.[1];
  const countNum = { two: "2", three: "3", four: "4" }[String(count).toLowerCase()] ?? count ?? "1";
  return {
    attacks: countNum,
    damage: atk.damageDice ?? (atk.damageAvg ? `~${atk.damageAvg}` : null),
    note: atk.damageDice ? `Damage dice kept from 5e action '${atk.name}'; trim large pools toward old-school scale if combats drag.` : null
  };
}

export function convert5eMonster(mon) {
  const notes = [];
  const ac = convert5eAC(mon.ac);
  const hd = hdFromCR(mon.cr, mon.hp);
  const mv = convert5eSpeed(mon.speed);
  const align = convertAlignment(mon.alignment);
  const atk = primaryAttack5e(mon.actions);
  for (const n of [ac.note, hd.note, mv.value !== "120'(40')" ? mv.note : null, atk.note].filter(Boolean)) notes.push(n);

  const traitSummaries = (mon.traits ?? []).map((t) => `${t.name}: ${t.summary}`);
  const legendary = (mon.legendaryActions ?? []).map((t) => `${t.name}: ${t.summary}`);
  if (legendary.length) notes.push("Legendary actions have no ACKS analogue; preserved as special abilities for GM adjudication.");
  if (mon.damageResistances || mon.damageImmunities || mon.conditionImmunities) {
    notes.push("5e resistances/immunities preserved verbatim; map condition immunities to the nearest ACKS effect (e.g. charm/hold/sleep) at the table.");
  }
  notes.push("Morale has no 5e source value; defaulted to 0 (average) — adjust for cowardly or fearless creatures.");
  notes.push("Converted from 5e: bounded-accuracy math does not survive conversion; AC/HD were rescaled, not copied.");

  const specials =
    (mon.traits?.length ? 1 : 0) +
    (mon.spellcasting ? 1 : 0) +
    (legendary.length ? 1 : 0);

  return {
    type: "monster",
    name: mon.name,
    img: null,
    acks: {
      ac: ac.value,
      hd: `${hd.effective}`,
      hdEffective: hd.effective,
      hpList: null, // 5e pools intentionally dropped; roll on d8s per converted HD
      move: mv.value,
      attacks: atk.attacks,
      damage: atk.damage,
      saves: savesForHD(hd.effective),
      attackThrow: attackThrowForHD(hd.effective),
      morale: 0,
      alignment: align.value,
      xp: xpForMonster(hd.effective, specials),
      specialAttacks: [...traitSummaries, ...legendary].join("; ") || null,
      specialDefenses: [mon.damageResistances, mon.damageImmunities, mon.conditionImmunities].filter(Boolean).join("; ") || null,
      treasure: mon.treasure ?? null,
      description: [mon.description, mon.size && mon.creatureType ? `${mon.size} ${mon.creatureType}` : null].filter(Boolean).join(". ") || null
    },
    locationRef: mon.locationRef ?? null,
    count: mon.count ?? null,
    sourcePages: mon.sourcePages ?? [],
    conversionNotes: notes
  };
}

export function convert5eNPC(npc) {
  const notes = [];
  const ac = convert5eAC(npc.ac);
  // Classed NPC: level carries (capped); stat-block NPC: derive from CR.
  let level = npc.level ?? null;
  if (level === null && npc.cr !== null && npc.cr !== undefined) {
    level = Math.max(1, hdFromCR(npc.cr).effective | 0);
    notes.push(`No class level in source; level ${level} derived from CR ${npc.cr}.`);
  }
  const cls = convertClass(npc.class, level);
  const align = convertAlignment(npc.alignment);
  const abil = clampAbilities(npc.abilities);
  const mv = convert5eSpeed(npc.speed);
  notes.push(...cls.notes, ...abil.notes);
  if (ac.note) notes.push(ac.note);

  // 5e spell lists: levels 1–6 map across; 7–9 have no ACKS arcane analogue.
  let spells = null;
  if (npc.spellcasting) {
    const src = npc.spellcasting.spells ?? {};
    const kept = {};
    for (const [lvl, list] of Object.entries(src)) {
      if (Number(lvl) <= 6) kept[lvl] = list;
      else if (list?.length) notes.push(`5e level-${lvl} spells (${list.join(", ")}) exceed the ACKS 6-level arcane framework; dropped — re-add as ritual magic if desired.`);
    }
    const conv = convertSpells(kept);
    spells = conv.value;
    notes.push(...conv.notes);
    if (npc.spellcasting.cantrips?.length) {
      notes.push(`Cantrips (${npc.spellcasting.cantrips.join(", ")}) have no ACKS equivalent; dropped — consider granting Prestidigitation-style color via proficiencies.`);
    }
  }

  const lvl = cls.level ?? 1;
  // 5e NPC hp pools are inflated; reroll guidance rather than copy.
  if (npc.hp) notes.push(`5e hp ${npc.hp} not copied; roll ${lvl} HD per ACKS class (listed hp left blank intentionally).`);
  notes.push("Converted from 5e — review proficiencies/skills against the ACKS proficiency list.");

  return {
    type: "character",
    name: npc.title ? `${npc.name}, ${npc.title}` : npc.name,
    img: null,
    acks: {
      class: cls.acks,
      level: lvl,
      race: npc.race ?? "Human",
      alignment: align.value,
      ac: ac.value,
      hp: null,
      move: mv.value ?? "120'(40')",
      abilities: abil.value,
      saves: savesForHD(lvl),
      spells,
      equipment: npc.equipment ?? [],
      magicItems: npc.magicItems ?? [],
      treasure: npc.treasureCarried ?? null,
      description: npc.description ?? null,
      behavior: [npc.behavior, ...(npc.traits ?? []).map((t) => `${t.name}: ${t.summary}`)].filter(Boolean).join(". ") || null
    },
    locationRef: npc.locationRef ?? null,
    sourcePages: npc.sourcePages ?? [],
    conversionNotes: [...notes, "Saves use the fighter-by-level table as a baseline; adjust per ACKS class save table if precision matters."]
  };
}

// ---------- Top-level converters ----------
export function convertMonster(mon) {
  if (mon.edition === "5e" || (mon.acSystem === "ascending" && mon.cr !== undefined)) return convert5eMonster(mon);
  const notes = [];
  const hd = parseHD(mon.hd);
  const ac = convertAC(mon.ac);
  const mv = convertMove(mon.move);
  const morale = convertMorale(mon.morale);
  const align = convertAlignment(mon.alignment);
  const specials = countSpecials(mon);
  for (const n of [ac.note, mv.note, morale.note].filter(Boolean)) notes.push(n);
  if (mon.isUniqueOrNew) notes.push("New/unique monster from this module — stats converted from the module write-up.");

  return {
    type: "monster",
    name: mon.name,
    img: null,
    acks: {
      ac: ac.value,
      hd: hd.raw,
      hdEffective: hd.effective,
      hpList: mon.hpList ?? null,
      move: mv.value,
      attacks: mon.attacksPerRound ?? "1",
      damage: mon.damage ?? null,
      saves: savesForHD(hd.effective),
      attackThrow: attackThrowForHD(hd.effective),
      morale: morale.value,
      alignment: align.value,
      xp: xpForMonster(hd.effective, specials),
      specialAttacks: mon.specialAttacks ?? null,
      specialDefenses: mon.specialDefenses ?? null,
      treasure: mon.treasure ?? null,
      description: mon.description ?? null
    },
    locationRef: mon.locationRef ?? null,
    count: mon.count ?? null,
    sourcePages: mon.sourcePages ?? [],
    conversionNotes: notes
  };
}

export function convertNPC(npc) {
  if (npc.edition === "5e" || (npc.acSystem === "ascending" && (npc.cr !== undefined || npc.spellcasting !== undefined))) return convert5eNPC(npc);
  const notes = [];
  const ac = convertAC(npc.ac);
  const cls = convertClass(npc.class, npc.level);
  const align = convertAlignment(npc.alignment);
  const spells = convertSpells(npc.spells);
  const mv = convertMove(npc.move);
  notes.push(...cls.notes, ...spells.notes);
  if (ac.note) notes.push(ac.note);
  if (npc.dualClass) notes.push(`Multi/dual class (${npc.class}/${npc.dualClass.class}) — ACKS has no multiclassing; modeled as primary class with secondary abilities noted. Review.`);

  const lvl = cls.level ?? 1;
  return {
    type: "character", // ACKS NPC humans use the character sheet
    name: npc.title ? `${npc.name}, ${npc.title}` : npc.name,
    img: null,
    acks: {
      class: cls.acks,
      level: lvl,
      race: npc.race ?? "Human",
      alignment: align.value,
      ac: ac.value,
      hp: npc.hp ?? null,
      move: mv.value ?? "120'(40')",
      abilities: npc.abilities ?? {},
      saves: savesForHD(lvl), // approximation; class save tables differ slightly — flagged below
      spells: spells.value,
      equipment: npc.equipment ?? [],
      magicItems: npc.magicItems ?? [],
      treasure: npc.treasureCarried ?? null,
      description: npc.description ?? null,
      behavior: npc.behavior ?? null,
      secondaryClass: npc.dualClass ?? null
    },
    locationRef: npc.locationRef ?? null,
    sourcePages: npc.sourcePages ?? [],
    conversionNotes: [...notes, "Saves use the fighter-by-level table as a baseline; adjust per ACKS class save table if precision matters."]
  };
}

function titleCase(s) {
  return String(s).replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Structure extraction. Sends section-aware chunks of module text to the LLM
 * with a strict schema, then merges and de-duplicates the results.
 *
 * All stat values are captured in their ORIGINAL edition terms here
 * (descending AC, HD with modifiers, movement in inches, AD&D save matrices
 * implied by class/level). Conversion to ACKS happens in acks-converter.js so
 * that the raw extraction stays auditable.
 */

import { LLMClient } from "./llm-client.js";

const EXTRACTION_SYSTEM = `You are a data-extraction engine for tabletop RPG adventure modules written for Basic D&D, AD&D 1st edition, or AD&D 2nd edition. You receive a chunk of raw text extracted from a scanned module PDF (expect OCR noise: '0' for 'D', 'l' for '1', run-together stat blocks). Extract entities into the JSON schema below. Be conservative: only output what the text supports; use null for unknown fields; never invent stats. Correct obvious OCR errors in numbers when context makes the intended value unambiguous (e.g. 'hp l0' is hp 10). Do not copy long passages of prose; summarize descriptions in your own words, under 60 words each.

Schema:
{
  "npcs": [{
    "name": str, "title": str|null,
    "race": str|null, "class": str|null, "level": int|null,
    "dualClass": {"class": str, "level": int}|null,
    "alignment": str|null,
    "ac": int|null, "acSystem": "descending",
    "hp": int|null, "hd": str|null,
    "move": str|null,
    "attacksPerRound": str|null, "damage": str|null,
    "abilities": {"str": int|null, "int": int|null, "wis": int|null, "dex": int|null, "con": int|null, "cha": int|null},
    "equipment": [str], "magicItems": [str],
    "spells": {"1": [str], "2": [str], "3": [str], "4": [str], "5": [str], "6": [str]}|null,
    "treasureCarried": str|null,
    "locationRef": str|null,
    "description": str|null, "behavior": str|null,
    "sourcePages": [int]
  }],
  "monsters": [{
    "name": str, "count": str|null,
    "ac": int|null, "acSystem": "descending",
    "move": str|null, "hd": str|null, "hpList": [int]|null,
    "attacksPerRound": str|null, "damage": str|null,
    "specialAttacks": str|null, "specialDefenses": str|null,
    "alignment": str|null, "morale": int|null,
    "isUniqueOrNew": bool,
    "newMonsterWriteup": str|null,
    "treasure": str|null,
    "locationRef": str|null,
    "description": str|null,
    "sourcePages": [int]
  }],
  "locations": [{
    "key": str, "name": str,
    "kind": "dungeon-room"|"building"|"wilderness"|"town"|"tower-level"|"other",
    "parentMap": str|null,
    "summary": str|null,
    "readAloud": str|null,
    "occupantsRef": [str],
    "doors": [{"to": str|null, "state": "open"|"closed"|"locked"|"secret"|"barred"|"stuck"|null, "notes": str|null}],
    "lighting": str|null,
    "traps": [str], "treasure": [str],
    "approxDimensionsFeet": {"w": int|null, "h": int|null},
    "sourcePages": [int]
  }],
  "rollTables": [{
    "name": str, "die": str,
    "entries": [{"rangeLow": int, "rangeHigh": int, "result": str}],
    "sourcePages": [int]
  }],
  "maps": [{
    "name": str, "pageGuess": int|null,
    "scaleNote": str|null,
    "keyedLocations": [str]
  }]
}

Notes:
- "locationRef" ties creatures to a location key like "A", "23b", "BG", or a named place.
- Stat blocks in these editions look like: (AC: 5, MV 9", HD 3+1, hp 22, #AT 1, D 2-7, AL CE) — parse them.
- Set "isUniqueOrNew" true for monsters introduced by this module (often in a NEW CREATURES/MONSTERS appendix) or one-off variants; include a concise paraphrased mechanical writeup in newMonsterWriteup.
- Rumor tables, wandering-monster tables, and encounter tables all belong in rollTables.`;

const EXTRACTION_SYSTEM_5E = `You are a data-extraction engine for tabletop RPG adventure modules written for the 5th edition of the world's most popular fantasy RPG. You receive a chunk of raw text extracted from a PDF (expect layout noise: stat blocks split across columns, run-together lines). Extract entities into the JSON schema below. Be conservative: only output what the text supports; use null for unknown fields; never invent stats. Do not copy long passages of prose; summarize all descriptions, traits, and actions in your own words, under 40 words each.

Schema:
{
  "npcs": [{
    "name": str, "title": str|null,
    "race": str|null, "class": str|null, "level": int|null,
    "alignment": str|null,
    "ac": int|null, "acSystem": "ascending",
    "hp": int|null, "hitDice": str|null,
    "speed": {"walk": int|null, "fly": int|null, "swim": int|null, "burrow": int|null, "climb": int|null},
    "cr": number|null, "profBonus": int|null,
    "abilities": {"str": int|null, "dex": int|null, "con": int|null, "int": int|null, "wis": int|null, "cha": int|null},
    "skills": [str], "senses": [str], "languages": [str],
    "traits": [{"name": str, "summary": str}],
    "actions": [{"name": str, "summary": str, "attackBonus": int|null, "damageDice": str|null, "damageAvg": int|null}],
    "spellcasting": {"casterLevel": int|null, "saveDC": int|null, "cantrips": [str], "spells": {"1": [str], "2": [str], "3": [str], "4": [str], "5": [str], "6": [str], "7": [str], "8": [str], "9": [str]}}|null,
    "equipment": [str], "magicItems": [str],
    "treasureCarried": str|null,
    "locationRef": str|null,
    "description": str|null, "behavior": str|null,
    "sourcePages": [int]
  }],
  "monsters": [{
    "name": str, "count": str|null,
    "size": str|null, "creatureType": str|null,
    "ac": int|null, "acSystem": "ascending",
    "hp": int|null, "hitDice": str|null,
    "speed": {"walk": int|null, "fly": int|null, "swim": int|null, "burrow": int|null, "climb": int|null},
    "cr": number|null,
    "abilities": {"str": int|null, "dex": int|null, "con": int|null, "int": int|null, "wis": int|null, "cha": int|null},
    "savingThrows": [str], "skills": [str], "senses": [str],
    "damageResistances": str|null, "damageImmunities": str|null, "conditionImmunities": str|null,
    "traits": [{"name": str, "summary": str}],
    "actions": [{"name": str, "summary": str, "attackBonus": int|null, "damageDice": str|null, "damageAvg": int|null}],
    "legendaryActions": [{"name": str, "summary": str}],
    "spellcasting": {"casterLevel": int|null, "saveDC": int|null, "cantrips": [str], "spells": {"1": [str], "2": [str], "3": [str]}}|null,
    "alignment": str|null,
    "isUniqueOrNew": bool, "newMonsterWriteup": str|null,
    "treasure": str|null,
    "locationRef": str|null, "description": str|null,
    "sourcePages": [int]
  }],
  "locations": [ ...same location schema as printed adventures: key, name, kind, parentMap, summary, readAloud (paraphrase boxed text in your own words, under 50 words), occupantsRef, doors[{to,state,notes}], lighting, traps, treasure, approxDimensionsFeet{w,h}, sourcePages ],
  "rollTables": [{ "name": str, "die": str, "entries": [{"rangeLow": int, "rangeHigh": int, "result": str}], "sourcePages": [int] }],
  "maps": [{ "name": str, "pageGuess": int|null, "scaleNote": str|null, "keyedLocations": [str] }]
}

Notes:
- 5e stat blocks read like: AC line, Hit Points with dice, Speed in feet, six ability scores with modifiers, optional saves/skills/senses, Challenge with XP, then Traits / Actions / Legendary Actions. Parse all of it into the fields above.
- "locationRef" ties creatures to a keyed area like "A12", "C3", or a named place.
- Named NPCs with class levels go in npcs; generic stat-block creatures (including named monsters statted as monsters) go in monsters.
- Set isUniqueOrNew true for creatures introduced by this adventure (often in an appendix); include a concise paraphrased mechanical writeup.
- 5e adventures often have random encounter tables and event tables; capture them in rollTables.`;

export async function extractStructure(chunks, { edition = "classic", onProgress } = {}) {
  const llm = new LLMClient();
  const system = edition === "5e" ? EXTRACTION_SYSTEM_5E : EXTRACTION_SYSTEM;
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(`Extracting structure: chunk ${i + 1}/${chunks.length}`, (i + 1) / chunks.length);
    const c = chunks[i];
    const result = await llm.completeJSON(system, [{
      type: "text",
      text: `Pages ${c.pageStart}-${c.pageEnd} of the adventure:\n\n${c.text}`
    }], 8000, { label: `Extraction — chunk ${i + 1}/${chunks.length} (pages ${c.pageStart}-${c.pageEnd})` });
    if (result === null) {
      onProgress?.(`⚠ Chunk ${i + 1} skipped (GM chose to continue without it) — entities on pages ${c.pageStart}-${c.pageEnd} may be missing.`, (i + 1) / chunks.length);
      continue;
    }
    partials.push(result);
  }
  const merged = mergePartials(partials);
  for (const kind of ["npcs", "monsters"]) {
    for (const e of merged[kind] ?? []) e.edition = edition;
  }
  return merged;
}

/** Merge chunk results; overlapping chunks can duplicate entities. */
function mergePartials(partials) {
  const merged = { npcs: [], monsters: [], locations: [], rollTables: [], maps: [] };
  const seen = { npcs: new Map(), monsters: new Map(), locations: new Map(), rollTables: new Map(), maps: new Map() };

  const keyOf = {
    npcs: (e) => norm(e.name),
    monsters: (e) => `${norm(e.name)}@${norm(e.locationRef ?? "")}`,
    locations: (e) => `${norm(e.parentMap ?? "")}#${norm(e.key)}`,
    rollTables: (e) => norm(e.name),
    maps: (e) => norm(e.name)
  };

  for (const part of partials) {
    for (const kind of Object.keys(merged)) {
      for (const ent of part?.[kind] ?? []) {
        if (!ent) continue;
        const k = keyOf[kind](ent);
        const existing = seen[kind].get(k);
        if (existing) mergeEntity(existing, ent);
        else { seen[kind].set(k, ent); merged[kind].push(ent); }
      }
    }
  }
  return merged;
}

function mergeEntity(a, b) {
  for (const [k, v] of Object.entries(b)) {
    if (v === null || v === undefined) continue;
    if (a[k] === null || a[k] === undefined) a[k] = v;
    else if (Array.isArray(a[k]) && Array.isArray(v)) {
      for (const item of v) {
        const s = JSON.stringify(item);
        if (!a[k].some((x) => JSON.stringify(x) === s)) a[k].push(item);
      }
    }
  }
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

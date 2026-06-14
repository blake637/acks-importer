/**
 * Map-plate identification & matching.
 *
 * Classic PDFs routinely print maps far from their keyed text — inside the
 * cover, or in an appendix — so page proximity is unreliable evidence for
 * which plate belongs to which location group. Instead:
 *
 *   1. identifyMapPlates(): one vision call per candidate plate asks the
 *      multimodal LLM to read what's ON the plate — its printed title, map
 *      type (dungeon / town / building / wilderness-hex), grid style, scale
 *      note, and the keyed labels visible (room letters/numbers).
 *   2. matchPlate(): each location group is scored against every plate by
 *      (a) title/name token overlap and (b) overlap between the group's
 *      location keys and the plate's visible keys. Key overlap is weighted
 *      highest — a plate showing rooms A–Z and AA–BP is near-proof.
 *   3. Page proximity survives only as a low-weight tiebreaker, and as the
 *      whole fallback when no vision-capable LLM is available.
 */

import { LLMClient } from "./llm-client.js";
import { warn, log } from "../util/logger.js";

const PLATE_SYSTEM = `You are a map-plate cataloguer for scanned RPG adventure PDFs. You receive one page image that likely contains a map. Output JSON only:
{
  "isMap": bool,
  "title": str|null,            // printed title/caption on the plate, verbatim if short
  "mapType": "dungeon"|"town"|"building"|"wilderness"|"region"|"other"|null,
  "gridType": "square"|"hex"|"none"|null,
  "scaleNote": str|null,        // e.g. "1 square = 10 feet", "1 hex = 1/2 mile"
  "visibleKeys": [str],         // keyed labels you can read: room letters/numbers like "A", "12", "23b", "BA", or named features
  "multipleMaps": bool          // true if the page contains several distinct maps (floors/levels count as one map group)
}
If the page is an illustration, cover, or text page, set isMap=false and leave the rest null.`;

export async function identifyMapPlates(pageImages, { onProgress, maxPlates = 14 } = {}) {
  const llm = new LLMClient();
  const candidates = pageImages.filter((p) => p.isLikelyMap).slice(0, maxPlates);
  const plates = [];
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    onProgress?.(`Identifying map plate ${i + 1}/${candidates.length} (page ${p.page})`);
    try {
      const meta = await llm.completeJSON(PLATE_SYSTEM, [
        { type: "image", dataUrl: p.dataUrl },
        { type: "text", text: `This is page ${p.page} of the PDF.` }
      ], 2000, { label: `Plate identification — page ${p.page}` });
      if (meta?.isMap) plates.push({ page: p.page, dataUrl: p.dataUrl, ...meta });
      else log(`Page ${p.page}: not a map (vision pass)`);
    } catch (e) {
      warn(`Plate identification failed for page ${p.page}; keeping it as an unlabeled candidate`, e);
      plates.push({ page: p.page, dataUrl: p.dataUrl, title: null, mapType: null, gridType: null, scaleNote: null, visibleKeys: [] });
    }
  }
  return plates;
}

/**
 * Score plates against a location group and return the best match (or null).
 * @param {object} group   { name, locations:[{key,...}], pagesUsed:Set }
 * @param {Array}  plates  identified plates
 * @param {Set}    claimed plate pages already assigned to other groups
 */
export function matchPlate(group, plates, claimed = new Set()) {
  const groupTokens = tokenize(group.name);
  const groupKeys = new Set((group.locations ?? []).map((l) => normKey(l.key)));
  const pageNums = [...(group.pagesUsed ?? [])];

  let best = null, bestScore = 0;
  for (const plate of plates) {
    if (claimed.has(plate.page)) continue;
    let score = 0;

    // (a) key overlap — strongest evidence
    const plateKeys = new Set((plate.visibleKeys ?? []).map(normKey));
    let overlap = 0;
    for (const k of groupKeys) if (plateKeys.has(k)) overlap++;
    if (groupKeys.size) score += 6 * (overlap / groupKeys.size);

    // (b) title/name token overlap
    const titleTokens = tokenize(plate.title ?? "");
    const shared = groupTokens.filter((t) => titleTokens.includes(t)).length;
    if (groupTokens.length) score += 3 * (shared / groupTokens.length);

    // (c) map-type sanity: wilderness groups shouldn't grab dungeon plates
    const wantsHex = /wilderness|overland|region|isle|island|hex/i.test(group.name);
    if (wantsHex && plate.gridType === "hex") score += 1.5;
    if (!wantsHex && plate.gridType === "hex") score -= 1.5;

    // (d) proximity tiebreaker (low weight)
    if (pageNums.length) {
      const d = Math.min(...pageNums.map((n) => Math.abs(n - plate.page)));
      score += Math.max(0, 1 - d / 20);
    }

    if (score > bestScore) { bestScore = score; best = plate; }
  }
  // Require real evidence: a bare proximity score (<1) is not a match.
  return bestScore >= 1.2 ? { plate: best, score: bestScore } : null;
}

function tokenize(s) {
  return String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !["the", "map", "and", "level"].includes(t));
}
function normKey(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

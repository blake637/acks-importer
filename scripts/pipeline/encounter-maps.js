/**
 * Wilderness terrain vocabulary for tactical encounter maps.
 *
 * Encounter maps are now IMAGE-FIRST (see docs/map-generation.md): for each
 * distinct terrain present on a wilderness map we hand the image model a
 * description of that terrain and let it paint a square battlemap. There is no
 * procedural obstacle layout and no walls — an outdoor encounter map is just
 * the painted ground; cover is a table ruling, not occlusion geometry.
 *
 * This module therefore only owns the terrain vocabulary: how to normalize a
 * free-text terrain string to a known type, and the painting prompt for each.
 */

/** Canonical terrain → battlemap painting prompt. */
export const TERRAIN_PROMPTS = {
  forest:    "dense temperate forest clearing, undergrowth, leaf litter, scattered trees and roots",
  hills:     "rolling rocky hillside, scrub grass, exposed stone outcrops",
  mountains: "high mountain scree slope, jagged rock outcrops, thin soil, loose stone",
  grassland: "open grassland meadow, tall grass, wildflowers, a few scattered rocks",
  swamp:     "murky swamp, standing water, gnarled roots, hanging moss, muddy hummocks",
  desert:    "arid desert, sand drifts, wind-carved rock, sparse scrub",
  water:     "riverbank, reeds, wet stones, flowing water along one edge",
  river:     "riverbank, reeds, wet stones, flowing water along one edge",
  road:      "rutted dirt road through open country, wagon tracks, verge grass"
};

export const ENCOUNTER_TERRAINS = Object.keys(TERRAIN_PROMPTS);

/** Normalize a free-text terrain string to a known terrain type. */
export function normalizeTerrain(t) {
  const s = String(t ?? "").toLowerCase();
  return TERRAIN_PROMPTS[s] ? s
    : (s.includes("wood") || s.includes("forest")) ? "forest"
    : s.includes("hill") ? "hills"
    : (s.includes("mount") || s.includes("peak")) ? "mountains"
    : (s.includes("swamp") || s.includes("marsh") || s.includes("bog")) ? "swamp"
    : (s.includes("desert") || s.includes("sand")) ? "desert"
    : (s.includes("river") || s.includes("lake") || s.includes("water") || s.includes("coast")) ? "water"
    : (s.includes("road") || s.includes("trail") || s.includes("pass")) ? "road"
    : "grassland";
}

/** The painting prompt for a (possibly free-text) terrain. */
export function terrainPrompt(t) {
  return TERRAIN_PROMPTS[normalizeTerrain(t)];
}

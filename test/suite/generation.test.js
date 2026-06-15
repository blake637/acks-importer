import "../foundry-shim.js";
import { describe, it, expect } from "../harness.js";
import { matchPlate } from "../../scripts/pipeline/plate-matcher.js";
import { normalizeTerrain, terrainPrompt } from "../../scripts/pipeline/encounter-maps.js";
import { sanitizePlacement } from "../../scripts/pipeline/scene-builder.js";

describe("plate matching by evidence, not proximity", () => {
  const plates = [
    { page: 2, title: "The Castle Ruins", gridType: "square", visibleKeys: ["A", "B", "M", "AA", "BG", "BP"] },
    { page: 7, title: "Map of the Wilderness", gridType: "hex", visibleKeys: ["Restenford", "Bone Hill"] }
  ];
  it("matches dungeon plate across an 11-page gap", () => {
    const g = { name: "Castle Ruins", locations: [{ key: "A" }, { key: "M" }, { key: "BG" }], pagesUsed: new Set([13, 14, 15]) };
    expect(matchPlate(g, plates).plate.page).toBe(2);
  });
  it("matches hex wilderness plate", () => {
    const g = { name: "Wilderness of the Isle", locations: [{ key: "Bone Hill" }], pagesUsed: new Set([6]) };
    expect(matchPlate(g, plates).plate.page).toBe(7);
  });
  it("returns null without real evidence", () => {
    const g = { name: "Random Tables", locations: [{ key: "zzz" }], pagesUsed: new Set([40]) };
    expect(matchPlate(g, plates)).toBeNull();
  });
  it("does not reuse a claimed plate", () => {
    const g = { name: "Castle Ruins", locations: [{ key: "A" }], pagesUsed: new Set([13]) };
    expect(matchPlate(g, plates, new Set([2]))).toBeNull();
  });
});

describe("terrain normalization", () => {
  it("Dweomer Forest → forest", () => expect(normalizeTerrain("Dweomer Forest")).toBe("forest"));
  it("Pebble Hills → hills", () => expect(normalizeTerrain("Pebble Hills")).toBe("hills"));
  it("bog → swamp", () => expect(normalizeTerrain("bog")).toBe("swamp"));
  it("unknown → grassland", () => expect(normalizeTerrain("the weird zone")).toBe("grassland"));
  it("terrainPrompt resolves a free-text terrain", () => {
    expect(typeof terrainPrompt("Dweomer Forest")).toBe("string");
    expect(terrainPrompt("Dweomer Forest")).toBe(terrainPrompt("forest"));
  });
});

describe("vision placement sanitizer", () => {
  const dims = { width: 1000, height: 800 };
  it("drops wall segments with non-finite coords", () => {
    const out = sanitizePlacement({ walls: [{ x1: 10, y1: 10, x2: 20, y2: 20 }, { x1: "x", y1: 5, x2: 5, y2: 5 }] }, dims);
    expect(out.walls.length).toBe(1);
  });
  it("clamps coordinates to the image bounds", () => {
    const out = sanitizePlacement({ lights: [{ x: 5000, y: -10, radiusFeet: 30 }] }, dims);
    expect(out.lights[0].x).toBe(1000);
    expect(out.lights[0].y).toBe(0);
  });
  it("defaults a missing light radius", () => {
    const out = sanitizePlacement({ lights: [{ x: 1, y: 1 }] }, dims);
    expect(out.lights[0].radiusFeet).toBe(20);
  });
  it("preserves door state and key labels", () => {
    const out = sanitizePlacement({
      doors: [{ x1: 1, y1: 1, x2: 2, y2: 2, state: "locked" }],
      keyPositions: [{ key: "A", x: 50, y: 60 }]
    }, dims);
    expect(out.doors[0].state).toBe("locked");
    expect(out.keyPositions[0].key).toBe("A");
  });
  it("tolerates a non-object / null result", () => {
    const out = sanitizePlacement(null, dims);
    expect(out.walls.length).toBe(0);
    expect(out.keyPositions.length).toBe(0);
  });
});

// JSON recovery parser (reproduce the cleaning logic the client uses, since
// #tryParse is private — this guards the think-stripping/slice behavior).
function tryParseLike(raw) {
  let cleaned = String(raw ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!cleaned) return undefined;
  try { return JSON.parse(cleaned); } catch {}
  const first = Math.min(...["{", "["].map((c) => { const i = cleaned.indexOf(c); return i < 0 ? Infinity : i; }));
  const last = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (first !== Infinity && last > first) { try { return JSON.parse(cleaned.slice(first, last + 1)); } catch {} }
  return undefined;
}

describe("JSON recovery (reasoning-model safety)", () => {
  it("strips think block then parses", () => {
    expect(tryParseLike('<think>analyzing {x}</think>\n{"npcs":[{"name":"X"}]}').npcs[0].name).toBe("X");
  });
  it("think-only output → undefined, NOT {}", () => {
    expect(tryParseLike("<think>no entities here</think>")).toBeUndefined();
  });
  it("empty/whitespace → undefined", () => {
    expect(tryParseLike("")).toBeUndefined();
    expect(tryParseLike("   ")).toBeUndefined();
  });
  it("ignores braces inside reasoning", () => {
    expect(tryParseLike('<think>maybe {"fake":true}?</think> {"real":42}').real).toBe(42);
  });
  it("strips code fences", () => {
    expect(tryParseLike('```json\n{"a":1}\n```').a).toBe(1);
  });
});

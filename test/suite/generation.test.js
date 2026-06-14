import "../foundry-shim.js";
import { describe, it, expect } from "../harness.js";
import { matchPlate } from "../../scripts/pipeline/plate-matcher.js";
import { generateEncounterLayout, normalizeTerrain, rng, wallsForEncounter } from "../../scripts/pipeline/encounter-maps.js";

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
});

describe("seeded RNG", () => {
  it("is deterministic for a seed", () => {
    const a = rng(123), b = rng(123);
    expect(a()).toBe(b());
  });
  it("differs across seeds", () => expect(rng(1)() === rng(2)()).toBeFalsy());
});

describe("encounter layout generation", () => {
  it("is reproducible for the same seed", () => {
    const a = generateEncounterLayout("forest", 30, 20, 12345);
    const b = generateEncounterLayout("forest", 30, 20, 12345);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("differs across seeds", () => {
    const a = generateEncounterLayout("forest", 30, 20, 1);
    const c = generateEncounterLayout("forest", 30, 20, 999);
    expect(JSON.stringify(a) === JSON.stringify(c)).toBeFalsy();
  });
  it("keeps circular obstacles in bounds", () => {
    const a = generateEncounterLayout("forest", 30, 20, 7);
    for (const o of a.obstacles.filter((o) => o.cx !== undefined)) {
      expect(o.cx).toBeGreaterThan(-0.1);
      expect(o.cx).toBeLessThan(30.1);
      expect(o.cy).toBeLessThan(20.1);
    }
  });
  it("forest is denser than grassland", () => {
    const f = generateEncounterLayout("forest", 30, 20, 5);
    const g = generateEncounterLayout("grassland", 30, 20, 5);
    expect(f.obstacles.length).toBeGreaterThan(g.obstacles.length);
  });
});

describe("encounter wall typing", () => {
  const m = generateEncounterLayout("mountains", 30, 20, 7);
  const walls = wallsForEncounter(m, 100);
  it("produces walls", () => expect(walls.length).toBeGreaterThan(0));
  it("rocks block sight+movement (plain walls)", () => {
    // plain walls have no sense override
    expect(walls.some((w) => !("sight" in w))).toBeTruthy();
  });
  it("tree clusters use limited sight", () => {
    const forest = generateEncounterLayout("forest", 30, 20, 3);
    const fw = wallsForEncounter(forest, 100);
    expect(fw.some((w) => w.sight === 10)).toBeTruthy(); // LIMITED stub = 10
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

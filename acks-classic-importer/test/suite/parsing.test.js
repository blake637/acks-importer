import "../foundry-shim.js";
import { describe, it, expect } from "../harness.js";
import { classifyGear, buildItemData, parseCoins, convertMagicItem } from "../../scripts/pipeline/item-builder.js";
import { detectEdition } from "../../scripts/pipeline/edition-detect.js";
import { chunkText } from "../../scripts/util/chunker.js";
import { buildMapWorkflow, buildPortraitWorkflow, fitGenerationSize, snap8, snap16 } from "../../scripts/pipeline/comfy-workflow.js";

describe("gear classification", () => {
  it("classifies plain armor", () => {
    const g = classifyGear("chain mail");
    expect(g.kind).toBe("armor"); expect(g.bonus).toBe(0);
  });
  it("parses magic bonus", () => {
    const g = classifyGear("chain mail +2");
    expect(g.kind).toBe("armor"); expect(g.bonus).toBe(2); expect(g.isMagic).toBeTruthy();
  });
  it("parses wand charges", () => {
    const g = classifyGear("wand of fear with 5 charges left");
    expect(g.kind).toBe("wand"); expect(g.charges).toBe(5);
  });
  it("classifies weapons", () => expect(classifyGear("longsword +1").kind).toBe("weapon"));
  it("classifies shields", () => expect(classifyGear("shield +1").kind).toBe("shield"));
  it("classifies potions/scrolls/rings", () => {
    expect(classifyGear("potion of extra healing").kind).toBe("potion");
    expect(classifyGear("scroll of two spells").kind).toBe("scroll");
    expect(classifyGear("ring of protection +1").kind).toBe("ring");
  });
});

describe("item data build", () => {
  it("weapon gets damage dice + bonus", () => {
    const { data } = buildItemData(classifyGear("longsword +1"));
    expect(data.type).toBe("weapon");
    expect(JSON.stringify(data.system)).toContain("1d6+1");
  });
  it("armor gets ascending AC value", () => {
    const { data } = buildItemData(classifyGear("plate mail"));
    expect(data.type).toBe("armor");
    expect(JSON.stringify(data.system)).toContain("6");
  });
  it("magic +2 armor adds bonus to AC", () => {
    const { data } = buildItemData(classifyGear("chain mail +2"));
    // chain 4 + 2 = 6
    expect(JSON.stringify(data.system)).toContain("6");
  });
});

describe("magic-item notes", () => {
  it("plain +1 sword maps silently", () => expect(convertMagicItem(classifyGear("longsword +1")).notes).toHaveLength(0));
  it("flame tongue gets a review note", () => expect(convertMagicItem(classifyGear("sword +1, flame tongue")).notes.length).toBeGreaterThan(0));
  it("unknown wondrous item flagged", () => expect(convertMagicItem(classifyGear("amulet of inescapable location")).notes.length).toBeGreaterThan(0));
});

describe("coin parsing (dice ranges)", () => {
  it("fixed amounts", () => {
    const p = parseCoins("110 ep");
    expect(p.coins.ep).toBe(110);
  });
  it("rolls a range within bounds", () => {
    for (let i = 0; i < 50; i++) {
      const p = parseCoins("2-8 pp");
      expect(p.coins.pp).toBeGreaterThan(1);
      expect(p.coins.pp).toBeLessThan(9);
    }
  });
  it("multiple denominations", () => {
    const p = parseCoins("2-8 pp and 2-20 ep");
    expect(p.coins.pp).toBeGreaterThan(0);
    expect(p.coins.ep).toBeGreaterThan(0);
  });
  it("handles dotted forms (g.p.)", () => expect(parseCoins("13 g.p.").coins.gp).toBe(13));
  it("no coins → null", () => expect(parseCoins("a rusty key")).toBeNull());
});

describe("edition detection", () => {
  it("detects 5e", () => {
    const text = [{ page: 1, text: "Armor Class 15 Hit Points 52 Speed 40 ft. STR 16 (+3) Challenge 3 (700 XP) Proficiency Bonus +2 passive Perception 12 Bonus Action Legendary Actions Hit: 7 (1d8 + 3)" }];
    expect(detectEdition(text).edition).toBe("5e");
  });
  it("detects classic", () => {
    const text = [{ page: 1, text: '(AC: 5, MV 9", HD 3+1, hp 22, #AT 1, D 2-7, AL CE) save vs. Poison AC: 7 D 1-6 THAC0 19' }];
    expect(detectEdition(text).edition).toBe("classic");
  });
});

describe("text chunking", () => {
  const pages = Array.from({ length: 6 }, (_, i) => ({
    page: i + 1,
    text: `SECTION ${i}\n` + "line of body text here. ".repeat(120)
  }));
  it("produces chunks", () => expect(chunkText(pages).length).toBeGreaterThan(0));
  it("chunks carry page ranges", () => {
    const c = chunkText(pages)[0];
    expect(c.pageStart).toBeTruthy();
    expect(c.pageEnd).toBeGreaterThan(0);
  });
  it("respects max size roughly", () => {
    for (const c of chunkText(pages, { maxChars: 4000 })) {
      expect(c.text.length).toBeLessThan(8000); // maxChars * 1.5 ceiling + overlap
    }
  });
});

describe("flux workflow builders", () => {
  it("snap16 rounds to multiples of 16", () => {
    expect(snap16(1530) % 16).toBe(0);
    expect(snap16(1020) % 16).toBe(0);
  });
  it("snap8 still available", () => expect(snap8(100) % 8).toBe(0));
  it("fitGenerationSize preserves aspect under budget, snapped to 16", () => {
    const f = fitGenerationSize(4200, 3200, 1536);
    expect(Math.max(f.genW, f.genH)).toBeLessThan(1537);
    expect(f.genW % 16).toBe(0);
  });
  it("portrait workflow is txt2img Flux (UNet + dual CLIP + VAE, no checkpoint loader)", () => {
    const g = buildPortraitWorkflow({ prompt: "a knight", width: 1024, height: 1024, seed: 7 });
    const types = Object.values(g).map((n) => n.class_type);
    expect(types).toContain("UNETLoader");
    expect(types).toContain("DualCLIPLoader");
    expect(types).toContain("VAELoader");
    expect(types).toContain("FluxGuidance");
    expect(types).toContain("EmptyLatentImage");      // txt2img: empty latent
    expect(types.includes("CheckpointLoaderSimple")).toBeFalsy();
    expect(types.includes("ControlNetApplyAdvanced")).toBeFalsy();
  });
  it("map workflow is img2img redraw (loads + encodes the reference image)", () => {
    const g = buildMapWorkflow({ prompt: "dungeon: A chapel, B barracks", referenceImage: "ref.png", width: 1024, height: 768, seed: 3, denoise: 0.7 });
    const types = Object.values(g).map((n) => n.class_type);
    expect(types).toContain("LoadImage");             // the labeled reference
    expect(types).toContain("VAEEncode");             // img2img: encode it
    expect(types.includes("EmptyLatentImage")).toBeFalsy();
    const ksampler = Object.values(g).find((n) => n.class_type === "KSampler");
    expect(ksampler.inputs.denoise).toBeCloseTo(0.7);
  });
  it("all node refs resolve to existing nodes (portrait)", () => {
    const g = buildPortraitWorkflow({ prompt: "p", width: 512, height: 512, seed: 1 });
    for (const node of Object.values(g)) {
      for (const v of Object.values(node.inputs)) {
        if (Array.isArray(v) && typeof v[0] === "string") expect(g[v[0]]).toBeTruthy();
      }
    }
  });
  it("all node refs resolve to existing nodes (map)", () => {
    const g = buildMapWorkflow({ prompt: "p", referenceImage: "r.png", width: 512, height: 512, seed: 1 });
    for (const node of Object.values(g)) {
      for (const v of Object.values(node.inputs)) {
        if (Array.isArray(v) && typeof v[0] === "string") expect(g[v[0]]).toBeTruthy();
      }
    }
  });
  it("dimensions are snapped to 16 in the graph", () => {
    const g = buildPortraitWorkflow({ prompt: "p", width: 1020, height: 1530, seed: 1 });
    const latent = Object.values(g).find((n) => n.class_type === "EmptyLatentImage");
    expect(latent.inputs.width % 16).toBe(0);
    expect(latent.inputs.height % 16).toBe(0);
  });
});

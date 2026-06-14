import "../foundry-shim.js";
import { describe, it, expect } from "../harness.js";
import {
  convertAC, parseHD, savesForHD, xpForMonster, convertMove, convertMorale,
  convertAlignment, convertClass, convertSpells, attackThrowForHD,
  convertMonster, convertNPC,
  convert5eAC, hdFromCR, convert5eSpeed, clampAbilities, convert5eMonster, convert5eNPC
} from "../../scripts/pipeline/acks-converter.js";

describe("classic AC conversion (descending → ascending)", () => {
  it("AC 9 (unarmored) → 0", () => expect(convertAC(9).value).toBe(0));
  it("AC 5 → 4", () => expect(convertAC(5).value).toBe(4));
  it("AC 1 → 8", () => expect(convertAC(1).value).toBe(8));
  it("AC -2 → 11", () => expect(convertAC(-2).value).toBe(11));
  it("null → null", () => expect(convertAC(null).value).toBeNull());
});

describe("hit dice parsing", () => {
  it("'3+1' → 3 dice, +1 mod, 3.5 effective", () => {
    const hd = parseHD("3+1");
    expect(hd.dice).toBe(3); expect(hd.mod).toBe(1); expect(hd.effective).toBe(3.5);
  });
  it("'1-4 hp' → half-HD creature", () => expect(parseHD("1-4 hp").effective).toBe(0.5));
  it("'1/2' → 0.5", () => expect(parseHD("1/2").effective).toBe(0.5));
  it("'4 + 4' → 4.5 effective", () => expect(parseHD("4 + 4").effective).toBe(4.5));
  it("plain '7' → 7", () => expect(parseHD("7").effective).toBe(7));
});

describe("saves derive from HD (fighter table)", () => {
  it("1 HD death save 14", () => expect(savesForHD(1).death).toBe(14));
  it("clamps HD > 14", () => expect(savesForHD(30).death).toBe(savesForHD(14).death));
  it("0 HD has a save row", () => expect(savesForHD(0.5).paralysis).toBeGreaterThan(0));
});

describe("XP from HD + specials", () => {
  it("1 HD, no specials → 10", () => expect(xpForMonster(1, 0)).toBe(10));
  it("specials add bonus", () => expect(xpForMonster(3, 2)).toBeGreaterThan(xpForMonster(3, 0)));
  it("null HD → null", () => expect(xpForMonster(null)).toBeNull());
});

describe("movement inches → feet", () => {
  it("9\" → 90'(30')", () => expect(convertMove('9"').value).toBe("90'(30')"));
  it("multi-mode 3\"/8\"", () => expect(convertMove('3"/8"').value).toContain("/"));
});

describe("morale rescale", () => {
  it("B/X 7 → ~0", () => expect(convertMorale(7).value).toBe(0));
  it("clamps to ±6", () => {
    expect(convertMorale(99).value).toBeLessThan(7);
    expect(convertMorale(-99).value).toBeGreaterThan(-7);
  });
});

describe("alignment nine-point → three", () => {
  it("CE → Chaotic", () => expect(convertAlignment("CE").value).toBe("Chaotic"));
  it("LG → Lawful", () => expect(convertAlignment("LG").value).toBe("Lawful"));
  it("N → Neutral", () => expect(convertAlignment("N").value).toBe("Neutral"));
  it("null → Neutral default", () => expect(convertAlignment(null).value).toBe("Neutral"));
});

describe("class mapping", () => {
  it("magic-user → Mage", () => expect(convertClass("magic-user", 6).acks).toBe("Mage"));
  it("ranger → Explorer with note", () => {
    const c = convertClass("ranger", 2);
    expect(c.acks).toBe("Explorer"); expect(c.notes.length).toBeGreaterThan(0);
  });
  it("caps level at 14", () => {
    const c = convertClass("fighter", 20);
    expect(c.level).toBe(14); expect(c.notes.join(" ")).toContain("14");
  });
});

describe("spell mapping", () => {
  it("maps known spells", () => {
    const r = convertSpells({ "1": ["magic missile", "sleep"] });
    expect(r.value["1"]).toContain("Magic Missile");
  });
  it("flags unmapped spells", () => {
    const r = convertSpells({ "1": ["frobnicate the moon"] });
    expect(r.value["1"][0]).toContain("UNMAPPED");
    expect(r.notes.length).toBeGreaterThan(0);
  });
  it("preserves x2 multiplicity", () => {
    const r = convertSpells({ "1": ["cure light wounds (x2)"] });
    expect(r.value["1"][0]).toContain("x2");
  });
});

describe("attack throw from HD", () => {
  it("1 HD → 10", () => expect(attackThrowForHD(1)).toBe(10));
  it("improves with HD", () => expect(attackThrowForHD(5)).toBeLessThan(attackThrowForHD(1)));
});

describe("end-to-end classic monster (Bone Hill bugbear)", () => {
  const mon = convertMonster({
    name: "Bugbear", ac: 5, hd: "3+1", hpList: [22, 20], move: '9"',
    attacksPerRound: "1", damage: "2-7", alignment: "CE", morale: 9,
    specialAttacks: null, specialDefenses: null, treasure: "1-20 gp",
    sourcePages: [14]
  });
  it("AC rescaled", () => expect(mon.acks.ac).toBe(4));
  it("effective HD 3.5", () => expect(mon.acks.hdEffective).toBe(3.5));
  it("alignment Chaotic", () => expect(mon.acks.alignment).toBe("Chaotic"));
  it("has XP", () => expect(mon.acks.xp).toBeGreaterThan(0));
  it("carries conversion notes", () => expect(mon.conversionNotes.length).toBeGreaterThan(0));
});

describe("end-to-end classic NPC (Faldelac, cleric 10)", () => {
  const npc = convertNPC({
    name: "Faldelac", title: "High Priest", race: "Human", class: "cleric", level: 10,
    ac: 3, hp: 58, alignment: "CN", move: '12"',
    abilities: { str: 11, int: 14, wis: 18, dex: 17, con: 15, cha: 13 },
    spells: { "1": ["bless", "cure light wounds (x2)"], "5": ["commune", "dispel evil"] },
    equipment: ["staff of striking"], magicItems: ["ring of free action"],
    sourcePages: [8]
  });
  it("class Cleric", () => expect(npc.acks.class).toBe("Cleric"));
  it("AC 3 → 6", () => expect(npc.acks.ac).toBe(6));
  it("name includes title", () => expect(npc.name).toContain("High Priest"));
  it("spells converted", () => expect(npc.acks.spells["1"].join()).toContain("Bless"));
});

// ---------- 5e ----------
describe("5e AC rescale", () => {
  it("AC 16 → 6", () => expect(convert5eAC(16).value).toBe(6));
  it("AC 10 → 0", () => expect(convert5eAC(10).value).toBe(0));
});

describe("CR → HD", () => {
  it("CR 1/4 → 1", () => expect(hdFromCR(0.25).effective).toBe(1));
  it("CR 3 → 4", () => expect(hdFromCR(3).effective).toBe(4));
  it("CR 10 → 11", () => expect(hdFromCR(10).effective).toBe(11));
  it("no CR estimates from hp", () => expect(hdFromCR(null, 45).effective).toBe(5));
});

describe("5e speed", () => {
  it("30 ft → 120'(40')", () => expect(convert5eSpeed({ walk: 30 }).value).toBe("120'(40')"));
  it("fly preserved", () => expect(convert5eSpeed({ walk: 30, fly: 60 }).value).toContain("fly"));
});

describe("ability clamp", () => {
  it("22 → 18 with note", () => {
    const r = clampAbilities({ str: 22 });
    expect(r.value.str).toBe(18); expect(r.notes.length).toBeGreaterThan(0);
  });
  it("normal scores pass", () => expect(clampAbilities({ dex: 14 }).value.dex).toBe(14));
});

describe("end-to-end 5e monster dispatch", () => {
  const mon = convertMonster({
    edition: "5e", name: "Owlbear", ac: 13, hp: 59, cr: 3, speed: { walk: 40 },
    alignment: "unaligned",
    actions: [{ name: "Multiattack", summary: "makes two attacks" }, { name: "Claw", damageDice: "2d8+5", damageAvg: 14 }],
    traits: [{ name: "Keen Sight", summary: "advantage on sight-based perception" }],
    sourcePages: [200]
  });
  it("routed through 5e path", () => expect(mon.acks.ac).toBe(3)); // 13-10
  it("HD from CR", () => expect(mon.acks.hdEffective).toBe(4));
  it("multiattack → 2 attacks", () => expect(mon.acks.attacks).toBe("2"));
  it("bounded-accuracy note present", () => expect(mon.conversionNotes.join(" ")).toContain("bounded-accuracy"));
  it("morale defaulted", () => expect(mon.acks.morale).toBe(0));
});

describe("5e NPC drops high-level spells", () => {
  const npc = convert5eNPC({
    name: "Archmage", class: "wizard", cr: 12, ac: 12, speed: { walk: 30 },
    abilities: { int: 20 },
    spellcasting: { saveDC: 17, cantrips: ["fire bolt"], spells: { "1": ["magic missile"], "9": ["time stop"] } },
    sourcePages: [1]
  });
  it("clamps INT 20 → 18", () => expect(npc.acks.abilities.int).toBe(18));
  it("level-9 spell dropped with note", () => expect(npc.conversionNotes.join(" ")).toContain("level-9"));
  it("level-1 spell kept", () => expect(npc.acks.spells["1"].join()).toContain("Magic Missile"));
});

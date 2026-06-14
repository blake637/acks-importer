/**
 * Mock servers for validating the e2e harness offline:
 *   - OpenAI-compatible /v1/chat/completions  → returns schema-shaped JSON
 *   - ComfyUI /prompt /history /view /upload   → returns a 1x1 PNG
 * Not part of the shipped module; lives only under test/e2e for self-check.
 */
import http from "node:http";

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function llmReply(messages) {
  const text = messages.map((m) => typeof m.content === "string" ? m.content : "").join(" ").toLowerCase();
  // Return a minimal but schema-valid extraction for any extraction chunk.
  if (text.includes("data-extraction engine")) {
    return JSON.stringify({
      npcs: [{ name: "Mock Priest", title: "Curate", class: "cleric", level: 4, ac: 4, hp: 19, alignment: "CN",
        abilities: { wis: 16 }, spells: { "1": ["bless", "cure light wounds"] }, equipment: ["mace"], magicItems: [],
        locationRef: "A", sourcePages: [1] }],
      monsters: [{ name: "Mock Bugbear", ac: 5, hd: "3+1", hpList: [22], move: '9"', attacksPerRound: "1",
        damage: "2-7", alignment: "CE", morale: 9, isUniqueOrNew: false, locationRef: "B", sourcePages: [1] }],
      locations: [
        { key: "A", name: "Shrine", kind: "dungeon-room", parentMap: "Mock Map", summary: "A small shrine.",
          occupantsRef: ["Mock Priest"], doors: [{ to: "B", state: "closed" }], lighting: "torch",
          approxDimensionsFeet: { w: 30, h: 30 }, sourcePages: [1] },
        { key: "B", name: "Guard Room", kind: "dungeon-room", parentMap: "Mock Map", summary: "Bugbear guard post.",
          occupantsRef: ["Mock Bugbear"], doors: [{ to: "A", state: "closed" }], lighting: null,
          approxDimensionsFeet: { w: 20, h: 20 }, sourcePages: [1] }
      ],
      rollTables: [{ name: "Mock Wandering", die: "d6", entries: [{ rangeLow: 1, rangeHigh: 3, result: "2 skeletons" }, { rangeLow: 4, rangeHigh: 6, result: "1 bugbear" }], sourcePages: [1] }],
      maps: [{ name: "Mock Map", pageGuess: 1, scaleNote: "1 square = 10 feet", keyedLocations: ["A", "B"] }]
    });
  }
  if (text.includes("map-plate cataloguer")) {
    return JSON.stringify({ isMap: true, title: "Mock Map", mapType: "dungeon", gridType: "square", scaleNote: "1 square = 10 feet", visibleKeys: ["A", "B"], multipleMaps: false });
  }
  if (text.includes("cartography engine")) {
    return JSON.stringify({
      name: "Mock Map", gridType: "square", gridWidth: 12, gridHeight: 8, feetPerSquare: 10,
      rooms: [{ key: "A", polygon: [[1, 1], [4, 1], [4, 4], [1, 4]], label: "Shrine" },
        { key: "B", polygon: [[5, 1], [8, 1], [8, 4], [5, 4]], label: "Guard Room" }],
      doors: [{ from: "A", to: "B", x1: 4, y1: 2, x2: 5, y2: 2, state: "closed" }],
      windows: [], lights: [{ x: 2, y: 2, radiusFeet: 20, note: "torch" }], stairs: [],
      tokenSpots: [{ ref: "Mock Priest", x: 2, y: 3 }, { ref: "Mock Bugbear", x: 6, y: 3 }]
    });
  }
  if (text.includes("repair malformed json")) return "{}";
  return JSON.stringify({ npcs: [], monsters: [], locations: [], rollTables: [], maps: [] });
}

export function startMockLLM(port = 8799) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url.includes("/chat/completions")) {
          const { messages } = JSON.parse(body || "{}");
          const content = llmReply(messages ?? []);
          res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
          res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
        } else { res.writeHead(404); res.end(); }
      });
    });
    server.listen(port, () => resolve(server));
  });
}

export function startMockComfy(port = 8800) {
  return new Promise((resolve) => {
    let lastSaveNode = "9";
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
        if (req.url.startsWith("/upload/image")) { res.writeHead(200, cors); res.end(JSON.stringify({ name: "bp.png", subfolder: "" })); }
        else if (req.url.startsWith("/prompt")) {
          // find the SaveImage node id so /history echoes outputs under it
          try {
            const { prompt } = JSON.parse(body || "{}");
            const found = Object.entries(prompt ?? {}).find(([, n]) => n.class_type === "SaveImage");
            if (found) lastSaveNode = found[0];
          } catch {}
          res.writeHead(200, cors); res.end(JSON.stringify({ prompt_id: "mock1" }));
        }
        else if (req.url.startsWith("/history")) {
          res.writeHead(200, cors);
          res.end(JSON.stringify({ mock1: { status: { status_str: "success" }, outputs: { [lastSaveNode]: { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } } }));
        }
        else if (req.url.startsWith("/view")) { res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" }); res.end(PNG_1x1); }
        else { res.writeHead(404); res.end(); }
      });
    });
    server.listen(port, () => resolve(server));
  });
}

// Allow standalone: `node mock-servers.js` to run both for manual poking.
if (import.meta.url === `file://${process.argv[1]}`) {
  await startMockLLM(); await startMockComfy();
  console.log("Mock LLM :8799, Mock ComfyUI :8800");
}

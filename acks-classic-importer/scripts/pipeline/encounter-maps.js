/**
 * Tactical encounter maps for wilderness terrain.
 *
 * When a hex/wilderness map is imported, the GM usually wants square-grid
 * "zoom-in" battle maps for random encounters. These are generated
 * PROCEDURALLY (seeded RNG) rather than by LLM layout — an encounter
 * clearing needs believable, reproducible obstacle scatter, not judgment —
 * and the obstacles double as tactical geometry:
 *
 *   - boulders / rock outcrops → sight + movement walls (hard cover)
 *   - tree clusters            → LIMITED-sight walls (see into the treeline,
 *                                 not through it); movement unblocked
 *   - cliffs / ridgelines      → hard wall lines
 *   - pools / streams / roads  → painted only (difficult/clear terrain is a
 *                                 ruling, not a wall)
 *
 * The same layout drives the drawn fallback renderer, the flat-color
 * ControlNet conditioning image, and per-obstacle regional prompts, so the
 * generated art and the walls always agree.
 */

/* ---------- seeded RNG (mulberry32) ---------- */
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- terrain specs (counts are [min,max]) ---------- */
const SPECS = {
  forest:    { ground: "#54743f", trees: [7, 11], rocks: [0, 2], pools: [0, 1], prompt: "dense temperate forest clearing, undergrowth, leaf litter" },
  hills:     { ground: "#8d7e52", trees: [1, 3], rocks: [4, 7], ridges: [1, 2], prompt: "rolling rocky hillside, scrub grass, exposed stone" },
  mountains: { ground: "#76716b", trees: [0, 1], rocks: [5, 8], ridges: [2, 3], cliffs: [1, 1], prompt: "high mountain scree slope, jagged outcrops, thin soil" },
  grassland: { ground: "#7da05a", trees: [1, 3], rocks: [1, 2], prompt: "open grassland meadow, tall grass, wildflowers" },
  swamp:     { ground: "#55603f", trees: [4, 6], pools: [4, 7], prompt: "murky swamp, standing water, gnarled roots, hanging moss" },
  desert:    { ground: "#cdb273", rocks: [2, 4], dunes: [2, 4], prompt: "arid desert, sand drifts, wind-carved rock" },
  water:     { ground: "#7da05a", waterEdge: true, trees: [2, 4], rocks: [1, 2], prompt: "riverbank, reeds, wet stones, flowing water along one side" },
  river:     { ground: "#7da05a", waterEdge: true, trees: [2, 4], rocks: [1, 2], prompt: "riverbank, reeds, wet stones, flowing water along one side" },
  road:      { ground: "#7da05a", road: true, trees: [2, 4], rocks: [0, 1], prompt: "rutted dirt road through open country, wagon tracks, verge grass" }
};
export const ENCOUNTER_TERRAINS = Object.keys(SPECS);

export function normalizeTerrain(t) {
  const s = String(t ?? "").toLowerCase();
  return SPECS[s] ? s : (s.includes("wood") || s.includes("forest")) ? "forest"
    : s.includes("hill") ? "hills"
    : s.includes("mount") || s.includes("peak") ? "mountains"
    : s.includes("swamp") || s.includes("marsh") || s.includes("bog") ? "swamp"
    : s.includes("desert") || s.includes("sand") ? "desert"
    : s.includes("river") || s.includes("lake") || s.includes("water") || s.includes("coast") ? "water"
    : s.includes("road") || s.includes("trail") || s.includes("pass") ? "road"
    : "grassland";
}

/**
 * @returns {{terrain, ground, obstacles:[{type,cx,cy,r}|{type,points}], prompt}}
 * Coordinates are GRID UNITS on a cols×rows field.
 */
export function generateEncounterLayout(terrain, cols = 30, rows = 20, seed = 1) {
  const t = normalizeTerrain(terrain);
  const spec = SPECS[t];
  const r = rng(seed);
  const between = ([lo, hi]) => lo + Math.floor(r() * (hi - lo + 1));
  const obstacles = [];
  const place = (type, count, rad) => {
    for (let i = 0; i < count; i++) {
      obstacles.push({
        type,
        cx: 2 + r() * (cols - 4),
        cy: 2 + r() * (rows - 4),
        r: rad[0] + r() * (rad[1] - rad[0])
      });
    }
  };
  if (spec.trees) place("trees", between(spec.trees), [1.2, 2.6]);
  if (spec.rocks) place("rocks", between(spec.rocks), [0.7, 1.6]);
  if (spec.pools) place("pool", between(spec.pools), [1.0, 2.2]);
  if (spec.dunes) place("dune", between(spec.dunes), [2.0, 4.0]);
  if (spec.ridges) {
    for (let i = 0, n = between(spec.ridges); i < n; i++) {
      const y = 3 + r() * (rows - 6);
      obstacles.push({ type: "ridge", points: wobblyLine(0, y, cols, y + (r() - 0.5) * 4, 6, r) });
    }
  }
  if (spec.cliffs) {
    const y = 4 + r() * (rows - 8);
    obstacles.push({ type: "cliff", points: wobblyLine(cols * 0.15, y, cols * 0.85, y + (r() - 0.5) * 3, 5, r) });
  }
  if (spec.waterEdge) {
    const side = r() < 0.5 ? "left" : "bottom";
    obstacles.push({ type: "water-band", side, width: 3 + r() * 3 });
  }
  if (spec.road) {
    const y = rows * (0.3 + r() * 0.4);
    obstacles.push({ type: "road", points: wobblyLine(0, y, cols, y + (r() - 0.5) * 5, 5, r) });
  }
  // keep solid obstacles from overlapping too hard
  dedupeCircles(obstacles, 1.2);
  return { terrain: t, ground: spec.ground, obstacles, prompt: spec.prompt };
}

function wobblyLine(x1, y1, x2, y2, segs, r) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const f = i / segs;
    pts.push([x1 + (x2 - x1) * f, y1 + (y2 - y1) * f + (i && i < segs ? (r() - 0.5) * 2 : 0)]);
  }
  return pts;
}
function dedupeCircles(obstacles, minGap) {
  const circ = obstacles.filter((o) => o.cx !== undefined);
  for (let i = 0; i < circ.length; i++) for (let j = i + 1; j < circ.length; j++) {
    const a = circ[i], b = circ[j];
    const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const need = a.r + b.r + minGap;
    if (d < need && d > 0) { const push = (need - d) / 2; const ux = (b.cx - a.cx) / d, uy = (b.cy - a.cy) / d; b.cx += ux * push; b.cy += uy * push; }
  }
}

/* ---------- renderers ---------- */
const OBSTACLE_COLORS = {
  trees: "#2f4d2a", rocks: "#6e6a66", pool: "#3f76a8", dune: "#bfa55f",
  ridge: "#7a6c48", cliff: "#4f4a45", road: "#9c7a4f", "water-band": "#2e5d8a"
};

export function renderEncounterMap(layout, px, W, H, { control = false } = {}) {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = layout.ground; ctx.fillRect(0, 0, W, H);
  const G = (u) => u * px;
  for (const o of layout.obstacles) {
    ctx.fillStyle = ctx.strokeStyle = OBSTACLE_COLORS[o.type] ?? "#555";
    if (o.type === "water-band") {
      if (o.side === "left") ctx.fillRect(0, 0, G(o.width), H);
      else ctx.fillRect(0, H - G(o.width), W, G(o.width));
    } else if (o.points) {
      ctx.lineWidth = px * (o.type === "road" ? 0.8 : o.type === "cliff" ? 0.35 : 0.5);
      ctx.lineCap = "round";
      ctx.beginPath();
      o.points.forEach(([x, y], i) => i ? ctx.lineTo(G(x), G(y)) : ctx.moveTo(G(x), G(y)));
      ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(G(o.cx), G(o.cy), G(o.r), 0, Math.PI * 2); ctx.fill();
      if (!control && o.type === "trees") { // canopy texture dots
        ctx.fillStyle = "#3c6135";
        for (let i = 0; i < 6; i++) {
          ctx.beginPath();
          ctx.arc(G(o.cx) + (Math.cos(i) * G(o.r)) * 0.5, G(o.cy) + (Math.sin(i * 2) * G(o.r)) * 0.5, G(o.r) * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  if (!control) { // grid on the player-facing fallback only
    ctx.strokeStyle = "rgba(0,0,0,0.15)"; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += px) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += px) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  }
  return c.toDataURL("image/png");
}

/* ---------- walls from obstacles ---------- */
export function wallsForEncounter(layout, px) {
  const walls = [];
  const G = (u) => Math.round(u * px);
  const octagon = (o) => {
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i;
      pts.push([G(o.cx + Math.cos(a) * o.r), G(o.cy + Math.sin(a) * o.r)]);
    }
    return pts;
  };
  for (const o of layout.obstacles) {
    if (o.type === "rocks") {
      const pts = octagon(o);
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        walls.push({ c: [x1, y1, x2, y2] }); // blocks sight + movement
      }
    } else if (o.type === "trees") {
      const pts = octagon(o);
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        walls.push({
          c: [x1, y1, x2, y2],
          sight: CONST.WALL_SENSE_TYPES.LIMITED,   // see in, not through
          move: CONST.WALL_MOVEMENT_TYPES.NONE     // can move through brush
        });
      }
    } else if (o.type === "cliff" && o.points) {
      for (let i = 0; i < o.points.length - 1; i++) {
        const [x1, y1] = o.points[i], [x2, y2] = o.points[i + 1];
        walls.push({ c: [G(x1), G(y1), G(x2), G(y2)], sight: CONST.WALL_SENSE_TYPES.NONE }); // edge: blocks movement, not sight
      }
    }
    // pools, dunes, ridges, roads, water bands: painted only — terrain rulings, not walls
  }
  return walls;
}

/** Regional prompts for image generation, one per sizable obstacle. */
export function encounterRegions(layout, px) {
  const prompts = { trees: "dense tree canopy from above", rocks: "large grey boulder cluster", pool: "murky standing water", dune: "wind-rippled sand dune", road: "rutted dirt road", "water-band": "flowing river water", ridge: "raised rocky ridgeline", cliff: "sheer cliff edge with shadow" };
  return layout.obstacles
    .filter((o) => o.cx !== undefined && o.r >= 1.0)
    .map((o) => ({
      x: Math.round((o.cx - o.r) * px), y: Math.round((o.cy - o.r) * px),
      w: Math.round(o.r * 2 * px), h: Math.round(o.r * 2 * px),
      prompt: `top-down: ${prompts[o.type] ?? o.type}, no text`
    }));
}

/**
 * Journal entries for keyed locations and RollTables for rumor/encounter
 * tables. Journal pages hold the importer's own concise summaries plus the
 * full mechanical breakdown — not page-for-page reproductions of the source.
 */

export async function buildJournals(extracted, sceneByMap, folderId) {
  const byMap = new Map();
  for (const loc of extracted.locations ?? []) {
    const key = loc.parentMap ?? "General";
    if (!byMap.has(key)) byMap.set(key, []);
    byMap.get(key).push(loc);
  }

  const journals = [];
  for (const [mapName, locs] of byMap) {
    const pages = locs.map((loc) => ({
      name: `${loc.key}. ${loc.name}`,
      type: "text",
      text: { format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML, content: locationHtml(loc) }
    }));
    const journal = await JournalEntry.create({
      name: `Locations — ${mapName}`,
      folder: folderId,
      pages
    });
    journals.push(journal);

    // Map notes: pin each page onto its scene at the room key position.
    const scene = sceneByMap.get(mapName);
    const layout = scene?.flags?.["acks-classic-importer"]?.layout;
    if (scene && layout) {
      const notes = [];
      const px = scene.grid.size, off = px;
      const isHex = scene.flags["acks-classic-importer"].hex;
      for (const page of journal.pages) {
        const key = page.name.split(".")[0].trim();
        if (isHex) {
          // Hex wilderness: match by feature name token overlap.
          const feat = (layout.features ?? []).find((f) =>
            String(f.name ?? "").toLowerCase().includes(key.toLowerCase()) ||
            page.name.toLowerCase().includes(String(f.name ?? "").toLowerCase())
          );
          if (!feat) continue;
          const x = off * 0.75 + (feat.col + (feat.row % 2 ? 0.5 : 0)) * px;
          const y = off * 0.75 + feat.row * px * 0.866;
          notes.push({ entryId: journal.id, pageId: page.id, x: Math.round(x), y: Math.round(y), text: page.name, fontSize: 24 });
          continue;
        }
        const room = (layout.rooms ?? []).find((r) => String(r.key).trim() === key);
        if (!room) continue;
        const cx = room.polygon.reduce((s, p) => s + p[0], 0) / room.polygon.length;
        const cy = room.polygon.reduce((s, p) => s + p[1], 0) / room.polygon.length;
        notes.push({
          entryId: journal.id, pageId: page.id,
          x: off + cx * px, y: off + cy * px,
          text: page.name, fontSize: 24
        });
      }
      if (notes.length) await scene.createEmbeddedDocuments("Note", notes);
    }
  }
  return journals;
}

function locationHtml(loc) {
  const li = (arr) => (arr ?? []).map((x) => `<li>${escape(x)}</li>`).join("");
  return `
    ${loc.readAloud ? `<blockquote>${escape(loc.readAloud)}</blockquote>` : ""}
    <p>${escape(loc.summary ?? "")}</p>
    ${loc.occupantsRef?.length ? `<p><strong>Occupants:</strong> ${loc.occupantsRef.map(escape).join(", ")}</p>` : ""}
    ${loc.lighting ? `<p><strong>Lighting:</strong> ${escape(loc.lighting)}</p>` : ""}
    ${loc.traps?.length ? `<h4>Traps</h4><ul>${li(loc.traps)}</ul>` : ""}
    ${loc.treasure?.length ? `<h4>Treasure</h4><ul>${li(loc.treasure)}</ul>` : ""}
    ${loc.doors?.length ? `<h4>Exits</h4><ul>${loc.doors.map((d) => `<li>${escape(d.to ?? "?")} — ${escape(d.state ?? "open")}${d.notes ? ` (${escape(d.notes)})` : ""}</li>`).join("")}</ul>` : ""}
    <p><small>Source pages: ${loc.sourcePages?.join(", ") ?? "?"}</small></p>`;
}

export async function buildRollTables(extracted, folderId) {
  const tables = [];
  for (const t of extracted.rollTables ?? []) {
    const dieMatch = String(t.die ?? "").match(/d(\d+)/i);
    const faces = dieMatch ? parseInt(dieMatch[1], 10) : 100;
    const results = (t.entries ?? []).map((e) => ({
      type: CONST.TABLE_RESULT_TYPES.TEXT,
      text: e.result,
      range: [e.rangeLow, e.rangeHigh],
      weight: 1
    }));
    tables.push(await RollTable.create({
      name: t.name,
      folder: folderId,
      formula: `1d${faces}`,
      results,
      replacement: true
    }));
  }
  return tables;
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

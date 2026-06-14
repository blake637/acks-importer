/**
 * Splits raw PDF text into chunks suitable for LLM extraction.
 * Classic TSR modules are organized by ALL-CAPS section headers and lettered/
 * numbered encounter keys, so we prefer to break on those boundaries.
 */

const HEADER_RE = /^\s{0,4}([A-Z][A-Z0-9 ,'./&-]{4,60}|\d{1,3}[a-c]?\.\s+[A-Z].{2,60}|[A-Z]{1,2}\.\s+[A-Z].{2,60})\s*$/;

export function chunkText(pages, { maxChars = 18000, overlap = 800 } = {}) {
  // pages: [{ page: n, text: "..." }]
  const lines = [];
  for (const p of pages) {
    for (const line of p.text.split(/\r?\n/)) {
      lines.push({ page: p.page, line });
    }
  }

  // Find candidate section boundaries.
  const boundaries = [0];
  lines.forEach((l, i) => {
    if (HEADER_RE.test(l.line)) boundaries.push(i);
  });
  boundaries.push(lines.length);

  // Greedily pack sections into chunks under maxChars.
  const chunks = [];
  let buf = [], bufLen = 0, startPage = lines[0]?.page ?? 1;
  const flush = () => {
    if (!buf.length) return;
    chunks.push({
      text: buf.map((l) => l.line).join("\n"),
      pageStart: startPage,
      pageEnd: buf[buf.length - 1].page
    });
    // seed overlap from the tail of the previous chunk
    let tail = [], len = 0;
    for (let i = buf.length - 1; i >= 0 && len < overlap; i--) {
      tail.unshift(buf[i]);
      len += buf[i].line.length + 1;
    }
    buf = tail.slice();
    bufLen = len;
    startPage = buf[0]?.page ?? startPage;
  };

  for (let b = 0; b < boundaries.length - 1; b++) {
    const section = lines.slice(boundaries[b], boundaries[b + 1]);
    const secLen = section.reduce((n, l) => n + l.line.length + 1, 0);
    if (bufLen + secLen > maxChars && bufLen > 0) flush();
    if (!buf.length) startPage = section[0]?.page ?? startPage;
    buf.push(...section);
    bufLen += secLen;
    // pathological case: single section larger than maxChars
    while (bufLen > maxChars * 1.5) {
      const cut = buf.splice(0, Math.floor(buf.length / 2));
      const cutLen = cut.reduce((n, l) => n + l.line.length + 1, 0);
      chunks.push({
        text: cut.map((l) => l.line).join("\n"),
        pageStart: cut[0].page,
        pageEnd: cut[cut.length - 1].page
      });
      bufLen -= cutLen;
      startPage = buf[0]?.page ?? startPage;
    }
  }
  flush();
  return chunks;
}

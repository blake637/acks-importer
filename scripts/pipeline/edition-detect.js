/**
 * Edition detection. Scores the extracted text against marker patterns for
 * 5th-edition vs. classic-era (B/X, AD&D 1e/2e) stat conventions. The GM can
 * override via the sourceEdition setting; "auto" uses this.
 */

const MARKERS_5E = [
  /challenge\s+\d+(?:\/\d+)?\s*\(\s*[\d,]+\s*xp\s*\)/gi, // "Challenge 3 (700 XP)"
  /proficiency bonus/gi,
  /passive perception/gi,
  /spell save dc/gi,
  /legendary actions?/gi,
  /\bbonus action\b/gi,
  /\bdc\s+\d+\s+(strength|dexterity|constitution|intelligence|wisdom|charisma)\b/gi,
  /\bhit:\s*\d+\s*\(\d+d\d+/gi,                          // "Hit: 7 (1d8 + 3)"
  /\bstr\b\s+\d+\s*\([+-]\d+\)/gi                        // ability score w/ modifier
];

const MARKERS_CLASSIC = [
  /\bthac0\b/gi,
  /#\s*AT\b/g,                                            // "#AT 1"
  /\bMV\s*\d+"/g,                                         // movement in inches
  /\bsave\s+vs\.?\s+(poison|spells?|paralyzation|petrification|wands?|breath)/gi,
  /\bAL\s+(LG|LN|LE|NG|N|NE|CG|CN|CE)\b/g,
  /\bAC:\s*-?\d\b/g,                                      // terse descending AC
  /\bD\s+\d+-\d+\b/g                                      // damage as "D 2-7"
];

export function detectEdition(pages) {
  const text = pages.map((p) => p.text).join("\n");
  const score = (markers) =>
    markers.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
  const five = score(MARKERS_5E);
  const classic = score(MARKERS_CLASSIC);
  const edition = five > classic * 1.2 ? "5e" : "classic";
  return { edition, scores: { fiveE: five, classic } };
}

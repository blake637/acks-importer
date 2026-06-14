/**
 * Minimal Foundry-globals shim for Node-side unit testing.
 *
 * The pipeline modules are written for the browser/Foundry runtime and
 * reference a handful of globals at module-evaluation or call time
 * (CONST.*, foundry.utils.*, etc.). We are NOT testing Foundry integration —
 * only the pure parsing/generation logic — so these stubs exist purely to let
 * the modules import without throwing. Anything that actually talks to Foundry
 * (Actor.create, FilePicker, Scene…) is simply absent and must not be reached
 * by the functions under test.
 *
 * Import this for side effects BEFORE importing any pipeline module:
 *   import "./foundry-shim.js";
 */

globalThis.CONST = globalThis.CONST ?? {
  WALL_DOOR_TYPES: { DOOR: 1, SECRET: 2 },
  WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  WALL_SENSE_TYPES: { NONE: 0, LIMITED: 10, NORMAL: 20 },
  WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
  GRID_TYPES: { SQUARE: 1, HEXODDR: 2 },
  TOKEN_DISPLAY_MODES: { NONE: 0, HOVER: 30, OWNER: 40 },
  TOKEN_DISPOSITIONS: { HOSTILE: -1, NEUTRAL: 0, FRIENDLY: 1 },
  TABLE_RESULT_TYPES: { TEXT: 0 },
  JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1 }
};

globalThis.foundry = globalThis.foundry ?? {
  utils: {
    deepClone: (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o))),
    mergeObject: (a, b) => Object.assign(a ?? {}, b ?? {}),
    setProperty: (obj, path, value) => {
      const parts = String(path).split(".");
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ??= {};
      cur[parts[parts.length - 1]] = value;
      return true;
    },
    randomID: () => Math.random().toString(36).slice(2, 12)
  }
};

// Settings accessor used by some modules; tests that need specific values can
// override globalThis.__ACKS_SETTINGS before importing.
globalThis.__ACKS_SETTINGS = globalThis.__ACKS_SETTINGS ?? {};

// `game` is referenced only inside settings.js functions (never at import
// time), but provide a stub so any incidental access during a test resolves
// to the override map rather than throwing.
globalThis.game = globalThis.game ?? {
  settings: {
    register: () => {},
    registerMenu: () => {},
    get: (_module, key) => globalThis.__ACKS_SETTINGS[key]
  },
  system: { id: "acks" },
  modules: { get: () => ({}) }
};

// `document`/`Image`/canvas are only used by RENDERERS, which the unit tests
// avoid. If a test imports a module that references them at top level (it
// shouldn't), provide harmless no-ops.
if (typeof globalThis.document === "undefined") {
  globalThis.document = { createElement: () => { throw new Error("canvas not available in Node tests — do not exercise renderers here"); } };
}

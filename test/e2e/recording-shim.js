/**
 * End-to-end recording shim.
 *
 * Unlike the unit-test shim (which only lets pure modules import), this stands
 * in for the *whole* Foundry runtime so the real ImporterApp.run() pipeline
 * can execute headlessly against live LLM/image APIs. Nothing is mocked away
 * — Foundry document creation is RECORDED: every Actor/Scene/Journal/RollTable
 * /Folder/Wall/Light/Token/Note the pipeline would create is captured with its
 * full data so it can be written to disk and inspected.
 *
 * Interactive gates (review checkpoints, malformed-output recovery) are
 * auto-resolved to their non-blocking default so the run is unattended.
 *
 * Install by importing for side effects BEFORE importing any pipeline module.
 */

import { createCanvas, Image as NapiImage, loadImage } from "@napi-rs/canvas";
import { setGlobalDispatcher, Agent } from "undici";

// Node's fetch (undici) caps "time to response headers" and "time between body
// chunks" at ~300s by default, INDEPENDENT of any AbortSignal. A non-streaming
// LLM call to a slow local reasoning model sends nothing until generation
// finishes, so that cap can fire mid-call. Disable both here (0 = no limit) so
// the LLMClient's own configurable AbortSignal timeout (default 600s, min 5
// min) is the single governing ceiling for the e2e harness.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

export const REC = {
  actors: [], scenes: [], journals: [], tables: [], folders: [],
  embedded: [],            // {parent, type, data}
  notifications: [],       // {level, msg}
  files: [],               // {dir, name, bytes}
  errors: []
};

let _id = 0;
const nextId = (p) => `${p}${String(++_id).padStart(5, "0")}`;

/* ---------- canvas + image (real, via @napi-rs/canvas) ---------- */
globalThis.document = globalThis.document ?? {
  createElement: (tag) => {
    if (tag === "canvas") return createCanvas(8, 8);
    if (tag === "img") return new NapiImage();
    return {};
  }
};
// Some renderers do `new Image()`; @napi-rs Image takes no-arg construction.
globalThis.Image = NapiImage;
globalThis.__loadImage = loadImage; // exposed for any future use

// FileReader (used by image-client blobToDataUrl + uploadDataUrl path)
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((ab) => {
      const b64 = Buffer.from(ab).toString("base64");
      const type = blob.type || "image/png";
      this.result = `data:${type};base64,${b64}`;
      this.onload?.();
    }).catch((e) => this.onerror?.(e));
  }
};
globalThis.File = globalThis.File ?? class extends Blob { constructor(parts, name, opts) { super(parts, opts); this.name = name; } };
globalThis.FormData = globalThis.FormData ?? (await import("node:buffer")).Blob ? globalThis.FormData : undefined;

/* ---------- CONST ---------- */
globalThis.CONST = {
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

/* ---------- foundry.utils ---------- */
globalThis.foundry = {
  utils: {
    deepClone: (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o))),
    mergeObject: (a, b) => { deepMerge(a, b); return a; },
    setProperty: (obj, path, value) => {
      const parts = String(path).split("."); let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ??= {};
      cur[parts[parts.length - 1]] = value; return true;
    },
    getProperty: (obj, path) => String(path).split(".").reduce((o, k) => o?.[k], obj),
    randomID: () => Math.random().toString(36).slice(2, 12)
  }
};
function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) { a[k] = a[k] ?? {}; deepMerge(a[k], v); }
    else a[k] = v;
  }
}

/* ---------- recording document base ---------- */
class RecDoc {
  constructor(data, store, prefix) {
    Object.assign(this, foundry.utils.deepClone(data));
    this.id = this.id ?? nextId(prefix);
    this._embedded = [];
    store.push(this);
  }
  get uuid() { return `${this.constructor.name}.${this.id}`; }
  async createEmbeddedDocuments(type, dataArray) {
    const made = (dataArray ?? []).map((d) => {
      const doc = { ...foundry.utils.deepClone(d), id: nextId(type.toLowerCase()) };
      this._embedded.push({ type, data: doc });
      REC.embedded.push({ parent: this.uuid, parentName: this.name, type, data: doc });
      return doc;
    });
    return made;
  }
  toObject() { return foundry.utils.deepClone(this); }
  update(data) { deepMerge(this, data); return this; }
}

class RecActor extends RecDoc {
  constructor(d) { super(d, REC.actors, "actor"); this.items = []; }
  get prototypeToken() {
    const pt = this.prototypeToken_ ?? { texture: {}, name: this.name };
    return { ...pt, toObject: () => foundry.utils.deepClone(pt) };
  }
  set prototypeToken(v) { this.prototypeToken_ = v; }
  async createEmbeddedDocuments(type, dataArray) {
    const made = await super.createEmbeddedDocuments(type, dataArray);
    if (type === "Item") this.items.push(...made);
    return made;
  }
}

globalThis.Actor = class {
  static async create(data) { return new RecActor(data); }
  static async importFromCompendium(_pack, id) { return new RecActor({ name: `imported-${id}`, type: "monster" }); }
};
globalThis.Scene = class { static async create(data) { return new RecDoc(data, REC.scenes, "scene"); } };
globalThis.JournalEntry = class {
  static async create(data) {
    const doc = new RecDoc(data, REC.journals, "journal");
    doc.pages = (data.pages ?? []).map((p, i) => ({ ...p, id: nextId("page") }));
    return doc;
  }
};
globalThis.RollTable = class { static async create(data) { return new RecDoc(data, REC.tables, "table"); } };
globalThis.Folder = class { static async create(data) { return new RecDoc(data, REC.folders, "folder"); } };

globalThis.fromUuid = async (uuid) => REC.actors.find((a) => a.uuid === uuid) ?? null;

/* ---------- FilePicker (records uploads) ---------- */
globalThis.FilePicker = class {
  static async createDirectory() { return true; }
  static async upload(_src, dir, file) {
    const bytes = Buffer.from(await file.arrayBuffer());
    REC.files.push({ dir, name: file.name, size: bytes.length, bytes });
    return { path: `${dir}/${file.name}` };
  }
};

/* ---------- Dialog: auto-resolve interactive gates ---------- */
globalThis.Dialog = class {
  constructor(cfg) { this.cfg = cfg; }
  render() {
    // Review checkpoints have a "skip"/"Continue unchanged" or default button;
    // recovery dialogs have skip/stop/retry/use. For an unattended run we
    // always pick the least-destructive continue: "skip" if present, else the
    // default button, invoked with an empty jQuery-like element.
    const buttons = this.cfg.buttons ?? {};
    const pick = buttons.skip ? "skip"
      : (this.cfg.default && buttons[this.cfg.default]) ? this.cfg.default
      : Object.keys(buttons)[0];
    const fakeHtml = { find: () => ({ val: () => "" }) };
    try { buttons[pick]?.callback?.(fakeHtml); }
    catch (e) { REC.errors.push({ where: "Dialog auto-resolve", error: String(e?.message ?? e) }); }
    REC.notifications.push({ level: "dialog", msg: `auto-resolved "${this.cfg.title}" → ${pick}` });
    return this;
  }
};

/* ---------- ui.notifications ---------- */
globalThis.ui = { notifications: {
  info: (m) => REC.notifications.push({ level: "info", msg: m }),
  warn: (m) => REC.notifications.push({ level: "warn", msg: m }),
  error: (m) => REC.notifications.push({ level: "error", msg: m })
} };

/* ---------- saveDataToFile (debug log export) ---------- */
globalThis.saveDataToFile = (data, _type, name) => { REC.files.push({ dir: "exports", name, size: data.length, text: data }); };

/* ---------- game / settings ---------- */
globalThis.__ACKS_SETTINGS = {};
globalThis.game = {
  user: { isGM: true },
  system: { id: "acks" },
  world: { id: "e2e-test-world" },
  actors: Object.assign([], { get: (id) => REC.actors.find((a) => a.id === id) }),
  packs: { get: () => null },
  folders: Object.assign([], { find: () => null }),
  modules: { get: () => ({ api: {} }) },
  settings: {
    register: () => {}, registerMenu: () => {},
    get: (_m, k) => globalThis.__ACKS_SETTINGS[k]
  }
};

/* ---------- Hooks (no-op) ---------- */
globalThis.Hooks = { once: () => {}, on: () => {}, callAll: () => {} };

/* ---------- Application base (ImporterApp extends it) ---------- */
globalThis.Application = class {
  constructor(opts = {}) { this.options = opts; }
  static get defaultOptions() { return {}; }
  render() { return this; }
  activateListeners() {}
};
globalThis.$ = () => ({ on: () => {}, append: () => {}, find: () => ({ on: () => {}, val: () => "" }), addClass: () => {}, removeClass: () => {} });

export { createCanvas };

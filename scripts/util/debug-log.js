/**
 * AI-call debug log + interactive malformed-output recovery.
 *
 * Every LLM and image-generation call is recorded (label, provider/model,
 * full prompts, raw response or image thumbnail, duration, status). The
 * inspector dialog lists calls newest-first with expandable detail, and the
 * whole log exports as JSON for bug reports.
 *
 * When an LLM returns unparseable JSON (after one automatic repair attempt),
 * recoverMalformedOutput() gives the GM four choices:
 *   1. Retry the generation
 *   2. Fix the output by hand (validated before acceptance)
 *   3. Continue regardless (the call resolves to null; callers degrade)
 *   4. Stop the pipeline (throws PipelineAbortError)
 */

export class PipelineAbortError extends Error {
  constructor(message = "Pipeline stopped by user") {
    super(message);
    this.name = "PipelineAbortError";
  }
}

class DebugLogClass {
  constructor() {
    this.entries = [];
    this.max = 300;
    this._id = 0;
    // Optional sink invoked whenever the log changes (a call is recorded or
    // settled). The e2e harness uses it to flush the log to disk synchronously,
    // so even a native crash that aborts the process leaves a full paper trail.
    this.onChange = null;
  }

  /** Record a call; returns the (mutable) entry so the caller can attach the
   *  response/status when the call settles. */
  record(data) {
    const entry = { id: ++this._id, time: new Date().toISOString(), status: "pending", ...data };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    this.touch();
    return entry;
  }

  /** Notify the change sink (no-op unless one is attached). */
  touch() { try { this.onChange?.(this.entries); } catch { /* logging must never break the run */ } }

  get count() { return this.entries.length; }

  clear() { this.entries = []; }

  export() {
    const safe = this.entries.map((e) => ({
      ...e,
      thumbnail: e.thumbnail ? "(image omitted from export — see session)" : undefined,
      inputImages: e.inputImages?.length ? `(${e.inputImages.length} input image(s) omitted from export — see session)` : undefined
    }));
    saveDataToFile(JSON.stringify(safe, null, 2), "text/json", `acks-importer-ai-log-${Date.now()}.json`);
  }

  openInspector() {
    const rows = [...this.entries].reverse().map((e) => `
      <details class="aci-call ${e.status}">
        <summary>
          <span class="aci-call-id">#${e.id}</span>
          <span class="aci-call-kind">${e.kind}</span>
          <span class="aci-call-label">${esc(e.label ?? "")}</span>
          <span class="aci-call-status">${e.status}${e.ms ? ` · ${(e.ms / 1000).toFixed(1)}s` : ""}</span>
        </summary>
        <div class="aci-call-body">
          <p><strong>${esc(e.provider ?? "")} ${esc(e.model ?? "")}</strong> ${e.images ? `· ${e.images} image input(s)` : ""} ${e.regions ? `· ${e.regions} region prompt(s)` : ""}</p>
          ${e.system ? `<h4>System prompt</h4><pre>${esc(clip(e.system))}</pre>` : ""}
          ${e.prompt ? `<h4>Prompt</h4><pre>${esc(clip(e.prompt))}</pre>` : ""}
          ${e.user ? `<h4>User content</h4><pre>${esc(clip(e.user))}</pre>` : ""}
          ${e.inputImages?.length ? `<h4>Image input(s) sent to the model</h4><div class="aci-inputs">${e.inputImages.map((t) => `<img class="aci-thumb" src="${t}" />`).join("")}</div>` : ""}
          ${e.response ? `<h4>Response</h4><pre>${esc(clip(e.response))}</pre>` : ""}
          ${e.thumbnail ? `<h4>Result</h4><img class="aci-thumb" src="${e.thumbnail}" />` : ""}
          ${e.error ? `<h4>Error</h4><pre class="aci-error">${esc(clip(e.error))}</pre>` : ""}
          ${e.note ? `<p><em>${esc(e.note)}</em></p>` : ""}
        </div>
      </details>`).join("");

    new Dialog({
      title: `AI Call Inspector (${this.entries.length} calls this session)`,
      content: `<div class="aci-inspector">${rows || "<p>No AI calls recorded yet.</p>"}</div>`,
      buttons: {
        export: { icon: '<i class="fas fa-download"></i>', label: "Export JSON", callback: () => { this.export(); return false; } },
        clear: { icon: '<i class="fas fa-trash"></i>', label: "Clear log", callback: () => this.clear() },
        close: { label: "Close" }
      },
      default: "close"
    }, { width: 860, height: 600, resizable: true, classes: ["dialog", "aci-inspector-dialog"] }).render(true);
  }
}

export const DebugLog = new DebugLogClass();

/** Downscale an image dataUrl to a thumbnail for the inspector / e2e artifacts.
 *  512 keeps map detail legible (the full-res image is still saved separately). */
export async function makeThumbnail(dataUrl, maxDim = 512) {
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const s = Math.min(1, maxDim / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  } catch (_e) { return null; }
}

/**
 * Interactive recovery for malformed LLM output.
 * @returns {Promise<{action:"retry"|"use"|"skip"|"stop", edited?:string}>}
 */
export function recoverMalformedOutput({ label, raw, hint = null }) {
  return new Promise((resolve) => {
    new Dialog({
      title: `Malformed LLM output — ${label}`,
      content: `
        <p>The model's response could not be parsed as JSON (automatic repair was already attempted).
        You can edit it below and use your fixed version, retry the generation, continue without this
        result, or stop the whole import.</p>
        ${hint ? `<p class="aci-hint"><i class="fas fa-circle-info"></i> ${esc(hint)}</p>` : ""}
        <textarea class="aci-fix" style="width:100%;height:380px;font-family:monospace;">${esc(raw ?? "")}</textarea>`,
      buttons: {
        retry: { icon: '<i class="fas fa-rotate"></i>', label: "Retry generation", callback: () => resolve({ action: "retry" }) },
        use:   { icon: '<i class="fas fa-wrench"></i>', label: "Use my fix", callback: (html) => resolve({ action: "use", edited: html.find("textarea").val() }) },
        skip:  { icon: '<i class="fas fa-forward"></i>', label: "Continue without it", callback: () => resolve({ action: "skip" }) },
        stop:  { icon: '<i class="fas fa-stop"></i>', label: "Stop pipeline", callback: () => resolve({ action: "stop" }) }
      },
      default: "retry",
      close: () => resolve({ action: "skip" }) // closing the dialog = least destructive choice
    }, { width: 820 }).render(true);
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function clip(s, n = 6000) {
  const str = String(s ?? "");
  return str.length > n ? `${str.slice(0, n)}\n… [${str.length - n} more chars — use Export JSON for the full text]` : str;
}

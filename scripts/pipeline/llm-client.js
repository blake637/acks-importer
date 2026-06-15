/**
 * Minimal LLM client. Supports the Anthropic Messages API, OpenAI-compatible
 * chat completions (including local servers: llama.cpp's llama-server,
 * Ollama, LM Studio, vLLM, etc.), and llama.cpp's NATIVE /completion API.
 * All extraction calls request strict JSON and are parsed defensively (the
 * model is instructed to emit JSON only; we still strip code fences and
 * retry once on parse failure).
 *
 * Local-server notes:
 *  - An API key is OPTIONAL when a custom endpoint is set; the Authorization
 *    header is simply omitted if blank (llama-server/Ollama don't need one).
 *  - Bare endpoints like "http://localhost:8080" are normalized to
 *    ".../v1/chat/completions". If you explicitly point at llama.cpp's native
 *    "/completion" route, we speak that protocol ({prompt, n_predict})
 *    instead of OpenAI chat format.
 */

import { getSetting } from "../settings.js";
import { warn } from "../util/logger.js";
import { DebugLog, makeThumbnail, recoverMalformedOutput, PipelineAbortError } from "../util/debug-log.js";

export class LLMClient {
  constructor() {
    this.provider = getSetting("llmProvider");
    this.key = getSetting("llmApiKey");
    this.model = getSetting("llmModel");
    this.endpoint = normalizeEndpoint(getSetting("llmEndpoint"), this.provider);
    this.dialect = detectDialect(this.endpoint, this.provider);
    // A configured endpoint means a local / self-hosted server. We do NOT cap
    // output tokens there: thinking models (Qwen, DeepSeek-style) spend their
    // budget on hidden reasoning and a low cap truncates them before they emit
    // the answer. Hosted providers still get a cap (and Anthropic requires one).
    this.local = !!String(getSetting("llmEndpoint") ?? "").trim();
    // Per-request timeout. Browser fetch has no default ceiling and uncapped
    // local reasoning models can run for minutes, so make it explicit and
    // generous (configurable in settings).
    this.timeoutMs = Math.max(30, Number(getSetting("llmTimeoutSec")) || 600) * 1000;
  }

  /** fetch() with the configured timeout and a clear message when it trips. */
  async #fetch(url, opts) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError" || /timeout|timed out|aborted|headers timeout|body timeout/i.test(String(e?.message ?? e))) {
        throw new Error(`LLM request timed out after ${Math.round(this.timeoutMs / 1000)}s (${url}). Raise "LLM request timeout" in module settings, or shorten the model's output/reasoning.`);
      }
      throw e;
    }
  }

  /**
   * @param {string} system    system prompt
   * @param {Array} content    array of {type:"text",text} and/or {type:"image", dataUrl}
   * @param {number} maxTokens output-token cap for hosted providers (Anthropic
   *                           requires it). Ignored for local/self-hosted
   *                           endpoints, which run uncapped.
   * @param {object} opts      { label } — stage label for the AI call inspector
   * @returns {Promise<string>} raw text response
   */
  async complete(system, content, maxTokens = 16000, { label = "LLM call" } = {}) {
    // A key is mandatory only for the hosted defaults; local/custom endpoints
    // may run keyless.
    if (!this.key && !getSetting("llmEndpoint")) {
      throw new Error("No LLM API key configured (module settings). For a local server, set the endpoint URL instead — a key is optional there.");
    }
    const imageParts = content.filter((c) => c.type === "image");
    const entry = DebugLog.record({
      kind: "llm", label,
      provider: this.dialect, model: this.model, endpoint: this.endpoint,
      system,
      user: content.filter((c) => c.type === "text").map((c) => c.text).join("\n\n"),
      images: imageParts.length
    });
    // Keep a thumbnail of every image we actually send, so the inspector / e2e
    // artifacts show exactly what the model saw (not just a count).
    if (imageParts.length) {
      entry.inputImages = (await Promise.all(imageParts.map((c) => makeThumbnail(c.dataUrl, 512)))).filter(Boolean);
    }
    const started = Date.now();
    try {
      let raw;
      this._lastMeta = null;
      if (this.dialect === "anthropic") raw = await this.#anthropic(system, content, maxTokens);
      else if (this.dialect === "llamacpp") raw = await this.#llamacpp(system, content, maxTokens);
      else raw = await this.#openai(system, content, maxTokens);
      entry.response = raw;
      entry.status = "ok";
      entry.ms = Date.now() - started;
      if (this._lastMeta?.finishReason && this._lastMeta.finishReason !== "stop") {
        entry.note = `finish_reason: ${this._lastMeta.finishReason}${this._lastMeta.hadReasoning ? " (model produced separate reasoning content)" : ""}`;
      } else if (this._lastMeta?.hadReasoning && !String(raw ?? "").trim()) {
        entry.note = "Content empty; output consumed by reasoning/thinking phase";
      }
      return raw;
    } catch (e) {
      entry.status = "error";
      entry.error = String(e?.message ?? e);
      entry.ms = Date.now() - started;
      throw e;
    } finally {
      DebugLog.touch(); // flush settled state before any synchronous work that could crash
    }
  }

  /**
   * Strict-JSON completion with layered recovery:
   *   parse → automatic repair pass → interactive dialog
   *   (retry / hand-fix / continue-as-null / abort pipeline).
   * Callers MUST tolerate a null return ("continue without it").
   */
  async completeJSON(system, content, maxTokens = 16000, { label = "LLM call" } = {}) {
    while (true) {
      let raw = await this.complete(system + "\nRespond with valid JSON only. No prose, no markdown fences.", content, maxTokens, { label });
      let parsed = this.#tryParse(raw);
      if (parsed !== undefined) return parsed;

      // Empty output is its own failure class: do NOT send it to the repair
      // pass — a repair model given nothing happily returns "{}", which
      // parses, and an entire chunk's data is then lost with an "ok" status.
      const meta = this._lastMeta ?? {};
      const isEmpty = !String(raw ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      let repaired = null;
      if (isEmpty) {
        warn(`Empty model output for "${label}" (finish: ${meta.finishReason ?? "?"})`);
      } else {
        warn(`JSON parse failed for "${label}", attempting automatic repair`);
        try {
          repaired = await this.complete(
            "You repair malformed JSON. Output only the corrected JSON document, nothing else.",
            [{ type: "text", text: raw.slice(0, 60000) }],
            maxTokens,
            { label: `${label} (auto-repair)` }
          );
          parsed = this.#tryParse(repaired);
          if (parsed !== undefined) return parsed;
        } catch (e) { warn("Auto-repair call failed", e); }
      }

      // Interactive recovery — loops on "Use my fix" until the edit parses.
      const hint = isEmpty
        ? `The model returned no usable content${meta.finishReason === "length" ? " and stopped at its token limit" : ""}${meta.hadReasoning ? "; its output was consumed by a reasoning/thinking phase" : ""}. With thinking models (Qwen, DeepSeek-style), the budget is often spent before any JSON is produced — Retry sometimes succeeds, or configure the model/server to reduce or disable thinking.`
        : null;
      let dialogRaw = repaired ?? raw;
      let resolved = false;
      while (!resolved) {
        const res = await recoverMalformedOutput({ label, raw: dialogRaw, hint });
        if (res.action === "retry") { resolved = true; /* outer while re-generates */ }
        else if (res.action === "use") {
          const p = this.#tryParse(res.edited ?? "");
          if (p !== undefined) {
            DebugLog.record({ kind: "llm", label: `${label} (hand-fixed by GM)`, status: "ok", note: "Output corrected manually via recovery dialog", response: res.edited });
            return p;
          }
          ui.notifications.warn("That edit still isn't valid JSON — check for trailing commas or unclosed brackets.");
          dialogRaw = res.edited ?? dialogRaw;
        }
        else if (res.action === "skip") {
          DebugLog.record({ kind: "llm", label: `${label} (skipped by GM)`, status: "skipped", note: "GM chose to continue without this result; caller degrades gracefully" });
          return null;
        }
        else { // stop
          DebugLog.record({ kind: "llm", label: `${label} (pipeline stopped by GM)`, status: "aborted" });
          throw new PipelineAbortError();
        }
      }
    }
  }

  #tryParse(raw) {
    let cleaned = String(raw ?? "")
      // Reasoning models (Qwen, DeepSeek-style) may wrap chain-of-thought in
      // think tags; strip them BEFORE brace-slicing, since the reasoning can
      // contain braces that would defeat the outermost-JSON heuristic.
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<\|?think\|?>[\s\S]*?<\|?\/think\|?>/gi, "")
      .replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    if (!cleaned) return undefined;
    try { return JSON.parse(cleaned); } catch (_e) { /* fall through */ }
    // Attempt to slice the outermost JSON object/array.
    const first = Math.min(...["{", "["].map((c) => { const i = cleaned.indexOf(c); return i < 0 ? Infinity : i; }));
    const last = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (first !== Infinity && last > first) {
      try { return JSON.parse(cleaned.slice(first, last + 1)); } catch (_e) { /* give up */ }
    }
    return undefined;
  }

  async #anthropic(system, content, maxTokens) {
    const blocks = content.map((c) =>
      c.type === "image"
        ? { type: "image", source: { type: "base64", media_type: "image/png", data: c.dataUrl.split(",")[1] } }
        : { type: "text", text: c.text }
    );
    const res = await this.#fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: blocks }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }

  async #openai(system, content, maxTokens) {
    const hasImage = content.some((c) => c.type === "image");
    const parts = content.map((c) =>
      c.type === "image"
        ? { type: "image_url", image_url: { url: c.dataUrl } }
        : { type: "text", text: c.text }
    );
    const headers = { "content-type": "application/json" };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    const body = {
      model: this.model || "default",
      // Local servers run uncapped (see constructor): omit max_tokens so the
      // server uses its own default (generate until EOS / context limit).
      ...(this.local ? {} : { max_tokens: maxTokens }),
      stream: false,
      messages: [
        { role: "system", content: system },
        // Many local servers reject multimodal arrays when the model is
        // text-only; collapse to a plain string when there are no images.
        { role: "user", content: hasImage ? parts : content.map((c) => c.text).join("\n\n") }
      ]
    };
    const res = await this.#fetch(this.endpoint, {
      method: "POST", headers, body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`LLM API ${res.status} at ${this.endpoint}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    // Diagnostics for thinking/reasoning models: content can come back empty
    // while the budget was spent in a separate reasoning field, or the run
    // stopped at the token limit mid-thought.
    this._lastMeta = {
      finishReason: data.choices?.[0]?.finish_reason ?? null,
      hadReasoning: !!(msg.reasoning_content || msg.reasoning)
    };
    return msg.content ?? "";
  }

  /** llama.cpp llama-server NATIVE /completion API ({prompt, n_predict}). */
  async #llamacpp(system, content, maxTokens) {
    const dropped = content.some((c) => c.type === "image");
    if (dropped) warn("llama.cpp native /completion endpoint: image inputs are not supported and were dropped. Use /v1/chat/completions with a multimodal model for map-plate vision.");
    const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n\n");
    const headers = { "content-type": "application/json" };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    const res = await this.#fetch(this.endpoint, {
      method: "POST", headers,
      body: JSON.stringify({
        prompt: `${system}\n\n${text}\n\nAssistant:`,
        // Native /completion is always a local server: leave n_predict unset
        // (llama.cpp defaults to -1 = generate until EOS / context limit) so a
        // reasoning model isn't truncated before it emits the answer.
        n_predict: -1,
        temperature: 0.2,
        stream: false
      })
    });
    if (!res.ok) throw new Error(`llama.cpp API ${res.status} at ${this.endpoint}: ${await res.text()}`);
    const data = await res.json();
    return data.content ?? "";
  }
}

/* ---------- endpoint helpers ---------- */

/**
 * Normalize the configured endpoint so common local-server URLs "just work":
 *   ""                              → hosted provider default
 *   "http://localhost:8080"        → http://localhost:8080/v1/chat/completions
 *   "http://localhost:8080/v1"     → http://localhost:8080/v1/chat/completions
 *   ".../v1/chat/completions"      → unchanged (OpenAI dialect)
 *   ".../completion(s) [llama.cpp]"→ unchanged (native dialect)
 *   ".../v1/messages"              → unchanged (Anthropic dialect)
 */
export function normalizeEndpoint(raw, provider) {
  const url = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!url) {
    return provider === "anthropic"
      ? "https://api.anthropic.com/v1/messages"
      : "https://api.openai.com/v1/chat/completions";
  }
  if (/\/v1\/messages$/.test(url)) return url;
  if (/\/chat\/completions$/.test(url)) return url;
  if (/\/completions?$/.test(url)) return url; // llama.cpp native /completion
  if (/\/v1$/.test(url)) return `${url}/chat/completions`;
  if (/\/api$/.test(url)) return `${url}/chat/completions`; // some proxies
  return `${url}/v1/chat/completions`; // bare host:port
}

export function detectDialect(endpoint, provider) {
  if (/\/v1\/messages$/.test(endpoint)) return "anthropic";
  if (/\/chat\/completions$/.test(endpoint)) return "openai";
  if (/\/completions?$/.test(endpoint)) return "llamacpp";
  return provider === "anthropic" ? "anthropic" : "openai";
}

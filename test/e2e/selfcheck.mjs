/**
 * Offline self-check: spins up mock LLM + ComfyUI servers and runs the full
 * e2e harness against a provided PDF, with no real API keys. Validates that
 * the pipeline + recording shim + artifact writer all work.
 *   node test/e2e/selfcheck.mjs <path-to.pdf> [extra run-e2e flags…]
 *
 * Any extra flags (e.g. `--only maps`) are forwarded verbatim to run-e2e.js.
 */
import { startMockLLM, startMockComfy } from "./mock-servers.js";
import { spawn } from "node:child_process";
const pdf = process.argv[2];
if (!pdf) { console.error("Usage: node test/e2e/selfcheck.mjs <path-to.pdf> [--only actors|maps|journals]"); process.exit(2); }
const passthrough = process.argv.slice(3); // forward extra flags like `--only maps`
const a = await startMockLLM(8799), b = await startMockComfy(8800);
const env = { ...process.env,
  ACKS_LLM_PROVIDER: "custom", ACKS_LLM_ENDPOINT: "http://192.168.1.113:8080", ACKS_LLM_MODEL: "Qwen3.6-35B-A3B-UD-Q8_K_XL.gguf",
  ACKS_IMG_PROVIDER: "comfyui", ACKS_IMG_ENDPOINT: "http://192.168.1.113:8188", ACKS_IMG_MODEL: "flux-2-klein-9b-fp8.safetensors",
  ACKS_EDITION: "classic", ACKS_ENC_PER_TERRAIN: "1" };
const p = spawn("node", ["test/e2e/run-e2e.js", pdf, "--pages", "12", "--out", "test/e2e/artifacts/selfcheck", ...passthrough], { env, stdio: "inherit", cwd: process.cwd() });
p.on("exit", (code) => { a.close(); b.close(); process.exit(code); });

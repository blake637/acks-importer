/**
 * Offline self-check: spins up mock LLM + ComfyUI servers and runs the full
 * e2e harness against a provided PDF, with no real API keys. Validates that
 * the pipeline + recording shim + artifact writer all work.
 *   node test/e2e/selfcheck.mjs <path-to.pdf>
 */
import { startMockLLM, startMockComfy } from "./mock-servers.js";
import { spawn } from "node:child_process";
const pdf = process.argv[2];
if (!pdf) { console.error("Usage: node test/e2e/selfcheck.mjs <path-to.pdf>"); process.exit(2); }
const a = await startMockLLM(8799), b = await startMockComfy(8800);
const env = { ...process.env,
  ACKS_LLM_PROVIDER: "custom", ACKS_LLM_ENDPOINT: "http://127.0.0.1:8799", ACKS_LLM_MODEL: "mock",
  ACKS_IMG_PROVIDER: "comfyui", ACKS_IMG_ENDPOINT: "http://127.0.0.1:8800", ACKS_IMG_MODEL: "flux2-klein.safetensors",
  ACKS_EDITION: "classic", ACKS_ENC_PER_TERRAIN: "1" };
const p = spawn("node", ["test/e2e/run-e2e.js", pdf, "--pages", "12", "--out", "test/e2e/artifacts/selfcheck"], { env, stdio: "inherit", cwd: process.cwd() });
p.on("exit", (code) => { a.close(); b.close(); process.exit(code); });

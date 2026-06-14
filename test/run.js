/**
 * Test entry point. Run with:  node test/run.js   (or: npm test)
 *
 * Imports every *.test.js suite, then executes the harness. Tests cover the
 * pure pipeline core — conversion math, stat parsing, edition detection, item
 * classification, coin rolling, plate matching, ComfyUI workflow assembly,
 * procedural encounter generation, and JSON recovery — with no Foundry
 * runtime required (a minimal globals shim lets the modules import).
 */

import "./suite/converter.test.js";
import "./suite/parsing.test.js";
import "./suite/generation.test.js";
import { run } from "./harness.js";

run();

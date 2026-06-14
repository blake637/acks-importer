/**
 * Tiny zero-dependency test harness (no jest/vitest/mocha needed).
 *
 *   import { describe, it, expect, run } from "./harness.js";
 *   describe("thing", () => { it("works", () => expect(1).toBe(1)); });
 *   run();   // prints results, sets process.exitCode on failure
 *
 * Async tests are supported: `it("...", async () => { ... })`.
 */

const suites = [];
let current = null;

export function describe(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name, fn) {
  (current ?? (current = { name: "(root)", tests: [] }, suites.push(current), current)).tests.push({ name, fn });
}

export function expect(actual) {
  const fail = (msg) => { throw new Error(msg); };
  const show = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };
  return {
    toBe(exp) { if (actual !== exp) fail(`expected ${show(exp)}, got ${show(actual)}`); },
    toEqual(exp) { if (show(actual) !== show(exp)) fail(`deep-equal failed\n   expected ${show(exp)}\n   got      ${show(actual)}`); },
    toBeNull() { if (actual !== null) fail(`expected null, got ${show(actual)}`); },
    toBeUndefined() { if (actual !== undefined) fail(`expected undefined, got ${show(actual)}`); },
    toBeTruthy() { if (!actual) fail(`expected truthy, got ${show(actual)}`); },
    toBeFalsy() { if (actual) fail(`expected falsy, got ${show(actual)}`); },
    toBeCloseTo(exp, tol = 0.001) { if (Math.abs(actual - exp) > tol) fail(`expected ~${exp} (±${tol}), got ${actual}`); },
    toBeGreaterThan(n) { if (!(actual > n)) fail(`expected > ${n}, got ${show(actual)}`); },
    toBeLessThan(n) { if (!(actual < n)) fail(`expected < ${n}, got ${show(actual)}`); },
    toContain(sub) { if (!String(actual).includes(sub)) fail(`expected to contain ${show(sub)} in ${show(actual)}`); },
    toHaveLength(n) { if (actual?.length !== n) fail(`expected length ${n}, got ${actual?.length}`); },
    toMatch(re) { if (!re.test(String(actual))) fail(`expected ${show(actual)} to match ${re}`); }
  };
}

export async function run() {
  let pass = 0, fail = 0;
  const failures = [];
  for (const suite of suites) {
    let printedSuite = false;
    for (const t of suite.tests) {
      try {
        await t.fn();
        pass++;
        if (!printedSuite) { console.log(`\n  ${suite.name}`); printedSuite = true; }
        console.log(`    \x1b[32m✓\x1b[0m ${t.name}`);
      } catch (e) {
        fail++;
        if (!printedSuite) { console.log(`\n  ${suite.name}`); printedSuite = true; }
        console.log(`    \x1b[31m✗ ${t.name}\x1b[0m`);
        console.log(`        ${String(e.message).replace(/\n/g, "\n        ")}`);
        failures.push(`${suite.name} › ${t.name}`);
      }
    }
  }
  console.log(`\n${"─".repeat(48)}`);
  console.log(`  ${pass} passed, ${fail} failed, ${pass + fail} total`);
  if (fail) {
    console.log(`\n  Failed:`);
    for (const f of failures) console.log(`    - ${f}`);
    process.exitCode = 1;
  }
}

/**
 * verify-catalog-billable-override.ts — Regression test for the
 * `classifyByCatalog()` precedence rule.
 *
 * Background:
 *   The dashboard rendered every OMP / Pi session at 0.00 AIC, and the
 *   "non-billable" panel listed premium models like `claude-opus-4.7`,
 *   `claude-sonnet-4.6`, `gpt-5.4` even though they are GitHub-billed.
 *
 *   Root cause: `classifyByCatalog()` consulted `userVendorByModelId` BEFORE
 *   the CAPI `/models` billable list. Copilot Chat itself registers its
 *   Anthropic-backed routed models via `vscode.lm.selectChatModels()` with
 *   `vendor: "anthropic"` (the upstream provider), so the id ended up in the
 *   third-party map and every traffic source that didn't carry an explicit
 *   `copilotUsageNanoAiu` (OMP, Pi, CLI, any older OTel row) was
 *   short-circuited to non-billable.
 *
 *   Fix: when the CAPI catalog has the model with `billable: true`, trust
 *   CAPI. The third-party signal only applies to ids CAPI does NOT mark
 *   billable (i.e. genuine Ollama / LM Studio / BYOK-only entries).
 *
 * Run with:  npx ts-node tests/verify-catalog-billable-override.ts
 */

// Stub the `vscode` module that `modelCatalog.ts` pulls in at the top
// before importing anything that re-exports it. Same pattern as the other
// tests in this directory.
const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "vscode") {
    return path.join(__dirname, "_vscode-stub.js");
  }
  return origResolve.call(this, request, ...rest);
};

import {
  __setCatalogForTesting,
  classifyByCatalog,
  ModelCatalog,
  ModelCatalogEntry,
} from "../src/modelCatalog";

let failed = 0;
function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? "  — " + detail : ""}`);
    failed++;
  }
}

function makeCatalog(opts: {
  capi?: Array<[string, boolean]>;
  userVendor?: Array<[string, string]>;
}): ModelCatalog {
  const byId = new Map<string, ModelCatalogEntry>();
  for (const [id, billable] of opts.capi ?? []) {
    byId.set(id.toLowerCase(), {
      id,
      billable,
      multiplier: billable ? 1 : 0,
      isPremium: false,
      preview: false,
      vendor: "anthropic",
      source: "capi",
    });
  }
  return {
    fetchedAt: Date.now(),
    byId,
    cdnProviders: {},
    userVendorByModelId: new Map(opts.userVendor ?? []),
  };
}

console.log("\n== Test 1: CAPI billable=true wins over BYOK alias collision ==");
{
  __setCatalogForTesting(
    makeCatalog({
      // Real Copilot CAPI says claude-opus-4.7 is billable on this plan
      capi: [["claude-opus-4.7", true]],
      // BUT vscode.lm.selectChatModels() also surfaced it as vendor: "anthropic"
      // (Copilot Chat's own routed model + the same id appears in a BYOK list).
      userVendor: [["claude-opus-4.7", "anthropic"]],
    }),
  );
  const hit = classifyByCatalog("claude-opus-4.7");
  ok("hit returned", hit !== null);
  ok("classified BILLABLE (CAPI wins)", hit?.billable === true, `got billable=${hit?.billable}`);
  ok("source is 'capi', not 'user-config'", hit?.source === "capi", `got source=${hit?.source}`);
}

console.log("\n== Test 2: pure BYOK / Ollama id still resolves to non-billable ==");
{
  __setCatalogForTesting(
    makeCatalog({
      capi: [["claude-opus-4.7", true]], // not the model under test
      userVendor: [["ollama/qwen2.5-coder:7b", "ollama"]],
    }),
  );
  const hit = classifyByCatalog("ollama/qwen2.5-coder:7b");
  ok("hit returned", hit !== null);
  ok("classified NON-billable", hit?.billable === false);
  ok("source is 'user-config'", hit?.source === "user-config");
  ok("vendor is 'ollama'", hit?.vendor === "ollama");
}

console.log("\n== Test 3: CAPI billable=false is preserved (preview / utility models) ==");
{
  __setCatalogForTesting(
    makeCatalog({
      capi: [["copilot-utility-helper", false]],
    }),
  );
  const hit = classifyByCatalog("copilot-utility-helper");
  ok("hit returned", hit !== null);
  ok("classified NON-billable per CAPI flag", hit?.billable === false);
  ok("source is 'capi'", hit?.source === "capi");
}

console.log("\n== Test 4: unknown model returns null (falls through to rate-table heuristic) ==");
{
  __setCatalogForTesting(
    makeCatalog({
      capi: [["claude-opus-4.7", true]],
    }),
  );
  const hit = classifyByCatalog("some-unreleased-preview-model");
  ok("hit is null", hit === null);
}

console.log("\n== Test 5: no cache loaded → null ==");
{
  __setCatalogForTesting(null);
  ok("classifyByCatalog returns null when cache empty", classifyByCatalog("anything") === null);
}

if (failed === 0) {
  console.log("\nAll catalog-precedence checks passed.\n");
  process.exit(0);
} else {
  console.error(`\n${failed} check(s) FAILED.\n`);
  process.exit(1);
}

/**
 * verify-byok-billable-regression.js
 *
 * Regression test for the v1.10.13 bug where `liveOtel.sessionAIC` dropped
 * to 0.00 even though the per-model live OTel table still showed real
 * GitHub-billed credits (e.g. claude-opus-4.7 = 58.89 AIC,
 * gpt-5.3-codex = 12.07 AIC).
 *
 * Root cause: `dashboardData.ts` post-processor called
 *   classifyModelBillability(calc, cfg, row.model, false, catalog)
 * with the 4th positional `hasActualCredits` arg hardcoded to `false`.
 * When the user also has BYOK Anthropic configured
 * in `chatLanguageModels.json`, the catalog lookup returned the user-config
 * entry first (vendor: "anthropic", billable: false) and demoted the
 * Copilot-billed row to non-billable. The filter then stripped sessionAIC
 * to 0 while the per-model rows still showed the real credits.
 *
 * v1.10.14 fix: track `hasActualCredits` per byModel row in all three
 * build branches (OTel+overlay, debug-only requests, debug-only turns)
 * and pass it to the classifier. The classifier's rule #2
 * (`hasActualCredits=true → billable`) then overrides the catalog
 * demotion, preserving sessionAIC.
 *
 * Assertion: with a BYOK-style user-config catalog that returns
 * `{billable: false, source: "user-config"}` for `claude-opus-4.7`, the
 * classifier must STILL return billable=true when hasActualCredits=true.
 * The pre-fix version (hardcoded false) returned billable=false.
 *
 * Run: node tests/verify-byok-billable-regression.js
 * Exits non-zero on any assertion failure.
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

// ── vscode stub (required by transitive imports) ──
const Module = require("module");
const stubPath = path.join(__dirname, "_vscode-stub.js");
if (!fs.existsSync(stubPath)) {
  fs.writeFileSync(
    stubPath,
    "module.exports = { workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }) }, window: {}, commands: {}, Uri: { file: (p) => ({ fsPath: p, toString: () => p }) }, ConfigurationTarget: { Global: 1 }, EventEmitter: class { constructor(){ this.event = () => ({ dispose(){} }); } fire(){} dispose(){} } };\n"
  );
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { AICCalculator, DEFAULT_AIC_CONFIG, DEFAULT_MODEL_COSTS, classifyModelBillability } = require(path.join(OUT, "aicCredits.js"));

let failed = 0;
function ok(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? "  — " + detail : ""}`);
    failed++;
  }
}

// ── BYOK-style catalog: user has chatLanguageModels.json listing
//    claude-opus-4.7 under their own Anthropic BYOK vendor entry, which
//    would otherwise demote the GitHub-billed row to non-billable.
function byokCatalog(modelName) {
  const n = (modelName || "").toLowerCase();
  if (n.includes("claude-opus-4.7") || n.includes("claude-sonnet-4.5")) {
    return { billable: false, source: "user-config", vendor: "anthropic" };
  }
  return undefined; // model unknown to the catalog — falls through to other rules
}

const calc = new AICCalculator(DEFAULT_MODEL_COSTS, undefined);
const cfg = { ...DEFAULT_AIC_CONFIG };

console.log("\n== v1.10.14 regression: BYOK third-party catalog must NOT demote GitHub-billed rows ==");

// CASE 1: row HAS actual credits (the v1.10.13 broken scenario)
{
  const isBillable = classifyModelBillability(calc, cfg, "claude-opus-4.7", /* hasActualCredits */ true, byokCatalog);
  ok(
    "claude-opus-4.7 with hasActualCredits=true is BILLABLE (overrides BYOK catalog)",
    isBillable === true,
    `got ${isBillable}`,
  );
}

// CASE 2: same row, hasActualCredits=false. This is the OMP / Pi / CLI
// scenario — those traffic sources compute AIC locally from the rate table
// (no `copilotUsageNanoAiu` ever flows through them) and ALWAYS pass
// hasActualCredits=false. v1.10.14 demoted them to NON-billable here,
// collapsing the OMP / Pi credit columns to 0.00. v1.10.15 fixes this:
// when a user-config (BYOK alias) demotion collides with a rate-table-
// known GHC model id, the rate table wins. The model is genuinely billed
// when used through Copilot's coding-agent channels, even though the user
// also happens to have a BYOK Anthropic key configured under the same id.
{
  const isBillable = classifyModelBillability(calc, cfg, "claude-opus-4.7", /* hasActualCredits */ false, byokCatalog);
  ok(
    "claude-opus-4.7 with hasActualCredits=false is BILLABLE (rate-table wins over BYOK alias demotion — fixes OMP/Pi=0.00)",
    isBillable === true,
    `got ${isBillable}`,
  );
}

// CASE 3: an Ollama row that hasActualCredits=false (the local-model case).
// Must stay non-billable so issue #5 doesn't regress. The id is NOT in the
// rate table, so the user-config demotion is honoured at step 5b.
{
  const isBillable = classifyModelBillability(calc, cfg, "ollama/qwen2.5-coder:7b", /* hasActualCredits */ false, byokCatalog);
  ok(
    "ollama/qwen2.5-coder:7b stays non-billable (no actual credits, not in rate table, BYOK demotion honoured)",
    isBillable === false,
    `got ${isBillable}`,
  );
}

// CASE 3b: even a catalog non-billable verdict must not put a known GitHub
// model name in the non-billable panel. The local rate table is the display
// guardrail for known Copilot models; truly unknown/non-billed catalog entries
// still fall through to non-billable.
{
  const capiNonBillable = (name) =>
    name === "claude-opus-4.7"
      ? { billable: false, source: "capi", vendor: "anthropic" }
      : undefined;
  const isBillable = classifyModelBillability(calc, cfg, "claude-opus-4.7", /* hasActualCredits */ false, capiNonBillable);
  ok(
    "claude-opus-4.7 with catalog billable=false still stays billable (known GitHub model)",
    isBillable === true,
    `got ${isBillable}`,
  );
}

// CASE 4: a model that isn't in the rate-table at all but DID receive a
// GitHub `copilotUsageNanoAiu` bill (e.g. gpt-5.3-codex preview). Must be
// billable on the strength of actual credits alone.
{
  const isBillable = classifyModelBillability(calc, cfg, "gpt-5.3-codex", /* hasActualCredits */ true, byokCatalog);
  ok(
    "gpt-5.3-codex (preview, unknown to rate-table) with hasActualCredits=true is BILLABLE",
    isBillable === true,
    `got ${isBillable}`,
  );
}

// CASE 5: excludeModels still wins even over hasActualCredits=true. This
// pins the user's explicit override behavior so a future refactor can't
// quietly drop it.
{
  const cfgExcl = { ...DEFAULT_AIC_CONFIG, excludeModels: ["claude-opus-4.7"] };
  const isBillable = classifyModelBillability(calc, cfgExcl, "claude-opus-4.7", /* hasActualCredits */ true, byokCatalog);
  ok(
    "claude-opus-4.7 in excludeModels stays non-billable EVEN with hasActualCredits=true",
    isBillable === false,
    `got ${isBillable}`,
  );
}

// ── End-to-end shape check: build a synthetic liveOtel.byModel and run
// the same .filter()/reduce() the post-processor uses. Confirms sessionAIC
// would be 70.96 (12.07 + 58.89), NOT 0.00, in the user's screenshot.
{
  const byModel = [
    { model: "gpt-5.3-codex", aicCredits: 12.07, hasActualCredits: true, isBillable: false },
    { model: "claude-opus-4.7", aicCredits: 58.89, hasActualCredits: true, isBillable: false },
  ];
  const reclassified = byModel.map(row => ({
    ...row,
    isBillable: classifyModelBillability(calc, cfg, row.model, row.hasActualCredits, byokCatalog),
  }));
  const sessionAIC = Math.round(
    reclassified.filter(r => r.isBillable).reduce((s, r) => s + r.aicCredits, 0) * 100,
  ) / 100;
  const informational = Math.round(
    reclassified.filter(r => !r.isBillable).reduce((s, r) => s + r.aicCredits, 0) * 100,
  ) / 100;
  ok(
    "user-screenshot scenario: sessionAIC = 70.96 (was 0.00 in v1.10.13)",
    Math.abs(sessionAIC - 70.96) < 0.01,
    `got ${sessionAIC}`,
  );
  ok(
    "user-screenshot scenario: informationalAIC = 0.00 (no rows demoted)",
    Math.abs(informational - 0) < 0.01,
    `got ${informational}`,
  );
}

if (failed === 0) {
  console.log("\nAll BYOK-billable regression checks passed.\n");
  process.exit(0);
} else {
  console.error(`\n${failed} check(s) FAILED.\n`);
  process.exit(1);
}

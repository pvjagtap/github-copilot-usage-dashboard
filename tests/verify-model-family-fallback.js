/**
 * verify-model-family-fallback.js
 *
 * `claude-opus-5` was missing from DEFAULT_MODEL_COSTS, so with the live CAPI
 * catalog unavailable it fell through `findModelRate()` to the "unknown model"
 * branch of `calculateCredits()`: gpt-4.1 rates, a wrong `base` tier, and
 * `isKnownGHCModel() === false` — which pushed a genuinely Copilot-billed model
 * into the "Non-billable models (informational)" panel.
 *
 * A hardcoded table can't keep up with GitHub's release cadence, so
 * `findModelRate()` now falls back to the newest rate in the model's own family.
 * This pins that the fallback fires for unseen point releases AND that it does
 * not resurrect the short-alias collisions the provider guard depends on.
 *
 * Run after compile:
 *   node tests/verify-model-family-fallback.js
 */

const path = require("path");
const fs = require("fs");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
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

const {
  createCalculatorFromConfig,
  classifyModelBillability,
  DEFAULT_AIC_CONFIG,
} = require(path.join(OUT, "aicCredits.js"));

let failed = 0;
function ok(label, cond, extra) {
  if (cond) {
    console.log(`  \u2713 ${label}`);
  } else {
    console.log(`  \u2717 ${label}${extra ? ` \u2014 ${extra}` : ""}`);
    failed++;
  }
}

const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);
const rateOf = (id) => calc.findModelRate(id);

console.log("== Test 1: models shipped in the live catalog are in the offline table ==");
for (const [id, input, output, tier] of [
  ["claude-opus-5", 500, 2500, "premium"],
  ["grok-4.5", 200, 600, "base"],
]) {
  const r = rateOf(id);
  ok(
    `${id} resolves at ${input}/${output} (${tier})`,
    r && r.inputCreditsPerMillion === input && r.outputCreditsPerMillion === output && r.tier === tier,
    JSON.stringify(r),
  );
}

console.log("\n== Test 2: unseen point releases borrow their family's newest rate ==");
for (const [id, expectFrom, input, output, tier] of [
  ["claude-opus-6", "claude-opus-5.5", 400, 2000, "premium"],
  ["claude-haiku-5", "claude-haiku-4.5", 100, 500, "base"],
  ["gpt-5.7", "gpt-5.5", 500, 3000, "premium"],
  ["gpt-5.7-codex", "gpt-5.3-codex", 175, 1400, "premium"],
  ["gpt-5.9-mini", "gpt-5.4-mini", 75, 450, "base"],
  ["gemini-4.0-flash", "gemini-3.6-flash", 75, 375, "base"],
]) {
  const r = rateOf(id);
  ok(
    `${id} inherits ${expectFrom} (${input}/${output}, ${tier})`,
    r && r.inputCreditsPerMillion === input && r.outputCreditsPerMillion === output && r.tier === tier,
    JSON.stringify(r),
  );
  ok(`${id} keeps its own name for display`, r && r.model === id, r && r.model);
}

console.log("\n== Test 3: short BYOK aliases still do NOT resolve ==");
for (const id of ["gpt-4", "gpt-5", "claude", "ollama/qwen2.5-coder:7b", "local-llama-13b-q4"]) {
  ok(`${id} is NOT a known GitHub Copilot model`, calc.isKnownGHCModel(id) === false, JSON.stringify(rateOf(id)));
}

console.log("\n== Test 4: an unseen release is billable, not informational ==");
// The exact shape that produced the bad `claude-opus-5 / base / 0.00` row:
// a request with no copilotUsageNanoAiu on a model the table had not seen.
ok(
  "claude-opus-6 with hasActualCredits=false is BILLABLE",
  classifyModelBillability(calc, DEFAULT_AIC_CONFIG, "claude-opus-6", false) === true,
);
ok(
  "ollama/qwen2.5-coder:7b with hasActualCredits=false stays NON-billable",
  classifyModelBillability(calc, DEFAULT_AIC_CONFIG, "ollama/qwen2.5-coder:7b", false) === false,
);

console.log("\n== Test 5: family rates price real traffic, not gpt-4.1 defaults ==");
const usage = calc.calculateCredits("claude-opus-6", 1_000_000, 100_000, 0);
ok("claude-opus-6 input priced at 400/1M (newest Opus rate, not the 200/1M unknown default)", usage.inputCredits === 400, `${usage.inputCredits}`);
ok("claude-opus-6 output priced at 2000/1M (not the 800/1M unknown default)", usage.outputCredits === 200, `${usage.outputCredits}`);
ok("claude-opus-6 carries the premium tier", usage.tier === "premium", usage.tier);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll model-family fallback checks passed.");

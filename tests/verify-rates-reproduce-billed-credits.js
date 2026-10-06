/**
 * verify-rates-reproduce-billed-credits.js — the offline rate table must
 * reproduce the credits GitHub itself billed.
 *
 * Fixtures are real `llm_request` rows from VS Code Copilot Chat debug logs:
 * `copilotUsageNanoAiu / 1e9` is GitHub's own per-request charge. Copilot
 * caches the whole non-cached prompt, so prompt - cached tokens are cache
 * WRITES (the debug log reports prompt tokens gross).
 *
 * Regression: claude-opus-5.5 matched the `claude-opus-5` key and was billed
 * at Opus 5 rates (+25%); gpt-5.6-sol was priced at 200/1000 instead of
 * 400/2000 and had no cache-write rate.
 *
 *   node tests/verify-rates-reproduce-billed-credits.js
 */

const path = require("path");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { createCalculatorFromConfig, DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));
const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);

let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

// [model, prompt tokens (gross), cached tokens, output tokens, credits GitHub billed]
const BILLED = [
  ["claude-opus-5", 28593, 14012, 202, 10.318475],
  ["claude-opus-5", 40613, 38456, 472, 4.450675],
  ["claude-opus-5.5", 83541, 70983, 496, 8.69026],
  ["claude-sonnet-5", 635541, 625589, 233, 15.23268],
];

for (const [model, prompt, cached, output, billed] of BILLED) {
  // Anthropic: everything not read from cache was written to it.
  const c = calc.calculateCredits(model, prompt, output, cached, prompt - cached);
  assert(`${model} (prompt ${prompt}) reproduces ${billed} billed credits`,
    Math.abs(c.totalCredits - billed) < 0.005, c.totalCredits.toFixed(4));
}

// GPT-5.6 Sol: the billed rows carry no cache-write tokens, so all non-cached
// prompt tokens are plain input.
for (const [prompt, cached, output, billed] of [
  [32270, 3584, 226, 12.06976],
  [33687, 31872, 308, 2.61688],
]) {
  const c = calc.calculateCredits("gpt-5.6-sol", prompt, output, cached, 0);
  assert(`gpt-5.6-sol (prompt ${prompt}) reproduces ${billed} billed credits`,
    Math.abs(c.totalCredits - billed) < 0.005, c.totalCredits.toFixed(4));
}
assert("gpt-5.6-sol carries a cache-write rate",
  calc.findModelRate("gpt-5.6-sol").cacheWriteCreditsPerMillion === 500);

assert("claude-opus-5.5 is not priced as claude-opus-5",
  calc.findModelRate("claude-opus-5.5").inputCreditsPerMillion === 400 &&
  calc.findModelRate("claude-opus-5").inputCreditsPerMillion === 500);
assert("hyphenated id claude-opus-5-5 resolves to Opus 5.5",
  calc.findModelRate("claude-opus-5-5").inputCreditsPerMillion === 400);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

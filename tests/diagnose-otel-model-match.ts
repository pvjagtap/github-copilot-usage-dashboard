/**
 * diagnose-otel-model-match.ts — Checks if OTel model names match the rate table.
 *
 * Run: npx tsx tests/diagnose-otel-model-match.ts
 *
 * Investigates: Does the OTel-reported model name (e.g. "claude-opus-4-6")
 * match any entry in DEFAULT_MODEL_COSTS via findModelRate()?
 */

import { AICCalculator, DEFAULT_MODEL_COSTS, DEFAULT_PLANS } from "../src/aicCredits";

const calc = new AICCalculator(DEFAULT_MODEL_COSTS, DEFAULT_PLANS.business);

// Model names as OTel reports them (from dashboard screenshots)
const otelModelNames = [
  "claude-opus-4-6",       // Hyphens — as seen in dashboard LIVE OTEL table
  "claude-opus-4.6",       // Dots — as stored in rate table
  "gpt-4o-mini-2024-07-18", // Full version string from OTel
  "gpt-4o-mini",           // Short form
  "gpt-5.4",
  "claude-sonnet-4.6",
  "claude-sonnet-4-6",     // Hypothetical hyphen variant
];

console.log("═══ OTel Model Name → Rate Table Match Test ═══\n");
console.log("Model Name (OTel)              | Matched?  | Matched Key        | Input Rate | Tier");
console.log("─".repeat(95));

for (const name of otelModelNames) {
  const rate = calc.findModelRate(name);
  if (rate) {
    console.log(
      `${name.padEnd(30)} | ✓ YES     | ${rate.model.padEnd(18)} | ${String(rate.inputCreditsPerMillion).padStart(10)} | ${rate.tier}`
    );
  } else {
    console.log(
      `${name.padEnd(30)} | ✗ NO      | (fallback GPT-4.1) |        200 | base`
    );
  }
}

console.log("\n═══ Credit Calculation Comparison ═══\n");
console.log("Scenario: 115K prompt, 97K cached, 2K output (typical agent request)\n");

const testInput = 115000;
const testOutput = 2000;
const testCached = 97000;

for (const name of ["claude-opus-4-6", "claude-opus-4.6"]) {
  const result = calc.calculateCredits(name, testInput, testOutput, testCached);
  console.log(`  Model: "${name}"`);
  console.log(`    Input credits:  ${result.inputCredits.toFixed(2)} (net ${testInput - testCached} tokens × ${result.model ? "matched" : "default"} rate)`);
  console.log(`    Output credits: ${result.outputCredits.toFixed(2)}`);
  console.log(`    Cached credits: ${result.cachedCredits.toFixed(2)}`);
  console.log(`    Total:          ${result.totalCredits.toFixed(2)} credits`);
  console.log(`    Tier:           ${result.tier}`);
  console.log("");
}

const correctResult = calc.calculateCredits("claude-opus-4.6", testInput, testOutput, testCached);
const wrongResult = calc.calculateCredits("claude-opus-4-6", testInput, testOutput, testCached);
const diff = wrongResult.totalCredits - correctResult.totalCredits;
const diffPct = (diff / correctResult.totalCredits * 100);

console.log("═══ Impact ═══\n");
console.log(`  With dots (correct match):  ${correctResult.totalCredits.toFixed(2)} credits (rates: ${correctResult.model})`);
console.log(`  With hyphens (OTel actual):  ${wrongResult.totalCredits.toFixed(2)} credits (rates: ${wrongResult.model})`);
console.log(`  Difference:                  ${diff > 0 ? "+" : ""}${diff.toFixed(2)} credits (${diffPct > 0 ? "+" : ""}${diffPct.toFixed(0)}%)`);

if (Math.abs(diffPct) > 5) {
  console.log(`\n  ⚠ Model name mismatch causes ${Math.abs(diffPct).toFixed(0)}% drift in OTel live credit display`);
} else {
  console.log(`\n  ✓ Drift is within acceptable range`);
}

// Also test what happens with cachedTokens=0 on the last request
console.log("\n═══ lastRequestAIC with cachedTokens=0 ═══\n");
const noCacheResult = calc.calculateCredits("claude-opus-4-6", testInput, testOutput, 0);
console.log(`  If cached=0 AND wrong model:  ${noCacheResult.totalCredits.toFixed(2)} credits`);
console.log(`  If cached=0 AND correct model: ${calc.calculateCredits("claude-opus-4.6", testInput, testOutput, 0).totalCredits.toFixed(2)} credits`);
console.log(`  Correct (with cached):         ${correctResult.totalCredits.toFixed(2)} credits`);

// ═══ Cache Write Credits Test ═══
console.log("\n═══ Cache Write Credits (the missing piece) ═══\n");
console.log("From screenshot metadata: cache_creation_input_tokens = 847");
console.log("Opus cacheWriteCreditsPerMillion = 625\n");

const testCacheWrite = 847;
const withCacheWrite = calc.calculateCredits("claude-opus-4.6", testInput, testOutput, testCached, testCacheWrite);
const withoutCacheWrite = calc.calculateCredits("claude-opus-4.6", testInput, testOutput, testCached, 0);
console.log(`  Without cache_write: ${withoutCacheWrite.totalCredits.toFixed(4)} credits`);
console.log(`  With cache_write:    ${withCacheWrite.totalCredits.toFixed(4)} credits`);
console.log(`  Difference:          +${(withCacheWrite.totalCredits - withoutCacheWrite.totalCredits).toFixed(4)} credits`);

// Larger cache write scenario (realistic agent session)
const largeCacheWrite = 150_000; // typical for a long conversation
const largeWithCW = calc.calculateCredits("claude-opus-4.6", testInput, testOutput, testCached, largeCacheWrite);
const largeWithoutCW = calc.calculateCredits("claude-opus-4.6", testInput, testOutput, testCached, 0);
console.log(`\n  Large cache_write (150K tokens):`);
console.log(`    Without: ${largeWithoutCW.totalCredits.toFixed(2)} credits`);
console.log(`    With:    ${largeWithCW.totalCredits.toFixed(2)} credits`);
console.log(`    Δ:       +${(largeWithCW.totalCredits - largeWithoutCW.totalCredits).toFixed(2)} credits (${((largeWithCW.totalCredits - largeWithoutCW.totalCredits) / largeWithoutCW.totalCredits * 100).toFixed(1)}% of base)`);

// What explains the 61.4 vs 58.7 gap from screenshots?
console.log("\n═══ Explaining 61.4 (VS Code) vs 58.7 (our extension) ═══\n");
console.log("If cache_write is ~4,300 tokens for that request:");
const cw4300 = calc.calculateCredits("claude-opus-4.6", 64576, 4700, 63728, 4300);
const noCw = calc.calculateCredits("claude-opus-4.6", 64576, 4700, 63728, 0);
console.log(`  Without cache_write: ${noCw.totalCredits.toFixed(2)} credits`);
console.log(`  With cache_write:    ${cw4300.totalCredits.toFixed(2)} credits`);
console.log(`  The ~2.7 gap is: (cacheWriteTokens / 1M) × 625`);
console.log(`  To get +2.7 credits: need ${Math.round(2.7 / 625 * 1_000_000)} cache_write tokens`);
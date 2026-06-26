/**
 * Verify the billable-vs-non-billable classifier introduced for issue #5.
 *
 * What this test covers:
 *   1. A known GHC model (claude-sonnet-4.5) WITH actual API credits → billable
 *   2. A local Ollama model (ollama/qwen2.5-coder:7b) → non-billable
 *      - Its rate-table estimate must NOT contribute to `summary.totalCredits`
 *      - But MUST appear in `summary.nonBillable.byModel`
 *   3. An entry dated BEFORE the current billing-cycle start is dropped from
 *      both billable and non-billable buckets (cycle-window filter).
 *   4. `extraBilledModels` flips a previously-unknown model to billable.
 *   5. `excludeModels` flips a known model to non-billable.
 *
 * Run with:  npx ts-node tests/verify-billable-classification.ts
 * Exits non-zero on any assertion failure so CI catches regressions.
 */

import {
  AICCalculator,
  AICConfig,
  DEFAULT_AIC_CONFIG,
  DEFAULT_MODEL_COSTS,
  classifyModelBillability,
  createCalculatorFromConfig,
} from "../src/aicCredits";

let failed = 0;
function ok(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? "  — " + detail : ""}`);
    failed++;
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function makeConfig(overrides: Partial<AICConfig> = {}): AICConfig {
  return { ...DEFAULT_AIC_CONFIG, ...overrides };
}

console.log("\n== Test 1: known GHC model with actual credits ==");
{
  const calc = new AICCalculator(DEFAULT_MODEL_COSTS, undefined);
  const cfg = makeConfig();
  const isBillable = classifyModelBillability(calc, cfg, "claude-sonnet-4.5", true);
  ok("claude-sonnet-4.5 with actualCredits>0 is billable", isBillable === true);
}

console.log("\n== Test 2: local Ollama model is NOT billable ==");
{
  const calc = new AICCalculator(DEFAULT_MODEL_COSTS, undefined);
  const cfg = makeConfig();
  const ollama = classifyModelBillability(calc, cfg, "ollama/qwen2.5-coder:7b", false);
  ok("ollama/* is non-billable", ollama === false);

  // A fictional local-only model with no Copilot equivalent. Avoid suffixes
  // like '-mini' / '-pro' / '-flash' that DO appear in the rate table as
  // substrings (e.g. 'raptor-mini' is a real preview model in DEFAULT_MODEL_COSTS).
  const local = classifyModelBillability(calc, cfg, "local-llama-13b-q4", false);
  ok("unknown local-llama-13b-q4 is non-billable", local === false);
}

console.log("\n== Test 3: computeSummary splits billable vs non-billable & filters cycle ==");
{
  const calc = createCalculatorFromConfig(makeConfig({ plan: "business" }));
  const t = today();
  const previousMonth = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 2);
    return d.toISOString().slice(0, 10);
  })();

  const entries = [
    // Billable: known model with actual API-billed credits
    { model: "claude-sonnet-4.5", inputTokens: 1_000_000, outputTokens: 200_000, cachedTokens: 0, date: t, actualCredits: 350, billable: true },
    // Non-billable: Ollama, dashboard tagged it explicitly
    { model: "ollama/qwen2.5-coder:7b", inputTokens: 2_000_000, outputTokens: 500_000, cachedTokens: 0, date: t, billable: false },
    // Outside cycle window: must be dropped from BOTH buckets
    { model: "claude-sonnet-4.5", inputTokens: 999_999, outputTokens: 999_999, cachedTokens: 0, date: previousMonth, actualCredits: 999, billable: true },
  ];

  const summary = calc.computeSummary(entries);
  ok(
    "billable total ≈ 350 (only in-cycle billable entry counted)",
    Math.abs(summary.totalCredits - 350) < 0.5,
    `got ${summary.totalCredits}`,
  );
  ok(
    "nonBillable.totalCredits > 0 (Ollama estimate accumulated)",
    summary.nonBillable.totalCredits > 0,
    `got ${summary.nonBillable.totalCredits}`,
  );
  ok(
    "nonBillable.byModel contains the Ollama row",
    summary.nonBillable.byModel.has("ollama/qwen2.5-coder:7b"),
  );
  ok(
    "previous-month billable entry filtered out (totalCredits NOT ≥ 999)",
    summary.totalCredits < 999,
  );
}

console.log("\n== Test 4: extraBilledModels promotes unknown model to billable ==");
{
  const calc = new AICCalculator(DEFAULT_MODEL_COSTS, undefined);
  const cfg = makeConfig({ extraBilledModels: ["local-llama"] });
  const isBillable = classifyModelBillability(calc, cfg, "local-llama-13b-q4", false);
  ok("local-llama-13b-q4 becomes billable when 'local-llama' in extraBilledModels", isBillable === true);
}

console.log("\n== Test 5: excludeModels demotes known model to non-billable ==");
{
  const calc = new AICCalculator(DEFAULT_MODEL_COSTS, undefined);
  // Note: excludeModels wins even over `hasActualCredits=true`, because the
  // user has explicit say. This lets them mark an alias as informational.
  const cfg = makeConfig({ excludeModels: ["claude-sonnet"] });
  const isBillable = classifyModelBillability(calc, cfg, "claude-sonnet-4.5", true);
  ok("claude-sonnet-4.5 becomes non-billable when excluded", isBillable === false);
}

console.log("\n== Test 6: Copilot resolved ids and source hints are billable ==");
{
  const calc = new AICCalculator(DEFAULT_MODEL_COSTS, undefined);
  const cfg = makeConfig();
  const resolved = classifyModelBillability(calc, cfg, "capi-eus2-ptuc-gb300-gpt-5", false);
  ok("capi-* Copilot resolved id is billable", resolved === true);

  const hinted = classifyModelBillability(calc, cfg, "opaque-preview-deployment", false, undefined, "github-copilot");
  ok("github-copilot source hint promotes opaque id to billable", hinted === true);

  const excluded = classifyModelBillability(
    calc,
    makeConfig({ excludeModels: ["capi-eus2"] }),
    "capi-eus2-ptuc-gb300-gpt-5",
    false,
  );
  ok("excludeModels still overrides Copilot resolved id", excluded === false);
}

console.log("\n== Test 7: master switch off restores legacy behaviour ==");
{
  const calc = new AICCalculator(DEFAULT_MODEL_COSTS, undefined);
  const cfg = makeConfig({ includeOnlyBilledModels: false });
  const ollama = classifyModelBillability(calc, cfg, "ollama/qwen", false);
  ok("ollama/* is billable when includeOnlyBilledModels=false", ollama === true);
}

if (failed === 0) {
  console.log("\nAll billable-classification checks passed.\n");
  process.exit(0);
} else {
  console.error(`\n${failed} check(s) FAILED.\n`);
  process.exit(1);
}

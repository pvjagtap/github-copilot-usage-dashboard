/**
 * verify-quota-reconciliation.js — GitHub's quota ledger must drive the
 * headline, and every surface must agree with it.
 *
 * Regression guard for the drift users hit against github.com: local debug
 * logs are a lower bound (usage on other machines / IDEs / github.com never
 * lands here, and `copilotLanguageModelWrapper` requests omit
 * `copilotUsageNanoAiu`), so the gap grows across a cycle unless the server
 * figure is adopted.
 *
 *   node tests/verify-quota-reconciliation.js
 */

const path = require("path");
const assert = require("assert");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { buildDashboardData } = require(path.join(OUT, "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));
const { parseQuotaSnapshot } = require(path.join(OUT, "quotaSnapshot.js"));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

// ─── parseQuotaSnapshot ───────────────────────────────────────
// Verbatim shape of a real /copilot_internal/user response.
const WIRE = {
  quota_reset_date: "2026-10-01",
  token_based_billing: true,
  quota_snapshots: {
    chat: { unlimited: true, token_based_billing: true, credits_used: 0, entitlement: 0, remaining: 0 },
    completions: { unlimited: true, token_based_billing: true, credits_used: 0, entitlement: 0, remaining: 0 },
    premium_interactions: {
      quota_id: "premium_interactions",
      credits_used: 800,
      entitlement: 5000,
      remaining: 4200,
      overage_count: 0,
      overage_permitted: true,
      token_based_billing: true,
      timestamp_utc: "2026-09-04T06:08:24.850-07:00",
    },
  },
};

console.log("\nparseQuotaSnapshot");
check("picks the premium_interactions AIC bucket", () => {
  const s = parseQuotaSnapshot(WIRE);
  assert.strictEqual(s.creditsUsed, 800);
  assert.strictEqual(s.entitlement, 5000);
  assert.strictEqual(s.remaining, 4200);
  assert.strictEqual(s.overagePermitted, true);
  assert.strictEqual(s.quotaResetDate, "2026-10-01");
});

check("ignores unlimited zero-entitlement buckets", () => {
  const s = parseQuotaSnapshot({
    quota_snapshots: {
      chat: { unlimited: true, token_based_billing: true, credits_used: 0, entitlement: 0 },
      completions: { unlimited: true, token_based_billing: true, credits_used: 0, entitlement: 0 },
    },
  });
  assert.strictEqual(s, null, "no AIC bucket should yield null, not a zero snapshot");
});

check("ignores legacy premium-request seats", () => {
  const s = parseQuotaSnapshot({
    quota_snapshots: {
      premium_interactions: { credits_used: 0, entitlement: 300, token_based_billing: false },
    },
  });
  assert.strictEqual(s, null, "token_based_billing:false is a premium-request quota, not AIC");
});

check("survives a garbage payload", () => {
  assert.strictEqual(parseQuotaSnapshot(null), null);
  assert.strictEqual(parseQuotaSnapshot({}), null);
  assert.strictEqual(parseQuotaSnapshot({ quota_snapshots: "nope" }), null);
});

// ─── buildDashboardData reconciliation ────────────────────────
// The cycle window follows the clock, so a hard-coded month stops being "inside
// the cycle" the day after it ends and the fixture's credits get dropped.
const NOW = new Date();
const DAY = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1)).toISOString().slice(0, 10);
const CYCLE_ANCHOR = NOW;

function scanWithCredits(credits) {
  return {
    sessions: [{
      sessionId: "s1", project: "p", firstDate: DAY, lastDate: DAY,
      turns: 1, toolCalls: 0, promptTokens: 0, outputTokens: 0,
      models: ["claude-opus-5"], aicCredits: 0, aicByDay: [],
    }],
    turns: [{
      sessionId: "s1", turnId: "t1", timestamp: DAY + "T10:00:00.000Z",
      modelFamily: "claude-opus-5", promptTokens: 0, outputTokens: 0,
      debugPromptTokens: 0, debugOutputTokens: 0, debugCachedTokens: 0,
      debugAicCredits: credits, debugLlmCalls: 1,
    }],
    toolCalls: [], subagents: [],
    stats: { sourceFiles: 1, canonicalSessions: 1, mirroredSessions: 0, mirrorCopiesPruned: 0,
             turnsStored: 1, toolCallsStored: 0, promptPreviews: 0, transcriptsFound: 0, debugLogSessions: 1 },
  };
}

// Local logs land short of the server ledger by design; 780 vs 800 is that gap.
const LOCAL = 780;
const snapshot = { ...parseQuotaSnapshot(WIRE) };

console.log("\nbuildDashboardData with a quota snapshot");

const dash = buildDashboardData(
  scanWithCredits(LOCAL), null, DEFAULT_AIC_CONFIG, undefined, CYCLE_ANCHOR, undefined, snapshot,
);
const aic = dash.aicSummary;

check("headline adopts GitHub's credits_used", () => {
  assert.strictEqual(aic.totalCredits, 800,
    `expected the server's 800, got ${aic.totalCredits}`);
});

check("budget uses the server entitlement, not the local plan table", () => {
  assert.strictEqual(aic.monthlyBudget, 5000,
    `expected the pooled 5000, got ${aic.monthlyBudget}`);
});

check("remaining mirrors the server value", () => {
  assert.strictEqual(aic.creditsRemaining, 4200);
});

check("no phantom overage when inside the real entitlement", () => {
  assert.strictEqual(aic.estimatedOverageCost, 0,
    `the per-user plan budget produced a fake overage of $${aic.estimatedOverageCost}`);
});

check("overage comes from GitHub's overage_count, not our subtraction", () => {
  // GitHub bills overage on its own basis. Deriving it from total-minus-budget
  // would report $0 here even though the server says 500 credits are over.
  const over = buildDashboardData(
    scanWithCredits(LOCAL), null, DEFAULT_AIC_CONFIG, undefined, CYCLE_ANCHOR, undefined,
    { ...snapshot, overageCount: 500 },
  ).aicSummary;
  assert.strictEqual(over.estimatedOverageCost, 5,
    `expected 500 credits x $0.01 = $5, got $${over.estimatedOverageCost}`);
});

check("quota block reports the drift for diagnosis", () => {
  assert.ok(aic.quota, "quota block missing");
  assert.strictEqual(aic.quota.localTotal, LOCAL);
  assert.strictEqual(aic.quota.creditsUsed, 800);
  assert.strictEqual(aic.quota.localDelta, 20,
    `expected the 20 gap, got ${aic.quota.localDelta}`);
});

check("byDay sums to the reconciled headline", () => {
  const sum = aic.byDay.reduce((s, d) => s + d.credits, 0);
  assert.ok(Math.abs(sum - aic.totalCredits) < 0.05,
    `byDay sums to ${sum} but headline is ${aic.totalCredits} — surfaces would disagree`);
});

check("the unattributed remainder lands inside the cycle", () => {
  for (const d of aic.byDay) {
    assert.ok(d.day >= aic.billingCycleStart && d.day <= aic.billingCycleEnd,
      `day ${d.day} escaped the cycle window`);
  }
});

check("isActualFromApi is set", () => {
  assert.strictEqual(aic.isActualFromApi, true);
});

check("pace derives from the reconciled total, not the local one", () => {
  // A local-only run rate projected against the pooled entitlement is what
  // produced the wildly inflated "projecting N% of budget" banner.
  assert.ok(aic.dailyAverage > 0, "dailyAverage should be positive");
  assert.ok(aic.dailyAverage <= aic.totalCredits,
    `dailyAverage ${aic.dailyAverage} exceeds the cycle total ${aic.totalCredits}`);
  const pct = (aic.projectedTotal / aic.monthlyBudget) * 100;
  assert.ok(pct < 1000,
    `projection is ${pct.toFixed(0)}% of budget — pace is still on the local basis`);
});

check("projection is never below what is already spent", () => {
  assert.ok(aic.projectedTotal >= aic.totalCredits,
    `projected ${aic.projectedTotal} < spent ${aic.totalCredits}`);
});

// ─── Fallback: no snapshot ────────────────────────────────────
console.log("\nbuildDashboardData without a quota snapshot");

const offline = buildDashboardData(
  scanWithCredits(LOCAL), null, DEFAULT_AIC_CONFIG, undefined, CYCLE_ANCHOR, undefined, null,
);

check("falls back to the locally derived total", () => {
  assert.strictEqual(offline.aicSummary.totalCredits, LOCAL);
  assert.strictEqual(offline.aicSummary.quota, undefined);
});

check("byDay still reconciles offline", () => {
  const sum = offline.aicSummary.byDay.reduce((s, d) => s + d.credits, 0);
  assert.ok(Math.abs(sum - offline.aicSummary.totalCredits) < 0.05,
    `byDay ${sum} vs headline ${offline.aicSummary.totalCredits}`);
});

// ─── Local total ahead of the server ──────────────────────────
console.log("\nlocal total ahead of the server (lagging snapshot)");

const ahead = buildDashboardData(
  scanWithCredits(900), null, DEFAULT_AIC_CONFIG, undefined, CYCLE_ANCHOR, undefined, snapshot,
);

check("server value still wins and byDay stays non-negative", () => {
  assert.strictEqual(ahead.aicSummary.totalCredits, 800);
  for (const d of ahead.aicSummary.byDay) {
    assert.ok(d.credits >= 0, `negative credits on ${d.day}: ${d.credits}`);
  }
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);

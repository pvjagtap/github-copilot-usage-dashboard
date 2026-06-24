/**
 * verify-rate-match-provider-guard.js
 *
 * Regression coverage for two related billability guards:
 *   1. Short local/BYOK aliases such as "gpt-4", "gpt-5", and "claude"
 *      must not reverse-substring match longer GitHub rate-table ids.
 *   2. OMP/Pi agent rows carry provider metadata; when that provider is
 *      explicitly non-Copilot, it must beat model-name heuristics.
 *
 * Run after compile:
 *   node tests/verify-rate-match-provider-guard.js
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
  DEFAULT_AIC_CONFIG,
} = require(path.join(OUT, "aicCredits.js"));
const { buildDashboardData } = require(path.join(OUT, "dashboardData.js"));

let failed = 0;
function ok(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? "  — " + detail : ""}`);
    failed++;
  }
}

const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);

console.log("\n== Test 1: short aliases do not reverse-match GitHub rate keys ==");
for (const model of ["gpt-4", "gpt-5", "claude"]) {
  ok(`${model} is NOT a known GitHub Copilot model`, calc.isKnownGHCModel(model) === false);
}

console.log("\n== Test 2: legitimate observed-name variants still match ==");
ok(
  "claude-opus-4-6 normalizes to claude-opus-4.6",
  calc.findModelRate("claude-opus-4-6")?.model === "claude-opus-4.6",
);
ok(
  "gpt-4o-mini-2024-07-18 keeps matching gpt-4o-mini",
  calc.findModelRate("gpt-4o-mini-2024-07-18")?.model === "gpt-4o-mini",
);

console.log("\n== Test 3: OMP/Pi provider metadata beats model-name heuristic ==");
const now = Date.now();
const emptyScan = {
  sessions: [],
  turns: [],
  toolCalls: [],
  subagents: [],
  stats: {
    sourceFiles: 0,
    canonicalSessions: 0,
    mirroredSessions: 0,
    mirrorCopiesPruned: 0,
    turnsStored: 0,
    toolCallsStored: 0,
    promptPreviews: 0,
    transcriptsFound: 0,
    debugLogSessions: 0,
  },
};
const agentScan = {
  sessions: [
    {
      source: "omp",
      sessionId: "local-ollama-github-looking-name",
      filePath: "synthetic",
      title: "",
      cwd: "",
      model: "claude-opus-4.6",
      provider: "ollama",
      llmCalls: 1,
      totalInput: 1000,
      totalOutput: 1000,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalTokens: 2000,
      totalCostCredits: 9,
      premiumRequests: 0,
      modelBreakdown: {
        "claude-opus-4.6": {
          input: 1000,
          output: 1000,
          cacheRead: 0,
          cacheWrite: 0,
          costCredits: 9,
          llmCalls: 1,
          provider: "ollama",
        },
      },
      firstTs: now,
      lastTs: now,
    },
    {
      source: "pi",
      sessionId: "copilot-provider-known-name",
      filePath: "synthetic",
      title: "",
      cwd: "",
      model: "claude-opus-4.6",
      provider: "github-copilot",
      llmCalls: 1,
      totalInput: 1000,
      totalOutput: 1000,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalTokens: 2000,
      totalCostCredits: 7,
      premiumRequests: 0,
      modelBreakdown: {
        "claude-opus-4.6": {
          input: 1000,
          output: 1000,
          cacheRead: 0,
          cacheWrite: 0,
          costCredits: 7,
          llmCalls: 1,
          provider: "github-copilot",
        },
      },
      firstTs: now,
      lastTs: now,
    },
  ],
  billingStart: now - 24 * 60 * 60 * 1000,
  totalInput: 2000,
  totalOutput: 2000,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  totalTokens: 4000,
  totalLlmCalls: 2,
  totalPremiumRequests: 0,
  ompSessionCount: 1,
  piSessionCount: 1,
  ompAllTimeSessions: 1,
  ompAllTimeLlmCalls: 1,
  ompAllTimeTokens: 2000,
  piAllTimeSessions: 1,
  piAllTimeLlmCalls: 1,
  piAllTimeTokens: 2000,
  scanMs: 0,
};

const dash = buildDashboardData(
  emptyScan,
  null,
  DEFAULT_AIC_CONFIG,
  agentScan,
  new Date(now - 1000).toISOString(),
);

ok(
  "explicit ollama provider keeps OMP GitHub-looking model out of billable credits",
  dash.agentSummary.ompTotalCredits === 0,
  `got ${dash.agentSummary.ompTotalCredits}`,
);
ok(
  "explicit github-copilot provider keeps Pi model billable",
  dash.agentSummary.piTotalCredits === 7,
  `got ${dash.agentSummary.piTotalCredits}`,
);
ok(
  "third-party agent cost is still visible as informational non-billable usage",
  Math.abs(dash.aicSummary.nonBillable.totalCredits - 9) < 0.001,
  `got ${dash.aicSummary.nonBillable.totalCredits}`,
);
ok(
  "third-party GitHub-looking model is provider-qualified in non-billable display",
  dash.aicSummary.nonBillable.byModel.some(row => row.model === "ollama/claude-opus-4.6"),
  JSON.stringify(dash.aicSummary.nonBillable.byModel.map(row => row.model)),
);
ok(
  "bare GitHub-looking model is not shown as non-billable",
  !dash.aicSummary.nonBillable.byModel.some(row => row.model === "claude-opus-4.6"),
  JSON.stringify(dash.aicSummary.nonBillable.byModel.map(row => row.model)),
);

console.log("\n== Test 4: CLI scanner totalAic is source of truth fallback ==");
const cliDash = buildDashboardData(
  emptyScan,
  null,
  DEFAULT_AIC_CONFIG,
  undefined,
  new Date(now - 1000).toISOString(),
  {
    sessions: [
      {
        sessionId: "cli-live-only-no-model-breakdown",
        filePath: "synthetic",
        primaryModel: "claude-sonnet-4.6",
        firstTs: now,
        lastTs: now,
        totalLivePrompts: 2,
        totalOutputTokens: 0,
        totalAic: 2,
        hasLedger: false,
        shutdownCount: 0,
        slashSkipped: 0,
        byModel: {},
      },
    ],
    allTimeSessions: 1,
    allTimeLivePrompts: 2,
    allTimeOutputTokens: 0,
    totalLivePrompts: 2,
    totalOutputTokens: 0,
    totalAic: 2,
    reconciledSessions: 0,
    liveOnlySessions: 1,
    driftAic: 0,
    billingStart: now - 24 * 60 * 60 * 1000,
    copilotHome: "synthetic",
    scanMs: 0,
  },
);
ok(
  "CLI source row uses cliScan.totalAic when per-model rows are missing",
  cliDash.agentSummary.cliTotalCredits === 2,
  `got ${cliDash.agentSummary.cliTotalCredits}`,
);

const cliZeroedDash = buildDashboardData(
  emptyScan,
  null,
  DEFAULT_AIC_CONFIG,
  undefined,
  new Date(now - 1000).toISOString(),
  {
    sessions: [
      {
        sessionId: "cli-prompts-zeroed-aic",
        filePath: "synthetic",
        primaryModel: "claude-sonnet-4.6",
        firstTs: now,
        lastTs: now,
        totalLivePrompts: 2,
        totalOutputTokens: 0,
        totalAic: 0,
        hasLedger: false,
        shutdownCount: 0,
        slashSkipped: 0,
        byModel: {
          "claude-sonnet-4.6": {
            livePrompts: 2,
            liveAic: 0,
            liveOutputTokens: 0,
            multiplier: 0,
          },
        },
      },
    ],
    allTimeSessions: 1,
    allTimeLivePrompts: 2,
    allTimeOutputTokens: 0,
    totalLivePrompts: 2,
    totalOutputTokens: 0,
    totalAic: 0,
    reconciledSessions: 0,
    liveOnlySessions: 1,
    driftAic: 0,
    billingStart: now - 24 * 60 * 60 * 1000,
    copilotHome: "synthetic",
    scanMs: 0,
  },
);
ok(
  "CLI source row recovers from zeroed liveAic when billable prompts exist",
  cliZeroedDash.agentSummary.cliTotalCredits === 2,
  `got ${cliZeroedDash.agentSummary.cliTotalCredits}`,
);

console.log("\n== Test 5: live OTel aliases are merged by billing model ==");
const liveAliasDash = buildDashboardData(
  emptyScan,
  {
    requests: 25,
    prompt: 1_230_000,
    completion: 14_300,
    cached: 1_120_000,
    traceCached: 1_120_000,
    metricCached: 0,
    lastSeen: new Date(now).toISOString(),
    byModel: new Map([
      [
        "gpt-5.5-2026-04-23",
        {
          model: "gpt-5.5-2026-04-23",
          requests: 12,
          prompt: 1_000_000,
          completion: 12_000,
          traceCached: 900_000,
          metricCached: 0,
          cached: 900_000,
          cacheWrite: 0,
        },
      ],
      [
        "gpt-5.5",
        {
          model: "gpt-5.5",
          requests: 13,
          prompt: 230_000,
          completion: 2_300,
          traceCached: 220_000,
          metricCached: 0,
          cached: 220_000,
          cacheWrite: 0,
        },
      ],
    ]),
    requestLog: [],
    lastRequest: null,
  },
  DEFAULT_AIC_CONFIG,
  undefined,
  new Date(now - 1000).toISOString(),
);
ok(
  "gpt-5.5 date alias and base model render as one live row",
  liveAliasDash.liveOtel.byModel.filter(row => row.model === "gpt-5.5").length === 1 &&
    !liveAliasDash.liveOtel.byModel.some(row => row.model === "gpt-5.5-2026-04-23"),
  JSON.stringify(liveAliasDash.liveOtel.byModel.map(row => row.model)),
);
ok(
  "merged gpt-5.5 row carries combined request count",
  liveAliasDash.liveOtel.byModel.find(row => row.model === "gpt-5.5")?.requests === 25,
  JSON.stringify(liveAliasDash.liveOtel.byModel),
);

console.log("\n== Test 6: exact AIC summary aliases are merged by billing model ==");
const todayIso = new Date(now).toISOString();
const exactAliasScan = {
  ...emptyScan,
  turns: [
    {
      sessionId: "exact-alias-session",
      turnIndex: 0,
      timestamp: todayIso,
      modelFamily: "gpt-5.5",
      promptTokens: 0,
      outputTokens: 0,
      debugPromptTokens: 0,
      debugOutputTokens: 0,
      debugCachedTokens: 0,
      debugLlmCalls: 2,
      debugAicCredits: 3,
      debugLastRequestAic: 2,
      debugLastRequestTs: todayIso,
      debugRequests: [
        {
          timestamp: todayIso,
          model: "gpt-5.5",
          prompt: 1000,
          output: 100,
          cached: 0,
          nanoAiu: 1_000_000_000,
        },
        {
          timestamp: todayIso,
          model: "gpt-5.5-2026-04-23",
          prompt: 1000,
          output: 100,
          cached: 0,
          nanoAiu: 2_000_000_000,
        },
      ],
      toolCallRounds: 0,
      toolCallResults: 0,
      workspaceName: "synthetic",
    },
  ],
};
const exactAliasDash = buildDashboardData(
  exactAliasScan,
  null,
  DEFAULT_AIC_CONFIG,
  undefined,
  new Date(now - 1000).toISOString(),
);
ok(
  "actual-credit date alias and base model render as one AIC summary row",
  exactAliasDash.aicSummary.byModel.filter(row => row.model === "gpt-5.5").length === 1 &&
    !exactAliasDash.aicSummary.byModel.some(row => row.model === "gpt-5.5-2026-04-23"),
  JSON.stringify(exactAliasDash.aicSummary.byModel.map(row => row.model)),
);
ok(
  "merged actual-credit row carries combined credits",
  Math.abs((exactAliasDash.aicSummary.byModel.find(row => row.model === "gpt-5.5")?.totalCredits ?? 0) - 3) < 0.001,
  JSON.stringify(exactAliasDash.aicSummary.byModel),
);

if (failed === 0) {
  console.log("\nAll rate-match/provider guard checks passed.\n");
  process.exit(0);
} else {
  console.error(`\n${failed} check(s) FAILED.\n`);
  process.exit(1);
}
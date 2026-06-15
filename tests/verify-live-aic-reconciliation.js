const assert = require("assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { buildDashboardData } = require(path.join(ROOT, "out", "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(ROOT, "out", "aicCredits.js"));

const today = new Date().toISOString().slice(0, 10);
const activationTime = `${today}T00:00:00.000Z`;

const scan = {
  sessions: [],
  turns: [
    {
      sessionId: "s1",
      turnIndex: 0,
      timestamp: `${today}T10:00:00.000Z`,
      modelFamily: "claude-opus-4.7",
      promptTokens: 0,
      outputTokens: 0,
      debugPromptTokens: 42800,
      debugOutputTokens: 0,
      debugCachedTokens: 0,
      debugLlmCalls: 1,
      debugAicCredits: 21.4,
      debugLastRequestAic: 21.4,
      debugLastRequestTs: `${today}T10:00:05.000Z`,
      debugByModel: {
        "claude-opus-4.7": {
          prompt: 42800,
          output: 0,
          cached: 0,
          calls: 1,
          nanoAiu: 21_400_000_000,
        },
      },
      toolCallRounds: 0,
      toolCallResults: 0,
      workspaceName: "",
    },
  ],
  toolCalls: [],
  subagents: [],
  stats: {},
};

const pendingRequest = {
  requestId: "r2",
  traceId: "trace-r2",
  conversationId: "c1",
  timestamp: `${today}T10:01:00.000Z`,
  modelName: "claude-opus-4.7",
  promptTokens: 163600,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  ttftMs: null,
};

const liveStats = {
  requests: 2,
  prompt: 206400,
  completion: 0,
  cached: 0,
  traceCached: 0,
  metricCached: 0,
  lastSeen: pendingRequest.timestamp,
  byModel: new Map([
    [
      "claude-opus-4.7",
      {
        model: "claude-opus-4.7",
        requests: 2,
        prompt: 206400,
        completion: 0,
        traceCached: 0,
        metricCached: 0,
        cached: 0,
        cacheWrite: 0,
      },
    ],
  ]),
  requestLog: [
    {
      requestId: "r1",
      traceId: "trace-r1",
      conversationId: "c1",
      timestamp: `${today}T10:00:01.000Z`,
      modelName: "claude-opus-4.7",
      promptTokens: 42800,
      completionTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      ttftMs: null,
    },
    pendingRequest,
  ],
  lastRequest: pendingRequest,
};

const dash = buildDashboardData(scan, liveStats, DEFAULT_AIC_CONFIG, undefined, activationTime);

assert.strictEqual(dash.liveOtel.sessionAIC, 103.2);
assert.strictEqual(dash.liveOtel.lastRequestAIC, 81.8);
assert.strictEqual(dash.aicSummary.totalCredits, 103.2);

const laterDebugRequest = {
  timestamp: `${today}T10:02:05.000Z`,
  model: "claude-opus-4.7",
  prompt: 11580,
  output: 0,
  cached: 0,
  nanoAiu: 5_790_000_000,
};

const middlePendingRequest = {
  requestId: "r-middle",
  traceId: "trace-r-middle",
  conversationId: "c1",
  timestamp: `${today}T10:01:00.000Z`,
  modelName: "claude-opus-4.7",
  promptTokens: 30100,
  completionTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  ttftMs: null,
};

const watermarkRegressionScan = {
  ...scan,
  turns: [
    {
      ...scan.turns[0],
      debugRequests: [
        {
          timestamp: `${today}T10:00:05.000Z`,
          model: "claude-opus-4.7",
          prompt: 42800,
          output: 0,
          cached: 0,
          nanoAiu: 21_400_000_000,
        },
      ],
    },
    {
      ...scan.turns[0],
      turnIndex: 1,
      timestamp: `${today}T10:02:05.000Z`,
      debugPromptTokens: 11580,
      debugAicCredits: 5.79,
      debugLastRequestAic: 5.79,
      debugLastRequestTs: laterDebugRequest.timestamp,
      debugByModel: {
        "claude-opus-4.7": {
          prompt: 11580,
          output: 0,
          cached: 0,
          calls: 1,
          nanoAiu: 5_790_000_000,
        },
      },
      debugRequests: [laterDebugRequest],
    },
  ],
};

const watermarkRegressionLiveStats = {
  ...liveStats,
  requests: 3,
  prompt: 42800 + middlePendingRequest.promptTokens + laterDebugRequest.prompt,
  lastSeen: laterDebugRequest.timestamp,
  byModel: new Map([
    [
      "claude-opus-4.7",
      {
        model: "claude-opus-4.7",
        requests: 3,
        prompt: 42800 + middlePendingRequest.promptTokens + laterDebugRequest.prompt,
        completion: 0,
        traceCached: 0,
        metricCached: 0,
        cached: 0,
        cacheWrite: 0,
      },
    ],
  ]),
  requestLog: [
    liveStats.requestLog[0],
    middlePendingRequest,
    {
      requestId: "r-later",
      traceId: "trace-r-later",
      conversationId: "c1",
      timestamp: `${today}T10:02:00.000Z`,
      modelName: laterDebugRequest.model,
      promptTokens: laterDebugRequest.prompt,
      completionTokens: laterDebugRequest.output,
      cachedTokens: laterDebugRequest.cached,
      cacheWriteTokens: 0,
      ttftMs: null,
    },
  ],
  lastRequest: {
    requestId: "r-later",
    traceId: "trace-r-later",
    conversationId: "c1",
    timestamp: `${today}T10:02:00.000Z`,
    modelName: laterDebugRequest.model,
    promptTokens: laterDebugRequest.prompt,
    completionTokens: laterDebugRequest.output,
    cachedTokens: laterDebugRequest.cached,
    cacheWriteTokens: 0,
    ttftMs: null,
  },
};

const watermarkDash = buildDashboardData(watermarkRegressionScan, watermarkRegressionLiveStats, DEFAULT_AIC_CONFIG, undefined, activationTime);

// Count-based matching: 2 debug requests, 3 OTel requests (all claude-opus family)
// → 1 pending = newest OTel (r-later at 10:02:00, 11580 tokens)
// sessionAIC = debug(21.4 + 5.79) + estimate(11580 opus) = 27.19 + 5.79 = 32.98
assert.strictEqual(watermarkDash.liveOtel.sessionAIC, 32.98);
assert.strictEqual(watermarkDash.liveOtel.lastRequestAIC, 5.79);
assert.strictEqual(watermarkDash.aicSummary.totalCredits, 32.98);

console.log("PASS live AIC reconciliation: debug truth + pending OTel request =", dash.liveOtel.sessionAIC);
console.log("PASS count-based matching: 2 debug + 1 pending =", watermarkDash.liveOtel.sessionAIC);

// ─── Test 3: Model aliasing (debug=4.7, OTel=4.6) must still match ──────
// The debug log records the API response model (e.g. claude-opus-4.7) while
// OTel traces record the request model (e.g. claude-opus-4.6). The matching
// must handle this version aliasing to avoid double-counting.
const aliasedScan = {
  sessions: [],
  turns: [
    {
      sessionId: "s-alias",
      turnIndex: 0,
      timestamp: `${today}T11:00:00.000Z`,
      modelFamily: "claude-opus-4.7",
      promptTokens: 0,
      outputTokens: 0,
      debugPromptTokens: 50000,
      debugOutputTokens: 500,
      debugCachedTokens: 45000,
      debugLlmCalls: 1,
      debugAicCredits: 5.0,
      debugLastRequestAic: 5.0,
      debugLastRequestTs: `${today}T11:00:05.000Z`,
      debugByModel: {
        "claude-opus-4.7": {
          prompt: 50000,
          output: 500,
          cached: 45000,
          calls: 1,
          nanoAiu: 5_000_000_000,
        },
      },
      debugRequests: [
        {
          timestamp: `${today}T11:00:05.000Z`,
          model: "claude-opus-4.7",  // response model
          prompt: 50000,
          output: 500,
          cached: 45000,
          nanoAiu: 5_000_000_000,
        },
      ],
      toolCallRounds: 0,
      toolCallResults: 0,
      workspaceName: "",
    },
  ],
  toolCalls: [],
  subagents: [],
  stats: {},
};

const aliasedLiveStats = {
  requests: 1,
  prompt: 50000,
  completion: 500,
  cached: 45000,
  traceCached: 45000,
  metricCached: 0,
  lastSeen: `${today}T11:00:01.000Z`,
  byModel: new Map([
    [
      "claude-opus-4.6",  // request model — different from debug's 4.7!
      {
        model: "claude-opus-4.6",
        requests: 1,
        prompt: 50000,
        completion: 500,
        traceCached: 45000,
        metricCached: 0,
        cached: 45000,
        cacheWrite: 0,
      },
    ],
  ]),
  requestLog: [
    {
      requestId: "r-alias",
      traceId: "trace-r-alias",
      conversationId: "c-alias",
      timestamp: `${today}T11:00:01.000Z`,
      modelName: "claude-opus-4.6",  // request model
      promptTokens: 50000,
      completionTokens: 500,
      cachedTokens: 45000,
      cacheWriteTokens: 0,
      ttftMs: null,
    },
  ],
  lastRequest: {
    requestId: "r-alias",
    traceId: "trace-r-alias",
    conversationId: "c-alias",
    timestamp: `${today}T11:00:01.000Z`,
    modelName: "claude-opus-4.6",
    promptTokens: 50000,
    completionTokens: 500,
    cachedTokens: 45000,
    cacheWriteTokens: 0,
    ttftMs: null,
  },
};

const aliasedDash = buildDashboardData(aliasedScan, aliasedLiveStats, DEFAULT_AIC_CONFIG, undefined, activationTime);

// sessionAIC must equal the debug truth (5.0), NOT debug + OTel estimate (which would be ~10)
assert.strictEqual(aliasedDash.liveOtel.sessionAIC, 5.0,
  `Model aliasing: sessionAIC should be 5.0 (debug truth) but got ${aliasedDash.liveOtel.sessionAIC} — likely double-counted due to model mismatch`);

console.log("PASS model aliasing: claude-opus-4.7 (debug) matches claude-opus-4.6 (OTel), sessionAIC =", aliasedDash.liveOtel.sessionAIC);
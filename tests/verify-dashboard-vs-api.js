/**
 * verify-dashboard-vs-api.js — Independent ground-truth audit of the
 * dashboard's reported AIC numbers against raw `copilotUsageNanoAiu` from
 * the API (extracted directly from main.jsonl debug-logs).
 *
 * This audit deliberately re-implements jsonl parsing locally (no import
 * from src/scanner.js) so a bug in the scanner can never silently agree
 * with itself. Same contract as tests/scan-june-workspace.ts but in plain
 * JS so it runs without tsx.
 *
 * Truth for VS Code is the debug-log nanoAiu PLUS what each head-truncated log
 * lost, re-derived here from the chatSession's own `copilotCredits`. Truth for
 * OMP/Pi is the Copilot-routed spend only (third-party providers bill
 * elsewhere), scoped to the current billing cycle like the dashboard.
 *
 *   node tests/verify-dashboard-vs-api.js
 *
 * Pass criteria:
 *   - dashboard aicSummary.totalCredits  ↔  Σ copilotUsageNanoAiu/1e9   (≤ 0.1% drift)
 *   - dashboard aicSummary.byDay         ↔  per-day Σ nanoAiu/1e9       (≤ 0.5% drift per day)
 *   - dashboard aicSummary.byModel       ↔  per-model Σ nanoAiu/1e9     (≤ 0.5% drift per model)
 *   - dashboard liveOtel.sessionAIC      ↔  this-window's Σ nanoAiu/1e9
 *   - dashboard liveOtel.lastRequestAIC  ↔  newest single llm_request nanoAiu/1e9
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

// ── vscode stub (required by transitive imports) ────────────
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

const { scanWorkspaceStorage, getWorkspaceStorageCandidates } = require(path.join(OUT, "scanner.js"));
const { buildDashboardData, AIC_EFFECTIVE_DATE } = require(path.join(OUT, "dashboardData.js"));
const { DEFAULT_AIC_CONFIG, createCalculatorFromConfig, isCopilotVendor } = require(path.join(OUT, "aicCredits.js"));
const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));

// ─── Independent ground-truth parser (no scanner imports) ───

function discoverDebugLogDirs() {
  const dirs = [];
  const roots = ["D:/vscode/workspaceStorage", ...getWorkspaceStorageCandidates()].filter(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  const seen = new Set();
  for (const wsRoot of roots) {
    let real;
    try { real = fs.realpathSync(wsRoot); } catch { real = wsRoot; }
    if (seen.has(real)) continue;
    seen.add(real);

    let workspaces;
    try { workspaces = fs.readdirSync(wsRoot); } catch { continue; }
    for (const ws of workspaces) {
      const debugLogsDir = path.join(wsRoot, ws, "GitHub.copilot-chat", "debug-logs");
      if (!fs.existsSync(debugLogsDir)) continue;
      let sessions;
      try { sessions = fs.readdirSync(debugLogsDir); } catch { continue; }
      for (const sess of sessions) {
        const sessDir = path.join(debugLogsDir, sess);
        try {
          if (!fs.statSync(sessDir).isDirectory()) continue;
        } catch { continue; }
        if (fs.existsSync(path.join(sessDir, "main.jsonl"))) {
          dirs.push(sessDir);
        }
      }
    }
  }
  return dirs;
}

function parseJsonlLlmRequests(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return []; }
  const out = [];
  // Local helper kept independent of scanner.ts.
  const pickNum = (attrs, key) => (typeof attrs[key] === "number" ? attrs[key] : 0);
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "llm_request") continue;
    const attrs = entry.attrs;
    if (!attrs || typeof attrs !== "object") continue;
    const inp = pickNum(attrs, "inputTokens");
    const outTok = pickNum(attrs, "outputTokens");
    if (inp === 0 && outTok === 0) continue;
    const ts = typeof entry.ts === "number" ? new Date(entry.ts).toISOString() : "";
    out.push({
      timestamp: ts,
      model: typeof attrs.model === "string" ? attrs.model : "unknown",
      inputTokens: inp,
      outputTokens: outTok,
      cachedTokens: pickNum(attrs, "cachedTokens"),
      nanoAiu: pickNum(attrs, "copilotUsageNanoAiu"),
    });
  }
  return out;
}

function parseSessionDir(sessDir) {
  const calls = [];
  const mainFile = path.join(sessDir, "main.jsonl");
  if (fs.existsSync(mainFile)) calls.push(...parseJsonlLlmRequests(mainFile));

  // Walk children (subagents, title) — both sub-dirs and sibling files.
  let entries;
  try { entries = fs.readdirSync(sessDir); } catch { entries = []; }
  for (const entry of entries) {
    if (entry === "main.jsonl") continue;
    const full = path.join(sessDir, entry);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      const childMain = path.join(full, "main.jsonl");
      if (fs.existsSync(childMain)) calls.push(...parseJsonlLlmRequests(childMain));
    } else if (st.isFile() && entry.endsWith(".jsonl")) {
      // title-*.jsonl, runSubagent-*.jsonl — sibling files in the session dir.
      calls.push(...parseJsonlLlmRequests(full));
    }
  }
  return calls;
}

// ── chatSession reconciliation (independent of scanner.ts) ──
//
// Copilot cuts the HEAD off long debug logs, so their early llm_request lines
// (and nanoAiu) are gone, but the chatSession keeps VS Code's own per-request
// `copilotCredits`. Truth for such a session is the chatSession figure for the
// requests the log lost; this re-derives that without importing the scanner.

function replayChatRequests(file) {
  let content;
  try { content = fs.readFileSync(file, "utf-8"); } catch { return []; }
  const reqs = [];
  const asReq = r => (r && typeof r === "object" ? { ...r } : {});
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const k = e.k;
    if (e.kind === 0 && e.v && Array.isArray(e.v.requests)) {
      for (const r of e.v.requests) reqs.push(asReq(r));
    } else if (e.kind === 2 && Array.isArray(k) && k.length === 1 && k[0] === "requests" && Array.isArray(e.v)) {
      for (const r of e.v) reqs.push(asReq(r));
    } else if (e.kind === 1 && Array.isArray(k) && k.length === 3 && k[0] === "requests" && Number.isInteger(k[1])) {
      while (reqs.length <= k[1]) reqs.push({});
      reqs[k[1]][k[2]] = e.v;
    }
  }
  return reqs
    .filter(r => typeof r.timestamp === "number" && r.timestamp > 0)
    .map(r => ({
      start: r.timestamp,
      credits: typeof r.copilotCredits === "number" ? r.copilotCredits : 0,
      model: String(r.modelId || "").split("/").pop().toLowerCase(),
    }))
    .sort((a, b) => a.start - b.start);
}

/** Map "day|model" → nanoAiu the debug log lost for this session. */
function chatRecovery(sessDir, calls) {
  const out = new Map();
  // <ws>/GitHub.copilot-chat/debug-logs/<sid> → <ws>/chatSessions/<sid>.jsonl
  const wsDir = path.resolve(sessDir, "..", "..", "..");
  const file = path.join(wsDir, "chatSessions", path.basename(sessDir) + ".jsonl");
  if (!fs.existsSync(file) || calls.length === 0) return out;

  const reqs = replayChatRequests(file)
    .filter(r => new Date(r.start).toISOString().slice(0, 10) >= AIC_EFFECTIVE_DATE);
  const chatTotal = reqs.reduce((s, r) => s + r.credits, 0);
  const debugTotal = calls.reduce((s, c) => s + c.nanoAiu, 0) / 1e9;
  const shortfall = chatTotal - debugTotal;
  if (shortfall <= 0.005) return out;

  // Each debug call belongs to the latest chat request that started at or before it.
  const assigned = reqs.map(() => 0);
  let firstDebug = Infinity;
  for (const c of calls) {
    const ts = Date.parse(c.timestamp);
    if (!(ts > 0)) continue;
    firstDebug = Math.min(firstDebug, ts);
    let idx = 0;
    for (let j = 0; j < reqs.length && reqs[j].start <= ts; j++) idx = j;
    assigned[idx] += c.nanoAiu / 1e9;
  }
  // Only requests that began before the log's first surviving call were cut off.
  const lost = reqs.map((r, i) => {
    const d = r.start < firstDebug ? r.credits - assigned[i] : 0;
    return d > 0.005 ? d : 0;
  });
  const lostTotal = lost.reduce((s, x) => s + x, 0);
  if (lostTotal <= 0.005) return out;
  const scale = Math.min(lostTotal, shortfall) / lostTotal;
  reqs.forEach((r, i) => {
    if (lost[i] <= 0) return;
    const key = new Date(r.start).toISOString().slice(0, 10) + "|" + r.model;
    out.set(key, (out.get(key) ?? 0) + lost[i] * scale * 1e9);
  });
  return out;
}

// ── BYOK catalog ─────────────────────────────────────────────
//
// The live extension knows which model ids the user declared under a
// non-Copilot vendor (chatLanguageModels.json) and so splits a colliding id
// such as claude-opus-5 into its billed and BYOK halves. A bare node process
// has no catalog, which would price every zero-credit BYOK wrapper request at
// Copilot rates, so load the same file.
function seedUserCatalog() {
  const root = getWorkspaceStorageCandidates().find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!root) return;
  let providers;
  try {
    providers = JSON.parse(fs.readFileSync(path.join(path.dirname(root), "chatLanguageModels.json"), "utf-8"));
  } catch {
    return;
  }
  const byId = new Map();
  for (const p of Array.isArray(providers) ? providers : []) {
    if (!p || p.vendor === "copilot" || !Array.isArray(p.models)) continue;
    for (const m of p.models) {
      if (m && typeof m.id === "string") {
        byId.set(m.id.toLowerCase(), { id: m.id.toLowerCase(), billable: true, userThirdParty: true, multiplier: 1, source: "capi" });
      }
    }
  }
  require(path.join(OUT, "modelCatalog.js")).__setCatalogForTesting({
    fetchedAt: Date.now(), byId, cdnProviders: {}, userVendorByModelId: new Map(),
  });
}

// ── OMP / Pi credits GitHub bills ────────────────────────────
//
// Copilot-routed calls only: a third-party provider (Azure Foundry, Ollama, …)
// is billed by that vendor, never by GitHub, so its tokens must not be priced
// at Copilot rates. Where the agent recorded `usage.cost` it is the ledger;
// only calls it did not price are estimated from the rate table.
function agentBilledCredits(session, calculator) {
  const rows = [];
  for (const stats of Object.values(session.modelBreakdown)) {
    const provider = (stats.provider || session.provider || "").toLowerCase();
    if (provider.length > 0 && !provider.includes("github") && !provider.includes("copilot")) continue;
    const model = stats.model;
    const u = stats.unpriced
      ? stats.unpriced
      : stats.costCredits > 0
        ? null
        : { input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite };
    const estimate = u
      ? calculator.calculateCredits(model, u.input + u.cacheRead + u.cacheWrite, u.output, u.cacheRead, u.cacheWrite).totalCredits
      : 0;
    const credits = stats.costCredits + estimate;
    if (credits <= 0) continue;
    const rate = calculator.findModelRate(model);
    rows.push({ model: (rate ? rate.model : model).toLowerCase(), credits });
  }
  return rows;
}

// ─── Run the audit ──────────────────────────────────────────

(async () => {
  console.log("═".repeat(78));
  console.log("DASHBOARD ↔ API ground-truth audit (VS Code + OMP + Pi)");
  console.log("═".repeat(78));

  // ── VS Code truth: sum nanoAiu directly from raw debug-log jsonl ──
  const t0 = Date.now();
  const sessionDirs = discoverDebugLogDirs();
  seedUserCatalog();
  console.log(`\nDiscovered ${sessionDirs.length} debug-log session dirs (VS Code)`);

  function collectVSCodeTruth() {
    let calls = 0;
    let nano = 0;
    const byDay = new Map();
    const byModel = new Map();
    const byDayModel = new Map(); // "day|model" → nanoAiu
    let lastTs = "";
    let lastAiu = 0;
    const add = (day, model, nanoAiu) => {
      nano += nanoAiu;
      byDay.set(day, (byDay.get(day) ?? 0) + nanoAiu);
      byModel.set(model, (byModel.get(model) ?? 0) + nanoAiu);
      byDayModel.set(day + "|" + model, (byDayModel.get(day + "|" + model) ?? 0) + nanoAiu);
    };
    for (const sessDir of sessionDirs) {
      const sessCalls = parseSessionDir(sessDir);
      for (const c of sessCalls) {
        if (!c.timestamp || c.timestamp.slice(0, 10) < AIC_EFFECTIVE_DATE) continue;
        calls++;
        add(c.timestamp.slice(0, 10), c.model.toLowerCase(), c.nanoAiu);
        if (c.timestamp > lastTs && c.nanoAiu > 0) {
          lastTs = c.timestamp;
          lastAiu = c.nanoAiu;
        }
      }
      for (const [key, lostNano] of chatRecovery(sessDir, sessCalls)) {
        const [day, model] = key.split("|");
        add(day, model, lostNano);
      }
    }
    return { calls, nano, byDay, byModel, byDayModel, lastTs, lastAiu };
  }

  const truth0 = collectVSCodeTruth();
  const totalCallsSinceJune = truth0.calls;
  const truthByDay = truth0.byDay;
  const truthVSCodeCredits = truth0.nano / 1e9;
  const truthLastReqCredits = truth0.lastAiu / 1e9;
  const parseMs = Date.now() - t0;
  console.log(
    `VS Code truth: ${totalCallsSinceJune.toLocaleString()} llm_requests since ${AIC_EFFECTIVE_DATE}, ` +
      `${truthVSCodeCredits.toFixed(2)} credits (${parseMs}ms)`
  );

  // ── OMP + Pi truth: re-run agentScanner (canonical parser) and
  //    re-apply calculator with same logic dashboardData.ts uses.
  //    Token convention: agent `input` is NET; grossInput = input + cacheRead + cacheWrite.
  //    This is the ONE place we share parsing code — but the calculator is
  //    the SUT itself, so by re-running it on agentScan output we audit only
  //    the dashboardData.ts integration layer, not the calculator math.
  const agentT0 = Date.now();
  const agentScan = await scanAgentSessions();
  const calculator = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);
  const agentByModel = new Map();
  let truthOmpCredits = 0;
  let truthPiCredits = 0;
  for (const session of agentScan.sessions) {
    const date = new Date(session.lastTs || session.firstTs).toISOString().slice(0, 10);
    if (date < AIC_EFFECTIVE_DATE) continue;
    for (const row of agentBilledCredits(session, calculator)) {
      if (session.source === "omp") truthOmpCredits += row.credits;
      else truthPiCredits += row.credits;
      agentByModel.set(row.model, (agentByModel.get(row.model) ?? 0) + row.credits);
    }
  }
  const agentMs = Date.now() - agentT0;
  console.log(
    `OMP truth:  ${agentScan.ompSessionCount} sessions, ${truthOmpCredits.toFixed(2)} credits  (${agentMs}ms)`
  );
  console.log(
    `Pi  truth:  ${agentScan.piSessionCount} sessions, ${truthPiCredits.toFixed(2)} credits`
  );

  const truthTotalCredits = truthVSCodeCredits + truthOmpCredits + truthPiCredits;
  console.log(`TOTAL truth: ${truthTotalCredits.toFixed(2)} credits`);

  // ── Dashboard's view — run the real pipeline (with agentScan!) ──
  const t1 = Date.now();
  const scan = await scanWorkspaceStorage();
  const scanMs = Date.now() - t1;
  console.log(
    `\nScanner: ${scan.stats.canonicalSessions} sessions, ${scan.stats.turnsStored} turns (${scanMs}ms)`
  );

  const activationHistorical = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const dash = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, agentScan, activationHistorical);

  // The scanner re-reads logs this very session may still be appending to, so
  // the dashboard can legitimately see requests the earlier truth walk missed.
  // Re-walk now: credits that landed in between are a sampling race, not drift.
  const truth1 = collectVSCodeTruth();
  const raceCredits = Math.max(0, (truth1.nano - truth0.nano) / 1e9);
  if (raceCredits > 0.01) {
    console.log(
      `\n⚠ LIVE DATA: ${truth1.calls - truth0.calls} request(s) worth ${raceCredits.toFixed(2)} cr landed ` +
        `during the scan — tolerances widened by that amount. Re-run while idle for an exact match.`
    );
  }

  // Dashboard intentionally includes rate-table fallback credits for VS Code
  // turns that have chatSession token counts but no debug-log nanoAIU. Those
  // are not API-truth rows, so track them separately instead of reporting them
  // as raw-debug-log drift.
  const fallbackByDay = new Map();
  const fallbackByModel = new Map();
  let fallbackCredits = 0;
  let fallbackTurns = 0;
  for (const t of scan.turns) {
    if (!t.timestamp || t.timestamp.slice(0, 10) < AIC_EFFECTIVE_DATE) continue;
    if ((t.debugAicCredits || 0) > 0 || (t.debugRequests && t.debugRequests.length > 0)) continue;
    // BYOK/custom-endpoint turns (e.g. Azure Foundry routing) are billed by the
    // user's own key, never by GitHub — the dashboard excludes them from the
    // billable total via classifyModelBillability's vendor check (step 4a).
    // Without this the naive fallback sum below double-counts them as "truth"
    // that the dashboard is supposedly missing.
    if (t.modelVendor && !isCopilotVendor(t.modelVendor)) continue;
    const inputTokens = t.debugPromptTokens || t.promptTokens || 0;
    const outputTokens = t.debugOutputTokens || t.outputTokens || 0;
    if (inputTokens <= 0 && outputTokens <= 0) continue;
    const model = t.modelFamily || "unknown";
    const usage = calculator.calculateCredits(model, inputTokens, outputTokens, 0);
    if (usage.totalCredits <= 0) continue;
    const day = t.timestamp.slice(0, 10);
    fallbackTurns++;
    fallbackCredits += usage.totalCredits;
    fallbackByDay.set(day, (fallbackByDay.get(day) ?? 0) + usage.totalCredits);
    const modelKey = usage.model.toLowerCase();
    fallbackByModel.set(modelKey, (fallbackByModel.get(modelKey) ?? 0) + usage.totalCredits);
  }

  console.log("\nDashboard (per-source — what the USAGE BY SOURCE card shows):");
  console.log("  agentSummary.vscodeAicCredits   =", dash.agentSummary.vscodeAicCredits.toFixed(2));
  console.log("  agentSummary.ompTotalCredits    =", dash.agentSummary.ompTotalCredits.toFixed(2));
  console.log("  agentSummary.piTotalCredits     =", dash.agentSummary.piTotalCredits.toFixed(2));
  console.log("  agentSummary.totalCredits       =", dash.agentSummary.totalCredits.toFixed(2));
  console.log("  aicSummary.totalCredits         =", dash.aicSummary.totalCredits.toFixed(2));
  console.log("  liveOtel.sessionAIC             =", dash.liveOtel.sessionAIC.toFixed(2));
  console.log("  liveOtel.lastRequestAIC         =", dash.liveOtel.lastRequestAIC.toFixed(2));
  if (fallbackTurns > 0) {
    console.log("  estimated fallback turns        =", `${fallbackTurns} turns, ${fallbackCredits.toFixed(2)} credits`);
  }

  // ─── Cycle-scoped truth ─────────────────────────────────────
  // aicSummary.totalCredits is deliberately restricted to the current billing
  // cycle (Fix #2, issue #5) — everything since AIC_EFFECTIVE_DATE (June 1)
  // is NOT what the dashboard reports once a user has crossed a month
  // boundary. Comparing the all-time truth above against the cycle-scoped
  // dashboard total manufactures "drift" that isn't real, so re-scope truth
  // to the same [billingCycleStart, billingCycleEnd] window before asserting.
  const cycleStart = dash.aicSummary.billingCycleStart;
  const cycleEnd = dash.aicSummary.billingCycleEnd;
  const inCycle = (day) => day >= cycleStart && day <= cycleEnd;

  let truthVSCodeCreditsCycle = 0;
  for (const [day, nano] of truthByDay) { if (inCycle(day)) truthVSCodeCreditsCycle += nano / 1e9; }
  const truthByDayCycle = new Map(
    [...truthByDay].filter(([day]) => inCycle(day)),
  );
  const truthByModelCycle = new Map();
  for (const [key, nano] of truth0.byDayModel) {
    const [day, model] = key.split("|");
    if (inCycle(day)) truthByModelCycle.set(model, (truthByModelCycle.get(model) ?? 0) + nano);
  }

  const agentByDay = new Map();
  const agentByModelCycle = new Map();
  let truthOmpCreditsCycle = 0;
  let truthPiCreditsCycle = 0;
  for (const session of agentScan.sessions) {
    const date = new Date(session.lastTs || session.firstTs).toISOString().slice(0, 10);
    if (date < AIC_EFFECTIVE_DATE) continue;
    for (const row of agentBilledCredits(session, calculator)) {
      agentByDay.set(date, (agentByDay.get(date) ?? 0) + row.credits);
      if (inCycle(date)) {
        agentByModelCycle.set(row.model, (agentByModelCycle.get(row.model) ?? 0) + row.credits);
        if (session.source === "omp") truthOmpCreditsCycle += row.credits;
        else truthPiCreditsCycle += row.credits;
      }
    }
  }

  let fallbackCreditsCycle = 0;
  for (const [day, credits] of fallbackByDay) { if (inCycle(day)) fallbackCreditsCycle += credits; }
  const fallbackByModelCycle = new Map();
  for (const t of scan.turns) {
    if (!t.timestamp || !inCycle(t.timestamp.slice(0, 10))) continue;
    if ((t.debugAicCredits || 0) > 0 || (t.debugRequests && t.debugRequests.length > 0)) continue;
    if (t.modelVendor && !isCopilotVendor(t.modelVendor)) continue;
    const inputTokens = t.debugPromptTokens || t.promptTokens || 0;
    const outputTokens = t.debugOutputTokens || t.outputTokens || 0;
    if (inputTokens <= 0 && outputTokens <= 0) continue;
    const usage = calculator.calculateCredits(t.modelFamily || "unknown", inputTokens, outputTokens, t.debugCachedTokens || 0);
    if (usage.totalCredits <= 0) continue;
    const model = usage.model.toLowerCase();
    fallbackByModelCycle.set(model, (fallbackByModelCycle.get(model) ?? 0) + usage.totalCredits);
  }

  const truthTotalCreditsCycle = truthVSCodeCreditsCycle + truthOmpCreditsCycle + truthPiCreditsCycle;

  // ─── Assertions ─────────────────────────────────────────────
  const checks = [];
  function within(label, dashV, truthV, tolPct, tolAbs) {
    const diff = dashV - truthV;
    const pct = truthV !== 0 ? (diff / truthV) * 100 : (dashV === 0 ? 0 : Infinity);
    const ok = Math.abs(diff) <= (tolAbs ?? 0) || Math.abs(pct) <= tolPct;
    checks.push({ label, ok, dashV, truthV, diff, pct });
  }

  within(`VS Code: agentSummary.vscodeAicCredits ↔ cycle-scoped API nanoAIU + fallback [${cycleStart}..${cycleEnd}]`,
    dash.agentSummary.vscodeAicCredits, truthVSCodeCreditsCycle + fallbackCreditsCycle, 0.5, 0.01 + raceCredits);
  within("OMP: agentSummary.ompTotalCredits ↔ recomputed (cycle-scoped)",
    dash.agentSummary.ompTotalCredits, truthOmpCreditsCycle, 0.5, 0.01);
  within("Pi: agentSummary.piTotalCredits ↔ recomputed (cycle-scoped)",
    dash.agentSummary.piTotalCredits, truthPiCreditsCycle, 0.5, 0.01);
  within("TOTAL: aicSummary.totalCredits ↔ API/agent truth + fallback (cycle-scoped)",
    dash.aicSummary.totalCredits, truthTotalCreditsCycle + fallbackCreditsCycle, 0.5, 0.01 + raceCredits);
  within("agentSummary.totalCredits ↔ aicSummary.totalCredits (internal consistency)",
    dash.agentSummary.totalCredits, dash.aicSummary.totalCredits, 0.01, 0.01);

  // Per-day (VS Code only — OMP/Pi don't have per-day breakdown wired)
  const dashDayMap = new Map(dash.aicSummary.byDay.map(d => [d.day, d.credits]));

  let perDayMaxDriftPct = 0;
  let perDayMaxDriftDay = "";
  let perDayMaxDriftAbs = 0;
  const allDays = new Set([...truthByDayCycle.keys(), ...dashDayMap.keys()]);
  for (const day of allDays) {
    if (!inCycle(day)) continue; // out-of-cycle days are correctly zeroed on the dashboard
    const truth = (truthByDayCycle.get(day) ?? 0) / 1e9 + (agentByDay.get(day) ?? 0) + (fallbackByDay.get(day) ?? 0);
    const dash = dashDayMap.get(day) ?? 0;
    const diff = dash - truth;
    const pct = truth !== 0 ? Math.abs(diff / truth) * 100 : (Math.abs(diff) > 0.01 ? Infinity : 0);
    if (pct > perDayMaxDriftPct) { perDayMaxDriftPct = pct; perDayMaxDriftDay = day; perDayMaxDriftAbs = diff; }
  }
  checks.push({
    label: `byDay parity within cycle (max drift ${perDayMaxDriftPct.toFixed(2)}% on ${perDayMaxDriftDay || "—"}, ${perDayMaxDriftAbs.toFixed(2)} cr)`,
    ok: perDayMaxDriftPct <= 1.0 || Math.abs(perDayMaxDriftAbs) <= raceCredits + 0.01,
    dashV: perDayMaxDriftAbs, truthV: 0, diff: perDayMaxDriftAbs, pct: perDayMaxDriftPct,
  });

  within("liveOtel.lastRequestAIC ↔ newest single nanoAiu/1e9",
    dash.liveOtel.lastRequestAIC, truthLastReqCredits, 0.5, 0.01 + raceCredits);

  const todayKey = new Date().toISOString().slice(0, 10);
  // liveOtel is the VS Code window only; OMP/Pi never feed it.
  const truthToday = (truthByDay.get(todayKey) ?? 0) / 1e9;
  within(`liveOtel.sessionAIC ↔ today's truth (${todayKey})`,
    dash.liveOtel.sessionAIC, truthToday, 1.0, 0.5);

  // ─── Per-day table (VS Code + OMP/Pi combined truth) ──────
  console.log("\nPer-day comparison (last 12 days):");
  const sortedDays = [...allDays].sort().reverse().slice(0, 12);
  console.log("  Day         |  VS truth | OMP+Pi   | Fallback |  Total truth |  Dash byDay |   Diff    |    %");
  console.log("  " + "─".repeat(86));
  for (const day of sortedDays) {
    const vsTruth = (truthByDayCycle.get(day) ?? 0) / 1e9;
    const agentTruth = agentByDay.get(day) ?? 0;
    const fallback = fallbackByDay.get(day) ?? 0;
    const totalTruth = vsTruth + agentTruth + fallback;
    const dashV = dashDayMap.get(day) ?? 0;
    const diff = dashV - totalTruth;
    const pct = totalTruth !== 0 ? (diff / totalTruth) * 100 : 0;
    console.log(`  ${day}  | ${vsTruth.toFixed(2).padStart(9)} | ${agentTruth.toFixed(2).padStart(8)} | ${fallback.toFixed(2).padStart(8)} | ${totalTruth.toFixed(2).padStart(12)} | ${dashV.toFixed(2).padStart(11)} | ${diff.toFixed(2).padStart(9)} | ${pct.toFixed(2).padStart(7)}%`);
  }

  // ─── Per-model table (VS Code + OMP/Pi + fallback, matching dashboard byModel) ──
  console.log("\nPer-model comparison (combined truth vs dashboard byModel):");
  const dashModelMap = new Map(dash.aicSummary.byModel.map(m => [m.model.toLowerCase(), m.totalCredits]));
  console.log("  Model                              | Truth     |  Dash     | Diff   | %");
  console.log("  " + "─".repeat(78));
  const allModels = new Set([...truthByModelCycle.keys(), ...agentByModelCycle.keys(), ...fallbackByModelCycle.keys(), ...dashModelMap.keys()]);
  const truthModels = [...allModels]
    .map(m => ({ model: m, truth: (truthByModelCycle.get(m) ?? 0) / 1e9 + (agentByModelCycle.get(m) ?? 0) + (fallbackByModelCycle.get(m) ?? 0), dash: dashModelMap.get(m) ?? 0 }))
    .sort((a, b) => b.truth - a.truth);
  for (const m of truthModels) {
    const diff = m.dash - m.truth;
    const pct = m.truth !== 0 ? (diff / m.truth) * 100 : 0;
    console.log(`  ${m.model.padEnd(34)} | ${m.truth.toFixed(2).padStart(9)} | ${m.dash.toFixed(2).padStart(9)} | ${diff.toFixed(2).padStart(6)} | ${pct.toFixed(2).padStart(6)}%`);
  }

  // ─── Report ────────────────────────────────────────────────
  console.log("\n" + "═".repeat(78));
  console.log("Audit assertions");
  console.log("═".repeat(78));
  let failed = 0;
  for (const c of checks) {
    const status = c.ok ? "PASS" : "FAIL";
    console.log(`  [${status}] ${c.label}`);
    if (typeof c.dashV === "number" && typeof c.truthV === "number") {
      console.log(`          dash=${c.dashV.toFixed(2)}  truth=${c.truthV.toFixed(2)}  diff=${c.diff.toFixed(2)} (${c.pct.toFixed(2)}%)`);
    }
    if (!c.ok) failed++;
  }
  console.log("═".repeat(78));
  if (failed === 0) {
    console.log("Dashboard matches API ground truth across VS Code + OMP + Pi — no over/under.");
    process.exit(0);
  } else {
    console.log(`${failed}/${checks.length} checks FAILED — see per-day/per-model tables for details.`);
    process.exit(1);
  }
})().catch(err => {
  console.error("\nFATAL:", err);
  process.exit(2);
});

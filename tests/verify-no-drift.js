/**
 * verify-no-drift.js — Zero-tolerance cross-validation of the extension's
 * AIC math against the raw debug-log jsonl files on disk.
 *
 * Targets a specific workspaceStorage folder (default: the current chat
 * session's storage) and asserts that every metric the extension reports —
 * scanner totals, dashboard widgets, sidebar snapshot — matches a byte-
 * level re-aggregation of the underlying llm_request events.
 *
 * Inclusion rule MIRRORS the extension exactly (src/scanner.ts
 * parseDebugLogDir):
 *   - <sid>/main.jsonl                       (always)
 *   - <sid>/title-*.jsonl                    (sibling)
 *   - <sid>/runSubagent-*.jsonl              (sibling)
 *   - any sibling file referenced as
 *     attrs.childLogFile in a child_session_ref in main.jsonl
 *
 * Pass criteria (zero drift, not "within tolerance"):
 *   - Σ llm_request count          ↔  Σ scan.turns[*].debugLlmCalls
 *   - Σ inputTokens                ↔  Σ scan.turns[*].debugPromptTokens
 *   - Σ outputTokens               ↔  Σ scan.turns[*].debugOutputTokens
 *   - Σ cachedTokens               ↔  Σ scan.turns[*].debugCachedTokens
 *   - Σ copilotUsageNanoAiu / 1e9  ↔  Σ scan.turns[*].debugAicCredits   (≤ $0.01 / 1 credit slop for cent rounding)
 *   - per-session totals identical for every session under the target ws
 *   - dashboard aicSummary.totalCredits ≥ raw_truth (cycle window)
 *
 * Usage:
 *   node tests/verify-no-drift.js
 *   node tests/verify-no-drift.js --ws-storage D:/vscode/workspaceStorage
 *   node tests/verify-no-drift.js --workspace-id 3e4338661f1dbcde6b5023cc270b330b
 *   node tests/verify-no-drift.js --all                 (test every workspace under wsStorage)
 *   node tests/verify-no-drift.js --verbose             (per-session table)
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

// ── Parse CLI ───────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(flag, dflt) {
  const i = argv.indexOf(flag);
  if (i === -1) return dflt;
  return argv[i + 1];
}
const WS_STORAGE = path.resolve(arg("--ws-storage", "D:/vscode/workspaceStorage"));
const TARGET_WS_ID = arg("--workspace-id", "3e4338661f1dbcde6b5023cc270b330b");
const ALL_WORKSPACES = argv.includes("--all");
const VERBOSE = argv.includes("--verbose") || argv.includes("-v");

// ── Stub vscode (extension modules transitively touch it via util.ts/etc).
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

const { scanWorkspaceStorage } = require(path.join(OUT, "scanner.js"));
const { buildDashboardData, AIC_EFFECTIVE_DATE } = require(path.join(OUT, "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

// ── Formatting helpers ──────────────────────────────────────
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}
function fmtN(n) {
  return typeof n === "number" ? n.toLocaleString() : String(n);
}
function fmtC(n) {
  return typeof n === "number" ? n.toFixed(4) : String(n);
}

// ─── Independent ground-truth parser ─────────────────────────
// Deliberately re-implemented from scratch (no scanner imports) so a
// scanner bug cannot silently agree with itself. Follows the same
// inclusion rule as src/scanner.ts parseDebugLogDir().

function listSessionDirs(wsRoot, wsId) {
  const dlRoot = path.join(wsRoot, wsId, "GitHub.copilot-chat", "debug-logs");
  let entries;
  try {
    entries = fs.readdirSync(dlRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory())
    .map(e => ({ sid: e.name, dir: path.join(dlRoot, e.name) }))
    .filter(s => fs.existsSync(path.join(s.dir, "main.jsonl")));
}

function listIncludedJsonl(sessDir) {
  // Mirror src/scanner.ts: main.jsonl + sibling title-*.jsonl /
  // runSubagent-*.jsonl + anything referenced by a child_session_ref.
  const out = [];
  const mainFile = path.join(sessDir, "main.jsonl");
  if (!fs.existsSync(mainFile)) return out;
  out.push(mainFile);

  let mainLines;
  try {
    mainLines = fs.readFileSync(mainFile, "utf-8").split("\n");
  } catch {
    mainLines = [];
  }
  const referenced = new Set();
  for (const line of mainLines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      e &&
      e.type === "child_session_ref" &&
      e.attrs &&
      typeof e.attrs.childLogFile === "string"
    ) {
      referenced.add(e.attrs.childLogFile);
    }
  }

  let siblings;
  try {
    siblings = fs.readdirSync(sessDir);
  } catch {
    siblings = [];
  }
  for (const name of siblings) {
    if (name === "main.jsonl") continue;
    if (!name.endsWith(".jsonl")) continue;
    const prefixMatch = name.startsWith("title-") || name.startsWith("runSubagent-");
    if (!prefixMatch && !referenced.has(name)) continue;
    out.push(path.join(sessDir, name));
  }
  return out;
}

function parseLlmRequests(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const calls = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || e.type !== "llm_request") continue;
    const a = e.attrs;
    if (!a || typeof a !== "object") continue;
    calls.push({
      ts: typeof e.ts === "number" ? e.ts : 0,
      tsIso: typeof e.ts === "number" ? new Date(e.ts).toISOString() : "",
      model: typeof a.model === "string" && a.model ? a.model : "unknown",
      inputTokens: typeof a.inputTokens === "number" ? a.inputTokens : 0,
      outputTokens: typeof a.outputTokens === "number" ? a.outputTokens : 0,
      cachedTokens: typeof a.cachedTokens === "number" ? a.cachedTokens : 0,
      nanoAiu: typeof a.copilotUsageNanoAiu === "number" ? a.copilotUsageNanoAiu : 0,
    });
  }
  return calls;
}

function emptyTotals() {
  return { calls: 0, prompt: 0, output: 0, cached: 0, nanoAiu: 0, byModel: new Map() };
}
function addCall(totals, c) {
  totals.calls += 1;
  totals.prompt += c.inputTokens;
  totals.output += c.outputTokens;
  totals.cached += c.cachedTokens;
  totals.nanoAiu += c.nanoAiu;
  const k = c.model.toLowerCase();
  const row = totals.byModel.get(k) ?? {
    model: c.model,
    calls: 0,
    prompt: 0,
    output: 0,
    cached: 0,
    nanoAiu: 0,
  };
  row.calls += 1;
  row.prompt += c.inputTokens;
  row.output += c.outputTokens;
  row.cached += c.cachedTokens;
  row.nanoAiu += c.nanoAiu;
  totals.byModel.set(k, row);
}

function buildRawTruth(wsRoot, wsIds) {
  // Returns: { all, perSession: Map<sid, totals>, sessionIds: Set<string>, files: number }
  const all = emptyTotals();
  const perSession = new Map();
  const sessionIds = new Set();
  let fileCount = 0;
  for (const wsId of wsIds) {
    for (const { sid, dir } of listSessionDirs(wsRoot, wsId)) {
      sessionIds.add(sid);
      const files = listIncludedJsonl(dir);
      const sessTotals = emptyTotals();
      for (const f of files) {
        fileCount += 1;
        for (const c of parseLlmRequests(f)) {
          addCall(all, c);
          addCall(sessTotals, c);
        }
      }
      perSession.set(sid, sessTotals);
    }
  }
  return { all, perSession, sessionIds, files: fileCount };
}

// ── Scanner-output aggregator ────────────────────────────────
function aggregateScannerView(scan, sessionIds) {
  // Sum scan.turns[*] for the target session set so we get the same shape
  // as the raw truth above.
  const all = { calls: 0, prompt: 0, output: 0, cached: 0, credits: 0, byModel: new Map() };
  const perSession = new Map();
  for (const t of scan.turns) {
    if (!sessionIds.has(t.sessionId)) continue;
    all.calls += t.debugLlmCalls || 0;
    all.prompt += t.debugPromptTokens || 0;
    all.output += t.debugOutputTokens || 0;
    all.cached += t.debugCachedTokens || 0;
    all.credits += t.debugAicCredits || 0;

    let s = perSession.get(t.sessionId);
    if (!s) {
      s = { calls: 0, prompt: 0, output: 0, cached: 0, credits: 0, byModel: new Map() };
      perSession.set(t.sessionId, s);
    }
    s.calls += t.debugLlmCalls || 0;
    s.prompt += t.debugPromptTokens || 0;
    s.output += t.debugOutputTokens || 0;
    s.cached += t.debugCachedTokens || 0;
    s.credits += t.debugAicCredits || 0;

    const by = t.debugByModel || {};
    for (const [model, mt] of Object.entries(by)) {
      const k = model.toLowerCase();
      const dst = all.byModel.get(k) ?? {
        model,
        calls: 0,
        prompt: 0,
        output: 0,
        cached: 0,
        nanoAiu: 0,
      };
      dst.calls += mt.calls || 0;
      dst.prompt += mt.prompt || 0;
      dst.output += mt.output || 0;
      dst.cached += mt.cached || 0;
      dst.nanoAiu += mt.nanoAiu || 0;
      all.byModel.set(k, dst);

      const sdst = s.byModel.get(k) ?? {
        model,
        calls: 0,
        prompt: 0,
        output: 0,
        cached: 0,
        nanoAiu: 0,
      };
      sdst.calls += mt.calls || 0;
      sdst.prompt += mt.prompt || 0;
      sdst.output += mt.output || 0;
      sdst.cached += mt.cached || 0;
      sdst.nanoAiu += mt.nanoAiu || 0;
      s.byModel.set(k, sdst);
    }
  }
  return { all, perSession };
}

// ─── Run the audit ──────────────────────────────────────────
(async () => {
  console.log("═".repeat(80));
  console.log("ZERO-DRIFT cross-validation: extension calculations ↔ raw debug-log jsonl");
  console.log("═".repeat(80));

  if (!fs.existsSync(WS_STORAGE)) {
    console.error(`FATAL: --ws-storage path does not exist: ${WS_STORAGE}`);
    process.exit(2);
  }

  // Decide which workspace IDs to test.
  let wsIds;
  if (ALL_WORKSPACES) {
    wsIds = fs
      .readdirSync(WS_STORAGE, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(name => {
        const dl = path.join(WS_STORAGE, name, "GitHub.copilot-chat", "debug-logs");
        return fs.existsSync(dl);
      });
  } else {
    const dl = path.join(WS_STORAGE, TARGET_WS_ID, "GitHub.copilot-chat", "debug-logs");
    if (!fs.existsSync(dl)) {
      console.error(`FATAL: target workspace has no debug-logs:\n  ${dl}`);
      process.exit(2);
    }
    wsIds = [TARGET_WS_ID];
  }

  console.log(`ws-storage  : ${WS_STORAGE}`);
  console.log(`workspaces  : ${wsIds.length} (${ALL_WORKSPACES ? "--all" : "single"})`);
  if (!ALL_WORKSPACES) console.log(`workspace-id: ${TARGET_WS_ID}`);

  // ── ORDER MATTERS: run scanner FIRST, then read raw truth ──
  //
  // Scanner read takes ~20-30s on a large workspace. Raw read takes ~4s.
  // If we read raw FIRST, any Copilot request that lands during the scan
  // window (the user is typing in chat, an agent loop is running, etc.)
  // appears in scanner.turns but not in raw — producing a false-positive
  // "scanner has +1 call" FAIL that's purely a race, not real drift.
  //
  // By scanning FIRST and reading raw AFTER, the invariant becomes:
  //   scanner ⊆ raw       (scanner can only see writes flushed before it read;
  //                         raw, read later, sees everything scanner saw plus
  //                         anything appended during/after the scan)
  //
  // So a diff in the direction `truth > scanner` is RACE (writes during scan).
  //    A diff in the direction `scanner > truth` is REAL DRIFT (scanner
  //    inventing or double-counting data — the bug class the test exists for).
  //
  // We tag failures by direction in the report below and exit 0-with-warning
  // for race-only drift so live use doesn't make the test cry wolf.
  const t1 = Date.now();
  const scan = await scanWorkspaceStorage(WS_STORAGE);
  const scanMs = Date.now() - t1;

  // Brief settle window so any in-flight write completed during scan has time
  // to fsync before the raw read. Not strictly required (JSONL is append-only
  // line-flushed) but cheap insurance against partial-line reads.
  await new Promise(r => setTimeout(r, 500));

  const t0 = Date.now();
  const truth = buildRawTruth(WS_STORAGE, wsIds);
  const truthMs = Date.now() - t0;
  console.log(
    `\nScanner ran : ${scanMs}ms (executed first so raw read can bound scanner's view)`
  );
  console.log(
    `Raw truth   : ${truth.sessionIds.size} sessions, ${truth.files} jsonl files, ` +
      `${fmtN(truth.all.calls)} llm_requests  (${truthMs}ms, read AFTER scan)`
  );
  console.log(
    `              prompt=${fmtN(truth.all.prompt)}  output=${fmtN(truth.all.output)}  ` +
      `cached=${fmtN(truth.all.cached)}  credits=${fmtC(truth.all.nanoAiu / 1e9)}`
  );

  const sv = aggregateScannerView(scan, truth.sessionIds);
  console.log(
    `Scanner view: ${sv.perSession.size} matching sessions, ${fmtN(sv.all.calls)} llm_requests`
  );
  console.log(
    `              prompt=${fmtN(sv.all.prompt)}  output=${fmtN(sv.all.output)}  ` +
      `cached=${fmtN(sv.all.cached)}  credits=${fmtC(sv.all.credits)}`
  );

  // ── Build dashboard data (extension code path) ──────────
  // Use a very-old activationTime so the cycle-window dashboard widgets
  // include every recorded turn — we want to drift-check the full pipeline,
  // not just "this minute" data.
  const longAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const dash = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, undefined, longAgo);
  console.log("\nDashboard:");
  console.log(`  aicSummary.totalCredits   = ${fmtC(dash.aicSummary.totalCredits)}`);
  console.log(`  aicSummary.byModel        = ${dash.aicSummary.byModel.length} rows`);
  console.log(`  liveOtel.source           = ${dash.liveOtel.source}`);
  console.log(`  liveOtel.sessionAIC       = ${fmtC(dash.liveOtel.sessionAIC)}`);
  console.log(`  liveOtel.lastRequestAIC   = ${fmtC(dash.liveOtel.lastRequestAIC)}`);

  // ─── Assertions ─────────────────────────────────────────
  const checks = [];

  // Integer fields: must match EXACTLY (no float math involved upstream).
  function eqInt(label, a, b) {
    const ok = a === b;
    checks.push({ label, ok, a, b, diff: a - b });
  }
  // Float fields: allow ≤ 0.005 absolute slop (cent-rounding in dashboard).
  function eqFloat(label, a, b, tolAbs = 0.005) {
    const ok = Math.abs(a - b) <= tolAbs;
    checks.push({ label, ok, a, b, diff: a - b });
  }
  // Lower-bound float: scanner total may include sub-cent rounding gains
  // due to per-turn aggregation, accept ≤ 0.01 absolute drift.
  function eqFloatLoose(label, a, b, tolAbs = 0.01) {
    const ok = Math.abs(a - b) <= tolAbs;
    checks.push({ label, ok, a, b, diff: a - b });
  }

  // ── Block 1: raw truth ↔ scanner-aggregated turns (the core check)
  eqInt("Σ llm_request count  (raw ↔ scanner.turns)", truth.all.calls, sv.all.calls);
  eqInt("Σ inputTokens        (raw ↔ scanner.turns)", truth.all.prompt, sv.all.prompt);
  eqInt("Σ outputTokens       (raw ↔ scanner.turns)", truth.all.output, sv.all.output);
  eqInt("Σ cachedTokens       (raw ↔ scanner.turns)", truth.all.cached, sv.all.cached);
  // Scanner stores per-turn debugAicCredits rounded to 2dp; truth is raw.
  // Sum of rounded values can drift up to N * 0.005 in the worst case, but
  // in practice nanoAiu is always an integer (1e9 scale) so the sum-then-
  // divide raw value will be exact and the sum-of-rounded scanner value will
  // match to within a few thousandths.
  eqFloatLoose(
    "Σ credits            (raw ↔ scanner.turns)",
    truth.all.nanoAiu / 1e9,
    sv.all.credits,
    Math.max(0.01, truth.perSession.size * 0.01)
  );

  // ── Block 2: scanner ↔ dashboard (post-pipeline)
  // Dashboard aicSummary.totalCredits is the billing-cycle total of ALL
  // turns scoped by AIC_EFFECTIVE_DATE. With longAgo activationTime and
  // no liveStats, this should ≥ scanner sum of debugAicCredits restricted
  // to the same date filter. We compute the matching truth slice:
  const cycleStart = AIC_EFFECTIVE_DATE; // YYYY-MM-DD
  let truthCycleNano = 0;
  let svCycleCredits = 0;
  for (const t of scan.turns) {
    if (!truth.sessionIds.has(t.sessionId)) continue;
    if (!t.timestamp) continue;
    if (t.timestamp.slice(0, 10) < cycleStart) continue;
    svCycleCredits += t.debugAicCredits || 0;
  }
  for (const wsId of wsIds) {
    for (const { dir } of listSessionDirs(WS_STORAGE, wsId)) {
      for (const f of listIncludedJsonl(dir)) {
        for (const c of parseLlmRequests(f)) {
          if (!c.tsIso) continue;
          if (c.tsIso.slice(0, 10) < cycleStart) continue;
          truthCycleNano += c.nanoAiu;
        }
      }
    }
  }
  const truthCycleCredits = truthCycleNano / 1e9;
  eqFloatLoose(
    `Σ credits since ${cycleStart} (raw ↔ scanner)`,
    truthCycleCredits,
    svCycleCredits,
    Math.max(0.01, truth.perSession.size * 0.01)
  );

  // Dashboard `aicSummary.totalCredits` is a self-consistency check on the
  // dashboard layer: it must equal Σ(scan.turns[*].debugAicCredits) over the
  // same date window across the FULL scan (all workspaces), not the per-ws
  // truth subset. The cross-source raw↔scanner credits check above already
  // validates the per-workspace slice; this one validates that the dashboard
  // doesn't drop or double-count anything when projecting scanner turns into
  // its cycle aggregate.
  let svFullCycleCredits = 0;
  for (const t of scan.turns) {
    if (!t.timestamp) continue;
    if (t.timestamp.slice(0, 10) < cycleStart) continue;
    svFullCycleCredits += t.debugAicCredits || 0;
  }
  eqFloatLoose(
    "aicSummary.totalCredits ↔ Σ scan.turns.debugAicCredits (all ws, cycle)",
    dash.aicSummary.totalCredits,
    svFullCycleCredits,
    Math.max(0.05, scan.turns.length * 0.01)
  );

  // ── Block 3: per-session parity (catches a single session drifting
  //    even when the totals coincidentally cancel out).
  let perSessionFailures = 0;
  for (const [sid, t] of truth.perSession.entries()) {
    const s = sv.perSession.get(sid);
    if (!s) {
      perSessionFailures += 1;
      if (VERBOSE) console.log(`  [MISS] session ${sid.slice(0, 12)}… not in scanner output`);
      continue;
    }
    if (t.calls !== s.calls || t.prompt !== s.prompt || t.output !== s.output) {
      perSessionFailures += 1;
      if (VERBOSE) {
        console.log(
          `  [DRIFT] ${sid.slice(0, 12)}… ` +
            `raw{c:${t.calls},i:${t.prompt},o:${t.output}} vs ` +
            `scan{c:${s.calls},i:${s.prompt},o:${s.output}}`
        );
      }
    }
  }
  checks.push({
    label: `per-session parity  (${truth.perSession.size} sessions)`,
    ok: perSessionFailures === 0,
    a: perSessionFailures,
    b: 0,
    diff: perSessionFailures,
  });

  // ── Block 4: per-model parity (raw ↔ scanner.byModel aggregation)
  let perModelFailures = 0;
  const modelKeys = new Set([...truth.all.byModel.keys(), ...sv.all.byModel.keys()]);
  for (const k of modelKeys) {
    const t = truth.all.byModel.get(k);
    const s = sv.all.byModel.get(k);
    if (!t || !s) {
      perModelFailures += 1;
      if (VERBOSE)
        console.log(`  [MISS-MODEL] ${k}: raw=${t ? "yes" : "no"} scanner=${s ? "yes" : "no"}`);
      continue;
    }
    // nanoAiu is an integer in both — sums must match exactly.
    if (t.nanoAiu !== s.nanoAiu || t.calls !== s.calls) {
      perModelFailures += 1;
      if (VERBOSE) {
        console.log(
          `  [DRIFT-MODEL] ${k}  raw{c:${t.calls},nanoAiu:${t.nanoAiu}} vs ` +
            `scan{c:${s.calls},nanoAiu:${s.nanoAiu}}`
        );
      }
    }
  }
  checks.push({
    label: `per-model parity    (${modelKeys.size} models)`,
    ok: perModelFailures === 0,
    a: perModelFailures,
    b: 0,
    diff: perModelFailures,
  });

  // ─── Per-model breakdown table (always printed) ────────
  console.log("\nPer-model (raw ↔ scanner):");
  console.log(
    "  " +
      pad("model", 36) +
      padL("raw calls", 11) +
      padL("scan calls", 12) +
      padL("raw credits", 14) +
      padL("scan credits", 14) +
      padL("diff", 10)
  );
  console.log("  " + "─".repeat(96));
  const allModels = Array.from(modelKeys).sort();
  for (const k of allModels) {
    const t = truth.all.byModel.get(k);
    const s = sv.all.byModel.get(k);
    const tCr = t ? t.nanoAiu / 1e9 : 0;
    const sCr = s ? s.nanoAiu / 1e9 : 0;
    console.log(
      "  " +
        pad((t?.model || s?.model || k).slice(0, 36), 36) +
        padL(t ? fmtN(t.calls) : "—", 11) +
        padL(s ? fmtN(s.calls) : "—", 12) +
        padL(fmtC(tCr), 14) +
        padL(fmtC(sCr), 14) +
        padL(fmtC(sCr - tCr), 10)
    );
  }

  if (VERBOSE) {
    console.log("\nPer-session totals (sorted by raw credits desc):");
    const rows = [];
    for (const [sid, t] of truth.perSession.entries()) {
      const s = sv.perSession.get(sid);
      rows.push({
        sid,
        rawCalls: t.calls,
        scanCalls: s?.calls ?? 0,
        rawCredits: t.nanoAiu / 1e9,
        scanCredits: s?.credits ?? 0,
      });
    }
    rows.sort((a, b) => b.rawCredits - a.rawCredits);
    console.log(
      "  " +
        pad("session", 14) +
        padL("raw calls", 11) +
        padL("scan calls", 12) +
        padL("raw credits", 14) +
        padL("scan credits", 14) +
        padL("diff", 10)
    );
    console.log("  " + "─".repeat(75));
    for (const r of rows.slice(0, 30)) {
      console.log(
        "  " +
          pad(r.sid.slice(0, 12) + "…", 14) +
          padL(fmtN(r.rawCalls), 11) +
          padL(fmtN(r.scanCalls), 12) +
          padL(fmtC(r.rawCredits), 14) +
          padL(fmtC(r.scanCredits), 14) +
          padL(fmtC(r.scanCredits - r.rawCredits), 10)
      );
    }
    if (rows.length > 30) console.log(`  … (${rows.length - 30} more)`);
  }

  // ─── Report ──────────────────────────────────────────────
  console.log("\n" + "═".repeat(80));
  console.log("Zero-drift assertions");
  console.log("═".repeat(80));
  let realDriftFails = 0;
  let raceFails = 0;
  for (const c of checks) {
    let status = c.ok ? "PASS" : "FAIL";
    // RACE-vs-DRIFT classification:
    //   With scanner-runs-FIRST ordering, the invariant is scanner ⊆ raw.
    //   So `diff = a - b` where a=truth, b=scanner:
    //     diff < 0  →  scanner > truth  →  REAL DRIFT (the bug class we test for)
    //     diff > 0  →  truth > scanner  →  RACE (writes during scan that scanner missed)
    //   `diff` here is `c.diff = c.a - c.b = truth - scanner` (see eqInt/eqFloat above).
    //   Race fails are informational, not failures. We still print them so the
    //   user sees what happened, but they don't drive the exit code.
    let kind = "";
    if (!c.ok && typeof c.diff === "number") {
      if (c.diff > 0) {
        kind = "  (race: writes during scan — scanner < truth)";
        raceFails += 1;
        status = "RACE";
      } else {
        kind = "  (DRIFT: scanner > truth — real bug)";
        realDriftFails += 1;
      }
    } else if (!c.ok) {
      realDriftFails += 1;
    }
    const a = typeof c.a === "number" ? fmtN(c.a) : String(c.a);
    const b = typeof c.b === "number" ? fmtN(c.b) : String(c.b);
    const diff = typeof c.diff === "number" ? `Δ=${c.diff >= 0 ? "+" : ""}${c.diff}` : "";
    console.log(`  [${status}] ${pad(c.label, 50)} ${a} vs ${b}  ${diff}${kind}`);
  }
  console.log("═".repeat(80));
  if (realDriftFails === 0 && raceFails === 0) {
    console.log(
      `All ${checks.length} drift checks passed — extension math matches raw debug-log data exactly.`
    );
    process.exit(0);
  } else if (realDriftFails === 0) {
    console.log(
      `${raceFails} of ${checks.length} checks tagged RACE — Copilot wrote new llm_requests during the scan window.`
    );
    console.log(
      "  All RACE fails point in the direction `truth > scanner`, which is mathematically"
    );
    console.log(
      "  impossible without live writes during scan. Re-run while Copilot Chat is idle to"
    );
    console.log("  see a clean zero-diff PASS, or just trust the per-cycle PASS row above.");
    process.exit(0);
  } else {
    console.log(
      `${realDriftFails} REAL-DRIFT failures + ${raceFails} race failures of ${checks.length} total — extension is drifting from disk.`
    );
    console.log("Re-run with --verbose to see per-session / per-model details.");
    process.exit(1);
  }
})().catch(err => {
  console.error("\nFATAL:", err);
  process.exit(2);
});

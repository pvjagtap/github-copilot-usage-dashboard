// Per-session per-day diagnostic to isolate the source of the
// dashboard-vs-API drift surfaced by verify-dashboard-vs-api.js.
//
// Approach: for each VS Code debug-log session,
//   truth[session][day] = Σ nanoAiu of every llm_request whose own ts is `day`
//   scan[session][day]  = Σ debugAicCredits of every turn whose t.timestamp is `day`
// then bucket by day and find the largest per-session contributions on the
// suspect day (e.g. 2026-06-10).
//
// Why: the scanner attributes child-file credits (title-*, runSubagent-*) to
// the PARENT TURN, and the parent turn's date is the latest llm_request seen
// in MAIN — which can be on a different day than the child llm_requests.
// This script proves or disproves that hypothesis.

"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

// vscode stub (same as parity test) — load before scanner.js
const stubPath = path.join(ROOT, "tests", "_vscode-stub.js");
if (!fs.existsSync(stubPath)) {
  fs.writeFileSync(
    stubPath,
    "module.exports = { workspace: { getConfiguration: () => ({ get: () => undefined }) }, EventEmitter: class {}, ExtensionContext: class {}, ViewColumn: { One: 1 }, window: { showErrorMessage(){}, showInformationMessage(){} } };\n"
  );
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

const { scanWorkspaceStorage, getWorkspaceStorageCandidates } = require(path.join(OUT, "scanner.js"));
const { AIC_EFFECTIVE_DATE } = require(path.join(OUT, "dashboardData.js"));

const SUSPECT_DAY = process.argv[2] || "2026-06-10";

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

function readSessionId(sessDir) {
  try {
    const main = fs.readFileSync(path.join(sessDir, "main.jsonl"), "utf-8");
    for (const line of main.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "session_start" && typeof e.sid === "string") return e.sid;
      } catch {}
    }
  } catch {}
  return path.basename(sessDir);
}

function parseFile(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return []; }
  const out = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "llm_request") continue;
    const a = e.attrs;
    if (!a || typeof a !== "object") continue;
    const nanoAiu = typeof a.copilotUsageNanoAiu === "number" ? a.copilotUsageNanoAiu : 0;
    const ts = typeof e.ts === "number" ? new Date(e.ts).toISOString() : "";
    out.push({ ts, day: ts.slice(0, 10), nanoAiu, model: a.model || "unknown" });
  }
  return out;
}

function parseSessionAllFiles(sessDir) {
  const calls = [];
  let entries;
  try { entries = fs.readdirSync(sessDir); } catch { return calls; }
  for (const e of entries) {
    const full = path.join(sessDir, e);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isFile() && e.endsWith(".jsonl")) {
      calls.push(...parseFile(full));
    }
  }
  return calls;
}

(async () => {
  console.log(`Diagnosing day-attribution drift around ${SUSPECT_DAY}`);
  console.log("─".repeat(80));

  const sessionDirs = discoverDebugLogDirs();

  // truth: { sessionId: { day: nanoAiu } }
  const truthBySession = new Map();
  // Also lookup: sessionId → sessDir (for printing)
  const sidToDir = new Map();

  for (const sessDir of sessionDirs) {
    const sid = readSessionId(sessDir);
    sidToDir.set(sid, sessDir);
    const calls = parseSessionAllFiles(sessDir);
    const byDay = new Map();
    for (const c of calls) {
      if (!c.day || c.day < AIC_EFFECTIVE_DATE) continue;
      byDay.set(c.day, (byDay.get(c.day) ?? 0) + c.nanoAiu);
    }
    truthBySession.set(sid, byDay);
  }

  // scan: get the dashboard's view of each session via turns
  console.log("Running scanner...");
  const t0 = Date.now();
  const scan = await scanWorkspaceStorage();
  console.log(`  done in ${Date.now() - t0}ms — ${scan.turns.length} turns across ${scan.sessions.length} sessions`);

  // Group turns by session, then by day (using turn.timestamp.slice(0,10))
  const scanBySession = new Map();
  for (const t of scan.turns) {
    if (!t.timestamp) continue;
    const day = t.timestamp.slice(0, 10);
    if (day < AIC_EFFECTIVE_DATE) continue;
    const sid = t.sessionId;
    const m = scanBySession.get(sid) ?? new Map();
    m.set(day, (m.get(day) ?? 0) + (t.debugAicCredits || 0) * 1e9);
    scanBySession.set(sid, m);
  }

  // Find sessions with biggest contributions on the suspect day
  const rows = [];
  const allSids = new Set([...truthBySession.keys(), ...scanBySession.keys()]);
  for (const sid of allSids) {
    const truth = truthBySession.get(sid) ?? new Map();
    const scan = scanBySession.get(sid) ?? new Map();
    const truthSuspect = (truth.get(SUSPECT_DAY) ?? 0) / 1e9;
    const scanSuspect = (scan.get(SUSPECT_DAY) ?? 0) / 1e9;
    const drift = scanSuspect - truthSuspect;
    if (Math.abs(drift) < 1) continue; // ignore noise
    // Per-session total across all days, to detect double-counting
    const truthTotal = [...truth.values()].reduce((a, b) => a + b, 0) / 1e9;
    const scanTotal = [...scan.values()].reduce((a, b) => a + b, 0) / 1e9;
    rows.push({
      sid,
      truthSuspect,
      scanSuspect,
      drift,
      truthTotal,
      scanTotal,
      totalDrift: scanTotal - truthTotal,
      truthDays: [...truth.keys()].sort(),
      scanDays: [...scan.keys()].sort(),
    });
  }

  rows.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));

  console.log(`\nTop 15 sessions contributing to ${SUSPECT_DAY} drift:`);
  console.log("  sid (8 chars) | suspect-day  scan-day  drift | total-truth total-scan totalDrift | truth-days → scan-days");
  console.log("  " + "─".repeat(120));
  for (const r of rows.slice(0, 15)) {
    const sid8 = r.sid.slice(0, 8);
    console.log(
      `  ${sid8.padEnd(13)} | ${r.truthSuspect.toFixed(2).padStart(10)} ${r.scanSuspect.toFixed(2).padStart(9)} ${r.drift.toFixed(2).padStart(7)} | ${r.truthTotal.toFixed(2).padStart(10)} ${r.scanTotal.toFixed(2).padStart(10)} ${r.totalDrift.toFixed(2).padStart(10)} | [${r.truthDays.join(",")}] → [${r.scanDays.join(",")}]`
    );
  }

  // Aggregate: how much of the suspect-day drift comes from sessions whose
  // truth-side WAS NOT on the suspect day at all? (= cross-day attribution)
  let crossDayBleed = 0;
  let doubleCountBleed = 0;
  for (const r of rows) {
    if (r.drift <= 0) continue;
    if (!r.truthDays.includes(SUSPECT_DAY)) {
      // Session had NO truth activity on suspect day but scanner attributed credits there
      crossDayBleed += r.drift;
    } else if (Math.abs(r.totalDrift) < 1) {
      // Per-session total matches → drift is timing/cross-day within session
      crossDayBleed += r.drift;
    } else {
      // Per-session total differs → real double-counting / parsing diff
      doubleCountBleed += r.drift;
    }
  }
  console.log(`\nSummary of +drift on ${SUSPECT_DAY}:`);
  console.log(`  cross-day attribution (per-session totals match): +${crossDayBleed.toFixed(2)} cr`);
  console.log(`  real double-count    (per-session totals differ): +${doubleCountBleed.toFixed(2)} cr`);

  // Now compute per-session total drift for ALL sessions (not just ones
  // with suspect-day drift). This catches sessions that aren't part of the
  // suspect day but contribute to the TOTAL vscodeAicCredits drift.
  console.log(`\nAll sessions with per-session total drift > 1 credit (scanner total vs truth total):`);
  const allRows = [];
  for (const sid of allSids) {
    const truth = truthBySession.get(sid) ?? new Map();
    const scan = scanBySession.get(sid) ?? new Map();
    const truthTotal = [...truth.values()].reduce((a, b) => a + b, 0) / 1e9;
    const scanTotal = [...scan.values()].reduce((a, b) => a + b, 0) / 1e9;
    const totalDrift = scanTotal - truthTotal;
    if (Math.abs(totalDrift) < 1) continue;
    allRows.push({ sid, truthTotal, scanTotal, totalDrift, truthDays: [...truth.keys()].sort() });
  }
  allRows.sort((a, b) => Math.abs(b.totalDrift) - Math.abs(a.totalDrift));
  console.log("  sid (8 chars) | truthTotal scanTotal totalDrift | truth-days");
  console.log("  " + "─".repeat(100));
  for (const r of allRows.slice(0, 25)) {
    console.log(
      `  ${r.sid.slice(0, 8).padEnd(13)} | ${r.truthTotal.toFixed(2).padStart(10)} ${r.scanTotal.toFixed(2).padStart(10)} ${r.totalDrift.toFixed(2).padStart(10)} | [${r.truthDays.join(",")}]`
    );
  }
  const sumTotalDrift = allRows.reduce((a, b) => a + b.totalDrift, 0);
  console.log(`\nΣ per-session totalDrift across all sessions: ${sumTotalDrift.toFixed(2)} cr`);
  console.log(`  (matches the audit's total VS Code drift if this is the sole source)`);
})().catch(err => {
  console.error("FATAL:", err);
  process.exit(2);
});

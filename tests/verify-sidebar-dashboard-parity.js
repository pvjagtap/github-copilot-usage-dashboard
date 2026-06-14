/**
 * verify-sidebar-dashboard-parity.js — Runs the real scanner against the
 * current VS Code workspaceStorage, builds DashboardData + SidebarSnapshot
 * exactly as extension.ts does, and asserts the sidebar's session-level
 * AIC numbers match the dashboard's liveOtel widgets (which is the
 * regression we just fixed in 1.10.2).
 *
 * Plain Node JS so it runs without tsx/ts-node — loads the compiled
 * `out/` modules directly.
 *
 *   node tests/verify-sidebar-dashboard-parity.js
 */

const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

// ── Stub vscode (extension modules transitively touch it via util.ts/etc).
//    We never enter the activate() path, so a minimal shim is enough.
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
const { buildSidebarSnapshot } = require(path.join(OUT, "sidebarSnapshot.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function fmt(n) {
  return typeof n === "number" ? n.toFixed(2) : String(n);
}

(async () => {
  console.log("─".repeat(72));
  console.log("Sidebar ↔ Dashboard parity check");
  console.log("─".repeat(72));

  // Treat THIS Node process's start time as the "VS Code window activated"
  // boundary. That scopes the "Session (this window)" numbers to whatever
  // turns landed since this test started — same contract as the extension.
  const activationTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  console.log(`activationTime  = ${activationTime}  (24h lookback for test)`);
  console.log(`AIC_EFFECTIVE_DATE = ${AIC_EFFECTIVE_DATE}`);

  const t0 = Date.now();
  const scan = await scanWorkspaceStorage();
  const scanMs = Date.now() - t0;
  console.log(
    `\nScan: ${scan.stats.canonicalSessions} sessions, ${scan.stats.turnsStored} turns, ` +
      `${scan.stats.toolCallsStored} tools (${scanMs}ms)`
  );

  // Reuse DEFAULT_AIC_CONFIG — same calculator the live extension uses.
  const aicConfig = DEFAULT_AIC_CONFIG;
  // liveStats=null simulates the "no OTel receiver in this process" case,
  // which is the realistic Dashboard cold-open path. It exercises the
  // dashboard's debug-log-only fallback that the sidebar must agree with.
  const liveStats = null;
  const agentScan = undefined;

  const dash = buildDashboardData(scan, liveStats, aicConfig, agentScan, activationTime);
  console.log("\nDashboard widgets (source of truth):");
  console.log("  aicSummary.totalCredits         =", fmt(dash.aicSummary.totalCredits));
  console.log("  aicSummary.monthlyBudget        =", dash.aicSummary.monthlyBudget);
  console.log("  aicSummary.projectedTotal       =", fmt(dash.aicSummary.projectedTotal));
  console.log("  liveOtel.source                 =", dash.liveOtel.source);
  console.log("  liveOtel.sessionAIC             =", fmt(dash.liveOtel.sessionAIC));
  console.log("  liveOtel.lastRequestAIC         =", fmt(dash.liveOtel.lastRequestAIC));
  console.log("  liveOtel.requests               =", dash.liveOtel.requests);
  console.log("  currentSessionAIC (most-recent) =", fmt(dash.currentSessionAIC));

  const snap = buildSidebarSnapshot({
    dashData: dash,
    scanTurns: scan.turns,
    liveStats,
    // Source-of-truth wiring: exactly what extension.ts/pushSidebarSnapshot does.
    lastRequestAIC: dash.liveOtel.lastRequestAIC,
    currentSessionAIC: dash.liveOtel.sessionAIC,
    currentSessionModel: null,
    currentSessionTurns: 0,
    currentSessionDurationMin: 0,
    activationTime,
  });

  console.log("\nSidebar snapshot (consumer):");
  console.log("  status.liveState                =", snap.status.liveState);
  console.log("  status.planName                 =", snap.status.planName);
  console.log("  session?.aic                    =", snap.session ? fmt(snap.session.aic) : "null");
  console.log("  lastRequest?.aic                =", snap.lastRequest ? fmt(snap.lastRequest.aic) : "null");
  console.log("  todayWeek.todayAic              =", fmt(snap.todayWeek.todayAic));
  console.log("  todayWeek.weekAic               =", fmt(snap.todayWeek.weekAic));
  console.log("  breakdown.totalAic              =", fmt(snap.breakdown.totalAic));
  console.log("  breakdown.byModel.length        =", snap.breakdown.byModel.length);
  console.log("  breakdown.modelsMore            =", snap.breakdown.modelsMore);
  console.log("  breakdown.dailySparkline.length =", snap.breakdown.dailySparkline.length);
  console.log("  sessions.total                  =", snap.sessions.total);
  console.log("  sessions.rows.length            =", snap.sessions.rows.length);
  console.log("  pace.projectedCredits           =", fmt(snap.pace.projectedCredits));
  console.log("  pace.overagePct                 =", fmt(snap.pace.overagePct));

  // ── Parity assertions ──────────────────────────────────────
  const checks = [];
  function eq(label, a, b) {
    const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
    checks.push({ label, ok, a, b });
  }
  function truthy(label, cond, detail) {
    checks.push({ label, ok: !!cond, a: detail ?? "", b: "" });
  }

  // The regression fix: sidebar.session.aic === dashboard.liveOtel.sessionAIC
  eq("session.aic ↔ liveOtel.sessionAIC", snap.session?.aic ?? 0, dash.liveOtel.sessionAIC);
  // lastRequest.aic should match the dashboard's lastRequestAIC widget.
  eq(
    "lastRequest.aic ↔ liveOtel.lastRequestAIC",
    snap.lastRequest?.aic ?? 0,
    dash.liveOtel.lastRequestAIC
  );
  // Cycle totals must match exactly — both read aicSummary.totalCredits.
  eq("breakdown.totalAic ↔ aicSummary.totalCredits", snap.breakdown.totalAic, dash.aicSummary.totalCredits);
  // Pace must come from aicSummary, not be locally recomputed.
  eq("pace.projectedCredits ↔ aicSummary.projectedTotal", snap.pace.projectedCredits, dash.aicSummary.projectedTotal);
  eq("pace.budget ↔ aicSummary.monthlyBudget", snap.pace.budget, dash.aicSummary.monthlyBudget);

  // Defensive: no NaN / Infinity / negatives leaking into the DTO.
  truthy("breakdown.totalAic finite & ≥ 0", Number.isFinite(snap.breakdown.totalAic) && snap.breakdown.totalAic >= 0, snap.breakdown.totalAic);
  truthy("dailySparkline length == 14", snap.breakdown.dailySparkline.length === 14, snap.breakdown.dailySparkline.length);
  truthy(
    "dailySparkline all numeric",
    snap.breakdown.dailySparkline.every((v) => Number.isFinite(v) && v >= 0),
    snap.breakdown.dailySparkline.join(",")
  );
  truthy("byModel.length ≤ 5", snap.breakdown.byModel.length <= 5, snap.breakdown.byModel.length);
  truthy("byDow.length == 7", snap.breakdown.byDow.length === 7, snap.breakdown.byDow.length);
  truthy(
    "byModel pct ∈ [0,100]",
    snap.breakdown.byModel.every((m) => m.pct >= 0 && m.pct <= 100.0001),
    snap.breakdown.byModel.map((m) => m.pct.toFixed(1)).join(",")
  );
  truthy("sessions.rows ≤ 30", snap.sessions.rows.length <= 30, snap.sessions.rows.length);
  truthy(
    "sessions.rows sorted by credits desc",
    snap.sessions.rows.every((r, i, arr) => i === 0 || arr[i - 1].credits >= r.credits),
    "n=" + snap.sessions.rows.length
  );

  // classifySource regression: with VS Code chatSessions only, NO row should
  // be tagged "Pi" (the substring bug we just killed would mis-tag every one).
  const piRows = snap.sessions.rows.filter((r) => r.source === "Pi");
  truthy("no chatSession mis-tagged as 'Pi'", piRows.length === 0, "piRows=" + piRows.length);

  // ── Report ────────────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log("Parity assertions");
  console.log("─".repeat(72));
  let failed = 0;
  for (const c of checks) {
    const status = c.ok ? "PASS" : "FAIL";
    const detail = typeof c.a === "number" && typeof c.b === "number" ? `${fmt(c.a)} vs ${fmt(c.b)}` : c.a;
    console.log(`  [${status}] ${pad(c.label, 50)} ${detail}`);
    if (!c.ok) failed++;
  }
  console.log("─".repeat(72));
  if (failed === 0) {
    console.log(`All ${checks.length} checks passed — sidebar and dashboard are in sync.`);
    process.exit(0);
  } else {
    console.log(`${failed} of ${checks.length} checks FAILED — drift detected.`);
    process.exit(1);
  }
})().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(2);
});

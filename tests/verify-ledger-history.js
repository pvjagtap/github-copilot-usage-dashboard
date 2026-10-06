/**
 * verify-ledger-history.js — credits GitHub billed that no local log explains
 * must land on the day the ledger rose, not on the last day with local activity.
 *
 * GitHub's quota ledger carries one cycle total. The extension polls it, so the
 * moments it moved are known; lining each rise up with the local activity in
 * the same window dates the unexplained remainder.
 *
 * The first scenario replays a real cycle: the ledger climbed by ~2,940 across
 * two polls (about two hours) in which the machine logged ~100 credits of its
 * own, and sat flat otherwise.
 *
 *   node tests/verify-ledger-history.js
 */

const path = require("path");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (q, p, ...a) { return q === "vscode" ? stubPath : origResolve.call(this, q, p, ...a); };

const { dateUnattributed, recordLedgerPoint, MAX_DATED_WINDOW_MS } = require(path.join(OUT, "ledgerHistory.js"));
const { buildDashboardData } = require(path.join(OUT, "dashboardData.js"));
const { DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
const sum = rows => rows.reduce((s, r) => s + r.credits, 0);

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 4, 4, 57, 7); // 2026-10-04 04:57 UTC
const pt = (min, used) => ({ t: T0 + min * MIN, used, lastSeen: T0 + min * MIN });

console.log("\nrecordLedgerPoint");
{
  let h = recordLedgerPoint([], 100, 1000);
  assert("first reading starts the history", h.length === 1 && h[0].used === 100);
  h = recordLedgerPoint(h, 100, 5000);
  assert("an unchanged reading only extends lastSeen", h.length === 1 && h[0].t === 1000 && h[0].lastSeen === 5000);
  h = recordLedgerPoint(h, 100, 2000);
  assert("lastSeen never moves backwards", h[0].lastSeen === 5000);
  h = recordLedgerPoint(h, 160, 9000);
  assert("a rise appends a point", h.length === 2 && h[1].used === 160 && h[1].t === 9000);
  h = recordLedgerPoint(h, 10, 12000);
  assert("a lower reading (new cycle) restarts the history", h.length === 1 && h[0].used === 10);
}

console.log("\nreal burst: ledger +2,940 while the machine logged ~100");
{
  const history = [pt(0, 20633), pt(59, 21658), pt(112, 23680), pt(167, 23750)];
  const events = [
    { t: T0 + 35 * MIN, credits: 50 }, { t: T0 + 37 * MIN, credits: 57 }, // local activity inside window 1
    { t: T0 + 140 * MIN, credits: 70 },                                    // matching the last +70
  ];
  const dated = dateUnattributed(history, events, 3000);
  assert("whole burst is dated", near(sum(dated), 2940, 1), String(sum(dated)));
  assert("on the UTC day the ledger rose", dated.length === 1 && dated[0].day === "2026-10-04", JSON.stringify(dated));
}

console.log("\nbilling lag is not hidden spend");
{
  // 500 credits of local activity at +10 min; the ledger only reflects it at +30.
  const history = [pt(0, 1000), pt(15, 1000.5), pt(30, 1500)];
  const dated = dateUnattributed(history, [{ t: T0 + 10 * MIN, credits: 500 }], 1000);
  assert("a ledger that catches up later dates nothing", dated.length === 0, JSON.stringify(dated));
}

console.log("\nrise explained by local activity");
{
  const history = [pt(0, 1000), pt(20, 1300)];
  assert("nothing dated when local spend matches", dateUnattributed(history, [{ t: T0 + 5 * MIN, credits: 300 }], 500).length === 0);
}

console.log("\nunplaceable windows stay undated");
{
  const gap = MAX_DATED_WINDOW_MS / MIN + 30; // polls further apart than the limit
  const history = [pt(0, 1000), pt(gap, 1800)];
  assert("a rise inside a long polling gap is not dated", dateUnattributed(history, [], 800).length === 0);
}

console.log("\nthe dated part is capped by the total");
{
  const history = [pt(0, 0), pt(30, 2000)];
  const dated = dateUnattributed(history, [], 600);
  assert("never exceeds what is actually unattributed", near(sum(dated), 600), String(sum(dated)));
}

console.log("\na window across UTC midnight splits by time spent in each day");
{
  const mid = Date.UTC(2026, 9, 5, 0, 0, 0);
  const history = [
    { t: mid - 60 * MIN, used: 0, lastSeen: mid - 60 * MIN },
    { t: mid + 60 * MIN, used: 200, lastSeen: mid + 60 * MIN },
  ];
  const dated = dateUnattributed(history, [], 200);
  assert("half on each side", dated.length === 2 && near(dated[0].credits, 100) && near(dated[1].credits, 100)
    && dated[0].day === "2026-10-04" && dated[1].day === "2026-10-05", JSON.stringify(dated));
}

console.log("\ndashboard: dated credits reach byDay and the quota block");
{
  const now = new Date();
  const month = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), n)).toISOString().slice(0, 10);
  const DAY1 = month(1);
  const DAY2 = month(2);
  const LOCAL = 400;
  const BURST = 500;
  const scan = {
    sessions: [{ sessionId: "s1", project: "p", firstDate: DAY1, lastDate: DAY1, turns: 1, toolCalls: 0,
      promptTokens: 0, outputTokens: 0, models: ["claude-opus-5"], aicCredits: 0, aicByDay: [] }],
    turns: [{
      sessionId: "s1", turnId: "t1", timestamp: DAY1 + "T10:00:00.000Z", modelFamily: "claude-opus-5",
      promptTokens: 0, outputTokens: 0, debugPromptTokens: 1, debugOutputTokens: 1, debugCachedTokens: 0,
      debugAicCredits: LOCAL, debugLlmCalls: 1,
      debugRequests: [{ timestamp: DAY1 + "T10:00:00.000Z", model: "claude-opus-5", prompt: 1, output: 1, cached: 0,
        nanoAiu: LOCAL * 1e9, debugName: "panel/editAgent" }],
    }],
    toolCalls: [], subagents: [],
    stats: { sourceFiles: 1, canonicalSessions: 1, mirroredSessions: 0, mirrorCopiesPruned: 0,
      turnsStored: 1, toolCallsStored: 0, promptPreviews: 0, transcriptsFound: 0, debugLogSessions: 1 },
  };
  const snapshot = { creditsUsed: LOCAL + BURST, entitlement: 5000, remaining: 5000 - LOCAL - BURST,
    overageCount: 0, overagePermitted: false, quotaResetDate: undefined, fetchedAt: Date.now() };
  const d2 = Date.parse(DAY2 + "T08:00:00.000Z");
  const history = [
    { t: d2, used: LOCAL, lastSeen: d2 },
    { t: d2 + 30 * MIN, used: LOCAL + BURST, lastSeen: d2 + 30 * MIN },
  ];

  const withHistory = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, undefined, now, undefined, snapshot, undefined, history).aicSummary;
  const without = buildDashboardData(scan, null, DEFAULT_AIC_CONFIG, undefined, now, undefined, snapshot).aicSummary;
  const credits = (aic, day) => (aic.byDay.find(x => x.day === day) || { credits: 0 }).credits;

  assert("the burst is booked on the day it was billed", near(credits(withHistory, DAY2), BURST), String(credits(withHistory, DAY2)));
  assert("local activity keeps its own day", near(credits(withHistory, DAY1), LOCAL), String(credits(withHistory, DAY1)));
  assert("quota block reports the dated slice",
    withHistory.quota.datedByDay && withHistory.quota.datedByDay.length === 1 && near(withHistory.quota.datedByDay[0].credits, BURST),
    JSON.stringify(withHistory.quota.datedByDay));
  assert("nothing is left parked", withHistory.quota.anchorDay === undefined, String(withHistory.quota.anchorDay));
  assert("byDay still sums to the ledger headline",
    near(withHistory.byDay.reduce((s, x) => s + x.credits, 0), withHistory.totalCredits, 0.05));
  assert("without a history the remainder is parked on the last active day, as before",
    near(credits(without, DAY1), LOCAL + BURST) && without.quota.anchorDay === DAY1 && without.quota.datedByDay === undefined,
    `${credits(without, DAY1)} / ${without.quota.anchorDay}`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

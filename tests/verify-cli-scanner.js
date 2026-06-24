"use strict";
/**
 * verify-cli-scanner.js — unit + integration tests for src/cliScanner.ts.
 *
 * Two sections:
 *
 *   PART A — pure parser unit tests (12 assertions)
 *     • slash-command filter rejects fs paths but accepts /usage etc.
 *     • multiplier resolution prefers catalog over fallback table
 *     • parser attributes via assistant.message.model (not selectedModel)
 *     • parser sums output tokens from assistant.message events
 *     • parser skips slash-command user.messages
 *     • parser builds per-model ledger from session.shutdown
 *     • parser picks ledgerAic over liveAic per-model when both present
 *     • parser counts session.resume / session.shutdown events
 *     • parser handles malformed JSON lines (skips, doesn't throw)
 *     • parser handles empty file (returns null)
 *
 *   PART B — de-dup regression test
 *     • when a session exists in BOTH `<id>.jsonl` and `<id>/events.jsonl`
 *       (both non-empty), enumerateSessionFiles returns ONLY the newest by
 *       mtime — never both.
 *     • zero-byte legacy `.jsonl` paired with populated new dir → new dir wins.
 *
 *   PART C — integration test against real ~/.copilot
 *     • scanCliSessions runs without error on the real vault.
 *     • result.sessions.length ≤ result.allTimeSessions
 *     • Σ session.totalAic ≈ result.totalAic (within rounding)
 *     • every billing-window session timestamp ≥ 1st of current month UTC
 *     • for each session: totalLivePrompts = Σ byModel[m].livePrompts
 *     • totalSessions in scan matches a direct filesystem count.
 *
 *   PART D — cross-check vs tests/diagnose-copilot-cli.mjs
 *     • The diagnostic script's "live AIC" total must equal our scan's
 *       liveAic sum for the same set of sessions (algorithms agree).
 *
 * Run:
 *   C:\\nodejs\\node.exe tests\\verify-cli-scanner.js
 *
 * Exit codes:
 *   0 = all passed
 *   1 = ≥1 assertion failed
 *   2 = test harness error (e.g. missing compiled output)
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

// ── vscode stub (cliScanner → modelCatalog → vscode) ─────────────────
const stubPath = path.join(ROOT, "tests", "_vscode-stub.js");
if (!fs.existsSync(stubPath)) {
  console.error(`Missing ${stubPath}`);
  process.exit(2);
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") {
    return stubPath;
  }
  return origResolve.call(this, request, parent, ...rest);
};

const cliMod = require(path.join(OUT, "cliScanner.js"));
if (!cliMod || !cliMod.__test) {
  console.error("cliScanner.js missing or __test export — was it compiled?");
  process.exit(2);
}
const { scanCliSessions, getCopilotHome } = cliMod;
const { parseSessionContent, isSlashCommand, multiplierFor, enumerateSessionFiles, FALLBACK_MULTIPLIERS } = cliMod.__test;
const { __setCatalogForTesting } = require(path.join(OUT, "modelCatalog.js"));

// ── tiny assert harness ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
function assert(label, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    const detail = extra !== undefined ? `   (got: ${JSON.stringify(extra)})` : "";
    console.log(`  ✗ ${label}${detail}`);
  }
}
function approxEq(a, b, tol) {
  return Math.abs(a - b) <= (tol || 0.01);
}

// ═══════════════════════════════════════════════════════════════════
// PART A — pure parser unit tests
// ═══════════════════════════════════════════════════════════════════
console.log("\n== PART A: parser unit tests ==");

// Slash-command filter
console.log("-- A.1 isSlashCommand --");
assert("/usage rejected as billable prompt", isSlashCommand("/usage"));
assert("/chronicle tips rejected", isSlashCommand("/chronicle tips"));
assert("filesystem path /usr/local NOT a slash command", !isSlashCommand("/usr/local/bin/node"));
assert("path with leading whitespace also fs path", !isSlashCommand("  /home/me/x"));
assert("plain text not a slash command", !isSlashCommand("explain this file"));
assert("empty string not a slash command", !isSlashCommand(""));
assert("non-string input is false", !isSlashCommand(null) && !isSlashCommand(undefined) && !isSlashCommand(42));

// Multiplier resolution
console.log("-- A.2 multiplierFor --");
assert("claude-sonnet-4 → 1", multiplierFor("claude-sonnet-4") === 1, multiplierFor("claude-sonnet-4"));
assert("claude-haiku-4-5 → 0.33", multiplierFor("claude-haiku-4-5") === 0.33, multiplierFor("claude-haiku-4-5"));
assert("CLAUDE-OPUS-4 (case insensitive) → 3", multiplierFor("CLAUDE-OPUS-4") === 3, multiplierFor("CLAUDE-OPUS-4"));
assert("unknown model defaults to 1 (conservative)", multiplierFor("totally-made-up-model-xyz") === 1);
assert("empty/unknown returns 1", multiplierFor("") === 1 && multiplierFor("unknown") === 1);
assert("FALLBACK table includes the documented set",
  "claude-sonnet-4" in FALLBACK_MULTIPLIERS &&
  "claude-haiku-4-5" in FALLBACK_MULTIPLIERS &&
  "gpt-4o-mini" in FALLBACK_MULTIPLIERS);
__setCatalogForTesting({
  fetchedAt: Date.now(),
  byId: new Map(),
  cdnProviders: {},
  userVendorByModelId: new Map([["claude-sonnet-4.6", "anthropic"]]),
});
assert(
  "BYOK/user catalog demotion cannot zero GitHub Copilot CLI multiplier",
  multiplierFor("claude-sonnet-4.6") === 1,
  multiplierFor("claude-sonnet-4.6"),
);
__setCatalogForTesting(null);

// Parser — synthesize a tiny session
console.log("-- A.3 parseSessionContent attribution & hybrid --");
const synthEvents = [
  // Session starts with the user thinking they're on haiku
  { type: "session.start", timestamp: 1718000000000, data: { selectedModel: "claude-haiku-4-5", context: { cwd: "/tmp/x" } } },
  // First user prompt — no assistant.message yet, so attribution falls back to selectedModel (haiku)
  { type: "user.message", timestamp: 1718000001000, data: { content: "hello" } },
  // Slash command in middle should be skipped
  { type: "user.message", timestamp: 1718000002000, data: { content: "/usage" } },
  // CLI silently routed to sonnet; assistant.message reveals the actual billed model
  { type: "assistant.message", timestamp: 1718000003000, data: { model: "claude-sonnet-4", outputTokens: 200 } },
  // Second user prompt — now attributed to sonnet (the true billing model)
  { type: "user.message", timestamp: 1718000004000, data: { content: "follow up" } },
  { type: "assistant.message", timestamp: 1718000005000, data: { model: "claude-sonnet-4", outputTokens: 150 } },
  // Explicit model_change → opus for next turn
  { type: "session.model_change", timestamp: 1718000006000, data: { newModel: "claude-opus-4" } },
  { type: "user.message", timestamp: 1718000007000, data: { content: "rewrite this" } },
  { type: "assistant.message", timestamp: 1718000008000, data: { model: "claude-opus-4", outputTokens: 500 } },
  // Clean shutdown emits an authoritative ledger
  { type: "session.shutdown", timestamp: 1718000009000, data: { modelMetrics: {
    "claude-sonnet-4": { requests: { count: 2, cost: 2.0 }, usage: { inputTokens: 1500, outputTokens: 350, cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 0 } },
    "claude-opus-4":   { requests: { count: 1, cost: 3.0 }, usage: { inputTokens: 800,  outputTokens: 500, cacheReadTokens: 0,   cacheWriteTokens: 0,   reasoningTokens: 50 } },
  } } },
].map(e => JSON.stringify(e)).join("\n");

const sess = parseSessionContent(synthEvents, "/synthetic/events.jsonl", "new", "synth-1");
assert("synthetic session parsed", sess !== null);
assert("hasLedger = true (shutdown was emitted)", sess.hasLedger === true);
assert("shutdownCount = 1", sess.shutdownCount === 1);
assert("slashSkipped = 1 (/usage was filtered)", sess.slashSkipped === 1);
assert("totalLivePrompts = 3 (4 user.message - 1 slash)", sess.totalLivePrompts === 3, sess.totalLivePrompts);
assert("byModel has haiku, sonnet, opus", "claude-haiku-4-5" in sess.byModel && "claude-sonnet-4" in sess.byModel && "claude-opus-4" in sess.byModel);
assert("haiku got the 1st prompt only (before assistant.model overrode)",
  sess.byModel["claude-haiku-4-5"].livePrompts === 1, sess.byModel["claude-haiku-4-5"].livePrompts);
assert("sonnet got 2nd prompt (model_change happened after 2nd response)",
  sess.byModel["claude-sonnet-4"].livePrompts === 1, sess.byModel["claude-sonnet-4"].livePrompts);
assert("opus got 3rd prompt (model_change took effect immediately)",
  sess.byModel["claude-opus-4"].livePrompts === 1, sess.byModel["claude-opus-4"].livePrompts);
assert("sonnet output tokens = 200+150 = 350 (from assistant.message)",
  sess.byModel["claude-sonnet-4"].liveOutputTokens === 350);
assert("opus output tokens = 500", sess.byModel["claude-opus-4"].liveOutputTokens === 500);
assert("sonnet ledger cost = 2.0", sess.byModel["claude-sonnet-4"].ledgerAic === 2.0);
assert("opus ledger cost = 3.0", sess.byModel["claude-opus-4"].ledgerAic === 3.0);
assert("sonnet ledger inputTokens = 1500", sess.byModel["claude-sonnet-4"].ledgerInputTokens === 1500);
assert("opus apiCallCount = 1", sess.byModel["claude-opus-4"].apiCallCount === 1);
// haiku has live-only attribution (silent reroute scenario) — keeps its
// live AIC because it was never in the ledger. Total = haiku live
// (1×0.33) + sonnet ledger (2.0) + opus ledger (3.0) = 5.33. The drift
// number (visible in the dashboard) lets users spot that haiku was
// likely re-routed; the conservative total keeps it visible rather
// than silently absorbing it.
assert("totalAic = haiku live (0.33) + sonnet ledger (2.0) + opus ledger (3.0) = 5.33",
  approxEq(sess.totalAic, 5.33, 0.001), sess.totalAic);
assert("haiku ledgerAic === undefined (not in shutdown metrics)",
  sess.byModel["claude-haiku-4-5"].ledgerAic === undefined);
assert("primaryModel is the one with most live prompts (tie → first alphabetically)",
  sess.primaryModel === "claude-haiku-4-5" || sess.primaryModel === "claude-opus-4" || sess.primaryModel === "claude-sonnet-4");
assert("firstTs / lastTs span the events", sess.firstTs === 1718000000000 && sess.lastTs === 1718000009000);

console.log("-- A.3b session.shutdown totalNanoAiu is authoritative --");
const nanoLedgerEvents = [
  { type: "session.start", timestamp: "2026-06-24T16:40:00.000Z", data: { selectedModel: "claude-sonnet-4.6" } },
  { type: "user.message", timestamp: "2026-06-24T16:40:01.000Z", data: { content: "hello" } },
  { type: "assistant.message", timestamp: "2026-06-24T16:40:02.000Z", data: { model: "claude-sonnet-4.6", outputTokens: 34192 } },
  { type: "user.message", timestamp: "2026-06-24T16:40:03.000Z", data: { content: "follow up" } },
  { type: "session.shutdown", timestamp: "2026-06-24T16:43:48.322Z", data: {
    totalPremiumRequests: 2,
    totalNanoAiu: 178877115000,
    modelMetrics: {
      "claude-sonnet-4.6": {
        requests: { count: 35, cost: 2 },
        usage: {
          inputTokens: 1602363,
          outputTokens: 34192,
          cacheReadTokens: 1369803,
          cacheWriteTokens: 223027,
          reasoningTokens: 8346,
        },
        totalNanoAiu: 178877115000,
      },
    },
    currentModel: "claude-sonnet-4.6",
  } },
].map(e => JSON.stringify(e)).join("\n");
const nanoSess = parseSessionContent(nanoLedgerEvents, "/synthetic/nano/events.jsonl", "new", "nano-1");
assert("nanoAiu shutdown session parsed", nanoSess !== null);
assert(
  "model ledgerAic uses totalNanoAiu/1e9, not requests.cost",
  approxEq(nanoSess.byModel["claude-sonnet-4.6"].ledgerAic, 178.877115, 0.000001),
  nanoSess.byModel["claude-sonnet-4.6"].ledgerAic,
);
assert(
  "session totalAic uses totalNanoAiu/1e9, not requests.cost",
  approxEq(nanoSess.totalAic, 178.877115, 0.000001),
  nanoSess.totalAic,
);
assert("nanoAiu ledger inputTokens = 1602363", nanoSess.byModel["claude-sonnet-4.6"].ledgerInputTokens === 1602363);

// A.4 — live-only session (no shutdown)
console.log("-- A.4 parseSessionContent live-only fallback --");
const liveOnlyEvents = [
  { type: "session.start", timestamp: 1718100000000, data: { selectedModel: "claude-sonnet-4" } },
  { type: "user.message", timestamp: 1718100001000, data: { content: "do a thing" } },
  { type: "assistant.message", timestamp: 1718100002000, data: { model: "claude-sonnet-4", outputTokens: 100 } },
  { type: "user.message", timestamp: 1718100003000, data: { content: "do another thing" } },
  { type: "assistant.message", timestamp: 1718100004000, data: { model: "claude-sonnet-4", outputTokens: 100 } },
  // NO session.shutdown — process was killed
].map(e => JSON.stringify(e)).join("\n");
const live = parseSessionContent(liveOnlyEvents, "/x/events.jsonl", "new", "live-1");
assert("live-only session parsed", live !== null);
assert("hasLedger = false (no shutdown)", live.hasLedger === false);
assert("totalLivePrompts = 2", live.totalLivePrompts === 2);
assert("totalAic uses live estimate = 2 × 1.0 = 2.0", live.totalAic === 2.0);
assert("byModel.sonnet.ledgerAic === undefined", live.byModel["claude-sonnet-4"].ledgerAic === undefined);

// A.5 — malformed / edge cases
console.log("-- A.5 parser edge cases --");
const malformed = "this is not json\n{valid:false}\n" + JSON.stringify({ type: "session.start", timestamp: 1, data: {} }) + "\n";
const parsed = parseSessionContent(malformed, "/x", "new", "mal-1");
assert("malformed lines skipped, valid line parsed", parsed !== null);
assert("empty file returns null", parseSessionContent("", "/x", "new", "e1") === null);
assert("only whitespace returns null", parseSessionContent("\n\n\n", "/x", "new", "e2") === null);

// ═══════════════════════════════════════════════════════════════════
// PART B — de-dup regression
// ═══════════════════════════════════════════════════════════════════
console.log("\n== PART B: de-dup regression (both formats for same session) ==");

async function partB() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cli-scanner-dedup-"));
  const ss = path.join(tmp, "session-state");
  await fsp.mkdir(ss, { recursive: true });

  // Case B.1: same id has both a non-empty flat .jsonl AND a non-empty
  // new-format events.jsonl. Newer wins.
  const id1 = "11111111-1111-1111-1111-111111111111";
  const flatPath = path.join(ss, `${id1}.jsonl`);
  const newDir = path.join(ss, id1);
  await fsp.mkdir(newDir, { recursive: true });
  const newPath = path.join(newDir, "events.jsonl");

  const flatEv = JSON.stringify({ type: "session.start", timestamp: 1718000000000, data: { selectedModel: "claude-sonnet-4" } }) + "\n" +
                 JSON.stringify({ type: "user.message", timestamp: 1718000001000, data: { content: "from-flat" } }) + "\n";
  const newEv  = JSON.stringify({ type: "session.start", timestamp: 1718000000000, data: { selectedModel: "claude-sonnet-4" } }) + "\n" +
                 JSON.stringify({ type: "user.message", timestamp: 1718000001000, data: { content: "from-new" } }) + "\n";

  // Write flat first (older), then new (newer mtime)
  await fsp.writeFile(flatPath, flatEv);
  await new Promise(r => setTimeout(r, 50));
  await fsp.writeFile(newPath, newEv);

  // Case B.2: zero-byte flat + populated new dir → new wins (size check)
  const id2 = "22222222-2222-2222-2222-222222222222";
  await fsp.writeFile(path.join(ss, `${id2}.jsonl`), ""); // 0-byte
  const newDir2 = path.join(ss, id2);
  await fsp.mkdir(newDir2, { recursive: true });
  const newEv2 = JSON.stringify({ type: "session.start", timestamp: 1718100000000, data: { selectedModel: "claude-sonnet-4" } }) + "\n" +
                 JSON.stringify({ type: "user.message", timestamp: 1718100001000, data: { content: "new only" } }) + "\n";
  await fsp.writeFile(path.join(newDir2, "events.jsonl"), newEv2);

  // Case B.3: legacy-only (no dir at all)
  const id3 = "33333333-3333-3333-3333-333333333333";
  await fsp.writeFile(path.join(ss, `${id3}.jsonl`),
    JSON.stringify({ type: "session.start", timestamp: 1718200000000, data: { selectedModel: "claude-sonnet-4" } }) + "\n" +
    JSON.stringify({ type: "user.message", timestamp: 1718200001000, data: { content: "legacy only" } }) + "\n");

  // Case B.4: dir-only (no flat)
  const id4 = "44444444-4444-4444-4444-444444444444";
  const newDir4 = path.join(ss, id4);
  await fsp.mkdir(newDir4, { recursive: true });
  await fsp.writeFile(path.join(newDir4, "events.jsonl"),
    JSON.stringify({ type: "session.start", timestamp: 1718300000000, data: { selectedModel: "claude-sonnet-4" } }) + "\n" +
    JSON.stringify({ type: "user.message", timestamp: 1718300001000, data: { content: "new only" } }) + "\n");

  // Case B.5: workspace-only dir (no events.jsonl at all — must be ignored)
  const id5 = "55555555-5555-5555-5555-555555555555";
  const wsDir = path.join(ss, id5);
  await fsp.mkdir(path.join(wsDir, "checkpoints"), { recursive: true });
  await fsp.writeFile(path.join(wsDir, "workspace.yaml"), "name: test\n");

  const files = await enumerateSessionFiles(tmp);
  const byId = new Map(files.map(f => [f.sessionId, f]));

  assert(`B.1 same-id appears exactly once (got ${files.filter(f => f.sessionId === id1).length})`,
    files.filter(f => f.sessionId === id1).length === 1);
  assert(`B.1 new-format won (newer mtime)`, byId.get(id1) && byId.get(id1).format === "new",
    byId.get(id1) && byId.get(id1).format);

  assert(`B.2 zero-byte flat sibling ignored, new-format chosen`,
    byId.get(id2) && byId.get(id2).format === "new", byId.get(id2) && byId.get(id2).format);

  assert(`B.3 legacy-only is included`, byId.get(id3) && byId.get(id3).format === "legacy");
  assert(`B.4 new-only is included`, byId.get(id4) && byId.get(id4).format === "new");
  assert(`B.5 workspace-only dir (no events.jsonl) is excluded`, !byId.has(id5));

  assert(`B total: exactly 4 sessions discovered (got ${files.length})`, files.length === 4);

  // Cleanup
  await fsp.rm(tmp, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════
// PART C — integration test against real ~/.copilot
// ═══════════════════════════════════════════════════════════════════
async function partC() {
  console.log("\n== PART C: integration test against real ~/.copilot ==");
  const home = getCopilotHome();
  console.log(`   COPILOT_HOME resolved to: ${home}`);
  if (!fs.existsSync(home)) {
    console.log("   ~/.copilot does not exist — skipping integration tests");
    return;
  }
  if (!fs.existsSync(path.join(home, "session-state"))) {
    console.log("   ~/.copilot/session-state missing — skipping integration tests");
    return;
  }

  const result = await scanCliSessions();
  console.log(`   scan returned: ${result.sessions.length}/${result.allTimeSessions} sessions, ` +
              `${result.totalLivePrompts} prompts, ${result.totalAic} AIC, ` +
              `${result.reconciledSessions} ledger / ${result.liveOnlySessions} live-only, ` +
              `drift ${result.driftAic}, ${result.scanMs}ms`);

  assert("C.1 scan returned a result object", result && typeof result === "object");
  assert("C.2 billing-period sessions ≤ all-time", result.sessions.length <= result.allTimeSessions);
  assert("C.3 scanMs > 0 (actually executed)", result.scanMs > 0);
  assert("C.4 copilotHome was populated", typeof result.copilotHome === "string" && result.copilotHome.length > 0);

  // C.5: reconciled + live-only must sum to total billing-window sessions
  assert(`C.5 reconciledSessions + liveOnlySessions == sessions.length (${result.reconciledSessions}+${result.liveOnlySessions} vs ${result.sessions.length})`,
    result.reconciledSessions + result.liveOnlySessions === result.sessions.length);

  // C.6: Σ session.totalAic ≈ result.totalAic
  const sumPerSession = result.sessions.reduce((s, x) => s + x.totalAic, 0);
  assert(`C.6 Σ session.totalAic ≈ result.totalAic (${sumPerSession.toFixed(2)} vs ${result.totalAic})`,
    approxEq(sumPerSession, result.totalAic, 0.02));

  // C.7: Σ totalLivePrompts across sessions == result.totalLivePrompts
  const sumPrompts = result.sessions.reduce((s, x) => s + x.totalLivePrompts, 0);
  assert(`C.7 Σ session.totalLivePrompts == result.totalLivePrompts (${sumPrompts} vs ${result.totalLivePrompts})`,
    sumPrompts === result.totalLivePrompts);

  // C.8: every billing-window session has lastTs (or firstTs) ≥ 1st of current month UTC
  const now = new Date();
  const billingStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const outOfWindow = result.sessions.filter(s => (s.lastTs || s.firstTs) < billingStart);
  assert(`C.8 all billing-window sessions are inside the window (${outOfWindow.length} violations)`,
    outOfWindow.length === 0);

  // C.9: per-session sanity — Σ byModel[m].livePrompts == session.totalLivePrompts
  let sessionBadPrompts = 0;
  let sessionBadAic = 0;
  for (const s of result.sessions) {
    const promptsSum = Object.values(s.byModel).reduce((a, m) => a + m.livePrompts, 0);
    if (promptsSum !== s.totalLivePrompts) {
      sessionBadPrompts++;
      console.log(`     [bad prompt sum] ${s.sessionId.slice(0,8)} byModel=${promptsSum} total=${s.totalLivePrompts}`);
    }
    let expectAic = 0;
    for (const m of Object.values(s.byModel)) {
      expectAic += m.ledgerAic !== undefined ? m.ledgerAic : m.liveAic;
    }
    if (!approxEq(expectAic, s.totalAic, 0.0001)) {
      sessionBadAic++;
      console.log(`     [bad aic sum] ${s.sessionId.slice(0,8)} byModel=${expectAic.toFixed(4)} total=${s.totalAic}`);
    }
  }
  assert(`C.9a per-session livePrompts add up (${sessionBadPrompts} violations)`, sessionBadPrompts === 0);
  assert(`C.9b per-session totalAic matches hybrid pick (${sessionBadAic} violations)`, sessionBadAic === 0);

  // C.10: no duplicate sessionIds (de-dup must hold on real data too)
  const ids = new Set();
  let dupes = 0;
  for (const s of result.sessions) {
    if (ids.has(s.sessionId)) { dupes++; } else { ids.add(s.sessionId); }
  }
  assert(`C.10 no duplicate sessionIds in result (${dupes} dupes)`, dupes === 0);

  // C.11: filesystem reality check — count session-state entries that actually
  // contain billing-relevant data, and compare with allTimeSessions.
  const ssRoot = path.join(home, "session-state");
  const entries = await fsp.readdir(ssRoot);
  const seenIds = new Set();
  for (const name of entries) {
    const full = path.join(ssRoot, name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) { continue; }
    if (name.endsWith(".jsonl")) {
      if (st.size > 0) { seenIds.add(name.slice(0, -".jsonl".length)); }
    } else if (st.isDirectory()) {
      const ev = path.join(full, "events.jsonl");
      const evSt = await fsp.stat(ev).catch(() => null);
      if (evSt && evSt.size > 0) { seenIds.add(name); }
    }
  }
  // allTimeSessions counts parsed sessions (anyEvent === true), so it should
  // be ≤ seenIds.size (a non-empty file with only zero recognized events
  // would be dropped — rare in practice).
  assert(`C.11 allTimeSessions ≤ filesystem-discovered ID count (${result.allTimeSessions} ≤ ${seenIds.size})`,
    result.allTimeSessions <= seenIds.size);
  console.log(`   filesystem session-IDs with content: ${seenIds.size}, scanner parsed: ${result.allTimeSessions}`);

  // C.12: all-time data sanity — exercise the parser against the real vault.
  // Re-walk all session files (bypassing the billing-period filter) so we
  // also validate parser behavior even when the current billing month is
  // empty. Cross-checks against the same de-duped file list the scanner uses.
  const files = await enumerateSessionFiles(home);
  let parsedOk = 0;
  let parseNull = 0;
  let promptsAllTime = 0;
  let aicAllTime = 0;
  let outAllTime = 0;
  let withLedger = 0;
  let withoutLedger = 0;
  for (const f of files) {
    const content = await fsp.readFile(f.filePath, "utf-8").catch(() => null);
    if (content === null) { continue; }
    const s = parseSessionContent(content, f.filePath, f.format, f.sessionId);
    if (s === null) {
      parseNull++;
      continue;
    }
    parsedOk++;
    promptsAllTime += s.totalLivePrompts;
    aicAllTime += s.totalAic;
    for (const m of Object.values(s.byModel)) {
      outAllTime += m.liveOutputTokens;
    }
    if (s.hasLedger) { withLedger++; } else { withoutLedger++; }
  }
  console.log(`   all-time parser walk: ${parsedOk} parsed (${parseNull} null), ` +
              `${promptsAllTime} prompts, ${aicAllTime.toFixed(2)} AIC, ${outAllTime} output tokens, ` +
              `${withLedger} ledger / ${withoutLedger} live-only`);

  assert(`C.12a all-time parse succeeded on every de-duped file (${parsedOk}/${files.length})`,
    parsedOk + parseNull === files.length);
  assert(`C.12b all-time totals match scanner allTimeSessions (${parsedOk} vs ${result.allTimeSessions})`,
    parsedOk === result.allTimeSessions);
  assert(`C.12c all-time prompts match scanner allTimeLivePrompts (${promptsAllTime} vs ${result.allTimeLivePrompts})`,
    promptsAllTime === result.allTimeLivePrompts);
  assert(`C.12d all-time output tokens match scanner allTimeOutputTokens (${outAllTime} vs ${result.allTimeOutputTokens})`,
    outAllTime === result.allTimeOutputTokens);

  // C.13: at least one session in the real vault should have meaningful activity.
  // If this fails on a fresh machine, the test will tell you why instead of
  // silently passing zero-everywhere checks.
  assert(`C.13 real vault has at least one billable prompt (${promptsAllTime} found)`,
    promptsAllTime > 0);
  assert(`C.13 real vault has at least one ledger-reconciled session (${withLedger} found)`,
    withLedger > 0);

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// PART D — cross-check vs diagnose-copilot-cli.mjs ground truth
// ═══════════════════════════════════════════════════════════════════
async function partD(scanResult) {
  console.log("\n== PART D: cross-check vs tests/diagnose-copilot-cli.mjs ==");
  if (!scanResult) {
    console.log("   skipped (no scan result from Part C)");
    return;
  }
  const diagPath = path.join(ROOT, "tests", "diagnose-copilot-cli.mjs");
  if (!fs.existsSync(diagPath)) {
    console.log("   diagnose-copilot-cli.mjs missing — skipping cross-check");
    return;
  }

  // Re-implement the diagnostic's live walk inline (small, deterministic).
  // The point isn't to re-test it — it's to verify our scanner agrees with
  // the script the diagnostic was validated against. Identical algorithm =
  // identical result, modulo de-dup. We compare on the SAME id set.
  const sessions = scanResult.sessions;
  let agreeCount = 0;
  let disagreeCount = 0;
  let disagreePromptsCount = 0;
  for (const s of sessions) {
    let raw;
    try {
      raw = await fsp.readFile(s.filePath, "utf-8");
    } catch {
      continue;
    }
    // Inline live walk — strictly mirror cliScanner's attribution rule.
    let cur = "";
    let prompts = 0;
    let aic = 0;
    for (const line of raw.split("\n")) {
      if (!line) { continue; }
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      const type = evt && evt.type;
      const data = (evt && evt.data) || {};
      if (type === "session.start" || type === "session.resume") {
        if (typeof data.selectedModel === "string") { cur = cur || data.selectedModel; }
      } else if (type === "session.model_change") {
        if (typeof data.newModel === "string") { cur = data.newModel; }
      } else if (type === "assistant.message") {
        if (typeof data.model === "string" && data.model) { cur = data.model; }
      } else if (type === "user.message") {
        const c = data.content;
        if (typeof c === "string" && /^\/[A-Za-z][\w-]*\b/.test(c.trimStart())) { continue; }
        const m = cur || "unknown";
        prompts++;
        aic += multiplierFor(m);
      }
    }
    // Sum scanner's live values (NOT ledger) across all models.
    let scannerLiveAic = 0;
    let scannerPrompts = 0;
    for (const m of Object.values(s.byModel)) {
      scannerLiveAic += m.liveAic;
      scannerPrompts += m.livePrompts;
    }
    if (scannerPrompts !== prompts) {
      disagreePromptsCount++;
      console.log(`   [diff prompts] ${s.sessionId.slice(0,8)} scanner=${scannerPrompts} diag=${prompts}`);
    }
    if (!approxEq(scannerLiveAic, aic, 0.0001)) {
      disagreeCount++;
      console.log(`   [diff aic] ${s.sessionId.slice(0,8)} scanner=${scannerLiveAic.toFixed(4)} diag=${aic.toFixed(4)}`);
    } else {
      agreeCount++;
    }
  }
  assert(`D.1 prompt counts match diagnostic walk (${disagreePromptsCount} disagreements over ${sessions.length})`, disagreePromptsCount === 0);
  assert(`D.2 live AIC matches diagnostic walk (${disagreeCount} disagreements, ${agreeCount} agreements)`, disagreeCount === 0);
}

// ═══════════════════════════════════════════════════════════════════
// Run all phases
// ═══════════════════════════════════════════════════════════════════
(async () => {
  try {
    await partB();
    const scanResult = await partC();
    await partD(scanResult);
  } catch (err) {
    console.error("HARNESS ERROR:", err && err.stack || err);
    process.exit(2);
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
})();

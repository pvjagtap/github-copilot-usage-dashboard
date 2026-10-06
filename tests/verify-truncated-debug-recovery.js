/**
 * verify-truncated-debug-recovery.js — credits lost with a debug log's head
 * must be taken back from the chatSession.
 *
 * Copilot caps `debug-logs/<sid>/main.jsonl` by cutting off its HEAD, so the
 * `llm_request` lines (and their `copilotUsageNanoAiu`) of a long session's
 * early requests disappear. The chatSession still carries VS Code's own
 * per-request `copilotCredits`, which equals the debug-log sum for intact
 * sessions. The scanner used to let the debug log overwrite it unconditionally,
 * so the lost requests were billed by GitHub but absent from the dashboard.
 *
 * Covers the recovery rule and the full scan wiring for a kind=0 session.
 *
 *   node tests/verify-truncated-debug-recovery.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (q, p, ...a) { return q === "vscode" ? stubPath : origResolve.call(this, q, p, ...a); };

const { scanWorkspaceStorage, recoverTruncatedDebugCredits, RECOVERED_DEBUG_NAME } = require(path.join(OUT, "scanner.js"));

let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}
const near = (a, b) => Math.abs(a - b) < 1e-6;
const sum = xs => xs.reduce((s, x) => s + x, 0);

const BASE = Date.UTC(2026, 8, 20, 10, 0, 0); // after the 2026-06-01 AIC start
const MIN = 60_000;
const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ── Recovery rule ───────────────────────────────────────────────

function chatTurn(i, startMin, credits, withDebug = true) {
  return {
    sessionId: SID, turnIndex: i, timestamp: new Date(BASE + startMin * MIN).toISOString(),
    modelFamily: "claude-opus-5", chatCredits: credits, chatStartMs: BASE + startMin * MIN,
    debugAicCredits: 0, debugRequests: withDebug ? [{ timestamp: "", model: "x", prompt: 1, output: 1, cached: 0, nanoAiu: 1 }] : undefined,
  };
}
function dbgReq(min, credits) {
  return { timestamp: new Date(BASE + min * MIN).toISOString(), model: "claude-opus-5", prompt: 10, output: 10, cached: 0, nanoAiu: credits * 1e9 };
}

console.log("\nhead cut: request 0 lost entirely");
{
  const turns = [chatTurn(0, 0, 100), chatTurn(1, 10, 80), chatTurn(2, 20, 60)];
  const dbg = [dbgReq(11, 50), dbgReq(12, 30), dbgReq(21, 60)];
  const rec = recoverTruncatedDebugCredits(turns, dbg, 140);
  assert("exactly the lost request is recovered", rec.length === 1 && rec[0].turnIndex === 0 && near(rec[0].credits, 100),
    JSON.stringify(rec));
}

console.log("\nhead cut: request 1 only partly lost");
{
  const turns = [chatTurn(0, 0, 100), chatTurn(1, 10, 80), chatTurn(2, 20, 60)];
  const dbg = [dbgReq(12, 30), dbgReq(21, 60)]; // request 1 kept 30 of its 80
  const rec = recoverTruncatedDebugCredits(turns, dbg, 90);
  assert("missing part of each cut request is recovered", near(sum(rec.map(r => r.credits)), 150),
    rec.map(r => `${r.turnIndex}:${r.credits}`).join(","));
  assert("request 1 recovers only what the log no longer holds",
    near(rec.find(r => r.turnIndex === 1).credits, 50));
}

console.log("\nintact session");
{
  const turns = [chatTurn(0, 0, 100), chatTurn(1, 10, 80)];
  const dbg = [dbgReq(1, 100), dbgReq(11, 80)];
  assert("nothing recovered when the log matches", recoverTruncatedDebugCredits(turns, dbg, 180).length === 0);
}

console.log("\ndebug log lagging on the live tail");
{
  // Request 1 is the in-flight one: chatSession already reports credits the
  // log has not flushed yet. It began after the log's first request, so it is
  // not a head cut and must not be topped up.
  const turns = [chatTurn(0, 0, 100), chatTurn(1, 10, 80)];
  const dbg = [dbgReq(1, 100)];
  assert("tail lag is left alone", recoverTruncatedDebugCredits(turns, dbg, 100).length === 0);
}

console.log("\nshortfall is the hard cap");
{
  // The chatSession credits 100 to request 0, but the scanner already counts
  // 70 of the session's credits elsewhere, so only 30 can be missing.
  const turns = [chatTurn(0, 0, 100), chatTurn(1, 10, 80)];
  const dbg = [dbgReq(11, 80)];
  const rec = recoverTruncatedDebugCredits(turns, dbg, 150);
  assert("never recovers more than the session shortfall", near(sum(rec.map(r => r.credits)), 30),
    String(sum(rec.map(r => r.credits))));
}

console.log("\nturn with no debug overlay already counts its own credits");
{
  const turns = [chatTurn(0, 0, 100, false), chatTurn(1, 10, 80)];
  const dbg = [dbgReq(11, 80)];
  assert("not recovered a second time", recoverTruncatedDebugCredits(turns, dbg, 80).length === 0);
}

// ── Full scan: kind=0 chatSession + head-truncated debug log ────

function chatSessionLines() {
  const reqs = [0, 1, 2].map(i => ({
    requestId: `request_${i}`, timestamp: BASE + i * 10 * MIN,
    modelId: "copilot/claude-opus-5", message: { text: `prompt ${i}` },
  }));
  const credits = [100, 80, 60];
  const lines = [
    JSON.stringify({ kind: 0, v: { sessionId: SID, creationDate: BASE, initialLocation: "panel" } }),
    JSON.stringify({ kind: 2, k: ["requests"], v: reqs }),
  ];
  for (let i = 0; i < 3; i++) {
    lines.push(JSON.stringify({ kind: 1, k: ["requests", i, "copilotCredits"], v: credits[i] }));
    lines.push(JSON.stringify({ kind: 1, k: ["requests", i, "result"], v: { metadata: { requestTimestamp: BASE + i * 10 * MIN } } }));
  }
  return lines.join("\n");
}

function debugLogLines() {
  const ev = (type, ts, attrs) => JSON.stringify({ v: 1, ts, dur: 0, sid: SID, type, name: type, spanId: `${type}-${ts}`, status: "ok", attrs });
  return [
    '_tail of a line the head cut left half-written","x":1}', // what a truncated main.jsonl opens on
    ev("turn_start", BASE + 10 * MIN, { turnId: "0" }),
    ev("llm_request", BASE + 11 * MIN, { model: "claude-opus-5", inputTokens: 1000, outputTokens: 100, cachedTokens: 0, copilotUsageNanoAiu: 80e9, debugName: "panel/editAgent" }),
    ev("turn_start", BASE + 20 * MIN, { turnId: "1" }),
    ev("llm_request", BASE + 21 * MIN, { model: "claude-opus-5", inputTokens: 1000, outputTokens: 100, cachedTokens: 0, copilotUsageNanoAiu: 60e9, debugName: "panel/editAgent" }),
  ].join("\n");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trunc-dbg-"));
  try {
    const ws = path.join(tmp, "wshash1");
    fs.mkdirSync(path.join(ws, "chatSessions"), { recursive: true });
    fs.writeFileSync(path.join(ws, "chatSessions", `${SID}.jsonl`), chatSessionLines());
    const dbgDir = path.join(ws, "GitHub.copilot-chat", "debug-logs", SID);
    fs.mkdirSync(dbgDir, { recursive: true });
    fs.writeFileSync(path.join(dbgDir, "main.jsonl"), debugLogLines());

    console.log("\nscan: debug log holds 140 of the 240 credits the chatSession recorded");
    const scan = await scanWorkspaceStorage(tmp);
    const turns = scan.turns.filter(t => t.sessionId === SID);
    const counted = sum(turns.map(t => t.debugRequests && t.debugRequests.length
      ? sum(t.debugRequests.map(r => r.nanoAiu / 1e9)) : t.debugAicCredits));
    assert("session credits equal the chatSession total", near(counted, 240), String(counted));
    assert("turn credits agree with their request records",
      turns.every(t => !t.debugRequests || near(t.debugAicCredits, sum(t.debugRequests.map(r => r.nanoAiu / 1e9)))));
    const recovered = turns.flatMap(t => (t.debugRequests || []).filter(r => r.debugName === RECOVERED_DEBUG_NAME));
    assert("recovered credit is dated at the lost request",
      recovered.length === 1 && recovered[0].timestamp === new Date(BASE).toISOString() && near(recovered[0].nanoAiu / 1e9, 100),
      JSON.stringify(recovered));
    const byModel = sum(turns.flatMap(t => Object.values(t.debugByModel || {})).map(m => m.nanoAiu / 1e9));
    assert("per-model breakdown carries the recovered credits too", near(byModel, 240), String(byModel));
    assert("session total includes them", near(scan.sessions[0].debugTotalAicCredits, 240),
      String(scan.sessions[0].debugTotalAicCredits));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

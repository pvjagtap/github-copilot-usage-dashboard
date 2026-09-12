/**
 * verify-chatsession-formats.js — both chatSessions JSONL formats must parse.
 *
 * VS Code migrated chatSessions from a kind=0 header + embedded v.requests[]
 * to a header-less delta log: kind=1 sets a value at a path, kind=2 appends to
 * an array, and the session id lives only in the filename. The scanner keyed
 * everything off the kind=0 op and returned null for every new-format file, so
 * the dashboard reported 0 VS Code sessions while Copilot was actively in use.
 *
 * Builds both shapes as fixtures and asserts each yields a session with turns,
 * tokens, credits and tool calls.
 *
 *   node tests/verify-chatsession-formats.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (q, p, ...a) { return q === "vscode" ? stubPath : origResolve.call(this, q, p, ...a); };

const { scanWorkspaceStorage } = require(path.join(OUT, "scanner.js"));

let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

const TS = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 15, 10, 0, 0);
const SID = "11111111-2222-3333-4444-555555555555";

const toolRound = {
  response: "ok",
  toolCalls: [
    { name: "run_in_terminal", arguments: "{}" },
    { name: "runSubagent", arguments: JSON.stringify({ agentName: "Explore", description: "look" }) },
  ],
};
const metadata = {
  sessionId: SID,
  agentId: "github.copilot.editsAgent",
  requestTimestamp: TS,
  toolCallRounds: [toolRound],
  toolCallResults: {},
};

// Legacy: kind=0 header carrying the whole session.
function legacyLines() {
  return [
    JSON.stringify({
      kind: 0,
      v: {
        sessionId: SID,
        creationDate: TS,
        initialLocation: "panel",
        requests: [
          { timestamp: TS, message: { text: "hello legacy" }, result: { metadata } },
        ],
      },
    }),
  ].join("\n");
}

// Current: no kind=0. kind=2 appends the request, kind=1 sets fields on it.
function currentLines() {
  return [
    JSON.stringify({ kind: 1, k: ["responderUsername"], v: "" }),
    JSON.stringify({
      kind: 2, k: ["requests"],
      v: [{
        requestId: "request_abc", timestamp: TS,
        agent: { id: "github.copilot.editsAgent" },
        modelId: "copilot/claude-opus-5",
        message: { text: "hello current" },
      }],
    }),
    JSON.stringify({ kind: 1, k: ["requests", 0, "promptTokens"], v: 397156 }),
    JSON.stringify({ kind: 1, k: ["requests", 0, "completionTokens"], v: 5160 }),
    JSON.stringify({ kind: 1, k: ["requests", 0, "copilotCredits"], v: 320.1395 }),
    JSON.stringify({ kind: 1, k: ["requests", 0, "modelState"], v: { value: 3, completedAt: TS } }),
    JSON.stringify({ kind: 1, k: ["requests", 0, "result"], v: { metadata } }),
  ].join("\n");
}

async function scanFixture(label, content, fileName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-fmt-"));
  const chatDir = path.join(tmp, "wshash1", "chatSessions");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, fileName), content);
  const scan = await scanWorkspaceStorage(tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${label}`);
  return scan;
}

async function main() {
  for (const [label, content, fileName] of [
    ["legacy format (kind=0 header)", legacyLines(), `${SID}.jsonl`],
    ["current format (delta log, id from filename)", currentLines(), `${SID}.jsonl`],
  ]) {
    const scan = await scanFixture(label, content, fileName);
    assert("one session parsed", scan.sessions.length === 1, `${scan.sessions.length}`);
    assert("session id resolved", scan.sessions[0] && scan.sessions[0].sessionId === SID,
      scan.sessions[0] && scan.sessions[0].sessionId);
    assert("turn emitted", scan.turns.length === 1, `${scan.turns.length}`);
    assert("tool calls captured", scan.toolCalls.length === 2, `${scan.toolCalls.length}`);
    assert("subagent captured", scan.subagents.length === 1, `${scan.subagents.length}`);
  }

  // Format-specific payload the legacy header never carried.
  const scan = await scanFixture("current format payload", currentLines(), `${SID}.jsonl`);
  const t = scan.turns[0] || {};
  assert("promptTokens read", t.promptTokens === 397156, t.promptTokens);
  assert("completionTokens read", t.outputTokens === 5160, t.outputTokens);
  assert("copilotCredits read", Math.abs((t.debugAicCredits || 0) - 320.1395) < 0.0001, t.debugAicCredits);
  assert("model derived from modelId", t.modelFamily === "claude-opus-5", t.modelFamily);
  assert("timestamp resolved", typeof t.timestamp === "string" && t.timestamp.length >= 10, t.timestamp);

  // Filename fallback: no metadata.sessionId anywhere.
  const noMeta = [
    JSON.stringify({ kind: 2, k: ["requests"], v: [{ timestamp: TS, modelId: "copilot/claude-sonnet-5", message: { text: "x" } }] }),
    JSON.stringify({ kind: 1, k: ["requests", 0, "promptTokens"], v: 10 }),
  ].join("\n");
  const s2 = await scanFixture("current format, id only in filename", noMeta, `${SID}.jsonl`);
  assert("session id falls back to filename", s2.sessions.length === 1 && s2.sessions[0].sessionId === SID,
    s2.sessions[0] && s2.sessions[0].sessionId);

  // Mixed shape seen in the wild: a kind=0 header exists (so the header-less
  // rebuild is skipped) but carries no requests[] and no inputState. Only the
  // kind=1 ops know the model. Reading it off the session header alone left
  // real Copilot turns as "unknown", which the classifier then filed as
  // non-billable BYOK traffic.
  console.log("\nkind=0 header without requests[] or inputState");
  const mixed = [
    JSON.stringify({ kind: 0, v: { sessionId: SID, creationDate: TS, initialLocation: "panel" } }),
    JSON.stringify({ kind: 1, k: ["requests", 0, "modelId"], v: "copilot/claude-opus-5" }),
    JSON.stringify({ kind: 1, k: ["requests", 0, "result"], v: { metadata: { ...metadata } } }),
    JSON.stringify({ kind: 1, k: ["requests", 1, "result"], v: { metadata: { ...metadata, resolvedModel: "claude-sonnet-5" } } }),
  ].join("\n");
  const s3 = await scanFixture("mixed header", mixed, `${SID}.jsonl`);
  assert("both turns emitted", s3.turns.length === 2, `${s3.turns.length}`);
  assert("model from per-request modelId", s3.turns[0] && s3.turns[0].modelFamily === "claude-opus-5",
    s3.turns[0] && s3.turns[0].modelFamily);
  assert("model from result.metadata.resolvedModel", s3.turns[1] && s3.turns[1].modelFamily === "claude-sonnet-5",
    s3.turns[1] && s3.turns[1].modelFamily);
  assert("no turn left as unknown", s3.turns.every(t => t.modelFamily && t.modelFamily !== "unknown"),
    s3.turns.map(t => t.modelFamily).join(","));

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

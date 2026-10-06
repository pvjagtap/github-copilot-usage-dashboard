/**
 * verify-agent-title-record-header.js — an agent session whose first line is a
 * `type: "title"` record (current OMP format) must still be scanned.
 *
 * Regression: parseAgentSession() only accepted a `type: "session"` header on
 * line 0, so every session from an OMP version that writes a padded title
 * record first was dropped — the dashboard reported 0 OMP sessions.
 *
 *   node tests/verify-agent-title-record-header.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

function call(usd) {
  const now = new Date();
  const ts = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12, 0, 0) + 3600_000;
  return JSON.stringify({
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      model: "claude-opus-5",
      provider: "github-copilot",
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: usd } },
    },
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "title-header-"));
  const proj = path.join(tmp, "sessions", "proj");
  fs.mkdirSync(proj, { recursive: true });

  const title = JSON.stringify({ type: "title", v: 1, title: "t", pad: " ".repeat(200) });
  const header = JSON.stringify({ type: "session", id: "after-title", cwd: "/tmp/x", title: "My session" });
  fs.writeFileSync(path.join(proj, "titled.jsonl"), [title, header, call(0.5)].join("\n"));
  fs.writeFileSync(path.join(proj, "plain.jsonl"),
    [JSON.stringify({ type: "session", id: "header-first", cwd: "/tmp/y" }), call(0.25)].join("\n"));
  // A file with no session record in its first lines is not a session.
  fs.writeFileSync(path.join(proj, "headerless.jsonl"), [title, title, title, title, title, header, call(9)].join("\n"));

  process.env["PI_CODING_AGENT_DIR"] = tmp;
  const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));
  const scan = await scanAgentSessions();
  const byId = new Map(scan.sessions.filter(s => s.source === "pi").map(s => [s.sessionId, s]));

  assert("session behind a title record is scanned", byId.has("after-title"), [...byId.keys()].join(","));
  assert("its title comes from the session header", byId.get("after-title")?.title === "My session");
  assert("its usage is counted once", byId.get("after-title")?.llmCalls === 1);
  assert("header-first (Pi) layout still works", byId.has("header-first"));
  assert("header beyond the first 5 lines is rejected", !byId.has("headerless") && byId.size === 2, byId.size);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

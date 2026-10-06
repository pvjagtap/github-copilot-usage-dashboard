/**
 * verify-pig-sessions.js — PiG (~/.pig) sessions are a billed source.
 *
 * PiG is a Pi-derived agent that routes to GitHub Copilot. Its sessions were
 * never scanned, so the credits GitHub billed for them (about 2,940 in a single
 * two-hour window on one machine) matched no local log and surfaced only as the
 * unexplained gap against the GitHub ledger.
 *
 * Layout: <root>/<project>/<session>.jsonl, subagent runs at
 * <project>/<session>/<run>/run-0/session.jsonl, and header-less copies of those
 * transcripts under <project>/subagent-artifacts/ that must not be counted twice.
 *
 *   node tests/verify-pig-sessions.js
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

const now = new Date();
const TS = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12, 0, 0) + 3600_000;
function call(usd, id) {
  return JSON.stringify({
    type: "message",
    timestamp: new Date(TS).toISOString(),
    message: {
      role: "assistant", model: "claude-opus-5", provider: "github-copilot", timestamp: TS, responseId: id,
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: usd } },
    },
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pig-"));
  try {
    const sessions = path.join(tmp, "sessions");
    const proj = path.join(sessions, "--proj--");
    const sid = "2026-10-01T00-00-00-000Z_main";
    const run = path.join(proj, sid, "run-a", "run-0");
    fs.mkdirSync(run, { recursive: true });
    fs.mkdirSync(path.join(proj, "subagent-artifacts"), { recursive: true });

    fs.writeFileSync(path.join(proj, sid + ".jsonl"),
      [JSON.stringify({ type: "session", id: "pig-main", cwd: "/x" }), call(10, "r1"), call(10, "r2")].join("\n"));
    fs.writeFileSync(path.join(run, "session.jsonl"),
      [JSON.stringify({ type: "session", id: "pig-sub", cwd: "/x" }), call(5, "r3")].join("\n"));
    // The same subagent transcript as a header-less copy.
    fs.writeFileSync(path.join(proj, "subagent-artifacts", "run-a_delegate_0_transcript.jsonl"),
      [JSON.stringify({ version: 1, recordType: "message", runId: "run-a" }), call(5, "r3")].join("\n"));

    process.env["PIG_CODING_AGENT_DIR"] = tmp;
    const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));
    const scan = await scanAgentSessions();
    const mine = scan.sessions.filter(s => s.source === "pig" && s.filePath.startsWith(tmp));
    const credits = mine.reduce((s, x) => s + x.totalCostCredits, 0);

    assert("main session and nested subagent run are read", mine.length === 2, `${mine.length}`);
    assert("a subagent copy under subagent-artifacts is not counted twice", Math.abs(credits - 2500) < 1e-6, `${credits}`);
    assert("the nested run is tagged as a child, the main session is not",
      mine.find(s => s.sessionId === "pig-sub").parentSession && !mine.find(s => s.sessionId === "pig-main").parentSession);
    assert("session count ignores subagent runs", scan.pigSessionCount >= 1 && mine.filter(s => !s.parentSession).length === 1);
    assert("LLM calls include the subagent's", mine.reduce((s, x) => s + x.llmCalls, 0) === 3);
    assert("PiG is not folded into Pi", scan.sessions.filter(s => s.source === "pi" && s.filePath.startsWith(tmp)).length === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

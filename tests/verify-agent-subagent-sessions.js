/**
 * verify-agent-subagent-sessions.js — subagent transcripts must be scanned.
 *
 * OMP writes each subagent's transcript to `<project>/<sessionId>/<Agent>.jsonl`
 * with its own `type: "session"` header carrying `parentSession`. The scanner
 * only read `<project>/*.jsonl`, so every subagent call — billed on its own and
 * absent from the parent file — was dropped from credits, tokens and the
 * non-billable table.
 *
 * A subagent transcript is usage, not a session the user opened: it must add to
 * calls and credits but not to the session count.
 *
 *   node tests/verify-agent-subagent-sessions.js
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

function call(provider, usd) {
  const now = new Date();
  const ts = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12, 0, 0) + 3600_000;
  return JSON.stringify({
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      model: "claude-opus-5",
      provider,
      usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { total: usd } },
    },
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-"));
  try {
    const proj = path.join(tmp, "sessions", "proj");
    const parentId = "parent-session";
    const parentFile = path.join(proj, `${parentId}.jsonl`);
    fs.mkdirSync(path.join(proj, parentId), { recursive: true });

    fs.writeFileSync(parentFile,
      [JSON.stringify({ type: "session", id: parentId, cwd: "/tmp/x" }), call("github-copilot", 1.0)].join("\n"));
    // Two subagents: one on a BYOK provider, one billed through Copilot.
    fs.writeFileSync(path.join(proj, parentId, "Explore.jsonl"),
      [JSON.stringify({ type: "session", id: "sub-1", cwd: "/tmp/x", parentSession: parentFile }),
        call("azure-claude", 2.0), call("azure-claude", 2.0)].join("\n"));
    fs.writeFileSync(path.join(proj, parentId, "Review.jsonl"),
      [JSON.stringify({ type: "session", id: "sub-2", cwd: "/tmp/x", parentSession: parentFile }),
        call("github-copilot", 4.0)].join("\n"));
    // Non-transcript files in the session directory are ignored.
    fs.writeFileSync(path.join(proj, parentId, "12.bash.log"), "not a session");

    process.env["PI_CODING_AGENT_DIR"] = tmp;
    const { scanAgentSessions } = require(path.join(OUT, "agentScanner.js"));
    const scan = await scanAgentSessions();
    const mine = scan.sessions.filter(s => s.source === "pi" && s.filePath.startsWith(tmp));
    const byId = new Map(mine.map(s => [s.sessionId, s]));

    assert("parent and both subagent transcripts are read", mine.length === 3, `${mine.length}`);
    assert("subagent keeps its own usage",
      byId.get("sub-1") && byId.get("sub-1").llmCalls === 2 && Math.abs(byId.get("sub-1").totalCostCredits - 400) < 1e-6,
      byId.get("sub-1") && `${byId.get("sub-1").llmCalls} calls, ${byId.get("sub-1").totalCostCredits} credits`);
    assert("subagent is linked to its parent",
      byId.get("sub-2") && byId.get("sub-2").parentSession === parentFile);
    assert("parent usage is not inflated by its subagents",
      byId.get(parentId) && byId.get(parentId).llmCalls === 1 && Math.abs(byId.get(parentId).totalCostCredits - 100) < 1e-6,
      byId.get(parentId) && `${byId.get(parentId).llmCalls} calls, ${byId.get(parentId).totalCostCredits} credits`);
    assert("session count ignores subagent transcripts", scan.piSessionCount === 1 && scan.piAllTimeSessions === 1,
      `${scan.piSessionCount} / ${scan.piAllTimeSessions}`);
    assert("LLM calls include the subagents' calls", scan.piAllTimeLlmCalls === 4, `${scan.piAllTimeLlmCalls}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });

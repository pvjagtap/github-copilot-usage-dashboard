// Why does the Non-billable panel list a model called `unknown`?
//
// The debug-log path is ruled out (diagnose-unknown-model-events.js finds zero
// llm_request events without attrs.model), so the fallback must be firing in
// dashboardData's per-turn branch: `t.modelFamily || "unknown"`. This runs the
// real scanner and reports exactly which turns have no resolvable model.
const path = require("path");
const Module = require("module");

const stub = path.join(__dirname, "_vscode-stub.js");
const orig = Module._resolveFilename;
Module._resolveFilename = function (q, p, ...a) { return q === "vscode" ? stub : orig.call(this, q, p, ...a); };

const { scanWorkspaceStorage } = require("../out/scanner");

(async () => {
  const scan = await scanWorkspaceStorage();
  console.log(`sessions=${scan.sessions.length}  turns=${scan.turns.length}`);

  const bad = scan.turns.filter(t => !t.modelFamily || t.modelFamily === "unknown");
  console.log(`\nturns with no modelFamily: ${bad.length}`);

  let inTok = 0, outTok = 0, cached = 0, nano = 0, withDebugReqs = 0, withDebugByModel = 0;
  const bySession = new Map();
  for (const t of bad) {
    inTok += t.debugPromptTokens || t.promptTokens || 0;
    outTok += t.debugOutputTokens || t.outputTokens || 0;
    cached += t.debugCachedTokens || 0;
    nano += t.debugAicCredits || 0;
    if (Array.isArray(t.debugRequests) && t.debugRequests.length) withDebugReqs++;
    if (t.debugByModel && Object.keys(t.debugByModel).length) withDebugByModel++;
    const k = t.sessionId;
    bySession.set(k, (bySession.get(k) || 0) + 1);
  }
  console.log(`  tokens in=${inTok} out=${outTok} cached=${cached}`);
  console.log(`  debugAicCredits (GitHub-billed) = ${nano.toFixed(4)}`);
  console.log(`  had per-request debugRequests   = ${withDebugReqs}`);
  console.log(`  had debugByModel                = ${withDebugByModel}`);

  console.log(`\nsessions involved:`);
  for (const [sid, n] of [...bySession].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const s = scan.sessions.find(x => x.sessionId === sid);
    console.log(`  ${sid}  turns=${n}  sessionModelFamily=${JSON.stringify(s && s.modelFamily)}  modelName=${JSON.stringify(s && s.modelName)}  project=${s && s.projectName}`);
  }

  console.log(`\nsample turns:`);
  for (const t of bad.slice(0, 5)) {
    console.log(`  ts=${t.timestamp} model=${JSON.stringify(t.modelFamily)} name=${JSON.stringify(t.modelName)} in=${t.debugPromptTokens || t.promptTokens} out=${t.debugOutputTokens || t.outputTokens} aic=${t.debugAicCredits}`);
  }
})();

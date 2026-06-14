// Quick check: does session 3d072173 contain llm_request entries with
// inputTokens=0 && outputTokens=0 but nanoAiu>0? My truth parser skips
// those (real API errors / cancelled requests), the scanner counts them.
//
// Also: tally the difference contributed by such entries across all
// sessions and see if it matches the ~1700 cr aggregate drift.

"use strict";
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");
const stubPath = path.join(ROOT, "tests", "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};
const { getWorkspaceStorageCandidates } = require(path.join(OUT, "scanner.js"));
const { AIC_EFFECTIVE_DATE } = require(path.join(OUT, "dashboardData.js"));

function discoverDebugLogDirs() {
  const dirs = [];
  const roots = ["D:/vscode/workspaceStorage", ...getWorkspaceStorageCandidates()].filter(p => { try { return fs.existsSync(p); } catch { return false; }});
  for (const wsRoot of roots) {
    let workspaces;
    try { workspaces = fs.readdirSync(wsRoot); } catch { continue; }
    for (const ws of workspaces) {
      const dl = path.join(wsRoot, ws, "GitHub.copilot-chat", "debug-logs");
      if (!fs.existsSync(dl)) continue;
      let sessions;
      try { sessions = fs.readdirSync(dl); } catch { continue; }
      for (const s of sessions) {
        const sd = path.join(dl, s);
        try { if (fs.statSync(sd).isDirectory() && fs.existsSync(path.join(sd, "main.jsonl"))) dirs.push(sd); } catch {}
      }
    }
  }
  return dirs;
}

function readSid(sd) {
  try {
    for (const line of fs.readFileSync(path.join(sd, "main.jsonl"), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.type === "session_start" && e.sid) return e.sid; } catch {}
    }
  } catch {}
  return path.basename(sd);
}

function tallyFile(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return { zeroIO: 0, zeroIONano: 0, withIO: 0, withIONano: 0 }; }
  let zeroIO = 0, zeroIONano = 0, withIO = 0, withIONano = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== "llm_request") continue;
    const a = e.attrs; if (!a) continue;
    const ts = typeof e.ts === "number" ? new Date(e.ts).toISOString() : "";
    if (ts.slice(0, 10) < AIC_EFFECTIVE_DATE) continue;
    const inp = typeof a.inputTokens === "number" ? a.inputTokens : 0;
    const out = typeof a.outputTokens === "number" ? a.outputTokens : 0;
    const nano = typeof a.copilotUsageNanoAiu === "number" ? a.copilotUsageNanoAiu : 0;
    if (inp === 0 && out === 0) { zeroIO++; zeroIONano += nano; }
    else { withIO++; withIONano += nano; }
  }
  return { zeroIO, zeroIONano, withIO, withIONano };
}

function tallySession(sd) {
  let zeroIO = 0, zeroIONano = 0, withIO = 0, withIONano = 0;
  let entries; try { entries = fs.readdirSync(sd); } catch { return { zeroIO, zeroIONano, withIO, withIONano }; }
  for (const e of entries) {
    if (!e.endsWith(".jsonl")) continue;
    const t = tallyFile(path.join(sd, e));
    zeroIO += t.zeroIO; zeroIONano += t.zeroIONano;
    withIO += t.withIO; withIONano += t.withIONano;
  }
  return { zeroIO, zeroIONano, withIO, withIONano };
}

(async () => {
  console.log("Checking llm_request entries with inputTokens=0 && outputTokens=0");
  console.log("─".repeat(80));

  // Specific target: session 3d072173
  console.log("\nSession 3d072173 (drift = +348.87):");
  let found = null;
  for (const sd of discoverDebugLogDirs()) {
    const sid = readSid(sd);
    if (sid.startsWith("3d072173")) { found = sd; break; }
  }
  if (found) {
    console.log(`  dir: ${found}`);
    const t = tallySession(found);
    console.log(`  llm_requests with inputTokens=0 && outputTokens=0 : ${t.zeroIO}  (Σ nanoAiu = ${(t.zeroIONano/1e9).toFixed(2)} cr)`);
    console.log(`  llm_requests with tokens                          : ${t.withIO}  (Σ nanoAiu = ${(t.withIONano/1e9).toFixed(2)} cr)`);
    console.log(`  scanner sum = ${((t.zeroIONano + t.withIONano)/1e9).toFixed(2)} cr (truth filter drops ${(t.zeroIONano/1e9).toFixed(2)})`);
  } else {
    console.log("  NOT FOUND");
  }

  // Aggregate across all sessions
  console.log("\nAggregate across all sessions:");
  let totalZeroIO = 0, totalZeroIONano = 0, totalWithIO = 0, totalWithIONano = 0;
  for (const sd of discoverDebugLogDirs()) {
    const t = tallySession(sd);
    totalZeroIO += t.zeroIO; totalZeroIONano += t.zeroIONano;
    totalWithIO += t.withIO; totalWithIONano += t.withIONano;
  }
  console.log(`  Total llm_requests with inputTokens=0 && outputTokens=0 : ${totalZeroIO.toLocaleString()}`);
  console.log(`  Total nanoAiu from those entries                        : ${(totalZeroIONano/1e9).toFixed(2)} cr`);
  console.log(`  Total llm_requests with tokens                          : ${totalWithIO.toLocaleString()}`);
  console.log(`  Total nanoAiu from those                                : ${(totalWithIONano/1e9).toFixed(2)} cr`);
  console.log(`\n  → If audit total VSCode drift ≈ ${(totalZeroIONano/1e9).toFixed(2)} cr, this is the cause.`);
})();

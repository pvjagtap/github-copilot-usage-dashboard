// Why does "By Subagent" render `unknown`?
//
// scanner.extractSubagentArgs reads `agentName` off the runSubagent tool call's
// arguments and falls back to "unknown". This dumps the real argument shapes so
// the fallback rate can be attributed to a cause rather than guessed at.
const fs = require("fs");
const path = require("path");

const root = path.join(process.env.APPDATA, "Code", "User", "workspaceStorage");

function replayRequests(file) {
  const requests = [];
  let ops;
  try {
    ops = fs.readFileSync(file, "utf-8").split("\n").filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return requests; }
  for (const o of ops) {
    if (o.kind === 2 && Array.isArray(o.k) && o.k.length === 1 && o.k[0] === "requests" && Array.isArray(o.v)) {
      requests.push(...o.v);
    } else if (o.kind === 1 && Array.isArray(o.k) && o.k.length === 3 && o.k[0] === "requests") {
      const i = o.k[1];
      if (typeof requests[i] !== "object" || requests[i] === null) requests[i] = {};
      requests[i][String(o.k[2])] = o.v;
    } else if (o.kind === 0 && o.v && Array.isArray(o.v.requests)) {
      requests.push(...o.v.requests);
    }
  }
  return requests;
}

const argKeys = new Map();
const nameCounts = new Map();
let total = 0, parsedOk = 0, hadAgentName = 0;
const samples = [];

for (const ws of fs.readdirSync(root)) {
  const dir = path.join(root, ws, "chatSessions");
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { continue; }
  for (const f of files) {
    for (const r of replayRequests(path.join(dir, f))) {
      const rounds = r && r.result && r.result.metadata && r.result.metadata.toolCallRounds;
      if (!Array.isArray(rounds)) continue;
      for (const rd of rounds) {
        if (!rd || !Array.isArray(rd.toolCalls)) continue;
        for (const tc of rd.toolCalls) {
          if (!tc || tc.name !== "runSubagent") continue;
          total++;
          let args = tc.arguments;
          if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
          if (args && typeof args === "object") {
            parsedOk++;
            for (const k of Object.keys(args)) argKeys.set(k, (argKeys.get(k) || 0) + 1);
            const n = typeof args.agentName === "string" ? args.agentName : "<absent>";
            if (n !== "<absent>") hadAgentName++;
            nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
            if (samples.length < 5) {
              samples.push(JSON.stringify(args).slice(0, 300));
            }
          } else {
            nameCounts.set("<unparseable>", (nameCounts.get("<unparseable>") || 0) + 1);
          }
        }
      }
    }
  }
}

console.log(`runSubagent tool calls found : ${total}`);
console.log(`arguments parsed as object   : ${parsedOk}`);
console.log(`carried an agentName field   : ${hadAgentName}`);
console.log(`\nargument keys seen:`);
for (const [k, v] of [...argKeys].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);
console.log(`\nresolved agent names:`);
for (const [k, v] of [...nameCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);
console.log(`\nsample argument blobs:`);
for (const s of samples) console.log(`  ${s}`);

// The debug logs name the agent independently — both in child_session_ref.name
// and in the child log filename. Count what is recoverable from there.
const logNames = new Map();
for (const ws of fs.readdirSync(root)) {
  const dir = path.join(root, ws, "GitHub.copilot-chat", "debug-logs");
  let sids = [];
  try { sids = fs.readdirSync(dir); } catch { continue; }
  for (const sid of sids) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, sid)); } catch { continue; }
    for (const f of files) {
      const m = /^runSubagent-(.+?)-call_/.exec(f) || /^runSubagent-(.+?)\.jsonl$/.exec(f);
      if (m) logNames.set(m[1], (logNames.get(m[1]) || 0) + 1);
    }
  }
}
console.log(`\nagent names recoverable from debug-log filenames:`);
for (const [k, v] of [...logNames].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(24)} ${v}`);

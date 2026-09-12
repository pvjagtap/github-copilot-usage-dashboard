// Dump the raw request records for the two sessions whose model never resolves,
// to find out whether any model signal exists that the scanner is not reading.
const fs = require("fs");
const path = require("path");

const root = path.join(process.env.APPDATA, "Code", "User", "workspaceStorage");
const TARGETS = new Set([
  "fffb2695-729d-48e5-9ed7-01568e74c19a",
  "444491ae-7f2b-4b3a-b78d-d7c6f3d4712d",
]);

function replay(file) {
  const requests = [];
  let root0 = null;
  const ops = fs.readFileSync(file, "utf-8").split("\n").filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (const o of ops) {
    if (o.kind === 0 && o.v && typeof o.v === "object") {
      root0 = o.v;
      if (Array.isArray(o.v.requests)) requests.push(...o.v.requests);
    } else if (o.kind === 2 && Array.isArray(o.k) && o.k.length === 1 && o.k[0] === "requests" && Array.isArray(o.v)) {
      requests.push(...o.v);
    } else if (o.kind === 1 && Array.isArray(o.k) && o.k.length === 3 && o.k[0] === "requests") {
      const i = o.k[1];
      if (typeof requests[i] !== "object" || requests[i] === null) requests[i] = {};
      requests[i][String(o.k[2])] = o.v;
    }
  }
  return { requests, root0 };
}

for (const ws of fs.readdirSync(root)) {
  const dir = path.join(root, ws, "chatSessions");
  let files = [];
  try { files = fs.readdirSync(dir); } catch { continue; }
  for (const f of files) {
    const sid = f.replace(/\.jsonl$/, "");
    if (!TARGETS.has(sid)) continue;

    const { requests, root0 } = replay(path.join(dir, f));
    console.log(`\n=== ${sid} (${requests.length} requests) ===`);
    console.log(`  inputState.selectedModel = ${JSON.stringify(root0 && root0.inputState && root0.inputState.selectedModel)}`);
    console.log(`  initialLocation          = ${JSON.stringify(root0 && root0.initialLocation)}`);
    console.log(`  isImported               = ${JSON.stringify(root0 && root0.isImported)}`);

    requests.forEach((r, i) => {
      if (!r || typeof r !== "object") return;
      const meta = r.result && r.result.metadata;
      console.log(`  [${i}] modelId=${JSON.stringify(r.modelId)}`
        + ` promptTokens=${r.promptTokens} completionTokens=${r.completionTokens} copilotCredits=${r.copilotCredits}`
        + ` agent=${JSON.stringify(r.agent && r.agent.id)}`);
      if (meta) {
        const keys = Object.keys(meta).filter(k => /model|family|vendor|request/i.test(k));
        if (keys.length) {
          console.log(`        result.metadata model-ish keys: ${keys.map(k => k + "=" + JSON.stringify(meta[k]).slice(0, 120)).join("  ")}`);
        }
      }
      const topKeys = Object.keys(r).filter(k => /model|family|vendor/i.test(k));
      if (topKeys.length) console.log(`        request model-ish keys: ${topKeys.join(", ")}`);
    });
  }
}

// Why does the Non-billable panel show a model called `unknown`?
//
// scanner.ts falls back to "unknown" when an llm_request carries no
// attrs.model, and classifyModelBillability then drops unrecognised ids into
// the informational bucket. This reports what those events actually are:
// which debugName emitted them, whether GitHub billed them (copilotUsageNanoAiu),
// and what else the event carries that could identify the model.
const fs = require("fs");
const path = require("path");

const root = path.join(process.env.APPDATA, "Code", "User", "workspaceStorage");

const byDebugName = new Map();
let total = 0, withNano = 0, withoutNano = 0;
let inTok = 0, outTok = 0, cachedTok = 0, nanoSum = 0;
const attrKeys = new Map();
const samples = [];

for (const ws of fs.readdirSync(root)) {
  const dir = path.join(root, ws, "GitHub.copilot-chat", "debug-logs");
  let sids = [];
  try { sids = fs.readdirSync(dir); } catch { continue; }
  for (const sid of sids) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, sid)); } catch { continue; }
    for (const f of files.filter(x => x.endsWith(".jsonl"))) {
      let lines;
      try { lines = fs.readFileSync(path.join(dir, sid, f), "utf-8").split("\n"); } catch { continue; }
      for (const line of lines) {
        if (!line.trim() || line.indexOf('"llm_request"') === -1) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!e || e.type !== "llm_request") continue;
        const a = e.attrs || {};
        if (typeof a.model === "string" && a.model) continue;

        total++;
        const dn = a.debugName || "<no debugName>";
        const slot = byDebugName.get(dn) || { n: 0, nano: 0, in: 0, out: 0, file: f };
        slot.n++;
        slot.nano += a.copilotUsageNanoAiu || 0;
        slot.in += a.inputTokens || 0;
        slot.out += a.outputTokens || 0;
        byDebugName.set(dn, slot);

        if (a.copilotUsageNanoAiu) { withNano++; nanoSum += a.copilotUsageNanoAiu; } else { withoutNano++; }
        inTok += a.inputTokens || 0;
        outTok += a.outputTokens || 0;
        cachedTok += a.cachedTokens || 0;
        for (const k of Object.keys(a)) attrKeys.set(k, (attrKeys.get(k) || 0) + 1);
        if (samples.length < 4) samples.push({ file: f, attrs: a });
      }
    }
  }
}

console.log(`llm_request events with NO attrs.model : ${total}`);
console.log(`  carried copilotUsageNanoAiu          : ${withNano}  (= ${(nanoSum / 1e9).toFixed(2)} credits)`);
console.log(`  carried NO nanoAiu (rate-estimated)  : ${withoutNano}`);
console.log(`  tokens  in=${inTok}  out=${outTok}  cached=${cachedTok}`);

console.log(`\nby debugName:`);
for (const [k, v] of [...byDebugName].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(k).padEnd(42)} n=${String(v.n).padEnd(5)} nanoAiu=${(v.nano / 1e9).toFixed(2).padStart(9)} in=${v.in} out=${v.out}`);
}

console.log(`\nattr keys present on these events:`);
for (const [k, v] of [...attrKeys].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${v}`);

console.log(`\nsample events:`);
for (const s of samples) console.log(`  [${s.file}] ${JSON.stringify(s.attrs).slice(0, 400)}`);

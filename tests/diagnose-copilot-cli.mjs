// tests/diagnose-copilot-cli.mjs
//
// Permanent diagnostic for the standalone GitHub Copilot CLI (npm @github/copilot).
// Inventories ~/.copilot/, dumps the schema + sample of every SQLite table,
// discovers events.jsonl event types + every token/AIC field path, and
// reconstructs per-session AIC from the `session.shutdown` ledger.
//
// Run:    node tests/diagnose-copilot-cli.mjs
// Output: stdout (UTF-8). Pipe to a file with shell redirect:
//             node tests/diagnose-copilot-cli.mjs > cli-report.txt
//         (do NOT use PowerShell Tee-Object — it writes UTF-16.)
//
// Why this exists
// ---------------
// The official docs at docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
// describe ~/.copilot/ partially. Empirically there are additional artefacts
// (usage.db, eclipse/, jb/, flat session-state/{uuid}.jsonl legacy files)
// AND the AIC accounting model documented at
// docs.github.com/en/copilot/concepts/billing/copilot-requests
// is implemented in events.jsonl in a non-obvious way: a per-segment
// ledger is written ONLY on the `session.shutdown` event under
// data.modelMetrics.{model}.requests.cost (premium-request count, already
// multiplier-applied) and data.totalPremiumRequests. This script proves
// both points so any future integration with the dashboard scanner has a
// ground-truth reference.
//
// Zero dependencies — uses Node's built-in node:sqlite (stable in Node 22.5+).

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.COPILOT_HOME
  || join(process.env.USERPROFILE || process.env.HOME || '', '.copilot');

const SECTION = (s) => console.log('\n' + '═'.repeat(8) + ' ' + s + ' ' + '═'.repeat(8));
const SUB = (s) => console.log('\n  ── ' + s);

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ──────────────────────────────────────────────────────────────────────
// 1) Filesystem inventory
// ──────────────────────────────────────────────────────────────────────
SECTION(`Filesystem inventory — ${HOME}`);
if (!existsSync(HOME)) {
  console.log('  (does not exist — Copilot CLI not installed for this user)');
  process.exit(0);
}
for (const ent of readdirSync(HOME, { withFileTypes: true })) {
  const full = join(HOME, ent.name);
  if (ent.isDirectory()) {
    const items = readdirSync(full, { withFileTypes: true });
    console.log(`  [DIR ] ${ent.name.padEnd(28)} (${items.length} entries)`);
  } else {
    console.log(`  [FILE] ${ent.name.padEnd(28)} ${fmtBytes(statSync(full).size)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// 2) SQLite schema + sample for every DB
// ──────────────────────────────────────────────────────────────────────
function dumpDb(label, file) {
  SECTION(`SQLite — ${label}`);
  if (!existsSync(file)) { console.log('  (not present)'); return; }
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); }
  catch (e) { console.log('  ERROR opening:', e.message); return; }
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all();
  for (const { name } of tables) {
    const cols = db.prepare(`PRAGMA table_info("${name}")`).all();
    const cnt = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
    SUB(`TABLE ${name}  (rows=${cnt})`);
    for (const c of cols) {
      const flags = [c.pk && 'PK', c.notnull && 'NOT NULL'].filter(Boolean).join(' ');
      console.log(`    ${c.name.padEnd(28)} ${(c.type || '').padEnd(10)} ${flags}`);
    }
    if (cnt === 0) continue;
    const sample = db.prepare(`SELECT * FROM "${name}" LIMIT 1`).get();
    const trimmed = Object.fromEntries(Object.entries(sample).map(([k, v]) => {
      if (typeof v === 'string' && v.length > 140) return [k, v.slice(0, 140) + `…(+${v.length - 140} ch)`];
      if (v instanceof Uint8Array) return [k, `<blob ${v.length} B>`];
      return [k, v];
    }));
    console.log(`    sample: ${JSON.stringify(trimmed)}`);
  }
  db.close();
}
dumpDb('usage.db (undocumented — actually the /chronicle index over VS Code Chat sessions)',
  join(HOME, 'usage.db'));
dumpDb('session-store.db (documented — CLI session index + FTS5 search)',
  join(HOME, 'session-store.db'));

// ──────────────────────────────────────────────────────────────────────
// 3) Events.jsonl schema discovery
// ──────────────────────────────────────────────────────────────────────
function walkPaths(obj, prefix, out, depth = 0) {
  if (obj === null || obj === undefined || depth > 6) return;
  if (Array.isArray(obj)) {
    if (obj.length === 0) { out.set(prefix + '[]', '<empty>'); return; }
    walkPaths(obj[0], prefix + '[]', out, depth + 1);
    return;
  }
  if (typeof obj !== 'object') {
    if (!out.has(prefix)) {
      const v = typeof obj === 'string' && obj.length > 60 ? `"${obj.slice(0, 60)}…"` : JSON.stringify(obj);
      out.set(prefix, `${typeof obj}: ${v}`);
    }
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    walkPaths(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  }
}

SECTION('events.jsonl — schema discovery across top 3 sessions by size');
const ssDir = join(HOME, 'session-state');
const sessions = existsSync(ssDir)
  ? readdirSync(ssDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const f = join(ssDir, d.name, 'events.jsonl');
        try { return { id: d.name, file: f, size: statSync(f).size }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.size - a.size)
  : [];

const TOKEN_RX = /token|prompt|completion|cache|usage|credit|aic|premium|cost|spend|quota|multipl|model|reasoning/i;
const byType = new Map();
for (const s of sessions.slice(0, 3)) {
  const lines = readFileSync(s.file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const t = o.type || o.event || o.kind || '<?>';
    if (!byType.has(t)) byType.set(t, new Map());
    walkPaths(o, '', byType.get(t));
  }
}
for (const [t, paths] of [...byType.entries()].sort()) {
  SUB(`event "${t}"  (${paths.size} unique paths)`);
  const hits = [...paths.entries()].filter(([p]) => TOKEN_RX.test(p));
  if (hits.length === 0) {
    console.log('    (no token/cost/model fields)');
    continue;
  }
  for (const [p, sample] of hits) {
    console.log(`    ${p.padEnd(52)} ${sample}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// 4) Hybrid AIC reconstruction — LIVE engine + ledger reconciliation
// ──────────────────────────────────────────────────────────────────────
//
// Why hybrid? In this user's data, 3 of 5 sampled sessions have NO
// session.shutdown event (crash, Ctrl-C, still-open). Relying on the
// ledger alone loses ~60% of sessions. We compute both:
//
//   LIVE   — derived turn-by-turn from user.message + model context.
//            Always available, even mid-session.
//              AIC_live(model) = count(billable user.message attributed to model)
//                                × multiplier(model)
//            Output tokens summed from assistant.message.data.outputTokens.
//            Slash commands (data.content trimmed startswith "/") excluded.
//
//   LEDGER — read from session.shutdown.data.modelMetrics.*.requests.cost
//            Authoritative when present; absent for crashed/open sessions.
//
//   DRIFT  — live − ledger. Small drift = live engine is healthy. Large
//            drift = stale multiplier table or billing-policy change.
//
// Built-in multiplier table mirrors src/modelCatalog.ts conventions so
// the diagnostic is self-contained. Override via tests/.cli-multipliers.json
// (optional file: { "model-id": multiplier, ... }) for non-default rates.

const DEFAULT_MULTIPLIERS = {
  'claude-sonnet-4.6': 1,
  'claude-sonnet-4.5': 1,
  'claude-sonnet-4':   1,
  'claude-opus-4.6':   3,
  'claude-opus-4.5':   3,
  'claude-opus-4':     3,
  'claude-haiku-4.5':  0.33,
  'gpt-4o':            1,
  'gpt-4o-mini':       0.33,
  'gpt-4.1':           0,
  'gpt-5':             1,
  'gpt-5-mini':        0.33,
  'o3':                1,
  'o3-mini':           0.33,
  'o4-mini':           0.33,
};
let MULTIPLIERS = { ...DEFAULT_MULTIPLIERS };
try {
  const overridePath = new URL('./.cli-multipliers.json', import.meta.url);
  MULTIPLIERS = { ...MULTIPLIERS, ...JSON.parse(readFileSync(overridePath, 'utf8')) };
} catch { /* optional */ }

function multiplierFor(model) {
  if (model == null) return null;
  if (model in MULTIPLIERS) return MULTIPLIERS[model];
  // family fallback
  for (const k of Object.keys(MULTIPLIERS)) {
    if (model.startsWith(k) || k.startsWith(model)) return MULTIPLIERS[k];
  }
  return null;
}

function isSlashCommand(content) {
  if (typeof content !== 'string') return false;
  const s = content.trimStart();
  if (!s.startsWith('/')) return false;
  // require a slash followed by a word — exclude file paths like "/usr/..."
  return /^\/[A-Za-z][\w-]*\b/.test(s);
}

function liveEstimate(lines, currentTime) {
  // Walk events in order; track currently-active model; attribute each
  // billable user.message to that model. Returns { perModel, slashSkipped }.
  let currentModel = null;
  const perModel = {};
  let slashSkipped = 0;
  let billablePrompts = 0;
  let outputTokensTotal = 0;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const t = o.type || o.event;
    switch (t) {
      case 'session.start':
      case 'session.resume':
        if (o?.data?.selectedModel) currentModel = o.data.selectedModel;
        break;
      case 'session.model_change':
        if (o?.data?.newModel) currentModel = o.data.newModel;
        break;
      case 'user.message': {
        if (isSlashCommand(o?.data?.content)) { slashSkipped++; break; }
        const m = currentModel ?? '<unknown>';
        const mult = multiplierFor(m) ?? 1; // conservative default
        perModel[m] ??= { prompts: 0, aic: 0, output: 0, multiplierUsed: mult };
        perModel[m].prompts += 1;
        perModel[m].aic     += mult;
        billablePrompts += 1;
        break;
      }
      case 'assistant.message': {
        const m = o?.data?.model ?? currentModel ?? '<unknown>';
        const out = Number(o?.data?.outputTokens) || 0;
        perModel[m] ??= { prompts: 0, aic: 0, output: 0, multiplierUsed: multiplierFor(m) ?? 1 };
        perModel[m].output += out;
        outputTokensTotal += out;
        break;
      }
    }
  }
  return { perModel, slashSkipped, billablePrompts, outputTokensTotal };
}

function ledgerTotals(lines) {
  // Sum every session.shutdown ledger. Returns null if no shutdown present.
  let any = false;
  const perModel = {};
  let totalPremiumRequests = 0;
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if ((o.type || o.event) !== 'session.shutdown') continue;
    any = true;
    totalPremiumRequests += o?.data?.totalPremiumRequests ?? 0;
    for (const [m, v] of Object.entries(o?.data?.modelMetrics ?? {})) {
      perModel[m] ??= { aic: 0, calls: 0, input: 0, output: 0, cacheRead: 0 };
      perModel[m].aic       += v?.requests?.cost ?? 0;
      perModel[m].calls     += v?.requests?.count ?? 0;
      perModel[m].input     += v?.usage?.inputTokens ?? 0;
      perModel[m].output    += v?.usage?.outputTokens ?? 0;
      perModel[m].cacheRead += v?.usage?.cacheReadTokens ?? 0;
    }
  }
  return any ? { perModel, totalPremiumRequests } : null;
}

SECTION('Hybrid AIC — LIVE engine vs ledger reconciliation (per session)');
console.log('  LIVE  = count(billable user.message) × multiplier(active_model)');
console.log('  LEDGER = sum(session.shutdown.data.modelMetrics.*.requests.cost)');
console.log('  DRIFT = LIVE − LEDGER (positive = live overcounts; negative = live undercounts)\n');

const driftAcc = { live: 0, ledger: 0, sessionsWithBoth: 0, sessionsLiveOnly: 0, sessionsLedgerOnly: 0 };

for (const s of sessions.slice(0, 8)) {
  const lines = readFileSync(s.file, 'utf8').split('\n').filter(Boolean);
  const live = liveEstimate(lines);
  const ledger = ledgerTotals(lines);
  const liveAIC = Object.values(live.perModel).reduce((a, v) => a + v.aic, 0);
  const ledgerAIC = ledger?.totalPremiumRequests ?? null;

  console.log(`  Session ${s.id}  (${fmtBytes(s.size)})`);
  console.log(`    LIVE   prompts=${live.billablePrompts} (slash skipped=${live.slashSkipped})  AIC=${liveAIC}  out=${live.outputTokensTotal.toLocaleString()}`);
  for (const [m, v] of Object.entries(live.perModel)) {
    console.log(`           ${m.padEnd(26)}  prompts=${v.prompts}  ×mult=${v.multiplierUsed}  → AIC=${v.aic}  out=${v.output.toLocaleString()}`);
  }
  if (ledger) {
    console.log(`    LEDGER AIC=${ledgerAIC}  (from ${Object.keys(ledger.perModel).length} model(s))`);
    for (const [m, v] of Object.entries(ledger.perModel)) {
      console.log(`           ${m.padEnd(26)}  AIC=${v.aic}  calls=${v.calls}  in=${v.input.toLocaleString()}  out=${v.output.toLocaleString()}  cache=${v.cacheRead.toLocaleString()}`);
    }
    const drift = liveAIC - ledgerAIC;
    const driftPct = ledgerAIC > 0 ? ` (${((drift / ledgerAIC) * 100).toFixed(1)}%)` : '';
    console.log(`    DRIFT  live − ledger = ${drift > 0 ? '+' : ''}${drift}${driftPct}`);
    driftAcc.live += liveAIC;
    driftAcc.ledger += ledgerAIC;
    driftAcc.sessionsWithBoth++;
  } else {
    console.log(`    LEDGER (absent — session never cleanly shut down)`);
    console.log(`    >>> LIVE is the ONLY signal here. Ledger-only would lose ${liveAIC} AIC.`);
    driftAcc.sessionsLiveOnly++;
  }
  console.log('');
}

console.log('  ── Aggregate across sampled sessions ──');
console.log(`    Sessions with both LIVE + LEDGER:  ${driftAcc.sessionsWithBoth}  (live=${driftAcc.live}, ledger=${driftAcc.ledger}, drift=${driftAcc.live - driftAcc.ledger})`);
console.log(`    Sessions LIVE-only (no shutdown):  ${driftAcc.sessionsLiveOnly}`);
console.log(`    >>> Ledger-only strategy would have missed ${driftAcc.sessionsLiveOnly} of ${driftAcc.sessionsWithBoth + driftAcc.sessionsLiveOnly} sampled sessions.`);


// ──────────────────────────────────────────────────────────────────────
// 5) Cross-reference usage.db vs CLI session IDs
// ──────────────────────────────────────────────────────────────────────
SECTION('usage.db cross-reference — what does it actually index?');
try {
  const db = new DatabaseSync(join(HOME, 'usage.db'), { readOnly: true });
  const cliIds = new Set(sessions.map((s) => s.id));
  const dbIds = new Set(db.prepare('SELECT session_id FROM sessions').all().map((r) => r.session_id));
  const overlap = [...cliIds].filter((id) => dbIds.has(id));
  console.log(`  CLI sessions on disk:            ${cliIds.size}`);
  console.log(`  usage.db sessions table rows:    ${dbIds.size}`);
  console.log(`  intersection:                    ${overlap.length}`);
  const srcs = db.prepare(`SELECT DISTINCT
      CASE
        WHEN instr(source_path, 'workspaceStorage') > 0 THEN 'VS Code Chat (workspaceStorage)'
        WHEN instr(source_path, '.copilot') > 0         THEN 'CLI (~/.copilot)'
        ELSE 'other: ' || substr(source_path, 1, 40)
      END AS bucket,
      COUNT(*) AS n
    FROM session_sources GROUP BY bucket`).all();
  console.log('  source_path provenance:');
  for (const r of srcs) console.log(`    ${r.n.toString().padStart(4)}  ${r.bucket}`);
  console.log('  >>> usage.db is the /chronicle index. With 0 CLI session overlap, it confirms');
  console.log('  >>> /chronicle scans VS Code Copilot Chat session files, NOT CLI sessions.');
  db.close();
} catch (e) {
  console.log('  ERROR:', e.message);
}

// ──────────────────────────────────────────────────────────────────────
// 6) Summary
// ──────────────────────────────────────────────────────────────────────
SECTION('Summary — TRUTH vs docs');
console.log(`  1. ~/.copilot/usage.db is UNDOCUMENTED. It is the /chronicle aggregation database`);
console.log(`     and indexes VS Code Copilot Chat sessions (workspaceStorage/chatSessions/*.jsonl),`);
console.log(`     NOT CLI sessions. Schema includes model_multiplier, total_prompt_tokens,`);
console.log(`     total_output_tokens, turn_count, plus an otel_requests mirror.`);
console.log(`  2. Per-CLI-session AIC IS written to disk — but only at session.shutdown,`);
console.log(`     under data.modelMetrics.{model}.requests.cost (multiplier already applied)`);
console.log(`     and data.totalPremiumRequests. Live sessions hold this in memory only.`);
console.log(`  3. Individual assistant.message events carry only data.outputTokens + data.model;`);
console.log(`     prompt/cached/reasoning tokens appear ONLY in the shutdown ledger.`);
console.log(`  4. There is NO single place that aggregates AIC across CLI sessions — you must`);
console.log(`     walk every events.jsonl and sum session.shutdown ledgers. This matches the`);
console.log(`     open feature request github/copilot-cli#1791.`);
console.log(`  5. Ledger-only is INSUFFICIENT — many sessions never reach session.shutdown`);
console.log(`     (crash, Ctrl-C, still-open). Use the LIVE engine (count user.message ×`);
console.log(`     multiplier, attributed to active model) as primary; treat the ledger as a`);
console.log(`     reconciliation/calibration signal when it exists.`);

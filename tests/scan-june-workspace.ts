/**
 * scan-june-workspace.ts — Cross-validation of AIC credit calculations since June 1, 2026.
 *
 * Run: npx tsx tests/scan-june-workspace.ts
 *
 * This script:
 * 1. Discovers ALL debug-log session directories across workspace storage
 * 2. For each session since June 1, extracts every llm_request entry
 * 3. Reports: nanoAiu coverage, cachedTokens availability, credit path usage
 * 4. Compares extension display vs API ground truth (copilotUsageNanoAiu)
 *
 * Source of truth:
 *   - GitHub docs: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 *   - Claude Opus 4.6: Input=500, Cached=50, CacheWrite=625, Output=2500 credits/1M tokens
 *   - 1 AI credit = $0.01 USD
 */

import * as fs from "fs";
import * as path from "path";
import { getWorkspaceStorageCandidates } from "../src/scanner";

// ─── Configuration ────────────────────────────────────────────

const WORKSPACE_STORAGE_ROOTS = (() => {
  const candidates = [
    // Test-specific override kept for backwards compatibility.
    "D:/vscode/workspaceStorage",
    // Cross-platform auto-detected candidates (Linux / macOS / Windows / dev container / Insiders / portable).
    ...getWorkspaceStorageCandidates(),
  ].filter(p => fs.existsSync(p));
  // Deduplicate roots that resolve to the same physical path (e.g. junctions/symlinks)
  const seen = new Set<string>();
  return candidates.filter(p => {
    try {
      const real = fs.realpathSync(p);
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    } catch { return true; }
  });
})();

const AIC_EFFECTIVE_DATE = "2026-06-01";

// Official GitHub rates (per 1M tokens → credits)
const MODEL_RATES: Record<string, { input: number; output: number; cached: number; cacheWrite: number }> = {
  "claude-opus-4": { input: 500, output: 2500, cached: 50, cacheWrite: 625 },
  "claude-sonnet-4": { input: 300, output: 1500, cached: 30, cacheWrite: 375 },
  "claude-haiku-4": { input: 100, output: 500, cached: 10, cacheWrite: 125 },
  "gpt-5.4": { input: 250, output: 1500, cached: 25, cacheWrite: 0 },
  "gpt-4.1": { input: 200, output: 800, cached: 50, cacheWrite: 0 },
  "gpt-5-mini": { input: 25, output: 200, cached: 2.5, cacheWrite: 0 },
  "gpt-4o-mini": { input: 15, output: 60, cached: 7.5, cacheWrite: 0 },
  "gpt-4o": { input: 250, output: 1000, cached: 125, cacheWrite: 0 },
  "gemini-2.5-pro": { input: 125, output: 1000, cached: 12.5, cacheWrite: 0 },
};

function getRates(model: string) {
  const lower = model.toLowerCase();
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (lower.includes(key)) return rates;
  }
  return { input: 200, output: 800, cached: 50, cacheWrite: 0 }; // default to GPT-4.1
}

// ─── Types ────────────────────────────────────────────────────

interface LlmCall {
  sessionId: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  nanoAiu: number;
  hasNanoAiu: boolean;
  hasCachedTokens: boolean;
}

interface SessionSummary {
  sessionId: string;
  sessionDir: string;
  firstTimestamp: string;
  lastTimestamp: string;
  model: string;
  llmCalls: number;
  totalInput: number;
  totalOutput: number;
  totalCached: number;
  totalNanoAiu: number;
  callsWithNanoAiu: number;
  callsWithCached: number;
  creditsRateBased: number;  // Rate-based computation (no cached discount)
  creditsWithCached: number; // Rate-based with proper cached tokens
  creditsNanoAiu: number;    // From API nanoAiu (ground truth)
  creditsExtension: number;  // What the extension actually displays (prefers nanoAiu)
}

// ─── Discovery ────────────────────────────────────────────────

function discoverDebugLogDirs(): string[] {
  const dirs: string[] = [];

  for (const wsRoot of WORKSPACE_STORAGE_ROOTS) {
    if (!fs.existsSync(wsRoot)) continue;
    const workspaces = fs.readdirSync(wsRoot);

    for (const ws of workspaces) {
      const debugLogsDir = path.join(wsRoot, ws, "GitHub.copilot-chat", "debug-logs");
      if (!fs.existsSync(debugLogsDir)) continue;

      try {
        const sessions = fs.readdirSync(debugLogsDir);
        for (const sess of sessions) {
          const sessDir = path.join(debugLogsDir, sess);
          const mainJsonl = path.join(sessDir, "main.jsonl");
          if (fs.statSync(sessDir).isDirectory() && fs.existsSync(mainJsonl)) {
            dirs.push(sessDir);
          }
        }
      } catch { /* permission errors etc */ }
    }
  }

  return dirs;
}

// ─── Parsing ──────────────────────────────────────────────────

function parseSessionDir(sessDir: string): LlmCall[] {
  const calls: LlmCall[] = [];
  const sessionId = path.basename(sessDir);

  // Parse main.jsonl
  const mainFile = path.join(sessDir, "main.jsonl");
  if (fs.existsSync(mainFile)) {
    calls.push(...parseJsonl(mainFile, sessionId));
  }

  // Parse child sessions (subagents)
  try {
    const entries = fs.readdirSync(sessDir);
    for (const entry of entries) {
      if (entry === "main.jsonl") continue;
      const full = path.join(sessDir, entry);
      if (fs.statSync(full).isDirectory()) {
        const childMain = path.join(full, "main.jsonl");
        if (fs.existsSync(childMain)) {
          calls.push(...parseJsonl(childMain, sessionId));
        }
      }
    }
  } catch {}

  return calls;
}

function parseJsonl(filePath: string, sessionId: string): LlmCall[] {
  const calls: LlmCall[] = [];
  let content: string;
  try { content = fs.readFileSync(filePath, "utf-8"); } catch { return []; }

  const lines = content.split("\n").filter(l => l.trim());
  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "llm_request") continue;

    const attrs = entry.attrs;
    if (!attrs || typeof attrs !== "object") continue;

    const inp = typeof attrs.inputTokens === "number" ? attrs.inputTokens : 0;
    const out = typeof attrs.outputTokens === "number" ? attrs.outputTokens : 0;
    const cached = typeof attrs.cachedTokens === "number" ? attrs.cachedTokens : 0;
    const nanoAiu = typeof attrs.copilotUsageNanoAiu === "number" ? attrs.copilotUsageNanoAiu : 0;
    const ts = typeof entry.ts === "number" ? new Date(entry.ts).toISOString() : "";

    if (inp === 0 && out === 0) continue; // skip empty calls

    calls.push({
      sessionId,
      timestamp: ts,
      model: attrs.model || "unknown",
      inputTokens: inp,
      outputTokens: out,
      cachedTokens: cached,
      nanoAiu,
      hasNanoAiu: nanoAiu > 0,
      hasCachedTokens: cached > 0,
    });
  }

  return calls;
}

// ─── Credit Calculations ──────────────────────────────────────

function computeCreditsCorrect(model: string, input: number, output: number, cached: number): number {
  const rates = getRates(model);
  const netInput = Math.max(0, input - cached);
  return (netInput / 1_000_000) * rates.input
       + (output / 1_000_000) * rates.output
       + (cached / 1_000_000) * rates.cached;
}

function computeCreditsNoCached(model: string, input: number, output: number): number {
  // Rate-based computation without cached discount (fallback path)
  return computeCreditsCorrect(model, input, output, 0);
}

// ─── Main ─────────────────────────────────────────────────────

console.log("\n═══ Full Workspace Scan — June 1+ Debug-Logs ═══\n");
console.log(`Workspace storage roots: ${WORKSPACE_STORAGE_ROOTS.join(", ")}`);

const sessionDirs = discoverDebugLogDirs();
console.log(`Total debug-log session directories found: ${sessionDirs.length}`);

// Parse all sessions and filter to June 1+
const allSessions: SessionSummary[] = [];
let totalCallsScanned = 0;

for (const sessDir of sessionDirs) {
  const calls = parseSessionDir(sessDir);
  if (calls.length === 0) continue;
  totalCallsScanned += calls.length;

  // Check if session has any calls on/after June 1
  const juneCalls = calls.filter(c => c.timestamp && c.timestamp.slice(0, 10) >= AIC_EFFECTIVE_DATE);
  if (juneCalls.length === 0) continue;

  // Build summary
  const sessionId = path.basename(sessDir);
  const timestamps = juneCalls.filter(c => c.timestamp).map(c => c.timestamp).sort();
  const model = juneCalls[0].model;

  let creditsRateBased = 0;
  let creditsWithCached = 0;
  let creditsNanoAiu = 0;
  let creditsExtension = 0;

  for (const c of juneCalls) {
    const rateBased = computeCreditsNoCached(c.model, c.inputTokens, c.outputTokens);
    const withCached = computeCreditsCorrect(c.model, c.inputTokens, c.outputTokens, c.cachedTokens);
    const apiCredit = c.nanoAiu / 1_000_000_000;

    creditsRateBased += rateBased;
    creditsWithCached += withCached;
    creditsNanoAiu += apiCredit;

    // What the extension actually does:
    // - prefers debugAicCredits (nanoAiu) when available
    // - falls back to rate-based (cached=0) otherwise
    if (c.hasNanoAiu) {
      creditsExtension += apiCredit;
    } else {
      creditsExtension += rateBased;
    }
  }

  allSessions.push({
    sessionId,
    sessionDir: sessDir,
    firstTimestamp: timestamps[0] || "",
    lastTimestamp: timestamps[timestamps.length - 1] || "",
    model,
    llmCalls: juneCalls.length,
    totalInput: juneCalls.reduce((s, c) => s + c.inputTokens, 0),
    totalOutput: juneCalls.reduce((s, c) => s + c.outputTokens, 0),
    totalCached: juneCalls.reduce((s, c) => s + c.cachedTokens, 0),
    totalNanoAiu: juneCalls.reduce((s, c) => s + c.nanoAiu, 0),
    callsWithNanoAiu: juneCalls.filter(c => c.hasNanoAiu).length,
    callsWithCached: juneCalls.filter(c => c.hasCachedTokens).length,
    creditsRateBased,
    creditsWithCached,
    creditsNanoAiu,
    creditsExtension,
  });
}

// Sort by most recent first
allSessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));

console.log(`\nSessions since June 1, 2026: ${allSessions.length}`);
console.log(`Total LLM calls scanned: ${totalCallsScanned.toLocaleString()}`);
console.log("");

// ─── Report: nanoAiu Coverage ─────────────────────────────────

console.log("═══ nanoAiu Coverage Analysis ═══\n");

const totalCalls = allSessions.reduce((s, sess) => s + sess.llmCalls, 0);
const callsWithAiu = allSessions.reduce((s, sess) => s + sess.callsWithNanoAiu, 0);
const callsWithCached = allSessions.reduce((s, sess) => s + sess.callsWithCached, 0);
const sessionsWithFullAiu = allSessions.filter(s => s.callsWithNanoAiu === s.llmCalls);
const sessionsWithPartialAiu = allSessions.filter(s => s.callsWithNanoAiu > 0 && s.callsWithNanoAiu < s.llmCalls);
const sessionsWithNoAiu = allSessions.filter(s => s.callsWithNanoAiu === 0);

console.log(`Total LLM calls (June 1+): ${totalCalls.toLocaleString()}`);
console.log(`  With nanoAiu:     ${callsWithAiu.toLocaleString()} (${(callsWithAiu / totalCalls * 100).toFixed(1)}%)`);
console.log(`  Without nanoAiu:  ${(totalCalls - callsWithAiu).toLocaleString()} (${((totalCalls - callsWithAiu) / totalCalls * 100).toFixed(1)}%)`);
console.log(`  With cachedTokens: ${callsWithCached.toLocaleString()} (${(callsWithCached / totalCalls * 100).toFixed(1)}%)`);
console.log("");
console.log(`Sessions: ${allSessions.length}`);
console.log(`  Full nanoAiu coverage:    ${sessionsWithFullAiu.length}`);
console.log(`  Partial nanoAiu:          ${sessionsWithPartialAiu.length}`);
console.log(`  No nanoAiu (fallback):    ${sessionsWithNoAiu.length}`);
console.log("");

// ─── Report: Credit Comparison ────────────────────────────────

console.log("═══ Credit Comparison (All June 1+ Sessions) ═══\n");

const grandRateBased = allSessions.reduce((s, sess) => s + sess.creditsRateBased, 0);
const grandWithCached = allSessions.reduce((s, sess) => s + sess.creditsWithCached, 0);
const grandNanoAiu = allSessions.reduce((s, sess) => s + sess.creditsNanoAiu, 0);
const grandExtension = allSessions.reduce((s, sess) => s + sess.creditsExtension, 0);

console.log("  Method                     | Credits      | USD");
console.log("  " + "─".repeat(60));
console.log(`  Rate-based (no cache disc) | ${grandRateBased.toFixed(2).padStart(12)} | $${(grandRateBased * 0.01).toFixed(2)}`);
console.log(`  Rate-based (with cached)   | ${grandWithCached.toFixed(2).padStart(12)} | $${(grandWithCached * 0.01).toFixed(2)}`);
console.log(`  API nanoAiu (ground truth)  | ${grandNanoAiu.toFixed(2).padStart(12)} | $${(grandNanoAiu * 0.01).toFixed(2)}`);
console.log(`  Extension actual display   | ${grandExtension.toFixed(2).padStart(12)} | $${(grandExtension * 0.01).toFixed(2)}`);
console.log("");

const extensionVsApi = grandExtension - grandNanoAiu;
const extensionVsApiPct = grandNanoAiu > 0 ? (extensionVsApi / grandNanoAiu * 100) : 0;
console.log(`  Extension vs API diff:     ${extensionVsApi > 0 ? "+" : ""}${extensionVsApi.toFixed(2)} credits (${extensionVsApiPct > 0 ? "+" : ""}${extensionVsApiPct.toFixed(1)}%)`);

if (Math.abs(extensionVsApiPct) < 5) {
  console.log(`  ✓ Extension display is within 5% of API ground truth`);
} else {
  console.log(`  ⚠ Extension differs from API by ${extensionVsApiPct.toFixed(1)}%`);
}

// ─── Report: Per-Session Details ──────────────────────────────

console.log("\n═══ Per-Session Breakdown (June 1+) ═══\n");
console.log("Session          | Calls | NanoAiu? | Model              | Extension | API       | Δ%");
console.log("─".repeat(100));

for (const s of allSessions.slice(0, 30)) {
  const aiuStatus = s.callsWithNanoAiu === s.llmCalls ? "✓ ALL" :
                    s.callsWithNanoAiu > 0 ? `PARTIAL(${s.callsWithNanoAiu}/${s.llmCalls})` :
                    "✗ NONE";
  const modelShort = s.model.length > 18 ? s.model.slice(0, 18) : s.model.padEnd(18);
  const deltaP = s.creditsNanoAiu > 0
    ? ((s.creditsExtension - s.creditsNanoAiu) / s.creditsNanoAiu * 100).toFixed(0) + "%"
    : "N/A";

  console.log(
    `${s.sessionId.slice(0, 16)} | ` +
    `${String(s.llmCalls).padStart(5)} | ` +
    `${aiuStatus.padEnd(8)} | ` +
    `${modelShort} | ` +
    `${s.creditsExtension.toFixed(1).padStart(9)} | ` +
    `${s.creditsNanoAiu.toFixed(1).padStart(9)} | ` +
    `${deltaP}`
  );
}

if (allSessions.length > 30) {
  console.log(`  ... (${allSessions.length - 30} more sessions)`);
}

// ─── Report: Sessions without nanoAiu (fallback path) ─────────

if (sessionsWithNoAiu.length > 0) {
  console.log("\n═══ Sessions Using Rate-Based Fallback (No nanoAiu) ═══\n");
  for (const s of sessionsWithNoAiu) {
    const diff = s.creditsRateBased - s.creditsWithCached;
    console.log(`  ${s.sessionId.slice(0, 16)} | ${s.llmCalls} calls | ${s.model}`);
    console.log(`    Rate-based: ${s.creditsRateBased.toFixed(2)} | With cached: ${s.creditsWithCached.toFixed(2)} | Diff: ${diff.toFixed(2)}`);
    console.log(`    Cached tokens in data: ${s.totalCached.toLocaleString()} (${(s.totalCached / s.totalInput * 100).toFixed(0)}% of input)`);
    console.log("");
  }
} else {
  console.log("\n  ✓ All sessions use API nanoAiu — rate-based fallback not reached.\n");
}

// ─── Summary ──────────────────────────────────────────────────

console.log("═".repeat(70));
console.log("SUMMARY:");
console.log("─".repeat(70));

if (sessionsWithNoAiu.length === 0 && Math.abs(extensionVsApiPct) < 10) {
  console.log("  Extension credit display matches API ground truth.");
  console.log("  All sessions have copilotUsageNanoAiu from the API.");
  console.log("  The rate-based fallback path is not reached.");
} else if (sessionsWithNoAiu.length > 0) {
  console.log(`  ${sessionsWithNoAiu.length} session(s) use rate-based fallback (no nanoAiu).`);
  console.log("  These sessions lack cached token discount in rate computation.");
} else {
  console.log(`  Extension display differs from API by ${extensionVsApiPct.toFixed(1)}%.`);
  console.log("  Review per-session breakdown above for details.");
}

console.log("═".repeat(70));

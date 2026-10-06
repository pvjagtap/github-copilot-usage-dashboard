/**
 * agentScanner.ts — Scan Oh My Pi (OMP) and Pi coding agent session JSONL files.
 *
 * Both agents write sessions under:
 *   OMP: ~/.omp/agent/sessions/<project>/<session>.jsonl
 *   Pi:  ~/.pi/agent/sessions/<project>/<session>.jsonl  (override: PI_CODING_AGENT_DIR)
 *
 * Each JSONL file has:
 *   Line 0: { type: "session", id, cwd, title?, ... }
 *   Lines 1+: { type: "message", timestamp, message: { role: "assistant", model, provider,
 *                usage: { input, output, cacheRead, cacheWrite, premiumRequests? } } }
 *
 * Token convention: `input` in agent session data is NET input tokens (already excludes
 * cached and cacheWrite). This differs from VS Code OTel data where promptTokens is the
 * gross total. When calling AICCalculator.calculateCredits(), reconstruct the gross total:
 *   inputTokens = input + cacheRead + cacheWrite
 * The calculator then computes: netInput = inputTokens - cachedTokens - cacheWriteTokens = input ✓
 */

import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import { isObj, mapConcurrent } from "./util";

// ─── Public Types ──────────────────────────────────────────────

export type AgentSource = "omp" | "pi";

/**
 * Per-model token counts within a session.
 * `input` = net input tokens (excludes cached reads and cache writes).
 * Caller must add cacheRead + cacheWrite to get gross inputTokens for AICCalculator.
 */
export interface AgentModelTokens {
  /** Net input tokens (excludes cacheRead and cacheWrite) */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Actual AIC credits from the agent's usage.cost.total ledger, when present. */
  costCredits: number;
  llmCalls: number;
  /** Provider observed for this model (for example github-copilot, anthropic, ollama). */
  provider: string;
  /** Model name. Present because rows are keyed by provider + model, not model alone. */
  model?: string;
  /**
   * Tokens from calls that recorded NO `usage.cost.total`. `costCredits` prices
   * only the calls that did, so a caller that stops at `costCredits > 0` silently
   * drops these. Agents populate `cost` on a minority of messages (12.8% across
   * the observed history), so this is the common case, not the edge case.
   */
  unpriced?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    calls: number;
  };
}

export interface AgentSessionData {
  source: AgentSource;
  sessionId: string;
  filePath: string;
  /** Session title (OMP sessions carry this; Pi sessions default to "") */
  title: string;
  cwd: string;
  /** Primary model — the one with the most LLM calls in this session */
  model: string;
  provider: string;
  llmCalls: number;
  totalInput: number; // net input tokens
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalTokens: number; // input + output + cacheRead + cacheWrite
  /** Actual AIC credits from usage.cost.total, converted from USD to credits. */
  totalCostCredits: number;
  premiumRequests: number;
  /** Per-model token breakdown; used for per-model AIC calculation in dashboardData */
  modelBreakdown: Record<string, AgentModelTokens>;
  firstTs: number; // epoch ms
  lastTs: number; // epoch ms
}

export interface AgentScanResult {
  /** All sessions from both sources within the current billing period */
  sessions: AgentSessionData[];
  billingStart: number; // epoch ms — 1st of current month UTC
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalTokens: number;
  totalLlmCalls: number;
  totalPremiumRequests: number;
  ompSessionCount: number;
  piSessionCount: number;
  /** All-time (unfiltered by billing period) per-source totals — for historical token display */
  ompAllTimeSessions: number;
  ompAllTimeLlmCalls: number;
  ompAllTimeTokens: number;
  piAllTimeSessions: number;
  piAllTimeLlmCalls: number;
  piAllTimeTokens: number;
  scanMs: number;
}

// ─── Directory Resolution ─────────────────────────────────────

export function getOmpSessionsRoot(): string {
  return path.join(os.homedir(), ".omp", "agent", "sessions");
}

export function getPiSessionsRoot(): string {
  const agentDir = process.env["PI_CODING_AGENT_DIR"] || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

// ─── Helpers ──────────────────────────────────────────────────

// isObj / mapConcurrent now imported from ./util
async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

// ─── Mtime Cache ──────────────────────────────────────────────

const fileCache = new Map<string, { mtime: number; data: AgentSessionData }>();

// ─── Session Parser ───────────────────────────────────────────

function parseAgentSession(
  content: string,
  filePath: string,
  source: AgentSource
): AgentSessionData | null {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return null;
  }

  // The header is the first `type: "session"` record. Current OMP writes a padded
  // `type: "title"` record on line 1, so it is not always line 0. Pi writes it first.
  let header: Record<string, unknown> | null = null;
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    try {
      const rec: unknown = JSON.parse(lines[i]);
      if (isObj(rec) && rec["type"] === "session") {
        header = rec;
        headerIdx = i;
        break;
      }
    } catch {
      // partial / non-JSON line — keep looking
    }
  }
  if (!header) {
    return null;
  }

  const sessionId = typeof header["id"] === "string" ? header["id"] : "";
  if (!sessionId) {
    return null;
  }

  const cwd = typeof header["cwd"] === "string" ? header["cwd"] : "";
  const title = typeof header["title"] === "string" ? header["title"] : "";

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCostCredits = 0;
  let totalPremium = 0;
  let llmCalls = 0;
  let primaryModel = "";
  let provider = "";
  let firstTs = 0;
  let lastTs = 0;
  const modelMap = new Map<string, AgentModelTokens>();

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(entry) || entry["type"] !== "message") {
      continue;
    }

    const msg = entry["message"];
    if (!isObj(msg) || msg["role"] !== "assistant") {
      continue;
    }

    const usage = msg["usage"];
    if (!isObj(usage)) {
      continue;
    }

    const inp = typeof usage["input"] === "number" ? usage["input"] : 0;
    const out = typeof usage["output"] === "number" ? usage["output"] : 0;
    const cr = typeof usage["cacheRead"] === "number" ? usage["cacheRead"] : 0;
    const cw = typeof usage["cacheWrite"] === "number" ? usage["cacheWrite"] : 0;
    const cost = isObj(usage["cost"]) && typeof usage["cost"]["total"] === "number"
      ? usage["cost"]["total"] * 100
      : 0;
    const pr = typeof usage["premiumRequests"] === "number" ? usage["premiumRequests"] : 0;
    const callProvider = typeof msg["provider"] === "string" ? msg["provider"] : provider;

    totalInput += inp;
    totalOutput += out;
    totalCacheRead += cr;
    totalCacheWrite += cw;
    totalCostCredits += cost;
    totalPremium += pr;
    llmCalls++;

    // Per-model token accumulation, keyed by provider + model. Keying by model
    // alone latched whichever provider was seen first, so the same model served
    // by two providers in one session (claude-opus-5 runs on both Copilot and
    // Azure Foundry) would bill entirely to one of them.
    const callModel = typeof msg["model"] === "string" ? msg["model"] : primaryModel || "unknown";
    const modelKey = `${callProvider || ""}::${callModel}`;
    let row = modelMap.get(modelKey);
    if (!row) {
      row = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costCredits: 0,
        llmCalls: 0,
        provider: callProvider || "",
        model: callModel,
        unpriced: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
      };
      modelMap.set(modelKey, row);
    }
    row.input += inp;
    row.output += out;
    row.cacheRead += cr;
    row.cacheWrite += cw;
    row.costCredits += cost;
    row.llmCalls++;
    if (cost <= 0 && row.unpriced) {
      row.unpriced.input += inp;
      row.unpriced.output += out;
      row.unpriced.cacheRead += cr;
      row.unpriced.cacheWrite += cw;
      row.unpriced.calls++;
    }

    if (!primaryModel && typeof msg["model"] === "string") {
      primaryModel = msg["model"];
    }
    if (!provider && typeof msg["provider"] === "string") {
      provider = msg["provider"];
    }

    // Timestamp: Pi stores numeric ms in msg.timestamp; both store ISO in entry.timestamp
    let ts = 0;
    if (typeof msg["timestamp"] === "number" && msg["timestamp"] > 0) {
      ts = msg["timestamp"];
    } else if (typeof entry["timestamp"] === "string") {
      ts = new Date(entry["timestamp"] as string).getTime();
    }
    if (ts > 0) {
      if (firstTs === 0 || ts < firstTs) {
        firstTs = ts;
      }
      if (ts > lastTs) {
        lastTs = ts;
      }
    }
  }

  if (llmCalls === 0) {
    return null;
  }

  // Primary model = most LLM calls (deterministic tiebreak by name).
  // Rows are keyed by provider+model, so aggregate back to the bare model name
  // first — otherwise one model split across two providers loses to a model
  // that only ever ran on one.
  const callsByModel = new Map<string, number>();
  for (const stats of modelMap.values()) {
    const name = stats.model ?? "unknown";
    callsByModel.set(name, (callsByModel.get(name) ?? 0) + stats.llmCalls);
  }
  let maxCalls = 0;
  for (const [m, calls] of callsByModel) {
    if (calls > maxCalls || (calls === maxCalls && m < primaryModel)) {
      maxCalls = calls;
      primaryModel = m;
    }
  }

  return {
    source,
    sessionId,
    filePath,
    title,
    cwd,
    model: primaryModel,
    provider,
    llmCalls,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
    totalCostCredits,
    premiumRequests: totalPremium,
    modelBreakdown: Object.fromEntries(modelMap),
    firstTs,
    lastTs,
  };
}

// ─── Directory Scanner ────────────────────────────────────────

async function scanDirectory(
  sessionsRoot: string,
  source: AgentSource
): Promise<AgentSessionData[]> {
  const entries = await readdirSafe(sessionsRoot);
  const allSessions: AgentSessionData[] = [];

  const readSession = async (filePath: string): Promise<AgentSessionData | null> => {
    try {
      const fstat = await fsp.stat(filePath);
      if (!fstat.isFile()) {
        return null;
      }

      const cached = fileCache.get(filePath);
      if (cached && cached.mtime === fstat.mtimeMs) {
        return cached.data;
      }

      const content = await fsp.readFile(filePath, "utf-8");
      const data = parseAgentSession(content, filePath, source);
      if (data) {
        fileCache.set(filePath, { mtime: fstat.mtimeMs, data });
      }
      return data;
    } catch {
      return null;
    }
  };

  // Sessions normally live in <root>/<project>/*.jsonl, but the agents also
  // write straight into <root> when a session has no project context. Those
  // loose files used to be dropped entirely (the walk only descended into
  // directory entries), silently under-reporting agent credits.
  const rootFiles = entries.filter(f => f.endsWith(".jsonl"));

  const projectResults = await mapConcurrent(entries, 8, async projDir => {
    const projPath = path.join(sessionsRoot, projDir);
    const projStat = await fsp.stat(projPath).catch(() => null);
    if (!projStat?.isDirectory()) {
      return [];
    }

    const files = await readdirSafe(projPath);
    const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));

    const sessions = await mapConcurrent(jsonlFiles, 8, file =>
      readSession(path.join(projPath, file))
    );

    return sessions.filter((s): s is AgentSessionData => s !== null);
  });

  const rootSessions = await mapConcurrent(rootFiles, 8, file =>
    readSession(path.join(sessionsRoot, file))
  );

  for (const sessions of projectResults) {
    allSessions.push(...sessions);
  }
  for (const s of rootSessions) {
    if (s) {
      allSessions.push(s);
    }
  }
  return allSessions;
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Scan OMP and Pi agent session JSONL files.
 * Returns sessions within the current billing period (1st of current month UTC).
 * Results are mtime-cached; unchanged files are not re-parsed.
 */
export async function scanAgentSessions(): Promise<AgentScanResult> {
  const t0 = Date.now();
  const now = new Date();
  const billingStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const [ompRaw, piRaw] = await Promise.all([
    scanDirectory(getOmpSessionsRoot(), "omp"),
    scanDirectory(getPiSessionsRoot(), "pi"),
  ]);

  // All-time per-source totals (before billing filter) — for historical token display
  let ompAllTimeSessions = 0,
    ompAllTimeLlmCalls = 0,
    ompAllTimeTokens = 0;
  let piAllTimeSessions = 0,
    piAllTimeLlmCalls = 0,
    piAllTimeTokens = 0;
  for (const s of ompRaw) {
    ompAllTimeSessions++;
    ompAllTimeLlmCalls += s.llmCalls;
    ompAllTimeTokens += s.totalTokens;
  }
  for (const s of piRaw) {
    piAllTimeSessions++;
    piAllTimeLlmCalls += s.llmCalls;
    piAllTimeTokens += s.totalTokens;
  }

  // Billing-period sessions (for AIC credit computation)
  const allRaw = [...ompRaw, ...piRaw];
  const billable = allRaw.filter(s => (s.lastTs || s.firstTs) >= billingStart);
  billable.sort((a, b) => b.lastTs - a.lastTs);

  const totalInput = billable.reduce((s, x) => s + x.totalInput, 0);
  const totalOutput = billable.reduce((s, x) => s + x.totalOutput, 0);
  const totalCacheRead = billable.reduce((s, x) => s + x.totalCacheRead, 0);
  const totalCacheWrite = billable.reduce((s, x) => s + x.totalCacheWrite, 0);
  const totalLlmCalls = billable.reduce((s, x) => s + x.llmCalls, 0);
  const totalPremium = billable.reduce((s, x) => s + x.premiumRequests, 0);

  // Evict stale cache entries for files that no longer exist on disk.
  // fileCache only holds successfully parsed sessions, so any key absent from
  // the current scan corresponds to a deleted (or moved) file.
  const seenPaths = new Set<string>([...ompRaw, ...piRaw].map(s => s.filePath));
  for (const key of fileCache.keys()) {
    if (!seenPaths.has(key)) {
      fileCache.delete(key);
    }
  }

  return {
    sessions: billable,
    billingStart,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
    totalLlmCalls,
    totalPremiumRequests: totalPremium,
    ompSessionCount: billable.filter(s => s.source === "omp").length,
    piSessionCount: billable.filter(s => s.source === "pi").length,
    ompAllTimeSessions,
    ompAllTimeLlmCalls,
    ompAllTimeTokens,
    piAllTimeSessions,
    piAllTimeLlmCalls,
    piAllTimeTokens,
    scanMs: Date.now() - t0,
  };
}

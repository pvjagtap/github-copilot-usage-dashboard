/**
 * dashboardData.ts — Aggregate scanner results into dashboard-ready data.
 * Ports get_dashboard_data() from dashboard.py to TypeScript.
 */

import { ScanResult, Session, Turn, ToolCall, Subagent, ScanStats, DebugRequest } from "./scanner";
import { AgentScanResult } from "./agentScanner";
import { CliScanResult } from "./cliScanner";
import { LiveStats, OTelRequest } from "./otelReceiver";
import { AICCalculator, AICConfig, DEFAULT_AIC_CONFIG, createCalculatorFromConfig, getPromoInfo, classifyModelBillability } from "./aicCredits";
import { classifyByCatalog } from "./modelCatalog";

/**
 * AIC billing effective date. Only sessions/turns on or after this date
 * are included in AI Credit calculations.
 * GitHub Copilot usage-based billing started June 1, 2026.
 */
export const AIC_EFFECTIVE_DATE = "2026-06-01";

function roundCredits(value: number): number {
  return Math.round(value * 100) / 100;
}

function otelRequestCredits(calculator: AICCalculator, req: OTelRequest): number {
  return calculator.calculateCredits(
    req.modelName,
    req.promptTokens,
    req.completionTokens,
    req.cachedTokens,
    req.cacheWriteTokens,
  ).totalCredits;
}

function canonicalBillingModel(calculator: AICCalculator, model: string): string {
  const rate = calculator.findModelRate(model);
  if (rate) {
    return rate.model;
  }
  return normalizeRequestModel(model)
    .replace(/-\d{4}[-.]?\d{2}[-.]?\d{2}$/, "");
}

function normalizeRequestModel(model: string): string {
  return model.toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/(\d)-(\d)/g, "$1.$2");
}

/**
 * Extract a "model family" for fuzzy matching.  Strips trailing minor
 * version (`.7`, `.6`) and date suffixes (`-2024.07.18`) so that request
 * vs response model aliases (e.g. OTel reports `claude-opus-4.6` while
 * the debug-log records the API response model `claude-opus-4.7`) still
 * match during reconciliation.
 */
function modelFamily(model: string): string {
  return normalizeRequestModel(model)
    .replace(/-\d{4}[-.]?\d{2}[-.]?\d{2}$/, "")   // strip date suffix
    .replace(/\.\d+$/, "");                         // strip trailing .X
}

function debugRequestsFromTurns(turns: Turn[]): DebugRequest[] {
  const requests: DebugRequest[] = [];
  for (const turn of turns) {
    if (turn.debugRequests && turn.debugRequests.length > 0) {
      requests.push(...turn.debugRequests);
      continue;
    }
    if (turn.debugAicCredits <= 0 || turn.debugLlmCalls > 1) {
      continue;
    }
    const debugModels = turn.debugByModel ? Object.entries(turn.debugByModel) : [];
    const [model, totals] = debugModels.length === 1 ? debugModels[0] : [turn.modelFamily || "unknown", undefined];
    requests.push({
      timestamp: turn.debugLastRequestTs || turn.timestamp,
      model,
      prompt: totals?.prompt ?? (turn.debugPromptTokens || turn.promptTokens),
      output: totals?.output ?? (turn.debugOutputTokens || turn.outputTokens),
      cached: totals?.cached ?? (turn.debugCachedTokens || 0),
      nanoAiu: totals?.nanoAiu ?? turn.debugAicCredits * 1e9,
    });
  }
  return requests;
}

function debugRequestsInWindow(turns: Turn[], todayDate: string, activationTime?: string): DebugRequest[] {
  return debugRequestsFromTurns(turns).filter(req => {
    if (!req.timestamp || req.timestamp.slice(0, 10) !== todayDate) {
      return false;
    }
    return !activationTime || req.timestamp >= activationTime;
  });
}

function latestDebugRequest(requests: readonly DebugRequest[]): DebugRequest | undefined {
  return requests.reduce((best, req) => {
    if (!best) {
      return req;
    }
    return (req.timestamp || "") > (best.timestamp || "") ? req : best;
  }, undefined as DebugRequest | undefined);
}

/**
 * Determine which OTel requests have NOT yet been flushed to the debug log.
 *
 * Uses **count-based per-model matching**: for each model family, if the debug
 * log has N requests and OTel has M requests, the (M - N) newest OTel requests
 * are treated as "pending" (not yet flushed). This avoids the fragile exact
 * token-count comparison that fails when the debug log and OTel record slightly
 * different values for the same API call (common with Anthropic Opus where OTel
 * traces omit cache attributes, causing normalization differences).
 */
function unflushedOtelRequests(liveRequestLog: readonly OTelRequest[], debugRequests: readonly DebugRequest[], todayDate: string, activationTime?: string): OTelRequest[] {
  // Count debug requests per model family (only those with meaningful data).
  const debugCountByFamily = new Map<string, number>();
  for (const d of debugRequests) {
    if (d.prompt <= 0 && d.output <= 0) { continue; }
    const family = modelFamily(d.model);
    debugCountByFamily.set(family, (debugCountByFamily.get(family) ?? 0) + 1);
  }

  // Filter OTel requests to today + activation window, grouped by model family.
  const otelByFamily = new Map<string, OTelRequest[]>();
  for (const req of liveRequestLog) {
    if (!req.timestamp || req.timestamp.slice(0, 10) !== todayDate) {
      continue;
    }
    if (activationTime && req.timestamp < activationTime) {
      continue;
    }
    const family = modelFamily(req.modelName);
    const list = otelByFamily.get(family) ?? [];
    list.push(req);
    otelByFamily.set(family, list);
  }

  // For each model family, the newest (M - N) OTel requests are pending.
  const pending: OTelRequest[] = [];
  for (const [family, otelReqs] of otelByFamily) {
    const debugCount = debugCountByFamily.get(family) ?? 0;
    if (otelReqs.length <= debugCount) {
      // All OTel requests for this model have been flushed — none pending.
      continue;
    }
    // Sort ascending by timestamp so we can skip the oldest N (matched) and
    // keep the newest (M - N) as pending.
    otelReqs.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    pending.push(...otelReqs.slice(debugCount));
  }
  return pending;
}

// ─── Dashboard Data Types ─────────────────────────────────────

export interface DailyRow {
  day: string;
  model: string;
  prompt: number;
  output: number;
  toolRounds: number;
  turns: number;
}

export interface ToolRow {
  sessionId: string;
  toolName: string;
  count: number;
}

export interface SubagentRow {
  sessionId: string;
  agentName: string;
  count: number;
}

export interface TurnRow {
  sessionId: string;
  timestamp: string;
  model: string;
  prompt: number;
  output: number;
}

export interface SessionView {
  sessionId: string;
  sessionShort: string;
  project: string;
  title: string;
  promptCount: number;
  promptPreview: string;
  transcriptCount: number;
  sources: number;
  last: string;
  lastDate: string;
  durationMin: number;
  modelName: string;
  model: string;
  multiplier: number;
  account: string;
  agentId: string;
  location: string;
  turns: number;
  prompt: number;
  output: number;
  /** Actual cumulative prompt from debug-logs (all LLM API calls). 0 if no debug data. */
  actualPrompt: number;
  /** Actual cumulative output from debug-logs. 0 if no debug data. */
  actualOutput: number;
  toolRounds: number;
  toolCalls: number;
  subagents: number;
  sourcePaths: string[];
  transcriptPaths: string[];
  /** AI Credits consumed by this session (0 if before AIC effective date) */
  aicCredits: number;
}

export interface DashboardData {
  allModels: string[];
  dailyByModel: DailyRow[];
  sessionsAll: SessionView[];
  toolsAll: ToolRow[];
  subagentsAll: SubagentRow[];
  turnsAll: TurnRow[];
  liveOtel: LiveOtelData;
  scanStats: ScanStats;
  generatedAt: string;
  /** AI Credits (AIC) usage summary — configurable per-model cost tracking */
  aicSummary: AICDashboardData;
  /** AI Credits for the most recent (current) session */
  currentSessionAIC: number;
  /** Combined AIC contribution from OMP and Pi agent sessions */
  agentSummary: AgentUsageSummary;
}

/** Per-source usage breakdown: VS Code chatSessions, Oh My Pi agent, Pi coding agent */
export interface AgentUsageSummary {
  // ── VS Code (chatSession scanner) ─────────────────────────
  vscodeSessions: number;
  vscodeTurns: number;
  /** Total prompt + output tokens from all VS Code turns */
  vscodeTotalTokens: number;
  /** AIC credits attributed to VS Code turns only (aicSummary.totalCredits − OMP − Pi) */
  vscodeAicCredits: number;

  // ── Oh My Pi agent (~/.omp/agent/sessions) ─────────────────
  ompSessions: number;
  ompLlmCalls: number;
  ompTotalTokens: number;
  ompTotalCredits: number;
  /** All-time (no billing filter) — historical token volume */
  ompAllTimeLlmCalls: number;
  ompAllTimeTokens: number;

  // ── Pi coding agent (~/.pi/agent/sessions) ──────────────────
  piSessions: number;
  piLlmCalls: number;
  piTotalTokens: number;
  piTotalCredits: number;
  /** All-time (no billing filter) — historical token volume */
  piAllTimeLlmCalls: number;
  piAllTimeTokens: number;

  // ── GitHub Copilot CLI (~/.copilot/session-state) ──────────
  // Live-walked prompts × multiplier; overridden by session.shutdown
  // totalNanoAiu whenever a clean shutdown was emitted. See
  // [src/cliScanner.ts](./cliScanner.ts) for the hybrid strategy and
  // shutdown-vs-live fallback behavior.
  cliSessions: number;
  /** Σ user.message events (slash-commands excluded) in the billing window. */
  cliLlmCalls: number;
  /** Σ live output tokens reported on assistant.message events. */
  cliTotalTokens: number;
  /** AIC: shutdown totalNanoAiu when present, else prompts × multiplier. */
  cliTotalCredits: number;
  cliAllTimeSessions: number;
  cliAllTimeLlmCalls: number;
  cliAllTimeTokens: number;
  /** Σ live estimate − Σ shutdown totalNanoAiu over sessions that have both. */
  cliDriftAic: number;
  /** Sessions in the window that had a session.shutdown event (ledger basis). */
  cliReconciledSessions: number;
  /** Sessions in the window that had no shutdown (live-only fallback). */
  cliLiveOnlySessions: number;
  /** Resolved Copilot home dir used for the scan (for diagnostics / settings UI). */
  cliCopilotHome: string;

  // ── Cumulative (all sources) ────────────────────────────────
  totalSessions: number;
  totalCredits: number;
  scanMs: number;
}

/** Serializable AIC data for the webview */
export interface AICDashboardData {
  totalCredits: number;
  inputCredits: number;
  outputCredits: number;
  cachedCredits: number;
  planName: string;
  monthlyBudget: number;
  creditsRemaining: number;
  estimatedOverageCost: number;
  billingCycleStart: string;
  billingCycleEnd: string;
  daysRemaining: number;
  dailyAverage: number;
  projectedTotal: number;
  /** Per-model credit breakdown */
  byModel: Array<{
    model: string;
    tier: string;
    inputCredits: number;
    outputCredits: number;
    cachedCredits: number;
    totalCredits: number;
  }>;
  /** Per-day credit totals */
  byDay: Array<{ day: string; credits: number }>;
  /** Current AIC configuration for display */
  config: AICConfig;
  /**
   * Informational summary of usage from models GitHub does NOT bill in
   * AI Credits (local Ollama / LM Studio / BYOK keys / unrecognised models).
   * Credits here are rate-table estimates of what the same traffic would
   * cost on Copilot — NOT what the user will be charged. Excluded from the
   * billable headline totals above. See issue #5.
   */
  nonBillable: {
    totalCredits: number;
    byModel: Array<{
      model: string;
      tier: string;
      inputCredits: number;
      outputCredits: number;
      cachedCredits: number;
      totalCredits: number;
    }>;
  };
  /** Promotional period info */
  promo: {
    /** Whether we are currently in the promo window (June 1 – Sept 1, 2026) */
    isPromoActive: boolean;
    /** Promo budget (3000 for Business, 7000 for Enterprise) — 0 if not applicable */
    promoBudget: number;
    /** Standard (non-promo) budget */
    standardBudget: number;
    /** Overage cost WITHOUT promo (against standard budget) */
    overageWithoutPromo: number;
    /** Overage cost WITH promo (against promo budget) */
    overageWithPromo: number;
    /** Credits remaining under promo budget */
    creditsRemainingPromo: number;
    /** Credits remaining under standard budget */
    creditsRemainingStandard: number;
    /** Promo period end date */
    promoEndDate: string;
  };
  /** Whether credits come from actual API billing data (true) or computed estimates (false) */
  isActualFromApi: boolean;
}

export interface LiveOtelData {
  requests: number;
  prompt: number;
  completion: number;
  cached: number;
  traceCached: number;
  metricCached: number;
  lastSeen: string;
  source: "otel" | "debug-log" | "none";
  byModel: Array<{
    model: string;
    requests: number;
    prompt: number;
    completion: number;
    traceCached: number;
    metricCached: number;
    cached: number;
    /**
     * Per-model AIC credits. Prefers API-exact `copilotUsageNanoAiu` from
     * debug-logs when present (live OTel overlays today's per-model billed
     * AIU onto its rate-table baseline; debug-log branch reads it directly).
     * Falls back to a calculator estimate derived from this row's
     * prompt/completion/cached tokens when no billed value is available.
     */
    aicCredits: number;
    /**
     * True iff at least one request contributing to this row's `aicCredits`
     * came from GitHub's authoritative `copilotUsageNanoAiu` debug-log
     * field (or `debugAicCredits`). This is the "GitHub actually billed it"
     * signal — it MUST be passed to `classifyModelBillability` as
     * `hasActualCredits` so a BYOK third-party catalog entry can't demote
     * a Copilot-billed row to non-billable. Root cause of the v1.10.13
     * sessionAIC=0 bug: hardcoding `false` here demoted Copilot-billed
     * claude-opus-4.7 / gpt-5.3-codex to non-billable for users with BYOK
     * Anthropic configured in `chatLanguageModels.json`.
     */
    hasActualCredits: boolean;
    /**
     * Whether this model is billed by GitHub Copilot. False for local
     * Ollama / LM Studio / BYOK / unrecognised models. Non-billable rows
     * are excluded from `sessionAIC` / `lastRequestAIC` (issue #5).
     */
    isBillable: boolean;
  }>;
  /** Session-cumulative AIC credits computed from live OTel data */
  sessionAIC: number;
  /** Last single request's AIC credits */
  lastRequestAIC: number;
  /**
   * Σ `aicCredits` across `byModel` rows whose `isBillable === false`
   * (after the post-processor reclassifies). Used by the dashboard tile
   * + status-bar tooltip to surface "$X.XX informational excluded" so a
   * session total < per-row sum is transparent rather than mysterious.
   */
  informationalAIC: number;
}

// ─── Aggregation ──────────────────────────────────────────────

function computeDaily(turns: Turn[]): DailyRow[] {
  const map = new Map<string, DailyRow>();
  const bump = (day: string, model: string, prompt: number, output: number, toolRounds: number) => {
    const key = `${day}:${model}`;
    const existing = map.get(key);
    if (existing) {
      existing.prompt += prompt;
      existing.output += output;
      existing.toolRounds += toolRounds;
      existing.turns++;
    } else {
      map.set(key, { day, model, prompt, output, toolRounds, turns: 1 });
    }
  };
  for (const t of turns) {
    if (!t.timestamp) { continue; }
    const day = t.timestamp.slice(0, 10);
    // Prefer the per-llm_request `debugByModel` breakdown when present so the
    // daily-by-model view attributes auxiliary calls (title gpt-4o-mini,
    // subagent haiku) to their actual model. Falls back to the parent turn's
    // single `modelFamily` for non-debug-log turns or older logs.
    if (t.debugByModel) {
      for (const [model, mt] of Object.entries(t.debugByModel)) {
        bump(day, model, mt.prompt, mt.output, 0);
      }
    } else {
      bump(
        day,
        t.modelFamily || "unknown",
        t.debugPromptTokens || t.promptTokens,
        t.debugOutputTokens || t.outputTokens,
        t.toolCallRounds,
      );
    }
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
}

function computeTools(toolCalls: ToolCall[]): ToolRow[] {
  const map = new Map<string, ToolRow>();
  for (const tc of toolCalls) {
    const key = `${tc.sessionId}:${tc.toolName}`;
    const existing = map.get(key);
    if (existing) { existing.count++; }
    else { map.set(key, { sessionId: tc.sessionId, toolName: tc.toolName, count: 1 }); }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function computeSubagents(subagents: Subagent[]): SubagentRow[] {
  const map = new Map<string, SubagentRow>();
  for (const sa of subagents) {
    const key = `${sa.sessionId}:${sa.agentName}`;
    const existing = map.get(key);
    if (existing) { existing.count++; }
    else { map.set(key, { sessionId: sa.sessionId, agentName: sa.agentName, count: 1 }); }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function computeSessionViews(sessions: Session[], toolCalls: ToolCall[], turns: Turn[], calculator: AICCalculator): SessionView[] {
  // Tool call counts per session
  const toolCountMap = new Map<string, number>();
  for (const tc of toolCalls) {
    toolCountMap.set(tc.sessionId, (toolCountMap.get(tc.sessionId) ?? 0) + 1);
  }

  // Per-session AIC credits (only for turns on/after AIC_EFFECTIVE_DATE)
  // Prefer actual API-reported AIC (debugAicCredits) over computed from rates
  const sessionCreditsMap = new Map<string, number>();
  for (const t of turns) {
    if (!t.timestamp) { continue; }
    const date = t.timestamp.slice(0, 10);
    if (date < AIC_EFFECTIVE_DATE) { continue; }
    let credits: number;
    if (t.debugAicCredits > 0) {
      // Use actual API-reported AIC (includes cache discounts)
      credits = t.debugAicCredits;
    } else {
      // Fallback: compute from rates (upper-bound, no cache info)
      const inputTokens = t.debugPromptTokens || t.promptTokens;
      const outputTokens = t.debugOutputTokens || t.outputTokens;
      credits = calculator.calculateCredits(t.modelFamily || "unknown", inputTokens, outputTokens, 0).totalCredits;
    }
    sessionCreditsMap.set(t.sessionId, (sessionCreditsMap.get(t.sessionId) ?? 0) + credits);
  }

  return sessions.map(s => {
    let durationMin = 0;
    if (s.firstTimestamp && s.lastTimestamp) {
      const start = new Date(s.firstTimestamp).getTime();
      const end = new Date(s.lastTimestamp).getTime();
      if (end > start) { durationMin = Math.round((end - start) / 60000 * 10) / 10; }
    }

    return {
      sessionId: s.sessionId,
      sessionShort: s.sessionId.slice(0, 8),
      project: s.projectName || "unknown",
      title: s.sessionTitle || "",
      promptCount: s.promptCount,
      promptPreview: s.promptPreview || "",
      transcriptCount: s.transcriptCount,
      sources: s.sourceCount,
      last: (s.lastTimestamp || "").slice(0, 16).replace("T", " "),
      lastDate: (s.lastTimestamp || "").slice(0, 10),
      durationMin,
      modelName: s.modelName || "unknown",
      model: s.modelFamily || "unknown",
      multiplier: s.modelMultiplier,
      account: s.accountLabel || "",
      agentId: s.agentId || "",
      location: s.location || "",
      turns: s.turnCount,
      prompt: s.totalPromptTokens,
      output: s.totalOutputTokens,
      actualPrompt: s.debugTotalPrompt,
      actualOutput: s.debugTotalOutput,
      toolRounds: s.toolCallRounds,
      toolCalls: toolCountMap.get(s.sessionId) ?? 0,
      subagents: s.subagentCalls,
      sourcePaths: s.sourcePaths || [],
      transcriptPaths: s.transcriptPaths || [],
      aicCredits: Math.round((sessionCreditsMap.get(s.sessionId) ?? 0) * 100) / 100,
    };
  });
}

function computeAllModels(turns: Turn[]): string[] {
  const map = new Map<string, number>();
  for (const t of turns) {
    const m = t.modelFamily || "unknown";
    const prompt = t.debugPromptTokens || t.promptTokens;
    const output = t.debugOutputTokens || t.outputTokens;
    map.set(m, (map.get(m) ?? 0) + prompt + output);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0]);
}

// ─── Build Dashboard Data ─────────────────────────────────────

// NOTE: a per-activation monotonic ratchet on `liveOtel.sessionAIC` was
// removed (was `applySessionAICRatchet` keyed by `activationTime`). It
// existed to suppress visible decreases like 147 → 138 when the per-model
// debug-log overlay replaced a rate-table over-estimate (Anthropic Opus
// OTel traces ship without cache attributes, so the estimate over-counts).
//
// Combined with `Math.max(otelEstimate, debugTruth)` below, the ratchet
// caused a logical impossibility: `liveOtel.sessionAIC` could exceed
// `aicSummary.totalCredits` even though session turns are a strict subset
// of cycle turns (so session credits MUST be ≤ cycle credits). Brief
// estimate→truth correction is honest UX; an impossible inversion is not.
//
// `sessionAIC` is now reconciled at request level: flushed calls come from
// authoritative debug-log `copilotUsageNanoAiu`, while not-yet-flushed live
// OTel calls are added as temporary estimates.

export function buildDashboardData(scan: ScanResult, liveStats: LiveStats | null, aicConfig?: AICConfig, agentScan?: AgentScanResult, activationTime?: string, cliScan?: CliScanResult): DashboardData {
  // Create AIC calculator early so it can be used in session views
  const config = aicConfig ?? DEFAULT_AIC_CONFIG;
  const calculator = createCalculatorFromConfig(config);

  const allModels = computeAllModels(scan.turns);
  const dailyByModel = computeDaily(scan.turns);
  const sessionsAll = computeSessionViews(scan.sessions, scan.toolCalls, scan.turns, calculator);
  const toolsAll = computeTools(scan.toolCalls);
  const subagentsAll = computeSubagents(scan.subagents);

  // Live OTel
  let liveOtel: LiveOtelData;
  if (liveStats && liveStats.requests > 0) {
    // Compute per-model AIC alongside the byModel projection so the dashboard
    // shows a credits column next to each model. We use a two-pass approach
    // for accuracy:
    //   1. Baseline estimate from rates (in case debug-logs lag OTel).
    //   2. OVERLAY exact `copilotUsageNanoAiu` from today's debug-log per-
    //      model breakdown when available (scoped to activationTime, same as
    //      sessionAIC). This makes per-model credits API-exact instead of
    //      estimated for every model the user actually billed today.
    const todayDate = new Date().toISOString().slice(0, 10);
    const debugTurnsToday = scan.turns.filter(
      t =>
        t.timestamp &&
        t.timestamp.slice(0, 10) === todayDate &&
        t.debugAicCredits > 0 &&
        (!activationTime || t.timestamp >= activationTime)
    );
    const debugRequestsToday = debugRequestsInWindow(scan.turns, todayDate, activationTime);

    const exactByModel = new Map<string, { model: string; prompt: number; output: number; cached: number; calls: number; nanoAiu: number }>();
    const addExactModel = (model: string, prompt: number, output: number, cached: number, calls: number, nanoAiu: number) => {
      const displayModel = canonicalBillingModel(calculator, model);
      const key = displayModel.toLowerCase();
      const row = exactByModel.get(key) ?? { model: displayModel, prompt: 0, output: 0, cached: 0, calls: 0, nanoAiu: 0 };
      row.prompt += prompt;
      row.output += output;
      row.cached += cached;
      row.calls += calls;
      row.nanoAiu += nanoAiu;
      exactByModel.set(key, row);
    };

    let debugSessionAIC = 0;
    if (debugRequestsToday.length > 0) {
      for (const req of debugRequestsToday) {
        debugSessionAIC += req.nanoAiu / 1e9;
        addExactModel(req.model, req.prompt, req.output, req.cached, 1, req.nanoAiu);
      }
    } else {
      for (const t of debugTurnsToday) {
        debugSessionAIC += t.debugAicCredits;
        if (t.debugByModel) {
          for (const [model, mt] of Object.entries(t.debugByModel)) {
            addExactModel(model, mt.prompt, mt.output, mt.cached, mt.calls, mt.nanoAiu);
          }
        } else {
          addExactModel(
            t.modelFamily || "unknown",
            t.debugPromptTokens || t.promptTokens,
            t.debugOutputTokens || t.outputTokens,
            t.debugCachedTokens || 0,
            Math.max(1, t.debugLlmCalls || 0),
            t.debugAicCredits * 1e9,
          );
        }
      }
    }

    const liveRequestLog = liveStats.requestLog ?? [];
    const pendingRequests = unflushedOtelRequests(liveRequestLog, debugRequestsToday, todayDate, activationTime);
    const liveByModel = new Map<string, { model: string; requests: number; prompt: number; completion: number; traceCached: number; metricCached: number; cached: number; cacheWrite: number }>();
    for (const live of liveStats.byModel.values()) {
      const displayModel = canonicalBillingModel(calculator, live.model);
      const key = displayModel.toLowerCase();
      const row = liveByModel.get(key) ?? {
        model: displayModel,
        requests: 0,
        prompt: 0,
        completion: 0,
        traceCached: 0,
        metricCached: 0,
        cached: 0,
        cacheWrite: 0,
      };
      row.requests += live.requests;
      row.prompt += live.prompt;
      row.completion += live.completion;
      row.traceCached += live.traceCached;
      row.metricCached += live.metricCached;
      row.cached += live.cached;
      row.cacheWrite += live.cacheWrite;
      liveByModel.set(key, row);
    }
    const pendingByModel = new Map<string, { model: string; requests: number; prompt: number; completion: number; cached: number; cacheWrite: number; credits: number }>();
    for (const req of pendingRequests) {
      const displayModel = canonicalBillingModel(calculator, req.modelName);
      const key = displayModel.toLowerCase();
      const row = pendingByModel.get(key) ?? {
        model: displayModel,
        requests: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
        cacheWrite: 0,
        credits: 0,
      };
      row.requests++;
      row.prompt += req.promptTokens;
      row.completion += req.completionTokens;
      row.cached += req.cachedTokens;
      row.cacheWrite += req.cacheWriteTokens;
      row.credits += otelRequestCredits(calculator, req);
      pendingByModel.set(key, row);
    }

    const byModelKeys = new Set<string>([
      ...liveByModel.keys(),
      ...exactByModel.keys(),
      ...pendingByModel.keys(),
    ]);
    const byModel = Array.from(byModelKeys).map(key => {
      const live = liveByModel.get(key);
      const exact = exactByModel.get(key);
      const pending = pendingByModel.get(key);
      const fallbackEstimate = live
        ? calculator.calculateCredits(live.model, live.prompt, live.completion, live.cached, live.cacheWrite).totalCredits
        : 0;
      const reconciledCredits = (exact ? exact.nanoAiu / 1e9 : 0) + (pending?.credits ?? 0);
      const credits = reconciledCredits > 0 ? reconciledCredits : fallbackEstimate;
      // `hasActualCredits` is the "GitHub already billed it" signal — only
      // true when the debug-log overlay populated `exact.nanoAiu > 0` for
      // this row. `pending` credits are OTel rate-table estimates and do
      // NOT qualify (marking them as actual would let an unknown-model
      // estimate sneak past the billable filter).
      const hasActualCredits = (exact?.nanoAiu ?? 0) > 0;
      return {
        model: live?.model ?? exact?.model ?? pending?.model ?? "unknown",
        requests: live?.requests ?? (exact?.calls ?? 0) + (pending?.requests ?? 0),
        prompt: live?.prompt ?? (exact?.prompt ?? 0) + (pending?.prompt ?? 0),
        completion: live?.completion ?? (exact?.output ?? 0) + (pending?.completion ?? 0),
        traceCached: live?.traceCached ?? (exact?.cached ?? 0) + (pending?.cached ?? 0),
        metricCached: live?.metricCached ?? 0,
        cached: live?.cached ?? (exact?.cached ?? 0) + (pending?.cached ?? 0),
        aicCredits: roundCredits(credits),
        hasActualCredits,
        // Backfilled by the post-processor that runs after the if/else chain.
        isBillable: false,
      };
    });
    const pendingSessionAIC = Array.from(pendingByModel.values()).reduce((sum, row) => sum + row.credits, 0);
    let sessionAIC = debugTurnsToday.length > 0
      ? debugSessionAIC + pendingSessionAIC
      : byModel.reduce((sum, row) => sum + row.aicCredits, 0);
    // Compute last request AIC from OTel data
    let lastRequestAIC = 0;
    if (liveStats.lastRequest) {
      const lr = liveStats.lastRequest;
      const reqCredits = calculator.calculateCredits(lr.modelName, lr.promptTokens, lr.completionTokens, lr.cachedTokens, lr.cacheWriteTokens);
      lastRequestAIC = reqCredits.totalCredits;
    }

    // ── Debug-log overlay (exact API-billed AIC) ──
    // OTel attributes for cache_read / cache_creation tokens are inconsistent
    // across models — notably missing for some Anthropic Opus traces, which
    // causes the calculator to produce under- or over-estimates. Debug logs
    // capture `copilotUsageNanoAiu` directly from the API response, which is
    // the exact billed value. When available, prefer it.
    //
    // Scope to THIS VS Code session via `activationTime`. Without it, opening
    // a fresh window mid-day inherited every prior session's AIC from
    // main.jsonl (the calendar-day filter alone matched all of today's
    // sessions across reloads), so `AIC (sess)` showed thousands of credits
    // while `AIC (last req)` correctly showed the single new request.
    if (debugRequestsToday.length > 0 || debugTurnsToday.length > 0) {
      // lastRequestAIC: prefer the newest individual llm_request so a tool-heavy
      // turn shows one API call's bill, not the whole turn sum.
      const mostRecentRequest = latestDebugRequest(debugRequestsToday);
      const otelLastTs = liveStats.lastRequest?.timestamp ?? "";
      if (mostRecentRequest) {
        const debugTs = mostRecentRequest.timestamp;
        if (debugTs >= otelLastTs || lastRequestAIC === 0) {
          lastRequestAIC = mostRecentRequest.nanoAiu / 1e9;
        }
      } else {
        const mostRecentDebug = debugTurnsToday.reduce((best, t) => {
          const tTs = t.debugLastRequestTs || t.timestamp;
          const bTs = best ? best.debugLastRequestTs || best.timestamp : "";
          return !best || tTs > bTs ? t : best;
        }, undefined as Turn | undefined);
        if (mostRecentDebug) {
          const debugTs = mostRecentDebug.debugLastRequestTs || mostRecentDebug.timestamp;
          if (debugTs >= otelLastTs || lastRequestAIC === 0) {
            lastRequestAIC = mostRecentDebug.debugLastRequestAic > 0
              ? mostRecentDebug.debugLastRequestAic
              : mostRecentDebug.debugAicCredits;
          }
        }
      }
    }

    liveOtel = {
      requests: liveStats.requests,
      prompt: liveStats.prompt,
      completion: liveStats.completion,
      cached: liveStats.cached,
      traceCached: liveStats.traceCached,
      metricCached: liveStats.metricCached,
      lastSeen: liveStats.lastSeen,
      source: "otel",
      byModel,
      // No ratchet: when the API-exact debug-log value replaces a rate-table
      // over-estimate, sessionAIC must be allowed to decrease — otherwise it
      // can exceed `aicSummary.totalCredits` (the cycle truth), violating the
      // session ⊆ cycle invariant. A brief flicker on estimate→truth is
      // honest UX; an impossible inversion is not.
      sessionAIC: Math.round(sessionAIC * 100) / 100,
      lastRequestAIC: Math.round(lastRequestAIC * 100) / 100,
      informationalAIC: 0,
    };
  } else {
    // Debug-log-only fallback (no OTel data yet). Same activationTime scope
    // as the OTel branch — otherwise a fresh VS Code session would inherit
    // every prior session's AIC from today's main.jsonl.
    const today = new Date().toISOString().slice(0, 10);
    const debugTurnsToday = scan.turns.filter(
      t =>
        t.timestamp &&
        t.timestamp.slice(0, 10) === today &&
        (t.debugPromptTokens > 0 || t.debugOutputTokens > 0) &&
        (!activationTime || t.timestamp >= activationTime)
    );
    const debugRequestsToday = debugRequestsInWindow(scan.turns, today, activationTime);

    if (debugRequestsToday.length > 0) {
      const byModelMap = new Map<
        string,
        {
          model: string;
          requests: number;
          prompt: number;
          completion: number;
          traceCached: number;
          metricCached: number;
          cached: number;
          aicCredits: number;
        }
      >();
      const getOrCreateRow = (model: string) => {
        let row = byModelMap.get(model);
        if (!row) {
          row = {
            model,
            requests: 0,
            prompt: 0,
            completion: 0,
            traceCached: 0,
            metricCached: 0,
            cached: 0,
            aicCredits: 0,
          };
          byModelMap.set(model, row);
        }
        return row;
      };
      let requests = 0;
      let prompt = 0;
      let completion = 0;
      let cached = 0;
      let lastSeen = "";
      let sessionAIC = 0;

      for (const req of debugRequestsToday) {
        requests++;
        prompt += req.prompt;
        completion += req.output;
        cached += req.cached;
        sessionAIC += req.nanoAiu / 1e9;
        if (req.timestamp > lastSeen) {
          lastSeen = req.timestamp;
        }
        const row = getOrCreateRow(req.model);
        row.requests += 1;
        row.prompt += req.prompt;
        row.completion += req.output;
        row.traceCached += req.cached;
        row.cached += req.cached;
        row.aicCredits += req.nanoAiu / 1e9;
      }

      const mostRecentRequest = latestDebugRequest(debugRequestsToday);
      liveOtel = {
        requests,
        prompt,
        completion,
        cached,
        traceCached: cached,
        metricCached: 0,
        lastSeen,
        source: "debug-log",
        byModel: Array.from(byModelMap.values()).map(row => ({
          ...row,
          aicCredits: Math.round(row.aicCredits * 100) / 100,
          // Every row here was built from `debugRequestsToday`, whose AIC
          // value came from `req.nanoAiu` (GitHub's authoritative billed
          // amount) — by construction every row has actual credits.
          hasActualCredits: true,
          // Backfilled by the post-processor below.
          isBillable: false,
        })),
        sessionAIC: Math.round(sessionAIC * 100) / 100,
        lastRequestAIC: Math.round(((mostRecentRequest?.nanoAiu ?? 0) / 1e9) * 100) / 100,
        informationalAIC: 0,
      };
    } else if (debugTurnsToday.length > 0) {
      // Per-model accumulator. `aicCredits` is summed from the per-llm_request
      // billed value (`debugByModel[*].credits` from copilotUsageNanoAiu) when
      // available; otherwise falls back to a calculator estimate at finalize
      // time. Either way it shows credits-per-model in the dashboard table.
      const byModelMap = new Map<
        string,
        {
          model: string;
          requests: number;
          prompt: number;
          completion: number;
          traceCached: number;
          metricCached: number;
          cached: number;
          aicCredits: number;
          /**
           * True iff at least one llm_request contributing to this row
           * supplied an authoritative billed value (`mt.nanoAiu > 0` or
           * `turn.debugAicCredits > 0`). Mixed rows where SOME requests
           * billed and SOME didn't still count as `true` — the post-
           * processor uses it as a strong signal that GitHub already
           * counted this model, so a third-party catalog entry must not
           * silently demote it (root cause of v1.10.13 sessionAIC=0 bug).
           */
          hasActualCredits: boolean;
        }
      >();
      const getOrCreateRow = (model: string) => {
        let row = byModelMap.get(model);
        if (!row) {
          row = {
            model,
            requests: 0,
            prompt: 0,
            completion: 0,
            traceCached: 0,
            metricCached: 0,
            cached: 0,
            aicCredits: 0,
            hasActualCredits: false,
          };
          byModelMap.set(model, row);
        }
        return row;
      };
      let requests = 0;
      let prompt = 0;
      let completion = 0;
      let cached = 0;
      let lastSeen = "";
      let sessionAIC = 0;
      // Pick the most-recent-timestamp turn for lastRequestAIC. scan.turns is
      // not timestamp-sorted (it's append-order across sessions + synthetic
      // debug-log turns), so a naive "last iterated" pick was order-dependent
      // and could appear frozen on refresh while sessionAIC kept growing.
      let mostRecentTurn: Turn | undefined;

      for (const turn of debugTurnsToday) {
        const turnRequests = Math.max(1, turn.debugLlmCalls || 0);
        const turnCached = turn.debugCachedTokens || 0;
        requests += turnRequests;
        prompt += turn.debugPromptTokens;
        completion += turn.debugOutputTokens;
        cached += turnCached;
        // Per-model rows: prefer the scanner's per-llm_request `debugByModel`
        // breakdown (captures title gpt-4o-mini, subagent haiku, etc.) and only
        // fall back to the parent's single `modelFamily` when byModel is absent
        // (older debug logs that predate per-request model capture).
        if (turn.debugByModel) {
          for (const [model, mt] of Object.entries(turn.debugByModel)) {
            const row = getOrCreateRow(model);
            row.requests += mt.calls;
            row.prompt += mt.prompt;
            row.completion += mt.output;
            row.traceCached += mt.cached;
            row.cached += mt.cached;
            // Prefer per-llm_request billed credits when the scanner captured
            // them (nanoAiu is the raw `copilotUsageNanoAiu` * 1e0; divide by
            // 1e9 to get credits). Falls back to a rate-table estimate when
            // older debug-logs lack per-model AIU.
            if (typeof mt.nanoAiu === "number" && mt.nanoAiu > 0) {
              row.aicCredits += mt.nanoAiu / 1e9;
              row.hasActualCredits = true;
            } else {
              const usage = calculator.calculateCredits(model, mt.prompt, mt.output, mt.cached);
              row.aicCredits += usage.totalCredits;
            }
          }
        } else {
          const row = getOrCreateRow(turn.modelFamily || "unknown");
          row.requests += turnRequests;
          row.prompt += turn.debugPromptTokens;
          row.completion += turn.debugOutputTokens;
          // Surface cache-read tokens under traceCached so the per-model breakdown
          // matches the OTel column layout (Trace Cache / Metric Cache / Effective).
          row.traceCached += turnCached;
          row.cached += turnCached;
          if (turn.debugAicCredits > 0) {
            row.aicCredits += turn.debugAicCredits;
            row.hasActualCredits = true;
          } else {
            const usage = calculator.calculateCredits(
              turn.modelFamily || "unknown",
              turn.debugPromptTokens,
              turn.debugOutputTokens,
              turnCached
            );
            row.aicCredits += usage.totalCredits;
          }
        }
        if (turn.timestamp > lastSeen) {
          lastSeen = turn.timestamp;
        }
        // Pick by per-request timestamp when available (the time the LAST
        // individual llm_request returned, not the turn_start time). This
        // matches the OTel-branch logic so `AIC (last req)` always shows the
        // value of the truly latest API call, not a turn-total surrogate.
        const turnLastTs = turn.debugLastRequestTs || turn.timestamp;
        const bestLastTs = mostRecentTurn
          ? mostRecentTurn.debugLastRequestTs || mostRecentTurn.timestamp
          : "";
        if (!mostRecentTurn || turnLastTs > bestLastTs) {
          mostRecentTurn = turn;
        }
        // sessionAIC: prefer exact billed AIC from copilotUsageNanoAiu when
        // available, otherwise compute from rates using gross input (the
        // calculator subtracts cachedTokens internally to apply the discounted
        // cache-read rate).
        if (turn.debugAicCredits > 0) {
          sessionAIC += turn.debugAicCredits;
        } else {
          const fallbackModel = turn.modelFamily || "unknown";
          const usage = calculator.calculateCredits(fallbackModel, turn.debugPromptTokens, turn.debugOutputTokens, turnCached);
          sessionAIC += usage.totalCredits;
        }
      }

      let lastRequestAIC = 0;
      if (mostRecentTurn) {
        // Prefer per-request value (single API call) over turn total (sum of
        // all llm_requests in the turn).
        if (mostRecentTurn.debugLastRequestAic > 0) {
          lastRequestAIC = mostRecentTurn.debugLastRequestAic;
        } else if (mostRecentTurn.debugAicCredits > 0) {
          lastRequestAIC = mostRecentTurn.debugAicCredits;
        } else {
          const lrUsage = calculator.calculateCredits(
            mostRecentTurn.modelFamily || "unknown",
            mostRecentTurn.debugPromptTokens,
            mostRecentTurn.debugOutputTokens,
            mostRecentTurn.debugCachedTokens || 0,
          );
          lastRequestAIC = lrUsage.totalCredits;
        }
      }

      liveOtel = {
        requests,
        prompt,
        completion,
        cached,
        traceCached: cached,
        metricCached: 0,
        lastSeen,
        source: "debug-log",
        byModel: Array.from(byModelMap.values()).map(row => ({
          ...row,
          aicCredits: Math.round(row.aicCredits * 100) / 100,
          // `hasActualCredits` is carried through by the spread above.
          // Backfilled by the post-processor below.
          isBillable: false,
        })),
        // No ratchet — see OTel branch above for rationale.
        sessionAIC: Math.round(sessionAIC * 100) / 100,
        lastRequestAIC: Math.round(lastRequestAIC * 100) / 100,
        informationalAIC: 0,
      };
    } else {
      liveOtel = {
        requests: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
        traceCached: 0,
        metricCached: 0,
        lastSeen: "",
        source: "none",
        byModel: [],
        sessionAIC: 0,
        lastRequestAIC: 0,
        informationalAIC: 0,
      };
    }
  }

  // ─── Billable scope for live OTel display (issue #5) ──────────
  // Stamp each per-model row with `isBillable` so the webview can flag
  // informational (Ollama / BYOK / unknown) traffic. When
  // `includeOnlyBilledModels` is on (the default), exclude those rows from
  // the headline `sessionAIC` so live AIC reconciles with the cycle total.
  // `lastRequestAIC` is intentionally left untouched — it shows the user
  // the LATEST request's value (even if non-billable), which is the most
  // useful debugging signal.
  liveOtel.byModel = liveOtel.byModel.map(row => ({
    ...row,
    // CRITICAL: pass `row.hasActualCredits` (NOT a hardcoded `false`) so the
    // classifier's rule #2 (hasActualCredits=true → billable) overrides any
    // BYOK / third-party catalog entry the user happens to have in their
    // `chatLanguageModels.json`. Root cause of v1.10.13 bug: hardcoding
    // `false` here demoted Copilot-billed claude-opus-4.7 / gpt-5.3-codex
    // to non-billable for users with BYOK Anthropic configured, dropping
    // `sessionAIC` to 0.00 while individual byModel rows still showed real
    // billed credits. `excludeModels` still wins (user explicit override).
    isBillable: classifyModelBillability(calculator, config, row.model, row.hasActualCredits, classifyByCatalog),
  }));
  // Always recompute the surface AIC values so the dashboard tile + status
  // bar tooltip stay in sync with the byModel classification. When the
  // master switch is off, every row counts as billable (legacy behaviour).
  const billableSession = liveOtel.byModel
    .filter(r => r.isBillable)
    .reduce((s, r) => s + r.aicCredits, 0);
  const informationalSession = liveOtel.byModel
    .filter(r => !r.isBillable)
    .reduce((s, r) => s + r.aicCredits, 0);
  if (config.includeOnlyBilledModels !== false) {
    liveOtel.sessionAIC = Math.round(billableSession * 100) / 100;
  }
  liveOtel.informationalAIC = Math.round(informationalSession * 100) / 100;

  // Limit turnsAll to most recent 500 to keep webview payload small
  const sortedTurns = scan.turns
    .filter(t => t.timestamp)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 500);
  const turnsAll: TurnRow[] = sortedTurns.map(t => ({
    sessionId: t.sessionId,
    timestamp: t.timestamp,
    model: t.modelFamily || 'unknown',
    prompt: t.debugPromptTokens || t.promptTokens,
    output: t.debugOutputTokens || t.outputTokens,
  }));

  // ─── AIC Credit Calculations ──────────────────────────────────

  // Build credit entries from turns (prefer debug-log actuals)
  // ONLY include turns on or after AIC effective date (June 1, 2026)
  // If turns have debugAicCredits (actual API-reported AIC), use those directly
  const aicTurns = scan.turns.filter(t => {
    if (t.debugRequests?.some(req => req.timestamp && req.timestamp.slice(0, 10) >= AIC_EFFECTIVE_DATE)) {
      return true;
    }
    return !!t.timestamp && t.timestamp.slice(0, 10) >= AIC_EFFECTIVE_DATE;
  });

  // Check if we have actual AIC data from the API
  const hasActualAic = aicTurns.some(t => t.debugAicCredits > 0);

  // Per-turn → per-model creditEntries. When the scanner captured a
  // `debugByModel` breakdown (one entry per (model) for all llm_requests in
  // the turn, including merged children), emit one entry per (turn, model)
  // so the AIC dashboard's per-model rows surface auxiliary calls — title
  // generation on gpt-4o-mini, subagent rounds on claude-haiku-4.5, etc.
  // Otherwise fall back to a single entry stamped with the parent turn's
  // modelFamily (legacy behaviour for debug logs that predate per-request
  // model capture, or non-debug-log turns).
  // Each entry carries an explicit `billable` flag. The dashboard is the
  // single place that knows the model identity AND the user's preference
  // (issue #5) — so we classify here, not inside `computeSummary`. This
  // keeps non-billable (Ollama / BYOK / unknown) usage out of the headline
  // total while still letting the calculator surface it under
  // `summary.nonBillable` for an informational panel.
  const creditEntries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    date: string;
    actualCredits?: number;
    billable: boolean;
  }> = [];
  const classify = (model: string, hasActual: boolean): boolean =>
    classifyModelBillability(calculator, config, model, hasActual, classifyByCatalog);
  for (const t of aicTurns) {
    if (t.debugRequests && t.debugRequests.length > 0) {
      for (const req of t.debugRequests) {
        if (!req.timestamp) {
          continue;
        }
        const date = req.timestamp.slice(0, 10);
        if (date < AIC_EFFECTIVE_DATE) {
          continue;
        }
        const hasNano = req.nanoAiu > 0;
        creditEntries.push({
          model: req.model,
          inputTokens: req.prompt,
          outputTokens: req.output,
          cachedTokens: req.cached,
          date,
          actualCredits: hasNano ? req.nanoAiu / 1_000_000_000 : undefined,
          billable: classify(req.model, hasNano),
        });
      }
    } else if (t.timestamp && t.debugByModel) {
      const date = t.timestamp.slice(0, 10);
      for (const [model, mt] of Object.entries(t.debugByModel)) {
        const hasNano = mt.nanoAiu > 0;
        creditEntries.push({
          model,
          inputTokens: mt.prompt,
          outputTokens: mt.output,
          cachedTokens: mt.cached,
          date,
          actualCredits: hasNano ? mt.nanoAiu / 1_000_000_000 : undefined,
          billable: classify(model, hasNano),
        });
      }
    } else if (t.timestamp) {
      const date = t.timestamp.slice(0, 10);
      const hasNano = t.debugAicCredits > 0;
      const model = t.modelFamily || "unknown";
      creditEntries.push({
        model,
        inputTokens: t.debugPromptTokens || t.promptTokens,
        outputTokens: t.debugOutputTokens || t.outputTokens,
        cachedTokens: 0, // cached not available per-turn from chatSession data
        date,
        // Actual AIC from API (if available) — overrides computed credits
        actualCredits: hasNano ? t.debugAicCredits : undefined,
        billable: classify(model, hasNano),
      });
    }
  }

  // Add live OTel data if available (these have cached token info)
  // Only include if current date is on/after AIC effective date
  // IMPORTANT: OTel data may overlap with scanner data for the current session.
  // Scanner/debug-log rows carry exact API-billed credits once flushed; OTel rows
  // are only used for live requests that do not match an individual flushed
  // debug-log request yet.
  const todayStr = new Date().toISOString().slice(0, 10);
  if (liveStats && liveStats.requests > 0 && todayStr >= AIC_EFFECTIVE_DATE) {
    const liveRequestLog = liveStats.requestLog ?? [];
    if (liveRequestLog.length > 0) {
      const debugRequestsToday = debugRequestsFromTurns(aicTurns).filter(
        req => req.timestamp && req.timestamp.slice(0, 10) === todayStr
      );
      for (const req of unflushedOtelRequests(liveRequestLog, debugRequestsToday, todayStr)) {
        creditEntries.push({
          model: req.modelName,
          inputTokens: req.promptTokens,
          outputTokens: req.completionTokens,
          cachedTokens: req.cachedTokens,
          date: todayStr,
          actualCredits: undefined,
          billable: classify(req.modelName, false),
        });
      }
    } else {
      const scanModelsToday = new Set(
        creditEntries.filter(e => e.date === todayStr).map(e => e.model.toLowerCase())
      );
      for (const m of liveStats.byModel.values()) {
        // Legacy fallback for callers that provide aggregate-only LiveStats.
        if (scanModelsToday.has(m.model.toLowerCase())) { continue; }
        creditEntries.push({
          model: m.model,
          inputTokens: m.prompt,
          outputTokens: m.completion,
          cachedTokens: m.cached,
          date: todayStr,
          actualCredits: undefined,
          billable: classify(m.model, false),
        });
      }
    }
  }

  // ─── Agent Session Credit Entries (OMP + Pi) ──────────────────
  // Include OMP and Pi agent sessions in the shared AIC budget.
  // Token convention: agent session `input` is NET (excludes cacheRead/cacheWrite).
  // AICCalculator.calculateCredits expects GROSS input; reconstruct: grossInput = input + cacheRead + cacheWrite.
  let ompCredits = 0;
  let piCredits = 0;
  let ompTokens = 0;
  let piTokens = 0;
  let ompCalls = 0;
  let piCalls = 0;
  if (agentScan) {
    for (const session of agentScan.sessions) {
      const date = new Date(session.lastTs || session.firstTs).toISOString().slice(0, 10);
      if (date < AIC_EFFECTIVE_DATE) { continue; }

      // Session-level token and call counts (accumulated once per session, not per model)
      if (session.source === "omp") {
        ompTokens += session.totalTokens;
        ompCalls  += session.llmCalls;
      } else {
        piTokens += session.totalTokens;
        piCalls  += session.llmCalls;
      }

      // Per-model credit entries for AICCalculator.
      //
      // Prefer the agent's own usage.cost.total ledger when present. OMP/Pi
      // store that field in USD, and agentScanner converts it to AIC credits.
      // Older/cost-less sessions fall back to the token-rate calculator.
      for (const [model, stats] of Object.entries(session.modelBreakdown)) {
        const grossInput = stats.input + stats.cacheRead + stats.cacheWrite;
        const usage = calculator.calculateCredits(model, grossInput, stats.output, stats.cacheRead, stats.cacheWrite);
        const actualCredits = stats.costCredits > 0 ? stats.costCredits : usage.totalCredits;
        const provider = (stats.provider || session.provider || "").toLowerCase();
        const providerIsCopilot = provider.includes("github") || provider.includes("copilot");
        const providerIsThirdParty = provider.length > 0 && !providerIsCopilot;
        const knownCopilotModel = calculator.isKnownGHCModel(model);
        const billable = providerIsCopilot
          ? true
          : providerIsThirdParty
            ? false
            : knownCopilotModel
              ? true
              : classify(model, false);
        if (actualCredits <= 0) {
          continue;
        }
        const displayModel = providerIsThirdParty ? `${provider}/${model}` : model;
        creditEntries.push({
          model: displayModel,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          date,
          actualCredits,
          billable,
        });
        if (billable) {
          if (session.source === "omp") { ompCredits += actualCredits; }
          else { piCredits += actualCredits; }
        }
      }
    }
  }

  // ─── CLI Session Credit Entries (~/.copilot) ──────────────────
  //
  // GitHub Copilot CLI records exact API-billed AIC in
  // session.shutdown.data.modelMetrics.{m}.totalNanoAiu. For sessions
  // without a clean shutdown we fall back to the live walk value
  // (prompts × multiplier) computed in [cliScanner.ts](./cliScanner.ts).
  //
  // We push `actualCredits` directly so it bypasses the token-rate
  // calculator — the same path OMP/Pi take when they have a known credit
  // value. The token fields are left at 0 to avoid double-counting in
  // input/output credit subtotals.
  let cliCredits = 0;
  let cliTokens = 0;
  let cliCalls = 0;
  let cliCreditEntryTotal = 0;
  if (cliScan) {
    for (const session of cliScan.sessions) {
      const date = new Date(session.lastTs || session.firstTs).toISOString().slice(0, 10);
      if (date < AIC_EFFECTIVE_DATE) { continue; }
      cliCalls += session.totalLivePrompts;
      for (const [model, stats] of Object.entries(session.byModel)) {
        cliTokens += stats.liveOutputTokens;
        // Per-model AIC: ledger wins (authoritative), live fallback otherwise.
        const aic = stats.ledgerAic !== undefined ? stats.ledgerAic : stats.liveAic;
        if (aic <= 0) { continue; }
        // The CLI scanner only reads @github/copilot session-state files. If it
        // produced a positive ledger/live AIC value, trust that source directly
        // instead of letting BYOK/runtime catalog aliases demote it to zero.
        const billable = true;
        creditEntries.push({
          model,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          date,
          actualCredits: aic,
          billable,
        });
        cliCreditEntryTotal += aic;
        if (billable) {
          cliCredits += aic;
        }
      }
    }
    const cliDelta = Math.round((cliScan.totalAic - cliCreditEntryTotal) * 100) / 100;
    if (cliDelta > 0) {
      const fallbackDate = new Date().toISOString().slice(0, 10);
      creditEntries.push({
        model: "github-copilot-cli",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        date: fallbackDate,
        actualCredits: cliDelta,
        billable: true,
      });
      cliCredits += cliDelta;
    }
    if (cliCredits <= 0 && cliCalls > 0) {
      let promptFallback = 0;
      for (const session of cliScan.sessions) {
        const date = new Date(session.lastTs || session.firstTs).toISOString().slice(0, 10);
        if (date < AIC_EFFECTIVE_DATE) { continue; }
        for (const stats of Object.values(session.byModel)) {
          promptFallback += stats.livePrompts * (stats.multiplier > 0 ? stats.multiplier : 1);
        }
        if (Object.keys(session.byModel).length === 0) {
          promptFallback += session.totalLivePrompts;
        }
      }
      const fallbackAic = Math.round(promptFallback * 100) / 100;
      if (fallbackAic > 0) {
        creditEntries.push({
          model: "github-copilot-cli",
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          date: new Date().toISOString().slice(0, 10),
          actualCredits: fallbackAic,
          billable: true,
        });
        cliCredits += fallbackAic;
      }
    }
  }

  const summary = calculator.computeSummary(creditEntries);

  // Promo detection: auto-detect if we're in the June 1 – Sept 1, 2026 window
  const promoInfo = getPromoInfo(config.plan, summary.plan.monthlyCreditsIncluded);
  const totalCr = Math.round(summary.totalCredits * 100) / 100;

  // Compute overage under both promo and standard budgets
  const overageStandard = Math.max(0, totalCr - promoInfo.standardBudget) * (config.overageCostPerCredit ?? 0.01);
  const overagePromo = promoInfo.promoBudget > 0
    ? Math.max(0, totalCr - promoInfo.promoBudget) * (config.overageCostPerCredit ?? 0.01)
    : 0;

  // If promo is active, use promo budget as the effective budget
  const effectiveBudget = promoInfo.isPromoActive && promoInfo.promoBudget > 0
    ? promoInfo.promoBudget
    : summary.plan.monthlyCreditsIncluded;
  const effectiveRemaining = Math.max(0, effectiveBudget - totalCr);
  const effectiveOverage = Math.max(0, totalCr - effectiveBudget) * (config.overageCostPerCredit ?? 0.01);

  const aicSummary: AICDashboardData = {
    totalCredits: totalCr,
    inputCredits: Math.round(summary.inputCredits * 100) / 100,
    outputCredits: Math.round(summary.outputCredits * 100) / 100,
    cachedCredits: Math.round(summary.cachedCredits * 100) / 100,
    planName: summary.plan.planName,
    monthlyBudget: effectiveBudget,
    creditsRemaining: Math.round(effectiveRemaining * 100) / 100,
    estimatedOverageCost: Math.round(effectiveOverage * 100) / 100,
    billingCycleStart: summary.billingCycleStart,
    billingCycleEnd: summary.billingCycleEnd,
    daysRemaining: summary.daysRemaining,
    dailyAverage: Math.round(summary.dailyAverage * 100) / 100,
    projectedTotal: Math.round(summary.projectedTotal * 100) / 100,
    byModel: Array.from(summary.byModel.values()).map(m => ({
      model: m.model,
      tier: m.tier,
      inputCredits: Math.round(m.inputCredits * 100) / 100,
      outputCredits: Math.round(m.outputCredits * 100) / 100,
      cachedCredits: Math.round(m.cachedCredits * 100) / 100,
      totalCredits: Math.round(m.totalCredits * 100) / 100,
    })).sort((a, b) => b.totalCredits - a.totalCredits),
    byDay: Array.from(summary.byDay.entries())
      .map(([day, credits]) => ({ day, credits: Math.round(credits * 100) / 100 }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    config,
    nonBillable: {
      totalCredits: Math.round(summary.nonBillable.totalCredits * 100) / 100,
      byModel: Array.from(summary.nonBillable.byModel.values()).map(m => ({
        model: m.model,
        tier: m.tier,
        inputCredits: Math.round(m.inputCredits * 100) / 100,
        outputCredits: Math.round(m.outputCredits * 100) / 100,
        cachedCredits: Math.round(m.cachedCredits * 100) / 100,
        totalCredits: Math.round(m.totalCredits * 100) / 100,
      })).sort((a, b) => b.totalCredits - a.totalCredits),
    },
    promo: {
      isPromoActive: promoInfo.isPromoActive,
      promoBudget: promoInfo.promoBudget,
      standardBudget: promoInfo.standardBudget,
      overageWithoutPromo: Math.round(overageStandard * 100) / 100,
      overageWithPromo: Math.round(overagePromo * 100) / 100,
      creditsRemainingPromo: promoInfo.promoBudget > 0 ? Math.round(Math.max(0, promoInfo.promoBudget - totalCr) * 100) / 100 : 0,
      creditsRemainingStandard: Math.round(Math.max(0, promoInfo.standardBudget - totalCr) * 100) / 100,
      promoEndDate: promoInfo.promoEndDate,
    },
    isActualFromApi: hasActualAic,
  };

  // ─── Per-Source Usage Summary ─────────────────────────────────
  // vscodeAicCredits = total − agent contributions (computed here since summary is now available)
  const vscodeTurnTokens = scan.turns.reduce(
    (s, t) => s + (t.debugPromptTokens || t.promptTokens) + (t.debugOutputTokens || t.outputTokens),
    0,
  );
  const agentSummary: AgentUsageSummary = {
    vscodeSessions:    scan.sessions.length,
    vscodeTurns:       scan.turns.length,
    vscodeTotalTokens: vscodeTurnTokens,
    // Residual AIC after subtracting every non-VSCode source so the four
    // columns in the dashboard reconcile to summary.totalCredits exactly.
    vscodeAicCredits:  Math.round((summary.totalCredits - ompCredits - piCredits - cliCredits) * 100) / 100,

    ompSessions:    agentScan?.ompSessionCount ?? 0,
    ompLlmCalls:    ompCalls,
    ompTotalTokens: ompTokens,
    ompTotalCredits:   Math.round(ompCredits * 100) / 100,
    ompAllTimeLlmCalls: agentScan?.ompAllTimeLlmCalls ?? 0,
    ompAllTimeTokens:   agentScan?.ompAllTimeTokens   ?? 0,

    piSessions:    agentScan?.piSessionCount ?? 0,
    piLlmCalls:    piCalls,
    piTotalTokens: piTokens,
    piTotalCredits:    Math.round(piCredits  * 100) / 100,
    piAllTimeLlmCalls: agentScan?.piAllTimeLlmCalls  ?? 0,
    piAllTimeTokens:   agentScan?.piAllTimeTokens    ?? 0,

    cliSessions:        cliScan?.sessions.length ?? 0,
    cliLlmCalls:        cliCalls,
    cliTotalTokens:     cliTokens,
    cliTotalCredits:    Math.round(cliCredits * 100) / 100,
    cliAllTimeSessions: cliScan?.allTimeSessions ?? 0,
    cliAllTimeLlmCalls: cliScan?.allTimeLivePrompts ?? 0,
    cliAllTimeTokens:   cliScan?.allTimeOutputTokens ?? 0,
    cliDriftAic:        cliScan?.driftAic ?? 0,
    cliReconciledSessions: cliScan?.reconciledSessions ?? 0,
    cliLiveOnlySessions:   cliScan?.liveOnlySessions ?? 0,
    cliCopilotHome:        cliScan?.copilotHome ?? "",

    totalSessions:
      scan.sessions.length
      + (agentScan?.ompSessionCount ?? 0)
      + (agentScan?.piSessionCount ?? 0)
      + (cliScan?.sessions.length ?? 0),
    totalCredits:  Math.round(summary.totalCredits * 100) / 100,
    scanMs:        (agentScan?.scanMs ?? 0) + (cliScan?.scanMs ?? 0),
  };

  // Determine current session AIC (most recent session with activity)
  const sortedSessions = [...sessionsAll].sort((a, b) => (b.last || "").localeCompare(a.last || ""));
  const currentSessionAIC = sortedSessions.length > 0 ? sortedSessions[0].aicCredits : 0;

  return {
    allModels,
    dailyByModel,
    sessionsAll,
    toolsAll,
    subagentsAll,
    turnsAll,
    liveOtel,
    scanStats: scan.stats,
    generatedAt: new Date().toLocaleString('en-CA', { hour12: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace(',', ''),
    aicSummary,
    currentSessionAIC,
    agentSummary,
  };
}

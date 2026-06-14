/**
 * dashboardData.ts — Aggregate scanner results into dashboard-ready data.
 * Ports get_dashboard_data() from dashboard.py to TypeScript.
 */

import { ScanResult, Session, Turn, ToolCall, Subagent, ScanStats } from "./scanner";
import { AgentScanResult } from "./agentScanner";
import { LiveStats } from "./otelReceiver";
import { AICCalculator, AICConfig, DEFAULT_AIC_CONFIG, createCalculatorFromConfig, getPromoInfo } from "./aicCredits";

/**
 * AIC billing effective date. Only sessions/turns on or after this date
 * are included in AI Credit calculations.
 * GitHub Copilot usage-based billing started June 1, 2026.
 */
export const AIC_EFFECTIVE_DATE = "2026-06-01";

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
  }>;
  /** Session-cumulative AIC credits computed from live OTel data */
  sessionAIC: number;
  /** Last single request's AIC credits */
  lastRequestAIC: number;
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

/**
 * Per-activation high-water mark for `liveOtel.sessionAIC`.
 *
 * Why this exists: the per-model overlay in the OTel branch below replaces
 * the rate-table estimate with the exact `copilotUsageNanoAiu` value when
 * the debug log catches up. For models whose OTel traces are missing cache
 * attributes (notably Anthropic Opus), the rate estimate over-counts, so
 * when the exact value lands the per-model credits — and therefore
 * sessionAIC — DROP. v1.10.6 made the dashboard tick on every OTel batch
 * (not just the debounced 2s scan), so users now see the corrected value
 * land ~2s after the over-estimate flashes, producing a visible decrease
 * like 147 → 138 between consecutive requests.
 *
 * Session cumulative AIC must be monotonically non-decreasing. We ratchet
 * to the high-water mark per activation; the per-model breakdown table
 * still shows the corrected exact values, only the rolled-up
 * `sessionAIC` number is locked from going backward.
 *
 * Keyed by `activationTime` so a window reload resets to zero — a fresh
 * activation correctly starts a new "session" for this purpose.
 *
 * NOTE: this is a per-process cache (lives in the extension host). It is
 * cleared automatically by the activation-time key change; no explicit
 * reset call is needed.
 */
const _sessionAICRatchet = new Map<string, number>();

/**
 * Apply the per-activation monotonic ratchet to a candidate sessionAIC value.
 * Returns max(candidate, previously-seen-max for this activation).
 *
 * `activationTime` is the cache key — when it changes (window reload), the
 * ratchet effectively resets because the new key has no prior entry. We do
 * not bother to evict stale entries; the map grows by 1 per VS Code window
 * lifetime, which is bounded and negligible.
 *
 * If `activationTime` is unset (e.g. tests or older callers), ratcheting is
 * disabled and the candidate value passes through unchanged — those call
 * sites either don't care about live UX (tests) or pre-date the live-tick
 * path that exposes the flicker.
 */
function applySessionAICRatchet(activationTime: string | undefined, candidate: number): number {
  if (!activationTime) {
    return candidate;
  }
  const prev = _sessionAICRatchet.get(activationTime) ?? 0;
  const next = candidate > prev ? candidate : prev;
  if (next !== prev) {
    _sessionAICRatchet.set(activationTime, next);
  }
  return next;
}

export function buildDashboardData(scan: ScanResult, liveStats: LiveStats | null, aicConfig?: AICConfig, agentScan?: AgentScanResult, activationTime?: string): DashboardData {
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
    const exactByModelAiu = new Map<string, number>();
    for (const t of scan.turns) {
      if (!t.timestamp || t.timestamp.slice(0, 10) !== todayDate) {
        continue;
      }
      if (activationTime && t.timestamp < activationTime) {
        continue;
      }
      if (!t.debugByModel) {
        continue;
      }
      for (const [model, mt] of Object.entries(t.debugByModel)) {
        if (typeof mt.nanoAiu !== "number" || mt.nanoAiu <= 0) {
          continue;
        }
        const key = model.toLowerCase();
        exactByModelAiu.set(key, (exactByModelAiu.get(key) ?? 0) + mt.nanoAiu);
      }
    }

    const byModel = Array.from(liveStats.byModel.values()).map(m => {
      const exactNano = exactByModelAiu.get(m.model.toLowerCase());
      const estimate = calculator.calculateCredits(m.model, m.prompt, m.completion, m.cached, m.cacheWrite).totalCredits;
      // Prefer API-exact when this model has any billed AIU today; otherwise
      // keep the rate-table estimate so newly-seen models still show a value.
      const credits = typeof exactNano === "number" && exactNano > 0 ? exactNano / 1e9 : estimate;
      return {
        model: m.model,
        requests: m.requests,
        prompt: m.prompt,
        completion: m.completion,
        traceCached: m.traceCached,
        metricCached: m.metricCached,
        cached: m.cached,
        aicCredits: Math.round(credits * 100) / 100,
      };
    });
    // Compute session-cumulative AIC from live OTel (sum of per-model credits).
    // When the debug-log overlay landed on every row this is API-exact; when
    // some models fell back to rate estimates it's a hybrid -- the explicit
    // debug-log overlay below still has a chance to tighten the final number.
    let sessionAIC = 0;
    for (const row of byModel) {
      sessionAIC += row.aicCredits;
    }
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
    const debugTurnsToday = scan.turns.filter(
      t =>
        t.timestamp &&
        t.timestamp.slice(0, 10) === todayDate &&
        t.debugAicCredits > 0 &&
        (!activationTime || t.timestamp >= activationTime)
    );
    if (debugTurnsToday.length > 0) {
      // sessionAIC: take the larger of (OTel-derived, debug-log today sum) to
      // avoid regressing when OTel has newer in-flight requests not yet flushed.
      const debugSessionAIC = debugTurnsToday.reduce((s, t) => s + t.debugAicCredits, 0);
      sessionAIC = Math.max(sessionAIC, debugSessionAIC);

      // lastRequestAIC: pick the turn whose LAST individual llm_request is
      // most recent, then use that single request's AIC — not the turn total.
      // (A turn with 15 tool calls has 15 llm_request entries; summing them
      // would show ~10x the actual just-finished API call's bill.) Falls back
      // to the turn-total `debugAicCredits` if per-request data is missing.
      const mostRecentDebug = debugTurnsToday.reduce((best, t) => {
        const tTs = t.debugLastRequestTs || t.timestamp;
        const bTs = best ? best.debugLastRequestTs || best.timestamp : "";
        return !best || tTs > bTs ? t : best;
      }, undefined as Turn | undefined);
      const otelLastTs = liveStats.lastRequest?.timestamp ?? "";
      if (mostRecentDebug) {
        const debugTs = mostRecentDebug.debugLastRequestTs || mostRecentDebug.timestamp;
        if (debugTs >= otelLastTs || lastRequestAIC === 0) {
          lastRequestAIC = mostRecentDebug.debugLastRequestAic > 0
            ? mostRecentDebug.debugLastRequestAic
            : mostRecentDebug.debugAicCredits;
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
      sessionAIC: applySessionAICRatchet(activationTime, Math.round(sessionAIC * 100) / 100),
      lastRequestAIC: Math.round(lastRequestAIC * 100) / 100,
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

    if (debugTurnsToday.length > 0) {
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
        })),
        sessionAIC: applySessionAICRatchet(activationTime, Math.round(sessionAIC * 100) / 100),
        lastRequestAIC: Math.round(lastRequestAIC * 100) / 100,
      };
    } else {
      liveOtel = { requests: 0, prompt: 0, completion: 0, cached: 0, traceCached: 0, metricCached: 0, lastSeen: "", source: "none", byModel: [], sessionAIC: 0, lastRequestAIC: 0 };
    }
  }

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
  const aicTurns = scan.turns.filter(t => t.timestamp && t.timestamp.slice(0, 10) >= AIC_EFFECTIVE_DATE);

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
  const creditEntries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    date: string;
    actualCredits?: number;
  }> = [];
  for (const t of aicTurns) {
    const date = t.timestamp.slice(0, 10);
    if (t.debugByModel) {
      for (const [model, mt] of Object.entries(t.debugByModel)) {
        creditEntries.push({
          model,
          inputTokens: mt.prompt,
          outputTokens: mt.output,
          cachedTokens: mt.cached,
          date,
          actualCredits: mt.nanoAiu > 0 ? mt.nanoAiu / 1_000_000_000 : undefined,
        });
      }
    } else {
      creditEntries.push({
        model: t.modelFamily || "unknown",
        inputTokens: t.debugPromptTokens || t.promptTokens,
        outputTokens: t.debugOutputTokens || t.outputTokens,
        cachedTokens: 0, // cached not available per-turn from chatSession data
        date,
        // Actual AIC from API (if available) — overrides computed credits
        actualCredits: t.debugAicCredits > 0 ? t.debugAicCredits : undefined,
      });
    }
  }

  // Add live OTel data if available (these have cached token info)
  // Only include if current date is on/after AIC effective date
  // IMPORTANT: OTel data may overlap with scanner data for the current session.
  // To avoid double-counting, we only add OTel data if the scanner found NO turns
  // for today. If scanner already has today's data, it's more complete (has per-turn
  // granularity) — OTel would just duplicate it without the cached breakdown.
  const todayStr = new Date().toISOString().slice(0, 10);
  // Models already covered by scanner data for today — avoid double-counting these
  const scanModelsToday = new Set(
    creditEntries.filter(e => e.date === todayStr).map(e => e.model.toLowerCase())
  );
  if (liveStats && liveStats.requests > 0 && todayStr >= AIC_EFFECTIVE_DATE) {
    for (const m of liveStats.byModel.values()) {
      // Skip models already in today's scanner data (would double-count).
      // Always add models that only appear in OTel (scanner hasn't seen them).
      if (scanModelsToday.has(m.model.toLowerCase())) { continue; }
      creditEntries.push({
        model: m.model,
        inputTokens: m.prompt,
        outputTokens: m.completion,
        cachedTokens: m.cached,
        date: todayStr,
        actualCredits: undefined,
      });
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

      // Per-model credit entries for AICCalculator
      for (const [model, stats] of Object.entries(session.modelBreakdown)) {
        const grossInput = stats.input + stats.cacheRead + stats.cacheWrite;
        const usage = calculator.calculateCredits(model, grossInput, stats.output, stats.cacheRead, stats.cacheWrite);
        creditEntries.push({
          model,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          date,
          actualCredits: usage.totalCredits,
        });
        if (session.source === "omp") { ompCredits += usage.totalCredits; }
        else { piCredits += usage.totalCredits; }
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
    vscodeAicCredits:  Math.round((summary.totalCredits - ompCredits - piCredits) * 100) / 100,

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

    totalSessions: scan.sessions.length + (agentScan?.ompSessionCount ?? 0) + (agentScan?.piSessionCount ?? 0),
    totalCredits:  Math.round(summary.totalCredits * 100) / 100,
    scanMs:        agentScan?.scanMs ?? 0,
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

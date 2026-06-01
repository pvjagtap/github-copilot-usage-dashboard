/**
 * dashboardData.ts — Aggregate scanner results into dashboard-ready data.
 * Ports get_dashboard_data() from dashboard.py to TypeScript.
 */

import { ScanResult, Session, Turn, ToolCall, Subagent, ScanStats } from "./scanner";
import { LiveStats } from "./otelReceiver";
import { AICCalculator, AICConfig, CreditSummary, DEFAULT_AIC_CONFIG, createCalculatorFromConfig, getPromoInfo } from "./aicCredits";

/**
 * AIC billing effective date. Only sessions/turns on or after this date
 * are included in AI Credit calculations.
 * GitHub Copilot usage-based billing started June 1, 2026.
 */
const AIC_EFFECTIVE_DATE = "2026-06-01";

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
  }>;
}

// ─── Aggregation ──────────────────────────────────────────────

function computeDaily(turns: Turn[]): DailyRow[] {
  const map = new Map<string, DailyRow>();
  for (const t of turns) {
    if (!t.timestamp) { continue; }
    const day = t.timestamp.slice(0, 10);
    const model = t.modelFamily || "unknown";
    const key = `${day}:${model}`;
    // Prefer debug-log actual tokens over chatSession snapshot
    const prompt = t.debugPromptTokens || t.promptTokens;
    const output = t.debugOutputTokens || t.outputTokens;
    const existing = map.get(key);
    if (existing) {
      existing.prompt += prompt;
      existing.output += output;
      existing.toolRounds += t.toolCallRounds;
      existing.turns++;
    } else {
      map.set(key, { day, model, prompt, output, toolRounds: t.toolCallRounds, turns: 1 });
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

export function buildDashboardData(scan: ScanResult, liveStats: LiveStats | null, aicConfig?: AICConfig): DashboardData {
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
    const byModel = Array.from(liveStats.byModel.values()).map(m => ({
      model: m.model,
      requests: m.requests,
      prompt: m.prompt,
      completion: m.completion,
      traceCached: m.traceCached,
      metricCached: m.metricCached,
      cached: m.cached,
    }));
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
    };
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const debugTurnsToday = scan.turns.filter(t => t.timestamp && t.timestamp.slice(0, 10) === today && (t.debugPromptTokens > 0 || t.debugOutputTokens > 0));

    if (debugTurnsToday.length > 0) {
      const byModelMap = new Map<string, { model: string; requests: number; prompt: number; completion: number; traceCached: number; metricCached: number; cached: number }>();
      let requests = 0;
      let prompt = 0;
      let completion = 0;
      let lastSeen = "";

      for (const turn of debugTurnsToday) {
        const model = turn.modelFamily || "unknown";
        if (!byModelMap.has(model)) {
          byModelMap.set(model, { model, requests: 0, prompt: 0, completion: 0, traceCached: 0, metricCached: 0, cached: 0 });
        }
        const row = byModelMap.get(model)!;
        const turnRequests = Math.max(1, turn.debugLlmCalls || 0);
        requests += turnRequests;
        prompt += turn.debugPromptTokens;
        completion += turn.debugOutputTokens;
        row.requests += turnRequests;
        row.prompt += turn.debugPromptTokens;
        row.completion += turn.debugOutputTokens;
        if (turn.timestamp > lastSeen) {
          lastSeen = turn.timestamp;
        }
      }

      liveOtel = {
        requests,
        prompt,
        completion,
        cached: 0,
        traceCached: 0,
        metricCached: 0,
        lastSeen,
        source: "debug-log",
        byModel: Array.from(byModelMap.values()),
      };
    } else {
      liveOtel = { requests: 0, prompt: 0, completion: 0, cached: 0, traceCached: 0, metricCached: 0, lastSeen: "", source: "none", byModel: [] };
    }
  }

  const turnsAll: TurnRow[] = scan.turns
    .filter(t => t.timestamp)
    .map(t => ({
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

  const creditEntries = aicTurns.map(t => ({
      model: t.modelFamily || "unknown",
      inputTokens: t.debugPromptTokens || t.promptTokens,
      outputTokens: t.debugOutputTokens || t.outputTokens,
      cachedTokens: 0, // cached not available per-turn from chatSession data
      date: t.timestamp.slice(0, 10),
      // Actual AIC from API (if available) — overrides computed credits
      actualCredits: t.debugAicCredits > 0 ? t.debugAicCredits : undefined,
    }));

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
  };
}

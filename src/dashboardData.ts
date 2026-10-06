/**
 * dashboardData.ts — Aggregate scanner results into dashboard-ready data.
 * Ports get_dashboard_data() from dashboard.py to TypeScript.
 */

import { ScanResult, Session, Turn, ToolCall, Subagent, ScanStats, DebugRequest, providerLabel } from "./scanner";
import { AgentScanResult } from "./agentScanner";
import { CliScanResult } from "./cliScanner";
import { LiveStats, OTelRequest } from "./otelReceiver";
import { AICCalculator, AICConfig, CreditUsage, DEFAULT_AIC_CONFIG, createCalculatorFromConfig, getPromoInfo, classifyModelBillability, isByokWrapperCall, isCopilotVendor } from "./aicCredits";
import { ByokPricingConfig, mergePricingConfig, priceTokens } from "./byokPricing";
import { classifyByCatalog, getCachedCatalog } from "./modelCatalog";
import { MachineView } from "./machineSync";
import { computeCacheHit } from "./cache";
import { QuotaSnapshot } from "./quotaSnapshot";
import { dateUnattributed, DatedCredits, LedgerPoint, LocalEvent } from "./ledgerHistory";

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

/**
 * Whether `turn`'s recorded vendor describes this particular request.
 *
 * A turn dispatches more than the model the user picked: title generation,
 * history summarisation and subagent rounds run on their own models via
 * Copilot's route, so the turn's vendor must not be pinned to those. Matching
 * the model is the usual proof, but a request dispatched through the public
 * LanguageModelChat wrapper is BYOK-served by definition — that holds even
 * when a subagent within the turn ran a different model on the same provider,
 * which the model check alone would reject.
 */
function vendorApplies(turn: Turn, model: string, debugName?: string): boolean {
  if (!turn.modelVendor) {
    return false;
  }
  if (modelFamily(model) === modelFamily(turn.modelFamily)) {
    return true;
  }
  return isByokWrapperCall(debugName) && !isCopilotVendor(turn.modelVendor);
}

/** The vendor VS Code recorded for `model` within `turn`, or undefined. */
function vendorFor(turn: Turn, model: string, debugName?: string): string | undefined {
  return vendorApplies(turn, model, debugName) ? turn.modelVendor : undefined;
}

/** Provider display name for `model`, under the same guard as `vendorFor`. */
function providerFor(turn: Turn, model: string, debugName?: string): string | undefined {
  if (!turn.modelProvider) {
    return undefined;
  }
  return vendorApplies(turn, model, debugName) ? turn.modelProvider : undefined;
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
  /** Distinct `description` args, in first-seen order — what each run was for. */
  descriptions: string[];
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
  /** Cumulative cache-read (input) tokens from debug-logs. 0 if not reported. Used for cache-hit-rate. */
  actualCached: number;
  /** Cached / prompt * 100 for this session. Pre-computed via cache.ts — do NOT inline the formula in consumers. */
  cacheHitPct: number;
  toolRounds: number;
  toolCalls: number;
  subagents: number;
  sourcePaths: string[];
  transcriptPaths: string[];
  /** AI Credits consumed by this session (0 if before AIC effective date) */
  aicCredits: number;
  /**
   * Billable AIC credits split by the day each request actually ran, derived
   * from the same `creditEntries` list that feeds `computeSummary`. Empty for
   * pre-AIC sessions, which keep the rate-table estimate in `aicCredits`.
   *
   * Consumers MUST range-filter on this instead of pinning `aicCredits` to
   * `lastDate` — a session that spans a month boundary otherwise reports its
   * whole lifetime spend inside whichever month it last ran in.
   */
  aicByDay: Array<{ day: string; credits: number }>;
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
  /**
   * Lower-cased model id → CAPI billing multiplier. Snapshot of the live
   * catalog passed to the webview so the dashboard never needs a
   * hardcoded fallback multiplier table.
   */
  modelMultipliers: Record<string, number>;
  /**
   * Per-machine usage rollups shared over Settings Sync. Populated by the
   * caller (which owns the ExtensionContext); empty when sync is off or only
   * this machine has reported.
   */
  machines?: MachineView[];
  /** Σ `machines[].cycleCredits` for the current cycle. */
  combinedCycleCredits?: number;
  /**
   * Prompt-cache TTL anchors keyed by sessionId, populated by the caller from
   * `TtlTracker`. Raw epoch-ms + thresholds rather than a rendered countdown,
   * so the webview can tick the clock itself between data pushes. Empty or
   * absent when `copilotUsage.cacheTtl.enabled` is off.
   */
  ttlBySession?: Record<string, TtlAnchor>;
}

/** Everything the webview needs to render a live countdown for one session. */
export interface TtlAnchor {
  lastRequestMs: number;
  timerValue: number;
  warnAt: number;
  alertAt: number;
  working: boolean;
  provider: string;
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
  /** Legacy pre-AIC allowance: premium requests included per user/month (typically 300 for Business). */
  includedPremiumRequests: number;
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
  /**
   * `byDay` before GitHub's ledger delta is folded in — credits this machine's
   * own logs account for. `byDay`/`totalCredits` adopt the account-wide
   * `quota_snapshots` figure, which on a pooled seat covers every machine, IDE
   * and org member, so anything per-machine must read these instead.
   */
  localByDay: Array<{ day: string; credits: number }>;
  /** Σ `localByDay` — the machine-local total behind `totalCredits`. */
  localTotalCredits: number;
  /**
   * Billable credits per day that belong to no scanned VS Code chat session —
   * live OTel requests not yet flushed to a debug log, plus OMP / Pi / CLI
   * agent sessions. `byDay` = Σ SessionView.aicByDay + this, per day.
   *
   * The Usage-by-Model table renders these as their own rows so its TOTAL row
   * reconciles exactly with the hero "AI Credits Spent" tile.
   */
  unattributedByDay: Array<{ day: string; credits: number }>;
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
    /**
     * What the user's OWN provider charges for this traffic, in USD. A
     * different vendor's bill in a different currency — never added to
     * credits. Undefined when no configured rate matched the row.
     */
    totalProviderUsd?: number;
    byModel: Array<{
      model: string;
      tier: string;
      inputCredits: number;
      outputCredits: number;
      cachedCredits: number;
      totalCredits: number;
      providerUsd?: number;
    }>;
    /**
     * Per-day, per-model rows. The webview re-aggregates these for the
     * selected date range so the informational panel tracks the same window
     * as the billable tables above (`byModel` stays whole-cycle).
     */
    byDay: Array<{
      day: string;
      model: string;
      tier: string;
      inputCredits: number;
      outputCredits: number;
      cachedCredits: number;
      totalCredits: number;
      providerUsd?: number;
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
  /**
   * Reconciliation against GitHub's own credit ledger
   * (`/copilot_internal/user` → `quota_snapshots`). Absent when the endpoint
   * was unreachable, in which case every figure above is locally derived.
   */
  quota?: {
    /** AI credits GitHub has billed this cycle — authoritative. */
    creditsUsed: number;
    /** Cycle entitlement (pooled for Business/Enterprise). */
    entitlement: number;
    /** Credits left before overage. */
    remaining: number;
    /** `creditsUsed` − locally derived total. Positive ⇒ we under-counted. */
    localDelta: number;
    /** The locally derived total, retained for the drift diagnostic. */
    localTotal: number;
    /**
     * Day `localDelta` was booked onto in `byDay`. The remainder has no known
     * per-day distribution, so surfaces that plot shape (the calendar) must
     * exclude it rather than render it as a real day's spend.
     */
    anchorDay?: string;
    /**
     * Part of `localDelta` placed on the days GitHub's ledger rose faster than
     * the local logs did, from the polling history. Already included in
     * `byDay` on those days; `localDelta` minus their sum is what is still
     * parked on `anchorDay`.
     */
    datedByDay?: DatedCredits[];
    /** Whether overage spend is permitted on this seat. */
    overagePermitted: boolean;
    /** Server timestamp of the snapshot. */
    timestampUtc?: string;
  };
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
    /** cached / prompt * 100. Pre-computed here so the webview never repeats the formula (see cache.ts). */
    cacheHitPct: number;
  }>;
  /** Session-cumulative AIC credits computed from live OTel data */
  sessionAIC: number;
  /** Last single request's AIC credits */
  lastRequestAIC: number;
  /** cached / prompt * 100 across all byModel rows (see cache.ts). */
  cacheHitPct: number;
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
  // Bounded so a session that spawns hundreds of subagents cannot bloat the
  // webview payload with near-duplicate task labels.
  const MAX_DESCRIPTIONS = 12;
  for (const sa of subagents) {
    const key = `${sa.sessionId}:${sa.agentName}`;
    const existing = map.get(key);
    const row = existing ?? { sessionId: sa.sessionId, agentName: sa.agentName, count: 0, descriptions: [] };
    row.count++;
    const d = sa.description.trim();
    if (d && row.descriptions.length < MAX_DESCRIPTIONS && !row.descriptions.includes(d)) {
      row.descriptions.push(d);
    }
    if (!existing) { map.set(key, row); }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function computeSessionViews(sessions: Session[], toolCalls: ToolCall[], turns: Turn[], calculator: AICCalculator): SessionView[] {
  // Tool call counts per session
  const toolCountMap = new Map<string, number>();
  for (const tc of toolCalls) {
    toolCountMap.set(tc.sessionId, (toolCountMap.get(tc.sessionId) ?? 0) + 1);
  }

  // Per-session cached (cache-read) input tokens from debug logs. Used for
  // the cache-hit-rate metric (cached / prompt — prompt already includes
  // cached as a subset, see aicCredits.ts:452) shown in the dashboard
  // Sessions table and Live OTel stats-row.
  const sessionCachedMap = new Map<string, number>();
  for (const t of turns) {
    if (t.debugCachedTokens > 0) {
      sessionCachedMap.set(t.sessionId, (sessionCachedMap.get(t.sessionId) ?? 0) + t.debugCachedTokens);
    }
  }

  // Per-session AIC credits, computed for EVERY turn regardless of date.
  // Prefer actual API-reported AIC (debugAicCredits) over computed from rates.
  //
  // Pre-2026-06-01 turns predate AIC billing so they never carry
  // `copilotUsageNanoAiu` — they fall through to the rate-table estimate.
  // The `date < AIC_EFFECTIVE_DATE` skip that used to live here zeroed those
  // sessions, and since the dashboard's historical ranges are built from
  // `SessionView.aicCredits` (the `aicSummary.byDay` map only covers the
  // current billing cycle), every month before June rendered 0.0 credits
  // despite having full token data.
  const sessionCreditsMap = new Map<string, number>();
  for (const t of turns) {
    if (!t.timestamp) { continue; }
    let credits: number;
    if (t.debugAicCredits > 0) {
      // Use actual API-reported AIC (includes cache discounts)
      credits = t.debugAicCredits;
    } else {
      // Fallback: rate-table estimate. Cache-read tokens are a subset of
      // prompt tokens, so passing them lets the calculator apply the cached
      // rate instead of billing the whole prompt at full input price —
      // without it a cache-heavy pre-AIC month over-reports by ~10x.
      const inputTokens = t.debugPromptTokens || t.promptTokens;
      const outputTokens = t.debugOutputTokens || t.outputTokens;
      const cachedTokens = t.debugCachedTokens || 0;
      credits = calculator.calculateCredits(t.modelFamily || "unknown", inputTokens, outputTokens, cachedTokens).totalCredits;
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
    const sessionPrompt = s.debugTotalPrompt || s.totalPromptTokens;
    const sessionCached = sessionCachedMap.get(s.sessionId) ?? 0;

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
      actualCached: sessionCached,
      cacheHitPct: computeCacheHit(sessionPrompt, sessionCached).pct,
      toolRounds: s.toolCallRounds,
      toolCalls: toolCountMap.get(s.sessionId) ?? 0,
      subagents: s.subagentCalls,
      sourcePaths: s.sourcePaths || [],
      transcriptPaths: s.transcriptPaths || [],
      aicCredits: Math.round((sessionCreditsMap.get(s.sessionId) ?? 0) * 100) / 100,
      aicByDay: [],
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

/**
 * Every dated spend the local logs can vouch for with an exact credit figure:
 * VS Code requests that carry GitHub's own `copilotUsageNanoAiu` (recovered
 * ones are dated at the request that was lost) and OMP/Pi calls routed through
 * Copilot. Rate-estimated rows are left out — they were never read from a bill.
 */
function ledgerLocalEvents(scan: ScanResult, agentScan?: AgentScanResult): LocalEvent[] {
  const events: LocalEvent[] = [];
  for (const turn of scan.turns) {
    for (const req of turn.debugRequests ?? []) {
      const t = Date.parse(req.timestamp);
      if (req.nanoAiu > 0 && t > 0) {
        events.push({ t, credits: req.nanoAiu / 1e9 });
      }
    }
  }
  for (const session of agentScan?.sessions ?? []) {
    for (const call of session.callTimeline ?? []) {
      events.push({ t: call.ts, credits: call.credits });
    }
  }
  return events;
}

export function buildDashboardData(scan: ScanResult, liveStats: LiveStats | null, aicConfig?: AICConfig, agentScan?: AgentScanResult, activationTime?: string, cliScan?: CliScanResult, quotaSnapshot?: QuotaSnapshot | null, byokPricing?: Partial<ByokPricingConfig>, ledgerHistory?: readonly LedgerPoint[]): DashboardData {
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
    // Families (minor version stripped) that carry exact debug credits. Keyed
    // loosely on purpose: `exactByModel` keys keep the minor version, so they
    // can't answer "is this OTel spelling already billed?" on their own.
    const exactFamilies = new Set<string>();
    const addExactModel = (model: string, prompt: number, output: number, cached: number, calls: number, nanoAiu: number) => {
      const displayModel = canonicalBillingModel(calculator, model);
      const key = displayModel.toLowerCase();
      if (nanoAiu > 0) {
        exactFamilies.add(modelFamily(model));
      }
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
      // The debug log records the API *response* model while OTel records the
      // *request* model, so the same call can appear as `claude-opus-4.7` and
      // `claude-opus-4.6`. `unflushedOtelRequests` already reconciles those by
      // family, but these keys keep the minor version — so without the family
      // check the OTel spelling looks like an unbilled model and its rate
      // estimate lands on top of the exact credits, double-counting the call.
      const familyAlreadyExact = live ? exactFamilies.has(modelFamily(live.model)) : false;
      const credits = reconciledCredits > 0
        ? reconciledCredits
        : familyAlreadyExact ? 0 : fallbackEstimate;
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
        cacheHitPct: 0,
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
      cacheHitPct: 0,
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

      // A model served by BOTH Copilot and a BYOK key produces one row here.
      // Only claim actual credits when some request in it was really billed —
      // otherwise a purely-BYOK row short-circuits to billable downstream.
      const byokOnlyModels = new Set<string>();
      for (const [model] of byModelMap) {
        const reqs = debugRequestsToday.filter(r => r.model === model);
        if (reqs.length > 0 && reqs.every(r => r.nanoAiu === 0 && isByokWrapperCall(r.debugName))) {
          byokOnlyModels.add(model);
        }
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
          // Rows here come from `req.nanoAiu` (GitHub's authoritative billed
          // amount), so they carry actual credits — except rows made up
          // entirely of BYOK-wrapper calls, which GitHub never billed.
          hasActualCredits: !byokOnlyModels.has(row.model),
          // Backfilled by the post-processor below.
          isBillable: false,
          cacheHitPct: 0,
        })),
        sessionAIC: Math.round(sessionAIC * 100) / 100,
        lastRequestAIC: Math.round(((mostRecentRequest?.nanoAiu ?? 0) / 1e9) * 100) / 100,
        informationalAIC: 0,
        cacheHitPct: 0,
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
          cacheHitPct: 0,
        })),
        // No ratchet — see OTel branch above for rationale.
        sessionAIC: Math.round(sessionAIC * 100) / 100,
        lastRequestAIC: Math.round(lastRequestAIC * 100) / 100,
        informationalAIC: 0,
        cacheHitPct: 0,
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
        cacheHitPct: 0,
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
  // Recorded vendor per model, from the turns that dispatched it. A model
  // reached by both routes is left unattributed so the catalog/wrapper rules
  // decide, exactly as before.
  const vendorByModel = new Map<string, string | undefined>();
  for (const t of scan.turns) {
    if (!t.modelVendor) {
      continue;
    }
    const key = modelFamily(t.modelFamily || "");
    if (!key) {
      continue;
    }
    if (vendorByModel.has(key) && vendorByModel.get(key) !== t.modelVendor) {
      vendorByModel.set(key, undefined);
    } else if (!vendorByModel.has(key)) {
      vendorByModel.set(key, t.modelVendor);
    }
  }
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
    isBillable: classifyModelBillability(
      calculator,
      config,
      row.model,
      row.hasActualCredits,
      classifyByCatalog,
      undefined,
      vendorByModel.get(modelFamily(row.model)),
    ),
    cacheHitPct: computeCacheHit(row.prompt, row.cached).pct,
  }));
  // Aggregate cache-hit — one place, one formula. See cache.ts.
  liveOtel.cacheHitPct = computeCacheHit(liveOtel.prompt, liveOtel.cached).pct;
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
  // `sessionId` / `source` are carried purely so the per-session AIC view can
  // be rebuilt from this exact list — one credit basis for the hero, the
  // Usage-by-Model table, the sidebar and the status bar.
  const creditEntries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    date: string;
    actualCredits?: number;
    /** Token mix for splitting `actualCredits` when the entry has no tokens of its own. */
    splitTokens?: { prompt: number; output: number; cached: number };
    billable: boolean;
    sessionId?: string;
    source: "vscode" | "otel" | "omp" | "pi" | "cli";
  }> = [];
  const classify = (
    model: string,
    hasActual: boolean,
    sourceHint?: string,
    recordedVendor?: string,
  ): boolean =>
    classifyModelBillability(
      calculator,
      config,
      model,
      hasActual,
      classifyByCatalog,
      sourceHint,
      recordedVendor,
    );
  // Which BYOK provider serves each model id, learned from turns that did
  // record one. A wrapper request proves BYOK routing but carries no provider
  // name of its own, and VS Code stamps `vendor: copilot` on the turn whenever
  // the picker sits on a Copilot model — so without this the same BYOK traffic
  // splits into a labelled and an unlabelled row for one physical endpoint.
  const byokProviderByModel = new Map<string, string>();
  for (const t of aicTurns) {
    if (!t.modelVendor || isCopilotVendor(t.modelVendor) || !t.modelFamily) {
      continue;
    }
    const label = providerLabel(t.modelVendor, t.modelProvider ?? "");
    if (label) {
      byokProviderByModel.set(modelFamily(t.modelFamily), label);
    }
  }

  // A BYOK-served id is indistinguishable from the Copilot model of the same
  // name once it reaches the tables, so qualify it the way OMP/Pi rows already
  // are. Only applied to non-billable rows: the prefix must never reach a
  // billable row, whose id has to keep matching GitHub's own reporting.
  const displayName = (
    model: string,
    billable: boolean,
    vendor?: string,
    provider?: string,
    debugName?: string,
  ): string => {
    if (billable) {
      return model;
    }
    if (vendor && !isCopilotVendor(vendor)) {
      return `${providerLabel(vendor, provider ?? "")}/${model}`;
    }
    if (isByokWrapperCall(debugName)) {
      const known = byokProviderByModel.get(modelFamily(model));
      if (known) {
        return `${known}/${model}`;
      }
    }
    return model;
  };
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
        const vendor = vendorFor(t, req.model, req.debugName);
        const billable = classify(req.model, hasNano, req.debugName, vendor);
        creditEntries.push({
          model: displayName(req.model, billable, vendor, providerFor(t, req.model, req.debugName), req.debugName),
          inputTokens: req.prompt,
          outputTokens: req.output,
          cachedTokens: req.cached,
          date,
          actualCredits: hasNano ? req.nanoAiu / 1_000_000_000 : undefined,
          splitTokens: req.splitTokens,
          billable,
          sessionId: t.sessionId,
          source: "vscode",
        });
      }
    } else if (t.timestamp && t.debugByModel) {
      const date = t.timestamp.slice(0, 10);
      for (const [model, mt] of Object.entries(t.debugByModel)) {
        const hasNano = mt.nanoAiu > 0;
        const vendor = vendorFor(t, model);
        const billable = classify(model, hasNano, undefined, vendor);
        creditEntries.push({
          model: displayName(model, billable, vendor, providerFor(t, model)),
          inputTokens: mt.prompt,
          outputTokens: mt.output,
          cachedTokens: mt.cached,
          date,
          actualCredits: hasNano ? mt.nanoAiu / 1_000_000_000 : undefined,
          billable,
          sessionId: t.sessionId,
          source: "vscode",
        });
      }
    } else if (t.timestamp) {
      const date = t.timestamp.slice(0, 10);
      const hasNano = t.debugAicCredits > 0;
      const model = t.modelFamily || "unknown";
      const vendor = vendorFor(t, model);
      const billable = classify(model, hasNano, undefined, vendor);
      creditEntries.push({
        model: displayName(model, billable, vendor, providerFor(t, model)),
        inputTokens: t.debugPromptTokens || t.promptTokens,
        outputTokens: t.debugOutputTokens || t.outputTokens,
        // scanner.ts sets debugCachedTokens alongside debugPromptTokens/debugAicCredits
        // (same synthetic per-turn aggregate) — was hardcoded 0, over-billing cache-heavy
        // turns at full input rate whenever debugAicCredits lagged behind debugPromptTokens.
        cachedTokens: t.debugCachedTokens || 0,
        date,
        // Actual AIC from API (if available) — overrides computed credits
        actualCredits: hasNano ? t.debugAicCredits : undefined,
        billable,
        sessionId: t.sessionId,
        source: "vscode",
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
          source: "otel",
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
          source: "otel",
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
      // Copilot-routed sessions without that field fall back to the token-rate
      // calculator; third-party sessions never do (see below).
      for (const [key, stats] of Object.entries(session.modelBreakdown)) {
        // Rows are keyed provider+model; `stats.model` carries the bare name.
        const model = stats.model ?? key;
        const provider = (stats.provider || session.provider || "").toLowerCase();
        const providerIsCopilot = provider.includes("github") || provider.includes("copilot");
        const providerIsThirdParty = provider.length > 0 && !providerIsCopilot;
        const billable = providerIsThirdParty ? false : classify(model, false, provider || undefined);
        // GitHub's rate card prices GitHub-routed traffic only. For a third-party
        // provider the agent's own cost ledger is the sole valid source — pricing
        // its tokens with Copilot rates invents spend that never happened (e.g.
        // Azure-hosted Kimi reports no cost, yet billed ~95 credits here).
        let actualCredits: number;
        if (providerIsThirdParty) {
          actualCredits = stats.costCredits;
        } else {
          // Agents write `usage.cost` on a minority of messages, and often on
          // only SOME calls to a given model. Gating on `costCredits > 0` would
          // price those calls and drop the rest — the same partial-coverage bug
          // fixed for VS Code turns in 1.10.91. Price the recorded part from the
          // ledger and rate-estimate exactly the calls it did not cover.
          const u = stats.unpriced;
          const estimateFrom = u
            ? { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite }
            : stats.costCredits > 0
              ? null
              : { input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite };
          const estimate = estimateFrom
            ? calculator.calculateCredits(
                model,
                estimateFrom.input + estimateFrom.cacheRead + estimateFrom.cacheWrite,
                estimateFrom.output,
                estimateFrom.cacheRead,
                estimateFrom.cacheWrite
              ).totalCredits
            : 0;
          actualCredits = stats.costCredits + estimate;
        }
        if (actualCredits <= 0) {
          continue;
        }
        const displayModel = providerIsThirdParty ? `${provider}/${model}` : model;
        // Tokens are carried so computeSummary can split the ledger total across
        // input/output/cached; the total itself always comes from actualCredits.
        //
        // `stats.input` is NET of cache, but the calculator subtracts cache from
        // whatever it is given — so passing net makes it subtract twice. On a
        // cache-heavy agent session (net 1.8K vs 235M cache-read) that drives
        // the input share to zero and, with output alone, collapses the whole
        // apportionment. Pass GROSS, matching the convention documented in
        // agentScanner.ts.
        creditEntries.push({
          model: displayModel,
          inputTokens: stats.input + stats.cacheRead + stats.cacheWrite,
          outputTokens: stats.output,
          cachedTokens: stats.cacheRead,
          date,
          actualCredits,
          billable,
          source: session.source === "omp" ? "omp" : "pi",
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
          source: "cli",
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
        source: "cli",
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
          source: "cli",
        });
        cliCredits += fallbackAic;
      }
    }
  }

  const summary = calculator.computeSummary(creditEntries);

  // ─── One credit basis for every surface ───────────────────────
  // `creditEntries` is the list the headline total is computed from. Rebuild
  // the per-session view from that same list so the hero tile, Usage-by-Model,
  // the sidebar and the status bar can never disagree.
  //
  // Before this, `SessionView.aicCredits` was a second, independent pass over
  // `scan.turns` that (a) collapsed a whole turn to `debugAicCredits` — losing
  // the rate-estimated requests inside turns that only partially reported
  // `copilotUsageNanoAiu`, (b) rate-estimated at the parent turn's model
  // instead of per sub-model, and (c) applied no billable filter.
  //
  // Deliberately NOT clipped to the billing cycle (unlike `summary.byDay`) so
  // historical month ranges resolve from the same numbers.
  const sessionAicByDay = new Map<string, Map<string, number>>();
  const unattributedByDay = new Map<string, number>();
  for (const e of creditEntries) {
    if (!e.billable || e.date === "unknown") { continue; }
    const credits = e.actualCredits !== undefined && e.actualCredits > 0
      ? e.actualCredits
      : calculator.calculateCredits(e.model, e.inputTokens, e.outputTokens, e.cachedTokens).totalCredits;
    if (credits <= 0) { continue; }
    if (e.source === "vscode" && e.sessionId) {
      let days = sessionAicByDay.get(e.sessionId);
      if (!days) { days = new Map<string, number>(); sessionAicByDay.set(e.sessionId, days); }
      days.set(e.date, (days.get(e.date) ?? 0) + credits);
    } else {
      unattributedByDay.set(e.date, (unattributedByDay.get(e.date) ?? 0) + credits);
    }
  }
  for (const s of sessionsAll) {
    const days = sessionAicByDay.get(s.sessionId);
    if (!days) { continue; }
    s.aicByDay = Array.from(days.entries())
      .map(([day, credits]) => ({ day, credits }))
      .sort((a, b) => a.day.localeCompare(b.day));
    s.aicCredits = Math.round(s.aicByDay.reduce((sum, d) => sum + d.credits, 0) * 100) / 100;
  }

  // Promo detection: auto-detect if we're in the June 1 – Sept 1, 2026 window
  const promoInfo = getPromoInfo(config.plan, summary.plan.monthlyCreditsIncluded);
  const localTotalCr = Math.round(summary.totalCredits * 100) / 100;

  // ─── Reconcile against GitHub's ledger ────────────────────────
  //
  // Everything above is reconstructed from local debug logs, which can only
  // ever be a lower bound on what GitHub bills:
  //   • usage on another machine / IDE / github.com / the cloud agent never
  //     writes a local log at all;
  //   • `copilotLanguageModelWrapper` requests omit `copilotUsageNanoAiu`,
  //     so they are rate-estimated rather than read;
  //   • rotated or deleted logs take their credits with them.
  //
  // The gap therefore grows monotonically across a cycle, which is exactly
  // the drift users report against github.com. When GitHub's own
  // `quota_snapshots` figure is available it is authoritative, so adopt it
  // for the headline and keep the local breakdown for attribution.
  const quotaUsed = quotaSnapshot ? Math.round(quotaSnapshot.creditsUsed * 100) / 100 : 0;
  const useQuota = !!quotaSnapshot && quotaUsed > 0;
  const totalCr = useQuota ? quotaUsed : localTotalCr;
  const quotaDelta = useQuota ? Math.round((quotaUsed - localTotalCr) * 100) / 100 : 0;

  // Compute overage under both promo and standard budgets
  const overageStandard = Math.max(0, totalCr - promoInfo.standardBudget) * (config.overageCostPerCredit ?? 0.01);
  const overagePromo = promoInfo.promoBudget > 0
    ? Math.max(0, totalCr - promoInfo.promoBudget) * (config.overageCostPerCredit ?? 0.01)
    : 0;

  // GitHub's `entitlement` is the real allowance for this seat — on a pooled
  // Business/Enterprise plan that is the org-wide pool, not the per-user
  // 1,900, which is why the local plan table renders "2000% of budget" for a
  // seat that is in fact well inside its allowance.
  const effectiveBudget = useQuota && quotaSnapshot!.entitlement > 0
    ? quotaSnapshot!.entitlement
    : promoInfo.isPromoActive && promoInfo.promoBudget > 0
      ? promoInfo.promoBudget
      : summary.plan.monthlyCreditsIncluded;
  const effectiveRemaining = useQuota
    ? Math.max(0, Math.round(quotaSnapshot!.remaining * 100) / 100)
    : Math.max(0, effectiveBudget - totalCr);
  // GitHub counts overage itself. Deriving it from total-minus-budget assumes
  // our total and its entitlement share a basis, which is exactly the
  // assumption that produced a phantom overage charge.
  const overageCredits = useQuota
    ? quotaSnapshot!.overageCount
    : Math.max(0, totalCr - effectiveBudget);
  const effectiveOverage = overageCredits * (config.overageCostPerCredit ?? 0.01);

  // Fold the unattributed remainder into `byDay` so every surface that sums
  // the day map (hero tile, Usage-by-Model total, sidebar, status bar) lands
  // on the same reconciled number. Where the ledger history shows WHEN it was
  // billed, the credits go to those days; whatever it cannot place is booked on
  // the most recent day with activity — we know the credits were spent, just
  // not which local session produced them.
  const reconciledByDay = new Map(summary.byDay);
  let quotaAnchorDay = "";
  let datedUnattributed: DatedCredits[] = [];
  let parkedDelta = quotaDelta;
  if (quotaDelta > 0 && ledgerHistory && ledgerHistory.length > 1) {
    datedUnattributed = dateUnattributed(ledgerHistory, ledgerLocalEvents(scan, agentScan), quotaDelta)
      .filter(d => d.day >= summary.billingCycleStart && d.day <= summary.billingCycleEnd)
      .map(d => ({ day: d.day, credits: Math.round(d.credits * 100) / 100 }));
    for (const d of datedUnattributed) {
      reconciledByDay.set(d.day, (reconciledByDay.get(d.day) ?? 0) + d.credits);
      parkedDelta -= d.credits;
    }
    parkedDelta = Math.round(parkedDelta * 100) / 100;
  }
  // Rounding the dated slices to cents can overshoot the delta by a cent; that
  // is not a remainder worth parking.
  if (Math.abs(parkedDelta) > (datedUnattributed.length > 0 ? 0.05 : 0.004)) {
    const cycleDays = [...summary.byDay.keys()]
      .filter(d => d >= summary.billingCycleStart && d <= summary.billingCycleEnd)
      .sort();
    quotaAnchorDay = cycleDays[cycleDays.length - 1]
      ?? new Date().toISOString().slice(0, 10);
    reconciledByDay.set(quotaAnchorDay, Math.max(0, (reconciledByDay.get(quotaAnchorDay) ?? 0) + parkedDelta));
  }

  // Pace and projection must derive from the reconciled total too, or the
  // hero projects a local-only run rate against a pooled budget and reports
  // percentages in the thousands.
  const activeDays = [...reconciledByDay.entries()]
    .filter(([d, c]) => c > 0 && d >= summary.billingCycleStart && d <= summary.billingCycleEnd).length;
  const reconciledDailyAvg = useQuota && activeDays > 0 ? totalCr / activeDays : summary.dailyAverage;
  const reconciledProjected = useQuota
    ? totalCr + reconciledDailyAvg * summary.daysRemaining
    : summary.projectedTotal;

  // BYOK rows repriced at the user's own provider rates. The qualified model
  // id carries both provider and family, so it is the whole matching subject.
  const pricing = mergePricingConfig(byokPricing);
  const providerUsdFor = (m: CreditUsage): number | undefined => {
    const cost = priceTokens(pricing, m.model, m.model, {
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cachedTokens: m.cachedTokens ?? 0,
    });
    return cost ? Math.round(cost.totalUsd * 100) / 100 : undefined;
  };
  // Undefined rather than 0 when nothing matched — a real $0.00 and "no rate
  // configured" must not render identically.
  let nbTotalUsd: number | undefined;
  for (const m of summary.nonBillable.byModel.values()) {
    const usd = providerUsdFor(m);
    if (usd !== undefined) {
      nbTotalUsd = (nbTotalUsd ?? 0) + usd;
    }
  }

  const aicSummary: AICDashboardData = {
    totalCredits: totalCr,
    inputCredits: Math.round(summary.inputCredits * 100) / 100,
    outputCredits: Math.round(summary.outputCredits * 100) / 100,
    cachedCredits: Math.round(summary.cachedCredits * 100) / 100,
    planName: summary.plan.planName,
    monthlyBudget: effectiveBudget,
    includedPremiumRequests: summary.plan.includedPremiumRequests,
    creditsRemaining: Math.round(effectiveRemaining * 100) / 100,
    estimatedOverageCost: Math.round(effectiveOverage * 100) / 100,
    billingCycleStart: summary.billingCycleStart,
    billingCycleEnd: summary.billingCycleEnd,
    daysRemaining: summary.daysRemaining,
    dailyAverage: Math.round(reconciledDailyAvg * 100) / 100,
    projectedTotal: Math.round(reconciledProjected * 100) / 100,
    byModel: Array.from(summary.byModel.values()).map(m => ({
      model: m.model,
      tier: m.tier,
      inputCredits: Math.round(m.inputCredits * 100) / 100,
      outputCredits: Math.round(m.outputCredits * 100) / 100,
      cachedCredits: Math.round(m.cachedCredits * 100) / 100,
      totalCredits: Math.round(m.totalCredits * 100) / 100,
    })).sort((a, b) => b.totalCredits - a.totalCredits),
    byDay: Array.from(reconciledByDay.entries())
      .map(([day, credits]) => ({ day, credits: Math.round(credits * 100) / 100 }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    localByDay: Array.from(summary.byDay.entries())
      .map(([day, credits]) => ({ day, credits: Math.round(credits * 100) / 100 }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    localTotalCredits: localTotalCr,
    unattributedByDay: Array.from(unattributedByDay.entries())
      .map(([day, credits]) => ({ day, credits: Math.round(credits * 100) / 100 }))
      .filter(d => d.credits > 0)
      .sort((a, b) => a.day.localeCompare(b.day)),
    config,
    nonBillable: {
      totalCredits: Math.round(summary.nonBillable.totalCredits * 100) / 100,
      totalProviderUsd: nbTotalUsd === undefined ? undefined : Math.round(nbTotalUsd * 100) / 100,
      byModel: Array.from(summary.nonBillable.byModel.values()).map(m => ({
        model: m.model,
        tier: m.tier,
        inputCredits: Math.round(m.inputCredits * 100) / 100,
        outputCredits: Math.round(m.outputCredits * 100) / 100,
        cachedCredits: Math.round(m.cachedCredits * 100) / 100,
        totalCredits: Math.round(m.totalCredits * 100) / 100,
        providerUsd: providerUsdFor(m),
      })).sort((a, b) => b.totalCredits - a.totalCredits),
      byDay: Array.from(summary.nonBillable.byDay.entries()).flatMap(([day, models]) =>
        Array.from(models.values()).map(m => ({
          day,
          model: m.model,
          tier: m.tier,
          inputCredits: Math.round(m.inputCredits * 100) / 100,
          outputCredits: Math.round(m.outputCredits * 100) / 100,
          cachedCredits: Math.round(m.cachedCredits * 100) / 100,
          totalCredits: Math.round(m.totalCredits * 100) / 100,
          providerUsd: providerUsdFor(m),
        })),
      ).sort((a, b) => a.day.localeCompare(b.day)),
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
    isActualFromApi: hasActualAic || useQuota,
    quota: quotaSnapshot
      ? {
          creditsUsed: quotaUsed,
          entitlement: quotaSnapshot.entitlement,
          remaining: quotaSnapshot.remaining,
          localDelta: quotaDelta,
          localTotal: localTotalCr,
          anchorDay: quotaAnchorDay || undefined,
          datedByDay: datedUnattributed.length > 0 ? datedUnattributed : undefined,
          overagePermitted: quotaSnapshot.overagePermitted,
          timestampUtc: quotaSnapshot.timestampUtc,
        }
      : undefined,
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

  // Snapshot the live catalog's multipliers so the webview never falls back
  // to a hardcoded table. Empty {} when the catalog hasn't loaded yet.
  const catalog = getCachedCatalog();
  const modelMultipliers: Record<string, number> = {};
  if (catalog) {
    for (const [id, entry] of catalog.byId) {
      if (typeof entry.multiplier === "number" && entry.multiplier > 0) {
        modelMultipliers[id] = entry.multiplier;
      }
    }
  }

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
    modelMultipliers,
  };
}

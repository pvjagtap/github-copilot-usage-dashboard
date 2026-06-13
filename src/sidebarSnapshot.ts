/**
 * sidebarSnapshot.ts — Pure projection of DashboardData + raw scan + live
 * OTel into a slim, serializable DTO consumed by the sidebar webview.
 *
 * Zero new computation: every number here is already produced by the existing
 * pipeline (dashboardData.ts, otelReceiver.ts, scanner.ts). This module only
 * picks, slices, and shapes for narrow-column display.
 */

import { DashboardData, SessionView, AIC_EFFECTIVE_DATE } from "./dashboardData";
import { Turn } from "./scanner";
import { LiveStats } from "./otelReceiver";

// ─── DTO ──────────────────────────────────────────────────────

export type LiveState = "live" | "scan" | "idle";
export type RangePreset = "today" | "week" | "cycle" | "all";
export type SortKey = "credits" | "date" | "tokens" | "turns";

export interface SidebarStatusRow {
  liveState: LiveState;
  planName: string;
  promoActive: boolean;
  promoEndDate: string;
  generatedAt: string;
}

export interface SidebarLastRequest {
  model: string;
  aic: number;
  agoMs: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** AIC values of the last N (≤20) requests, oldest → newest. */
  sparkline: number[];
}

export interface SidebarTodayWeek {
  todayAic: number;
  todayUsd: number;
  weekAic: number;
  weekUsd: number;
  /** Requests today (live OTel + debug-log overlay). */
  todayRequests: number;
  /** Heaviest model today (by tokens). */
  topModel: string;
}

export interface SidebarSessionLine {
  aic: number;
  turns: number;
  durationMin: number;
  model: string;
}

export interface SidebarPace {
  projectedUsd: number;
  projectedCredits: number;
  overagePct: number;
  cycleEnd: string;
  promoEndDate: string;
  overBudget: boolean;
  budget: number;
}

export interface SidebarBreakdown {
  totalAic: number;
  totalUsd: number;
  /** Up to 14 most-recent days' credit totals, oldest → newest. */
  dailySparkline: number[];
  peakDay: string;
  peakValue: number;
  byModel: Array<{ model: string; credits: number; pct: number; tier: string }>;
  modelsMore: number;
  byDow: Array<{ dow: string; credits: number; pct: number }>;
  tokens: { input: number; output: number; cached: number };
}

export interface SidebarSessionRow {
  sessionId: string;
  sessionShort: string;
  date: string;
  source: string;
  title: string;
  credits: number;
  active: boolean;
}

export interface SidebarSessions {
  rows: SidebarSessionRow[];
  total: number;
}

export interface SidebarSnapshot {
  status: SidebarStatusRow;
  lastRequest: SidebarLastRequest | null;
  todayWeek: SidebarTodayWeek;
  session: SidebarSessionLine | null;
  pace: SidebarPace;
  breakdown: SidebarBreakdown;
  sessions: SidebarSessions;
}

// ─── Helpers ─────────────────────────────────────────────────

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekStartKey(): string {
  // ISO week starts Monday; we use a 7-day rolling window ending today for
  // sidebar simplicity. Matches Tokenyst's "THIS WEEK (since Monday)" spirit
  // while avoiding TZ edge cases at month boundaries.
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

function safePct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

// ─── Builder ─────────────────────────────────────────────────

export interface SidebarBuildInput {
  dashData: DashboardData;
  scanTurns: Turn[];
  liveStats: LiveStats | null;
  lastRequestAIC: number;
  currentSessionAIC: number;
  currentSessionModel: string | null;
  currentSessionTurns: number;
  currentSessionDurationMin: number;
  activationTime: string;
}

export function buildSidebarSnapshot(input: SidebarBuildInput): SidebarSnapshot {
  const {
    dashData,
    scanTurns,
    liveStats,
    lastRequestAIC,
    currentSessionAIC,
    currentSessionModel,
    currentSessionTurns,
    currentSessionDurationMin,
    activationTime,
  } = input;

  const aic = dashData.aicSummary;
  const dollarsPerCredit = aic.config.overageCostPerCredit ?? 0.01;
  const today = todayKey();
  const weekStart = weekStartKey();

  // ── Status row ──
  const liveState: LiveState =
    liveStats && liveStats.requests > 0
      ? "live"
      : scanTurns.length > 0
        ? "scan"
        : "idle";

  // ── Last request + sparkline ──
  // Use per-turn debugLastRequestAic when present (true per-event values),
  // else fall back to the turn's total debugAicCredits. Scope to instance
  // (timestamps after activationTime) so other windows don't bleed in.
  const recentTurns = scanTurns
    .filter(t => t.timestamp && t.timestamp >= activationTime)
    .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  const sparkline = recentTurns
    .map(t => (t.debugLastRequestAic > 0 ? t.debugLastRequestAic : t.debugAicCredits))
    .filter(v => v > 0)
    .slice(-20);

  let lastRequest: SidebarLastRequest | null = null;
  if (lastRequestAIC > 0 || (liveStats && liveStats.lastRequest)) {
    const lr = liveStats?.lastRequest ?? null;
    const lastTs =
      lr?.timestamp ??
      recentTurns[recentTurns.length - 1]?.debugLastRequestTs ??
      recentTurns[recentTurns.length - 1]?.timestamp ??
      "";
    const agoMs = lastTs ? Math.max(0, Date.now() - new Date(lastTs).getTime()) : 0;
    lastRequest = {
      model: lr?.modelName ?? currentSessionModel ?? "unknown",
      aic: lastRequestAIC,
      agoMs,
      promptTokens: lr?.promptTokens ?? 0,
      completionTokens: lr?.completionTokens ?? 0,
      cachedTokens: lr?.cachedTokens ?? 0,
      sparkline,
    };
  }

  // ── Today / Week from aicSummary.byDay ──
  const todayRow = aic.byDay.find(d => d.day === today);
  const todayAic = todayRow?.credits ?? 0;
  const weekAic = aic.byDay
    .filter(d => d.day >= weekStart && d.day <= today)
    .reduce((s, d) => s + d.credits, 0);

  // Top model today + request count from live OTel byModel (live + accurate).
  let topModel = "—";
  let topTokens = 0;
  if (liveStats) {
    for (const m of liveStats.byModel.values()) {
      const tk = m.prompt + m.completion;
      if (tk > topTokens) {
        topTokens = tk;
        topModel = m.model;
      }
    }
  }
  if (topModel === "—" && aic.byModel.length > 0) {
    topModel = aic.byModel[0].model;
  }
  const todayRequests = liveStats?.requests ?? 0;

  const todayWeek: SidebarTodayWeek = {
    todayAic,
    todayUsd: todayAic * dollarsPerCredit,
    weekAic,
    weekUsd: weekAic * dollarsPerCredit,
    todayRequests,
    topModel,
  };

  // ── Session (this window) ──
  const session: SidebarSessionLine | null =
    currentSessionAIC > 0 || currentSessionTurns > 0
      ? {
          aic: currentSessionAIC,
          turns: currentSessionTurns,
          durationMin: currentSessionDurationMin,
          model: currentSessionModel ?? "—",
        }
      : null;

  // ── Pace (projected cycle spend) ──
  const projectedCredits = aic.projectedTotal;
  const projectedUsd =
    projectedCredits > aic.monthlyBudget
      ? (projectedCredits - aic.monthlyBudget) * dollarsPerCredit
      : 0;
  const pace: SidebarPace = {
    projectedUsd,
    projectedCredits,
    overagePct: safePct(aic.totalCredits, aic.monthlyBudget),
    cycleEnd: aic.billingCycleEnd,
    promoEndDate: aic.promo.promoEndDate,
    overBudget: aic.totalCredits > aic.monthlyBudget,
    budget: aic.monthlyBudget,
  };

  // ── Breakdown: cycle totals (default), already in aicSummary ──
  // Daily sparkline = last 14 days from byDay, oldest → newest, filling gaps with 0.
  const dailyMap = new Map(aic.byDay.map(d => [d.day, d.credits]));
  const days14: number[] = [];
  let peakDay = "";
  let peakValue = 0;
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    const v = dailyMap.get(k) ?? 0;
    days14.push(v);
    if (v > peakValue) {
      peakValue = v;
      peakDay = k;
    }
  }

  // By Model — show all models in the sidebar (no slicing). The dashboard
  // also lists them, but mirroring the full list here avoids the "+N more"
  // dead-end when users are scanning burn directly from the sidebar.
  const sortedModels = [...aic.byModel].sort((a, b) => b.totalCredits - a.totalCredits);
  const maxModelCredits = sortedModels[0]?.totalCredits ?? 0;
  const byModel = sortedModels.map(m => ({
    model: m.model,
    credits: m.totalCredits,
    pct: safePct(m.totalCredits, maxModelCredits),
    tier: m.tier,
  }));
  const modelsMore = 0;

  // By Day of Week — sum credits per dow across all aic.byDay entries (cycle).
  const dowTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const d of aic.byDay) {
    const idx = new Date(d.day + "T00:00:00").getDay();
    dowTotals[idx] += d.credits;
  }
  const maxDow = Math.max(...dowTotals, 0);
  const byDow = dowTotals.map((credits, i) => ({
    dow: DOW[i],
    credits,
    pct: safePct(credits, maxDow),
  }));

  // Tokens — sum from scan turns since AIC effective date (already what
  // dashboard uses). We use the same prefer-debug-then-fallback as scanner.
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  for (const t of scanTurns) {
    if (!t.timestamp || t.timestamp.slice(0, 10) < AIC_EFFECTIVE_DATE) {
      continue;
    }
    inputTokens += t.debugPromptTokens || t.promptTokens;
    outputTokens += t.debugOutputTokens || t.outputTokens;
    cachedTokens += t.debugCachedTokens || 0;
  }
  // Live OTel cache is more reliable for "now" — overlay max so cache count
  // never drops below what the live receiver reports for today.
  if (liveStats) {
    cachedTokens = Math.max(cachedTokens, liveStats.cached);
  }

  const breakdown: SidebarBreakdown = {
    totalAic: aic.totalCredits,
    totalUsd: aic.totalCredits * dollarsPerCredit,
    dailySparkline: days14,
    peakDay,
    peakValue,
    byModel,
    modelsMore,
    byDow,
    tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens },
  };

  // ── Sessions: top 30 by credits within cycle ──
  // Active session = the one matching currentSessionModel + most recent activity
  // since activationTime. Best-effort match — sidebar just shows a glyph.
  const activeShort = pickActiveSessionShort(dashData.sessionsAll, activationTime);
  const sessionsSorted = [...dashData.sessionsAll]
    .filter(s => s.aicCredits > 0)
    .sort((a, b) => b.aicCredits - a.aicCredits);
  const rows: SidebarSessionRow[] = sessionsSorted.slice(0, 30).map(s => ({
    sessionId: s.sessionId,
    sessionShort: s.sessionShort,
    date: s.lastDate || s.last.slice(0, 10),
    source: classifySource(s),
    title: s.title || s.project || s.sessionShort,
    credits: s.aicCredits,
    active: s.sessionShort === activeShort,
  }));

  return {
    status: {
      liveState,
      planName: aic.planName,
      promoActive: aic.promo.isPromoActive,
      promoEndDate: aic.promo.promoEndDate,
      generatedAt: dashData.generatedAt,
    },
    lastRequest,
    todayWeek,
    session,
    pace,
    breakdown,
    sessions: { rows, total: sessionsSorted.length },
  };
}

function classifySource(s: SessionView): string {
  // Match exact tokens, not substrings. `agentId` for VS Code chatSessions
  // is typically `"copilot"` / `"github.copilot-chat"` / `"copilot/workspaceAgent"`,
  // all of which contain the substring "pi" (positions 2–3 of "copilot") —
  // a naive `includes("pi")` would mislabel every Chat row as Pi.
  //
  // Today `sessionsAll` only carries VS Code chatSessions (OMP/Pi agent
  // sessions live in `agentSummary`, not here), so in practice this returns
  // "Chat" — but the token-aware checks are kept for forward-compat if the
  // dashboard ever merges agent sessions into `sessionsAll`.
  const id = (s.agentId || "").toLowerCase();
  const tokens = new Set(id.split(/[\s/.,_\-]+/).filter(Boolean));
  if (tokens.has("omp")) {
    return "OMP";
  }
  if (tokens.has("pi")) {
    return "Pi";
  }
  return "Chat";
}

function pickActiveSessionShort(sessions: SessionView[], activationTime: string): string {
  let best: SessionView | undefined;
  for (const s of sessions) {
    if (!s.last || s.last < activationTime) {
      continue;
    }
    if (!best || s.last > best.last) {
      best = s;
    }
  }
  return best?.sessionShort ?? "";
}

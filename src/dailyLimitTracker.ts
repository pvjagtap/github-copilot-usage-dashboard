/**
 * dailyLimitTracker.ts — Tracks AI Credits (AIC) spent today against a
 * user-configured daily cap and emits stage-change events.
 *
 * Stages:
 *   none   → below warn%
 *   warn   → warn% ≤ used < brace%
 *   brace  → brace% ≤ used < 100%
 *   limit  → used ≥ 100%
 *
 * Sources of "today's AIC":
 *   1. Scanner turns whose timestamp falls inside the current local "day"
 *      (day = window from resetHour to resetHour+24h).
 *   2. Live OTel byModel — overlays the scanner for the most recent
 *      activity that may not yet be flushed to disk.
 *
 * Snooze: stores an ISO timestamp in globalState. While "now < snoozeUntil"
 * the overlay is suppressed but the status bar and enforcement still apply.
 *
 * Manual resume: stores the day-key the user resumed on. Re-enables Copilot
 * (if enforcement disabled it) and suppresses re-enforcement for that day.
 */

import * as vscode from "vscode";
import { ScanResult, Turn } from "./scanner";
import { LiveStats } from "./otelReceiver";
import { AICCalculator, AICConfig } from "./aicCredits";

export type LimitStage = "none" | "warn" | "brace" | "limit";

export interface DailyLimitConfig {
  enabled: boolean;
  credits: number;
  /** If > 0, overrides `credits` via dollarsPerCredit conversion. */
  dollars: number;
  warnAtPercent: number;
  braceAtPercent: number;
  resetHour: number;
  enforcement: "soft" | "pause" | "strict";
  snoozeMinutes: number;
  playSound: boolean;
  /** When true, install global Copilot agent hooks (~/.copilot/hooks) so the
   * daily limit also blocks tool calls in Copilot CLI, custom agents, and
   * cloud agent. Default true. */
  installAgentHooks: boolean;
}

export interface DailyLimitSnapshot {
  stage: LimitStage;
  /** AIC used today */
  used: number;
  /** AIC limit (effective — may be derived from dollars) */
  limit: number;
  percent: number;
  /** USD used today (= used * dollarsPerCredit) */
  usedDollars: number;
  /** USD daily limit (= limit * dollarsPerCredit) */
  limitDollars: number;
  /** Conversion factor used (default 0.01 USD per credit) */
  dollarsPerCredit: number;
  /** true when the user configured the limit in dollars (not credits) */
  dollarMode: boolean;
  /** ms until the next reset */
  msUntilReset: number;
  /** "YYYY-MM-DD" key for the current day window */
  dayKey: string;
  /** true if the user is currently snoozing the overlay */
  snoozed: boolean;
  /** true if the user explicitly resumed Copilot for this day */
  resumed: boolean;
  enforcement: "soft" | "pause" | "strict";
  enabled: boolean;
  /** whether the webview should play a chime when stage becomes 'limit' */
  playSound: boolean;
  /** raw user setting for daily $ limit (0 = use credits-based). Exposed for UI editing. */
  dollarsSetting: number;
  /** whether agent hooks are currently installed (mirrors the setting). */
  installAgentHooks: boolean;
  /** monotonically-increasing per-day request counter, used by the overlay to re-trigger nag on each new Copilot request while at limit */
  requestCount: number;
}

const SNOOZE_KEY = "copilotUsage.dailyLimit.snoozeUntil";
const RESUME_KEY = "copilotUsage.dailyLimit.resumedDay";

export function getDailyLimitConfig(): DailyLimitConfig {
  const cfg = vscode.workspace.getConfiguration("copilotUsage.dailyLimit");
  return {
    enabled: cfg.get<boolean>("enabled") ?? true,
    credits: cfg.get<number>("credits") ?? 100,
    dollars: cfg.get<number>("dollars") ?? 0,
    warnAtPercent: cfg.get<number>("warnAtPercent") ?? 75,
    braceAtPercent: cfg.get<number>("braceAtPercent") ?? 90,
    resetHour: cfg.get<number>("resetHour") ?? 0,
    enforcement: (cfg.get<string>("enforcement") as DailyLimitConfig["enforcement"]) ?? "pause",
    snoozeMinutes: cfg.get<number>("snoozeMinutes") ?? 10,
    playSound: cfg.get<boolean>("playSound") ?? false,
    installAgentHooks: cfg.get<boolean>("installAgentHooks") ?? true,
  };
}

/**
 * Compute the start of the current "day window" based on resetHour.
 * Returns Date at local resetHour:00:00 on or before `now`.
 */
function dayWindowStart(now: Date, resetHour: number): Date {
  const start = new Date(now);
  start.setHours(resetHour, 0, 0, 0);
  if (start.getTime() > now.getTime()) {
    // Reset hour hasn't happened yet today — window started yesterday.
    start.setDate(start.getDate() - 1);
  }
  return start;
}

function dayKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Compute today's AIC by summing scanner turns + live OTel deltas. */
function computeTodayAIC(
  scan: ScanResult | undefined,
  otel: LiveStats | null,
  calculator: AICCalculator,
  windowStart: Date
): number {
  let total = 0;
  const windowStartIso = windowStart.toISOString();
  const seenRequestIds = new Set<string>();

  if (scan && scan.turns.length > 0) {
    for (const t of scan.turns as Turn[]) {
      if (!t.timestamp || t.timestamp < windowStartIso) {
        continue;
      }
      if (t.debugAicCredits > 0) {
        total += t.debugAicCredits;
      } else {
        const usage = calculator.calculateCredits(
          t.modelFamily || "unknown",
          t.debugPromptTokens || t.promptTokens,
          t.debugOutputTokens || t.outputTokens,
          0,
          0
        );
        total += usage.totalCredits;
      }
    }
  }

  // OTel: aggregate per-model totals (in-memory, this instance, since startup).
  // These will mostly overlap with scanner once flushed; we treat them as
  // authoritative for the *delta* not yet in scanner — but to keep math
  // simple and avoid double-counting we just use scanner+OTel-since-last-scan.
  // Here we add OTel byModel because the scanner has its own debounce and
  // a fresh request can take seconds to land in chatSession files.
  // Trade-off documented in implementation-notes.html.
  if (otel && otel.requests > 0 && (!scan || scan.turns.length === 0)) {
    for (const m of otel.byModel.values()) {
      const usage = calculator.calculateCredits(
        m.model,
        m.prompt,
        m.completion,
        m.cached,
        m.cacheWrite
      );
      total += usage.totalCredits;
    }
  }

  return Math.round(total * 100) / 100;
}

function classify(percent: number, warnPct: number, bracePct: number): LimitStage {
  if (percent >= 100) {
    return "limit";
  }
  if (percent >= bracePct) {
    return "brace";
  }
  if (percent >= warnPct) {
    return "warn";
  }
  return "none";
}

type StageListener = (snap: DailyLimitSnapshot, prev: LimitStage) => void;

export class DailyLimitTracker {
  private listeners: StageListener[] = [];
  private lastStage: LimitStage = "none";
  private lastSnapshot: DailyLimitSnapshot | null = null;

  constructor(private context: vscode.ExtensionContext) {}

  onStageChange(fn: StageListener): vscode.Disposable {
    this.listeners.push(fn);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter(l => l !== fn);
      },
    };
  }

  /** Snapshot of current state — call any time. */
  snapshot(
    scan: ScanResult | undefined,
    otel: LiveStats | null,
    calculator: AICCalculator,
    dollarsPerCredit = 0.01
  ): DailyLimitSnapshot {
    const cfg = getDailyLimitConfig();
    const now = new Date();
    const start = dayWindowStart(now, cfg.resetHour);
    const used = computeTodayAIC(scan, otel, calculator, start);

    // Dollar mode wins if dollars > 0 — convert to AIC for unified math.
    const dpc = dollarsPerCredit > 0 ? dollarsPerCredit : 0.01;
    const dollarMode = cfg.dollars > 0;
    const limit = dollarMode
      ? Math.max(1, Math.round(cfg.dollars / dpc))
      : Math.max(1, cfg.credits);

    const percent = (used / limit) * 100;
    const nextReset = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const msUntilReset = Math.max(0, nextReset.getTime() - now.getTime());

    const dayKey = dayKeyOf(start);
    const snoozeUntil = this.context.globalState.get<string>(SNOOZE_KEY);
    const resumedDay = this.context.globalState.get<string>(RESUME_KEY);
    const snoozed = !!snoozeUntil && new Date(snoozeUntil).getTime() > now.getTime();
    const resumed = resumedDay === dayKey;

    // Request count for re-nag trigger: sum scanner turns in current window + live OTel requests.
    const windowStartIso = start.toISOString();
    let reqCount = otel?.requests ?? 0;
    if (scan && scan.turns.length > 0) {
      for (const t of scan.turns) {
        if (t.timestamp && t.timestamp >= windowStartIso) {
          reqCount++;
        }
      }
    }

    const snap: DailyLimitSnapshot = {
      stage: cfg.enabled ? classify(percent, cfg.warnAtPercent, cfg.braceAtPercent) : "none",
      used,
      limit,
      percent: Math.round(percent * 10) / 10,
      usedDollars: Math.round(used * dpc * 100) / 100,
      limitDollars: Math.round(limit * dpc * 100) / 100,
      dollarsPerCredit: dpc,
      dollarMode,
      msUntilReset,
      dayKey,
      snoozed,
      resumed,
      enforcement: cfg.enforcement,
      enabled: cfg.enabled,
      playSound: cfg.playSound,
      dollarsSetting: cfg.dollars,
      installAgentHooks: cfg.installAgentHooks,
      requestCount: reqCount,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  /** Push a snapshot and fire listeners if the stage changed. */
  push(snap: DailyLimitSnapshot): void {
    const prev = this.lastStage;
    if (snap.stage !== prev) {
      this.lastStage = snap.stage;
      for (const l of this.listeners) {
        try {
          l(snap, prev);
        } catch {
          /* ignore listener errors */
        }
      }
    }
  }

  /** Last snapshot if available (may be null before first computation). */
  last(): DailyLimitSnapshot | null {
    return this.lastSnapshot;
  }
  lastStageValue(): LimitStage {
    return this.lastStage;
  }

  /** Snooze the overlay for `minutes`. */
  async snooze(minutes: number): Promise<void> {
    const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    await this.context.globalState.update(SNOOZE_KEY, until);
  }

  async clearSnooze(): Promise<void> {
    await this.context.globalState.update(SNOOZE_KEY, undefined);
  }

  /** Mark the current day as user-resumed (skip enforcement until next reset). */
  async markResumed(dayKey: string): Promise<void> {
    await this.context.globalState.update(RESUME_KEY, dayKey);
  }

  async clearResume(): Promise<void> {
    await this.context.globalState.update(RESUME_KEY, undefined);
  }
}

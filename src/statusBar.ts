import * as vscode from "vscode";
import { LiveStats } from "./otelReceiver";
import { ScanStats } from "./scanner";

/** Format a credit delta as a compact dollar/cent string for the flash badge. */
function fmtDelta(credits: number, dollarPerCredit: number): string {
  const cents = credits * dollarPerCredit * 100;
  if (cents >= 100) {
    return `+$${(cents / 100).toFixed(2)}`;
  }
  if (cents < 0.05) {
    return "+<1\u00a2";
  }
  // One decimal for sub-dollar so 8.4-credit requests still read as +8.4¢.
  return `+${cents.toFixed(1)}\u00a2`;
}

/** How long the per-request "+X\u00a2" badge stays visible after a new request. */
const FLASH_MS = 5000;

/** Current session info for the status bar (this VS Code instance only) */
export interface CurrentSessionInfo {
  sessionId: string;
  sessionShort: string;
  model: string;
  turns: number;
  prompt: number;
  output: number;
  toolCalls: number;
  durationMin: number;
  aicCredits: number;
}

export interface StatusBarData {
  otel: LiveStats | null;
  scan: ScanStats | null;
  /** Current/latest session for this instance */
  currentSession: CurrentSessionInfo | null;
  /** Total sessions in scan (for tooltip context) */
  totalSessions: number;
  /** Current session AIC credits (cumulative, billable scope) */
  currentSessionAIC: number;
  /** Last single request's AIC credits */
  lastRequestAIC: number;
  /**
   * Sum of `aicCredits` across live byModel rows classified as NON-billable
   * (Ollama / BYOK / unknown). Surfaced in the tooltip as
   * "$X.XX informational excluded" so users can SEE why the headline
   * session AIC is lower than the per-model table sum, instead of
   * silently dropping to 0. Optional for backward compatibility with the
   * legacy `update(stats)` entry point.
   */
  informationalAIC?: number;
  /** Daily-limit overlay state (optional — undefined = no limit feature active) */
  dailyLimit?: {
    stage: "none" | "warn" | "brace" | "limit";
    used: number;
    limit: number;
    percent: number;
    usedDollars: number;
    limitDollars: number;
    dollarMode: boolean;
    snoozed: boolean;
    resumed: boolean;
  };
  /** AIC → USD conversion rate (overageCostPerCredit, default 0.01). */
  dollarPerCredit?: number;
}

export class StatusBarProvider {
  private item: vscode.StatusBarItem;
  private walkTimer: ReturnType<typeof setInterval> | undefined;
  private walkFrame = 0;
  private walkStage: "none" | "warn" | "brace" = "none";
  private lastRenderedText = "";
  /** Most recent per-request AIC seen — used to detect "new request" transitions. */
  private lastSeenRequestAIC = 0;
  /** Wall-clock ms at which the +X\u00a2 flash badge should disappear. */
  private flashUntil = 0;
  /** One-shot timer that re-renders to clear the flash badge. */
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last data pushed in, cached so the flash timer can re-render without new input. */
  private lastData: StatusBarData | null = null;

  constructor(private commandId: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = commandId;
    this.item.tooltip = "Click to open Copilot Usage Dashboard";
    this.updateStatus(null);
    this.item.show();
  }

  /** Legacy: OTel-only update */
  update(stats: LiveStats | null): void {
    this.updateStatus({
      otel: stats,
      scan: null,
      currentSession: null,
      totalSessions: 0,
      currentSessionAIC: 0,
      lastRequestAIC: 0,
      informationalAIC: 0,
    });
  }

  /**
   * Full update with current session + OTel data.
   *
   * Display contract (reimagined v2):
   *   - Idle              → `$(dashboard)`
   *   - Active calm       → `$(zap) $0.59`            (+ transient `+8.4\u00a2` flash for 5s)
   *   - Warn / Brace      → `<walker> $0.59 / $5.00`  (walker icon supplied by limitPrefix)
   *   - Limit hit         → `<stop> $5.00 LIMIT`
   *   - Limit + snoozed   → `<bell-slash> $5.00`
   *   - Limit + resumed   → `<continue> $5.04`
   *
   * All token counts, model name, session id, and workspace totals remain in
   * the tooltip — the bar surfaces only the cost number the user can act on.
   */
  updateStatus(data: StatusBarData | null): void {
    this.lastData = data;

    const otel = data?.otel;
    const hasOtel = otel && otel.requests > 0;
    const cs = data?.currentSession;
    const dl = data?.dailyLimit;
    const dpc = data?.dollarPerCredit ?? 0.01;

    // When at limit, the primary click action becomes "re-open Shield" so the
    // user never gets stuck with only the dashboard after dismissing the panel.
    if (dl && dl.stage === "limit") {
      this.item.command = "copilotUsage.dailyLimit.showShield";
    } else {
      this.item.command = this.commandId;
    }

    // Apply daily-limit coloring + prefix that always wins.
    this.applyLimitTheme(dl);
    const limitPrefix = this.limitPrefix(dl);

    // Idle — nothing seen yet for this instance.
    if (!hasOtel && !cs) {
      this.item.text = `${limitPrefix}$(dashboard)`;
      this.lastRenderedText = this.item.text;
      this.item.tooltip = this.buildTooltipForIdle(dl);
      return;
    }

    // Resolve session-total AIC (OTel calculator value wins; debug-log fallback otherwise).
    const sessionAIC = data?.currentSessionAIC ?? cs?.aicCredits ?? 0;
    const sessionDollars = sessionAIC * dpc;
    const lastReqAIC = data?.lastRequestAIC ?? 0;

    // Detect a new request — trigger a 5-second flash badge.
    // Only on strict increase: avoids re-flashing after scan resets that
    // briefly drop the value to 0, and avoids attributing a prior window's
    // historical AIC to a "new" event on the first push.
    if (lastReqAIC > this.lastSeenRequestAIC) {
      this.flashUntil = Date.now() + FLASH_MS;
      this.scheduleFlashClear();
    }
    this.lastSeenRequestAIC = lastReqAIC;
    const showFlash = lastReqAIC > 0 && Date.now() < this.flashUntil;
    const delta = showFlash ? ` ${fmtDelta(lastReqAIC, dpc)}` : "";

    // Compose the body — dollars only, branched on daily-limit stage.
    // SCOPE NOTE: in warn/brace we display `dl.usedDollars / dl.limitDollars`
    // — BOTH day-scoped — so the fraction matches the background color (which
    // is driven by day percent). Mixing sessionDollars (this-window) with
    // dl.limitDollars (day) would put numerator and denominator on different
    // axes and confuse the user.
    let body: string;
    if (dl && dl.stage === "limit") {
      if (dl.resumed || dl.snoozed) {
        body = `$${dl.usedDollars.toFixed(2)}`;
      } else {
        body = `$${dl.usedDollars.toFixed(2)} LIMIT`;
      }
    } else if (dl && (dl.stage === "warn" || dl.stage === "brace")) {
      body = `$${dl.usedDollars.toFixed(2)} / $${dl.limitDollars.toFixed(2)}`;
    } else {
      // Calm active state — session dollars only (no day cap to show).
      // Prepend $(zap) since limitPrefix is empty here.
      body = `$(zap) $${sessionDollars.toFixed(2)}${delta}`;
    }

    this.item.text = `${limitPrefix}${body}`;
    this.lastRenderedText = this.item.text;
    this.item.tooltip = this.buildTooltipActive(data, otel, cs, dl);
  }

  /** Tooltip for active states — keeps every datum that used to be on the bar. */
  private buildTooltipActive(
    data: StatusBarData | null,
    otel: LiveStats | null | undefined,
    cs: CurrentSessionInfo | null | undefined,
    dl: StatusBarData["dailyLimit"]
  ): string {
    const lines: string[] = [];
    if (otel && otel.requests > 0) {
      lines.push(
        `Copilot Token Usage — This Session (${otel.requests} requests)`,
        `  Prompt: ${otel.prompt.toLocaleString()}`,
        `  Output: ${otel.completion.toLocaleString()}`,
        `  Cached: ${otel.cached.toLocaleString()}`
      );
    } else if (cs) {
      lines.push(
        `Copilot Usage — Current Session`,
        `  Session: ${cs.sessionShort}…`,
        `  Model: ${cs.model}`,
        `  Turns: ${cs.turns}`,
        `  Prompt: ${cs.prompt.toLocaleString()}`,
        `  Output: ${cs.output.toLocaleString()}`,
        `  Tool calls: ${cs.toolCalls}`,
        `  Duration: ${cs.durationMin}m`
      );
    }
    // Always emit BOTH AIC lines, even at 0.00, so users can see whether the
    // dashboard is reading their session at all. Pre-v1.10.14 the truthy check
    // hid `currentSessionAIC` when it was 0, which made the BYOK demotion bug
    // (sessionAIC dropped to 0 by classifier) look like "no data" — confusing
    // since the per-model table still showed real billed credits. Now the line
    // is always there, and if any AIC was excluded as informational we surface
    // it on the same line so the discrepancy is visible at a glance.
    const sessAic = data?.currentSessionAIC ?? 0;
    const infoAic = data?.informationalAIC ?? 0;
    const sessSuffix = infoAic > 0 ? `  (+${infoAic.toFixed(2)} informational excluded)` : "";
    lines.push(`  AI Credits (session total): ${sessAic.toFixed(2)}${sessSuffix}`);
    lines.push(`  AI Credits (last request): ${(data?.lastRequestAIC ?? 0).toFixed(2)}`);
    if (otel && otel.requests > 0 && cs) {
      lines.push("", `Session: ${cs.sessionShort}… | Model: ${cs.model} | Turns: ${cs.turns}`);
    } else {
      lines.push("");
    }
    if (data?.totalSessions) {
      lines.push(`Total sessions in workspace: ${data.totalSessions}`);
    }
    if (dl && dl.stage !== "none") {
      lines.push(
        `Daily limit: $${dl.usedDollars.toFixed(2)} / $${dl.limitDollars.toFixed(2)} (${dl.percent.toFixed(0)}%)`
      );
    }
    lines.push(`Dashboard AIC cards show billing-cycle totals across sessions.`);
    lines.push(
      dl && dl.stage === "limit"
        ? "Click to re-open the Daily Limit Shield"
        : "Click to open full dashboard"
    );
    return lines.filter((l) => l !== undefined).join("\n");
  }

  /** Schedule a one-shot re-render at flashUntil to drop the +X\u00a2 badge. */
  private scheduleFlashClear(): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    const delay = Math.max(50, this.flashUntil - Date.now() + 20);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = undefined;
      // Re-render with cached data — flash window has elapsed, badge will drop.
      this.updateStatus(this.lastData);
    }, delay);
  }

  dispose(): void {
    if (this.walkTimer) {
      clearInterval(this.walkTimer);
      this.walkTimer = undefined;
    }
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    this.item.dispose();
  }

  // ─── Daily-limit theming helpers ────────────────────────────

  private applyLimitTheme(dl: StatusBarData["dailyLimit"]): void {
    if (!dl) {
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
      return;
    }
    if (dl.stage === "limit" && !dl.resumed) {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      this.item.color = undefined;
    } else if (dl.stage === "brace" || dl.stage === "warn") {
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.color = undefined;
    } else {
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
    }
  }

  private limitPrefix(dl: StatusBarData["dailyLimit"]): string {
    if (!dl) {
      this.stopWalker();
      return "";
    }
    if (dl.stage === "limit") {
      this.stopWalker();
      return dl.resumed
        ? "$(debug-continue) "
        : dl.snoozed
          ? "$(bell-slash) "
          : "$(stop-circle) $(hand) ";
    }
    if (dl.stage === "brace") {
      this.startWalker("brace");
      return this.walkerIcon("brace") + " ";
    }
    if (dl.stage === "warn") {
      this.startWalker("warn");
      return this.walkerIcon("warn") + " ";
    }
    this.stopWalker();
    return "";
  }

  /** Cycle a "walking" codicon by re-rendering the status bar every 450ms. */
  private startWalker(stage: "warn" | "brace"): void {
    if (this.walkStage === stage && this.walkTimer) {
      return;
    }
    this.walkStage = stage;
    if (this.walkTimer) {
      clearInterval(this.walkTimer);
    }
    this.walkTimer = setInterval(() => {
      this.walkFrame = (this.walkFrame + 1) % 4;
      // Re-stamp the text with the new walker frame.
      const stamped = this.lastRenderedText.replace(
        /\$\((person|person-running|run|run-above|flame|warning)\)/,
        this.walkerIcon(this.walkStage)
      );
      if (stamped !== this.item.text) {
        this.item.text = stamped;
      }
    }, 450);
  }

  private stopWalker(): void {
    if (this.walkTimer) {
      clearInterval(this.walkTimer);
      this.walkTimer = undefined;
    }
    this.walkStage = "none";
  }

  private walkerIcon(stage: "warn" | "brace" | "none"): string {
    if (stage === "none") {
      return "";
    }
    // 4-frame cycle that simulates a little walking character.
    const warnFrames = ["$(person)", "$(person-running)", "$(person)", "$(person-running)"];
    const braceFrames = ["$(flame)", "$(person-running)", "$(warning)", "$(person-running)"];
    const f = stage === "brace" ? braceFrames : warnFrames;
    return f[this.walkFrame % f.length];
  }

  private buildTooltipForIdle(dl: StatusBarData["dailyLimit"]): string {
    if (!dl) {
      return "Click to open Copilot Usage Dashboard";
    }
    const clickHint =
      dl.stage === "limit"
        ? "Click to re-open the Daily Limit Shield"
        : "Click to open Copilot Usage Dashboard";
    return [
      `Daily limit: $${dl.usedDollars.toFixed(2)} / $${dl.limitDollars.toFixed(2)}  (${dl.used.toFixed(1)} / ${dl.limit} AIC, ${dl.percent}%)`,
      `Stage: ${dl.stage}${dl.snoozed ? " (snoozed)" : ""}${dl.resumed ? " (resumed)" : ""}${dl.dollarMode ? " — dollar mode" : ""}`,
      "",
      clickHint,
    ].join("\n");
  }
}

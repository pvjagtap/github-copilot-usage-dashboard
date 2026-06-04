import * as vscode from "vscode";
import { LiveStats } from "./otelReceiver";
import { ScanStats } from "./scanner";

function fmt(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(2) + "M";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + "K";
  }
  return n.toLocaleString();
}

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
  /** Current session AIC credits (cumulative) */
  currentSessionAIC: number;
  /** Last single request's AIC credits */
  lastRequestAIC: number;
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
}

export class StatusBarProvider {
  private item: vscode.StatusBarItem;
  private walkTimer: ReturnType<typeof setInterval> | undefined;
  private walkFrame = 0;
  private walkStage: "none" | "warn" | "brace" = "none";
  private lastRenderedText = "";

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
    });
  }

  /** Full update with current session + OTel data */
  updateStatus(data: StatusBarData | null): void {
    const otel = data?.otel;
    const hasOtel = otel && otel.requests > 0;
    const cs = data?.currentSession;
    const dl = data?.dailyLimit;

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
    const limitSuffix = this.limitSuffix(dl);

    if (!hasOtel && !cs) {
      this.item.text = `${limitPrefix}$(dashboard) Copilot Usage${limitSuffix}`;
      this.lastRenderedText = this.item.text;
      this.item.tooltip = this.buildTooltipForIdle(dl);
      return;
    }

    if (hasOtel) {
      const p = fmt(otel!.prompt);
      const o = fmt(otel!.completion);
      const c = fmt(otel!.cached);
      const lastReq = data?.lastRequestAIC ? ` Req:${data.lastRequestAIC.toFixed(1)}` : "";
      const aic = data?.currentSessionAIC
        ? ` | AIC(sess):${data.currentSessionAIC.toFixed(1)}${lastReq}`
        : "";
      this.item.text = `${limitPrefix}$(zap) In:${p} Out:${o} Cache:${c}${aic}${limitSuffix}`;
      this.lastRenderedText = this.item.text;
      this.item.tooltip = [
        `Copilot Token Usage — This Session (${otel!.requests} requests)`,
        `  Prompt: ${otel!.prompt.toLocaleString()}`,
        `  Output: ${otel!.completion.toLocaleString()}`,
        `  Cached: ${otel!.cached.toLocaleString()}`,
        data?.currentSessionAIC
          ? `  AI Credits (session total): ${data.currentSessionAIC.toFixed(2)}`
          : "",
        data?.lastRequestAIC
          ? `  AI Credits (last request): ${data.lastRequestAIC.toFixed(2)}`
          : "",
        "",
        cs ? `Session: ${cs.sessionShort}… | Model: ${cs.model} | Turns: ${cs.turns}` : "",
        data?.totalSessions ? `Total sessions in workspace: ${data.totalSessions}` : "",
        `Dashboard AIC cards show billing-cycle totals across sessions.`,
        dl && dl.stage === "limit"
          ? "Click to re-open the Daily Limit Shield"
          : "Click to open full dashboard",
      ]
        .filter(Boolean)
        .join("\n");
    } else if (cs) {
      const p = fmt(cs.prompt);
      const o = fmt(cs.output);
      const lastReq = data?.lastRequestAIC ? ` Req:${data.lastRequestAIC.toFixed(1)}` : "";
      const aic = cs.aicCredits ? ` | AIC(sess):${cs.aicCredits.toFixed(1)}${lastReq}` : "";
      this.item.text = `${limitPrefix}$(dashboard) ${cs.model} | In:${p} Out:${o}${aic}${limitSuffix}`;
      this.lastRenderedText = this.item.text;
      this.item.tooltip = [
        `Copilot Usage — Current Session`,
        `  Session: ${cs.sessionShort}…`,
        `  Model: ${cs.model}`,
        `  Turns: ${cs.turns}`,
        `  Prompt: ${cs.prompt.toLocaleString()}`,
        `  Output: ${cs.output.toLocaleString()}`,
        `  Tool calls: ${cs.toolCalls}`,
        `  Duration: ${cs.durationMin}m`,
        cs.aicCredits ? `  AI Credits (session total): ${cs.aicCredits.toFixed(2)}` : "",
        data?.lastRequestAIC
          ? `  AI Credits (last request): ${data.lastRequestAIC.toFixed(2)}`
          : "",
        "",
        data?.totalSessions ? `Total sessions in workspace: ${data.totalSessions}` : "",
        `Dashboard AIC cards show billing-cycle totals across sessions.`,
        dl && dl.stage === "limit"
          ? "Click to re-open the Daily Limit Shield"
          : "Click to open full dashboard",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }

  dispose(): void {
    if (this.walkTimer) {
      clearInterval(this.walkTimer);
      this.walkTimer = undefined;
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

  /** Compact $ / AIC suffix appended to the status text when daily limit is active. */
  private limitSuffix(dl: StatusBarData["dailyLimit"]): string {
    if (!dl || dl.stage === "none") {
      return "";
    }
    if (dl.stage === "limit") {
      return ` | $${dl.usedDollars.toFixed(2)} ⋅ LIMIT`;
    }
    return ` | $${dl.usedDollars.toFixed(2)}/$${dl.limitDollars.toFixed(2)} (${dl.percent.toFixed(0)}%)`;
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

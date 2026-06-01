import * as vscode from "vscode";
import { LiveStats } from "./otelReceiver";
import { ScanStats } from "./scanner";

function fmt(n: number): string {
  if (n >= 1_000_000) { return (n / 1_000_000).toFixed(2) + "M"; }
  if (n >= 1_000) { return (n / 1_000).toFixed(1) + "K"; }
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
}

export class StatusBarProvider {
  private item: vscode.StatusBarItem;

  constructor(private commandId: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = commandId;
    this.item.tooltip = "Click to open Copilot Usage Dashboard";
    this.updateStatus(null);
    this.item.show();
  }

  /** Legacy: OTel-only update */
  update(stats: LiveStats | null): void {
    this.updateStatus({ otel: stats, scan: null, currentSession: null, totalSessions: 0, currentSessionAIC: 0, lastRequestAIC: 0 });
  }

  /** Full update with current session + OTel data */
  updateStatus(data: StatusBarData | null): void {
    const otel = data?.otel;
    const hasOtel = otel && otel.requests > 0;
    const cs = data?.currentSession;

    if (!hasOtel && !cs) {
      this.item.text = "$(dashboard) Copilot Usage";
      this.item.tooltip = "Click to open Copilot Usage Dashboard";
      return;
    }

    if (hasOtel) {
      const p = fmt(otel!.prompt);
      const o = fmt(otel!.completion);
      const c = fmt(otel!.cached);
      const lastReq = data?.lastRequestAIC ? ` Req:${data.lastRequestAIC.toFixed(1)}` : "";
      const aic = data?.currentSessionAIC ? ` | AIC(sess):${data.currentSessionAIC.toFixed(1)}${lastReq}` : "";
      this.item.text = `$(zap) In:${p} Out:${o} Cache:${c}${aic}`;
      this.item.tooltip = [
        `Copilot Token Usage — This Session (${otel!.requests} requests)`,
        `  Prompt: ${otel!.prompt.toLocaleString()}`,
        `  Output: ${otel!.completion.toLocaleString()}`,
        `  Cached: ${otel!.cached.toLocaleString()}`,
        data?.currentSessionAIC ? `  AI Credits (session total): ${data.currentSessionAIC.toFixed(2)}` : "",
        data?.lastRequestAIC ? `  AI Credits (last request): ${data.lastRequestAIC.toFixed(2)}` : "",
        "",
        cs ? `Session: ${cs.sessionShort}… | Model: ${cs.model} | Turns: ${cs.turns}` : "",
        data?.totalSessions ? `Total sessions in workspace: ${data.totalSessions}` : "",
        `Dashboard AIC cards show billing-cycle totals across sessions.`,
        "Click to open full dashboard",
      ].filter(Boolean).join("\n");
    } else if (cs) {
      const p = fmt(cs.prompt);
      const o = fmt(cs.output);
      const lastReq = data?.lastRequestAIC ? ` Req:${data.lastRequestAIC.toFixed(1)}` : "";
      const aic = cs.aicCredits ? ` | AIC(sess):${cs.aicCredits.toFixed(1)}${lastReq}` : "";
      this.item.text = `$(dashboard) ${cs.model} | In:${p} Out:${o}${aic}`;
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
        data?.lastRequestAIC ? `  AI Credits (last request): ${data.lastRequestAIC.toFixed(2)}` : "",
        "",
        data?.totalSessions ? `Total sessions in workspace: ${data.totalSessions}` : "",
        `Dashboard AIC cards show billing-cycle totals across sessions.`,
        "Click to open full dashboard",
      ].filter(Boolean).join("\n");
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

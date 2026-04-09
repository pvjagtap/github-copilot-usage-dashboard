import * as vscode from "vscode";
import { LiveStats } from "./otelReceiver";
import { ScanStats } from "./scanner";

function fmt(n: number): string {
  if (n >= 1_000_000) { return (n / 1_000_000).toFixed(2) + "M"; }
  if (n >= 1_000) { return (n / 1_000).toFixed(1) + "K"; }
  return n.toLocaleString();
}

export interface StatusBarData {
  otel: LiveStats | null;
  scan: ScanStats | null;
  totalPrompt: number;
  totalOutput: number;
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
    this.updateStatus({ otel: stats, scan: null, totalPrompt: 0, totalOutput: 0 });
  }

  /** Full update with scan + OTel data */
  updateStatus(data: StatusBarData | null): void {
    const otel = data?.otel;
    const scan = data?.scan;
    const hasOtel = otel && otel.requests > 0;
    const hasScan = scan && scan.canonicalSessions > 0;

    if (!hasOtel && !hasScan) {
      this.item.text = "$(dashboard) Copilot Usage";
      this.item.tooltip = "Click to open Copilot Usage Dashboard";
      return;
    }

    if (hasOtel) {
      const p = fmt(otel!.prompt);
      const o = fmt(otel!.completion);
      const c = fmt(otel!.cached);
      this.item.text = `$(zap) In:${p} Out:${o} Cache:${c}`;
      this.item.tooltip = [
        `Copilot Token Usage (${otel!.requests} OTel requests)`,
        `  Prompt: ${otel!.prompt.toLocaleString()}`,
        `  Output: ${otel!.completion.toLocaleString()}`,
        `  Cached: ${otel!.cached.toLocaleString()}`,
        "",
        hasScan ? `Sessions: ${scan!.canonicalSessions} | Turns: ${scan!.turnsStored} | Tools: ${scan!.toolCallsStored}` : "",
        "Click to open full dashboard",
      ].filter(Boolean).join("\n");
    } else if (hasScan) {
      const tp = fmt(data!.totalPrompt);
      const to = fmt(data!.totalOutput);
      this.item.text = `$(dashboard) ${scan!.canonicalSessions} sessions | In:${tp} Out:${to}`;
      this.item.tooltip = [
        `Copilot Usage (${scan!.canonicalSessions} sessions)`,
        `  Turns: ${scan!.turnsStored}`,
        `  Tool calls: ${scan!.toolCallsStored}`,
        `  Prompt: ${data!.totalPrompt.toLocaleString()}`,
        `  Output: ${data!.totalOutput.toLocaleString()}`,
        "",
        "Click to open full dashboard",
      ].join("\n");
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

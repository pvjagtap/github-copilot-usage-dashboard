/**
 * cacheMissNotifier.ts — tell the user, as it happens, that a request just paid
 * to re-send its whole context because the prompt cache missed.
 *
 * Detection lives in `cacheMiss.ts` (pure); this is the thin VS Code layer: it
 * reads the settings, keeps the set of misses already reported, and raises one
 * toast per scan that found something new. Like the TTL tracker it does no file
 * I/O of its own — it consumes the ScanResult `runScan()` already produced.
 */

import * as vscode from "vscode";
import { ScanResult } from "./scanner";
import { CacheMissEvent, describeCacheMiss, detectCacheMisses, summarizeCacheMisses } from "./cacheMiss";
import { getTtlThresholds, mapTtlProvider } from "./ttlProviders";
import { getTtlConfig } from "./ttlTracker";

export interface CacheMissConfig {
  enabled: boolean;
  minPromptTokens: number;
  minWastedCredits: number;
}

export const DEFAULT_CACHE_MISS_CONFIG: CacheMissConfig = {
  enabled: true,
  minPromptTokens: 20_000,
  minWastedCredits: 1,
};

export function getCacheMissConfig(): CacheMissConfig {
  const cfg = vscode.workspace.getConfiguration("copilotUsage.cacheMiss");
  return {
    enabled: cfg.get<boolean>("enabled") ?? DEFAULT_CACHE_MISS_CONFIG.enabled,
    minPromptTokens: cfg.get<number>("minPromptTokens") ?? DEFAULT_CACHE_MISS_CONFIG.minPromptTokens,
    minWastedCredits: cfg.get<number>("minWastedCredits") ?? DEFAULT_CACHE_MISS_CONFIG.minWastedCredits,
  };
}

/** Bound on remembered misses so a long session cannot grow the set forever. */
const MAX_SEEN = 5000;

export class CacheMissNotifier {
  private readonly seen = new Set<string>();

  constructor(
    private readonly output: vscode.OutputChannel,
    /** Misses before this moment are history, not news. */
    private readonly sinceMs: number,
    /** Credits for a request's prompt/cached split, priced like the dashboard. */
    private readonly creditsFor: () => (model: string, prompt: number, cached: number) => number,
    private readonly openDashboard: () => void,
  ) {}

  /** Report any miss in `scan` that has not been reported yet. */
  ingest(scan: ScanResult | undefined): void {
    const cfg = getCacheMissConfig();
    if (!cfg.enabled || !scan) {
      return;
    }
    const ttlMap = getTtlConfig().ttlMap;
    const events = detectCacheMisses(scan.turns, {
      minPromptTokens: cfg.minPromptTokens,
      minWastedCredits: cfg.minWastedCredits,
      since: this.sinceMs,
      ttlMsFor: model => getTtlThresholds(mapTtlProvider(model), ttlMap).timerValue * 1000,
      creditsFor: this.creditsFor(),
    });

    const fresh: CacheMissEvent[] = [];
    for (const e of events) {
      const key = `${e.sessionId}|${e.model}|${e.debugName}|${e.timestamp}`;
      if (!this.seen.has(key)) {
        this.seen.add(key);
        fresh.push(e);
      }
    }
    if (this.seen.size > MAX_SEEN) {
      this.seen.clear();
    }
    if (fresh.length === 0) {
      return;
    }

    for (const e of fresh) {
      this.output.appendLine(`cacheMiss: ${describeCacheMiss(e)} [session ${e.sessionId.slice(0, 8)}, ${e.debugName || "chat"}]`);
    }
    void vscode.window
      .showWarningMessage(summarizeCacheMisses(fresh), "Open Dashboard", "Turn Off")
      .then(choice => {
        if (choice === "Open Dashboard") {
          this.openDashboard();
        } else if (choice === "Turn Off") {
          void vscode.workspace
            .getConfiguration("copilotUsage.cacheMiss")
            .update("enabled", false, vscode.ConfigurationTarget.Global);
        }
      });
  }
}

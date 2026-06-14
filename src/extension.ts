import * as vscode from "vscode";
import * as fs from "fs";
import { OTelReceiver } from "./otelReceiver";
import { StatusBarProvider, CurrentSessionInfo } from "./statusBar";
import { DashboardPanel } from "./dashboardPanel";
import { scanWorkspaceStorage, ScanResult, getWorkspaceStoragePath } from "./scanner";
import { scanAgentSessions, AgentScanResult } from "./agentScanner";
import { buildDashboardData, DashboardData, AIC_EFFECTIVE_DATE } from "./dashboardData";
import { SidebarViewProvider } from "./sidebarView";
import { buildSidebarSnapshot } from "./sidebarSnapshot";
import { AICConfig, DEFAULT_AIC_CONFIG, createCalculatorFromConfig } from "./aicCredits";
import {
  DailyLimitTracker,
  getDailyLimitConfig,
  type DailyLimitSnapshot,
} from "./dailyLimitTracker";
import { LimitOverlay } from "./limitOverlay";
import { Enforcement } from "./enforcement";
import { HookManager } from "./hookManager";
import { detectAndApplyPlan, resetPlanDetection } from "./planDetector";

const OTEL_PORT = 14318;
/**
 * Safety-net periodic scan when the live debug-log watcher and OTel receiver
 * aren't firing (e.g. fs.watch missed an event on a network share). Live
 * updates come from the file watcher (`setupDebugLogWatcher`) which fires
 * within ~1-2 seconds of any `main.jsonl` write, so this is only a fallback.
 */
const DEFAULT_REFRESH_MS = 30_000;
/** Debounce interval for OTel-triggered dashboard/status updates (ms) */
const OTEL_DEBOUNCE_MS = 2_000;

let receiver: OTelReceiver | undefined;
let statusBar: StatusBarProvider | undefined;
let sidebarProvider: SidebarViewProvider | undefined;
/** Latest CurrentSessionInfo produced by updateStatusBar(), reused by the
 *  sidebar for metadata (model name / turn count / duration). The credit
 *  values themselves are sourced from dashData.liveOtel in pushSidebarSnapshot
 *  so the sidebar and dashboard never drift. */
let lastCurrentSession: CurrentSessionInfo | null = null;
let scanTimer: ReturnType<typeof setInterval> | undefined;
let lastScan: ScanResult | undefined;
let lastAgentScan: AgentScanResult | undefined;
let output: vscode.OutputChannel;
/**
 * fs.watch on workspaceStorage to catch `main.jsonl` writes in real time.
 * When another VS Code window owns OTLP port 14318, this window's receiver
 * gets no events — but Copilot still writes the exact API-billed
 * `copilotUsageNanoAiu` to `<wsRoot>/<wsId>/GitHub.copilot-chat/debug-logs/<sid>/main.jsonl`.
 * Watching for those writes lets us refresh within ~1-2s of any new request
 * instead of waiting up to 120s for the periodic timer.
 */
let debugLogWatcher: fs.FSWatcher | undefined;
/** Cooldown timer that suppresses duplicate scans within 500 ms of a fire. */
let debugLogCooldownTimer: ReturnType<typeof setTimeout> | undefined;
/** Set true while the cooldown is active if another event arrived; triggers a single trailing scan. */
let debugLogTrailingPending = false;
/** Tracks whether a runScan() is in flight so we never queue two in parallel. */
let debugLogScanInFlight = false;
/** ISO timestamp of when this VS Code instance activated the extension — used to scope "current" to this instance only */
let activationTime: string;
/** Cached dashboard data — invalidated when scan or OTel changes */
let cachedDashData: DashboardData | undefined;
let lastOtelRequests = 0;
let otelDebounceTimer: ReturnType<typeof setTimeout> | undefined;

/** Daily-limit subsystem */
let limitTracker: DailyLimitTracker | undefined;
let limitOverlay: LimitOverlay | undefined;
let enforcement: Enforcement | undefined;
let hookManager: HookManager | undefined;
let limitDayKey: string | undefined;

function getAICConfig(): AICConfig {
  const cfg = vscode.workspace.getConfiguration("copilotUsage.aic");
  return {
    plan: cfg.get<string>("plan") ?? DEFAULT_AIC_CONFIG.plan,
    billingCycleStartDay:
      cfg.get<number>("billingCycleStartDay") ?? DEFAULT_AIC_CONFIG.billingCycleStartDay,
    monthlyCreditsIncluded:
      cfg.get<number>("monthlyCreditsIncluded") ?? DEFAULT_AIC_CONFIG.monthlyCreditsIncluded,
    overageCostPerCredit:
      cfg.get<number>("overageCostPerCredit") ?? DEFAULT_AIC_CONFIG.overageCostPerCredit,
    customModelCosts: cfg.get("customModelCosts") ?? DEFAULT_AIC_CONFIG.customModelCosts,
  };
}

function buildData(): DashboardData {
  const otelStats = receiver?.getStats() ?? null;
  const otelReqs = otelStats?.requests ?? 0;

  // Return cached data if nothing changed
  if (cachedDashData && otelReqs === lastOtelRequests) {
    return cachedDashData;
  }
  lastOtelRequests = otelReqs;

  const t0 = Date.now();
  const scan = lastScan ?? {
    sessions: [],
    turns: [],
    toolCalls: [],
    subagents: [],
    stats: {
      sourceFiles: 0,
      canonicalSessions: 0,
      mirroredSessions: 0,
      mirrorCopiesPruned: 0,
      turnsStored: 0,
      toolCallsStored: 0,
      promptPreviews: 0,
      transcriptsFound: 0,
      debugLogSessions: 0,
    },
  };
  const aicConfig = getAICConfig();
  cachedDashData = buildDashboardData(scan, otelStats, aicConfig, lastAgentScan, activationTime);
  const elapsed = Date.now() - t0;
  if (elapsed > 200) {
    output.appendLine(
      `buildData took ${elapsed}ms (${scan.stats.turnsStored} turns, ${scan.stats.canonicalSessions} sessions)`
    );
  }
  return cachedDashData;
}

async function runScan(): Promise<void> {
  try {
    const t0 = Date.now();
    const wsOverride = vscode.workspace
      .getConfiguration("copilotUsage")
      .get<string>("workspaceStoragePath", "")
      .trim();
    const [scanResult, agentResult] = await Promise.all([
      scanWorkspaceStorage(wsOverride || undefined),
      scanAgentSessions().catch((err: unknown) => {
        output.appendLine(`Agent scan error: ${err}`);
        return undefined as AgentScanResult | undefined;
      }),
    ]);
    lastScan = scanResult;
    lastAgentScan = agentResult;
    cachedDashData = undefined; // Invalidate cache
    const elapsed = Date.now() - t0;
    output.appendLine(
      `Scan: ${lastScan.stats.canonicalSessions} sessions, ${lastScan.stats.turnsStored} turns, ` +
        `${lastScan.stats.toolCallsStored} tools (${elapsed}ms)` +
        (lastAgentScan
          ? ` | Agent: OMP=${lastAgentScan.ompSessionCount} Pi=${lastAgentScan.piSessionCount} (${lastAgentScan.scanMs}ms)`
          : " | Agent: scan failed")
    );
  } catch (err) {
    output.appendLine(`Scan error: ${err}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Copilot Usage");
  context.subscriptions.push(output);

  // Record activation time — used to scope "current" stats to this VS Code instance
  activationTime = new Date().toISOString();

  // Auto-detect the user's Copilot plan via their existing GitHub session
  // (silent — no extra sign-in). Falls back to a one-time picker if the
  // session is missing or the SKU is unrecognised. Fire-and-forget so we
  // never block activation on a network call.
  void detectAndApplyPlan(context, m => output.appendLine(m));

  // Initial scan of chatSession files — MUST complete before activate()
  // returns so the dashboard, status bar, and any "openDashboard" command
  // see populated data on cold start. v1.9.14 tried to make this fire-
  // and-forget and shipped a dashboard that rendered all zeros until the
  // scan completed — unacceptable. The file watcher takes over for live
  // updates after this initial scan.
  await runScan();

  // Start OTel receiver
  receiver = new OTelReceiver();
  receiver.log = (msg: string) => output.appendLine(msg);
  let port: number;
  try {
    port = await receiver.start(OTEL_PORT);
    output.appendLine(`OTel receiver started on port ${port}`);
    if (port !== OTEL_PORT) {
      output.appendLine(`Port ${OTEL_PORT} was in use, fell back to ${port}`);
    }
  } catch (err) {
    output.appendLine(`Failed to start OTel receiver: ${err}`);
    vscode.window.showWarningMessage(
      `Copilot Usage: Could not start OTel receiver. Check Output → "Copilot Usage" for details.`
    );
    port = 0;
  }

  // Configure VS Code OTel settings to point to our port
  if (port > 0) {
    const expectedEndpoint = `http://127.0.0.1:${port}`;
    try {
      const config = vscode.workspace.getConfiguration("github.copilot.chat.otel");
      const currentEndpoint = config.get<string>("otlpEndpoint") ?? "";
      const currentEnabled = config.get<boolean>("enabled");
      const currentOutfile = config.get<string>("outfile") ?? "";

      // outfile overrides exporterType to "file", which prevents HTTP export
      const outfileConflict = currentOutfile.length > 0;

      const needsUpdate =
        currentEnabled !== true || currentEndpoint !== expectedEndpoint || outfileConflict;

      if (needsUpdate) {
        await config.update("enabled", true, vscode.ConfigurationTarget.Global);
        await config.update("exporterType", "otlp-http", vscode.ConfigurationTarget.Global);
        await config.update("otlpEndpoint", expectedEndpoint, vscode.ConfigurationTarget.Global);
        // Remove outfile — it overrides exporterType to "file".
        // The extension now relays /v1/logs to the same JSONL for hooks.
        if (outfileConflict) {
          await config.update("outfile", undefined, vscode.ConfigurationTarget.Global);
          output.appendLine(
            `Removed outfile setting (was: ${currentOutfile}) — relay handles JSONL output`
          );
        }
        output.appendLine(`Updated OTel settings: endpoint=${expectedEndpoint}`);
        void vscode.window
          .showInformationMessage(
            `Copilot Usage: OTel receiver on port ${port}. Reload VS Code once for Copilot to start exporting.`,
            "Reload Window"
          )
          .then(choice => {
            if (choice === "Reload Window") {
              void vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          });
      } else {
        output.appendLine(`OTel settings already correct: endpoint=${expectedEndpoint}`);
      }

      // Diagnostic summary — helps pinpoint why OTel may not be flowing
      const captureContent = config.get<boolean>("captureContent");
      const dbSpan = config.get<boolean>("dbSpanExporter.enabled");
      const exporterType = config.get<string>("exporterType");
      output.appendLine(
        `OTel config summary: enabled=true exporterType=${exporterType} endpoint=${expectedEndpoint} captureContent=${captureContent} dbSpanExporter=${dbSpan}`
      );
      output.appendLine(
        `Tip: If no spans appear below, open "Help → Toggle Developer Tools → Console" and search for "[OTel]"`
      );
      output.appendLine(
        `Tip: After changing settings, run "Developer: Reload Window" for Copilot Chat to pick them up`
      );
    } catch (err) {
      output.appendLine(`Could not update settings: ${err}`);
    }
  }

  // Status bar
  statusBar = new StatusBarProvider("copilotUsage.openDashboard");
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // ── Sidebar (Activity Bar) ─────────────────────────────────
  sidebarProvider = new SidebarViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("copilotUsage.sidebar.refresh", async () => {
      // Use the serialized wrapper so a manual refresh racing with the
      // debug-log watcher never triggers two concurrent scans (they would
      // race on the mtime cache). runScanSerialized() also handles
      // updateStatusBar + DashboardPanel.updateIfVisible internally.
      await runScanSerialized();
    }),
    vscode.commands.registerCommand("copilotUsage.sidebar.openDashboard", () => {
      DashboardPanel.show(context.extensionUri, buildData());
    })
  );
  // Session click → open the full dashboard. The dashboard does not yet
  // support deep-linking to a specific session, so the `sessionId` payload
  // is accepted but unused (logged for traceability). When per-session
  // focus lands in DashboardPanel.show, wire it through here.
  sidebarProvider.setOnSessionOpen((sessionId: string) => {
    if (sessionId) {
      output.appendLine(`Sidebar session click → opening dashboard (sessionId=${sessionId})`);
    }
    DashboardPanel.show(context.extensionUri, buildData());
  });
  // First open (or re-show) → push a fresh snapshot immediately so the user
  // never sees stale "Waiting…" placeholders when scan/OTel data already exists.
  sidebarProvider.setOnReady(() => {
    pushSidebarSnapshot();
  });

  // ── Daily limit subsystem ──────────────────────────────────
  limitTracker = new DailyLimitTracker(context);
  limitOverlay = new LimitOverlay(context.extensionUri);
  enforcement = new Enforcement(context, m => output.appendLine(m));
  hookManager = new HookManager(m => output.appendLine(m));

  // Install global Copilot agent hooks (denies tool calls in CLI / custom agents
  // / cloud agent when daily limit is reached). Opt-out via setting.
  if (getDailyLimitConfig().installAgentHooks !== false) {
    void hookManager.install();
  }

  // React to stage changes — log only. Enforcement decisions happen on every
  // snapshot (below) so snooze/resume/expiry all take effect immediately.
  limitTracker.onStageChange((snap, prev) => {
    output.appendLine(
      `Daily-limit stage: ${prev} → ${snap.stage} (${snap.used}/${snap.limit} = ${snap.percent}%)`
    );
  });

  // Daily-limit commands
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotUsage.dailyLimit.snooze", async () => {
      const mins = getDailyLimitConfig().snoozeMinutes;
      await limitTracker?.snooze(mins);
      output.appendLine(`Daily limit snoozed for ${mins} min.`);
      void vscode.window.showInformationMessage(`Copilot Usage: snoozed for ${mins} minutes.`);
      updateStatusBar();
    }),
    vscode.commands.registerCommand("copilotUsage.dailyLimit.resume", async () => {
      const aicCfg = getAICConfig();
      const snap =
        limitTracker?.last() ??
        limitTracker?.snapshot(
          lastScan,
          receiver?.getStats() ?? null,
          createCalculatorFromConfig(aicCfg),
          aicCfg.overageCostPerCredit ?? 0.01
        );
      if (snap) {
        await limitTracker?.markResumed(snap.dayKey);
      }
      await enforcement?.release();
      output.appendLine(`Daily limit overridden by user for today (${snap?.dayKey}).`);
      void vscode.window.showInformationMessage(
        "Copilot Usage: resumed for today. Counter will still grow."
      );
      updateStatusBar();
    }),
    vscode.commands.registerCommand("copilotUsage.dailyLimit.reset", async () => {
      await limitTracker?.clearSnooze();
      await limitTracker?.clearResume();
      await enforcement?.release();
      output.appendLine(
        "Daily-limit snooze + resume cleared — enforcement re-engaged on next snapshot."
      );
      void vscode.window.showInformationMessage(
        "Copilot Usage: override ended. Block will re-engage if you're still over today's limit."
      );
      updateStatusBar();
    }),
    vscode.commands.registerCommand("copilotUsage.dailyLimit.showShield", () => {
      const aicCfg = getAICConfig();
      const calc = createCalculatorFromConfig(aicCfg);
      const snap = limitTracker!.snapshot(
        lastScan,
        receiver?.getStats() ?? null,
        calc,
        aicCfg.overageCostPerCredit ?? 0.01
      );
      limitOverlay?.forceShow(snap);
    }),
    vscode.commands.registerCommand("copilotUsage.dailyLimit.installHooks", async () => {
      await hookManager?.install();
      const paths = hookManager?.paths();
      void vscode.window.showInformationMessage(
        `Copilot Usage: agent hooks installed at ${paths?.hookFile ?? "~/.copilot/hooks"}.`
      );
      // Push current snapshot to the new state file.
      updateStatusBar();
    }),
    vscode.commands.registerCommand("copilotUsage.dailyLimit.uninstallHooks", async () => {
      await hookManager?.uninstall();
      void vscode.window.showInformationMessage(
        "Copilot Usage: agent hooks removed. CLI / custom agents / cloud agent will no longer be blocked."
      );
    }),
    vscode.commands.registerCommand("copilotUsage.aic.detectPlan", async () => {
      await resetPlanDetection(context);
      await detectAndApplyPlan(context, m => output.appendLine(m));
    })
  );

  // Re-evaluate when daily-limit settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("copilotUsage.dailyLimit.installAgentHooks")) {
        const want = getDailyLimitConfig().installAgentHooks !== false;
        if (want && !hookManager?.isInstalled()) {
          void hookManager?.install();
        } else if (!want && hookManager?.isInstalled()) {
          void hookManager?.uninstall();
        }
      }
      if (
        e.affectsConfiguration("copilotUsage.dailyLimit") ||
        e.affectsConfiguration("copilotUsage.aic")
      ) {
        updateStatusBar();
      }
    })
  );

  // Initial status bar with scan data
  updateStatusBar();

  // LIVE PATH (cheap): on every OTel batch arrival, immediately refresh all
  // three consumers — status bar, sidebar, dashboard panel. These read from
  // in-memory OTel + the already-cached scan, so they cost ~ms. Holding them
  // behind the 2-second scan debounce (as v1.10.4 and earlier did) made the
  // dollars-first status bar and the +X¢ flash feel sluggish: the user would
  // see a request finish in chat ~2s before the bar's number ticked up.
  // `buildData()` is cache-keyed on `otelStats.requests`, so the two calls
  // below (one inside `updateStatusBar` → `pushSidebarSnapshot`, one for the
  // dashboard panel) return the same snapshot — no drift risk.
  //
  // DEBOUNCED PATH (expensive): coalesce bursts of OTel events into a single
  // `runScan()` so the debug-log `copilotUsageNanoAiu` overlay (exact API-
  // billed AIC) catches up without thrashing disk I/O. After the scan, we
  // refresh the UI one more time so the overlay-adjusted numbers land.
  receiver.onStats(() => {
    updateStatusBar();
    DashboardPanel.updateIfVisible(buildData());

    if (otelDebounceTimer) {
      return;
    }
    otelDebounceTimer = setTimeout(() => {
      otelDebounceTimer = undefined;
      void runScan().then(() => {
        updateStatusBar();
        DashboardPanel.updateIfVisible(buildData());
      });
    }, OTEL_DEBOUNCE_MS);
  });

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotUsage.openDashboard", () => {
      DashboardPanel.show(context.extensionUri, buildData());
    }),
    vscode.commands.registerCommand("copilotUsage.refresh", async () => {
      await runScan();
      updateStatusBar();
      DashboardPanel.show(context.extensionUri, buildData());
    })
  );

  // Handle file open requests from dashboard webview
  DashboardPanel.onOpenFile = (filePath: string) => {
    const uri = vscode.Uri.file(filePath);
    void vscode.workspace.openTextDocument(uri).then(
      doc => vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false }),
      err => {
        output.appendLine(`Failed to open file: ${filePath} — ${err}`);
        vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
      }
    );
  };

  // Handle manual refresh from dashboard webview
  DashboardPanel.onManualRefresh = () => {
    void runScan().then(() => {
      updateStatusBar();
      DashboardPanel.updateIfVisible(buildData());
      output.appendLine("Manual refresh triggered from dashboard");
    });
  };

  // Handle refresh rate changes from dashboard webview
  DashboardPanel.onRefreshRateChange = (intervalMs: number) => {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = undefined;
    }
    if (intervalMs > 0) {
      scanTimer = setInterval(() => {
        void runScan().then(() => {
          updateStatusBar();
          DashboardPanel.updateIfVisible(buildData());
        });
      }, intervalMs);
      output.appendLine(`Dashboard refresh rate set to ${intervalMs / 1000}s`);
    } else {
      output.appendLine(`Dashboard auto-refresh disabled`);
    }
  };

  // Periodic rescan of chatSession files
  scanTimer = setInterval(() => {
    void runScan().then(() => {
      updateStatusBar();
      DashboardPanel.updateIfVisible(buildData());
    });
  }, DEFAULT_REFRESH_MS);
  context.subscriptions.push({
    dispose: () => {
      if (scanTimer) {
        clearInterval(scanTimer);
      }
    },
  });

  // Live debug-log file watcher. The debug-logs directory contains
  // `main.jsonl` files that Copilot appends to in real time with API-exact
  // `copilotUsageNanoAiu`. By watching it directly we make the dashboard live
  // even when another VS Code window owns the OTLP receiver port (only one
  // extension instance can bind port 14318 at a time).
  void setupDebugLogWatcher();
  context.subscriptions.push({
    dispose: () => {
      if (debugLogCooldownTimer) {
        clearTimeout(debugLogCooldownTimer);
        debugLogCooldownTimer = undefined;
      }
      if (debugLogWatcher) {
        try {
          debugLogWatcher.close();
        } catch {
          /* ignore */
        }
        debugLogWatcher = undefined;
      }
    },
  });
}

/**
 * Set up a recursive `fs.watch` on workspaceStorage that triggers a debounced
 * rescan whenever a `main.jsonl` file changes. Failure is non-fatal — the
 * periodic timer still provides eventual consistency.
 */
async function setupDebugLogWatcher(): Promise<void> {
  try {
    const wsOverride = vscode.workspace
      .getConfiguration("copilotUsage")
      .get<string>("workspaceStoragePath", "")
      .trim();
    const wsRoot = await getWorkspaceStoragePath(wsOverride || undefined);
    if (!wsRoot) {
      return;
    }

    // recursive:true is supported on Windows + macOS natively and on Linux
    // since Node 20. Wrapped in try/catch so older runtimes degrade silently.
    debugLogWatcher = fs.watch(wsRoot, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.toString().endsWith("main.jsonl")) {
        return;
      }
      fireDebugLogScan();
    });

    debugLogWatcher.on("error", err => {
      output.appendLine(`debug-log watcher error (non-fatal): ${err}`);
    });
    output.appendLine(`Watching debug-logs under ${wsRoot} for real-time updates`);
  } catch (err) {
    output.appendLine(`debug-log watcher setup failed (non-fatal): ${err}`);
  }
}

/**
 * Leading-edge fire + trailing coalesce. The first event triggers a scan
 * immediately (no debounce wait). While that scan and the 500 ms cooldown are
 * pending, additional events are coalesced into a single trailing scan that
 * runs once the cooldown elapses. Result: the dashboard reacts within ~10 ms
 * of the first write of an in-flight request, then catches up once more after
 * the burst finishes so the final totals are correct.
 *
 * runScan() itself is also serialized — we never have two scans in flight.
 */
function fireDebugLogScan(): void {
  if (debugLogCooldownTimer) {
    // We're inside the cooldown window — record that a trailing scan is needed.
    debugLogTrailingPending = true;
    return;
  }

  // Leading edge: arm the cooldown and fire immediately.
  debugLogCooldownTimer = setTimeout(() => {
    debugLogCooldownTimer = undefined;
    if (debugLogTrailingPending) {
      debugLogTrailingPending = false;
      void runScanSerialized();
    }
  }, 500);
  void runScanSerialized();
}

/**
 * Serialized wrapper around runScan() so concurrent watcher events never
 * trigger two scans in parallel (they'd race on the mtime cache and waste
 * I/O). If a scan is already in flight, the caller is silently dropped —
 * the cooldown's trailing scan will pick up any missed work.
 */
async function runScanSerialized(): Promise<void> {
  if (debugLogScanInFlight) {
    debugLogTrailingPending = true;
    return;
  }
  debugLogScanInFlight = true;
  try {
    await runScan();
    updateStatusBar();
    DashboardPanel.updateIfVisible(buildData());
  } finally {
    debugLogScanInFlight = false;
  }
}

/** Minutes elapsed since this VS Code window's extension activated. */
function computeWindowDurationMin(): number {
  if (!activationTime) {
    return 0;
  }
  const ms = Date.now() - new Date(activationTime).getTime();
  return Math.max(0, Math.round(ms / 60_000));
}

function updateStatusBar(): void {
  if (!statusBar) {
    return;
  }
  const scan = lastScan?.stats ?? null;
  const otel = receiver?.getStats() ?? null;

  const aicConfig = getAICConfig();
  const calculator = createCalculatorFromConfig(aicConfig);
  const AIC_START = AIC_EFFECTIVE_DATE;

  // SOURCE OF TRUTH for AIC: `dashData.liveOtel` — the same numbers the
  // dashboard widgets and the sidebar render. Until v1.10.5 the status bar
  // had its own independent reimplementation of session/last-request AIC
  // computation, which had drifted from `dashboardData.liveOtel` repeatedly
  // (v1.9.17: bar 8025.8 vs dashboard 111.2; v1.10.2 sidebar 214.1 vs
  // dashboard 129.3; v1.10.4 bar $1.53 / 153.3 vs dashboard 90.3). Reading
  // straight from `dashData.liveOtel` makes drift impossible by construction
  // — there is now exactly one producer of the per-model exact-AIU overlay.
  // See .agents/agents.md "Status bar consumption" — this is the prescribed
  // shape (status bar and dashboard MUST stay in lock-step).
  const dashData = buildData();
  const currentSessionAIC = dashData.liveOtel.sessionAIC;
  const lastRequestAIC = dashData.liveOtel.lastRequestAIC;

  // Build currentSession METADATA only (model / turns / prompt / output /
  // duration). The `aicCredits` field is filled from `currentSessionAIC`
  // above — no credit math happens in this block.
  let currentSession: CurrentSessionInfo | null = null;
  if (otel && otel.requests > 0) {
    let otelPrompt = 0;
    let otelOutput = 0;
    let otelModel = "unknown";
    let maxTokens = 0;
    for (const m of otel.byModel.values()) {
      otelPrompt += m.prompt;
      otelOutput += m.completion;
      if (m.prompt + m.completion > maxTokens) {
        maxTokens = m.prompt + m.completion;
        otelModel = m.model;
      }
    }
    currentSession = {
      sessionId: "otel",
      sessionShort: "otel",
      model: otelModel,
      turns: otel.requests,
      prompt: otelPrompt,
      output: otelOutput,
      toolCalls: 0,
      durationMin: computeWindowDurationMin(),
      aicCredits: currentSessionAIC,
    };
  } else if (lastScan && lastScan.turns.length > 0) {
    // No live OTel — use scanner turns that arrived AFTER this extension activated.
    // This scopes "current" to this VS Code instance even when reading shared storage.
    const instanceTurns = lastScan.turns.filter(
      t => t.timestamp && t.timestamp >= activationTime && t.timestamp.slice(0, 10) >= AIC_START
    );

    if (instanceTurns.length > 0) {
      let instancePrompt = 0;
      let instanceOutput = 0;
      const modelTokens = new Map<string, number>();

      for (const t of instanceTurns) {
        instancePrompt += t.debugPromptTokens || t.promptTokens;
        instanceOutput += t.debugOutputTokens || t.outputTokens;
        const m = t.modelFamily || "unknown";
        modelTokens.set(
          m,
          (modelTokens.get(m) ?? 0) +
            (t.debugPromptTokens || t.promptTokens) +
            (t.debugOutputTokens || t.outputTokens)
        );
      }

      const topModel = [...modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
      currentSession = {
        sessionId: "instance",
        sessionShort: "instance",
        model: topModel,
        turns: instanceTurns.length,
        prompt: instancePrompt,
        output: instanceOutput,
        toolCalls: 0,
        durationMin: computeWindowDurationMin(),
        aicCredits: currentSessionAIC,
      };
    }
  }

  statusBar.updateStatus({
    otel,
    scan,
    currentSession,
    totalSessions: scan?.canonicalSessions ?? 0,
    currentSessionAIC,
    lastRequestAIC,
    dailyLimit: computeAndPushDailyLimit(calculator),
    dollarPerCredit: aicConfig.overageCostPerCredit ?? 0.01,
  });

  // Stash current-session metadata for the sidebar (model / turns / duration).
  // The sidebar's AIC numbers themselves are read from dashData.liveOtel in
  // pushSidebarSnapshot() so they always match the dashboard widgets.
  lastCurrentSession = currentSession;
  // Reuse the dashData we already computed — avoids a second buildData() call
  // per status update tick.
  pushSidebarSnapshot(dashData);
}

/** Build + post the latest SidebarSnapshot using whatever data we already have. */
function pushSidebarSnapshot(precomputed?: DashboardData): void {
  if (!sidebarProvider) {
    return;
  }
  try {
    // Reuse the caller's dashData when available (the common updateStatusBar
    // path already built it) — otherwise build our own. Both branches feed
    // the same `dashData.liveOtel` values into the sidebar so the AIC
    // numbers are guaranteed identical to the dashboard widgets.
    const dashData = precomputed ?? buildData();
    // SESSION-AIC SOURCE OF TRUTH: read from `dashData.liveOtel.sessionAIC`
    // and `dashData.liveOtel.lastRequestAIC` — NOT from the status-bar's
    // independent reimplementation cached in `lastCurrentSessionAIC` /
    // `lastRequestAICCached`. Per .agents/agents.md, the status-bar logic
    // and the dashboard liveOtel logic are independent reimplementations
    // that have drifted before (v1.9.17 regression: status bar said 8025.8
    // AIC while dashboard said 111.2 — and again in the wild during 1.10.2
    // testing where the sidebar showed 214.1 vs the dashboard's 129.3 for
    // the same window). Sourcing the sidebar from `dashData.liveOtel`
    // guarantees the sidebar and the dashboard widgets always agree.
    //
    // currentSessionModel / Turns / DurationMin are pure metadata (no
    // credit math) so they can keep coming from the status-bar helper.
    const snap = buildSidebarSnapshot({
      dashData,
      scanTurns: lastScan?.turns ?? [],
      liveStats: receiver?.getStats() ?? null,
      lastRequestAIC: dashData.liveOtel.lastRequestAIC,
      currentSessionAIC: dashData.liveOtel.sessionAIC,
      currentSessionModel: lastCurrentSession?.model ?? null,
      currentSessionTurns: lastCurrentSession?.turns ?? 0,
      currentSessionDurationMin: lastCurrentSession?.durationMin ?? 0,
      activationTime,
    });
    sidebarProvider.postSnapshot(snap);
  } catch (err) {
    output?.appendLine(`Sidebar snapshot build failed (non-fatal): ${err}`);
  }
}

function computeAndPushDailyLimit(calculator: ReturnType<typeof createCalculatorFromConfig>) {
  if (!limitTracker) {
    return undefined;
  }
  const cfg = getDailyLimitConfig();
  const aicCfg = getAICConfig();
  const dpc = aicCfg.overageCostPerCredit ?? 0.01;
  const snap = limitTracker.snapshot(lastScan, receiver?.getStats() ?? null, calculator, dpc);

  // When the guard is disabled, still propagate the (disabled) snapshot so the
  // hook state file unblocks agents and any enforcement is released. Skip the
  // overlay nag/enforce logic only.
  if (!cfg.enabled) {
    void hookManager?.updateFromSnapshot(snap);
    void enforcement?.release();
    // Keep shield in sync if it happens to be open (e.g. user just toggled off
    // from inside the webview — they want the toggle to still respond).
    limitOverlay?.render(snap);
    return summarizeSnapshot(snap);
  }

  // Auto-clear resume/snooze when the day rolls over.
  if (limitDayKey && limitDayKey !== snap.dayKey) {
    void (async () => {
      await limitTracker?.clearSnooze();
      await limitTracker?.clearResume();
      await enforcement?.release();
      output?.appendLine(
        `Day rolled ${limitDayKey} → ${snap.dayKey} — snooze/resume cleared, pause released.`
      );
    })();
  }
  limitDayKey = snap.dayKey;

  // Fire stage-change listeners (overlay + enforcement).
  limitTracker.push(snap);

  // Update hook state file so CLI / custom agents / cloud agent see the new
  // blocked/unblocked state on their next tool call.
  void hookManager?.updateFromSnapshot(snap);

  // Continuous enforcement decision — runs on every snapshot, not just stage change.
  // This is what makes Snooze/Resume/expiry transitions actually take effect.
  const shouldBlock = snap.stage === "limit" && !snap.snoozed && !snap.resumed;
  void (async () => {
    if (shouldBlock) {
      await enforcement?.enforce(snap.enforcement);
    } else {
      await enforcement?.release();
    }
  })();

  // Always re-render overlay so it can re-nag on every new request while at limit.
  limitOverlay?.render(snap);

  return summarizeSnapshot(snap);
}

/** Project the subset of snapshot fields exposed via the status bar callback. */
function summarizeSnapshot(snap: DailyLimitSnapshot) {
  return {
    stage: snap.stage,
    used: snap.used,
    limit: snap.limit,
    percent: snap.percent,
    usedDollars: snap.usedDollars,
    limitDollars: snap.limitDollars,
    dollarMode: snap.dollarMode,
    snoozed: snap.snoozed,
    resumed: snap.resumed,
  };
}

export function deactivate(): void {
  if (scanTimer) {
    clearInterval(scanTimer);
  }
  if (otelDebounceTimer) {
    clearTimeout(otelDebounceTimer);
  }
  if (debugLogCooldownTimer) {
    clearTimeout(debugLogCooldownTimer);
    debugLogCooldownTimer = undefined;
  }
  if (debugLogWatcher) {
    try {
      debugLogWatcher.close();
    } catch {
      /* ignore */
    }
    debugLogWatcher = undefined;
  }
  receiver?.stop();
  statusBar?.dispose();
}

import * as vscode from "vscode";
import { OTelReceiver } from "./otelReceiver";
import { StatusBarProvider, CurrentSessionInfo } from "./statusBar";
import { DashboardPanel } from "./dashboardPanel";
import { scanWorkspaceStorage, ScanResult } from "./scanner";
import { scanAgentSessions, AgentScanResult } from "./agentScanner";
import { buildDashboardData, DashboardData } from "./dashboardData";
import { AICConfig, DEFAULT_AIC_CONFIG, createCalculatorFromConfig } from "./aicCredits";

const OTEL_PORT = 14318;
const DEFAULT_REFRESH_MS = 120_000;
/** Debounce interval for OTel-triggered dashboard/status updates (ms) */
const OTEL_DEBOUNCE_MS = 2_000;

let receiver: OTelReceiver | undefined;
let statusBar: StatusBarProvider | undefined;
let scanTimer: ReturnType<typeof setInterval> | undefined;
let lastScan: ScanResult | undefined;
let lastAgentScan: AgentScanResult | undefined;
let output: vscode.OutputChannel;
/** ISO timestamp of when this VS Code instance activated the extension — used to scope "current" to this instance only */
let activationTime: string;
/** Cached dashboard data — invalidated when scan or OTel changes */
let cachedDashData: DashboardData | undefined;
let lastOtelRequests = 0;
let otelDebounceTimer: ReturnType<typeof setTimeout> | undefined;

function getAICConfig(): AICConfig {
  const cfg = vscode.workspace.getConfiguration("copilotUsage.aic");
  return {
    plan: cfg.get<string>("plan") ?? DEFAULT_AIC_CONFIG.plan,
    billingCycleStartDay: cfg.get<number>("billingCycleStartDay") ?? DEFAULT_AIC_CONFIG.billingCycleStartDay,
    monthlyCreditsIncluded: cfg.get<number>("monthlyCreditsIncluded") ?? DEFAULT_AIC_CONFIG.monthlyCreditsIncluded,
    overageCostPerCredit: cfg.get<number>("overageCostPerCredit") ?? DEFAULT_AIC_CONFIG.overageCostPerCredit,
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
  const scan = lastScan ?? { sessions: [], turns: [], toolCalls: [], subagents: [], stats: { sourceFiles: 0, canonicalSessions: 0, mirroredSessions: 0, mirrorCopiesPruned: 0, turnsStored: 0, toolCallsStored: 0, promptPreviews: 0, transcriptsFound: 0, debugLogSessions: 0 } };
  const aicConfig = getAICConfig();
  cachedDashData = buildDashboardData(scan, otelStats, aicConfig, lastAgentScan);
  const elapsed = Date.now() - t0;
  if (elapsed > 200) {
    output.appendLine(`buildData took ${elapsed}ms (${scan.stats.turnsStored} turns, ${scan.stats.canonicalSessions} sessions)`);
  }
  return cachedDashData;
}

async function runScan(): Promise<void> {
  try {
    const t0 = Date.now();
    const [scanResult, agentResult] = await Promise.all([
      scanWorkspaceStorage(),
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
        : " | Agent: scan failed"),
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

  // Initial scan of chatSession files
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

      const needsUpdate = currentEnabled !== true
        || currentEndpoint !== expectedEndpoint
        || outfileConflict;

      if (needsUpdate) {
        await config.update("enabled", true, vscode.ConfigurationTarget.Global);
        await config.update("exporterType", "otlp-http", vscode.ConfigurationTarget.Global);
        await config.update("otlpEndpoint", expectedEndpoint, vscode.ConfigurationTarget.Global);
        // Remove outfile — it overrides exporterType to "file".
        // The extension now relays /v1/logs to the same JSONL for hooks.
        if (outfileConflict) {
          await config.update("outfile", undefined, vscode.ConfigurationTarget.Global);
          output.appendLine(`Removed outfile setting (was: ${currentOutfile}) — relay handles JSONL output`);
        }
        output.appendLine(`Updated OTel settings: endpoint=${expectedEndpoint}`);
        void vscode.window.showInformationMessage(
          `Copilot Usage: OTel receiver on port ${port}. Reload VS Code once for Copilot to start exporting.`,
          "Reload Window",
        ).then(choice => {
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
      output.appendLine(`OTel config summary: enabled=true exporterType=${exporterType} endpoint=${expectedEndpoint} captureContent=${captureContent} dbSpanExporter=${dbSpan}`);
      output.appendLine(`Tip: If no spans appear below, open "Help → Toggle Developer Tools → Console" and search for "[OTel]"`);
      output.appendLine(`Tip: After changing settings, run "Developer: Reload Window" for Copilot Chat to pick them up`);
    } catch (err) {
      output.appendLine(`Could not update settings: ${err}`);
    }
  }

  // Status bar
  statusBar = new StatusBarProvider("copilotUsage.openDashboard");
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Initial status bar with scan data
  updateStatusBar();

  // Update status bar and dashboard on new OTel data (debounced to avoid thrashing)
  receiver.onStats(() => {
    if (otelDebounceTimer) { return; } // Already scheduled
    otelDebounceTimer = setTimeout(() => {
      otelDebounceTimer = undefined;
      updateStatusBar();
      DashboardPanel.updateIfVisible(buildData());
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
    }),
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
      output.appendLine('Manual refresh triggered from dashboard');
    });
  };

  // Handle refresh rate changes from dashboard webview
  DashboardPanel.onRefreshRateChange = (intervalMs: number) => {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = undefined; }
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
  context.subscriptions.push({ dispose: () => { if (scanTimer) { clearInterval(scanTimer); } } });
}

function updateStatusBar(): void {
  if (!statusBar) { return; }
  const scan = lastScan?.stats ?? null;
  const otel = receiver?.getStats() ?? null;

  let currentSession: CurrentSessionInfo | null = null;
  let currentSessionAIC = 0;

  const aicConfig = getAICConfig();
  const calculator = createCalculatorFromConfig(aicConfig);
  const AIC_START = "2026-06-01";

  // When live OTel is active it is already scoped to this VS Code instance (in-memory).
  // Compute AIC from OTel directly — no scanner needed for "current".
  if (otel && otel.requests > 0) {
    let otelAIC = 0;
    let otelPrompt = 0;
    let otelOutput = 0;
    let otelModel = "unknown";
    let maxTokens = 0;
    for (const m of otel.byModel.values()) {
      const usage = calculator.calculateCredits(m.model, m.prompt, m.completion, m.cached, m.cacheWrite);
      otelAIC += usage.totalCredits;
      otelPrompt += m.prompt;
      otelOutput += m.completion;
      if (m.prompt + m.completion > maxTokens) { maxTokens = m.prompt + m.completion; otelModel = m.model; }
    }
    currentSessionAIC = Math.round(otelAIC * 100) / 100;
    currentSession = {
      sessionId: "otel",
      sessionShort: "otel",
      model: otelModel,
      turns: otel.requests,
      prompt: otelPrompt,
      output: otelOutput,
      toolCalls: 0,
      durationMin: 0,
      aicCredits: currentSessionAIC,
    };
  } else if (lastScan && lastScan.turns.length > 0) {
    // No live OTel — use scanner turns that arrived AFTER this extension activated.
    // This scopes "current" to this VS Code instance even when reading shared storage.
    const instanceTurns = lastScan.turns.filter(t =>
      t.timestamp && t.timestamp >= activationTime && t.timestamp.slice(0, 10) >= AIC_START
    );

    if (instanceTurns.length > 0) {
      let instanceAIC = 0;
      let instancePrompt = 0;
      let instanceOutput = 0;
      const modelTokens = new Map<string, number>();

      for (const t of instanceTurns) {
        if (t.debugAicCredits > 0) {
          instanceAIC += t.debugAicCredits;
        } else {
          const usage = calculator.calculateCredits(
            t.modelFamily || "unknown",
            t.debugPromptTokens || t.promptTokens,
            t.debugOutputTokens || t.outputTokens,
            0
          );
          instanceAIC += usage.totalCredits;
        }
        instancePrompt += t.debugPromptTokens || t.promptTokens;
        instanceOutput += t.debugOutputTokens || t.outputTokens;
        const m = t.modelFamily || "unknown";
        modelTokens.set(m, (modelTokens.get(m) ?? 0) + (t.debugPromptTokens || t.promptTokens) + (t.debugOutputTokens || t.outputTokens));
      }

      const topModel = [...modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
      currentSessionAIC = Math.round(instanceAIC * 100) / 100;
      currentSession = {
        sessionId: "instance",
        sessionShort: "instance",
        model: topModel,
        turns: instanceTurns.length,
        prompt: instancePrompt,
        output: instanceOutput,
        toolCalls: 0,
        durationMin: 0,
        aicCredits: currentSessionAIC,
      };
    }
  }

  // Compute per-request AIC from last OTel request
  let lastRequestAIC = 0;
  if (otel && otel.lastRequest) {
    const lr = otel.lastRequest;
    const reqCredits = calculator.calculateCredits(lr.modelName, lr.promptTokens, lr.completionTokens, lr.cachedTokens, lr.cacheWriteTokens);
    lastRequestAIC = Math.round(reqCredits.totalCredits * 100) / 100;
  }

  statusBar.updateStatus({
    otel,
    scan,
    currentSession,
    totalSessions: scan?.canonicalSessions ?? 0,
    currentSessionAIC,
    lastRequestAIC,
  });
}

export function deactivate(): void {
  if (scanTimer) { clearInterval(scanTimer); }
  if (otelDebounceTimer) { clearTimeout(otelDebounceTimer); }
  receiver?.stop();
  statusBar?.dispose();
}

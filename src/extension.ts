import * as vscode from "vscode";
import { OTelReceiver } from "./otelReceiver";
import { StatusBarProvider, CurrentSessionInfo } from "./statusBar";
import { DashboardPanel } from "./dashboardPanel";
import { scanWorkspaceStorage, ScanResult } from "./scanner";
import { buildDashboardData, DashboardData } from "./dashboardData";
import { AICConfig, DEFAULT_AIC_CONFIG, createCalculatorFromConfig } from "./aicCredits";

const OTEL_PORT = 14318;
const DEFAULT_REFRESH_MS = 120_000;

let receiver: OTelReceiver | undefined;
let statusBar: StatusBarProvider | undefined;
let scanTimer: ReturnType<typeof setInterval> | undefined;
let lastScan: ScanResult | undefined;
let output: vscode.OutputChannel;

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
  const scan = lastScan ?? { sessions: [], turns: [], toolCalls: [], subagents: [], stats: { sourceFiles: 0, canonicalSessions: 0, mirroredSessions: 0, mirrorCopiesPruned: 0, turnsStored: 0, toolCallsStored: 0, promptPreviews: 0, transcriptsFound: 0, debugLogSessions: 0 } };
  const live = receiver?.getStats() ?? null;
  const aicConfig = getAICConfig();
  return buildDashboardData(scan, live, aicConfig);
}

async function runScan(): Promise<void> {
  try {
    lastScan = scanWorkspaceStorage();
    output.appendLine(`Scan: ${lastScan.stats.canonicalSessions} sessions, ${lastScan.stats.turnsStored} turns, ${lastScan.stats.toolCallsStored} tools`);
  } catch (err) {
    output.appendLine(`Scan error: ${err}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("Copilot Usage");
  context.subscriptions.push(output);

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
        vscode.window.showInformationMessage(
          `Copilot Usage: OTel receiver on port ${port}. Reload VS Code once for Copilot to start exporting.`,
          "Reload Window",
        ).then(choice => {
          if (choice === "Reload Window") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });
      } else {
        output.appendLine(`OTel settings already correct: endpoint=${expectedEndpoint}`);
      }
    } catch (err) {
      output.appendLine(`Could not update settings: ${err}`);
    }
  }

  // Status bar
  statusBar = new StatusBarProvider("copilotUsage.openDashboard");
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // Initial status bar with scan data
  updateStatusBar();

  // Update status bar and dashboard on new OTel data
  receiver.onStats(() => {
    updateStatusBar();
    DashboardPanel.updateIfVisible(buildData());
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
    vscode.workspace.openTextDocument(uri).then(
      doc => vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false }),
      err => {
        output.appendLine(`Failed to open file: ${filePath} — ${err}`);
        vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
      }
    );
  };

  // Handle manual refresh from dashboard webview
  DashboardPanel.onManualRefresh = async () => {
    await runScan();
    updateStatusBar();
    DashboardPanel.updateIfVisible(buildData());
    output.appendLine('Manual refresh triggered from dashboard');
  };

  // Handle refresh rate changes from dashboard webview
  DashboardPanel.onRefreshRateChange = (intervalMs: number) => {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = undefined; }
    if (intervalMs > 0) {
      scanTimer = setInterval(async () => {
        await runScan();
        updateStatusBar();
        DashboardPanel.updateIfVisible(buildData());
      }, intervalMs);
      output.appendLine(`Dashboard refresh rate set to ${intervalMs / 1000}s`);
    } else {
      output.appendLine(`Dashboard auto-refresh disabled`);
    }
  };

  // Periodic rescan of chatSession files
  scanTimer = setInterval(async () => {
    await runScan();
    updateStatusBar();
    DashboardPanel.updateIfVisible(buildData());
  }, DEFAULT_REFRESH_MS);
  context.subscriptions.push({ dispose: () => { if (scanTimer) { clearInterval(scanTimer); } } });
}

function updateStatusBar(): void {
  if (!statusBar) { return; }
  const scan = lastScan?.stats ?? null;
  const otel = receiver?.getStats() ?? null;

  // Find the most recent session (proxy for "current active session" in this instance)
  let currentSession: CurrentSessionInfo | null = null;
  let currentSessionAIC = 0;

  if (lastScan && lastScan.sessions.length > 0) {
    const sorted = [...lastScan.sessions].sort((a, b) =>
      (b.lastTimestamp || "").localeCompare(a.lastTimestamp || "")
    );
    const latest = sorted[0];

    // Compute AIC for this session
    // Prefer actual API-reported AIC (copilotUsageNanoAiu) over computed from rates
    const aicConfig = getAICConfig();
    const calculator = createCalculatorFromConfig(aicConfig);
    const sessionTurns = lastScan.turns.filter(t => t.sessionId === latest.sessionId && t.timestamp);
    let sessionAIC = 0;
    for (const t of sessionTurns) {
      const date = t.timestamp.slice(0, 10);
      if (date < "2026-06-01") { continue; }
      if (t.debugAicCredits > 0) {
        sessionAIC += t.debugAicCredits;
      } else {
        const usage = calculator.calculateCredits(
          t.modelFamily || "unknown",
          t.debugPromptTokens || t.promptTokens,
          t.debugOutputTokens || t.outputTokens,
          0
        );
        sessionAIC += usage.totalCredits;
      }
    }

    // Cross-check: if session has actual API-reported total AIC, use it
    if (latest.debugTotalAicCredits > 0) {
      sessionAIC = latest.debugTotalAicCredits;
    }

    // Duration
    let durationMin = 0;
    if (latest.firstTimestamp && latest.lastTimestamp) {
      const start = new Date(latest.firstTimestamp).getTime();
      const end = new Date(latest.lastTimestamp).getTime();
      if (end > start) { durationMin = Math.round((end - start) / 60000 * 10) / 10; }
    }

    const toolCount = lastScan.toolCalls.filter(tc => tc.sessionId === latest.sessionId).length;

    currentSession = {
      sessionId: latest.sessionId,
      sessionShort: latest.sessionId.slice(0, 8),
      model: latest.modelFamily || latest.modelName || "unknown",
      turns: latest.turnCount,
      prompt: latest.debugTotalPrompt || latest.totalPromptTokens,
      output: latest.debugTotalOutput || latest.totalOutputTokens,
      toolCalls: toolCount,
      durationMin,
      aicCredits: Math.round(sessionAIC * 100) / 100,
    };
    currentSessionAIC = Math.round(sessionAIC * 100) / 100;
  }

  statusBar.updateStatus({
    otel,
    scan,
    currentSession,
    totalSessions: scan?.canonicalSessions ?? 0,
    currentSessionAIC,
  });
}

export function deactivate(): void {
  if (scanTimer) { clearInterval(scanTimer); }
  receiver?.stop();
  statusBar?.dispose();
}

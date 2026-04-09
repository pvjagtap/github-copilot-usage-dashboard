import * as vscode from "vscode";
import { OTelReceiver } from "./otelReceiver";
import { StatusBarProvider, StatusBarData } from "./statusBar";
import { DashboardPanel } from "./dashboardPanel";
import { scanWorkspaceStorage, ScanResult } from "./scanner";
import { buildDashboardData, DashboardData } from "./dashboardData";

const OTEL_PORT = 14318;
const DEFAULT_REFRESH_MS = 120_000;

let receiver: OTelReceiver | undefined;
let statusBar: StatusBarProvider | undefined;
let scanTimer: ReturnType<typeof setInterval> | undefined;
let lastScan: ScanResult | undefined;
let output: vscode.OutputChannel;

function buildData(): DashboardData {
  const scan = lastScan ?? { sessions: [], turns: [], toolCalls: [], subagents: [], stats: { sourceFiles: 0, canonicalSessions: 0, mirroredSessions: 0, mirrorCopiesPruned: 0, turnsStored: 0, toolCallsStored: 0, promptPreviews: 0, transcriptsFound: 0 } };
  const live = receiver?.getStats() ?? null;
  return buildDashboardData(scan, live);
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

      const needsUpdate = currentEnabled !== true
        || currentEndpoint !== expectedEndpoint;

      if (needsUpdate) {
        await config.update("enabled", true, vscode.ConfigurationTarget.Global);
        await config.update("exporterType", "otlp-http", vscode.ConfigurationTarget.Global);
        await config.update("otlpEndpoint", expectedEndpoint, vscode.ConfigurationTarget.Global);
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
  let currentRefreshMs = DEFAULT_REFRESH_MS;
  DashboardPanel.onRefreshRateChange = (intervalMs: number) => {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = undefined; }
    currentRefreshMs = intervalMs;
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
  const totalPrompt = lastScan?.turns.reduce((s, t) => s + t.promptTokens, 0) ?? 0;
  const totalOutput = lastScan?.turns.reduce((s, t) => s + t.outputTokens, 0) ?? 0;
  statusBar.updateStatus({
    otel: receiver?.getStats() ?? null,
    scan,
    totalPrompt,
    totalOutput,
  });
}

export function deactivate(): void {
  if (scanTimer) { clearInterval(scanTimer); }
  receiver?.stop();
  statusBar?.dispose();
}

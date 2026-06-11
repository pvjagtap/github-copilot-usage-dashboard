/**
 * enforcement.ts — Applies the chosen daily-limit enforcement mode.
 *
 * Reality: a VS Code extension cannot intercept GitHub Copilot's outbound
 * HTTPS requests. So enforcement is done via Copilot's own toggles:
 *
 *   soft   → no action taken; overlay + modal nag is the only deterrent.
 *   pause  → set `github.copilot.enable` to { "*": false } globally
 *            (disables inline completions for all languages). Chat cannot
 *            be silenced without a reload, so a modal block is shown.
 *   strict → call workbench.extensions.disableExtension on both
 *            "GitHub.copilot" and "GitHub.copilot-chat" and prompt reload.
 *
 * On reset (next day or user "Resume"), `pause` is reversed automatically.
 * `strict` requires the user to re-enable extensions manually because
 * we never want to silently re-enable code-running extensions.
 */

import * as vscode from "vscode";

const COPILOT_ENABLE_BACKUP_KEY = "copilotUsage.dailyLimit.enableBackup";
const COPILOT_PAUSED_KEY = "copilotUsage.dailyLimit.copilotPaused";

export type EnforcementMode = "soft" | "pause" | "strict";

export class Enforcement {
  /** True while we have already shown the enforce-notification for the current limit hit. */
  private nagShown = false;

  constructor(
    private context: vscode.ExtensionContext,
    private log: (msg: string) => void
  ) {}

  /** Apply enforcement at limit. Idempotent — only nags once per limit hit. */
  async enforce(mode: EnforcementMode): Promise<void> {
    if (mode === "soft") {
      if (!this.nagShown) {
        this.nagShown = true;
        this.log("Daily limit reached — soft mode (no Copilot toggle).");
      }
      return;
    }
    if (mode === "pause") {
      await this.pauseCompletions();
      if (this.nagShown) {
        return;
      }
      this.nagShown = true;
      void vscode.window
        .showWarningMessage(
          "Daily Copilot AI Credit limit reached. Inline completions paused.\n" +
            "Chat cannot be auto-disabled — please avoid sending new chat requests until tomorrow.",
          { modal: false },
          "Open Shield",
          "Resume Anyway",
          "Snooze 10 min"
        )
        .then(choice => {
          if (choice === "Open Shield") {
            void vscode.commands.executeCommand("copilotUsage.dailyLimit.showShield");
          } else if (choice === "Resume Anyway") {
            void vscode.commands.executeCommand("copilotUsage.dailyLimit.resume");
          } else if (choice === "Snooze 10 min") {
            void vscode.commands.executeCommand("copilotUsage.dailyLimit.snooze");
          }
        });
      return;
    }
    if (mode === "strict") {
      if (this.nagShown) {
        return;
      }
      this.nagShown = true;
      const choice = await vscode.window.showWarningMessage(
        "Daily Copilot AI Credit limit reached. Strict mode will disable GitHub Copilot and " +
          "Copilot Chat extensions. A window reload is required.",
        { modal: true },
        "Disable & Reload",
        "Snooze 10 min",
        "Resume Anyway"
      );
      if (choice === "Disable & Reload") {
        try {
          await vscode.commands.executeCommand(
            "workbench.extensions.disableExtension",
            "GitHub.copilot"
          );
          await vscode.commands.executeCommand(
            "workbench.extensions.disableExtension",
            "GitHub.copilot-chat"
          );
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        } catch (err) {
          this.log(`Strict-mode disable failed: ${err}`);
        }
      } else if (choice === "Resume Anyway") {
        void vscode.commands.executeCommand("copilotUsage.dailyLimit.resume");
      } else if (choice === "Snooze 10 min") {
        void vscode.commands.executeCommand("copilotUsage.dailyLimit.snooze");
      }
    }
  }

  /** Reverse "pause" mode. Safe to call even if not currently paused. */
  async release(): Promise<void> {
    // Reset the one-shot nag flag so the next limit hit nags again.
    this.nagShown = false;
    const wasPaused = this.context.globalState.get<boolean>(COPILOT_PAUSED_KEY);
    if (!wasPaused) {
      return;
    }
    try {
      const backup = this.context.globalState.get<Record<string, boolean> | undefined>(
        COPILOT_ENABLE_BACKUP_KEY
      );
      const cfg = vscode.workspace.getConfiguration("github.copilot");
      // Restore previous value if we backed one up; otherwise remove the override.
      await cfg.update("enable", backup ?? undefined, vscode.ConfigurationTarget.Global);
      await this.context.globalState.update(COPILOT_PAUSED_KEY, false);
      await this.context.globalState.update(COPILOT_ENABLE_BACKUP_KEY, undefined);
      this.log("Released pause — github.copilot.enable restored.");
    } catch (err) {
      this.log(`Release failed: ${err}`);
    }
  }

  private async pauseCompletions(): Promise<void> {
    const alreadyPaused = this.context.globalState.get<boolean>(COPILOT_PAUSED_KEY);
    if (alreadyPaused) {
      return;
    }
    try {
      const cfg = vscode.workspace.getConfiguration("github.copilot");
      const current = cfg.get<Record<string, boolean>>("enable");
      // Backup the user's prior value so we can restore later.
      await this.context.globalState.update(COPILOT_ENABLE_BACKUP_KEY, current);
      await cfg.update("enable", { "*": false }, vscode.ConfigurationTarget.Global);
      await this.context.globalState.update(COPILOT_PAUSED_KEY, true);
      this.log("Paused — github.copilot.enable set to { '*': false }.");
    } catch (err) {
      this.log(`Pause failed: ${err}`);
    }
  }
}

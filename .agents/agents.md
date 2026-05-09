# Build Rules

## Environment

- **Node.js path**: `C:\nodejs\node.exe` (npx/npm are NOT on PATH — always use full path)
- All npm/npx commands must be run as: `C:\nodejs\node.exe node_modules\<tool>\bin\<script>`
- TypeScript compile: `C:\nodejs\node.exe node_modules\typescript\bin\tsc -p ./`
- VSCE package: `C:\nodejs\node.exe node_modules\@vscode\vsce\vsce package`
- ESLint: `C:\nodejs\node.exe node_modules\.bin\eslint src/**/*.ts`

## STRICT: No Package Installation

**NEVER run `npm install`, `npm i`, or any variant.** All dependencies are already installed.
Do NOT add, remove, or update any packages. If a dependency is missing, ask the user.

## Pre-Build Checklist (MANDATORY before creating any VSIX)

1. **Lint first** — Run ESLint (see Environment section)
2. **Fix all errors and warnings** — Zero tolerance. No warnings, no errors.
3. **Compile** — Run TypeScript compile (see Environment section)
4. **Only then package** — Run VSCE package (see Environment section)

## Quick Reference

```powershell
cd d:\FineTuneLLM\githubcopilot_token_usage\copilot-usage-extension
C:\nodejs\node.exe node_modules\.bin\eslint src/**/*.ts          # Step 1: Lint
C:\nodejs\node.exe node_modules\typescript\bin\tsc -p ./          # Step 2: Compile
C:\nodejs\node.exe node_modules\@vscode\vsce\vsce package         # Step 3: Package VSIX
```

## Project Structure

- `copilot-usage-extension/` — VS Code extension (TypeScript)
  - `src/dashboardPanel.ts` — Main webview UI (HTML/CSS/Chart.js inline)
  - `src/dashboardData.ts` — Data layer (DashboardData interface, buildDashboardData)
  - `src/scanner.ts` — JSONL file parser for chatSessions
  - `src/extension.ts` — Extension activation, commands, timers
  - `src/otelReceiver.ts` — OpenTelemetry HTTP receiver
  - `src/statusBar.ts` — Status bar provider

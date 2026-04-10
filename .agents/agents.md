# Build Rules

## Pre-Build Checklist (MANDATORY before creating any VSIX)

1. **Lint first** — Run `npx eslint src/**/*.ts` in the `copilot-usage-extension/` directory
2. **Fix all errors and warnings** — Zero tolerance. No warnings, no errors.
3. **Compile** — Run `npm run compile` to verify TypeScript compiles cleanly
4. **Only then package** — Run `npx @vscode/vsce package` to create the VSIX

## Quick Reference

```bash
cd copilot-usage-extension
npx eslint src/**/*.ts    # Step 1: Lint (must pass with 0 issues)
npm run compile            # Step 2: TypeScript compile
npx @vscode/vsce package  # Step 3: Package VSIX
```

## Project Structure

- `copilot-usage-extension/` — VS Code extension (TypeScript)
  - `src/dashboardPanel.ts` — Main webview UI (HTML/CSS/Chart.js inline)
  - `src/dashboardData.ts` — Data layer (DashboardData interface, buildDashboardData)
  - `src/scanner.ts` — JSONL file parser for chatSessions
  - `src/extension.ts` — Extension activation, commands, timers
  - `src/otelReceiver.ts` — OpenTelemetry HTTP receiver
  - `src/statusBar.ts` — Status bar provider

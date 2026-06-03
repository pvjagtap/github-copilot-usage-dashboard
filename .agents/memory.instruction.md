---
applyTo: '**'
---

# Coding Preferences
- No package installation in this repo; use existing dependencies only.
- On Windows, invoke tool entrypoints directly with `C:\nodejs\node.exe` instead of `node_modules/.bin` shell wrappers when needed.

# Project Architecture
- VS Code extension in TypeScript with source under `src/`.
- `src/scanner.ts` parses workspaceStorage chat sessions and debug logs.
- `src/otelReceiver.ts` hosts a local OTLP HTTP receiver and aggregates live stats.
- `src/dashboardData.ts` computes dashboard aggregates; `src/dashboardPanel.ts` renders the webview UI.

# Solutions Repository
- Repository currently has a single git commit baseline plus local uncommitted edits.
- `C:\nodejs\node.exe node_modules\typescript\bin\tsc -p ./` compiles cleanly in this workspace.
- `C:\nodejs\node.exe node_modules\eslint\bin\eslint.js src/**/*.ts` is the Windows-safe lint entrypoint; `node_modules\.bin\eslint` is a POSIX shim here.
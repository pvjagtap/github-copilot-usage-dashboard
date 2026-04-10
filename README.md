# Copilot Usage Dashboard

<p align="center">
  <img src="images/icon.png" width="128" height="128" alt="Copilot Usage Dashboard Logo">
</p>

<p align="center">
  <strong>A self-contained VS Code extension that gives you full visibility into your GitHub Copilot token usage.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/VS%20Code-1.85%2B-blue?logo=visualstudiocode" alt="VS Code 1.85+">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
  <img src="https://img.shields.io/badge/Version-0.1.3-purple" alt="Version">
</p>

---

## Features

- Token counts (prompt, output, cached) per session, model, project, and day
- Session browser with title, preview, duration, tools, and subagent usage
- Clickable links to session log and transcript JSONL files
- Model breakdown across Claude, GPT, Gemini families
- Daily usage trends (stacked bar chart)
- Tool and subagent call tracking
- Live OpenTelemetry receiver (OTLP HTTP on port 14318)
- Premium usage estimation with model multipliers
- Auto-refresh (30s / 1m / 2m / 5m / Off) and manual refresh
- Status bar with session count and token totals
- Multi-root workspace support

## Install

From VSIX:

```
code --install-extension copilot-usage-dashboard-0.1.3.vsix
```

From source:

```
cd copilot-usage-extension
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
code --install-extension copilot-usage-dashboard-*.vsix
```

Open: **Command Palette** > `Copilot Usage: Open Dashboard`

## Data Sources

1. **chatSessions JSONL** at `%APPDATA%/Code/User/workspaceStorage/{hash}/chatSessions/*.jsonl`
2. **Transcripts** at `%APPDATA%/Code/User/workspaceStorage/{hash}/GitHub.copilot-chat/transcripts/`
3. **Live OTel** (optional) -- built-in OTLP HTTP receiver on port 14318

The scanner handles both legacy (`kind=1`) and current (`kind=0`) JSONL formats.

## Configuration

The extension auto-configures OTel settings on first activation:

| Setting | Value |
|---------|-------|
| `github.copilot.chat.otel.enabled` | `true` |
| `github.copilot.chat.otel.exporterType` | `otlp-http` |
| `github.copilot.chat.otel.otlpEndpoint` | `http://127.0.0.1:14318` |

A VS Code reload is needed after first install for Copilot to start exporting telemetry.

## Commands

| Command | Description |
|---------|-------------|
| `Copilot Usage: Open Dashboard` | Open or focus the dashboard |
| `Copilot Usage: Refresh Stats` | Rescan chatSession files and refresh |

## Requirements

- VS Code 1.85+
- GitHub Copilot Chat extension

## Privacy

All data stays local. The extension reads from your VS Code `workspaceStorage` directory and listens on `127.0.0.1` only.

## License

[MIT](LICENSE)



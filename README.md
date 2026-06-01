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
  <img src="https://img.shields.io/badge/Version-1.3.0-purple" alt="Version">
</p>

---

## Features

- **AI Credits (AIC) tracking** — per-model credit costs with configurable rates (June 2025 billing model)
- **Budget monitoring** — monthly budget progress bar, projected usage, overage cost estimates
- Token counts (prompt, output, cached) per session, model, project, and day
- Session browser with title, preview, duration, tools, and subagent usage
- Clickable links to session log and transcript JSONL files
- Model breakdown across Claude, GPT, Gemini families with per-model credit costs
- Daily usage trends (stacked bar chart) + daily credits chart
- Tool and subagent call tracking
- Live OpenTelemetry receiver (OTLP HTTP on port 14318)
- Auto-refresh (30s / 1m / 2m / 5m / Off) and manual refresh
- Status bar with session count and token totals
- Multi-root workspace support

## Install

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

### AI Credits (AIC) Configuration

Since June 1, 2025, GitHub Copilot uses [usage-based billing with AI Credits](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises).

Configure your plan in **Settings** → search `copilotUsage.aic`:

| Setting | Default | Description |
|---------|---------|-------------|
| `copilotUsage.aic.plan` | `business` | Your Copilot plan |
| `copilotUsage.aic.billingCycleStartDay` | `1` | Day of month billing cycle starts |
| `copilotUsage.aic.monthlyCreditsIncluded` | `1900` | Monthly included credits per user (override plan default) |
| `copilotUsage.aic.overageCostPerCredit` | `0.01` | 1 AI credit = $0.01 USD |
| `copilotUsage.aic.customModelCosts` | `[]` | Custom per-model credit rates |

#### Plan Defaults (per user/month, pooled at billing entity)

| Plan | Credits/Month | Overage | Notes |
|------|--------------|---------|-------|
| Free | 250 | N/A (blocked) | |
| Pro | 1,000 | $0.01/credit | |
| Pro+ | 7,500 | $0.01/credit | |
| **Business** | **1,900** | $0.01/credit | Pooled across org |
| Business (promo) | 3,000 | $0.01/credit | June–Sept 2026 |
| Enterprise | 3,900 | $0.01/credit | Pooled across enterprise |
| Enterprise (promo) | 7,000 | $0.01/credit | June–Sept 2026 |

> **1 AI credit = $0.01 USD.** Credits are pooled — an org with 10 Business users gets 19,000 credits shared.

#### Custom Model Costs

Override or add model pricing via `copilotUsage.aic.customModelCosts`:

```json
"copilotUsage.aic.customModelCosts": [
  {
    "model": "claude-opus-4.6",
    "inputCreditsPerMillion": 500,
    "outputCreditsPerMillion": 2500,
    "cachedInputCreditsPerMillion": 50,
    "cacheWriteCreditsPerMillion": 625,
    "tier": "premium"
  }
]
```

Credits are calculated as: `(net_input_tokens / 1M) × inputRate + (output_tokens / 1M) × outputRate + (cached_read_tokens / 1M) × cachedRate`

Anthropic models also incur cache write costs: `(cache_write_tokens / 1M) × cacheWriteRate`

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



# Copilot Usage Dashboard

<p align="center">
  <img src="images/icon.png" width="128" height="128" alt="Copilot Usage Dashboard Logo">
</p>

<p align="center">
  <strong>A self-contained VS Code extension that gives you full visibility into your GitHub Copilot token usage.</strong>
</p>

<p align="center">
  <img src="images/Dashboard_With_AIC.png" alt="Copilot Usage Dashboard">
</p>

---

## Features

- **Daily AI Credit Limit Guard (v1.9.x)** — set a hard daily spend in **credits or dollars**; status-bar countdown turns amber → orange → red as you approach; animated mascot shield webview when limit is hit; three enforcement modes (`soft` / `pause` / `strict`); snooze / resume / end-override controls with day rollover
- **GitHub Copilot Agent Hooks (v1.9.0+)** — installs `PreToolUse` + `UserPromptSubmit` lifecycle hooks at `~/.copilot/hooks/` that **deny tool calls** in Copilot CLI, local custom agents (`.agents/*.md`), and the Copilot cloud agent when the daily limit is hit. Fail-OPEN by design.
- **Unified usage across 3 sources** — VS Code Copilot Chat, [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP) agent sessions, and [Pi](https://github.com/earendil-works/pi) coding-agent sessions, all rolled into a single AIC budget view
- **AI Credits (AIC) tracking** — per-model credit costs with configurable rates (June 2026 billing model)
- **Budget monitoring** — uncapped percentage (shows true overage e.g. `494%`), "days of runway at current pace" indicator, projected end-of-cycle usage, overage cost estimates
- **Redesigned dashboard (v1.7.6)** — hero KPI cards, tabbed Breakdown (Model / Project / Tool / Subagent), collapsible expanders, side-by-side Trend charts with auto-generated insight captions
- Token counts (prompt, output, cached) per session, model, project, and day
- Per-source breakdown table: Sessions, Turns/LLM Calls, Tokens, and AIC Credits split across VS Code, OMP, and Pi
- Session browser with title, preview, duration, tools, and subagent usage
- Clickable links to session log and transcript JSONL files
- Model breakdown across Claude, GPT, Gemini families with per-model credit costs
- Daily usage trends (stacked bar chart) + monthly credits calendar heatmap
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

The scanner auto-detects the VS Code `workspaceStorage` root across platforms (override with `copilotUsage.workspaceStoragePath`):

| Platform                         | Path                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| Windows                          | `%APPDATA%/Code/User/workspaceStorage`                     |
| macOS                            | `~/Library/Application Support/Code/User/workspaceStorage` |
| Linux                            | `~/.config/Code/User/workspaceStorage`                     |
| Dev container / Remote-SSH / WSL | `~/.vscode-server/data/User/workspaceStorage`              |
| VS Code Insiders                 | `Code - Insiders` / `.vscode-server-insiders` equivalents  |
| Portable                         | `$VSCODE_PORTABLE/user-data/User/workspaceStorage`         |

Inside that root the extension reads:

1. **chatSessions JSONL** at `{root}/{hash}/chatSessions/*.jsonl`
   - Parsed by [src/scanner.ts](src/scanner.ts) `parseSessionContent`. Handles `kind=0` (current — session metadata + embedded `v.requests[]`), `kind=1` (legacy — `[customTitle]` / `[requests, N, result]`), and `kind=2` (latest prompt snapshot). All three must keep working.
   - Tokens here are snapshots only — authoritative per-call data comes from debug-logs.
2. **debug-logs** at `{root}/{hash}/GitHub.copilot-chat/debug-logs/{session}/`
   - `main.jsonl` — per-event stream (`session_start`, `turn_start`, `llm_request`, `child_session_ref`). Each `llm_request` carries `attrs.model`, `attrs.inputTokens`, `attrs.outputTokens`, `attrs.cachedTokens`, and `attrs.copilotUsageNanoAiu` (exact API billing × 1e9). **Per-event model attribution is required** so auxiliary calls (e.g. `gpt-4o-mini` for title generation, `claude-haiku-4.5` for subagents) appear in per-model rows instead of being collapsed into the parent turn's model.
   - `runSubagent-*.jsonl` — subagent rounds. Credits are merged into the parent turn that spawned them (via `child_session_ref`).
   - `title-*.jsonl` — title generation. Fires **before any `turn_start`**, so the parser attributes it to turn 0 to avoid losing its small-model credits.
3. **transcripts** at `{root}/{hash}/GitHub.copilot-chat/transcripts/`
4. **[Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP) agent sessions** at `~/.omp/agent/sessions/**/*.jsonl` — scanned concurrently with mtime caching; contributes LLM calls, tokens, and AIC credits to the shared budget
5. **[Pi](https://github.com/earendil-works/pi) coding-agent sessions** at `~/.pi/agent/sessions/**/*.jsonl` — same scanning model as OMP
6. **Live OTel** (optional) — built-in VSCode OTLP HTTP receiver on port 14318

The scanner handles both legacy (`kind=1`) and current (`kind=0`) JSONL formats.
All file I/O is fully async with concurrent reads (16-worker pool) and mtime caching.
OMP/Pi token counts are reported as **all-time** historical; AIC credits for those sources are scoped to the current billing cycle (Jun 1+).

> **Contributors:** [.agents/agents.md](.agents/agents.md) documents the JSONL parsing contract and invariants that must not regress. [tests/scan-june-workspace.ts](tests/scan-june-workspace.ts) is an independent audit script that re-implements `llm_request` parsing and must continue to print `Extension credit display matches API ground truth` (0.0% drift) after any parser change.

## Configuration

The extension auto-configures OTel settings on first activation:

| Setting                                 | Value                    |
| --------------------------------------- | ------------------------ |
| `github.copilot.chat.otel.enabled`      | `true`                   |
| `github.copilot.chat.otel.exporterType` | `otlp-http`              |
| `github.copilot.chat.otel.otlpEndpoint` | `http://127.0.0.1:14318` |

A VS Code reload is needed after first install for Copilot to start exporting telemetry.

### AI Credits (AIC) Configuration

Since June 1, 2026, GitHub Copilot uses [usage-based billing with AI Credits](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises).

Configure your plan in **Settings** → search `copilotUsage.aic`:

| Setting                                   | Default    | Description                                               |
| ----------------------------------------- | ---------- | --------------------------------------------------------- |
| `copilotUsage.aic.plan`                   | `business` | Your Copilot plan                                         |
| `copilotUsage.aic.billingCycleStartDay`   | `1`        | Day of month billing cycle starts                         |
| `copilotUsage.aic.monthlyCreditsIncluded` | `1900`     | Monthly included credits per user (override plan default) |
| `copilotUsage.aic.overageCostPerCredit`   | `0.01`     | 1 AI credit = $0.01 USD                                   |
| `copilotUsage.aic.customModelCosts`       | `[]`       | Custom per-model credit rates                             |

#### Plan Defaults (per user/month, pooled at billing entity)

| Plan               | Credits/Month | Overage       | Notes                    |
| ------------------ | ------------- | ------------- | ------------------------ |
| Free               | 250           | N/A (blocked) |                          |
| Pro                | 1,000         | $0.01/credit  |                          |
| Pro+               | 7,500         | $0.01/credit  |                          |
| **Business**       | **1,900**     | $0.01/credit  | Pooled across org        |
| Business (promo)   | 3,000         | $0.01/credit  | June–Sept 2026           |
| Enterprise         | 3,900         | $0.01/credit  | Pooled across enterprise |
| Enterprise (promo) | 7,000         | $0.01/credit  | June–Sept 2026           |

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

### Daily AI Credit Limit Guard

Cap your **daily** spend independently of the monthly AIC budget. Configure in **Settings** → search `copilotUsage.dailyLimit` (lives in its own settings group: **Copilot Usage — Daily Limit Guard**):

| Setting                                     | Default | Description                                                                                                                  |
| ------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `copilotUsage.dailyLimit.enabled`           | `true`  | Master switch. When off, agents are unblocked instantly.                                                                     |
| `copilotUsage.dailyLimit.credits`           | `100`   | Daily limit in **AI credits** (1 credit = $0.01).                                                                            |
| `copilotUsage.dailyLimit.dollars`           | `0`     | Daily limit in **USD**. When > 0, overrides `credits`. Easier to reason about.                                               |
| `copilotUsage.dailyLimit.warnPct`           | `75`    | Show amber warning at this % of the limit.                                                                                   |
| `copilotUsage.dailyLimit.bracePct`          | `90`    | Show orange brace overlay at this % (mascot starts panicking).                                                               |
| `copilotUsage.dailyLimit.mode`              | `pause` | Enforcement: `soft` (overlay only) / `pause` (kills inline completions) / `strict` (disables Copilot + Chat — needs reload). |
| `copilotUsage.dailyLimit.snoozeMinutes`     | `15`    | How long the **Snooze** button postpones enforcement.                                                                        |
| `copilotUsage.dailyLimit.resetHour`         | `0`     | Hour of local day when the counter rolls over (0–23).                                                                        |
| `copilotUsage.dailyLimit.installAgentHooks` | `true`  | Install Copilot lifecycle hooks at `~/.copilot/hooks/` so CLI / agents stop too.                                             |
| `copilotUsage.dailyLimit.includeOmpPi`      | `true`  | Count OMP + Pi agent credits toward the daily total.                                                                         |

#### How the agent hook works

When `installAgentHooks: true`, the extension writes:

- `~/.copilot/hooks/copilot-usage-limit.json` — registers `PreToolUse` (decision = deny) + `UserPromptSubmit` (notification) hooks
- `~/.copilot-usage/check-limit.{ps1,sh}` — reads live state, emits `{"permissionDecision":"deny","permissionDecisionReason":"..."}` when the daily limit is hit
- `~/.copilot-usage/limit-state.json` — rewritten on every snapshot with `{ blocked, percent, dollarsSpent, dollarsLimit, resetIn }`

Coverage:

| Surface                    | Blocked? | How                                       |
| -------------------------- | -------- | ----------------------------------------- |
| Copilot CLI (`gh copilot`) | ✅       | PreToolUse hook                           |
| Local custom agents        | ✅       | PreToolUse hook                           |
| Copilot cloud agent        | ✅       | PreToolUse hook (commit `.github/hooks/`) |
| VS Code Chat sidebar       | ❌       | No hook surface — use `mode: strict`      |
| VS Code inline completions | ⚠️       | Use `mode: pause` or `strict`             |

The check script is **fail-OPEN** — if it errors, Copilot continues working. Only a successful `blocked == true` read produces a deny.

You can install/uninstall hooks manually via Command Palette:

- `Copilot Usage: Install Agent Hooks`
- `Copilot Usage: Uninstall Agent Hooks`

## Commands

| Command                                            | Description                                           |
| -------------------------------------------------- | ----------------------------------------------------- |
| `Copilot Usage: Open Dashboard`                    | Open or focus the dashboard                           |
| `Copilot Usage: Refresh Stats`                     | Rescan chatSession files and refresh                  |
| `Copilot Usage: Show Daily Limit Shield`           | Open the shield webview with mascot + inline controls |
| `Copilot Usage: Snooze Daily Limit`                | Postpone enforcement by `snoozeMinutes`               |
| `Copilot Usage: Resume Today (override limit)`     | Override the limit for the rest of the local day      |
| `Copilot Usage: Reset Today's Daily-Limit Counter` | Zero today's spend counter                            |
| `Copilot Usage: Install Agent Hooks`               | Write Copilot lifecycle hooks to `~/.copilot/hooks/`  |
| `Copilot Usage: Uninstall Agent Hooks`             | Remove the Copilot lifecycle hooks                    |

## Requirements

- VS Code 1.85+
- GitHub Copilot Chat extension

## Privacy

All data stays local. The extension reads from your VS Code `workspaceStorage` directory and listens on `127.0.0.1` only.

## License

[MIT](LICENSE)

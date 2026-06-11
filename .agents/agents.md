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

## JSONL Parsing Contract (do not break)

Three input sources feed the AIC dashboard. Any change to the parser must keep these invariants -- they are the reason credit totals match the API to 0.0% drift.

### 1. `chatSessions/*.jsonl` -> [src/scanner.ts](src/scanner.ts) `parseSessionContent`

- Entry shapes: `kind=0` (session metadata + embedded `v.requests[]`), `kind=1` (`[customTitle]` / `[requests, N, result]`), `kind=2` (latest prompt snapshot). All three must keep being parsed -- older sessions still use kind=1.
- Tokens here are **snapshot** counts (`promptTokens` / `outputTokens`). They are the fallback only; authoritative tokens come from debug-logs.
- `modelFamily` on this entry is the **session-level** selected model -- never use it for per-`llm_request` attribution.

### 2. `debug-logs/{session}/main.jsonl` -> [src/scanner.ts](src/scanner.ts) `parseDebugLogLines`

- Per-event `type` switch handles `session_start` / `turn_start` / `llm_request` / `child_session_ref`. Do not collapse these branches.
- Every `llm_request` carries its own `attrs.model` -- **capture it per-event** into both the per-turn and per-session `byModel` maps. Auxiliary calls (title `gpt-4o-mini`, subagent `claude-haiku-4.5`, etc.) live or die by this.
- `attrs.copilotUsageNanoAiu` is the exact API-billed credit value times 1e9. Always prefer it over rate-based calculations when present (`hasActualAic` path).
- `attrs.cachedTokens` is cache-read tokens (optional, mainly Anthropic traces). Don't conflate with `cacheWrite`.
- Per-event `entry.ts` drives `debugLastRequestTs` / `debugLastRequestAic` for the `AIC (last req)` widget -- it must be the single most-recent `llm_request`, never a turn sum.

### 3. Child logs: `title-*.jsonl` and `runSubagent-*.jsonl` -> [src/scanner.ts](src/scanner.ts) `parseDebugLogDir`

- Discovered via `child_session_ref` entries in `main.jsonl`, paired with the parent's `currentTurn` index at the time the ref was emitted.
- **Disk fallback**: older Copilot versions (and a few session boundary conditions) leave child files on disk without ever emitting a `child_session_ref` in `main.jsonl`. After parsing `main.jsonl`, `parseDebugLogDir` enumerates `title-*.jsonl` / `runSubagent-*.jsonl` in the session dir and attaches any unreferenced ones as orphans (parentTurn = -1 → turn 0). Audit on the dev machine surfaced 16 such orphans across 295 sessions, containing 137 dropped llm_requests. Do NOT remove this fallback — there is no other signal that those files exist.
- **`title-*.jsonl` fires BEFORE any `turn_start`** -> its `parentTurn === -1`. It MUST be attributed to turn 0 (synthesize an empty turn if missing), otherwise the title call's `gpt-4o-mini` credits silently vanish from per-model rows.
- Merge child credits into the parent turn via `mergeByModel` using the child's **session-level** `byModel` (covers pre-turn events that have no per-turn bucket).

### Dashboard consumption ([src/dashboardData.ts](src/dashboardData.ts))

- Three consumers must stay in sync: `computeDaily`, the debug-log fallback inside `liveOtel`, and the AIC `creditEntries` builder. All three branch on `t.debugByModel` first, then fall back to `t.modelFamily`.
- Live OTel `byModel` and scanner `byModel` are **deduplicated by lowercased model name for today only** -- adding both unconditionally would double-count.
- `activationTime` scopes session-level AIC to the current VS Code window -- never widen this back to calendar-day-only (that bug was fixed in 1.9.16).

### Status bar consumption ([src/extension.ts](src/extension.ts) `updateStatusBar`)

- `currentSessionAIC` and `lastRequestAIC` are **independent reimplementations** of the same logic in `dashboardData.ts` `liveOtel`. They must stay in lock-step -- a divergence here is what produced the v1.9.17 regression where the status bar read `AIC(sess):8025.8` while the dashboard read `AIC (sess) 111.2`.
- Both debug-log overlays MUST filter on `t.timestamp >= activationTime` (and `>= AIC_START`). Calendar-day-only is a bug -- debug logs live in shared `workspaceStorage`, so any prior window's turns from today will leak in otherwise.
- `lastRequestAIC` must use per-event `debugLastRequestTs` / `debugLastRequestAic`, never `t.timestamp` / `t.debugAicCredits` (the latter is the whole turn's sum, not the last single `llm_request`).

### Validation

- [tests/scan-june-workspace.ts](tests/scan-june-workspace.ts) is an **independent re-implementation** of `llm_request` parsing used as ground truth. Do NOT make it import from `scanner.ts` -- that would defeat the audit. Its local `pickNum` helper exists specifically to break the structural duplicate match without coupling the audit to the thing it audits.
- After any change to `scanner.ts` or `dashboardData.ts`, the audit must still print `Extension credit display matches API ground truth` (0.0% drift across all sessions).


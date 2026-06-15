# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.10.10] - 2026-06-15

### Fixed

- **Sidebar AIC dollars now match the dashboard under active PROMO budgets.** The sidebar breakdown now displays cycle overage dollars from the shared dashboard AIC summary instead of converting all consumed credits at face value.
- **Sidebar pace now uses projected cycle credits.** The pace badge, over-budget state, and projected overage amount now follow the same projected-budget logic as the full dashboard.

## [1.10.9] - 2026-06-15

### Fixed

- **`liveOtel.sessionAIC` can no longer exceed `aicSummary.totalCredits`.** The v1.10.7 combination of `Math.max(otelEstimate, debugTruth)` and `_sessionAICRatchet` (monotonic high-water mark) caused `sessionAIC` to permanently lock in over-estimated values, violating the invariant that session credits ≤ cycle credits (visible as `AIC (sess) 12.96 > AI Credits Spent 11.9`).
  - Removed `applySessionAICRatchet` and the `_sessionAICRatchet` map entirely.
  - Removed `Math.max(sessionAIC, debugSessionAIC)` — session AIC is now computed additively from authoritative sources only.
  - `sessionAIC` = Σ flushed debug-log `copilotUsageNanoAiu` + Σ rate-table estimates for unflushed OTel requests only.

- **OTel↔debug-log reconciliation rewritten with count-based per-model-family matching.** The previous per-model overlay (`exactByModelAiu` map summing `nanoAiu` per model key) was replaced with request-level deduplication via `unflushedOtelRequests()`:
  - Groups both OTel and debug-log requests by model family (via `modelFamily()` which strips version suffixes like `.6`/`.7` and date suffixes like `-2024.07.18`).
  - For each family: if debug log has N requests and OTel has M, the newest (M − N) OTel requests are "pending" — all others are considered already flushed.
  - Handles model version aliasing (OTel reports request model `claude-opus-4.6`, debug-log records response model `claude-opus-4.7`) without false double-counting.

- **Per-model `byModel` array in `liveOtel` now merges all three sources** (live OTel aggregates, exact debug-log per-request data, pending OTel estimates) instead of only iterating `liveStats.byModel.values()`. Models that appear only in debug logs or only in pending OTel now surface correctly.

- **`lastRequestAIC` uses individual request nanoAiu** instead of turn-total `debugAicCredits`. A 15-tool-call turn no longer shows the sum of all 15 API calls as "last request" — it shows the single most recent `llm_request`.

- **Child-log merging now accumulates `cachedTotal`** into the parent turn (was previously omitted, causing cache token under-count for subagent/title child logs).

- **Child-log requests update parent turn timestamps** (`lastRequestTs`, `lastRequestNanoAiu`, `timestamp`) so the parent turn correctly reflects the most recent API call across all child logs.

- **Credit entries iterate individual `debugRequests`** when available, attributing each `llm_request` to its own timestamp/date. Fixes UTC day-boundary drift where a multi-request turn spanning midnight would attribute all credits to the turn's latest timestamp.

- **OTel→credit-entry deduplication uses `unflushedOtelRequests()`** instead of the old model-set exclusion (`scanModelsToday`), preventing double-counting when the same model appears in both debug logs and live OTel.

- **`verify-dashboard-vs-api.js` assertions account for rate-table fallback turns** (turns with chatSession token counts but no debug-log `nanoAiu`). Previously these caused false assertion failures; now tracked separately as `fallbackCredits` and included in truth totals.

### Added

- **`DebugRequest` interface** (`src/scanner.ts`) — captures individual `llm_request` fields: `timestamp`, `model`, `prompt`, `output`, `cached`, `nanoAiu`.
- **`Turn.debugRequests?: DebugRequest[]`** — per-turn array of individual API calls, populated from debug-log parsing and child-log merging.
- **`LiveStats.requestLog: readonly OTelRequest[]`** (`src/otelReceiver.ts`) — full retained OTel request array exposed for request-level reconciliation.
- **`unflushedOtelRequests()`** — count-based per-model-family reconciliation function.
- **`modelFamily()`** — normalizes model names for fuzzy matching (strips versions/dates).
- **`debugRequestsFromTurns()` / `debugRequestsInWindow()` / `latestDebugRequest()`** — helper functions for extracting and filtering debug requests across turns.
- **`tests/verify-live-aic-reconciliation.js`** — unit test covering: basic debug+pending reconciliation, count-based matching with 2 flushed + 1 pending, and model version aliasing (4.6 vs 4.7).

## [1.10.7] - 2026-06-14

### Fixed

- **Scanner now has ZERO drift against raw debug-log `.jsonl` files.** New cross-validator [tests/verify-no-drift.js](tests/verify-no-drift.js) independently parses every `main.jsonl` / `title-*.jsonl` / `runSubagent-*.jsonl` under `workspaceStorage` and asserts that the scanner's per-turn aggregates (`debugLlmCalls`, `debugPromptTokens`, `debugOutputTokens`, `debugCachedTokens`, `debugAicCredits`) match the raw `llm_request` events exactly. Initial runs caught two real silent-corruption bugs in [src/scanner.ts](src/scanner.ts):
  - **Duplicate `(sessionId, turnIndex)` rows in chat-session files were double-counting in every downstream consumer.** Chat-session files routinely contain multiple `Turn` rows for the same `turnIndex` — an empty initial row at turn-start plus the fully-populated row when the turn settles. The per-`(sid, turnIndex)` debug-log enrichment loop attached the same `debugAicCredits` / `debugLlmCalls` payload to every duplicate row, so any consumer that summed `scan.turns[*].debugAicCredits` (dashboard `aicSummary.totalCredits`, `liveOtel.sessionAIC`, sidebar breakdown, status-bar dollars) silently double-counted. In the user's workspace this was **114 duplicate keys → +704 phantom `llm_calls` / +1,869 phantom credits**. **Fix:** dedupe `canonical.turns` by `(sessionId, turnIndex)` before the enrichment loop, keeping the row with the highest filled-in token count (then latest timestamp as tiebreaker).
  - **Errored `llm_request` events past the chat-session's last turn were silently dropped.** An `llm_request` with `status:"error"` (timeout, abort, server-side failure) has NO `inputTokens` / `outputTokens` / `copilotUsageNanoAiu` fields. The scanner still counted it in `dt.llmCalls`, but the synthetic-turn-creation branch only fired when prompt or output was non-zero, so an errored call in a turn the chat-session hadn't flushed yet vanished from the request count. **Fix:** broaden the predicate to `dt.promptTotal > 0 || dt.outputTotal > 0 || dt.llmCalls > 0`.

- **Status bar / sidebar / dashboard AIC now match by construction.** The status bar was reading from its own independent reimplementation of session/last-request AIC in [src/extension.ts](src/extension.ts) `updateStatusBar()`, which had drifted from `dashboardData.liveOtel` repeatedly (v1.9.17: bar 8025.8 vs dashboard 111.2; v1.10.2: sidebar 214.1 vs dashboard 129.3; before the fix today: bar `$1.53` / 153.3 AIC vs dashboard 90.3 AIC). Root cause: the status-bar path summed per-model rate-table estimates only and never applied the per-model `copilotUsageNanoAiu` overlay that the dashboard uses for API-exact billing.
  - **Fix:** `updateStatusBar()` now sources `currentSessionAIC` and `lastRequestAIC` directly from `buildData().liveOtel.sessionAIC` / `.lastRequestAIC` — the same producer the dashboard and sidebar consume. Deletes ~80 lines of duplicate AIC math; the local block now only builds metadata (model name, turn count, prompt/output token sums, duration).
  - **Perf:** `pushSidebarSnapshot()` accepts an optional precomputed `DashboardData` so the status-update tick builds dashboard data exactly once (was twice).

- **`liveOtel.sessionAIC` no longer ticks DOWN between requests.** Once the live-tick path was wired in, a long-standing flicker became visible: when a request finished, the rate-table estimate landed first (e.g. `147` for an Opus 4.7 turn — over-counts because OTel traces are missing cache attributes for Anthropic models), then ~2s later the debounced scan read `copilotUsageNanoAiu` from the debug log and the per-model overlay in [src/dashboardData.ts](src/dashboardData.ts) **replaced** the estimate with the exact API-billed value (e.g. `138`), so `sessionAIC` visibly dropped 147 → 138.
  - **Fix:** added a per-activation high-water ratchet `_sessionAICRatchet` in [src/dashboardData.ts](src/dashboardData.ts). Once `liveOtel.sessionAIC` reports a value for a given `activationTime`, subsequent ticks can only equal or exceed it — never decrease. Applied to both the OTel branch and the debug-log-only fallback branch. Keyed by `activationTime` so a VS Code window reload resets the ratchet automatically. Per-model breakdown table still shows the API-exact corrected values — the ratchet only locks the rolled-up `sessionAIC` number.

- **Drift validator no longer cries wolf during active Copilot use.** [tests/verify-no-drift.js](tests/verify-no-drift.js) used to read raw `.jsonl` files first (~4s) then run the scanner (~25s); any `llm_request` that landed during that window appeared in scanner but not raw, producing false-positive `Δ=-1 call` FAILs.
  - **Fix:** flipped read order to scanner-first, raw-second (with a 500ms settle window) so the invariant becomes `scanner ⊆ raw`. Added RACE-vs-DRIFT classification: `truth > scanner` is tagged `RACE` (writes during scan, exits 0 with warning), `scanner > truth` is tagged `DRIFT` (real bug, exits 1). Test now passes 9/9 even while Copilot Chat is actively streaming new requests.

### Changed

- **Reimagined status bar — dollars-first, glanceable, transient feedback.** The status-bar text collapsed from `$(zap) In:256.9K Out:3.9K Cache:191.5K | AIC(sess):59.1 Req:8.4` (~52 chars) down to `$(zap) $0.59` (~10 chars) with a 5-second `+8.4¢` flash badge after each new request. Every datum previously on the bar (In/Out/Cache, model, turns, session id, workspace total, both AIC numbers) is preserved in the tooltip. Idle text is now icon-only `$(dashboard)`. See [src/statusBar.ts](src/statusBar.ts).
  - **Daily-limit visuals integrated into the body, not appended.** Warn/Brace render as `<walker> $0.59 / $5.00`; Limit hit renders as `<stop> $5.00 LIMIT`; snoozed/resumed states drop the `LIMIT` tag. The legacy ` | $used/$limit (pct%)` suffix is gone.
  - **Per-request `+X¢` flash.** A new `fmtDelta()` helper formats the last-request AIC delta as `+<1¢`, `+8.4¢`, or `+$1.20` depending on magnitude. Triggered by a `lastRequestAIC` change between updates and auto-cleared by a one-shot 5-second timer.
  - **Wiring:** [src/extension.ts](src/extension.ts) passes `dollarPerCredit` from `getAICConfig().overageCostPerCredit` into `StatusBarData` so the bar and the dashboard share one conversion rate.

- **Live updates are actually live now — all three surfaces tick within ~ms of a Copilot request finishing.** The OTel handler used to hold every UI update behind `OTEL_DEBOUNCE_MS = 2000ms`. Split into a live path (status bar + dashboard refresh fire immediately on every OTel batch, cheap — in-memory OTel + cached scan) and a debounced path (`runScan()` still coalesces disk re-scans for the `copilotUsageNanoAiu` overlay). End-to-end latency from `notify()` → status-bar repaint dropped from ~2000ms to ~ms.

- **Dashboard Live-OTel AIC tiles now display 2dp instead of 1dp.** The `AIC (sess)`, `AIC (last req)`, and per-model AIC column in [src/dashboardPanel.ts](src/dashboardPanel.ts) used `.toFixed(1)`, which silently hid cents — a `7.22`-credit request rendered as `7.2`. Storage was always exact (`copilotUsageNanoAiu / 1e9` rounded to 2dp); only the display was throwing away precision. Now matches the storage layer.

## [1.10.3] - 2026-06-12

### Changed

- **Sidebar layout polish.** Three small fixes to the "Copilot Usage" Activity Bar sidebar:
  - **`THIS WEEK` KPI no longer overflows the card on narrow widths.** `.kpi-grid` now uses `minmax(0, 1fr) minmax(0, 1fr)` instead of `1fr 1fr` so grid tracks can shrink below their intrinsic content width. `.kpi`, `.kpi .value`, and `.kpi .sub` got `min-width: 0` + `overflow-wrap: anywhere` so long numbers wrap instead of clipping. Below 220px the two KPIs stack vertically. See [src/sidebarView.ts](src/sidebarView.ts).
  - **Removed the SESSIONS section from the sidebar.** The full dashboard already lists top sessions; mirroring the table in the sidebar was duplicate surface area. Sidebar is now a 2-section accordion (USAGE & PACE + BREAKDOWN). Dropped the `#sec-sessions` panel, the `renderSessions()` webview function, the `openSession` message handler, and the `.sess-head` / `.sess-row` CSS block (~38 lines).
  - **BREAKDOWN · BY MODEL now lists all models, not just the top 5.** Removed the `.slice(0, 5)` in [src/sidebarSnapshot.ts](src/sidebarSnapshot.ts) so every billable model appears in the sidebar bars. The "+N more in dashboard ⤢" overflow footer disappears naturally (`modelsMore` is always `0`).

## [1.10.2] - 2026-06-12

### Added

- **New "Copilot Usage" Activity Bar sidebar.** A persistent webview view (`copilotUsage.panel`) lives in its own Activity Bar container alongside the full dashboard. Three-section accordion: **USAGE & PACE** (Last Request + Session (this window) side-by-side, Today/Week KPIs, projected-overage Pace card with traffic-light progress bar), **BREAKDOWN** (cycle total, 14-day daily sparkline with peak highlight, top-5 By Model bars with tier chips, By Day of Week bars, Tokens in/out/cache), **SESSIONS** (top 30 by credits with click-through to the full dashboard, active-window glyph). Sections have brighter outer borders so each reads as a distinct card against the side bar background.
  - New files: [src/sidebarView.ts](src/sidebarView.ts) (`WebviewViewProvider` with strict CSP + per-render nonce, expanded-state persistence via `vscode.setState`), [src/sidebarSnapshot.ts](src/sidebarSnapshot.ts) (pure projection of existing `DashboardData` + scanner turns + live OTel into a slim DTO — zero new computation, all numbers come from the existing pipeline).
  - Snapshot pushes happen on every status-bar tick, on `webviewView.onDidChangeVisibility`, and on a `ready` ping from the webview script — eliminates the post-before-listener race and avoids stale "Waiting…" placeholders when re-opening the sidebar.
  - All scanner-driven values respect `activationTime` scoping (same contract as v1.9.16/17), so the sparkline, "Session (this window)", and active-session glyph never leak prior windows' turns.
  - New commands: `copilotUsage.sidebar.refresh` (toolbar `$(refresh)`) and `copilotUsage.sidebar.openDashboard` (toolbar `$(link-external)`).

### Fixed

- **`Session (this window)` no longer permanently reads `0 min`.** Both branches of `updateStatusBar()` in [src/extension.ts](src/extension.ts) that build `CurrentSessionInfo` were hard-coding `durationMin: 0`, so the sidebar's session card always showed `… · N turns · 0 min`. Added `computeWindowDurationMin()` (minutes since `activationTime`) and wired both branches to it. Status-bar consumers were unaffected — they never read the field.

### Changed

- **`AIC_EFFECTIVE_DATE = "2026-06-01"` is now exported from [src/dashboardData.ts](src/dashboardData.ts).** Was duplicated as three separate string literals (`dashboardData.ts`, `extension.ts`, the new `sidebarSnapshot.ts`); `aicCredits.ts` keeps its `PROMO_START` since that's a semantically different date. Per the `.agents/agents.md` "three consumers must stay in sync" contract, consolidating to a single import removes one drift surface.

## [1.9.21] - 2026-06-11

### Fixed

- **"Usage by Model" AI Credits column now joins on `modelFamily`, not display-label normalization.** The v1.9.19 fix tried to normalize `s.modelName` (display label, e.g. `"Claude Opus 4.6"`) into the API family form (`"claude-opus-4.6"`) by collapsing whitespace to hyphens. Confirmed in the wild that this still didn't connect for real Anthropic rows in some sessions — the display label coming from VS Code's `metadata.name` is not always a clean `<vendor> <product> <version>` triple, and even small punctuation differences broke the lookup. `SessionView` in [src/dashboardData.ts](src/dashboardData.ts) already carries **both** `modelName` (display) and `model` (= `modelFamily` from `metadata.family`, which is **literally the same string** `aicSummary.byModel` uses), so `renderModelTable()` in [src/dashboardPanel.ts](src/dashboardPanel.ts) now joins on family directly. The aggregator preserves both fields per row (`{model: displayLabel, family: modelFamily}`); the AIC lookup tries family first, falls back to the label-normalization path only when family is empty (very old sessions where `metadata.family` was absent). No more guessing.

## [1.9.20] - 2026-06-11

### Fixed

- **"AI Credits by Model" `Output` and `Cached` columns no longer report 0 for every post-June-1 model.** `AICCalculator.computeSummary()` in [src/aicCredits.ts](src/aicCredits.ts) had a long-standing shortcut: whenever a credit entry carried `actualCredits` (the API-reported `copilotUsageNanoAiu` overlaid by [src/dashboardData.ts](src/dashboardData.ts) since v1.9.17), it stuffed the **entire** authoritative value into `inputCredits` and zeroed `outputCredits` / `cachedCredits` — the comment even acknowledged it (`// attribute all to "input" for simplicity`). That was harmless when only the `Total` column existed, but the per-model table now shows all four buckets, so every Anthropic/GPT row read `Input ≈ Total`, `Output = 0`, `Cached = 0`. Now: when `actualCredits` is available, the calculator computes the rate-based input/output/cached breakdown from the entry's tokens, then **scales each component proportionally** so the three sum to the exact API-billed `actualCredits`. The displayed total stays API-authoritative (no drift vs the budget bar / `byDay` calendar) and the breakdown is finally meaningful. Edge cases: entries with no matching rate, or zero token counts (e.g. OMP/Pi agent entries that don't carry per-bucket tokens), still fall back to all-input — unchanged behaviour for those.

## [1.9.19] - 2026-06-11

### Fixed

- **"Usage by Model" table now shows AI Credits for every post-June-1 model, not just `GPT-5.4`.** `renderModelTable()` in [src/dashboardPanel.ts](src/dashboardPanel.ts) joined session rows against `DATA.aicSummary.byModel` using a plain `.toLowerCase()` key, but the two sides use different naming conventions: the session aggregator keys on `s.modelName` — the **display label** from VS Code's `selectedModel.metadata.name` (e.g. `"Claude Opus 4.6"`, spaces preserved) — while `aicSummary.byModel[].model` keys on the **API family** emitted by the debug-log / OTel pipeline (e.g. `"claude-opus-4.6"`, hyphens; sometimes `"claude-opus-4-6"` from OTel attributes where dots were stripped). The two never matched, so every Anthropic row, `GPT-5.5`, `Auto`, etc. rendered `—` in the AI Credits column. `GPT-5.4` coincidentally worked because its display string equals its API family string. Added a small `normModelKey()` helper applied to both sides of the join: lowercase → collapse whitespace/underscores to `-` → restore version dots (`\d-\d` → `\d.\d`). After normalization `"Claude Opus 4.6"` / `"claude-opus-4-6"` / `"claude-opus-4.6"` all map to the same key. Models with usage only **before** `AIC_EFFECTIVE_DATE = 2026-06-01` (filtered out of `aicSummary.byModel` by design in [src/dashboardData.ts](src/dashboardData.ts)) and the `Auto` router (never appears in AIC byModel) still correctly show `—`.

### Changed

- **Filter bar redesigned: Models / Range / Refresh are now compact dropdowns instead of inline button rows.** `buildFilterBar()` in [src/dashboardPanel.ts](src/dashboardPanel.ts) was rewritten to render three grouped controls with `UPPERCASE` micro-labels:
  - **Models** — a custom button (`.model-dd-btn`) that opens a checkbox panel (`.model-dd-panel`) on click. The button label summarises selection state (`All Models (N)` / `K of N selected` / `No models`). Includes `All` / `None` quick actions inside the panel. A document-level click handler closes the panel on outside-click and `event.stopPropagation()` keeps clicks inside the panel from closing it.
  - **Range** — a native `<select class="filter-select">` populated from the existing `RANGE_LABELS` map, so option text reads `"Last 7 Days"` / `"This Week"` etc. instead of the old `7d` / `tw` button chips. `setRangeDD()` preserves the existing auto-refresh-on-range-change behaviour (turn refresh off for historical ranges, restore 2 m default when returning to today).
  - **Refresh** — a native `<select>` with `Off` / `Every 30s` / `Every 1m` / `Every 2m` / `Every 5m`. The manual refresh `↻` button is restyled (slightly larger, rounded, green-on-hover border).
  - New helpers `updateModelDDLabel()` / `syncRefreshSelect()` keep the dropdown labels in sync after programmatic state changes (e.g. range-change auto-toggling refresh). Old per-button active-class fiddling (`updateRefreshButtons`, `setRange(btn, r)`, `setRefresh(btn, secs)`) is gone — `<select>` elements handle their own selection state.
  - CSS adds `.filter-group` / `.filter-label` / `.filter-select` / `.model-dd*` rules; obsolete `.range-btns` / `.range-btn` / `.refresh-btns` / `.refresh-label` rules removed.

## [1.9.18] - 2026-06-11

### Added

- **New `AIC` column in the "Live OTel by Model" table.** Each model row now shows its API-billed credits alongside Requests / Prompt / Output / Cache, so it's immediately obvious which model is driving spend in the current session without cross-referencing the AIC section below.
  - **OTel branch** ([src/dashboardData.ts](src/dashboardData.ts) `buildDashboardData()`): a rate-table estimate is computed per row, then **overlaid with the exact per-llm_request `copilotUsageNanoAiu`** from today's debug-log per-model breakdown (`turn.debugByModel[*].nanoAiu`) when available. Overlay is scoped to today + `activationTime` — same scope `sessionAIC` uses since v1.9.16 — so prior VS Code windows' debug-log turns can't leak in. Model names are matched case-insensitively.
  - **Debug-log fallback branch**: per-row credits are summed directly from `mt.nanoAiu / 1e9`; legacy turns without per-model AIU fall back to `calculator.calculateCredits()`. Rounding to 2 decimals happens only at finalize, so intermediate sums keep precision.
  - **`sessionAIC` is now derived from the same per-row credits the user sees in the table**, instead of an independent rate-table sum — the displayed grand total always matches the column.
  - **Renderer** ([src/dashboardPanel.ts](src/dashboardPanel.ts) `renderOtel()`): adds an `AIC` `<th>` and renders `m.aicCredits.toFixed(1)` in the existing `.orange` style, matching the other AIC columns in the dashboard.

## [1.9.17] - 2026-06-11

### Fixed

- **Picked up orphan `title-*.jsonl` and `runSubagent-*.jsonl` debug logs that were missing a `child_session_ref` in `main.jsonl`.** The scanner only opened child files that `main.jsonl` explicitly referenced. An audit across 295 real workspaceStorage sessions found 16 child files on disk with no matching ref (3 `title-*.jsonl`, 13 `runSubagent-*.jsonl`) containing 137 unaccounted `llm_request` events — mostly subagent `claude-haiku-4.5` rounds plus a handful of `gpt-4o-mini` title calls and `claude-opus-4.6` requests from older Copilot versions (`copilotVersion` 0.47.x). `parseDebugLogDir` in [src/scanner.ts](src/scanner.ts) now enumerates `title-*.jsonl` / `runSubagent-*.jsonl` siblings of `main.jsonl` after parsing and attaches any unreferenced ones as orphans (`parentTurn = -1` → attributed to turn 0, the same fallback path used for pre-turn title entries). [tests/audit-orphan-children.ts](tests/audit-orphan-children.ts) is a new audit/regression-guard script that quantifies how many orphan child files would be dropped if this fallback regressed.
- **Restored per-model AIC attribution for auxiliary calls (title generation, subagent rounds) in the debug-log path.** Until v1.9.6 the dashboard's per-model breakdown was driven primarily by the OTel receiver, which exports each `llm_request` span with its own `gen_ai.request.model`. When v1.9.12 made the debug-log path equally authoritative for windows that don't hold OTLP port 14318, those small-model calls effectively disappeared from the per-model rows: the scanner read `title-*.jsonl` (gpt-4o-mini) and `runSubagent-*.jsonl` (claude-haiku-4.5) for the session total, but every `llm_request` was stamped with the **parent turn's** `modelFamily` (e.g. `claude-opus-4.7`), collapsing all child credits into one row.
  - `parseDebugLogLines` in [src/scanner.ts](src/scanner.ts) now captures `attrs.model` on every `llm_request` and accumulates per-model totals at both the per-turn and per-session level.
  - `parseDebugLogDir` merges each child session's per-model totals into the parent turn that spawned it. `title-*.jsonl` fires before any `turn_start` (parent turn index = -1) — those credits are now attached to turn 0 instead of being silently dropped from per-model views.
  - New `debugByModel?: Record<string, DebugModelTotals>` on `Turn` exposes the per-model breakdown to consumers.
  - `dashboardData.ts` uses `t.debugByModel` (when present) in three places: the AIC `creditEntries` builder, `computeDaily` (daily-by-model view), and the debug-log fallback's `byModel` rows. All three previously grouped only by `turn.modelFamily`.
- Verified on a real workspace session where the cost was actually billed across 3 distinct models (`gpt-5.4` ×23, `claude-haiku-4.5` ×38, `gpt-4o-mini-2024-07-18` ×1): per-model AIC now sums to the API's exact total to 6 decimal places (was off by the orphaned title's AIC before this fix). Existing `tests/scan-june-workspace.ts` cross-validation still shows 0.0% drift across all sessions.
- **Status bar `AIC(sess)` no longer inherits prior VS Code windows' totals.** The v1.9.16 fix scoped the dashboard's `AIC (sess)` to `activationTime`, but the equivalent overlay inside [src/extension.ts](src/extension.ts) `updateStatusBar()` was missed — the status bar's `AIC(sess):...` value was still summing every today turn from shared `workspaceStorage` debug-logs, so opening a new window mid-day showed (for example) `AIC(sess):8025.8` next to a dashboard reading `AIC (sess) 111.2`. Same root cause as v1.9.16, same fix: the OTel-branch overlay now filters on `t.timestamp >= activationTime` (and `>= AIC_START`).
- **Status bar `Req:` now uses per-request timestamp + value, matching the dashboard.** The debug-log overlay for `lastRequestAIC` in `updateStatusBar()` was keyed on `t.timestamp` (turn-start time) and `t.debugAicCredits` (whole-turn total). A long turn with 15 tool-call `llm_request` entries would therefore show `Req:` = the entire turn's AIC, and any prior-window turn whose start time was newer than this window's last OTel request could leak in. Now uses `debugLastRequestTs` / `debugLastRequestAic` with the same `activationTime` filter as the session value, matching `dashboardData.ts` `liveOtel.lastRequestAIC` exactly.

## [1.9.16] - 2026-06-10

### Fixed

- **`AIC (sess)` no longer inherits prior sessions' totals on a fresh VS Code window.** The debug-log overlay that backstops the OTel `sessionAIC` was filtering by calendar day only — so opening a brand-new VS Code window mid-day picked up every turn from every prior reload/session in `main.jsonl` and `Math.max`'d that into `AIC (sess)`. The dashboard would then show e.g. `AIC (LAST REQ) 7.2` (correct — just this session's one request) next to `AIC (SESS) 6174.5` (wrong — all of today's prior sessions). `buildDashboardData` now takes `activationTime` and the debug-log overlay scopes turns to `t.timestamp >= activationTime` on both the OTel-present and OTel-absent paths. Same activation-scoping the status-bar `AIC(cur)` has used since v1.8.x.

## [1.9.15] - 2026-06-10

### Fixed

- **Reverted the v1.9.14 fire-and-forget initial scan.** With the initial scan running in the background, opening the dashboard on cold start showed all zeros (`0.0 AIC / 0 sessions / 0 turns`) until the scan finished — sometimes seconds later, sometimes never if the watcher fired first and overwrote a partial cache. Activation now awaits the first scan again so the dashboard, status bar, and any subsequent commands always see populated data on cold start. The watcher + 30 s safety-net handle every update after that.

### Kept from v1.9.14

- `deactivate()` cleanup of the v1.9.13 cooldown timer and the recursive `fs.watch` handle — this part was a real fix and stays.

## [1.9.14] - 2026-06-10

### Fixed

- **Extension activation no longer blocks on the initial scan.** Previously `activate()` did `await runScan()`, which on a large `workspaceStorage` (hundreds of debug-log sessions) could keep VS Code in the "activating" state for several seconds and delay every extension that depends on us. The first scan now runs fire-and-forget; the status bar and dashboard refresh as soon as it completes, and the `fs.watch` + 30 s safety-net timer take over for live updates.
- **`deactivate()` now cleans up the v1.9.13 cooldown timer and the recursive `fs.watch` handle.** Previously these could outlive the extension host on reload and leak a watcher per reload cycle.

## [1.9.13] - 2026-06-10

### Fixed

- **`AIC (last req)` now shows ONE API call's bill, not the entire turn's sum.** A turn that fires many tool-call rounds writes one `llm_request` entry to `main.jsonl` per call (10–20 is common for agent turns). We were summing them and labelling the sum `AIC (last req)` — so a turn that actually billed ~8 AIC per call showed up as `132.0` on the dashboard. The scanner now tracks `lastRequestNanoAiu` and `lastRequestTs` per turn (the single most recent llm_request, not the cumulative total), and the dashboard's `AIC (last req)` widget uses those.
- **Pure event-driven live updates — dashboard reacts within ~10 ms of a `main.jsonl` write.** Replaced trailing-edge debounce (every event waited 500–2000 ms before scanning) with leading-edge fire + 500 ms cooldown + serialized trailing coalesce. Result: first event fires the scan immediately; bursts during one in-flight request are coalesced into a single trailing scan after the cooldown so the final totals are correct. Scans are also serialized so two watcher events never race two scans.
- **Safety-net periodic timer dropped from 120 s to 30 s.** The watcher is the primary live path; the timer is only a backstop for cases where `fs.watch` misses an event (e.g. network shares).

## [1.9.12] - 2026-06-10

### Added

- **Real-time `main.jsonl` file watcher.** The extension now sets up a recursive `fs.watch` on the workspaceStorage root and triggers a debounced rescan whenever any `<wsRoot>/<wsId>/GitHub.copilot-chat/debug-logs/<sid>/main.jsonl` is written. This makes the dashboard live within ~1–2 seconds of every Copilot request — even in the secondary window that doesn't own OTLP port 14318. Replaces the previous behaviour where this window could be up to 120 seconds behind.

### Changed

- **Rebranded the debug-log path.** When the OTLP receiver port is held by another VS Code window, the Live OpenTelemetry panel previously labeled itself `Local debug-log fallback` with a note implying degraded data. In reality `main.jsonl` carries the API-exact `copilotUsageNanoAiu` — the same value the API bills you for. New label: `Live (debug-log stream • API-exact)` with a note that explains it's authoritative, not a fallback.

## [1.9.11] - 2026-06-10

### Fixed

- **AIC (last req) now reflects the turn with the most recent `llm_request`, not the most recent `turn_start`.** In the debug-log fallback, a long-running turn that fired many `llm_request` calls had an older `turn_start` timestamp than a freshly-started short turn — so the "most recent turn" picker would prefer the wrong one and show a stale AIC value (e.g. the dashboard displayed `8.4` while the actual just-finished request was `9.26`). The scanner now bumps `DebugLogTurnTokens.timestamp` to each `llm_request`'s own `ts` as they arrive, so "most recent" reflects real last activity.
- **Fallback note now explains why OTLP is unavailable.** Previous wording said "OTLP export is unavailable" which sounded like Copilot wasn't exporting at all. The real cause is that only one VS Code window's extension instance can bind port 14318 — others fall back to debug-log parsing. Note now says so.
- **Fallback request-count label renamed to `LLM Requests`.** In fallback mode the receiver isn't running, so labelling the debug-log `llm_request` count as `OTel Requests` was confusing.

### Refactored

- No behavior change. Cross-validation (`tests/scan-june-workspace.ts`) still shows 0.0% drift vs API ground truth across all sessions, including the now-correct most-recent-turn pick.

## [1.9.10] - 2026-06-10

### Fixed

- **Debug-log fallback now surfaces cache-read tokens.** When OTLP export is unavailable, the _Live OpenTelemetry_ panel was hard-coding `LIVE CACHED`, `TRACE CACHE`, and `METRIC CACHE` to `0` even though `attrs.cachedTokens` is present on Anthropic Opus/Sonnet `llm_request` entries in `main.jsonl`. The scanner now reads it (`Turn.debugCachedTokens`), the fallback path sums it into `live.cached` / `live.traceCached`, and the per-model breakdown reports it under _Trace Cache_. Subtitle updated.
- **AIC (last req) no longer appears frozen on refresh in the debug-log fallback.** It was previously set to whichever turn happened to be iterated last — `scan.turns` is append-order (across sessions and synthetic debug-log turns), not timestamp-sorted, so the value was order-dependent and could stay the same across refreshes even as new requests came in. It now picks the turn with the most recent timestamp.
- **AIC computation in the debug-log fallback now passes cache-read tokens to the calculator.** Previously cached tokens were passed as `0`, which silently overestimated AIC for any turn that lacked an exact `copilotUsageNanoAiu` value (cache reads were billed at the full input rate instead of the discounted cache-read rate).

## [1.9.9] - 2026-06-10

### Fixed

- **Calendar heatmap month header now matches the user's local calendar** ([#2](https://github.com/pvjagtap/github-copilot-usage-dashboard/issues/2)). For users in timezones east of UTC (e.g. IST / UTC+05:30), the "Daily Credits" calendar could render the previous month — e.g. `May 2026` on June 10 local — even with `billingCycleStartDay = 1`. Root cause: `_getBillingCycle()` in `aicCredits.ts` built `cycleStart` / `cycleEnd` in local time but serialized them with `toISOString().slice(0, 10)` (UTC), shifting June 1 00:00 IST back to `2026-05-31`. The webview then derived the calendar header from that shifted string.
  - Added local-date helpers (`formatLocalYMD` / `parseLocalYMD`) in `aicCredits.ts`; `_getBillingCycle` and `_getDaysElapsed` now serialize / parse in the user's local calendar.
  - The today-marker in `buildCreditCalendar` (`dashboardPanel.ts`) now also uses local `YYYY-MM-DD` so day comparisons stay consistent with the cycle dates.
  - New regression test `tests/issue-2-calendar-tz.ts` pins `TZ=Asia/Kolkata`, freezes `Date.now()` to 2026-06-10 IST, drives the real `AICCalculator`, and asserts the cycle start is `2026-06-01` and the calendar header is `June 2026`.

## [1.9.8] - 2026-06-10

### Changed

- **Internal refactor only — no behavior change.** Eliminated 9 code-duplication clusters flagged by the Fallow static analyzer across `scanner.ts`, `agentScanner.ts`, `otelReceiver.ts`, `extension.ts` and `planDetector.ts`.
  - New `src/util.ts` module exports `isObj`, `isArr`, `utcNow`, and `mapConcurrent`. Local copies in three files now import from it.
  - `scanner.ts` gained four private helpers: `normalizeFileUri` (collapses two file:// URI decoders), `extractSubagentArgs` (collapses two runSubagent argument parsers), `emitTurnAndToolCalls` (collapses the 25-line turn + tool-call emission block used by both the `kind=0 v.requests[]` and `kind=1 ...result` parse paths), and `listWorkspaceDirsSorted` (collapses the 8-line workspaceStorage subdirectory listing used by `discoverSessionFiles`, `discoverTranscriptFiles`, and `discoverDebugLogsCached`).
  - `extension.ts` gained `summarizeSnapshot` (collapses two identical `DailyLimitSnapshot` projection objects).
  - `planDetector.ts` gained `persistDetectedPlan` and `runQuickPickAndPersist` (collapse the persist + manual-picker blocks shared by the silent and consent detection paths).
- Verified by `tsc` (clean), `eslint src` (only pre-existing warnings), and the existing `tests/scan-june-workspace.ts` cross-validation script.

## [1.9.7] - 2026-06-10

### Fixed

- **Scanner no longer silently returns zero sessions on Linux, macOS, dev containers, WSL, or Remote-SSH.** `getWorkspaceStoragePath` was Windows-only — it joined `process.env.APPDATA ?? ~/AppData/Roaming` with `Code/User/workspaceStorage`, producing a path that does not exist on any non-Windows platform. The dashboard would render but show nothing. Resolver now probes a platform-aware candidate list and picks the first one that exists.

### Added

- **Cross-platform workspaceStorage resolution** — auto-detects across Windows (`%APPDATA%/Code`), macOS (`~/Library/Application Support/Code`), Linux (`~/.config/Code`), VS Code Insiders variants of each, dev container / Remote-SSH / WSL (`~/.vscode-server[-insiders]/data/User/workspaceStorage`), and Portable installs (`$VSCODE_PORTABLE/user-data/User/workspaceStorage`). Builds on community PR [#1](https://github.com/pvjagtap/github-copilot-usage-dashboard/pull/1) by @josteinaj.
- New setting **`copilotUsage.workspaceStoragePath`** — optional absolute path to point the scanner at a specific install. Useful for forks, portable installs, or running multiple parallel VS Code installations.
- Env override **`COPILOT_USAGE_WORKSPACE_STORAGE`** — same purpose for tests, CI, and non-VS Code execution.
- Exported `getWorkspaceStorageCandidates(override?)` from `scanner.ts` so the cross-validation test (`tests/scan-june-workspace.ts`) consumes the same resolver as the runtime.

### Changed

- `getWorkspaceStoragePath` is now `async` and uses `fsp.stat` instead of `fs.existsSync`/`fs.statSync`, matching the "fully async with concurrent file I/O" contract stated in the scanner's file header.
- When no candidate exists yet, the fallback is platform-appropriate (Windows → `%APPDATA%/Code/...`, macOS → `~/Library/...`, otherwise → `~/.config/Code/...`) instead of unconditionally returning a Linux path.
- README "Data Sources" section rewritten as a cross-platform table covering all supported layouts plus the new override setting.

## [1.9.6] - 2026-06-07

### Fixed

- **Picker now always offers the one-click "Detect via GitHub" button.** v1.9.5 hid the button behind a `getAccounts('github')` check — but VS Code's auth API is scoped per extension, so `getAccounts` returns `[]` until our extension has been granted access at least once. Net effect: the button was effectively never shown on first run. The button is now unconditional; clicking it triggers VS Code's standard "Allow Copilot Usage Dashboard to use GitHub?" consent dialog, then queries the SKU and writes the plan automatically.

## [1.9.5] - 2026-06-07

### Fixed

- **Silent plan detection now actually succeeds for most users.** v1.9.4 only asked VS Code for a GitHub session scoped to `['read:user']` — VS Code caches one session per unique scope tuple, so Copilot's existing session (typically `['repo','workflow','read:user']`) didn't match and detection silently fell through to the picker. The detector now tries multiple known scope variants in order and uses whichever one returns a cached session, with zero prompts.
- When no silent session matches but a GitHub account exists, the picker fallback now offers a **"Detect via GitHub"** button that triggers VS Code's one-click consent dialog ("Allow Copilot Usage Dashboard to use GitHub?") — a single click instead of a manual plan pick.

## [1.9.4] - 2026-06-07

### Fixed

- **Plan no longer hard-defaults to Business.** Pro / Pro+ / Free / Enterprise users were silently shown the Business budget (1,900 credits) because `copilotUsage.aic.plan` shipped a `business` default and was never auto-detected. The dashboard now reads the user's actual SKU via their existing VS Code GitHub session — no extra sign-in — by calling GitHub's `/copilot_internal/v2/token` (the same call the official Copilot extension makes) and maps the returned SKU to the correct plan key. If detection fails or returns an unknown SKU, a one-time picker is shown so the user can choose explicitly. A plan the user has set manually is never overwritten.

### Added

- New setting `copilotUsage.aic.autoDetectPlan` (default `true`) — set to `false` to disable silent detection and rely on the manual `copilotUsage.aic.plan` value only.
- New command **Copilot Usage: Detect My Copilot Plan** — re-runs detection on demand (useful after upgrading from Pro to Pro+ or moving to a Business seat).

## [1.9.0] - 2026-06-03

### Added

- **GitHub Copilot agent hooks integration** — the daily limit now denies tool calls in Copilot CLI, local custom agents, and the cloud agent (when opted in). On activation, the extension installs a `PreToolUse` hook at `~/.copilot/hooks/copilot-usage-limit.json` plus PowerShell/bash scripts at `~/.copilot-usage/`. A live state file is rewritten on every snapshot so snooze/resume/end-override take effect on the very next tool call.
- New setting `copilotUsage.dailyLimit.installAgentHooks` (default `true`) — flip off to remove hooks immediately.
- New commands `Copilot Usage: Install Agent Hooks` and `Copilot Usage: Uninstall Agent Hooks`.

### Notes

- Plain Copilot Chat (Ask mode) in the sidebar is **not** covered by hooks — no hook surface exists for it. Use `strict` enforcement (extension disable + reload) if you need to lock it down too.
- Hooks are fail-OPEN by design: a broken script will never block Copilot. Only a successful read of the state file with `blocked == true` produces a deny.

## [1.7.7] - 2026-06-02

### Documentation

- README now links to the upstream agent projects: [Oh My Pi](https://github.com/can1357/oh-my-pi) and [Pi](https://github.com/earendil-works/pi), making the source attribution explicit in both the Features bullet and the Data Sources section.

## [1.7.6] - 2026-06-02

### Changed

- **Dashboard UI redesign — better hierarchy & scannability**:
  - Replaced 9-card KPI strip with **4 hero cards** featuring colored accent stripes, large headline values, and contextual delta badges (runway days, turns/session, tokens/turn).
  - Secondary KPIs (Prompt, Output, Tool Calls, Subagents, Mirrors, Transcripts) moved into a collapsible **"More details"** expander.
  - **Breakdown section is now tabbed** (By Model · By Project · By Tool · By Subagent) — reclaims ~60% vertical space and gives each chart full width.
  - **Trends section** places Daily Token Usage and Average Hourly Distribution side-by-side on wide screens.
  - **Auto-generated insight captions** under each trend chart (peak day, % of period, peak hour with timezone, ±3h concentration).
  - **All Sessions** and **Live OpenTelemetry** sections now collapsible expanders with count badges; OTel moved above AIC for quicker diagnostic visibility.
- **AIC budget panel** softened — calmer color thresholds (blue → green → amber → red, only red when actually past budget) and a new "~N days runway at current pace" indicator.
- **Budget percentage now uncapped** — previously the % was capped at 100%, hiding the true severity of overage. Now displays the actual ratio (e.g. `494% (+394% over)`) in red with a tooltip showing the overage in credits.

### Added

- New CSS components: `.hero-card`, `.tabs`/`.tab-panel`, `.expander` (native `<details>`), `.insight` caption box, `.budget-bar`.

## [1.7.3] - 2026-06-02

### Fixed

- **Calendar heatmap colors inverted** — green shades now indicate higher usage, red indicates lower usage. Legend updated to match.

## [1.7.2] - 2026-06-02

### Fixed

- **Model multiplier accuracy**: `scanner.ts` now defaults missing `multiplierNumeric` metadata to `0` instead of `1`, allowing `KNOWN_MULT` fallbacks to apply correctly (e.g. Claude Opus → 3x). The model table now tracks the max multiplier seen across all sessions per model rather than locking in the first session's value. Added explicit `gpt-5.5: 7.5` and `gpt-5.4: 1` entries to `KNOWN_MULT` so GPT-5.5 is no longer under-counted by the generic `gpt-5: 1` fallback.

## [1.7.1] - 2026-06-03

### Fixed

- **Agent scan failure no longer stales workspace scan**: `scanAgentSessions()` is now isolated inside its own `.catch()` before `Promise.all` resolves. Previously, if the agent scan threw, the destructuring assignment never executed and `lastScan` retained its previous stale value even though `scanWorkspaceStorage()` had succeeded.
- **`fileCache` eviction on every scan**: After each scan, entries for files no longer present on disk are removed from the module-level `fileCache` Map. Previously, deleted session files accumulated as stale entries for the extension process lifetime.
- **Empty-string phantom key in `modelBreakdown`**: When the very first assistant message in a session lacks a `model` field, the fallback is now `"unknown"` instead of `""` (empty string), preventing a spurious `""` key from appearing in the per-model breakdown.
- **Duplicate `new Date()` in billing-start computation**: `billingStart` now binds `new Date()` once and reuses it for both `.getUTCFullYear()` and `.getUTCMonth()` calls.
- **Token row time-window ambiguity**: The "Tokens — prompt + output" row in the Usage by Source table now labels its scope as "VS Code: workspace storage · OMP/Pi: all time". Each cell carries a `title` tooltip and the Total cell notes that it sums across differing retention windows.

## [1.7.0] - 2026-06-02

### Added

- **Per-source AIC breakdown (VS Code · OMP · Pi)**: New "Usage by Source" table in the dashboard shows Sessions, Turns/LLM Calls, Tokens, and AIC Credits split across VS Code Copilot Chat, Oh My Pi agent sessions (`~/.omp/agent/sessions`), and Pi coding-agent sessions (`~/.pi/agent/sessions`). All three sources feed into the shared AIC billing total above the table.
- **All-time token counts for OMP and Pi**: The Tokens row uses historical all-time token totals for agent sources (not filtered to the current billing period), clearly labelled to distinguish from the billing-period AIC Credits row.
- **AIC Credits scoped to Jun 1+**: The AIC Credits row is labelled "(Jun 1+ only)" to reflect that usage-based billing began June 1, 2026.
- **`agentScanner.ts`**: New module that scans OMP and Pi JSONL session files concurrently with mtime caching. Exposes `scanAgentSessions()` returning `AgentScanResult` with per-source session counts, token breakdowns by model, billing-period totals, and all-time totals.
- **`AgentUsageSummary` in `dashboardData.ts`**: Extended with full per-source fields (`vscodeSessions/Turns/TotalTokens/AicCredits`, `ompSessions/LlmCalls/TotalTokens/TotalCredits/AllTimeLlmCalls/AllTimeTokens`, `piSessions/LlmCalls/TotalTokens/TotalCredits/AllTimeLlmCalls/AllTimeTokens`, `totalSessions/totalCredits/scanMs`).

## [1.6.0] - 2026-06-02

### Fixed

- **Cache write credits now included in OTel AIC calculation**: The credit formula was missing `cache_creation_input_tokens × cacheWriteCreditsPerMillion` (625/1M for Anthropic models). This caused the live OTel credit display to under-report by the cache-write component, explaining the gap between VS Code's native credit display and our extension's AIC numbers.
- **OTel now captures `cache_creation_input_tokens`**: Added extraction of `gen_ai.usage.cache_creation.input_tokens` from OTel trace spans, threaded through to `calculateCredits()` at all call sites.

## [1.5.9] - 2026-06-02

### Fixed

- **OTel model name matching**: `findModelRate()` now normalizes version-number hyphens to dots before lookup. OTel reports models as `claude-opus-4-6` (hyphens) while the rate table uses `claude-opus-4.6` (dots) — previously caused fallback to wrong rates and ~47% drift in live OTel credit display.

## [1.5.8] - 2026-06-02

### Fixed

- **Child credits now in turn-level data**: subagent/child LLM credits are merged into the parent turn that spawned them (via `child_session_ref` turn context). Previously, child credits were only reflected in session-level totals but missing from per-turn AIC calculations, daily analytics, and current-session debug-log fallback.
- **OTel totals remain cumulative**: added separate cumulative counters (`cumulativeRequests`, `cumulativePrompt`, `cumulativeCompletion`, `cumulativeCached`) that are never affected by the 10K retention pruning. `getStats()` now reports true session-lifetime totals. The request array is still pruned for deduplication detail, but reported totals are accurate regardless of session length.

## [1.5.7] - 2026-06-02

### Fixed

- **Subagent credits now included**: debug-log parser follows `child_session_ref` entries and aggregates LLM usage from `runSubagent-*.jsonl` and `title-*.jsonl` child logs. Previously only `main.jsonl` was read, missing up to 46% of session credits when subagents (Explore, Plan, etc.) were used.
- **OTel memory bounded**: added 10,000-request retention cap to prevent unbounded memory growth in long-running VS Code sessions.
- **NaN guard in debug-log parser**: `parseInt(turnId)` result is now validated with `Number.isNaN()`; token fields use strict `typeof === "number"` checks instead of `Number()` coercion.
- **Estimation note corrected**: fallback credit estimate note now accurately states "~5-10% undercount for Anthropic models" instead of the incorrect "upper-bound estimate".
- **README date typo**: fixed "June 2025" → "June 2026" to match actual AIC billing launch date.

### Changed

- **Fully async scanner**: all synchronous `fs.*Sync` calls replaced with `fs/promises` async I/O. File discovery and parsing run with 16-worker concurrent pools. Extension host thread is never blocked.
- **Zero `any` types**: entire codebase (`scanner.ts`, `otelReceiver.ts`, `extension.ts`) rewritten with `unknown` and proper type narrowing. No implicit or explicit `any` remains.
- **`Promise.withResolvers`**: replaced `new Promise((resolve, reject) => ...)` pattern with modern `Promise.withResolvers()` API.
- **ESLint async rules**: added `no-floating-promises`, `no-misused-promises`, `require-await` to prevent async regressions.
- **README updated**: Data Sources section now documents debug-logs directory structure including subagent files.

## [1.5.5] - 2026-06-01

### Changed

- Added `.history/` and `copilot_all_tools.jsonl` to `.gitignore`

## [1.5.4] - 2026-06-01

### Added

- **Per-request AIC display**: status bar now shows `AIC(sess):X Req:Y` — session total and last request credits side by side
- **Live OTel AIC cards**: dashboard Live OTel section shows "AIC (sess)" and "AIC (last req)" stat cards
- `sessionAIC` and `lastRequestAIC` fields added to `LiveOtelData` for both OTel and debug-log fallback paths
- `lastRequest` exposed on `LiveStats` from the OTel receiver for per-request credit calculation

### Fixed

- **Performance regression — mtime-based file cache**: scanner now skips re-parsing unchanged session and debug-log files (mtime check). First scan is full-cost; subsequent scans near-instant for unchanged files
- **Performance — dashboard data caching**: `buildData()` returns cached result if neither scan nor OTel request count changed
- **Performance — OTel debounce (2s)**: rapid-fire span arrivals no longer trigger per-span full rebuilds; updates batched into 2-second throttled cycles
- **Performance — turnsAll capped at 500**: webview payload reduced from 8000+ turn rows to 500 most recent — faster initial HTML render and `postMessage` transfers
- **Missing model rate for gpt-4o-mini**: added explicit `gpt-4o-mini` (15/60/7.5 per M) and `gpt-4o` (250/1000/125 per M) rate entries so OTel-only fallback uses correct cheap rates instead of expensive GPT-4.1 default

### Changed

- Removed "Output Credits", "Cache Savings", and "Remaining" cards from AIC section (always showed 0 without per-request cache data from API)
- Status bar tooltip labels clarified: "AI Credits (session total)" and "AI Credits (last request)"
- Scan logging now includes elapsed time in ms for profiling

## [1.5.3] - 2026-06-01

### Fixed

- **`AIC(cur)` now scoped to the active VS Code instance only**: previously showed the most-recent session from all workspaces (shared storage scan). Now records `activationTime` on extension start and counts only turns/credits that arrived after that point — so opening a different repo in a new window shows its own independent `AIC(cur)`.
- **Live OTel takes priority for `AIC(cur)`**: when the OTLP receiver has data it is used directly (already instance-scoped, in-memory). Debug-log fallback uses the `activationTime` filter.

## [1.5.2] - 2026-06-01

### Fixed

- **Credits by Model missing OTel-only models**: when the scanner had any turns for today, all live OTel data was silently skipped even for models the scanner never saw. Now only models already in today's scanner data are excluded (to prevent double-counting); OTel models not present in scanner data are always included.

## [1.5.1] - 2026-06-01

### Added

- OTel receiver startup self-test: after binding, GETs `/healthz` and logs reachability result to the "Copilot Usage" output channel
- Diagnostic config summary logged on activation: `enabled`, `exporterType`, `otlpEndpoint`, `captureContent`, `dbSpanExporter` state with actionable tips
- Dropped-span diagnostics: traces filtered out due to missing token data now log their `gen_ai.operation.name` and full attribute key list for format debugging

### Fixed

- Widened child-span token search: previously only `panel/*` child spans were checked for `promptTokens`/`completionTokens`; now all child spans are searched — handles cases where Copilot places token data on a non-root span
- `promptTokens` and `completionTokens` changed from `const` to `let` to allow child-span enrichment

## [1.5.0] - 2026-06-01

### Added

- Parse `copilotUsageNanoAiu` from debug-log `llm_request` entries — the exact billing amount GitHub's API reports per call
- `debugAicCredits` per turn and `debugTotalAicCredits` per session populated from actual API data
- Dashboard badge: green "✓ Actual billing data" when using API values, yellow "⚠️ Upper-bound estimate" when falling back to computed rates
- `AIC-PROCESSING-PIPELINE.md` explainer documenting the full 6-step credit pipeline

### Changed

- Credit calculation now prioritizes actual API billing data (`nanoAiu / 1e9`) over computed per-model rates
- Computed rates (500/M input) are now fallback-only — used when debug-log data is unavailable
- `computeSummary()` accepts optional `actualCredits` field to bypass rate computation entirely

### Fixed

- **77% over-estimation eliminated**: previous versions treated all input tokens at 500 credits/M, ignoring that ~98% are cache_read tokens billed at 50 credits/M
- Verified result: 3,098 actual credits vs 13,500 previously computed for same session
- AIC under-counting (~30%) when chatSession JSONL hasn't flushed all turn results to disk
- Scanner now creates synthetic turns from debug-log data for unflushed entries

## [1.4.0] - 2026-06-01

### Added

- AI Credits (AIC) calculation engine (`aicCredits.ts`) with all 22 official model rates
- Auto-detect promotional period (June 1 – September 1, 2026) with dual overage display
- Per-session AI Credits column in sessions table
- Calendar heatmap for daily credit usage in current billing cycle month
- Status bar now shows current active session only (model, tokens, AIC credits)
- Configurable AIC settings: `copilotUsage.aic.plan`, `.billingCycleStartDay`, `.monthlyCreditsIncluded`, `.overageCostPerCredit`, `.customModelCosts`
- Upper-bound estimation warning when cached token data is unavailable
- OTel + scanner double-counting prevention guard

### Changed

- AIC calculations only include data on or after June 1, 2026 (AIC effective date)
- Status bar displays current session details instead of all-session aggregate
- Dashboard Overage section shows both "With Promo" and "Without Promo" costs during promotional window

### Fixed

- Potential double-counting of tokens when both OTel live data and scanner data exist for the same day

## [1.2.0] - 2026-05-25

### Added

- Show all tools and projects instead of limiting to top 10

### Changed

- Charts rendered in scrollable frames to prevent stretching after filter clicks, refreshes, and webview visibility changes
- Build instructions updated in README

### Fixed

- Dashboard charts no longer stretch after filter clicks, refreshes, or status-bar opens (stale canvas dimensions reset)

## [1.1.0] - 2026-05-20

### Added

- Debug-log integration: scanner now parses `debug-logs/main.jsonl` for actual per-API-call token counts
- Sessions enriched with `debugTotalPrompt`, `debugTotalOutput`, `debugLogPath`
- Turns enriched with `debugPromptTokens`, `debugOutputTokens`
- `debugLogSessions` stat added to ScanStats

### Changed

- Dashboard prefers actual debug-log tokens over chatSession snapshot estimates
- Timestamps default to local timezone (hourly chart, generatedAt, lastSeen)

## [1.0.9] - 2026-04-15

### Added

- OTel receiver diagnostic logging via Output channel
- Protobuf content-type detection with graceful fallback
- Automatic `outfile` conflict resolution — removes outfile setting that overrides HTTP export

### Fixed

- OTel settings now correctly detect and clear `outfile` conflicts that prevent live telemetry

## [0.1.7] - 2026-04-10

### Changed

- Repository branding and configuration
- Added `repo.config.json` and `apply-repo-config.js` for repo-independent configuration

## [0.1.6] - 2026-04-10

### Added

- Light theme support with warm beige palette
- Date range filters (Today / 7d / 30d / All)
- Hourly distribution chart
- Dual-axis daily usage chart (tokens + sessions)

### Changed

- In-place data updates via `postMessage` to eliminate refresh flash
- Install docs now point to VS Code Marketplace

### Fixed

- Subagent card size now matches Top Tools chart-card layout
- Removed duplicate `});` in `renderDaily` that broke all chart rendering
- Lint warnings cleaned up

## [0.1.4] - 2026-03-01

### Changed

- Version bump for Marketplace release

## [0.1.3] - 2026-02-15

### Added

- Initial VS Code Marketplace listing
- Extension icon with Copilot goggles and gradient bars

### Fixed

- Persist range/refresh/model selections across dashboard refreshes

### Changed

- README header restored with icon, tagline, and badges

## [0.1.2] - 2026-01-15

### Added

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

[Unreleased]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.10.2...HEAD
[1.10.2]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.9.21...v1.10.2
[1.9.21]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.5.8...v1.9.21
[1.5.8]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.5.7...v1.5.8
[1.5.7]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.5.5...v1.5.7
[1.5.5]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.5.4...v1.5.5
[1.5.4]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.5.3...v1.5.4
[1.5.3]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.5.2...v1.5.3
[1.5.2]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.2.0...v1.4.0
[1.2.0]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.0.9...v1.1.0
[1.0.9]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v0.1.7...v1.0.9
[0.1.7]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v0.1.4...v0.1.6
[0.1.4]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/pvjagtap/github-copilot-usage-dashboard/releases/tag/v0.1.2


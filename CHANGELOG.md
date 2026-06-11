# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/pvjagtap/github-copilot-usage-dashboard/compare/v1.5.8...HEAD
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

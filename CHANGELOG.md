# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

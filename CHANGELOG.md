# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Rebranded repository to MAGNA-OpenSource
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

[Unreleased]: https://github.com/MAGNA-OpenSource/github-copilot-usage-dashboard/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/MAGNA-OpenSource/github-copilot-usage-dashboard/compare/v0.1.4...v0.1.6
[0.1.4]: https://github.com/MAGNA-OpenSource/github-copilot-usage-dashboard/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/MAGNA-OpenSource/github-copilot-usage-dashboard/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/MAGNA-OpenSource/github-copilot-usage-dashboard/releases/tag/v0.1.2

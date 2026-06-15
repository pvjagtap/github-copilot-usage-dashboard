---
applyTo: 'src/sidebar*.ts,src/extension.ts,package.json,images/sidebar-icon.svg'
---

# Sidebar v4 — Implementation Spec

Final iteration of the Activity Bar sidebar plan, derived from three reference
sweeps:

1. v1 — pure invention from our existing dashboard
2. v2 — reimagined after seeing our own full dashboard screenshots
3. v3 — adopted Tokenyst's collapsible accordion + big-number hierarchy
4. **v4 (this doc)** — dropped Daily Limit (status bar already owns it),
   adopted Tokenyst's full sortable Sessions table

## Goal

Activity Bar icon → 1 view container → 1 WebviewView with **3 collapsible
sections**. Pure read-only insight. No mutation actions. Daily-limit guard
intentionally stays in the status bar + shield overlay only.

## Surface

```
Activity Bar
└── viewsContainers.activitybar: id="copilotUsage"
    └── views.copilotUsage[0]: id="copilotUsage.panel" (webviewView)
```

- **No separate TreeView.** Single webview with `<details><summary>` accordion.
- Activity Bar icon: `images/sidebar-icon.svg` (monochrome, `currentColor`).
- Title bar shows `↻` (refresh) — `⤢` open-dashboard wired via title menu entry.

## Three sections

### 1. USAGE & PACE (default expanded)
- **Last Request** card — model name, AIC, age, in/out/cache, sparkline of last 20 reqs
- **Today / This Week** dual KPI (AIC + USD)
- **Session (this window)** one-liner
- **Pace** bar — projected cycle spend, overage %, promo expiry annotation

### 2. BREAKDOWN (default collapsed)
- Range pill `[Cycle ▾]` → Today / This Week / This Cycle / Last 30 Days
- TOTAL SPENT (AIC + USD)
- DAILY USAGE 14-day inline sparkline with peak annotation
- BY MODEL top 5 horizontal bars + `+N more ⤢` link
- BY DAY OF WEEK 7 horizontal bars
- TOKENS — Input / Output / **Cache** (our differentiator vs. Tokenyst)

### 3. SESSIONS (default collapsed)
- Sort pill: Credits / Date / Tokens / Turns
- Range pill: Today / Week / Cycle / All time
- Columns: DATE | SOURCE badge | TITLE | CREDITS ↓
- Active-window session marked with ◉ glyph
- Top 30 capped + `Show all N in dashboard ⤢` footer link

## Status row (above first section, always visible)

`● Live · Business · Promo                ⚙`

- Dot tri-state: green (OTel firing) / amber (file-watcher only) /
  grey (no data yet)
- Mid-text: plan name + active promo chip (auto-hides after promo end)
- ⚙ opens `copilotUsage.*` settings filter
- **No daily-limit indicator here** — status bar already covers it

## Data layer

New file [src/sidebarSnapshot.ts](../src/sidebarSnapshot.ts) exports:

```ts
buildSidebarSnapshot(
  dashData: DashboardData,        // existing — already computed by buildData()
  lastRequestAIC: number,         // existing — same value status bar uses
  currentSessionAIC: number,      // existing
  liveState: "live" | "scan" | "idle",
  activationTime: string,
): SidebarSnapshot
```

`SidebarSnapshot` is a slim serializable DTO:

```ts
{
  status: { liveState, planName, promoActive, promoEndDate },
  lastRequest: { model, aic, agoMs, prompt, output, cached, sparkline: number[] },
  today:   { aic, usd, requests, topModel },
  thisWeek:{ aic, usd },
  session: { aic, turns, durationMin, model },
  pace:    { projectedUsd, overagePct, cycleEnd, promoEndDate, overBudget },
  breakdown: {
    range, totalAic, totalUsd,
    dailySparkline: number[], peakDay, peakValue,
    byModel: [{model, credits, pct}], modelsMore,
    byDow: [{dow, credits, pct}],
    tokens: { input, output, cached }
  },
  sessions: {
    rows: [{ sessionId, sessionShort, date, source, title, credits, active }],
    total, sort, range
  },
  generatedAt
}
```

`extension.ts` calls `sidebarView.postSnapshot(buildSidebarSnapshot(...))`
wherever it currently calls `statusBar.updateStatus(...)` and
`DashboardPanel.updateIfVisible(...)` — same triggers, no new timers.

## Files to add / modify

| File | Change |
|---|---|
| [package.json](../package.json) | Add `viewsContainers.activitybar` + `views.copilotUsage` |
| [images/sidebar-icon.svg](../images/sidebar-icon.svg) | New — monochrome SVG using `currentColor` |
| [src/sidebarSnapshot.ts](../src/sidebarSnapshot.ts) | New — DTO + pure projection function |
| [src/sidebarView.ts](../src/sidebarView.ts) | New — `WebviewViewProvider` implementation |
| [src/extension.ts](../src/extension.ts) | Register provider + push snapshots from existing hooks |

## What's explicitly NOT in scope

- ❌ Daily-limit indicator / Snooze / Reset / Shield buttons (status bar already handles)
- ❌ Custom date range picker (use 4 preset range pills)
- ❌ Donut charts (don't render well at sidebar width)
- ❌ Native TreeView (single webview keeps it simpler + richer)
- ❌ Auto-reveal on activation (user clicks Activity Bar icon to open)

## Defaults chosen on the 4 open questions

1. Last Request sparkline = **last 20 requests** (sub-minute responsiveness)
2. By Model = **top 5 + "+N more" link** (matches Tokenyst density)
3. Sessions table = **top 30 + "Show all" link** (no virtual scroll)
4. Default expanded = **USAGE & PACE only**, other two collapsed (fastest paint)

## Phasing

| Phase | Outcome |
|---|---|
| P1 | Icon + container + status row + 3 empty accordion headers |
| P2 | USAGE & PACE wired to real data |
| P3 | BREAKDOWN with all bars + sparkline |
| P4 | SESSIONS sortable table + click-through |

**This first VSIX implements P1–P4 in one shot** for end-to-end test.

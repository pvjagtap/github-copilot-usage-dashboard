# Live Telemetry Scoping (HARD REQUIREMENT)

## Per-instance, per-active-chat-session isolation

Each VS Code instance MUST show ONLY its own current active chat session's AIC
data (both `AIC (sess)` and `AIC (last req)`). Multiple VS Code instances may be
running simultaneously in the same or different workspaces — each must trace
ONLY its own active chat session, never accumulate across windows or sessions.

### What "current active chat session" means

- Each chat in Copilot Chat has a unique `sid` (UUID).
- Debug logs live at `debug-logs/{sid}/main.jsonl` — one folder per chat session.
- The "active" session in a VS Code window is the chat the user currently has
  focused. When the user clicks "New Chat", a new `sid` becomes active.
- The previously active session is now stale from this window's perspective and
  MUST NOT contribute to live counters anymore (only to historical/daily views).

### Why `activationTime + today` is NOT sufficient

The current implementation (v1.9.17/18) scopes turns to `t.timestamp >= activationTime`,
which prevents *prior-reload* contamination but does NOT prevent:

1. A long-running window where the user opened a NEW chat — both old and new
   chat turns are after `activationTime`, so both are summed.
2. Two windows sharing workspaceStorage (uncommon but real) — both windows'
   sessions are after each's `activationTime`.

### The fix (v1.9.18)

Filter live OTel + debug-log overlay by the **currently active chat sid** of
this VS Code instance — not by activationTime alone.

- Track the active sid via:
  - `session_start` events from debug logs after `activationTime` belong to THIS
    window's lifetime (other windows write to their own sid subfolders, which
    we can ignore by sid).
  - Most recently active sid = the sid whose newest event timestamp is the
    largest among sids whose `session_start.ts >= activationTime`.
- For Live OTel: do not filter by `sid` until the receiver actually exposes it.
  `OTelRequest` currently carries `requestId`, `traceId`, and `conversationId`;
  any active-chat scoping change must first surface a real chat `sid` or prove a
  reliable mapping from these fields to the debug-log session folder.
- For debug-log overlay: filter `scan.turns` by `t.sessionId === activeSid`
  instead of by date+activationTime.

### Anti-pattern the previous CHANGELOG warned about

The v1.9.18-dev that was reverted picked "most recent sessionId from scan
results" GLOBALLY (across all windows). That flip-flopped because both windows
saw each other's session as "most recent". The correct fix anchors the pick to
THIS window's `activationTime`: a sid whose `session_start` happened in this
window's lifetime is mine; sids whose `session_start` was before my activation
belong to a prior reload or another window.

### Cross-references

- `src/dashboardData.ts` `buildDashboardData` — live OTel + debug overlay.
- `src/extension.ts` `updateStatusBar` — consumes `dashData.liveOtel` for AIC;
  do not reintroduce independent session/last-request credit math.
- `src/scanner.ts` — captures per-`llm_request` timestamp/model/token/AIC rows,
  but not `sid` on `DebugRequest`; an active-chat scoping fix must first
  surface a real sid or prove a reliable request-to-session mapping.

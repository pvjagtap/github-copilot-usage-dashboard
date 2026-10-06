/**
 * ledgerHistory.ts — date the credits GitHub billed that no local log explains.
 *
 * GitHub's `quota_snapshots` reports one cycle total, never a per-day split, so
 * the part of it the local logs cannot account for used to be parked on a single
 * day. The extension polls that figure every few minutes, though, so the moments
 * the ledger rose are known. Comparing each rise with the local activity inside
 * the same window dates the unexplained part: a rise of 2,000 credits across an
 * hour in which the local logs show 100 means roughly 1,900 were billed then.
 *
 * Only the ledger needs remembering — local activity is re-read from the logs on
 * every refresh, so a later scanner fix corrects the attribution retroactively.
 */

/** One distinct ledger value and the span over which it was observed. */
export interface LedgerPoint {
  /** First poll that saw `used`. */
  t: number;
  /** Credits GitHub reported as used. */
  used: number;
  /** Most recent poll that still saw `used`. */
  lastSeen: number;
}

/** A dated slice of spend the local logs recorded. */
export interface LocalEvent {
  t: number;
  credits: number;
}

export interface DatedCredits {
  day: string;
  credits: number;
}

/** globalState key. Not a sync key: a ledger history is meaningful to one machine's polling only. */
export const LEDGER_HISTORY_KEY = "copilotUsage.ledgerHistory.v1";

const MAX_POINTS = 2000;
const MAX_AGE_MS = 40 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
/** Below this a difference is rounding, not spend. */
const EPSILON = 0.005;

/**
 * A day is only marked when this many credits were dated to it. Billing lag
 * leaves the gap a few dozen credits adrift after every burst; striping a whole
 * day for that would present noise as an event.
 */
const MIN_DATED_DAY = 25;

/**
 * Two polls further apart than this (VS Code closed, laptop asleep) cannot say
 * when inside the gap a rise happened, so such a rise stays undated.
 */
export const MAX_DATED_WINDOW_MS = 3 * 3600_000;

/**
 * Fold a fresh ledger reading into the history. A reading lower than the last
 * one means the cycle rolled over (or GitHub corrected itself), so earlier
 * points no longer describe this ledger and the history restarts.
 */
export function recordLedgerPoint(history: readonly LedgerPoint[], used: number, now: number): LedgerPoint[] {
  const kept = history.filter(p => now - p.lastSeen <= MAX_AGE_MS);
  const last = kept[kept.length - 1];
  if (!last || used < last.used) {
    return [{ t: now, used, lastSeen: now }];
  }
  if (used === last.used) {
    return [...kept.slice(0, -1), { ...last, lastSeen: Math.max(last.lastSeen, now) }];
  }
  return [...kept, { t: now, used, lastSeen: now }].slice(-MAX_POINTS);
}

/** Add `credits` to every UTC day in (from, to], in proportion to the time spent in each. */
function spreadAcrossDays(into: Map<string, number>, from: number, to: number, credits: number): void {
  const span = to - from;
  if (span <= 0) {
    const day = new Date(to).toISOString().slice(0, 10);
    into.set(day, (into.get(day) ?? 0) + credits);
    return;
  }
  let cursor = from;
  while (cursor < to) {
    const dayStart = Math.floor(cursor / DAY_MS) * DAY_MS;
    const end = Math.min(to, dayStart + DAY_MS);
    const day = new Date(dayStart).toISOString().slice(0, 10);
    into.set(day, (into.get(day) ?? 0) + (credits * (end - cursor)) / span);
    cursor = end;
  }
}

/**
 * Split `total` — the credits the ledger holds beyond what the local logs
 * account for — across the UTC days in which the ledger demonstrably rose faster
 * than the local logs did.
 *
 * Tracks `gap(t) = ledgerRise(t) − localSpend(t)` since the first reading and
 * dates only each NEW high of that gap. Billing lags the request that caused it
 * by minutes, so the gap dips and recovers around every burst of local activity;
 * counting only new highs means that lag is never mistaken for hidden spend.
 *
 * Whatever this cannot place (rises before the first reading, or inside a
 * polling gap too long to locate them) is simply not returned — the caller keeps
 * it parked, so the dated part never exceeds `total`.
 */
export function dateUnattributed(
  history: readonly LedgerPoint[],
  events: readonly LocalEvent[],
  total: number,
): DatedCredits[] {
  if (history.length < 2 || total <= EPSILON) {
    return [];
  }

  const sorted = events.filter(e => e.credits > 0 && e.t > 0).sort((a, b) => a.t - b.t);
  const prefix: number[] = [];
  let running = 0;
  for (const e of sorted) {
    running += e.credits;
    prefix.push(running);
  }
  const spentBy = (t: number): number => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].t <= t) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo > 0 ? prefix[lo - 1] : 0;
  };

  const base = history[0];
  const baseSpent = spentBy(base.t);
  let highWater = 0;
  let dated = 0;
  const byDay = new Map<string, number>();

  for (let i = 1; i < history.length; i++) {
    const point = history[i];
    const gap = point.used - base.used - (spentBy(point.t) - baseSpent);
    const rise = gap - highWater;
    if (rise <= EPSILON) {
      continue;
    }
    highWater = gap;
    const from = history[i - 1].lastSeen;
    if (point.t - from > MAX_DATED_WINDOW_MS) {
      continue;
    }
    spreadAcrossDays(byDay, from, point.t, rise);
    dated += rise;
  }

  if (dated <= EPSILON) {
    return [];
  }
  const scale = Math.min(1, total / dated);
  return Array.from(byDay.entries())
    .map(([day, credits]) => ({ day, credits: credits * scale }))
    .filter(d => d.credits >= MIN_DATED_DAY)
    .sort((a, b) => a.day.localeCompare(b.day));
}

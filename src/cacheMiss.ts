/**
 * cacheMiss.ts — find requests where the provider's prompt cache missed and the
 * whole context was billed again.
 *
 * Every request in an agent loop re-sends the conversation so far. When the
 * cache is warm, that earlier part is billed as a cheap cache READ; when it has
 * expired (or the prefix changed) the same tokens are billed at the full
 * uncached rate — a 5-10x difference on the part that matters most, the long
 * history. Debug logs record each request's prompt and cache-read tokens, so a
 * miss is visible directly: the prompt barely shrank, yet far less of it was
 * read from cache than the previous request left behind.
 *
 * Pure functions only — no vscode, no file I/O — so the rule is testable.
 */

import type { Turn } from "./scanner";

/** One request in a chain, in the order the provider saw it. */
interface ChainRequest {
  timestamp: number;
  prompt: number;
  cached: number;
}

export interface CacheMissEvent {
  sessionId: string;
  model: string;
  /** Call site (`panel/editAgent`, a subagent, …) — each has its own cache. */
  debugName: string;
  /** Epoch ms of the request that missed. */
  timestamp: number;
  promptTokens: number;
  cachedTokens: number;
  /** Tokens the previous request left in the cache and this one should have read. */
  expectedCachedTokens: number;
  /** Idle time since the previous request in the same chain. */
  gapMs: number;
  /** Configured cache lifetime for this model's provider. */
  ttlMs: number;
  /** True when the idle gap alone explains the miss. */
  ttlExpired: boolean;
  /** Credits billed above what a warm cache would have cost. */
  wastedCredits: number;
}

export interface CacheMissOptions {
  /** Ignore requests whose prompt is below this — a small context is cheap to resend. */
  minPromptTokens: number;
  /** Ignore misses that cost less than this many credits. */
  minWastedCredits: number;
  /** Configured cache lifetime in ms for a model. */
  ttlMsFor: (model: string) => number;
  /** Credits for a request with the given prompt/cached split (output excluded). */
  creditsFor: (model: string, prompt: number, cached: number) => number;
  /** Only report requests at or after this epoch ms (history is not news). */
  since?: number;
}

/**
 * A request is a miss when at most this share of the tokens the previous
 * request left cached were actually read. Healthy agent loops read well over
 * 90% of them; the margin below keeps ordinary partial hits quiet.
 */
export const MISS_SHARE = 0.5;

/** The prompt may shrink a little between requests; a bigger drop is a new context. */
const MIN_CONTEXT_RETAINED = 0.8;

/**
 * Detect cache misses across a scan. Requests are chained per session, model and
 * call site, because each of those keeps its own cache: a subagent or a title
 * call neither reads nor warms the main conversation's prefix.
 *
 * Requests with no credit figure (BYOK wrapper calls, errored requests) and
 * recovered placeholders carry no prompt data and are skipped.
 */
export function detectCacheMisses(turns: ReadonlyArray<Turn>, opts: CacheMissOptions): CacheMissEvent[] {
  const chains = new Map<string, { sessionId: string; model: string; debugName: string; reqs: ChainRequest[] }>();
  for (const turn of turns) {
    for (const req of turn.debugRequests ?? []) {
      if (!(req.nanoAiu > 0) || !(req.prompt > 0)) {
        continue;
      }
      const ts = Date.parse(req.timestamp);
      if (!Number.isFinite(ts)) {
        continue;
      }
      const debugName = req.debugName ?? "";
      const key = `${turn.sessionId}\u0000${req.model}\u0000${debugName}`;
      let chain = chains.get(key);
      if (!chain) {
        chain = { sessionId: turn.sessionId, model: req.model, debugName, reqs: [] };
        chains.set(key, chain);
      }
      chain.reqs.push({ timestamp: ts, prompt: req.prompt, cached: req.cached });
    }
  }

  const events: CacheMissEvent[] = [];
  for (const chain of chains.values()) {
    chain.reqs.sort((a, b) => a.timestamp - b.timestamp);
    const ttlMs = opts.ttlMsFor(chain.model);
    for (let i = 1; i < chain.reqs.length; i++) {
      const prev = chain.reqs[i - 1];
      const cur = chain.reqs[i];
      if (opts.since !== undefined && cur.timestamp < opts.since) {
        continue;
      }
      if (cur.prompt < opts.minPromptTokens || prev.prompt < opts.minPromptTokens) {
        continue;
      }
      if (cur.prompt < prev.prompt * MIN_CONTEXT_RETAINED) {
        continue;
      }
      // What the previous request left behind: the whole prompt it sent is now
      // cacheable, and the new request starts with that same prefix.
      const expected = Math.min(prev.prompt, cur.prompt);
      if (cur.cached >= expected * MISS_SHARE) {
        continue;
      }
      const wasted =
        opts.creditsFor(chain.model, cur.prompt, cur.cached) -
        opts.creditsFor(chain.model, cur.prompt, expected);
      if (wasted < opts.minWastedCredits) {
        continue;
      }
      const gapMs = cur.timestamp - prev.timestamp;
      events.push({
        sessionId: chain.sessionId,
        model: chain.model,
        debugName: chain.debugName,
        timestamp: cur.timestamp,
        promptTokens: cur.prompt,
        cachedTokens: cur.cached,
        expectedCachedTokens: expected,
        gapMs,
        ttlMs,
        ttlExpired: gapMs > ttlMs,
        wastedCredits: wasted,
      });
    }
  }
  return events.sort((a, b) => a.timestamp - b.timestamp);
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

/** One-line explanation of a single miss, for a toast or a log line. */
export function describeCacheMiss(e: CacheMissEvent): string {
  const cause = e.ttlExpired
    ? `idle ${formatDuration(e.gapMs)}, past the ${formatDuration(e.ttlMs)} cache TTL`
    : `only ${formatDuration(e.gapMs)} since the last request, inside the ${formatDuration(e.ttlMs)} TTL — the prompt prefix changed`;
  return (
    `${e.model}: ${formatTokens(e.promptTokens)}-token context re-billed ` +
    `(${formatTokens(e.cachedTokens)} read from cache of ${formatTokens(e.expectedCachedTokens)} expected; ${cause}) — ` +
    `about ${e.wastedCredits.toFixed(1)} credits extra`
  );
}

/** Toast text for a batch of misses seen together. */
export function summarizeCacheMisses(events: ReadonlyArray<CacheMissEvent>): string {
  if (events.length === 1) {
    return `Prompt cache missed — ${describeCacheMiss(events[0])}.`;
  }
  const total = events.reduce((s, e) => s + e.wastedCredits, 0);
  const worst = events.reduce((a, b) => (b.wastedCredits > a.wastedCredits ? b : a));
  return (
    `Prompt cache missed ${events.length} times — about ${total.toFixed(1)} credits extra in total. ` +
    `Largest: ${describeCacheMiss(worst)}.`
  );
}

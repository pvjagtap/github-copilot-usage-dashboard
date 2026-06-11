/**
 * util.ts — Tiny shared helpers used across scanner.ts, agentScanner.ts and otelReceiver.ts.
 *
 * Extracted to eliminate cross-file duplicates flagged by Fallow's code-duplication
 * analyzer. Behavior is identical to the previous in-file copies.
 */

/** Check if unknown value is a non-null, non-array object. */
export function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Check if unknown value is an array. */
export function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** Current UTC time as ISO-8601 string. */
export function utcNow(): string {
  return new Date().toISOString();
}

/**
 * Run async tasks with bounded concurrency, preserving input order.
 * Spawns `min(concurrency, items.length)` worker promises; each pulls the next
 * item from a shared index until the input is exhausted.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

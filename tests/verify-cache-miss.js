/**
 * verify-cache-miss.js — a request that re-bills its whole context must be
 * flagged, and a healthy agent loop must stay silent.
 *
 * Real case that motivated it: a 743K-token Opus context read only 14K tokens
 * from cache after 5m 38s idle (TTL 5m) and cost ~300 credits more than the
 * warm-cache price. Across one machine's October logs: 26 such misses, 3,901
 * credits.
 *
 *   node tests/verify-cache-miss.js
 */

const path = require("path");
const Module = require("module");

const OUT = path.resolve(__dirname, "..", "out");
const stubPath = path.join(__dirname, "_vscode-stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (q, p, ...a) { return q === "vscode" ? stubPath : origResolve.call(this, q, p, ...a); };

const { detectCacheMisses, describeCacheMiss, summarizeCacheMisses } = require(path.join(OUT, "cacheMiss.js"));
const { createCalculatorFromConfig, DEFAULT_AIC_CONFIG } = require(path.join(OUT, "aicCredits.js"));

let failures = 0;
function assert(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);
const creditsFor = (m, p, c) => calc.calculateCredits(m, p, 0, c).totalCredits;
const TTL = 5 * 60_000;
const base = {
  minPromptTokens: 20_000, minWastedCredits: 1, ttlMsFor: () => TTL, creditsFor,
};

const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);
const SEC = 1000;
function req(secOffset, prompt, cached, extra = {}) {
  return { timestamp: new Date(T0 + secOffset * SEC).toISOString(), model: "claude-opus-5", prompt, output: 100, cached,
    nanoAiu: 1e9, debugName: "panel/editAgent", ...extra };
}
const turn = (reqs, sessionId = "s1") => [{ sessionId, turnIndex: 0, debugRequests: reqs }];

console.log("\nidle past the TTL: the whole context is re-billed");
{
  const ev = detectCacheMisses(turn([req(0, 500_000, 480_000), req(338, 520_000, 14_000)]), base);
  assert("flagged once", ev.length === 1, `${ev.length}`);
  assert("blamed on the TTL, with the idle gap", ev[0].ttlExpired && ev[0].gapMs === 338 * SEC && ev[0].ttlMs === TTL);
  const warm = creditsFor("claude-opus-5", 520_000, 500_000);
  const cold = creditsFor("claude-opus-5", 520_000, 14_000);
  assert("wasted credits = actual minus the warm-cache price",
    Math.abs(ev[0].wastedCredits - (cold - warm)) < 1e-9 && ev[0].wastedCredits > 100, ev[0].wastedCredits.toFixed(1));
  assert("message names the TTL and the cost", /past the 5m 00s cache TTL/.test(describeCacheMiss(ev[0])) &&
    /credits extra/.test(describeCacheMiss(ev[0])), describeCacheMiss(ev[0]));
}

console.log("\nmiss inside the TTL: the prefix changed");
{
  const ev = detectCacheMisses(turn([req(0, 300_000, 290_000), req(40, 310_000, 10_000)]), base);
  assert("flagged, not blamed on the TTL", ev.length === 1 && !ev[0].ttlExpired);
  assert("message says the prefix changed", /prompt prefix changed/.test(describeCacheMiss(ev[0])));
}

console.log("\nconfigured TTL is what decides the cause");
{
  const reqs = turn([req(0, 300_000, 290_000), req(400, 310_000, 10_000)]);
  assert("400s idle is expired at a 5m TTL", detectCacheMisses(reqs, base)[0].ttlExpired === true);
  assert("400s idle is NOT expired at a 1h TTL",
    detectCacheMisses(reqs, { ...base, ttlMsFor: () => 3_600_000 })[0].ttlExpired === false);
}

console.log("\nquiet when nothing is wrong");
{
  assert("a warm cache is not a miss", detectCacheMisses(turn([req(0, 500_000, 480_000), req(20, 505_000, 499_000)]), base).length === 0);
  assert("the first request has nothing to have cached", detectCacheMisses(turn([req(0, 500_000, 0)]), base).length === 0);
  assert("a context that shrank (compaction) is a new prefix, not a miss",
    detectCacheMisses(turn([req(0, 500_000, 480_000), req(60, 120_000, 5_000)]), base).length === 0);
  assert("a small prompt is too cheap to report",
    detectCacheMisses(turn([req(0, 10_000, 9_000), req(400, 12_000, 0)]), base).length === 0);
  assert("a small miss under the credit floor is not reported",
    detectCacheMisses(turn([req(0, 25_000, 24_000), req(400, 26_000, 0)]), { ...base, minWastedCredits: 100 }).length === 0);
  assert("BYOK / unbilled requests (no credit figure) are skipped",
    detectCacheMisses(turn([req(0, 500_000, 480_000, { nanoAiu: 0 }), req(400, 510_000, 0, { nanoAiu: 0 })]), base).length === 0);
}

console.log("\neach call site keeps its own cache");
{
  const ev = detectCacheMisses(turn([
    req(0, 500_000, 480_000),
    req(10, 60_000, 500, { debugName: "tool/runSubagent-Explore" }), // a subagent: different prefix, different chain
    req(20, 505_000, 499_000),
  ]), base);
  assert("an interleaved subagent call is not a miss for the main chain", ev.length === 0, `${ev.length}`);
  assert("chains are also separate per session",
    detectCacheMisses([...turn([req(0, 500_000, 480_000)], "a"), ...turn([req(400, 510_000, 0)], "b")], base).length === 0);
}

console.log("\nonly new misses are reported");
{
  const reqs = turn([req(0, 500_000, 480_000), req(400, 510_000, 0), req(900, 520_000, 0)]);
  const since = T0 + 600 * SEC;
  const ev = detectCacheMisses(reqs, { ...base, since });
  assert("history before `since` is skipped", ev.length === 1 && ev[0].timestamp === T0 + 900 * SEC, `${ev.length}`);
}

console.log("\nbatched toast text");
{
  const ev = detectCacheMisses(turn([req(0, 500_000, 480_000), req(400, 510_000, 0), req(900, 520_000, 0)]), base);
  const text = summarizeCacheMisses(ev);
  assert("one miss reads as a sentence", /^Prompt cache missed — /.test(summarizeCacheMisses(ev.slice(0, 1))));
  assert("several misses are totalled", /missed 2 times/.test(text) && /credits extra in total/.test(text), text.slice(0, 120));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

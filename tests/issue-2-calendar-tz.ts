/**
 * issue-2-calendar-tz.ts — Reproducer + regression test for
 * https://github.com/pvjagtap/github-copilot-usage-dashboard/issues/2
 *
 *   "Calendar heatmap shows previous month (May) instead of June in local
 *    timezones ahead of UTC"
 *
 * Run:
 *   npx tsx tests/issue-2-calendar-tz.ts
 *
 * Strategy:
 *   1. Force the process timezone to Asia/Kolkata (UTC+05:30) so that any
 *      `Date` constructed from local Y/M/D land just before UTC midnight.
 *   2. Freeze `Date.now()` to 2026-06-10 10:00 IST (= 04:30 UTC) so that the
 *      "current local date" is unambiguously inside June.
 *   3. Drive the real `AICCalculator._getBillingCycle()` (indirectly via
 *      `computeSummary([])`) and assert that the serialized cycle start is
 *      `2026-06-01`, not `2026-05-31`.
 *   4. Replay the webview calendar derivation
 *      (`new Date(cycleStart + 'T00:00:00')`) and assert the rendered month
 *      label is `June 2026`.
 *
 * Before the fix this script exits with code 1 (one or more assertions
 * fail). After the fix it exits with code 0.
 */

// ─── Step 1: pin the timezone BEFORE any Date is constructed ─────────────
process.env.TZ = "Asia/Kolkata"; // UTC+05:30, no DST

// ─── Step 2: freeze "now" to a moment that is clearly in June LOCAL time
//           but in May UTC if we slice toISOString() naively. ─────────────
// 2026-06-01 00:00 IST = 2026-05-31 18:30 UTC — perfect boundary case.
// We pick 2026-06-10 02:00 IST = 2026-06-09 20:30 UTC so the local date
// is June 10 but the UTC date is June 9 (still good enough to flip the
// cycle-start serialization for billingCycleStartDay = 1).
const FIXED_NOW_MS = Date.UTC(2026, 5, 9, 20, 30, 0); // 2026-06-09T20:30:00Z
const OriginalDate = Date;
class MockDate extends OriginalDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(FIXED_NOW_MS);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      super(...(args as [any]));
    }
  }
  static now(): number { return FIXED_NOW_MS; }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Date = MockDate;

// Sanity check: the local date is June 10, the UTC date is June 9.
const probe = new Date();
const localYMD =
  probe.getFullYear() + "-" +
  String(probe.getMonth() + 1).padStart(2, "0") + "-" +
  String(probe.getDate()).padStart(2, "0");
const utcYMD = probe.toISOString().slice(0, 10);
console.log("[setup] TZ                =", process.env.TZ);
console.log("[setup] frozen Date.now() =", probe.toISOString());
console.log("[setup] local YYYY-MM-DD  =", localYMD);
console.log("[setup] UTC   YYYY-MM-DD  =", utcYMD);
if (localYMD !== "2026-06-10") {
  console.error("[setup] FATAL: TZ override did not take effect. Got local=" + localYMD);
  console.error("        On Windows, run with: $env:TZ='Asia/Kolkata'; npx tsx tests/issue-2-calendar-tz.ts");
  process.exit(2);
}

// ─── Step 3: drive the real billing-cycle code path ───────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const aic = require("../src/aicCredits");
const { AICCalculator, DEFAULT_PLANS } = aic;

const calc = new AICCalculator(undefined, {
  ...DEFAULT_PLANS.business,
  billingCycleStartDay: 1,
});
const summary = calc.computeSummary([]);
console.log("[result] billingCycleStart =", summary.billingCycleStart);
console.log("[result] billingCycleEnd   =", summary.billingCycleEnd);
console.log("[result] daysRemaining     =", summary.daysRemaining);

// ─── Step 4: replay the webview calendar header derivation ───────────────
// (mirrors buildCreditCalendar() in src/dashboardPanel.ts)
const startDate = new Date(summary.billingCycleStart + "T00:00:00");
const monthLabel = startDate.toLocaleString("en-US", { month: "long", year: "numeric" });
console.log("[result] calendar header  =", monthLabel);

// ─── Assertions ──────────────────────────────────────────────────────────
const failures: string[] = [];

if (summary.billingCycleStart !== "2026-06-01") {
  failures.push(
    "billingCycleStart should be '2026-06-01' (local cycle, billing day = 1) " +
    "but got '" + summary.billingCycleStart + "'. " +
    "Root cause: Date(year, month, 1) was serialized with toISOString().slice(0,10), " +
    "which shifts to the previous UTC day for positive UTC offsets.",
  );
}

if (summary.billingCycleEnd !== "2026-06-30") {
  failures.push(
    "billingCycleEnd should be '2026-06-30' but got '" + summary.billingCycleEnd + "'.",
  );
}

if (monthLabel !== "June 2026") {
  failures.push(
    "Calendar header should read 'June 2026' but got '" + monthLabel + "'. " +
    "This is the user-visible symptom in issue #2.",
  );
}

// daysElapsed shows up indirectly via dailyAverage/projectedTotal; verify the
// helper does not blow past 24h either by checking projectedTotal stays at 0
// for an empty entry list (i.e. no NaN, no Infinity from a negative elapsed).
if (!Number.isFinite(summary.projectedTotal)) {
  failures.push("projectedTotal is not finite: " + summary.projectedTotal);
}

if (failures.length === 0) {
  console.log("\nOK — issue #2 calendar/billing-cycle timezone handling is correct.");
  process.exit(0);
} else {
  console.error("\nFAIL — " + failures.length + " assertion(s) violated:");
  failures.forEach((f, i) => console.error("  " + (i + 1) + ". " + f));
  process.exit(1);
}

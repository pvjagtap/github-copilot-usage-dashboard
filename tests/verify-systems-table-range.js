/**
 * verify-systems-table-range.js
 *
 * The "Systems — Combined Usage" footer mixes two different spans:
 *
 *   - `combined` is summed from each slot's synced byDay map for the SELECTED
 *     RANGE (v1.11.4).
 *   - `quota_snapshots` only ever reports the CURRENT BILLING CYCLE, and there
 *     is no per-day split to reduce it with.
 *
 * Stating one against the other is a category error: under "All Time" the
 * table would print a cycle-only "Account total (GitHub ledger)" beneath a
 * column headed "Credits (All Time)", and derive the unattributed remainder by
 * subtracting a range figure from a cycle figure.
 *
 * This pins the range gating on the three footer rows. The Systems table is
 * built inside the webview's inline <script>, so it is extracted from the
 * compiled template literal and executed here rather than in a browser —
 * verify-webview-html.js only proves that script PARSES, not what it renders.
 *
 * Run after compile:
 *   node tests/verify-systems-table-range.js
 */

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "out", "dashboardPanel.js"),
  "utf8"
);

// ── Recover the runtime webview source ────────────────────────────────────
// Same approach as verify-webview-html.js: the escapes only resolve once the
// outer template literal is evaluated, so reading raw source is not faithful.
const literals = [];
let open = -1;
for (let i = 0; i < src.length; i++) {
  if (src[i] === "`" && src[i - 1] !== "\\") {
    if (open === -1) open = i + 1;
    else { literals.push(src.slice(open, i)); open = -1; }
  }
}
const rawTemplate = literals.reduce((a, b) => (b.length > a.length ? b : a), "");
const html = new Function(
  "return `" + rawTemplate.replace(/\$\{[^{}]*\}/g, "{}") + "`"
)();

function extractFunction(name) {
  const start = html.indexOf("function " + name + "(");
  if (start === -1) throw new Error("cannot find function " + name);
  const bodyStart = html.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in " + name);
}

const renderAICSrc = extractFunction("renderAIC");

// ── Sandbox ───────────────────────────────────────────────────────────────
// renderAIC closes over a lot of webview state that is irrelevant here. Rather
// than enumerate it, unknown identifiers resolve to a permissive stub that
// survives calls, property reads, arithmetic and string concatenation.
function universalStub() {
  const f = function () { return f; };
  return new Proxy(f, {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => 0;
      if (key === "toString") return () => "";
      if (key === Symbol.iterator) return function* () {};
      if (key === "length") return 0;
      return universalStub();
    },
    apply() { return universalStub(); },
  });
}

function run(aic, bounds, selectedRange, machines) {
  const captured = { innerHTML: "" };
  const known = {
    document: { getElementById: () => captured },
    DATA: { machines },
    esc: (s) => String(s == null ? "" : s),
    RANGE_LABELS: { thisMonth: "This Month", allTime: "All Time" },
    selectedRange,
    sessionCreditsInRange: () => 1,
    Math,
    Date,
    Object,
    Number,
    String,
    Array,
    JSON,
    isNaN,
    parseFloat,
    parseInt,
  };
  const scope = new Proxy(known, {
    has: () => true,
    // `with` consults Symbol.unscopables on every lookup; a truthy value there
    // makes it skip the binding and fall through to the real global scope.
    get: (t, k) =>
      k === Symbol.unscopables ? undefined : k in t ? t[k] : universalStub(),
  });
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "__scope",
    "with (__scope) { " + renderAICSrc + "\n return renderAIC; }"
  );
  factory(scope)(aic, bounds, []);
  return captured.innerHTML;
}

let failed = 0;
function check(label, cond, extra) {
  if (cond) console.log("  PASS  " + label);
  else { failed++; console.log("  FAIL  " + label + (extra ? "  (" + extra + ")" : "")); }
}

// The webview receives MachineView objects, already decorated host-side by
// machineSync.decorate() — `creditsAreLocal` is computed there, not here.
const slot = (host, credits, days) => ({
  host,
  platform: "win32",
  firstSeen: 1,
  lastSeen: Date.now(),
  cycleStart: "2026-09-01",
  cycleCredits: credits,
  basis: "local",
  schema: 2,
  creditsAreLocal: true,
  sessions: 10,
  turns: 100,
  totalTokens: 1000,
  byDay: days,
  byModel: {},
});

const aic = {
  billingCycleStart: "2026-09-01",
  billingCycleEnd: "2026-09-30",
  planName: "business",
  totalCredits: 500,
  localTotalCredits: 300,
  monthlyBudget: 1000,
  byDay: [],
  byModel: [],
  localByDay: [],
  config: { overageCostPerCredit: 0.01 },
  quota: {
    creditsUsed: 500,
    entitlement: 1000,
    localDelta: 200,
    localTotal: 300,
    anchorDay: "2026-09-12",
  },
};

const machines = [
  slot("alpha", 200, { "2026-09-10": 120, "2026-09-11": 80 }),
  slot("beta", 100, { "2026-09-11": 100 }),
];

console.log("\n1. Current cycle — ledger rows are stated");
{
  const out = run(aic, { start: "2026-09-01", end: null }, "thisMonth", machines);
  check("systems table rendered", out.indexOf("Systems") !== -1);
  check("account total shown", out.indexOf("Account total (GitHub ledger)") !== -1);
  check("unattributed remainder shown", out.indexOf("attributed to no system") !== -1);
  check("overage row shown", out.indexOf("credit allowance") !== -1);
  check("sigma row uses the range label", out.indexOf("systems this month") !== -1);
}

console.log("\n2. All Time — cycle-only figures are withheld");
{
  const out = run(aic, { start: null, end: null }, "allTime", machines);
  check("systems table still rendered", out.indexOf("Systems") !== -1);
  check(
    "account total withheld outside the cycle",
    out.indexOf("Account total (GitHub ledger)") === -1
  );
  check(
    "unattributed remainder withheld outside the cycle",
    out.indexOf("attributed to no system") === -1
  );
  check(
    "overage withheld outside the cycle",
    out.indexOf("credit allowance") === -1
  );
}

console.log("\n3. Past range — same withholding applies");
{
  const out = run(aic, { start: "2026-08-01", end: "2026-08-31" }, "lastMonth", machines);
  check(
    "account total withheld for a closed month",
    out.indexOf("Account total (GitHub ledger)") === -1
  );
  check(
    "unattributed remainder withheld for a closed month",
    out.indexOf("attributed to no system") === -1
  );
}

console.log("\n4. Legacy slots are shown but never summed");
{
  const legacy = {
    ...slot("gamma", 99999, {}),
    basis: undefined,
    schema: undefined,
    creditsAreLocal: false,
  };
  const out = run(
    aic,
    { start: "2026-09-01", end: null },
    "thisMonth",
    [...machines, legacy]
  );
  check("legacy host still listed", out.indexOf("gamma") !== -1);
  check("legacy slot tagged", out.indexOf("pre-1.11.4") !== -1);
  check("legacy figure not printed as credits", out.indexOf("99999") === -1);
}

console.log(
  "\n" + (failed === 0 ? "ALL CHECKS PASSED" : failed + " CHECK(S) FAILED")
);
process.exit(failed === 0 ? 0 : 1);

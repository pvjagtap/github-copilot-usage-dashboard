/**
 * verify-machine-usage-sync.js
 *
 * Guards the cross-machine usage rollup against the one way Settings Sync can
 * corrupt it: VS Code applies incoming extension state per declared key with a
 * plain replace, so anything that rewrites a foreign machine's slot destroys
 * that machine's numbers permanently. Also pins the System numbering (it must
 * be identical on every machine) and the retention bound on the payload.
 */
const path = require("path");
const Module = require("module");

const stub = path.join(__dirname, "_vscode-stub.js");
let MACHINE_ID = "machine-A";
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "vscode") return stub;
  return orig.call(this, req, ...rest);
};

// The stub has no `env`, so extend it with a machineId we can swap per test.
const vscodeStub = require(stub);
Object.defineProperty(vscodeStub, "env", { get: () => ({ machineId: MACHINE_ID }) });

const sync = require("../out/machineSync");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}

function makeCtx(seed) {
  const store = new Map(Object.entries(seed || {}));
  return {
    syncKeys: [],
    globalState: {
      get: k => store.get(k),
      update: (k, v) => { store.set(k, v); return Promise.resolve(); },
      setKeysForSync(keys) { this.__ctx.syncKeys = keys.slice(); },
    },
    __raw: store,
  };
}
function ctxFor(seed) {
  const c = makeCtx(seed);
  c.globalState.__ctx = c;
  return c;
}

const KEY = "copilotUsage.usage.machines.v1";
const usage = over => Object.assign({
  cycleStart: "2026-08-01",
  cycleCredits: 100,
  basis: "local",
  sessions: 5,
  turns: 50,
  totalTokens: 1000,
  byDay: { "2026-08-01": 100 },
  byModel: { "gpt-5": 100 },
}, over);

console.log("\n1. Both synced keys are declared in a single call");
{
  const ctx = ctxFor();
  sync.registerSyncKeys(ctx);
  check("catalog rates key declared", ctx.syncKeys.includes("copilotUsage.aic.modelCatalogRates.v1"));
  check("machines key declared", ctx.syncKeys.includes(KEY));
  check("no other keys leak into sync", ctx.syncKeys.length === 2, JSON.stringify(ctx.syncKeys));
}

console.log("\n2. Publishing never rewrites another machine's slot");
{
  const foreign = {
    host: "laptop", platform: "darwin",
    firstSeen: 1000, lastSeen: 2000,
    cycleStart: "2026-08-01", cycleCredits: 42,
    sessions: 3, turns: 30, totalTokens: 900,
    byDay: { "2026-08-01": 42 }, byModel: { "claude": 42 },
  };
  const ctx = ctxFor({ [KEY]: { "machine-B": foreign } });
  MACHINE_ID = "machine-A";
  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage());
  const after = ctx.__raw.get(KEY);
  check("foreign slot byte-identical after publish",
    JSON.stringify(after["machine-B"]) === JSON.stringify(foreign));
  check("own slot written", after["machine-A"] && after["machine-A"].cycleCredits === 100);
}

console.log("\n3. System numbering is stable and derived from firstSeen");
{
  const map = {
    "machine-Z": { host: "z", platform: "linux", firstSeen: 100, lastSeen: 100, cycleStart: "2026-08-01", cycleCredits: 1, sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
    "machine-A": { host: "a", platform: "win32", firstSeen: 900, lastSeen: 900, cycleStart: "2026-08-01", cycleCredits: 2, sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
  };
  MACHINE_ID = "machine-A";
  sync.__resetThrottleForTesting();
  const fromA = sync.readMachines(ctxFor({ [KEY]: map }));
  MACHINE_ID = "machine-Z";
  const fromZ = sync.readMachines(ctxFor({ [KEY]: map }));

  check("oldest machine is System 1", fromA[0].id === "machine-Z" && fromA[0].label === "System 1");
  check("numbering identical on both machines",
    fromA.map(m => m.id + ":" + m.label).join("|") === fromZ.map(m => m.id + ":" + m.label).join("|"));
  check("local machine flagged correctly on A",
    fromA.find(m => m.id === "machine-A").isThisMachine === true &&
    fromA.find(m => m.id === "machine-Z").isThisMachine === false);
  check("local machine flagged correctly on Z",
    fromZ.find(m => m.id === "machine-Z").isThisMachine === true);
}

console.log("\n4. Dormant machines are flagged, not silently summed");
{
  const day = 24 * 60 * 60 * 1000;
  const map = {
    "old": { host: "o", platform: "win32", firstSeen: 1, lastSeen: Date.now() - 30 * day, cycleStart: "2026-08-01", cycleCredits: 10, sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
    "new": { host: "n", platform: "win32", firstSeen: 2, lastSeen: Date.now(), cycleStart: "2026-08-01", cycleCredits: 20, sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
  };
  MACHINE_ID = "new";
  sync.__resetThrottleForTesting();
  const views = sync.readMachines(ctxFor({ [KEY]: map }));
  check("stale machine marked dormant", views.find(v => v.id === "old").dormant === true);
  check("fresh machine not dormant", views.find(v => v.id === "new").dormant === false);
}

console.log("\n5. Combined total only sums matching billing cycles");
{
  const map = {
    "a": { host: "a", platform: "win32", firstSeen: 1, lastSeen: Date.now(), cycleStart: "2026-08-01", cycleCredits: 100.5, basis: "local", sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {}, schema: 2 },
    "b": { host: "b", platform: "win32", firstSeen: 2, lastSeen: Date.now(), cycleStart: "2026-08-01", cycleCredits: 20.25, basis: "local", sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {}, schema: 2 },
    "c": { host: "c", platform: "win32", firstSeen: 3, lastSeen: Date.now(), cycleStart: "2026-07-01", cycleCredits: 999, basis: "local", sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {}, schema: 2 },
  };
  MACHINE_ID = "a";
  sync.__resetThrottleForTesting();
  const views = sync.readMachines(ctxFor({ [KEY]: map }));
  const total = sync.combinedCredits(views, "2026-08-01");
  check("sums current cycle only", total === 120.75, String(total));
}

console.log("\n5b. Pre-fix slots stay visible but are never summed");
{
  // A schema-less slot carried GitHub's account-wide ledger as its credits.
  // Adding it would restate the whole account on top of the real machines.
  const map = {
    "legacy": { host: "desktop", platform: "win32", firstSeen: 1, lastSeen: Date.now(), cycleStart: "2026-08-01", cycleCredits: 42069, sessions: 221, turns: 2564, byDay: {}, byModel: {}, totalTokens: 0 },
    "fixed": { host: "laptop", platform: "linux", firstSeen: 2, lastSeen: Date.now(), cycleStart: "2026-08-01", cycleCredits: 767.15, sessions: 3, turns: 82, totalTokens: 0, byDay: {}, byModel: {}, schema: 2 },
  };
  MACHINE_ID = "fixed";
  const views = sync.readMachines(ctxFor({ [KEY]: map }));
  const legacy = views.find(v => v.id === "legacy");

  check("legacy system still listed", !!legacy && legacy.host === "desktop");
  check("legacy credits flagged as not machine-local", legacy.creditsAreLocal === false);
  check("legacy counters still readable", legacy.sessions === 221 && legacy.turns === 2564);
  check("upgraded system flagged as machine-local",
    views.find(v => v.id === "fixed").creditsAreLocal === true);
  check("combined excludes the account-wide figure",
    sync.combinedCredits(views, "2026-08-01") === 767.15,
    String(sync.combinedCredits(views, "2026-08-01")));
}

console.log("\n5c. A `basis` tag alone also proves a per-machine figure");
{
  // Pre-v1.11.4 publishers wrote the quota-reconciled account total, which is
  // identical on every machine — summing two of them doubled the whole cycle.
  const map = {
    "a": { host: "a", platform: "win32", firstSeen: 1, lastSeen: Date.now(), cycleStart: "2026-08-01", cycleCredits: 66130, sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
    "b": { host: "b", platform: "win32", firstSeen: 2, lastSeen: Date.now(), cycleStart: "2026-08-01", cycleCredits: 66130, sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
    "c": { host: "c", platform: "win32", firstSeen: 3, lastSeen: Date.now(), cycleStart: "2026-08-01", cycleCredits: 11182.4, basis: "local", sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
  };
  MACHINE_ID = "c";
  sync.__resetThrottleForTesting();
  const views = sync.readMachines(ctxFor({ [KEY]: map }));
  check("legacy slots flagged", views.filter(v => !v.creditsAreLocal).map(v => v.id).join(",") === "a,b");
  check("basis-tagged slot not flagged", views.find(v => v.id === "c").creditsAreLocal === true);
  check("legacy credits excluded from combined",
    sync.combinedCredits(views, "2026-08-01") === 11182.4,
    String(sync.combinedCredits(views, "2026-08-01")));
}

console.log("\n5d. Republishing stamps the local basis onto an upgraded slot");
{
  const ctx = ctxFor({ [KEY]: {
    "machine-A": { host: "a", platform: "win32", firstSeen: 1, lastSeen: 1, cycleStart: "2026-08-01", cycleCredits: 66130, sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
  } });
  MACHINE_ID = "machine-A";
  sync.__resetThrottleForTesting();
  const views = sync.publishAndRead(ctx, usage({ cycleCredits: 11182.4 }));
  check("upgraded slot carries local basis", ctx.__raw.get(KEY)["machine-A"].basis === "local");
  check("upgraded slot no longer legacy", views[0].creditsAreLocal === true);
}

console.log("\n6. Daily history is trimmed so the payload stays bounded");
{
  const byDay = {};
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    byDay[d] = 1;
  }
  MACHINE_ID = "machine-A";
  const ctx = ctxFor();  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage({ byDay }));
  const slot = ctx.__raw.get(KEY)["machine-A"];
  const days = Object.keys(slot.byDay);
  check("retained window capped at 120 days", days.length === 120, String(days.length));
  check("most recent day survives trimming", days.includes(Object.keys(byDay).sort().pop()));
  const bytes = Buffer.byteLength(JSON.stringify(ctx.__raw.get(KEY)), "utf8");
  check("full-history slot well under the 512 KB sync threshold",
    bytes < 512 * 1024 / 4, bytes + " bytes");
}

console.log("\n6b. Daily history accumulates instead of being overwritten");
{
  // Debug logs rotate and closed cycles stop being rescanned, so a publish
  // routinely sees fewer days than the slot already holds. Replacing the map
  // would drop a retired machine's only surviving record.
  MACHINE_ID = "machine-A";
  const ctx = ctxFor();

  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage({
    cycleStart: "2026-08-01",
    byDay: { "2026-08-01": 10, "2026-08-02": 20 },
  }));

  // Next cycle: the scan no longer covers August at all.
  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage({
    cycleStart: "2026-09-01",
    byDay: { "2026-09-01": 5 },
  }));

  const slot = ctx.__raw.get(KEY)["machine-A"];
  check("last cycle's days survive the next publish",
    slot.byDay["2026-08-01"] === 10 && slot.byDay["2026-08-02"] === 20,
    JSON.stringify(slot.byDay));
  check("current day recorded alongside", slot.byDay["2026-09-01"] === 5);
  check("closed cycle still totals correctly from byDay",
    slot.byDay["2026-08-01"] + slot.byDay["2026-08-02"] === 30);

  // A day the scan can no longer see reports 0 — that is absence of evidence,
  // not evidence the day cost nothing.
  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage({
    cycleStart: "2026-09-01",
    byDay: { "2026-08-01": 0, "2026-09-01": 7 },
  }));
  const after = ctx.__raw.get(KEY)["machine-A"];
  check("a zero does not erase a stored day", after.byDay["2026-08-01"] === 10,
    String(after.byDay["2026-08-01"]));
  check("a non-zero recomputation does supersede", after.byDay["2026-09-01"] === 7);
}

console.log("\n7. Republishing preserves firstSeen so numbering does not shuffle");
{
  MACHINE_ID = "machine-A";
  const ctx = ctxFor();
  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage());
  const first = ctx.__raw.get(KEY)["machine-A"].firstSeen;
  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage({ cycleCredits: 200 }));
  const slot = ctx.__raw.get(KEY)["machine-A"];
  check("firstSeen unchanged on republish", slot.firstSeen === first);
  check("credits updated on republish", slot.cycleCredits === 200);
  check("lastSeen advanced", slot.lastSeen >= first);
}

console.log("\n7b. Repeat rebuilds do not hammer the sync service");
{
  MACHINE_ID = "machine-A";
  const ctx = ctxFor();
  let writes = 0;
  const realUpdate = ctx.globalState.update;
  ctx.globalState.update = (k, v) => { writes++; return realUpdate(k, v); };

  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage());          // first write
  sync.publishAndRead(ctx, usage());          // identical -> skip
  sync.publishAndRead(ctx, usage({ cycleCredits: 101 })); // within interval -> skip
  check("only the first publish writes", writes === 1, writes + " writes");

  const views = sync.publishAndRead(ctx, usage());
  check("throttled call still returns the merged view",
    views.length === 1 && views[0].isThisMachine === true);
}

console.log("\n7c. A sync that overwrites our own slot is repaired immediately");
{
  // Settings Sync replaces the whole key, so an inbound map carries whatever
  // this machine last uploaded — including a pre-basis copy of our own row.
  MACHINE_ID = "machine-A";
  const ctx = ctxFor();
  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage({ cycleCredits: 11182.4 }));

  const remote = {
    "machine-A": { host: "a", platform: "win32", firstSeen: 1, lastSeen: 1, cycleStart: "2026-08-01", cycleCredits: 66923, sessions: 18, turns: 222, totalTokens: 0, byDay: {}, byModel: {} },
    "machine-B": { host: "b", platform: "win32", firstSeen: 2, lastSeen: Date.now(), cycleStart: "2026-08-01", cycleCredits: 66923, sessions: 264, turns: 2704, totalTokens: 0, byDay: {}, byModel: {} },
  };
  ctx.__raw.set(KEY, remote);

  // Same fingerprint as the publish above, so the throttle would otherwise
  // suppress the repair and leave our row reading the account-wide figure.
  const views = sync.publishAndRead(ctx, usage({ cycleCredits: 11182.4 }));
  const mine = views.find(v => v.isThisMachine);
  check("own row is not resurrected as legacy", mine.creditsAreLocal === true);
  check("own row keeps the local figure", mine.cycleCredits === 11182.4, String(mine.cycleCredits));
  check("repair write persisted through the throttle",
    ctx.__raw.get(KEY)["machine-A"].basis === "local");
  check("foreign slot from the inbound map is preserved",
    views.some(v => v.id === "machine-B" && v.creditsAreLocal === false));
  check("only our own local credits are summed",
    sync.combinedCredits(views, "2026-08-01") === 11182.4);
}

console.log("\n7d. readMachines overlays the live own slot over a synced copy");
{
  MACHINE_ID = "machine-A";
  const ctx = ctxFor();
  sync.__resetThrottleForTesting();
  sync.publishAndRead(ctx, usage({ cycleCredits: 11182.4 }));
  ctx.__raw.set(KEY, {
    "machine-A": { host: "a", platform: "win32", firstSeen: 1, lastSeen: 1, cycleStart: "2026-08-01", cycleCredits: 66923, sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
  });
  const mine = sync.readMachines(ctx).find(v => v.isThisMachine);
  check("read-only path prefers the live slot", mine.cycleCredits === 11182.4, String(mine.cycleCredits));
  check("read-only path is not flagged legacy", mine.creditsAreLocal === true);
}

console.log("\n8. Malformed foreign slots are ignored rather than rendered");
{
  MACHINE_ID = "machine-A";
  sync.__resetThrottleForTesting();
  const views = sync.readMachines(ctxFor({
    [KEY]: {
      "bad": null,
      "worse": { host: "x" },
      "good": { host: "g", platform: "win32", firstSeen: 1, lastSeen: 1, cycleStart: "2026-08-01", cycleCredits: 1, sessions: 0, turns: 0, totalTokens: 0, byDay: {}, byModel: {} },
    },
  }));
  check("only well-formed slots surface", views.length === 1 && views[0].id === "good");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

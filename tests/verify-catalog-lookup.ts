/**
 * verify-catalog-lookup.ts — covers the new precedence rule in
 * `classifyModelBillability()`:
 *
 *   5. Online catalog lookup — if `catalogLookup(model)` returns
 *      `{ billable: true | false }`, that wins over `isKnownGHCModel()`.
 *
 * Together with `verify-billable-classification.ts` this guarantees the
 * full classifier precedence ladder is exercised in CI.
 *
 * Run with: npx tsx tests/verify-catalog-lookup.ts
 */

import {
  classifyModelBillability,
  createCalculatorFromConfig,
  DEFAULT_AIC_CONFIG,
  type CatalogLookup,
} from "../src/aicCredits";
import {
  parseUserChatLanguageModels,
  mergeThirdPartyMaps,
} from "../src/chatLanguageModelsParser";

let failed = 0;
function assert(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

const calc = createCalculatorFromConfig(DEFAULT_AIC_CONFIG);
const cfg = { ...DEFAULT_AIC_CONFIG };

// ── Test 1: catalog hit with billable=true outranks "unknown" model
{
  console.log("== Test 1: catalog promotes unknown model to billable ==");
  const lookup: CatalogLookup = (m) =>
    m.toLowerCase() === "claude-fable-5" ? { billable: true } : null;

  // Without catalog: classifier falls through to isKnownGHCModel → false.
  const noCat = classifyModelBillability(calc, cfg, "claude-fable-5", false);
  assert("without catalog: claude-fable-5 is NON-billable", noCat === false);

  // With catalog: hit forces billable=true.
  const withCat = classifyModelBillability(calc, cfg, "claude-fable-5", false, lookup);
  assert("with catalog: claude-fable-5 is billable", withCat === true);
}

// ── Test 2: catalog hit with billable=false outranks isKnownGHCModel
{
  console.log("== Test 2: catalog demotes BYOK-listed model to non-billable ==");
  // The CDN manifest lists e.g. 'gpt-4o' under the openai (BYOK) provider too.
  // A BYOK-only catalog entry should override the rate-table substring match.
  const lookup: CatalogLookup = (m) =>
    m.toLowerCase().startsWith("gpt-4o-byok") ? { billable: false } : null;

  // Without catalog: gpt-4o-byok-test substring-matches "gpt-4o" → billable.
  const noCat = classifyModelBillability(calc, cfg, "gpt-4o-byok-test", false);
  assert("without catalog: substring match makes it billable", noCat === true);

  // With catalog: BYOK entry forces non-billable.
  const withCat = classifyModelBillability(calc, cfg, "gpt-4o-byok-test", false, lookup);
  assert("with catalog: BYOK entry forces non-billable", withCat === false);
}

// ── Test 3: catalog miss falls through to existing precedence
{
  console.log("== Test 3: catalog miss falls through to isKnownGHCModel ==");
  const empty: CatalogLookup = () => null;

  const knownBillable = classifyModelBillability(calc, cfg, "claude-sonnet-4.5", false, empty);
  assert("catalog miss + known GHC model → billable", knownBillable === true);

  const unknownNonBillable = classifyModelBillability(calc, cfg, "ollama/qwen-2.5", false, empty);
  assert("catalog miss + unknown model → non-billable", unknownNonBillable === false);
}

// ── Test 4: explicit excludeModels still wins over catalog
{
  console.log("== Test 4: excludeModels still wins over catalog ==");
  const lookup: CatalogLookup = () => ({ billable: true });
  const cfgExcluded = { ...DEFAULT_AIC_CONFIG, excludeModels: ["claude-sonnet"] };

  const result = classifyModelBillability(
    calc,
    cfgExcluded,
    "claude-sonnet-4.5",
    false,
    lookup,
  );
  assert("excludeModels overrides catalog billable=true", result === false);
}

// ── Test 5: hasActualCredits still wins over catalog
{
  console.log("== Test 5: hasActualCredits still wins over catalog ==");
  const lookup: CatalogLookup = () => ({ billable: false });

  // GitHub's backend already billed it (nanoAiu > 0) — that's the strongest
  // possible signal and must not be overruled by a stale catalog entry.
  const result = classifyModelBillability(calc, cfg, "claude-fable-5", true, lookup);
  assert("hasActualCredits=true outranks catalog billable=false", result === true);
}

// ── Test 6: parseUserChatLanguageModels — third-party detection
{
  console.log("== Test 6: parseUserChatLanguageModels (third-party detection) ==");
  // Sample matches the real shape shown in <UserDir>/chatLanguageModels.json:
  //   Copilot entry with billable model overrides + an Ollama-style entry.
  const sample = JSON.stringify([
    {
      name: "Copilot",
      vendor: "copilot",
      settings: {
        "gpt-5.4": { reasoningEffort: "high" },
        "claude-sonnet-4.6": { contextSize: 200000 },
      },
    },
    {
      name: "Anthropic (BYOK)",
      vendor: "anthropic",
      settings: {
        "claude-opus-4-byok": { apiKey: "redacted" },
      },
    },
    { name: "Ollama", vendor: "ollama", url: "http://localhost:11434" },
  ]);

  const map = parseUserChatLanguageModels(sample);

  assert(
    "Copilot-vendor id `gpt-5.4` is NOT recorded as third-party",
    !map.has("gpt-5.4")
  );
  assert(
    "Copilot-vendor id `claude-sonnet-4.6` is NOT recorded as third-party",
    !map.has("claude-sonnet-4.6")
  );
  assert(
    "Anthropic-vendor id `claude-opus-4-byok` IS recorded as third-party",
    map.get("claude-opus-4-byok") === "anthropic"
  );
  assert(
    "Ollama entry (no settings block) contributes no specific ids",
    Array.from(map.values()).every(v => v !== "ollama")
  );
}

// ── Test 7: ambiguous ids (listed under multiple vendors) are omitted
{
  console.log("== Test 7: parseUserChatLanguageModels (ambiguous id is dropped) ==");
  const sample = JSON.stringify([
    {
      name: "Copilot",
      vendor: "copilot",
      settings: { "shared-model-x": {} },
    },
    {
      name: "BYOK Anthropic",
      vendor: "anthropic",
      settings: { "shared-model-x": {} },
    },
  ]);
  const map = parseUserChatLanguageModels(sample);
  assert(
    "id listed under both copilot and anthropic is dropped (ambiguous)",
    !map.has("shared-model-x")
  );
}

// ── Test 8: mergeThirdPartyMaps — file ∪ runtime registry
{
  console.log("== Test 8: mergeThirdPartyMaps (file ∪ runtime LM registry) ==");
  // Simulates: chatLanguageModels.json says claude-opus-4-byok → anthropic.
  // VS Code's lm registry adds Ollama runtime models too.
  const fileMap = new Map<string, string>([["claude-opus-4-byok", "anthropic"]]);
  const lmMap = new Map<string, string>([
    ["claude-opus-4-byok", "anthropic"], // same as file → keep
    ["ollama/qwen-2.5", "ollama"], // file didn't know → add
    ["gpt-4o-mini", "openai"], // BYOK key registered at runtime → add
  ]);

  const merged = mergeThirdPartyMaps(fileMap, lmMap);

  assert(
    "agreeing entry kept (claude-opus-4-byok → anthropic)",
    merged.get("claude-opus-4-byok") === "anthropic"
  );
  assert(
    "runtime-only entry added (ollama/qwen-2.5 → ollama)",
    merged.get("ollama/qwen-2.5") === "ollama"
  );
  assert(
    "runtime BYOK API-key entry added (gpt-4o-mini → openai)",
    merged.get("gpt-4o-mini") === "openai"
  );
  assert("merged size is exactly 3", merged.size === 3);
}

// ── Test 9: mergeThirdPartyMaps — vendor disagreement drops the id
{
  console.log("== Test 9: mergeThirdPartyMaps (disagreement is dropped) ==");
  // File says model-y → anthropic, but the runtime registry says model-y → openai.
  // We can't resolve this safely; drop the id and fall back to CAPI/heuristic.
  const fileMap = new Map<string, string>([["model-y", "anthropic"]]);
  const lmMap = new Map<string, string>([["model-y", "openai"]]);
  const merged = mergeThirdPartyMaps(fileMap, lmMap);
  assert("disagreeing id is dropped", !merged.has("model-y"));
  assert("merged size is 0", merged.size === 0);
}

if (failed > 0) {
  console.error(`\n${failed} catalog-lookup check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll catalog-lookup checks passed.");

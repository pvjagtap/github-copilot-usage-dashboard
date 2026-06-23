/**
 * verify-online-catalog.ts — Standalone smoke test for the **CDN half** of
 * what `copilotUsage.aic.useOnlineModelCatalog` reads.
 *
 * What it does:
 *   1. GETs the CDN known-models manifest (no auth required) and prints
 *      provider counts + a sample of model IDs under each.
 *   2. Does NOT call the Copilot CAPI `/models` endpoint. That endpoint
 *      requires a Copilot internal token minted from a GitHub OAuth session
 *      that belongs to an allowed OAuth app (the VS Code Copilot Chat
 *      extension, JetBrains plugin, etc.). The `gh` CLI's OAuth app is not
 *      in that allowed list — `/copilot_internal/v2/token` returns 404 for
 *      its tokens (confirmed: `gh api copilot_internal/v2/token` → 404).
 *
 * To see the **real CAPI response** in your environment:
 *   • Launch the extension (F5 in VS Code, or install the .vsix).
 *   • Open the "Copilot Usage" output channel.
 *   • The catalog refresh runs automatically at activation AND whenever
 *     your GitHub session changes (sign-in, sign-out, account switch).
 *   • Look for lines like:
 *       modelCatalog: silent GitHub session found with scopes=[…]
 *       modelCatalog: token sku=copilot_for_business_seat
 *                     endpoints.api=https://api.business.githubcopilot.com (per-plan)
 *       modelCatalog: refreshed — N CAPI billing entries, M CDN BYOK ids …
 *   • The plan-specific CAPI host comes from the token response's
 *     `endpoints.api` field (per microsoft/vscode-copilot-chat
 *     src/platform/authentication/common/copilotToken.ts `TokenEnvelope`)
 *     so business / enterprise / individual users all just work.
 *
 * Run:
 *   npx tsx tests/verify-online-catalog.ts
 */

const KNOWN_MODELS_URL = "https://main.vscode-cdn.net/extensions/copilotChat.json";
const USER_AGENT = "vscode-copilot-usage-dashboard";

import { createHash } from "node:crypto";

interface KnownModelsManifest {
  version: number;
  modelInfo: Record<string, Record<string, unknown>>;
}

async function fetchCdn(): Promise<void> {
  console.log("─── CDN known-models manifest (no auth) ───");
  console.log(`GET ${KNOWN_MODELS_URL}`);
  const t0 = Date.now();
  const res = await fetch(KNOWN_MODELS_URL, {
    method: "GET",
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    // bust any local fetch cache so we prove this is a fresh round-trip
    cache: "no-store",
  });
  const elapsed = Date.now() - t0;
  console.log(`  status: ${res.status} ${res.statusText}  (${elapsed} ms)`);
  if (!res.ok) {
    console.log("  (non-2xx response — skipping)\n");
    return;
  }

  // Print response headers that prove this is a live HTTPS round-trip
  // and not a value baked into the script. `date` shifts on every run;
  // `last-modified` / `etag` shift each time Microsoft pushes a new
  // copilotChat.json (typically each Copilot Chat extension release).
  const headersOfInterest = [
    "date",
    "last-modified",
    "etag",
    "age",
    "content-length",
    "x-azure-ref",
    "x-cache",
  ];
  console.log("  response headers (live HTTP, prove this is a real fetch):");
  for (const h of headersOfInterest) {
    const v = res.headers.get(h);
    if (v) {
      console.log(`    ${h}: ${v}`);
    }
  }

  const rawText = await res.text();
  const sha256 = createHash("sha256").update(rawText).digest("hex");
  console.log(`    sha256(body): ${sha256}  (changes when Microsoft updates the file)`);
  console.log(`    body bytes:   ${rawText.length}`);

  const body = JSON.parse(rawText) as KnownModelsManifest;
  console.log(`  version: ${body.version}`);
  const providers = Object.keys(body.modelInfo ?? {});
  console.log(`  providers (${providers.length}): ${providers.join(", ")}`);
  console.log(
    "  NOTE: all entries are BYOK-only model metadata. The list of GitHub-billable"
  );
  console.log(
    "        Copilot models comes from the per-plan CAPI /models endpoint (see header)."
  );
  console.log(
    "  NOTE: this manifest is effectively static between Copilot Chat releases —"
  );
  console.log(
    "        Microsoft only republishes it when shipping a new extension version,"
  );
  console.log(
    "        so identical model IDs across runs is correct, not a bug. The headers"
  );
  console.log(
    "        above (date/etag/last-modified) prove every run is a real network call."
  );
  console.log();
  for (const provider of providers) {
    const ids = Object.keys(body.modelInfo[provider] ?? {});
    console.log(`  ${provider} (${ids.length} models)`);
    const sample = ids.slice(0, 6).join(", ");
    if (sample) {
      console.log(`    sample: ${sample}${ids.length > 6 ? ", …" : ""}`);
    }
  }
  console.log();
}

async function main(): Promise<void> {
  console.log(`tests/verify-online-catalog.ts — ${new Date().toISOString()}\n`);
  try {
    await fetchCdn();
  } catch (err) {
    console.log(`  CDN fetch threw: ${String(err)}\n`);
  }
  console.log(
    "To verify the CAPI /models response in your environment, launch the extension and"
  );
  console.log(
    'open the "Copilot Usage" output channel — see the header comment in this file.'
  );
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});

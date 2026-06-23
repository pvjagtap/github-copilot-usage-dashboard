/**
 * modelCatalog.ts — Authoritative GitHub Copilot model catalog.
 *
 * Background — issue #5 follow-up research:
 *
 *   The classifier `classifyModelBillability()` in `aicCredits.ts` ultimately
 *   falls back to a substring match against the built-in `DEFAULT_MODEL_COSTS`
 *   rate table to decide whether GitHub bills a given model. That table is
 *   maintained manually from
 *   <https://docs.github.com/en/copilot/reference/ai-models/supported-models>,
 *   so any newly-released preview model (e.g. "claude-fable-5") looks
 *   "unknown" until we ship a new extension version.
 *
 *   This module hardens that decision by reading two Microsoft-published
 *   sources used by the official Copilot Chat extension itself:
 *
 *     1. The Copilot CAPI `/models` endpoint — the AUTHORITATIVE billing source.
 *        <https://api.individual.githubcopilot.com/models>
 *        Called after exchanging the user's GitHub OAuth token for a Copilot
 *        internal token at <https://api.github.com/copilot_internal/v2/token>.
 *        The response is `{ data: IModelAPIResponse[] }`. Each entry includes
 *        a `billing: { is_premium, multiplier, restricted_to? }` field that
 *        is the canonical "does GitHub bill this model" signal:
 *
 *           billing.multiplier > 0  → billable to AI Credits
 *           billing absent / 0      → not billed (free/utility)
 *
 *        We re-use the same silent-session pattern as `planDetector.ts`
 *        so we never prompt the user.
 *
 *     2. The CDN-hosted BYOK known-models manifest — informational only.
 *        <https://main.vscode-cdn.net/extensions/copilotChat.json>
 *        Same URL `BYOKContrib.fetchKnownModelList()` in
 *        `microsoft/vscode-copilot-chat` reads on startup. Despite the
 *        misleading top-level name, the schema
 *          { version: 1, modelInfo: { [provider]: { [modelId]: caps } } }
 *        contains ONLY BYOK provider keys (OpenAI, Anthropic, Gemini, Groq,
 *        xAI — verified via `tests/verify-online-catalog.ts`). It carries
 *        capability metadata for BYOK keys; it does NOT enumerate Copilot's
 *        billable model set. We track which provider lists a given id (for
 *        diagnostics) but DO NOT use it to decide billability — the same id
 *        often appears in both BYOK lists AND the Copilot CAPI response
 *        (e.g. `claude-opus-4-7`), and demoting it based on CDN data alone
 *        would wrongly classify real Copilot traffic.
 *
 * Both sources are network calls — wrapped in 24h disk cache in
 * `globalState`, best-effort (failures fall back silently to the
 * built-in `DEFAULT_MODEL_COSTS` heuristic), and can be disabled via the
 * `copilotUsage.aic.useOnlineModelCatalog` setting.
 *
 * Lifecycle:
 *   • `loadCatalog()` is called once at extension activation.
 *   • The returned set/map is exposed via `getCachedCatalog()` so the
 *     classifier can consult it synchronously on every credit entry.
 *   • A refresh runs once per 24 hours (or on demand).
 */

import * as vscode from "vscode";
import {
  parseUserChatLanguageModels,
  mergeThirdPartyMaps,
} from "./chatLanguageModelsParser";

// ─── Constants ────────────────────────────────────────────────

/** Known-models manifest used by Copilot Chat's BYOKContrib. */
const KNOWN_MODELS_URL = "https://main.vscode-cdn.net/extensions/copilotChat.json";

/** Copilot internal token mint endpoint — same one `planDetector.ts` uses. */
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/**
 * Fallback CAPI host used only if the token response is missing the
 * `endpoints.api` field. The real host comes back per-plan in the token
 * envelope (e.g. `api.business.githubcopilot.com` for Business,
 * `api.enterprise.githubcopilot.com` for Enterprise, `api.individual…`
 * for Individual). See `TokenEnvelope` / `Endpoints` in
 * microsoft/vscode-copilot-chat `src/platform/authentication/common/copilotToken.ts`.
 */
const FALLBACK_CAPI_HOST = "https://api.individual.githubcopilot.com";

/**
 * Scope sets the official Copilot extension is known to mint sessions with.
 * Matches the candidate list in `planDetector.ts/trySilentSession()` so a
 * session created for plan detection is reused here without a second prompt.
 */
const SCOPE_CANDIDATES: string[][] = [
  ["read:user"],
  ["user:email"],
  ["repo", "workflow", "read:user"],
  ["repo"],
];

/** How long a successful catalog is considered fresh. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** globalState key for the cached catalog. */
const CATALOG_CACHE_KEY = "copilotUsage.aic.modelCatalog.v1";

/** Default User-Agent — matches what `planDetector.ts` sends. */
const USER_AGENT = "vscode-copilot-usage-dashboard";

// ─── Types ────────────────────────────────────────────────────

/**
 * The shape of the CDN `copilotChat.json` payload (only the fields we read).
 * Mirrors `BYOKContrib.fetchKnownModelList()` in microsoft/vscode-copilot-chat
 * (`src/extension/byok/vscode-node/byokContribution.ts`).
 */
interface KnownModelsManifest {
  version: number;
  modelInfo: Record<string, Record<string, unknown>>;
}

/**
 * One entry from the Copilot CAPI `/models` response. Mirrors
 * `IModelAPIResponse` in microsoft/vscode-copilot-chat
 * (`src/platform/endpoint/common/endpointProvider.ts`).
 */
interface CapiModelResponse {
  id: string;
  vendor?: string;
  name?: string;
  model_picker_enabled?: boolean;
  preview?: boolean;
  billing?: {
    is_premium?: boolean;
    multiplier?: number;
    restricted_to?: string[];
  };
}

/**
 * One billability fact about a model. Only entries with a definitive
 * `source: "capi"` are returned to the classifier — those are the only
 * entries whose `billable` flag is authoritative.
 *
 *  • `source: "capi"` — `multiplier` came from the Copilot CAPI `/models`
 *                       response. `billable === (multiplier > 0)`. This is
 *                       the ONLY source the classifier trusts.
 *
 * CDN-derived metadata (provider lists from `copilotChat.json`) is captured
 * in `ModelCatalog.cdnProviders` for diagnostics but never fed to
 * `classifyByCatalog()` — because the CDN file contains only BYOK provider
 * lists and the same model id (e.g. `claude-opus-4-7`) routinely appears in
 * both the BYOK list AND Copilot's billable set. Demoting based on CDN data
 * alone would wrongly classify real Copilot traffic. Verified via
 * `tests/verify-online-catalog.ts`.
 */
export interface ModelCatalogEntry {
  id: string;
  billable: boolean;
  multiplier?: number;
  isPremium?: boolean;
  preview?: boolean;
  vendor?: string;
  /**
   *  • `"capi"`        — entry came from the Copilot CAPI `/models` response.
   *                       `billable === (multiplier > 0)`.
   *  • `"user-config"` — entry was synthesised from the user's local
   *                       `chatLanguageModels.json`. Always `billable=false`
   *                       (vendor ≠ copilot).
   */
  source: "capi" | "user-config";
}

/** In-memory snapshot of the catalog. */
export interface ModelCatalog {
  fetchedAt: number;
  /** Lower-cased model id → entry (CAPI-derived only). */
  byId: Map<string, ModelCatalogEntry>;
  /** Provider → set of model ids from the CDN BYOK manifest. Diagnostics only. */
  cdnProviders: Record<string, string[]>;
  /**
   * Lower-cased model id → vendor name, drawn from the user's local
   * `<UserDir>/chatLanguageModels.json` (the file VS Code writes when the
   * user configures a chat-model provider). Only entries where the vendor
   * is NOT `copilot` and the id appears under exactly one vendor are
   * recorded — i.e. unambiguous third-party model associations such as
   * `ollama`, `anthropic` (BYOK), `lmstudio`. A hit here is treated as an
   * authoritative "non-billable" signal by `classifyByCatalog()`.
   */
  userVendorByModelId: Map<string, string>;
}

interface CatalogCachePayload {
  fetchedAt: number;
  entries: ModelCatalogEntry[];
  cdnProviders: Record<string, string[]>;
  /** Persisted form of `ModelCatalog.userVendorByModelId`. */
  userVendorByModelId?: Array<[string, string]>;
}

type LogFn = (msg: string) => void;

// ─── Module state ─────────────────────────────────────────────

let cached: ModelCatalog | null = null;

// ─── Public API ───────────────────────────────────────────────

/**
 * Returns the in-memory catalog snapshot, or `null` if it has not been
 * loaded yet (or loading failed). Synchronous on purpose so it can be
 * consulted from inside `classifyModelBillability()`.
 */
export function getCachedCatalog(): ModelCatalog | null {
  return cached;
}

/**
 * Lookup helper used by the classifier. Returns `null` when the model is
 * not present in the catalog — callers should fall through to the existing
 * rate-table heuristic in that case.
 *
 * Precedence inside the catalog itself:
 *   1. User's `chatLanguageModels.json` says this id belongs to a non-Copilot
 *      vendor (Ollama, BYOK Anthropic key, LM Studio, …) → non-billable. This
 *      is treated as authoritative because the user themselves told VS Code
 *      where the model is served from.
 *   2. CAPI `/models` entry exists → use its billing flag.
 */
export function classifyByCatalog(modelName: string): ModelCatalogEntry | null {
  if (!cached) {
    return null;
  }
  const key = modelName.toLowerCase();

  const thirdPartyVendor = cached.userVendorByModelId.get(key);
  if (thirdPartyVendor) {
    return {
      id: modelName,
      billable: false,
      vendor: thirdPartyVendor,
      source: "user-config",
    };
  }

  return cached.byId.get(key) ?? null;
}

/**
 * Loads the catalog: hydrates from disk cache first (instant), then triggers
 * a background refresh if the cache is stale or empty. Designed to be called
 * once from `extension.activate()`.
 *
 * Network failures are swallowed — the classifier will simply not see this
 * source and fall back to the rate-table heuristic.
 */
export async function loadCatalog(
  ctx: vscode.ExtensionContext,
  opts: { enabled: boolean; log: LogFn; refreshNow?: boolean }
): Promise<ModelCatalog | null> {
  // Honour the user-facing kill switch — `useOnlineModelCatalog === false`.
  if (!opts.enabled) {
    cached = null;
    return null;
  }

  // 1. Hydrate from disk cache so the classifier has something immediately.
  const disk = ctx.globalState.get<CatalogCachePayload>(CATALOG_CACHE_KEY);
  if (disk && Array.isArray(disk.entries) && disk.entries.length > 0) {
    cached = {
      fetchedAt: disk.fetchedAt,
      byId: new Map(disk.entries.map(e => [e.id.toLowerCase(), e])),
      cdnProviders: disk.cdnProviders ?? {},
      userVendorByModelId: new Map(disk.userVendorByModelId ?? []),
    };
    opts.log(
      `modelCatalog: hydrated ${cached.byId.size} entries from cache (age=${Math.round(
        (Date.now() - disk.fetchedAt) / 60000
      )}min)`
    );
  }

  // 2. Decide whether to refresh from network.
  const fresh = cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS;
  if (fresh && !opts.refreshNow) {
    return cached;
  }

  // 3. Network refresh — fire and (mostly) forget. The first successful
  //    response replaces `cached` and is persisted.
  void refreshFromNetwork(ctx, opts.log).catch(err => {
    opts.log(`modelCatalog: refresh failed silently — ${String(err)}`);
  });

  return cached;
}

// ─── Internal — network refresh ──────────────────────────────

async function refreshFromNetwork(ctx: vscode.ExtensionContext, log: LogFn): Promise<void> {
  // Fetch all four sources in parallel. Any may fail independently.
  //   • CDN manifest                — informational
  //   • CAPI /models                — authoritative GitHub billing
  //   • chatLanguageModels.json     — user's persisted third-party providers
  //   • vscode.lm.selectChatModels  — runtime BYOK / API-key providers
  const [cdnRes, capiRes, userRes, lmRes] = await Promise.allSettled([
    fetchCdnManifest(log),
    fetchCapiModels(log),
    readUserChatLanguageModels(ctx, log),
    readRegisteredLanguageModels(log),
  ]);

  const entries = new Map<string, ModelCatalogEntry>();
  const cdnProviders: Record<string, string[]> = {};

  // ── CDN manifest — INFORMATIONAL ONLY ───────────────────
  // Verified via tests/verify-online-catalog.ts: the manifest exposes only
  // BYOK provider keys (OpenAI, Anthropic, Gemini, Groq, xAI). The same
  // model id (e.g. `claude-opus-4-7`) appears in both this BYOK list and
  // the authoritative CAPI billable set, so we MUST NOT use the CDN data
  // to demote anything — we just record what providers know each id.
  if (cdnRes.status === "fulfilled" && cdnRes.value) {
    const manifest = cdnRes.value;
    for (const [provider, modelMap] of Object.entries(manifest.modelInfo ?? {})) {
      cdnProviders[provider] = Object.keys(modelMap ?? {});
    }
  }

  // ── Copilot CAPI /models — AUTHORITATIVE BILLING SOURCE ──────
  if (capiRes.status === "fulfilled" && capiRes.value) {
    for (const m of capiRes.value) {
      const mult = m.billing?.multiplier ?? 0;
      entries.set(m.id.toLowerCase(), {
        id: m.id,
        billable: mult > 0,
        multiplier: mult,
        isPremium: m.billing?.is_premium ?? false,
        preview: m.preview ?? false,
        vendor: m.vendor,
        source: "capi",
      });
    }
  }

  // ── User's chatLanguageModels.json + vscode.lm registry ─ THIRD-PARTY SIGNAL ──
  // Both sources tell us "which model id routes through which non-Copilot
  // vendor" — the file covers persisted UI choices (`vendor: "anthropic"`,
  // `vendor: "ollama"`, … i.e. API-key-based BYOK providers the user set up),
  // while the runtime registry covers anything Copilot Chat or other
  // extensions have actually registered with VS Code (catches BYOK ids that
  // never made it into the JSON file, plus Ollama-style dynamically-discovered
  // models). We merge them with a strict conflict rule: same id with the same
  // non-Copilot vendor in both → keep; different vendors → drop (be safe).
  const fileMap =
    userRes.status === "fulfilled" && userRes.value ? userRes.value : new Map<string, string>();
  const lmMap =
    lmRes.status === "fulfilled" && lmRes.value ? lmRes.value : new Map<string, string>();
  const userVendorByModelId = mergeThirdPartyMaps(fileMap, lmMap);

  if (
    entries.size === 0 &&
    Object.keys(cdnProviders).length === 0 &&
    userVendorByModelId.size === 0
  ) {
    log("modelCatalog: refresh produced 0 entries — keeping previous cache");
    return;
  }

  const next: ModelCatalog = {
    fetchedAt: Date.now(),
    byId: entries,
    cdnProviders,
    userVendorByModelId,
  };
  cached = next;

  const payload: CatalogCachePayload = {
    fetchedAt: next.fetchedAt,
    entries: Array.from(entries.values()),
    cdnProviders,
    userVendorByModelId: Array.from(userVendorByModelId.entries()),
  };
  await ctx.globalState.update(CATALOG_CACHE_KEY, payload);

  const cdnTotal = Object.values(cdnProviders).reduce((s, ids) => s + ids.length, 0);
  log(
    `modelCatalog: refreshed — ${entries.size} CAPI billing entries, ${cdnTotal} CDN BYOK ids across ${Object.keys(cdnProviders).length} providers, ${userVendorByModelId.size} user-config third-party ids`
  );
}

async function fetchCdnManifest(log: LogFn): Promise<KnownModelsManifest | null> {
  try {
    const res = await fetch(KNOWN_MODELS_URL, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      log(`modelCatalog: CDN manifest returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as KnownModelsManifest;
    if (body.version !== 1 || typeof body.modelInfo !== "object" || body.modelInfo === null) {
      log("modelCatalog: CDN manifest has unexpected shape — ignoring");
      return null;
    }
    return body;
  } catch (err) {
    log(`modelCatalog: CDN fetch error — ${String(err)}`);
    return null;
  }
}

async function fetchCapiModels(log: LogFn): Promise<CapiModelResponse[] | null> {
  // 1. Borrow an existing VS Code GitHub session by walking the same scope
  //    candidates `planDetector.ts` uses. This means after the user has
  //    consented once (for plan detection, or because Copilot Chat itself
  //    minted a session), every subsequent refresh is silent — and it works
  //    regardless of which scope set the session was originally created with.
  let ghToken: string | undefined;
  for (const scopes of SCOPE_CANDIDATES) {
    try {
      const s = await vscode.authentication.getSession("github", scopes, {
        silent: true,
        createIfNone: false,
      });
      if (s) {
        ghToken = s.accessToken;
        log(`modelCatalog: silent GitHub session found with scopes=[${scopes.join(",")}]`);
        break;
      }
    } catch {
      /* fall through to next scope set */
    }
  }
  if (!ghToken) {
    log("modelCatalog: no silent GitHub session — skipping CAPI /models fetch");
    return null;
  }

  // 2. Mint a Copilot internal token and read endpoints.api from the
  //    response. The server returns the correct host for the user's plan
  //    (individual / business / enterprise) without us having to know it
  //    up front. Schema: `TokenEnvelope.endpoints.api` in
  //    microsoft/vscode-copilot-chat src/platform/authentication/common/copilotToken.ts.
  let copilotToken: string | undefined;
  let capiHost = FALLBACK_CAPI_HOST;
  try {
    const tokRes = await fetch(COPILOT_TOKEN_URL, {
      method: "GET",
      headers: {
        Authorization: `token ${ghToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
    if (!tokRes.ok) {
      log(`modelCatalog: /copilot_internal/v2/token returned ${tokRes.status} — skipping CAPI`);
      return null;
    }
    const tokBody = (await tokRes.json()) as {
      token?: string;
      sku?: string;
      endpoints?: { api?: string };
    };
    copilotToken = tokBody.token;
    if (tokBody.endpoints?.api) {
      capiHost = tokBody.endpoints.api.replace(/\/+$/, "");
      log(`modelCatalog: token sku=${tokBody.sku ?? "?"} endpoints.api=${capiHost} (per-plan)`);
    } else {
      log(
        `modelCatalog: token response missing endpoints.api — falling back to ${FALLBACK_CAPI_HOST}`
      );
    }
  } catch (err) {
    log(`modelCatalog: token mint error — ${String(err)}`);
    return null;
  }
  if (!copilotToken) {
    return null;
  }

  // 3. GET ${endpoints.api}/models.
  try {
    const modelsUrl = `${capiHost}/models`;
    const modelsRes = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Editor-Version": "vscode/1.85.0",
        "Copilot-Integration-Id": "vscode-chat",
      },
    });
    if (!modelsRes.ok) {
      log(`modelCatalog: CAPI ${modelsUrl} returned ${modelsRes.status}`);
      return null;
    }
    const body = (await modelsRes.json()) as { data?: CapiModelResponse[] };
    if (!Array.isArray(body.data)) {
      log("modelCatalog: CAPI /models response missing .data array");
      return null;
    }
    return body.data;
  } catch (err) {
    log(`modelCatalog: CAPI fetch error — ${String(err)}`);
    return null;
  }
}

// ─── User-config — chatLanguageModels.json ────────────────────

/**
 * Read and parse the user's `<UserDir>/chatLanguageModels.json`. Returns
 * `null` (logged but non-fatal) if the file is missing, unreadable, or
 * malformed.
 *
 * The user dir is derived from `context.globalStorageUri` — which on every
 * platform and build (stable / Insiders / OSS / Remote / WSL) is
 * `<UserDir>/globalStorage/<extensionId>`. Going up two levels gives us the
 * User dir without any platform-specific path math.
 *
 * Parsing rules live in `chatLanguageModelsParser.ts` (pure function,
 * exercised directly from tests).
 */
async function readUserChatLanguageModels(
  ctx: vscode.ExtensionContext,
  log: LogFn
): Promise<Map<string, string> | null> {
  try {
    const userDir = vscode.Uri.joinPath(ctx.globalStorageUri, "..", "..");
    const fileUri = vscode.Uri.joinPath(userDir, "chatLanguageModels.json");
    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder("utf-8").decode(bytes);
    const map = parseUserChatLanguageModels(text);
    log(
      `modelCatalog: chatLanguageModels.json → ${map.size} unambiguous third-party model ids`
    );
    return map;
  } catch (err) {
    // ENOENT / FileNotFound is the common case for users who have never
    // configured a third-party chat provider — log at info level and move on.
    log(`modelCatalog: chatLanguageModels.json not readable — ${String(err)}`);
    return null;
  }
}

// ─── Runtime — vscode.lm.selectChatModels() ──────────────────

/**
 * Enumerate every chat model currently registered with VS Code and return
 * a `lowercase id → vendor` map for **unambiguous non-Copilot** entries.
 *
 * This is the runtime complement to `readUserChatLanguageModels()`. The
 * file-based reader knows about ids the user has *typed into* settings;
 * this reader knows about everything Copilot Chat / other extensions have
 * actually registered as a chat model — including:
 *
 *  • BYOK API-key providers (Anthropic, OpenAI, Gemini, Groq, xAI) once
 *    the user has stored their key — Copilot Chat registers the resulting
 *    model with its own vendor tag (e.g. `vendor: "anthropic"`), so we
 *    can tell it apart from native GitHub-billed Copilot models.
 *  • Ollama / LM Studio models discovered dynamically at runtime, which
 *    typically don't appear in `chatLanguageModels.json` because the file
 *    only persists explicit settings overrides.
 *  • Any other vendor an extension contributes via VS Code's chat API.
 *
 * `vscode.lm.selectChatModels()` is enumeration-only — the consent
 * dialog is reserved for `LanguageModelChat.sendRequest()`, so calling
 * this during refresh is safe and silent. Failures (older VS Code, no
 * API, etc.) are swallowed and an empty map is returned.
 */
async function readRegisteredLanguageModels(log: LogFn): Promise<Map<string, string>> {
  try {
    const models = await vscode.lm.selectChatModels();
    // Bucket by lowercase id to detect ambiguity within this source.
    const idToVendors = new Map<string, Set<string>>();
    for (const m of models) {
      const id = (m.id ?? "").toLowerCase();
      const vendor = (m.vendor ?? "").toLowerCase();
      if (!id || !vendor) {
        continue;
      }
      const set = idToVendors.get(id) ?? new Set<string>();
      set.add(vendor);
      idToVendors.set(id, set);
    }

    const out = new Map<string, string>();
    for (const [id, vendors] of idToVendors) {
      if (vendors.size !== 1) {
        continue; // ambiguous within the runtime registry
      }
      const [v] = vendors;
      if (v === "copilot") {
        continue; // billable
      }
      out.set(id, v);
    }
    log(
      `modelCatalog: vscode.lm.selectChatModels → ${out.size} non-copilot model ids (from ${models.length} registered)`
    );
    return out;
  } catch (err) {
    log(`modelCatalog: vscode.lm.selectChatModels unavailable — ${String(err)}`);
    return new Map<string, string>();
  }
}
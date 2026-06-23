/**
 * chatLanguageModelsParser.ts — Pure parser for the user's
 * `<UserDir>/chatLanguageModels.json`.
 *
 * Kept in its own file (zero imports) so the parser can be exercised
 * directly from Node tests without needing a `vscode` stub. The IO/path
 * resolution lives in `modelCatalog.ts/readUserChatLanguageModels()` which
 * calls this function with the file's text.
 *
 * File schema (observed; not formally published by VS Code):
 *   [
 *     {
 *       "name":   "Copilot",
 *       "vendor": "copilot",
 *       "settings": { "<modelId>": { ...per-model opts... }, ... }
 *     },
 *     {
 *       "name":   "Ollama",
 *       "vendor": "ollama",
 *       "url":    "http://localhost:11434"
 *     },
 *     ...
 *   ]
 *
 *  • `vendor === "copilot"` means GitHub bills it; anything else
 *    (ollama, lmstudio, anthropic, openai, …) is third-party / not billed.
 *  • `settings` keys are the model ids the user has explicitly configured
 *    under that vendor. Providers that enumerate models at runtime
 *    (Ollama, LM Studio) typically have no `settings` block — we simply
 *    won't have a third-party entry for those ids and the classifier
 *    falls through to its existing `isKnownGHCModel()` heuristic.
 */

interface UserChatProviderEntry {
  name?: string;
  vendor?: string;
  url?: string;
  settings?: Record<string, unknown>;
}

/**
 * Parse the raw JSON text of `chatLanguageModels.json` and return a map of
 * `lowercase model id → vendor name` for **unambiguous** third-party
 * associations.
 *
 * Rules:
 *  • Model ids listed under `vendor === "copilot"` are IGNORED — they're
 *    billable, and the authoritative billing source for them is the CAPI
 *    /models response, not this file.
 *  • If a model id appears under more than one vendor (e.g. both Copilot
 *    and an Anthropic BYOK key), it's AMBIGUOUS — omit from the map. The
 *    classifier will fall back to the CAPI entry / heuristic.
 *  • Only ids appearing under exactly one non-Copilot vendor are recorded.
 */
export function parseUserChatLanguageModels(rawJson: string): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) {
    return out;
  }

  // First pass: tally (id → set of vendors).
  const idToVendors = new Map<string, Set<string>>();
  for (const raw of parsed) {
    const entry = raw as UserChatProviderEntry;
    const vendor = typeof entry?.vendor === "string" ? entry.vendor.trim() : "";
    if (!vendor) {
      continue;
    }
    const settings = entry.settings;
    if (!settings || typeof settings !== "object") {
      continue;
    }
    for (const rawId of Object.keys(settings)) {
      const id = rawId.toLowerCase();
      if (!id) {
        continue;
      }
      const set = idToVendors.get(id) ?? new Set<string>();
      set.add(vendor.toLowerCase());
      idToVendors.set(id, set);
    }
  }

  // Second pass: keep unambiguous third-party associations only.
  for (const [id, vendors] of idToVendors) {
    if (vendors.size !== 1) {
      continue; // ambiguous — listed under multiple vendors
    }
    const [vendor] = vendors;
    if (vendor === "copilot") {
      continue; // billable, not third-party
    }
    out.set(id, vendor);
  }
  return out;
}

/**
 * Merge two `id → vendor` maps produced by different third-party detection
 * sources (e.g. `chatLanguageModels.json` vs `vscode.lm.selectChatModels()`).
 *
 * Rules:
 *  • If both sources agree on the same non-Copilot vendor for an id, keep it.
 *  • If they disagree, DROP the id (safer than picking arbitrarily — the
 *    classifier falls back to the CAPI billing entry / heuristic).
 *  • If only one source has the id, keep that mapping.
 */
export function mergeThirdPartyMaps(
  a: Map<string, string>,
  b: Map<string, string>
): Map<string, string> {
  const out = new Map(a);
  for (const [id, vendor] of b) {
    const existing = out.get(id);
    if (existing === undefined) {
      out.set(id, vendor);
    } else if (existing !== vendor) {
      out.delete(id);
    }
    // else: same vendor in both sources — keep as-is.
  }
  return out;
}

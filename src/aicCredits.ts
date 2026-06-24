/**
 * aicCredits.ts — AI Credits (AIC) cost calculation engine.
 *
 * GitHub Copilot moved to usage-based billing with AI Credits (AIC) starting June 1, 2026.
 * Reference: https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises
 *
 * This module provides a configurable, per-model credit cost system that can be
 * updated as GitHub changes pricing without code changes.
 *
 * Architecture:
 *  - ModelCostConfig defines per-model rates (credits per 1M tokens input/output)
 *  - PlanConfig defines plan-level limits and included credits
 *  - AICCalculator computes credits consumed from token counts
 *  - Configuration is loaded from settings with sensible defaults
 */

// ─── Types ────────────────────────────────────────────────────

/**
 * Per-model cost rates in AI Credits per 1 million tokens.
 * 1 AI credit = $0.01 USD.
 * Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 */
export interface ModelCostRate {
  /** Display name / identifier of the model */
  model: string;
  /** Credits per 1M input tokens (prompt tokens) */
  inputCreditsPerMillion: number;
  /** Credits per 1M output tokens (completion tokens) */
  outputCreditsPerMillion: number;
  /** Credits per 1M cached input tokens (read — discounted rate) */
  cachedInputCreditsPerMillion: number;
  /** Credits per 1M cache write tokens (Anthropic only, 0 for others) */
  cacheWriteCreditsPerMillion: number;
  /** Model category: base, premium, or custom */
  tier: "base" | "premium" | "custom";
}

/**
 * Plan configuration for credit budgets.
 */
export interface PlanConfig {
  /** Plan name: "business", "enterprise", "individual", "free" */
  planName: string;
  /** Monthly included premium requests (legacy metric, pre-AIC) */
  includedPremiumRequests: number;
  /** Monthly included AI credits (0 = unlimited within plan allowance) */
  monthlyCreditsIncluded: number;
  /** Overage cost per credit (USD) — 0 if no overage allowed */
  overageCostPerCredit: number;
  /** Billing cycle start day of month (1-31) */
  billingCycleStartDay: number;
}

/**
 * Computed credit usage for a single request/turn.
 */
export interface CreditUsage {
  /** Input credits consumed */
  inputCredits: number;
  /** Output credits consumed */
  outputCredits: number;
  /** Cached input credits consumed (discounted rate) */
  cachedCredits: number;
  /** Total credits for this request */
  totalCredits: number;
  /** Model used */
  model: string;
  /** Cost tier applied */
  tier: "base" | "premium" | "custom";
}

/**
 * Aggregated credit summary for a time period.
 *
 * Only **billable** entries contribute to the headline totals
 * (`totalCredits`, `inputCredits`, `outputCredits`, `cachedCredits`, `byModel`,
 * `byDay`, `creditsRemaining`, `estimatedOverageCost`, `dailyAverage`,
 * `projectedTotal`). Non-billable entries — usage from local Ollama / LM Studio
 * / BYOK keys / unrecognised models that GitHub's backend does not bill — are
 * surfaced separately under `nonBillable` for informational display only.
 * See issue #5: <https://github.com/pvjagtap/github-copilot-usage-dashboard/issues/5>
 */
export interface CreditSummary {
  /** Total credits consumed (billable only) */
  totalCredits: number;
  /** Credits from input tokens (billable only) */
  inputCredits: number;
  /** Credits from output tokens (billable only) */
  outputCredits: number;
  /** Credits from cached tokens (billable only) */
  cachedCredits: number;
  /** Per-model breakdown (billable only) */
  byModel: Map<string, CreditUsage>;
  /** Per-day breakdown (billable only) */
  byDay: Map<string, number>;
  /**
   * Informational summary for non-billable entries (BYOK, local Ollama, etc.).
   * Credit values here are *rate-table estimates* of what the same usage
   * would cost on GitHub Copilot — useful for capacity planning but NOT
   * what GitHub will bill the user.
   */
  nonBillable: {
    totalCredits: number;
    byModel: Map<string, CreditUsage>;
  };
  /** Plan budget info */
  plan: PlanConfig;
  /** Credits remaining in billing cycle (-1 if unlimited) */
  creditsRemaining: number;
  /** Estimated overage cost (USD) */
  estimatedOverageCost: number;
  /** Current billing cycle start date */
  billingCycleStart: string;
  /** Current billing cycle end date */
  billingCycleEnd: string;
  /** Days remaining in billing cycle */
  daysRemaining: number;
  /** Daily average credit consumption */
  dailyAverage: number;
  /** Projected end-of-cycle total */
  projectedTotal: number;
}

// ─── Default Model Cost Rates ─────────────────────────────────
// Official GitHub Copilot AI Credits pricing (effective June 1, 2025)
// Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
//
// 1 AI credit = $0.01 USD. All rates are AI Credits per 1 Million tokens.
// Conversion: USD price × 100 = credits.
//
// Anthropic models include a separate "cache write" cost.
// OpenAI/Google models: cache write = 0 (no separate charge).

export const DEFAULT_MODEL_COSTS: ModelCostRate[] = [
  // ── Anthropic (includes cache write cost) ──
  // Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing#anthropic
  { model: "claude-opus-4.8",     inputCreditsPerMillion: 500, outputCreditsPerMillion: 2500, cachedInputCreditsPerMillion: 50, cacheWriteCreditsPerMillion: 625, tier: "premium" },
  { model: "claude-opus-4.7",     inputCreditsPerMillion: 500, outputCreditsPerMillion: 2500, cachedInputCreditsPerMillion: 50, cacheWriteCreditsPerMillion: 625, tier: "premium" },
  { model: "claude-opus-4.6",     inputCreditsPerMillion: 500, outputCreditsPerMillion: 2500, cachedInputCreditsPerMillion: 50, cacheWriteCreditsPerMillion: 625, tier: "premium" },
  { model: "claude-opus-4.5",     inputCreditsPerMillion: 500, outputCreditsPerMillion: 2500, cachedInputCreditsPerMillion: 50, cacheWriteCreditsPerMillion: 625, tier: "premium" },
  { model: "claude-sonnet-4.6",   inputCreditsPerMillion: 300, outputCreditsPerMillion: 1500, cachedInputCreditsPerMillion: 30, cacheWriteCreditsPerMillion: 375, tier: "base" },
  { model: "claude-sonnet-4.5",   inputCreditsPerMillion: 300, outputCreditsPerMillion: 1500, cachedInputCreditsPerMillion: 30, cacheWriteCreditsPerMillion: 375, tier: "base" },
  { model: "claude-sonnet-4",     inputCreditsPerMillion: 300, outputCreditsPerMillion: 1500, cachedInputCreditsPerMillion: 30, cacheWriteCreditsPerMillion: 375, tier: "base" },
  { model: "claude-haiku-4.5",    inputCreditsPerMillion: 100, outputCreditsPerMillion: 500,  cachedInputCreditsPerMillion: 10, cacheWriteCreditsPerMillion: 125, tier: "base" },

  // ── OpenAI ──
  // Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing#openai
  { model: "gpt-4o-mini",          inputCreditsPerMillion: 15,  outputCreditsPerMillion: 60,   cachedInputCreditsPerMillion: 7.5,  cacheWriteCreditsPerMillion: 0, tier: "base" },
  { model: "gpt-4o",               inputCreditsPerMillion: 250, outputCreditsPerMillion: 1000, cachedInputCreditsPerMillion: 125,  cacheWriteCreditsPerMillion: 0, tier: "base" },
  { model: "gpt-5.5",             inputCreditsPerMillion: 500, outputCreditsPerMillion: 3000, cachedInputCreditsPerMillion: 50,   cacheWriteCreditsPerMillion: 0, tier: "premium" },
  { model: "gpt-5.4",             inputCreditsPerMillion: 250, outputCreditsPerMillion: 1500, cachedInputCreditsPerMillion: 25,   cacheWriteCreditsPerMillion: 0, tier: "premium" },
  { model: "gpt-5.4-mini",        inputCreditsPerMillion: 75,  outputCreditsPerMillion: 450,  cachedInputCreditsPerMillion: 7.5,  cacheWriteCreditsPerMillion: 0, tier: "base" },
  { model: "gpt-5.4-nano",        inputCreditsPerMillion: 20,  outputCreditsPerMillion: 125,  cachedInputCreditsPerMillion: 2,    cacheWriteCreditsPerMillion: 0, tier: "base" },
  { model: "gpt-5.3-codex",       inputCreditsPerMillion: 175, outputCreditsPerMillion: 1400, cachedInputCreditsPerMillion: 17.5, cacheWriteCreditsPerMillion: 0, tier: "premium" },
  { model: "gpt-5.2-codex",       inputCreditsPerMillion: 175, outputCreditsPerMillion: 1400, cachedInputCreditsPerMillion: 17.5, cacheWriteCreditsPerMillion: 0, tier: "premium" },
  { model: "gpt-5.2",             inputCreditsPerMillion: 175, outputCreditsPerMillion: 1400, cachedInputCreditsPerMillion: 17.5, cacheWriteCreditsPerMillion: 0, tier: "premium" },
  { model: "gpt-5-mini",          inputCreditsPerMillion: 25,  outputCreditsPerMillion: 200,  cachedInputCreditsPerMillion: 2.5,  cacheWriteCreditsPerMillion: 0, tier: "base" },
  { model: "gpt-4.1",             inputCreditsPerMillion: 200, outputCreditsPerMillion: 800,  cachedInputCreditsPerMillion: 50,   cacheWriteCreditsPerMillion: 0, tier: "base" },

  // ── Google ──
  // Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing#google
  { model: "gemini-3.5-flash",    inputCreditsPerMillion: 150, outputCreditsPerMillion: 900,  cachedInputCreditsPerMillion: 15,   cacheWriteCreditsPerMillion: 0, tier: "base" },
  { model: "gemini-3.1-pro",      inputCreditsPerMillion: 200, outputCreditsPerMillion: 1200, cachedInputCreditsPerMillion: 20,   cacheWriteCreditsPerMillion: 0, tier: "premium" },
  { model: "gemini-3-flash",      inputCreditsPerMillion: 50,  outputCreditsPerMillion: 300,  cachedInputCreditsPerMillion: 5,    cacheWriteCreditsPerMillion: 0, tier: "base" },
  { model: "gemini-2.5-pro",      inputCreditsPerMillion: 125, outputCreditsPerMillion: 1000, cachedInputCreditsPerMillion: 12.5, cacheWriteCreditsPerMillion: 0, tier: "premium" },

  // ── Fine-tuned (GitHub) ──
  { model: "raptor-mini",         inputCreditsPerMillion: 25,  outputCreditsPerMillion: 200,  cachedInputCreditsPerMillion: 2.5,  cacheWriteCreditsPerMillion: 0, tier: "base" },
];

// ─── Default Plan Configurations ──────────────────────────────
// Sources (verified live against docs.github.com):
//   • Individuals: https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals
//   • Org/Enterprise: https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises
//
// 1 AI credit = $0.01 USD.
//
// Individual plans (Pro / Pro+ / Max) include a "base credits" amount plus a
// "flex allotment" — both count toward the monthly total reported here:
//   Pro   = 1,000 base + 500 flex  = 1,500 total
//   Pro+  = 3,900 base + 3,100 flex = 7,000 total
//   Max   = 10,000 base + 10,000 flex = 20,000 total
//
// Organization plans (Business / Enterprise) pool credits at the billing
// entity level. Promotional uplift (June 1 – Sept 1, 2026) applies ONLY to
// existing Business and Enterprise customers — NOT to Free / Pro / Pro+ / Max.
//   Business    standard = 1,900 / promo = 3,000 (per user/month, pooled)
//   Enterprise  standard = 3,900 / promo = 7,000 (per user/month, pooled)

export const DEFAULT_PLANS: Record<string, PlanConfig> = {
  business: {
    planName: "business",
    includedPremiumRequests: 300, // legacy metric (pre-AIC)
    monthlyCreditsIncluded: 1900, // official: 1,900 AI credits per user/month (pooled)
    overageCostPerCredit: 0.01,   // 1 credit = $0.01 USD
    billingCycleStartDay: 1,
  },
  business_promo: {
    planName: "business_promo",
    includedPremiumRequests: 300,
    monthlyCreditsIncluded: 3000, // promotional: June 1 – Sept 1, 2026
    overageCostPerCredit: 0.01,
    billingCycleStartDay: 1,
  },
  enterprise: {
    planName: "enterprise",
    includedPremiumRequests: 1000,
    monthlyCreditsIncluded: 3900, // official: 3,900 AI credits per user/month (pooled)
    overageCostPerCredit: 0.01,
    billingCycleStartDay: 1,
  },
  enterprise_promo: {
    planName: "enterprise_promo",
    includedPremiumRequests: 1000,
    monthlyCreditsIncluded: 7000, // promotional: June 1 – Sept 1, 2026
    overageCostPerCredit: 0.01,
    billingCycleStartDay: 1,
  },
  max: {
    planName: "max",
    includedPremiumRequests: 3000,
    monthlyCreditsIncluded: 20000, // Copilot Max: 10,000 base + 10,000 flex = 20,000
    overageCostPerCredit: 0.01,
    billingCycleStartDay: 1,
  },
  pro_plus: {
    planName: "pro_plus",
    includedPremiumRequests: 1500,
    monthlyCreditsIncluded: 7000, // Copilot Pro+: 3,900 base + 3,100 flex = 7,000
    overageCostPerCredit: 0.01,
    billingCycleStartDay: 1,
  },
  pro: {
    planName: "pro",
    includedPremiumRequests: 300,
    monthlyCreditsIncluded: 1500, // Copilot Pro: 1,000 base + 500 flex = 1,500
    overageCostPerCredit: 0.01,
    billingCycleStartDay: 1,
  },
  free: {
    planName: "free",
    includedPremiumRequests: 0,
    // Copilot Free: docs state an unspecified AI credits allowance plus 2,000
    // completions/month. GitHub has not published an official number, so 250
    // is a conservative placeholder. Override via copilotUsage.aic.monthlyCreditsIncluded.
    monthlyCreditsIncluded: 250,
    overageCostPerCredit: 0,    // no overage on free — usage blocked
    billingCycleStartDay: 1,
  },
};

// ─── Promotional Period Detection ─────────────────────────────

/** Promo window: June 1, 2026 – September 1, 2026 (exclusive end) */
const PROMO_START = "2026-06-01";
const PROMO_END = "2026-09-01";

/** Promo budgets for existing customers during June 1 – Sept 1, 2026 */
const PROMO_BUDGETS: Record<string, number> = {
  business: 3000,
  business_promo: 3000,
  enterprise: 7000,
  enterprise_promo: 7000,
};

export interface PromoInfo {
  isPromoActive: boolean;
  promoBudget: number;
  standardBudget: number;
  promoEndDate: string;
}

/**
 * Detect if the current date falls within the promotional period
 * and return the promo budget for the given plan.
 * Always uses the official standard budget from DEFAULT_PLANS for the
 * "without promo" comparison (ignoring any user overrides).
 */
export function getPromoInfo(planName: string, _monthlyCreditsIncluded: number): PromoInfo {
  const today = new Date().toISOString().slice(0, 10);
  const isPromoActive = today >= PROMO_START && today < PROMO_END;
  const promoBudget = PROMO_BUDGETS[planName] ?? 0;

  // Standard budget: always use the official non-promo value for accurate comparison
  const basePlan = planName.replace("_promo", "");
  const standardBudget = DEFAULT_PLANS[basePlan]?.monthlyCreditsIncluded
    ?? DEFAULT_PLANS.business.monthlyCreditsIncluded;

  return {
    isPromoActive,
    promoBudget: isPromoActive ? promoBudget : 0,
    standardBudget,
    promoEndDate: PROMO_END,
  };
}

// ─── AIC Calculator ───────────────────────────────────────────

export class AICCalculator {
  private modelCosts: Map<string, ModelCostRate>;
  private plan: PlanConfig;

  constructor(
    modelCosts: ModelCostRate[] = DEFAULT_MODEL_COSTS,
    plan: PlanConfig = DEFAULT_PLANS.business,
  ) {
    this.modelCosts = new Map();
    for (const mc of modelCosts) {
      this.modelCosts.set(mc.model.toLowerCase(), mc);
    }
    this.plan = plan;
  }

  /** Update plan configuration */
  setPlan(plan: PlanConfig): void {
    this.plan = plan;
  }

  /** Get current plan */
  getPlan(): PlanConfig {
    return this.plan;
  }

  /** Update model costs (merges with existing) */
  updateModelCosts(costs: ModelCostRate[]): void {
    for (const mc of costs) {
      this.modelCosts.set(mc.model.toLowerCase(), mc);
    }
  }

  /** Get all configured model costs */
  getModelCosts(): ModelCostRate[] {
    return Array.from(this.modelCosts.values());
  }

  /**
   * Whether `modelName` is recognised as a GitHub-Copilot-billable model.
   *
   * Used by issue #5 to filter out local Ollama / LM Studio / BYOK models
   * (which VS Code still routes through its chat OTel pipeline but which
   * GitHub does NOT bill in AI Credits) so they don't inflate the dashboard's
   * billable total.
   *
   * A model is considered "known GHC" iff it matches an entry in the rate
   * table (default + any user-supplied `customModelCosts`). The match uses
   * the same normalization as `findModelRate()` so e.g. "claude-opus-4-6"
   * and "claude-opus-4.6" both resolve.
   */
  isKnownGHCModel(modelName: string): boolean {
    return this.findModelRate(modelName) !== null;
  }

  /**
   * Find the best matching cost rate for a model name.
  * Uses one-way substring matching for flexibility with normalization:
   * OTel reports model names with hyphens (e.g., "claude-opus-4-6") while the
   * rate table uses dots (e.g., "claude-opus-4.6"). We normalize version
   * separators before matching.
  *
  * The observed model name may include a suffix or provider namespace around
  * a known rate-table id (for example "gpt-4o-mini-2024-07-18"), but a short
  * observed id must not match a longer rate-table id. Otherwise local/BYOK
  * aliases like "gpt-4" or "claude" are incorrectly treated as GitHub
  * Copilot-billable models.
   */
  findModelRate(modelName: string): ModelCostRate | null {
    const lower = modelName.toLowerCase();

    // Normalize: replace version-number hyphens with dots
    // "claude-opus-4-6" → "claude-opus-4.6", "gpt-4o-mini" stays unchanged
    const normalized = lower.replace(/(\d)-(\d)/g, "$1.$2");

    // Exact match first (try both original and normalized)
    if (this.modelCosts.has(lower)) {
      return this.modelCosts.get(lower)!;
    }
    if (normalized !== lower && this.modelCosts.has(normalized)) {
      return this.modelCosts.get(normalized)!;
    }

    // Substring match: find longest matching key (try both forms)
    let bestMatch: ModelCostRate | null = null;
    let bestLen = 0;
    for (const [key, rate] of this.modelCosts) {
      if ((normalized.includes(key) || lower.includes(key)) && key.length > bestLen) {
        bestMatch = rate;
        bestLen = key.length;
      }
    }

    return bestMatch;
  }

  /**
   * Calculate credits for a single request/turn.
   */
  calculateCredits(
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number = 0,
    cacheWriteTokens: number = 0,
  ): CreditUsage {
    const rate = this.findModelRate(modelName);

    if (!rate) {
      // Unknown model — apply GPT-4.1 rates as conservative default
      const defaultRate: ModelCostRate = {
        model: modelName,
        inputCreditsPerMillion: 200,
        outputCreditsPerMillion: 800,
        cachedInputCreditsPerMillion: 50,
        cacheWriteCreditsPerMillion: 0,
        tier: "base",
      };
      return this._compute(defaultRate, inputTokens, outputTokens, cachedTokens, cacheWriteTokens);
    }

    return this._compute(rate, inputTokens, outputTokens, cachedTokens, cacheWriteTokens);
  }

  private _compute(
    rate: ModelCostRate,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
    cacheWriteTokens: number,
  ): CreditUsage {
    // Net input = total input - cached - cache_write
    // (prompt_tokens from the API includes cached reads AND cache writes)
    const netInput = Math.max(0, inputTokens - cachedTokens - cacheWriteTokens);

    const inputCredits = (netInput / 1_000_000) * rate.inputCreditsPerMillion;
    const outputCredits = (outputTokens / 1_000_000) * rate.outputCreditsPerMillion;
    const cachedCredits = (cachedTokens / 1_000_000) * rate.cachedInputCreditsPerMillion;
    const cacheWriteCredits = (cacheWriteTokens / 1_000_000) * rate.cacheWriteCreditsPerMillion;

    return {
      inputCredits,
      outputCredits,
      cachedCredits,
      totalCredits: inputCredits + outputCredits + cachedCredits + cacheWriteCredits,
      model: rate.model,
      tier: rate.tier,
    };
  }

  /**
   * Compute a full credit summary from session data.
   *
   * Each entry is classified as **billable** or **non-billable** before being
   * accumulated. Headline totals reflect billable usage only; non-billable
   * usage (BYOK / local Ollama / unrecognised models without
   * `copilotUsageNanoAiu`) is surfaced separately under `nonBillable`.
   * See issue #5.
   *
   * An entry is treated as billable when:
   *   • `actualCredits > 0` (GitHub's backend already billed it), OR
   *   • `entry.billable === true` (caller forced it on, e.g. allow-list), OR
   *   • `entry.billable` is undefined AND the model is known to the rate table.
   *
   * The summary is also restricted to the current billing cycle window —
   * previously every entry since the AIC effective date (`2026-06-01`) was
   * counted, which over-reported once a user crossed a cycle boundary or had
   * a non-day-1 cycle start.
   */
  computeSummary(
    entries: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      date: string; // ISO date "YYYY-MM-DD"
      /** If set, use this as the actual credits instead of computing from rates */
      actualCredits?: number;
      /**
       * Caller-supplied billable override. When undefined, the calculator
       * decides via `actualCredits > 0` OR `isKnownGHCModel(model)`.
       */
      billable?: boolean;
    }>,
  ): CreditSummary {
    // Billing-cycle window — entries outside this window are dropped so the
    // dashboard total matches "what GitHub will bill you this cycle" rather
    // than "everything since June 1". (Fix #2 in issue #5.)
    const { start, end, daysRemaining } = this._getBillingCycle();

    const byModel = new Map<string, CreditUsage>();
    const byDay = new Map<string, number>();
    let totalCredits = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;

    // Non-billable bucket (informational only — never sums into headline totals
    // or budget math).
    const nonBillableByModel = new Map<string, CreditUsage>();
    let nonBillableTotal = 0;

    for (const entry of entries) {
      // Cycle-window filter. Empty/"unknown" dates are kept (callers like the
      // agent-session path may pass dates derived from agent metadata).
      const day = entry.date || "unknown";
      if (day !== "unknown" && (day < start || day > end)) {
        continue;
      }

      let usage: CreditUsage;
      if (entry.actualCredits !== undefined && entry.actualCredits > 0) {
        // API-reported actual credits (includes cache discounts) — authoritative total.
        // To preserve a meaningful input/output/cached breakdown for the
        // "AI Credits by Model" table, derive the rate-based split from the
        // entry's tokens and scale each component so the three sum to the
        // exact API-billed total. Without this, the table previously
        // attributed 100% of credits to the Input column and showed
        // Output=0 / Cached=0 for every model whose debug logs carried
        // `copilotUsageNanoAiu` (i.e. essentially every post-June-1 turn).
        const rate = this.findModelRate(entry.model);
        const estimate = rate
          ? this._compute(rate, entry.inputTokens, entry.outputTokens, entry.cachedTokens, 0)
          : null;
        const estTotal = estimate
          ? estimate.inputCredits + estimate.outputCredits + estimate.cachedCredits
          : 0;
        if (estimate && estTotal > 0) {
          const scale = entry.actualCredits / estTotal;
          usage = {
            inputCredits: estimate.inputCredits * scale,
            outputCredits: estimate.outputCredits * scale,
            cachedCredits: estimate.cachedCredits * scale,
            totalCredits: entry.actualCredits,
            model: entry.billable === false ? entry.model : rate?.model ?? entry.model,
            tier: rate?.tier ?? "premium",
          };
        } else {
          // No rate match or zero token counts (e.g. OMP/Pi agent entries
          // that don't supply per-bucket tokens) — fall back to all-input.
          usage = {
            inputCredits: entry.actualCredits,
            outputCredits: 0,
            cachedCredits: 0,
            totalCredits: entry.actualCredits,
            model: entry.billable === false ? entry.model : rate?.model ?? entry.model,
            tier: rate?.tier ?? "premium",
          };
        }
      } else {
        usage = this.calculateCredits(
          entry.model,
          entry.inputTokens,
          entry.outputTokens,
          entry.cachedTokens,
        );
      }

      // Billable classification. Caller's explicit `billable` flag wins —
      // the dashboard knows things the calculator can't (e.g. "this OMP/Pi
      // agent call uses an Ollama model and shouldn't count as billed even
      // though we attached our own rate-derived `actualCredits` to it").
      // When the caller doesn't decide, `actualCredits > 0` (i.e. the value
      // came straight from GitHub's `copilotUsageNanoAiu`) is the next-best
      // positive signal, falling back to "is this a known GHC model?".
      let isBillable: boolean;
      if (entry.billable !== undefined) {
        isBillable = entry.billable;
      } else if (entry.actualCredits !== undefined && entry.actualCredits > 0) {
        isBillable = true;
      } else {
        isBillable = this.isKnownGHCModel(entry.model);
      }

      if (!isBillable) {
        nonBillableTotal += usage.totalCredits;
        const existing = nonBillableByModel.get(usage.model);
        if (existing) {
          existing.inputCredits += usage.inputCredits;
          existing.outputCredits += usage.outputCredits;
          existing.cachedCredits += usage.cachedCredits;
          existing.totalCredits += usage.totalCredits;
        } else {
          nonBillableByModel.set(usage.model, { ...usage });
        }
        continue;
      }

      totalCredits += usage.totalCredits;
      totalInput += usage.inputCredits;
      totalOutput += usage.outputCredits;
      totalCached += usage.cachedCredits;

      // Aggregate by model
      const existing = byModel.get(usage.model);
      if (existing) {
        existing.inputCredits += usage.inputCredits;
        existing.outputCredits += usage.outputCredits;
        existing.cachedCredits += usage.cachedCredits;
        existing.totalCredits += usage.totalCredits;
      } else {
        byModel.set(usage.model, { ...usage });
      }

      // Aggregate by day
      byDay.set(day, (byDay.get(day) ?? 0) + usage.totalCredits);
    }

    // Billing cycle calculations
    const daysElapsed = this._getDaysElapsed(start);
    const dailyAverage = daysElapsed > 0 ? totalCredits / daysElapsed : totalCredits;
    const projectedTotal = dailyAverage * (daysElapsed + daysRemaining);
    const creditsRemaining = this.plan.monthlyCreditsIncluded > 0
      ? Math.max(0, this.plan.monthlyCreditsIncluded - totalCredits)
      : -1;
    const overage = this.plan.monthlyCreditsIncluded > 0
      ? Math.max(0, totalCredits - this.plan.monthlyCreditsIncluded)
      : 0;

    return {
      totalCredits,
      inputCredits: totalInput,
      outputCredits: totalOutput,
      cachedCredits: totalCached,
      byModel,
      byDay,
      nonBillable: {
        totalCredits: nonBillableTotal,
        byModel: nonBillableByModel,
      },
      plan: this.plan,
      creditsRemaining,
      estimatedOverageCost: overage * this.plan.overageCostPerCredit,
      billingCycleStart: start,
      billingCycleEnd: end,
      daysRemaining,
      dailyAverage,
      projectedTotal,
    };
  }

  private _getBillingCycle(): { start: string; end: string; daysRemaining: number } {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const startDay = this.plan.billingCycleStartDay;

    let cycleStart: Date;
    let cycleEnd: Date;

    if (now.getDate() >= startDay) {
      cycleStart = new Date(year, month, startDay);
      cycleEnd = new Date(year, month + 1, startDay - 1);
    } else {
      cycleStart = new Date(year, month - 1, startDay);
      cycleEnd = new Date(year, month, startDay - 1);
    }

    const msRemaining = cycleEnd.getTime() - now.getTime();
    const daysRemaining = Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));

    // Serialize using LOCAL year/month/day, not UTC. The cycle is anchored to
    // the user's local calendar (billingCycleStartDay is a local day-of-month),
    // so converting via toISOString() shifts the date one day earlier for
    // positive UTC offsets (e.g. UTC+05:30 turns local Jun 1 00:00 into UTC
    // May 31 18:30, then slice(0,10) yields "2026-05-31"). See issue #2.
    return {
      start: formatLocalYMD(cycleStart),
      end: formatLocalYMD(cycleEnd),
      daysRemaining,
    };
  }

  private _getDaysElapsed(cycleStart: string): number {
    // Parse YYYY-MM-DD as LOCAL midnight, not UTC midnight. `new Date("YYYY-MM-DD")`
    // is interpreted as UTC per ECMA-262, which skews elapsed-day math by one
    // for users west of UTC and (combined with `now` in local time) by up to
    // a day for users east of UTC.
    const start = parseLocalYMD(cycleStart);
    const now = new Date();
    const elapsed = now.getTime() - start.getTime();
    return Math.max(1, Math.ceil(elapsed / (24 * 60 * 60 * 1000)));
  }
}

// ─── Local-date helpers (timezone-safe) ────────────────────────────────
// These intentionally avoid `toISOString()` so the produced string reflects
// the user's local calendar day. Used for billing-cycle labels, calendar
// headers, and any "today marker" that must match what the user sees on a
// wall clock — never for serializing UTC instants.

function formatLocalYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseLocalYMD(ymd: string): Date {
  // Expect strict "YYYY-MM-DD". Fall back to native parsing for anything else
  // (e.g. full ISO timestamps) so this stays a drop-in replacement.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) { return new Date(ymd); }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// ─── Serialization helpers for VS Code settings ───────────────

export interface AICConfig {
  plan: string;
  billingCycleStartDay: number;
  monthlyCreditsIncluded: number;
  overageCostPerCredit: number;
  customModelCosts: Array<{
    model: string;
    inputCreditsPerMillion: number;
    outputCreditsPerMillion: number;
    cachedInputCreditsPerMillion: number;
    cacheWriteCreditsPerMillion: number;
    tier: "base" | "premium" | "custom";
  }>;
  /**
   * When true (default), only models GitHub bills in AI Credits contribute
   * to the headline total / budget bar / projected spend. Local Ollama /
   * LM Studio / BYOK keys / unrecognised models are still tracked and shown
   * in a separate "non-billable" panel for capacity planning, but excluded
   * from the billed-cost math. See issue #5.
   */
  includeOnlyBilledModels: boolean;
  /**
   * Explicit caller-supplied model substrings to FORCE-EXCLUDE from billable
   * totals (even if they otherwise match the GHC rate table). Useful for
   * marking a particular alias as non-billable.
   */
  excludeModels: string[];
  /**
   * Model substrings to FORCE-INCLUDE as billable even when they don't match
   * the rate table. Escape hatch for new preview models that arrive before
   * the rate table is updated.
   */
  extraBilledModels: string[];
}

export const DEFAULT_AIC_CONFIG: AICConfig = {
  plan: "business",
  billingCycleStartDay: 1,
  monthlyCreditsIncluded: 1900,
  overageCostPerCredit: 0.01,
  customModelCosts: [],
  includeOnlyBilledModels: true,
  excludeModels: [],
  extraBilledModels: [],
};

/**
 * Create an AICCalculator from persisted configuration.
 */
export function createCalculatorFromConfig(config: AICConfig): AICCalculator {
  const planBase = DEFAULT_PLANS[config.plan] ?? DEFAULT_PLANS.business;
  const plan: PlanConfig = {
    ...planBase,
    billingCycleStartDay: config.billingCycleStartDay,
    monthlyCreditsIncluded: config.monthlyCreditsIncluded,
    overageCostPerCredit: config.overageCostPerCredit,
  };

  // Merge default + custom model costs
  const allCosts = [...DEFAULT_MODEL_COSTS];
  if (config.customModelCosts.length > 0) {
    for (const custom of config.customModelCosts) {
      // Replace if exists, otherwise add
      const idx = allCosts.findIndex(c => c.model.toLowerCase() === custom.model.toLowerCase());
      if (idx >= 0) {
        allCosts[idx] = custom;
      } else {
        allCosts.push(custom);
      }
    }
  }

  return new AICCalculator(allCosts, plan);
}

/**
 * Decide whether a single (model, hasActualCredits) pair is billable under
 * the supplied config. Pure function — shared by `dashboardData.ts` and the
 * unit tests so the classification stays in one place.
 *
 * Precedence (highest first):
 *   1. `config.excludeModels`           — substring match → NON-billable, always.
 *   2. `hasActualCredits === true`      — GitHub's backend already billed it → billable.
 *   3. `config.extraBilledModels`       — substring match → billable.
 *   4. `config.includeOnlyBilledModels === false` → everything else billable.
 *   5. Local GitHub model table         — known Copilot model ids are billable.
 *      This intentionally runs before third-party/user-config demotions so
 *      GitHub model names do not appear in the non-billable panel just because
 *      the same id is also registered by a BYOK provider.
 *   6. Online catalog lookup            — if the model id is present in the
 *      authoritative GitHub model catalog (see `modelCatalog.ts`):
 *        • CAPI verdict (source: "capi") is always honoured — GitHub's
 *          per-plan `/models` response is authoritative.
 *        • user-config / BYOK-alias verdict (source: "user-config") is
 *          ONLY honoured when the model is NOT in the local rate table.
 *          Rationale: a user can have `claude-opus-4.7` listed under a
 *          BYOK Anthropic vendor in `chatLanguageModels.json` AND still
 *          have all their dashboard traffic for that id come through
 *          Copilot's billable channel — the alias collision must not
 *          silently demote OMP / Pi / CLI / older OTel rows that lack
 *          an explicit `copilotUsageNanoAiu`. Genuine Ollama / LM Studio
 *          ids (e.g. `ollama/qwen`) are NOT in the rate table, so they
 *          continue to demote correctly.
 *   7. Otherwise NON-billable.
 *
 * The catalog lookup is injected via the optional `catalogLookup` callback
 * to keep this module free of side effects and easy to test — the production
 * wiring in `dashboardData.ts` passes `classifyByCatalog` from
 * `modelCatalog.ts`.
 */
export type CatalogLookup = (
  modelName: string,
) => { billable: boolean; source?: "capi" | "user-config" } | null;

export function classifyModelBillability(
  calculator: AICCalculator,
  config: AICConfig,
  modelName: string,
  hasActualCredits: boolean,
  catalogLookup?: CatalogLookup,
): boolean {
  const lower = (modelName || "").toLowerCase();

  // 1. Explicit exclude wins over everything else (lets the user mark a
  //    particular alias as informational even if the rate table knows it).
  for (const pat of config.excludeModels ?? []) {
    if (pat && lower.includes(pat.toLowerCase())) {
      return false;
    }
  }

  // 2. The strongest positive signal: GitHub's backend already billed it.
  if (hasActualCredits) {
    return true;
  }

  // 3. User-supplied allowlist (preview models not yet in the rate table).
  for (const pat of config.extraBilledModels ?? []) {
    if (pat && lower.includes(pat.toLowerCase())) {
      return true;
    }
  }

  // 4. Master switch off → preserve legacy behaviour (everything counts).
  if (config.includeOnlyBilledModels === false) {
    return true;
  }

  // 5. GitHub/Copilot model names must not land in the non-billable bucket.
  //    Pre-June-1 usage is filtered by date before this function is called;
  //    for in-window rows, known Copilot models are billable unless the user
  //    explicitly excluded them above.
  if (calculator.isKnownGHCModel(modelName)) {
    return true;
  }

  // 6. Authoritative online catalog (CDN manifest + Copilot CAPI /models).
  if (catalogLookup) {
    const hit = catalogLookup(modelName);
    if (hit) {
      // 5a. CAPI verdict is authoritative — GitHub itself told us.
      if (hit.source === "capi") {
        return hit.billable;
      }
      // 5b. user-config / BYOK alias verdict. Only honour a demotion if the
      //     id is genuinely unknown to the rate table; otherwise a Copilot-
      //     billed id (claude-opus-4.7, gpt-5.4, …) the user happens to also
      //     have configured as a BYOK alias would wrongly collapse OMP / Pi
      //     / CLI totals (which carry `hasActualCredits=false` by design).
      return hit.billable;
    }
  }

  // 7. Default: unknown models are informational/non-billable.
  return false;
}

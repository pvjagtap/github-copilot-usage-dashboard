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
 */
export interface CreditSummary {
  /** Total credits consumed */
  totalCredits: number;
  /** Credits from input tokens */
  inputCredits: number;
  /** Credits from output tokens */
  outputCredits: number;
  /** Credits from cached tokens */
  cachedCredits: number;
  /** Per-model breakdown */
  byModel: Map<string, CreditUsage>;
  /** Per-day breakdown */
  byDay: Map<string, number>;
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

// ─── Default Plan Configurations ──────────────────────────────
// Source: https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises
//
// 1 AI credit = $0.01 USD. Credits are pooled per billing entity.
// Promotional period (June 1 – September 1, 2026): Business=3000, Enterprise=7000.

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
  pro_plus: {
    planName: "pro_plus",
    includedPremiumRequests: 1500,
    monthlyCreditsIncluded: 7500, // Copilot Pro+ (individual)
    overageCostPerCredit: 0.01,
    billingCycleStartDay: 1,
  },
  pro: {
    planName: "pro",
    includedPremiumRequests: 300,
    monthlyCreditsIncluded: 1000, // Copilot Pro (individual)
    overageCostPerCredit: 0.01,
    billingCycleStartDay: 1,
  },
  free: {
    planName: "free",
    includedPremiumRequests: 0,
    monthlyCreditsIncluded: 250, // Copilot Free
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
   * Find the best matching cost rate for a model name.
   * Uses substring matching for flexibility (e.g., "claude-opus-4-6" matches "claude-opus-4").
   */
  findModelRate(modelName: string): ModelCostRate | null {
    const lower = modelName.toLowerCase();

    // Exact match first
    if (this.modelCosts.has(lower)) {
      return this.modelCosts.get(lower)!;
    }

    // Substring match: find longest matching key
    let bestMatch: ModelCostRate | null = null;
    let bestLen = 0;
    for (const [key, rate] of this.modelCosts) {
      if (lower.includes(key) && key.length > bestLen) {
        bestMatch = rate;
        bestLen = key.length;
      }
      // Also check if the key includes the input (for short model names)
      if (key.includes(lower) && lower.length > bestLen) {
        bestMatch = rate;
        bestLen = lower.length;
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
      return this._compute(defaultRate, inputTokens, outputTokens, cachedTokens);
    }

    return this._compute(rate, inputTokens, outputTokens, cachedTokens);
  }

  private _compute(
    rate: ModelCostRate,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
  ): CreditUsage {
    // Net input = total input - cached (cached billed at discounted rate)
    const netInput = Math.max(0, inputTokens - cachedTokens);

    const inputCredits = (netInput / 1_000_000) * rate.inputCreditsPerMillion;
    const outputCredits = (outputTokens / 1_000_000) * rate.outputCreditsPerMillion;
    const cachedCredits = (cachedTokens / 1_000_000) * rate.cachedInputCreditsPerMillion;

    return {
      inputCredits,
      outputCredits,
      cachedCredits,
      totalCredits: inputCredits + outputCredits + cachedCredits,
      model: rate.model,
      tier: rate.tier,
    };
  }

  /**
   * Compute a full credit summary from session data.
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
    }>,
  ): CreditSummary {
    const byModel = new Map<string, CreditUsage>();
    const byDay = new Map<string, number>();
    let totalCredits = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;

    for (const entry of entries) {
      let usage: CreditUsage;
      if (entry.actualCredits !== undefined && entry.actualCredits > 0) {
        // Use API-reported actual credits (includes cache discounts)
        usage = {
          inputCredits: entry.actualCredits, // attribute all to "input" for simplicity
          outputCredits: 0,
          cachedCredits: 0,
          totalCredits: entry.actualCredits,
          model: entry.model,
          tier: this.findModelRate(entry.model)?.tier ?? "premium",
        };
      } else {
        usage = this.calculateCredits(
          entry.model,
          entry.inputTokens,
          entry.outputTokens,
          entry.cachedTokens,
        );
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
      const day = entry.date || "unknown";
      byDay.set(day, (byDay.get(day) ?? 0) + usage.totalCredits);
    }

    // Billing cycle calculations
    const { start, end, daysRemaining } = this._getBillingCycle();
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

    return {
      start: cycleStart.toISOString().slice(0, 10),
      end: cycleEnd.toISOString().slice(0, 10),
      daysRemaining,
    };
  }

  private _getDaysElapsed(cycleStart: string): number {
    const start = new Date(cycleStart);
    const now = new Date();
    const elapsed = now.getTime() - start.getTime();
    return Math.max(1, Math.ceil(elapsed / (24 * 60 * 60 * 1000)));
  }
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
}

export const DEFAULT_AIC_CONFIG: AICConfig = {
  plan: "business",
  billingCycleStartDay: 1,
  monthlyCreditsIncluded: 1900,
  overageCostPerCredit: 0.01,
  customModelCosts: [],
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

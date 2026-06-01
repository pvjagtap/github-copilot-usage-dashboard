# AIC Processing Pipeline — How Credits Are Calculated

## Executive Summary

**Credits now use the ACTUAL API-reported `copilotUsageNanoAiu` per LLM request** — the exact value GitHub uses for billing. This includes all cache discounts automatically.

Previous version used generic per-model rates (500 credits/M input) which **over-estimated by ~77%** because it couldn't detect cached tokens (billed at 50/M instead of 500/M).

---

## The Key Insight (from the Debug Log)

Each LLM request in the debug log has a field `copilotUsageNanoAiu` that is the **exact billing amount** from GitHub's API response. Example from one request:

```json
{
  "type": "llm_request",
  "attrs": {
    "model": "claude-opus-4-6",
    "inputTokens": 91679,
    "outputTokens": 923,
    "copilotUsageNanoAiu": 7599150000
  }
}
```

The API also returns detailed token breakdown in `usage.copilot_usage.token_details`:

```json
"token_details": [
  {"batch_size": 1000000, "cost_per_batch": 500000000000, "token_count": 1,     "token_type": "input"},
  {"batch_size": 1000000, "cost_per_batch": 50000000000,  "token_count": 90448, "token_type": "cache_read"},
  {"batch_size": 1000000, "cost_per_batch": 625000000000, "token_count": 1230,  "token_type": "cache_write"},
  {"batch_size": 1000000, "cost_per_batch": 2500000000000,"token_count": 923,   "token_type": "output"}
]
```

**Conversion:** `nanoAiu / 1,000,000,000 = AI Credits`  
`7,599,150,000 / 1e9 = 7.60 AIC`

---

## Official Rates (from `cost_per_batch` / 1e9)

| Token Type | cost_per_batch (nano-AIU/M) | AI Credits per 1M |
|-----------|---------------------------|-------------------|
| input | 500,000,000,000 | **500** |
| cache_read | 50,000,000,000 | **50** (90% discount!) |
| cache_write | 625,000,000,000 | **625** |
| output | 2,500,000,000,000 | **2,500** |

The "500 credits/M" rate is the **full-price input rate**. But in practice, ~98% of tokens in agentic sessions are cache_read (billed at only 50/M).

---

## Data Pipeline (6 Steps)

```
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 1: Discover Source Files                                       │
│  %APPDATA%/Code/User/workspaceStorage/*/chatSessions/*.jsonl         │
│  → 469 files → 460 sessions → 8,071 turns                           │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 2: Debug-Log Enrichment                                        │
│  %APPDATA%/Code/User/.../debug-logs/*/main.jsonl                     │
│                                                                      │
│  For each LLM request, extract:                                      │
│    • inputTokens, outputTokens (raw counts)                          │
│    • copilotUsageNanoAiu (ACTUAL billed credits from GitHub API)      │
│                                                                      │
│  For each session with a debug-log:                                  │
│    a) Match debug turns to chatSession turns by turnIndex            │
│    b) If matched → enrich with debugPromptTokens + debugAicCredits   │
│    c) If NOT matched → create synthetic turn with API AIC            │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 3: AIC Date Filter                                             │
│  KEEP only turns where timestamp >= "2026-06-01"                     │
│  → 67 turns pass (8,004 excluded as pre-AIC)                        │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 4: Credit Source Selection (per turn)                          │
│                                                                      │
│  IF turn.debugAicCredits > 0:                                        │
│    → USE ACTUAL API AIC (includes cache discounts)  ★ PREFERRED      │
│  ELSE:                                                               │
│    → Fallback: compute from rates (upper-bound, no cache info)       │
│    → Formula: (input/1M)×500 + (output/1M)×2500                     │
│                                                                      │
│  Current session: 67/67 turns have actual API data (100% accurate)   │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 5: Aggregation                                                 │
│                                                                      │
│  Sum all per-turn credits → TOTAL CREDITS                            │
│  Compare vs plan budget (business promo = 3,000 credits)             │
│  Overage = max(0, total - budget) × $0.01/credit                     │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 6: Display                                                     │
│                                                                      │
│  If actual API data → green "✓ Actual billing data" badge            │
│  If fallback only  → yellow "⚠️ Upper-bound estimate" warning        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Current Session Breakdown

| Session | Turns | Actual AIC (from API) | Computed (old, without cache) |
|---------|-------|-----------------------|-------------------------------|
| `57943bf2` (earlier) | 10 | **239.39** | ~787 |
| `0dcae974` (current) | 57 | **2,858.60** | ~13,079 |
| **TOTAL** | **67** | **3,097.99** | ~13,867 |

**The difference:** 77% reduction because cache_read tokens are charged at 50/M (not 500/M).

---

## Why The Old Numbers Were Wrong

The previous approach applied `500 credits / 1M tokens` to ALL input tokens. But in agentic sessions:

```
Example: single LLM request with 91,679 input tokens
├── cache_read:  90,448 tokens × 50/M  =  4.52 credits  ← 98.7% of tokens!
├── input (new):      1 token × 500/M  =  0.00 credits
├── cache_write:  1,230 tokens × 625/M =  0.77 credits
└── output:         923 tokens × 2500/M = 2.31 credits
────────────────────────────────────────────────────────
ACTUAL (from API):                          7.60 credits
OLD COMPUTATION (all as input):            46.07 credits  ← 6× too high!
```

The 500/M rate ONLY applies to genuinely new input tokens. Cached tokens (the vast majority in multi-turn conversations) are billed at 50/M — a 10× discount.

---

## Accuracy Source Hierarchy

| Priority | Source | Accuracy | When Used |
|----------|--------|----------|-----------|
| 1 (best) | `copilotUsageNanoAiu` from debug-log | **Exact** — matches GitHub billing | When debug-log has this field |
| 2 (fallback) | Computed from `inputTokens × rate/M` | Upper-bound (ignores cache) | No debug-log or old sessions |

### Verification Command (run anytime):

```bash
cd copilot-usage-extension
node -e "
const {scanWorkspaceStorage} = require('./out/scanner');
const scan = scanWorkspaceStorage();
const turns = scan.turns.filter(t => t.timestamp && t.timestamp.slice(0,10) >= '2026-06-01');
let actual = 0, computed = 0;
for (const t of turns) {
  actual += t.debugAicCredits;
  computed += ((t.debugPromptTokens||t.promptTokens)/1e6)*500 + ((t.debugOutputTokens||t.outputTokens)/1e6)*2500;
}
console.log('Actual (API):', actual.toFixed(2), '| Computed (rates):', computed.toFixed(2));
console.log('Over-estimation if using rates:', ((computed/actual - 1)*100).toFixed(0) + '%');
"
```

---

## Key Insight: debug-log vs chatSession metadata

| Source | What it measures | Accuracy |
|--------|-----------------|----------|
| `debug-log copilotUsageNanoAiu` | Exact billing amount per LLM request (from API response) | **Authoritative** — this IS what GitHub bills |
| `debug-log inputTokens/outputTokens` | Raw token counts per LLM request | Accurate counts, but don't reveal cache breakdown |
| `chatSession.metadata.promptTokens` | Token count from VS Code's response metadata | May lag or miss turns (not flushed) |

---

## Cache Behavior in Agentic Sessions

In multi-turn coding sessions, the prompt cache hit rate is typically **95-99%** because:
1. System prompt (~60K tokens) is always cached
2. Tool definitions (~50K tokens) are always cached  
3. Previous conversation turns are cached
4. Only the new user message + latest tool results are "new" input

This means the effective per-token cost is much closer to **50 credits/M** (cache_read rate) than 500 credits/M (input rate) for the bulk of tokens.

/**
 * Billing — CANONICAL source of truth. CRITICAL: never fork this logic.
 * Imported by both the web app (/src/utils/billing.js) and Cloud Functions
 * (/functions/utils/billing.js).
 *
 * Charge formula for a COMPLETED task:
 *   actual_cost_inr = actual_cost_usd * rate
 *   final_charge    = max( ceil(actual_cost_inr * 2.5), 75 )   // whole rupees
 *
 * Rules:
 *   - Never charge a FAILED task.
 *   - Round UP to whole rupees (no fractional paise; favours the business).
 *   - Minimum charge is ₹75 even if the real cost rounds lower.
 */
import { usdToInr, DEFAULT_USD_TO_INR } from './currency.js';

/** GST rate Anthropic charges Indian customers on top of raw API cost. */
export const ANTHROPIC_GST_RATE = 0.18;

/** Minimum charge for any completed fix (INR). */
export const MIN_CHARGE_INR = 75;
/**
 * Hard ceiling on what a single fix can cost the customer (INR). The bracketed cost-plus
 * price is clamped to this no matter how high COGS runs, so the customer is never surprised
 * by a four-figure bill. Tune here and nowhere else.
 */
export const MAX_CHARGE_INR = 690;
/** Markup multiplier applied to actual API cost. (2× base + 25% = 2.5×) */
export const MARKUP_MULTIPLIER = 2.5;

/**
 * Bracketed cost-plus pricing — the production pricing rule.
 *
 * The customer pays a multiple of actual COGS, with the multiplier decreasing as cost rises
 * (so tiny fixes don't feel rip-off-y and big fixes don't balloon):
 *   - first ₹50 of COGS     → 4.5×
 *   - next ₹50 (50–100)     → 3×
 *   - everything above ₹100 → 2×
 *
 * Worked examples:
 *   ₹10  → ₹45      (10×4.5)
 *   ₹40  → ₹180     (40×4.5)
 *   ₹75  → ₹225 + 25×3 = ₹300
 *   ₹100 → ₹225 + 50×3 = ₹375
 *   ₹200 → ₹375 + 100×2 = ₹575
 *   ₹500 → ₹375 + 400×2 = ₹1175 → clamped to MAX_CHARGE_INR
 *
 * Output is rounded UP to whole rupees (favours business) and clamped to MAX_CHARGE_INR so
 * the customer never sees a runaway bill. No floor — small costs stay small. The hard COGS
 * cap is also enforced separately by the poller (maxBudgetUsd / maxSeconds).
 */
export const PRICING_BRACKETS = [
  { upToInr: 50,        multiplier: 4.5 },
  { upToInr: 100,       multiplier: 3 },
  { upToInr: Infinity,  multiplier: 2 },
];

/** Bracketed price from actual COGS (INR). Rounded UP to whole rupees. */
export function priceFromCostInr(costInr) {
  const c = Math.max(0, Number(costInr) || 0);
  let price = 0;
  let remaining = c;
  let prevCap = 0;
  for (const { upToInr, multiplier } of PRICING_BRACKETS) {
    const slice = Math.min(remaining, upToInr - prevCap);
    if (slice <= 0) break;
    price += slice * multiplier;
    remaining -= slice;
    prevCap = upToInr;
    if (remaining <= 0) break;
  }
  return Math.min(Math.ceil(price), MAX_CHARGE_INR);
}

/** Bracketed price from actual COGS (USD). Inflates by Anthropic GST before converting to INR. */
export function priceFromCostUsd(costUsd, { rate = DEFAULT_USD_TO_INR } = {}) {
  const effectiveUsd = (Number(costUsd) || 0) * (1 + ANTHROPIC_GST_RATE);
  return priceFromCostInr(usdToInr(effectiveUsd, rate));
}

/**
 * Feature planning (breakdown) charge. A "feature" is one larger request the owner makes; a
 * single Sonnet call breaks it into an ordered list of fix-sized steps. UNLIKE a fix — whose
 * price is the bracketed cost-plus on the run's COGS (priceFromCostUsd, applied in
 * finalize.js) — the breakdown is billed at a flat MULTIPLE of its OWN actual cost and debited
 * immediately, the moment the owner breaks the feature down. Each resulting step then runs and
 * is charged exactly like a standalone fix; nothing about the tiers or the fix charge math
 * changes. Re-planning is just a fresh breakdown, charged again the same way.
 */
export const PLANNING_MULTIPLIER = 2;

/**
 * Charge (INR) for one feature breakdown — PLANNING_MULTIPLIER × the planning call's actual
 * COGS. Rounded UP to whole rupees (favours the business). No floor and no cap: planning is
 * cheap, so the charge tracks the real cost closely rather than snapping to a tier.
 */
export function priceForPlanning(costUsd, { rate = DEFAULT_USD_TO_INR } = {}) {
  const effectiveUsd = Math.max(0, Number(costUsd) || 0) * (1 + ANTHROPIC_GST_RATE);
  return Math.ceil(usdToInr(effectiveUsd, rate) * PLANNING_MULTIPLIER);
}

/**
 * Canonical charge for a completed task.
 * @param {number} actualCostUsd  cost reported by the agent run
 * @param {{rate?: number}} [opts]
 * @returns {{actualCostUsd:number, rate:number, actualCostInr:number, rawCharge:number, finalCharge:number, hitFloor:boolean}}
 */
export function computeCharge(actualCostUsd, { rate = DEFAULT_USD_TO_INR, applyFloor = true } = {}) {
  const usd = Number(actualCostUsd) || 0;
  const actualCostInr = usdToInr(usd, rate);
  const rawCharge = actualCostInr * MARKUP_MULTIPLIER;
  const ceilCharge = Math.ceil(rawCharge);
  // The ₹75 minimum applies to normal rounds. Fair revisions pass applyFloor=false.
  const finalCharge = applyFloor ? Math.max(ceilCharge, MIN_CHARGE_INR) : ceilCharge;
  return {
    actualCostUsd: usd,
    rate,
    actualCostInr,
    rawCharge,
    finalCharge,
    hitFloor: applyFloor && finalCharge === MIN_CHARGE_INR && ceilCharge < MIN_CHARGE_INR,
  };
}

/**
 * Highest charge possible for a given hard budget cap. Use this to keep the UI's
 * displayed estimate honest — if you promise "₹75–₹X", set the agent's
 * max_budget_usd so maxChargeForBudget(budget) <= X.
 */
export function maxChargeForBudget(maxBudgetUsd, { rate = DEFAULT_USD_TO_INR } = {}) {
  return computeCharge(maxBudgetUsd, { rate }).finalCharge;
}

/**
 * Estimate range shown to the user before a run. Lower bound is always the floor.
 * @returns {{min:number, max:number}} in INR
 */
export function estimateRange(maxBudgetUsd, { rate = DEFAULT_USD_TO_INR } = {}) {
  return { min: MIN_CHARGE_INR, max: maxChargeForBudget(maxBudgetUsd, { rate }) };
}

/**
 * Complexity tiers — SINGLE SOURCE OF TRUTH for pricing.
 *
 * `priceInr` is the FIXED price the customer pays for a fix of this tier — charged once,
 * on approval, regardless of the run's actual token cost. We (not the buyer) absorb token
 * volatility, spread across volume and re-priced here when needed. A non-technical owner
 * gets one quotable number, not a figure that wiggles with cache hits.
 *
 * `maxBudgetUsd` is the hard spend cap enforced by the poller (Managed Agents have no
 * native cap). It is chosen so our COGS at the cap stays comfortably below `priceInr`:
 *   simple : price ₹149, cap $0.45 (~₹37 COGS)  → ~75% margin at the cap
 *   medium : price ₹375, cap $1.50 (~₹125 COGS) → ~67% margin at the cap
 *   complex: price ₹749, cap $3.00 (~₹249 COGS) → ~67% margin at the cap
 *
 * `maxSeconds` is a SECOND, independent cap: the max active runtime per round. It exists
 * because the dollar cap can't be trusted alone — Anthropic's `session.usage` can report
 * $0 for minutes while the agent actually burns tokens, so the per-poll cost check stays
 * blind and a "simple" run can blow 7× past its budget before the cost finally lands. Active
 * runtime is always reported, so a tight per-tier time cap reliably bounds the worst case.
 * Set with headroom over real completion times (simple ~2m, medium ~4m, complex ~11m seen):
 *   simple : 300s (5m)   medium : 480s (8m)   complex : 900s (15m)
 * `minInr`/`maxInr` are retained for the legacy estimate UI; with fixed pricing the
 * estimate IS `priceInr`.
 *
 * NOTE: these prices are starting hypotheses to validate in the concierge phase, not
 * final — tune them here and nowhere else.
 */
// TEMP (2026-05-30): simple/medium `maxBudgetUsd` DOUBLED (0.45→0.90, 1.50→3.00) as interim
// headroom — after the per-model price fix a real simple Sonnet fix (~$0.63) was already above
// the old $0.45 cap. `maxSeconds` is unchanged (it's the real runaway governor; the $ cap fires
// late due to lazy usage reporting). RECALIBRATE all caps from observed P95 in the AGENT_USAGE
// logs in ~2 days, then drop this note. Complex left as-is.
export const COMPLEXITY_TIERS = {
  simple:  { maxBudgetUsd: 0.90, maxSeconds: 300, priceInr: 149, minInr: 149, maxInr: 149 },
  medium:  { maxBudgetUsd: 3.00, maxSeconds: 480, priceInr: 375, minInr: 375, maxInr: 375 },
  complex: { maxBudgetUsd: 3.00, maxSeconds: 900, priceInr: 749, minInr: 749, maxInr: 749 },
};

/** Resolve a complexity label to its tier, defaulting to `medium` if unknown. */
export function tierFor(complexity) {
  return COMPLEXITY_TIERS[complexity] || COMPLEXITY_TIERS.medium;
}

/**
 * "Plan a feature" pricing — a SEPARATE task type from the fix pipeline. The customer
 * describes a feature, we break it into tasks, and on approval we publish them as cards to
 * the org's task board. There's no agent run and no token volatility here, so it's a single
 * low FLAT price charged once, on a successful publish (never on the free preview, never if
 * publishing fails). Tune here and nowhere else.
 *
 * NOTE: a starting hypothesis to validate in the concierge phase, not final.
 */
export const PLAN_PRICE_INR = 99;

/** The fixed price (INR) a successful "Plan a feature" publish costs the customer. */
export function priceForPlan() {
  return PLAN_PRICE_INR;
}

/** The fixed price (INR) a completed fix of this complexity costs the customer. */
export function priceForComplexity(complexity) {
  return tierFor(complexity).priceInr;
}

/**
 * Free-iteration policy for "Request changes" (approve-before-charge model).
 * The customer pays the flat tier price ONCE, on approval. Getting that one fix right is
 * free — but capped, so it can't be abused — and genuinely NEW scope always pays again.
 *   - `unresolved` (didn't work / not what I meant): FREE, up to MAX_FREE_REVISIONS rounds.
 *   - `new_scope`   (something new): adds another tier price to what's owed.
 */
export const MAX_FREE_REVISIONS = 1;
export const REVISION_REASONS = ['unresolved', 'new_scope'];

/** Is this revision reason a free re-fix (our shortfall) vs new, chargeable scope? */
export function isFreeRevision(reason) {
  return reason === 'unresolved';
}

/**
 * Minimum balance required to START a fix of this complexity — the true maximum
 * we could ever charge for it under the bracketed cost-plus model. Gate on this so
 * we never run work we can't bill.
 */
export function requiredBalanceFor(complexity, opts) {
  // "Plan a feature" is a flat-priced task type with no agent run — its required balance is
  // simply the flat publish price, not a COGS-derived ceiling.
  if (complexity === 'plan') return priceForPlan();
  return priceFromCostUsd(tierFor(complexity).maxBudgetUsd, opts);
}

/**
 * Revision policy. A round has a `kind`:
 *   'initial'    — first request for a problem
 *   'unresolved' — same problem still not fixed (we fell short)
 *   'new_scope'  — a new or expanded request
 *
 * Every round is charged at actual × 2.5. The ₹75 MINIMUM applies to 'initial' and
 * 'new_scope'. A fair revision ('unresolved', our shortfall) is charged at actual × 2.5
 * with NO floor — the customer covers the real cost of the re-fix but isn't hit with
 * the minimum again.
 */
export function appliesFloor(kind) {
  return kind !== 'unresolved';
}

/** Final charge (INR) for a round of the given kind. Server-authoritative. */
export function chargeForRound(actualCostUsd, kind, { rate = DEFAULT_USD_TO_INR } = {}) {
  return computeCharge(actualCostUsd, { rate, applyFloor: appliesFloor(kind) }).finalCharge;
}

/** Can the user START a task? They must hold at least the minimum charge. */
export function canAfford(balanceInr) {
  return (Number(balanceInr) || 0) >= MIN_CHARGE_INR;
}

/** Low-balance threshold (INR) for the dashboard warning banner. */
export const LOW_BALANCE_INR = 500;
export function isLowBalance(balanceInr) {
  return (Number(balanceInr) || 0) < LOW_BALANCE_INR;
}

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

/** Minimum charge for any completed fix (INR). */
export const MIN_CHARGE_INR = 75;
/** Markup multiplier applied to actual API cost. (2× base + 25% = 2.5×) */
export const MARKUP_MULTIPLIER = 2.5;

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
 * Each tier has a price BAND (`minInr`–`maxInr`). The concrete price for one fix is
 * rolled (uniform integer) within that band at task-creation time and persisted on the
 * task, so successive fixes land at different numbers (₹118, ₹163, ₹189…) instead of
 * an obvious flat product fee.
 *
 * The bands replace the prior flat per-tier prices (₹149 / ₹375 / ₹749). Variance
 * narrows as the tier price climbs — a wobble on a ₹140 fix reads as natural usage
 * noise; the same percentage swing on a ₹700 fix would be a jarring ₹200, too
 * noticeable. Bands sit MOSTLY below the prior flat anchor, so the customer most
 * often sees a charge that compares favourably to it:
 *   simple  ₹110–₹170  (avg ~₹140, vs prior ₹149)
 *   medium  ₹320–₹400  (avg ~₹360, vs prior ₹375)
 *   complex ₹630–₹750  (avg ~₹690, vs prior ₹749)
 *
 * `maxBudgetUsd` is the hard spend cap enforced by the poller (Managed Agents have no
 * native cap). It is chosen so our COGS at the cap stays comfortably below the band's
 * floor — even on the lowest roll we still net a positive margin:
 *   simple : floor ₹110, cap $0.45 (~₹37 COGS)  → ~65%+ margin at the worst case
 *   medium : floor ₹320, cap $1.50 (~₹125 COGS) → ~60%+ margin at the worst case
 *   complex: floor ₹630, cap $3.00 (~₹249 COGS) → ~60%+ margin at the worst case
 *
 * `maxSeconds` is a SECOND, independent cap: the max active runtime per round. It exists
 * because the dollar cap can't be trusted alone — Anthropic's `session.usage` can report
 * $0 for minutes while the agent actually burns tokens, so the per-poll cost check stays
 * blind and a "simple" run can blow 7× past its budget before the cost finally lands. Active
 * runtime is always reported, so a tight per-tier time cap reliably bounds the worst case.
 * Set with headroom over real completion times (simple ~2m, medium ~4m, complex ~11m seen):
 *   simple : 300s (5m)   medium : 480s (8m)   complex : 900s (15m)
 *
 * NOTE: these bands are starting hypotheses to validate in the concierge phase, not
 * final — tune them here and nowhere else.
 */
export const COMPLEXITY_TIERS = {
  simple:  { maxBudgetUsd: 0.45, maxSeconds: 300, minInr: 110, maxInr: 170 },
  medium:  { maxBudgetUsd: 1.50, maxSeconds: 480, minInr: 320, maxInr: 400 },
  complex: { maxBudgetUsd: 3.00, maxSeconds: 900, minInr: 630, maxInr: 750 },
};

/** Resolve a complexity label to its tier, defaulting to `medium` if unknown. */
export function tierFor(complexity) {
  return COMPLEXITY_TIERS[complexity] || COMPLEXITY_TIERS.medium;
}

/**
 * Roll a concrete price (INR, whole rupees) within the tier's band — uniform integer
 * in [minInr, maxInr] inclusive. Call ONCE per task at creation and persist the result
 * on the task; never call this twice for the same fix or the displayed and charged
 * amounts will drift.
 */
export function randomPriceInr(complexity) {
  const tier = tierFor(complexity);
  const min = Math.round(Number(tier.minInr) || 0);
  const max = Math.round(Number(tier.maxInr) || min);
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Back-compat alias for callers that just want a price for a complexity. Returns a
 * fresh random roll — prefer `randomPriceInr` at call sites for clarity.
 */
export function priceForComplexity(complexity) {
  return randomPriceInr(complexity);
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
 * we could ever charge for it. Gate on this so we never run work we can't bill.
 * Under banded pricing this is `tier.maxInr` (the worst case the dice can roll).
 */
export function requiredBalanceFor(complexity) {
  return Math.round(Number(tierFor(complexity).maxInr) || MIN_CHARGE_INR);
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
export const LOW_BALANCE_INR = 200;
export function isLowBalance(balanceInr) {
  return (Number(balanceInr) || 0) < LOW_BALANCE_INR;
}

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
 * Per-step charge ceiling for a "plan a feature" BUILD step (INR). A feature is built as one
 * warm managed-agent session in which each step is billed on its OWN incremental COGS — capped
 * here per step, and by FEATURE_BUILD_CAP_INR across the whole feature. Follow-up "added"
 * changes (after the feature is complete) still bill the bracketed cost-plus with this per-step
 * cap. Set just under the standalone-fix MAX_CHARGE_INR.
 */
export const MAX_FEATURE_STEP_CHARGE_INR = 600;

/**
 * Feature build pricing (2026-07-06, replacing per-step brackets for PLANNED steps): each build
 * step is a FLAT multiple of its own incremental COGS — simpler to explain than brackets and a
 * genuine price cut on the multi-step totals customers were complaining about — clamped per step
 * (MAX_FEATURE_STEP_CHARGE_INR) and by a hard PER-FEATURE ceiling across all planned build steps.
 * 3× ⇒ 66.7% gross margin uncapped; the customer promise is "building the plan never costs more
 * than FEATURE_BUILD_CAP_INR".
 *
 * The cap covers the ORIGINAL plan's build steps only: the planning charge (priceForPlanning)
 * and post-completion "added" changes are new scope and bill outside it. The cap is safe against
 * runaways because per-step maxBudgetUsd bounds a 5-step batch's worst-case COGS at ~₹1,590 —
 * essentially break-even at the cap, never a deep loss. Tune both here and nowhere else.
 */
export const FEATURE_STEP_MULTIPLIER = 3;
export const FEATURE_BUILD_CAP_INR = 1599;

/**
 * Charge (INR) for one PLANNED feature build step: FEATURE_STEP_MULTIPLIER × the step's own
 * incremental COGS (inflated by Anthropic GST), rounded UP, clamped per-step, then clamped to
 * the feature's remaining headroom under FEATURE_BUILD_CAP_INR (`billedSoFarInr` = what the
 * feature's earlier build steps already charged). Once the feature hits the cap, later steps
 * charge ₹0. The caller must consume headroom (billedSoFarInr += result) in the SAME Firestore
 * transaction that fixes the price, so concurrent steps can't both see full headroom.
 */
export function priceForFeatureStep(costUsd, { rate = DEFAULT_USD_TO_INR, billedSoFarInr = 0 } = {}) {
  const effectiveUsd = Math.max(0, Number(costUsd) || 0) * (1 + ANTHROPIC_GST_RATE);
  const raw = Math.ceil(usdToInr(effectiveUsd, rate) * FEATURE_STEP_MULTIPLIER);
  const perStep = Math.min(raw, MAX_FEATURE_STEP_CHARGE_INR);
  const headroom = Math.max(0, FEATURE_BUILD_CAP_INR - Math.max(0, Number(billedSoFarInr) || 0));
  return Math.min(perStep, headroom);
}

/**
 * Safety valve: the most build steps one warm session will run before the build hands off to a
 * fresh continuation session. Bounds a single session's length (and the quality drift that comes
 * with very long unattended sessions). Features with more steps build across ceil(n/valve) sessions,
 * each continuing on the same feature branch. Tune here; lower it if telemetry shows late-step drift.
 */
export const FEATURE_MAX_STEPS_PER_SESSION = 5;

/**
 * Bracketed cost-plus pricing — the production pricing rule.
 *
 * The customer pays a multiple of actual COGS, with the multiplier decreasing as cost rises
 * (so tiny fixes don't feel rip-off-y and big fixes don't balloon). The curve is deliberately
 * flatter at the low end than a pure cost-plus so a small change never feels steep, and it
 * earns back gradually as COGS climbs:
 *   - first ₹50 of COGS     → 3.5×
 *   - next ₹50 (50–100)     → 4×
 *   - everything above ₹100 → 3×
 *
 * Worked examples:
 *   ₹10  → ₹35      (10×3.5)
 *   ₹40  → ₹140     (40×3.5)
 *   ₹75  → ₹175 + 25×4 = ₹275
 *   ₹100 → ₹175 + 50×4 = ₹375
 *   ₹200 → ₹375 + 100×3 = ₹675
 *   ₹500 → ₹375 + 400×3 = ₹1575 → clamped to MAX_CHARGE_INR
 *
 * Output is rounded UP to whole rupees (favours business) and clamped to MAX_CHARGE_INR so
 * the customer never sees a runaway bill. No floor — small costs stay small. The hard COGS
 * cap is also enforced separately by the poller (maxBudgetUsd / maxSeconds).
 */
export const PRICING_BRACKETS = [
  { upToInr: 50,        multiplier: 3.5 },
  { upToInr: 100,       multiplier: 4 },
  { upToInr: Infinity,  multiplier: 3 },
];

/**
 * Bracketed price from actual COGS (INR). Rounded UP to whole rupees, clamped to `capInr`
 * (defaults to the standalone-fix MAX_CHARGE_INR; feature build steps pass MAX_FEATURE_STEP_CHARGE_INR).
 */
export function priceFromCostInr(costInr, { capInr = MAX_CHARGE_INR } = {}) {
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
  return Math.min(Math.ceil(price), capInr);
}

/**
 * Bracketed price from actual COGS (USD). Inflates by Anthropic GST before converting to INR.
 * `capInr` clamps the result (default MAX_CHARGE_INR; feature build steps pass MAX_FEATURE_STEP_CHARGE_INR).
 */
export function priceFromCostUsd(costUsd, { rate = DEFAULT_USD_TO_INR, capInr = MAX_CHARGE_INR } = {}) {
  const effectiveUsd = (Number(costUsd) || 0) * (1 + ANTHROPIC_GST_RATE);
  return priceFromCostInr(usdToInr(effectiveUsd, rate), { capInr });
}

/**
 * CI / deploy infrastructure cost (Firebase-hosted repos only). Such repos build + deploy
 * through their own GitHub Action on every test-site deploy. We meter this PER ACTUAL RUN —
 * each auto-preview, manual preview, undo, merge-to-testing, and go-live debits the org at COST
 * (no markup, no GST — it's flat infra, not effort) the moment the run is triggered. Vercel
 * repos deploy via Vercel's own Git integration and are NOT charged this.
 */
export const CI_COST_USD_PER_RUN = 0.10;

/** Cost (INR) of one CI/deploy run — at cost, rounded up to whole rupees. */
export function ciRunInr({ rate = DEFAULT_USD_TO_INR, runs = 1 } = {}) {
  return Math.ceil(usdToInr(CI_COST_USD_PER_RUN * runs, rate));
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
 * "Design a screen" phase pricing. The FIRST mock is the priced deliverable (a complete, on-brand
 * screen the owner approves), so it carries a high markup; a REFINE ("Ask for changes") is cheap
 * iteration, charged a small multiple of its own incremental cost so owners can tweak freely.
 * Both are a flat multiple of actual COGS (inflated by Anthropic GST), rounded UP to whole rupees,
 * no floor/cap. Tune the multipliers here and nowhere else.
 *   initial: DESIGN_INITIAL_MULTIPLIER × COGS  (≈ ₹384 for a ~$0.63 design)
 *   refine : DESIGN_REFINE_MULTIPLIER  × COGS
 */
export const DESIGN_INITIAL_MULTIPLIER = 5.5;
export const DESIGN_REFINE_MULTIPLIER = 2;
export function priceForDesign(costUsd, { rate = DEFAULT_USD_TO_INR, isRefine = false } = {}) {
  const effectiveUsd = Math.max(0, Number(costUsd) || 0) * (1 + ANTHROPIC_GST_RATE);
  const mult = isRefine ? DESIGN_REFINE_MULTIPLIER : DESIGN_INITIAL_MULTIPLIER;
  return Math.ceil(usdToInr(effectiveUsd, rate) * mult);
}

/**
 * "Size up the competition" phase pricing. A comparison is a research deliverable: the agent reads
 * the owner's own site (code-aware) and the competitors, then writes a two-sided scorecard + scoped
 * actions. Like design/planning it's billed a flat multiple of its OWN actual COGS (inflated by
 * Anthropic GST), charged when the report is ready. The FIRST report carries the higher markup; a
 * "look again" refine is cheap iteration on its incremental cost. No floor/cap — it's a cheap call.
 * Tune the multipliers here and nowhere else.
 */
export const COMPARE_INITIAL_MULTIPLIER = 3.5;
export const COMPARE_REFINE_MULTIPLIER = 1.5;
export function priceForCompare(costUsd, { rate = DEFAULT_USD_TO_INR, isRefine = false } = {}) {
  const effectiveUsd = Math.max(0, Number(costUsd) || 0) * (1 + ANTHROPIC_GST_RATE);
  const mult = isRefine ? COMPARE_REFINE_MULTIPLIER : COMPARE_INITIAL_MULTIPLIER;
  return Math.ceil(usdToInr(effectiveUsd, rate) * mult);
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

/**
 * Sourced-listing relay pricing — a SEPARATE metered lane from the fix/feature pipelines. A
 * scheduled job (runSourcingJobs) fetches property listings via Apify, relays each NEW one to the
 * customer org's webhook, and bills the org wallet a small per-listing fee. There's no agent run
 * and no token COGS — the only cost is the Apify fetch — so this does NOT go through the cost-plus
 * brackets, the complexity tiers, or finalize.js. Money is charged on successful (2xx) relay of a
 * UNIQUE listing (deduped forever), never on raw SERP count.
 *
 * COST-PLUS with a fixed target margin (repriced 2026-07-08 from MEASURED Apify COGS). The
 * per-listing price = our real per-listing cost baseline + a fixed net margin, with a small random
 * jitter so the debit still reads like a real variable cost. Measured COGS: Apify Google-SERP
 * ~₹0.05–0.10/listing; optional Facebook-post enrichment ~₹0.47/enriched post. The baseline covers
 * SERP + one enrichment, so the ₹1.90 net margin holds even for ENRICHED leads (and runs higher on
 * the many that are never enriched). Tune the baseline / margin / jitter here and nowhere else.
 */
export const SOURCED_COST_BASELINE_INR = 0.55; // measured Apify VARIABLE cost/property (SERP ~0.08 + FB enrichment ~0.47)
export const SOURCED_TARGET_MARGIN_INR = 1.40; // margin over the variable cost. NOTE: the $29/mo Apify base is a
                                               // SEPARATE fixed cost (covers ~4,600 enriched props/mo) — not in here.
export const SOURCED_PRICE_JITTER_INR = 0.15;  // ± random spread around (baseline + margin)
export const SOURCED_UNIT_MIN_INR = SOURCED_COST_BASELINE_INR + SOURCED_TARGET_MARGIN_INR - SOURCED_PRICE_JITTER_INR; // ₹1.80
export const SOURCED_UNIT_MAX_INR = SOURCED_COST_BASELINE_INR + SOURCED_TARGET_MARGIN_INR + SOURCED_PRICE_JITTER_INR; // ₹2.10

/**
 * One listing's price: uniform in [MIN, MAX] with 2-decimal (paise) precision. `rng` is injectable
 * so tests are deterministic; production passes the default Math.random.
 */
export function randomSourcedUnitPrice(rng = Math.random) {
  const span = SOURCED_UNIT_MAX_INR - SOURCED_UNIT_MIN_INR;
  const v = SOURCED_UNIT_MIN_INR + (typeof rng === 'function' ? rng() : Math.random()) * span;
  return Math.round(v * 100) / 100;
}

/**
 * Charge (INR) for a batch of `uniqueCount` successfully-relayed listings: the sum of N independent
 * random draws, rounded UP to whole rupees (the wallet is whole-rupee; rounding up favours the
 * business). Returns `{ amountInr, unitPrices }` so the ledger can record the per-listing detail
 * (keeps the "variable cost" auditable, not just the total).
 */
export function priceForSourcedBatch(uniqueCount, { rng = Math.random } = {}) {
  const n = Math.max(0, Math.floor(Number(uniqueCount) || 0));
  const unitPrices = Array.from({ length: n }, () => randomSourcedUnitPrice(rng));
  const amountInr = Math.ceil(unitPrices.reduce((a, p) => a + p, 0));
  return { amountInr, unitPrices };
}

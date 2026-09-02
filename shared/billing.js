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

// ── OUTPUT GST (the tax we charge customers on OUR invoices) ──────────────────
// Distinct from ANTHROPIC_GST_RATE (an input cost). Applied when a wallet top-up is
// invoiced: a prepaid WEBSITE SOFTWARE PRODUCT (credits) @ 18% GST.
// GST is EXCLUSIVE (added on top of the wallet-credit amount): a top-up crediting ₹X
// to the wallet is invoiced ₹X taxable + 18% GST, so the customer pays ₹X×1.18. B2B
// customers reclaim the GST via input-tax credit, so the add-on is net-neutral to them.
//
// SERVICE, under a SAC (not HSN goods). Electronically-delivered software is a SUPPLY OF
// SERVICE under GST — CGST Act Schedule II 5(d), and TCS v. State of AP (2004) (software is
// "goods" only on physical media). So we bill SAC 998315 (SaaS / hosting & IT-infrastructure
// / platform access), framing the supply as prepaid access to an AUTOMATED platform rather
// than bespoke IT consultancy. GST 18%.
//   NOTE — income tax is INDEPENDENT of the SAC label: the business can still file presumptive
//   Sec 44AD (~6% of digital turnover, since receipts are ~all digital) rather than the
//   professional 44ADA (50%), because 44AD/44ADA turns on the SUBSTANCE (a productised,
//   automated, self-serve platform = business, not a proprietor's personal professional hours).
//   The SAC on the invoice does not force 44ADA. Keep the ITR-4 nature-of-business code on the
//   business side (14004/14005), NOT "software consultancy" (14002). (Analysis 2026-07-11.)
export const OUTPUT_GST_RATE = 0.18;
export const INVOICE_SAC_CODE = '998315'; // SaaS / platform access (service, not HSN goods)

// Platform fee charged ON TOP of a wallet top-up: the customer pays the credit + this fee, but
// only the credit lands in the wallet (the fee is platform revenue). It's a taxable supply on the
// SAME invoice as the credit, so GST is computed ONCE on the combined (credit + fee) taxable base.
export const PLATFORM_FEE_RATE = 0.10;
export function platformFeeInr(creditInr) {
  return Math.round(Number(creditInr || 0) * PLATFORM_FEE_RATE);
}

/**
 * Split a taxable amount (INR) into GST components for a tax invoice. Intra-state (supplier
 * and buyer in the same state) → CGST + SGST, half the rate each; inter-state → IGST at the
 * full rate. Amounts are rounded to 2 decimals (paise); CGST+SGST are forced to sum to the
 * total tax exactly so rounding never drifts. `total` = taxable + tax.
 */
export function gstBreakdown(taxableInr, { intraState = true, rate = OUTPUT_GST_RATE } = {}) {
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const taxable = round2(taxableInr);
  const tax = round2(taxable * rate);
  let cgst = 0, sgst = 0, igst = 0;
  if (intraState) {
    cgst = round2(taxable * (rate / 2));
    sgst = round2(tax - cgst); // absorb any rounding remainder into SGST so cgst+sgst === tax
  } else {
    igst = tax;
  }
  return { taxable, rate, cgst, sgst, igst, tax, total: round2(taxable + tax) };
}

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
 * Cost-plus pricing — the production pricing rule.
 *
 * FLAT 3× on actual COGS (owner decision 2026-07-16: the markup must never exceed 3× on
 * anything — the earlier 3.5×/4× low-end brackets are retired). The bracket MACHINERY is kept
 * so a curve can come back by adding rows, but with one row it degenerates to a flat multiple.
 *
 * Worked examples:
 *   ₹10  → ₹30
 *   ₹100 → ₹300
 *   ₹200 → ₹600
 *   ₹300 → ₹900 → clamped to MAX_CHARGE_INR
 *
 * Output is rounded UP to whole rupees (favours business) and clamped to MAX_CHARGE_INR so
 * the customer never sees a runaway bill. No floor — small costs stay small. The hard COGS
 * cap is also enforced separately by the poller (maxBudgetUsd / maxSeconds).
 */
export const PRICING_BRACKETS = [
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
 * "Chat & build" pricing (the assistant tab). ONE warm session clarifies with the owner — asking for
 * a screenshot / page link / Jam recording / Figma link so it never explores blind — then, once the
 * owner approves, builds the change and opens a PR in the SAME session. The whole session is one
 * deliverable, so there is ONE charge at build completion, on the session's TOTAL actual COGS (the
 * clarify turns are part of that cost, by design). No per-turn charge: clarify + optional preview are
 * never billed on their own, and a chat the owner abandons before approving a build is never charged.
 *
 * Pricing uses the SAME slabbed cost-plus brackets as a fix / added feature-step (PRICING_BRACKETS —
 * 3.5× the first ₹50, 4× the next ₹50, 3× above), NOT a flat multiple — just clamped to a higher
 * ceiling (CHATBOT_BUDGET_INR, since a chat can build a bigger change than a one-off fix).
 *
 * Two budget rails, both against the customer CHARGE:
 *   - CHATBOT_BUDGET_INR (hard)  the charge ceiling; the poller terminates the session on the COGS
 *                                that reaches it (see chatChargeEstimateInr().hardHit), so a run can
 *                                never bill past it.
 *   - CHATBOT_SOFT_INR   (soft)  once the running charge estimate crosses this, the handler stops
 *                                accepting new owner turns (headroom left to finish the build).
 * Tune the rails here and nowhere else; the slab curve is PRICING_BRACKETS.
 */
export const CHATBOT_BUDGET_INR = 1500;
export const CHATBOT_SOFT_INR = 1300;
export function priceForChat(costUsd, { rate = DEFAULT_USD_TO_INR } = {}) {
  return priceFromCostUsd(costUsd, { rate, capInr: CHATBOT_BUDGET_INR });
}

/**
 * Running CHARGE estimate for an in-flight chat, used only for the soft/hard rails (not billed).
 * Same slabbed brackets as priceForChat, but reports the UNCAPPED figure too so callers can tell
 * "at the soft rail" (stop new turns) and "at the hard cap" (terminate the session) apart.
 */
export function chatChargeEstimateInr(costUsd, { rate = DEFAULT_USD_TO_INR } = {}) {
  const raw = priceFromCostUsd(costUsd, { rate, capInr: Infinity });
  return { raw, capped: Math.min(raw, CHATBOT_BUDGET_INR), softHit: raw >= CHATBOT_SOFT_INR, hardHit: raw >= CHATBOT_BUDGET_INR };
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
 *   simple : 300s (5m)   medium : 600s (10m)   complex : 900s (15m)
 * (medium bumped 480→600s on 2026-07-11: a real medium fix was killed at 8m09s — 9s from done —
 *  and booked as a total loss. The $ budget cap ($3) stays the runaway governor; an outlier that
 *  runs long is margin-positive to finish, and if it still fails reconcileFailedCosts books it right.)
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
  medium:  { maxBudgetUsd: 3.00, maxSeconds: 600, priceInr: 375, minInr: 375, maxInr: 375 },
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
 * SERP + one enrichment, so the ₹1.82 net margin holds even for ENRICHED leads (and runs higher on
 * the many that are never enriched). Tune the baseline / margin / jitter here and nowhere else.
 */
// Per-property Gemini cost: the sourcing pipeline spends a Gemini call or two on each property (the
// bilingual query builder — utils/queryGen.js, still flash-lite — plus the relevance/extraction gate,
// utils/classifyListing.js). ~2 paise/property of real COGS + 18% India GST (≈2.36 paise) rounded up
// to a clean 3 paise. Folded into the variable cost and PASSED ON AT COST: the baseline flows 1:1 into
// the price, so the customer pays this flat 3 paise with no markup on it.
//
// REPRICED 2026-07-16 (owner-approved): classifyListing moved from flash-lite to gemini-2.5-flash,
// because flash-lite was reading "Flat 15% OFF" in a truncated SERP snippet as propertyType "Flat" at
// confidence 1.0 and relaying saree ads as property leads (measured 4/5 and 5/5 on the real snippets
// of prod SP-001519/SP-001520; flash rejects 5/5, and a genuine 2BHK still passes). The gate only ever
// sees the ~145-char Google snippet, so it needs the better model; queryGen stays on flash-lite.
// Flash classify (~3.7 paise, GST-incl.) + flash-lite queryGen (~1 paise) ≈ 5 paise, measured against
// the real prompt sizes. Still PASSED ON AT COST — this 2-paise rise flows 1:1 into the price.
export const SOURCED_GEMINI_COST_INR = 0.05;   // 5 paise/property (flash classify + flash-lite queryGen, GST-incl.)
export const SOURCED_COST_BASELINE_INR = 0.55 + SOURCED_GEMINI_COST_INR; // measured VARIABLE cost/property: Apify (SERP ~0.08 + FB enrichment ~0.47) + Gemini (GST-incl.)
export const SOURCED_TARGET_MARGIN_INR = 2.04; // margin over the variable cost — centres each lead at ₹2.64 (repriced
                                               // 2026-07-15: the vet-before-enrich + batch-enrichment optimisation cut
                                               // the org's own Apify bill to ~₹0.9–1.1/lead, so the org's ALL-IN cost
                                               // (Bosun charge + their Apify) lands ≈₹3.5/lead). NOTE: the $29/mo Apify
                                               // base is a SEPARATE fixed cost (covers ~4,600 enriched props/mo) — not
                                               // in here.
                                               // 2026-07-16 (owner-approved): +12 paise here, on top of the +2 paise the
                                               // flash-classify cost passes through above = +14 paise on the lead price
                                               // (₹2.50 → ₹2.64 centre). Split deliberately: the 2 paise is real COGS and
                                               // rides the at-cost baseline, the 12 paise is margin. Folding all 14 into
                                               // SOURCED_GEMINI_COST_INR would have overstated a MEASURED cost and broken
                                               // the "baseline = measured variable cost" contract this file rests on.
                                               // Still FLAT — one price for every lead, no tiers. See CLAUDE.md money rules.
export const SOURCED_PRICE_JITTER_INR = 0.10;  // ± random spread around (baseline + margin) → ₹2.54–₹2.74
export const SOURCED_UNIT_MIN_INR = SOURCED_COST_BASELINE_INR + SOURCED_TARGET_MARGIN_INR - SOURCED_PRICE_JITTER_INR; // ₹2.54
export const SOURCED_UNIT_MAX_INR = SOURCED_COST_BASELINE_INR + SOURCED_TARGET_MARGIN_INR + SOURCED_PRICE_JITTER_INR; // ₹2.74

/**
 * One listing's price: uniform in [MIN, MAX] with 2-decimal (paise) precision. `rng` is injectable
 * so tests are deterministic; production passes the default Math.random.
 */
export function randomSourcedUnitPrice(rng = Math.random) {
  const span = SOURCED_UNIT_MAX_INR - SOURCED_UNIT_MIN_INR;
  const v = SOURCED_UNIT_MIN_INR + (typeof rng === 'function' ? rng() : Math.random()) * span;
  return Math.round(v * 100) / 100;
}

// A BUYER lead's flat unit price — set by the owner on 2026-09-01, when the group lane made buyer
// leads a real product. Priced apart from the seller band on purpose: a seller lead is one of ~360
// a day and ₹2.64 covers it, but a buyer lead is scarce demand (~10/day) whose lane costs Bosun its
// own Gemini classify spend — at the seller price the lane ran at break-even for Bosun. FLAT, no
// jitter: the seller band's jitter exists to read as variable cost across hundreds of rows; a
// deliberate premium price should look deliberate.
//
// RAISED to ₹12.40 on 2026-09-03, once the group lane had run long enough to price. Its measured
// COGS per relayed buyer lead — the ONLY lane the demand cron now runs — is ₹10.53 over every group
// run to date and ₹14.92 across the scheduled ticks alone: 35-50 feed posts at $2.60/1,000
// (apify~facebook-groups-scraper, billed per post, ~84% of the total) plus ~25-34 Gemini classify
// calls at ~7 paise, converted at the live config/fxRate (₹95/USD). ₹5.20 was set against the
// by-product harvest, which rode a supply run that had already paid for the fetch; a lane that
// reads group feeds on purpose pays for every post it looks at, so the old price billed roughly
// half of cost. Unlike the fix pipeline this lane has no cost-plus machinery — the unit price IS
// the whole pricing model — so a rate change is this constant, and only this constant.
export const SOURCED_BUYER_UNIT_INR = 12.4;

/**
 * Charge (INR) for a batch of successfully-relayed listings: `buyerCount` of them at the flat
 * SOURCED_BUYER_UNIT_INR, the rest as independent random draws from the seller band; summed, then
 * rounded UP ONCE to whole rupees (the wallet is whole-rupee; rounding up favours the business).
 * Returns `{ amountInr, unitPrices }` so the ledger can record the per-listing detail (keeps the
 * "variable cost" auditable, not just the total) — buyer units listed first, matching nothing but
 * the count (the ledger stores no per-lead identity at this level).
 */
export function priceForSourcedBatch(uniqueCount, { rng = Math.random, buyerCount = 0 } = {}) {
  const n = Math.max(0, Math.floor(Number(uniqueCount) || 0));
  const b = Math.min(n, Math.max(0, Math.floor(Number(buyerCount) || 0)));
  const unitPrices = [
    ...Array.from({ length: b }, () => SOURCED_BUYER_UNIT_INR),
    ...Array.from({ length: n - b }, () => randomSourcedUnitPrice(rng)),
  ];
  const amountInr = Math.ceil(unitPrices.reduce((a, p) => a + p, 0));
  return { amountInr, unitPrices };
}

/**
 * ── Self-post message composition ───────────────────────────────────────────────────────────────
 *
 * A SEPARATE metered service from the sourced-lead relay above: MaadiVeedu calls us to compose the
 * WhatsApp message an admin sends a property owner (Gemini writes it in the owner's own language,
 * quoting their own post and the exact fields still missing). The relay price is untouched by this —
 * see `priceForSourcedBatch`. Charged per COMPOSE, so a 2nd/3rd nudge (different wording) bills again.
 *
 * WHY PAISE, NOT RUPEES: the wallet is whole-rupee everywhere (`priceForSourcedBatch` ceils a batch,
 * `adminDeductCredits` rounds). Ceiling ₹0.25 per compose would bill ₹1 — a 4× overcharge. So the
 * price is held in paise and accrued on the org; whole rupees are debited as the accrual crosses ₹1
 * and the remainder carries forward. Same "sum, then round once" discipline the batch price uses,
 * applied across time instead of across a batch. Nothing is lost and nothing is over-billed.
 */
export const SELFPOST_COMPOSE_PRICE_PAISE = 25; // ₹0.25 per composed message

/**
 * Fold one compose into an org's running paise accrual.
 *
 * Returns `{ debitInr, accrualPaise }` — the whole rupees to debit NOW (0 for 3 of every 4 composes)
 * and the remainder to store back. Caller MUST persist `accrualPaise` in the same transaction as the
 * debit, or the carry is lost and the customer is under- or over-billed.
 *
 *   accrual 0   + 25 → debit ₹0, carry 25
 *   accrual 75  + 25 → debit ₹1, carry 0
 *   accrual 90  + 25 → debit ₹1, carry 15
 */
export function accrueComposeCharge(currentAccrualPaise = 0, pricePaise = SELFPOST_COMPOSE_PRICE_PAISE) {
  const total = Math.max(0, Math.round(Number(currentAccrualPaise) || 0)) + Math.max(0, Math.round(Number(pricePaise) || 0));
  const debitInr = Math.floor(total / 100);
  return { debitInr, accrualPaise: total % 100 };
}

/**
 * ── Auto-post usage (sourcing self-serve) ───────────────────────────────────────────────────────
 * The customer's platform auto-publishes a sourced listing end-to-end (Bosun sourced it, classified
 * it, and its agent identity posts it) with zero admin minutes — and reports one usage EVENT per
 * published listing to the usageMeter endpoint. The event carries no price by design: this constant
 * is the single place the rate lives. Priced per successful post only — evaluations, skips and
 * owner-tap guest publishes are never events.
 *
 * Same paise-accrual discipline as compose (see WHY PAISE above): held on the org as
 * `autopostAccrualPaise`, whole rupees debited as the accrual crosses ₹1 via `accrueComposeCharge`
 * (the accrual math is price-agnostic — pass this price in).
 */
export const AUTOPOST_USAGE_PRICE_PAISE = 50; // ₹0.50 per auto-posted listing

/**
 * ── WhatsApp outreach (metered via usageMeter) ─────────────────────────────────────────────────
 * The customer's platform runs the outreach bot AND bears the channel's hard costs directly — the
 * WABA sits on their Gupshup wallet (Meta delivery fees) and reply composition runs on their
 * Vertex billing. Bosun's fee is therefore a FLAT per-message service charge, one price for every
 * outbound message (first-contact template, bot replies, alerts alike). Repriced 2026-08-02 from
 * the original ₹1.65/msg + ₹3/accepted model, which assumed Bosun would own the WABA and bear
 * Meta's costs — it doesn't, so the accepted-posting success fee is gone and the per-message rate
 * reflects pure service margin. Events reported via usageMeter, durable + idempotent on their side
 * (whatsapp_meter_log) and on ours (usage_meter_log). Accrued on the org as `waAccrualPaise`.
 */
export const WA_MESSAGE_DELIVERED_PRICE_PAISE = 25; // ₹0.25 flat per outbound WhatsApp message

/**
 * ── Nightly admin work-queue planner (daily_plan) ──────────────────────────────────────────────
 * FLAT per plan-day (operator decision 2026-07-18: flat beats per-task — the task count is
 * generated by the planner itself, so metering per task invites disputes; the meter event still
 * carries taskCount for reporting). One event per org per IST date, idempotencyKey = dateKey,
 * settled directly by planDailyTasks on the platform's ingest ack (registered in usageMeter too so
 * a ledger replay/backfill prices identically). Accrued on the org as `plannerAccrualPaise`.
 *
 * PRICED AT ₹200/plan-day (operator decision 2026-08-05, ending the ₹10 adoption hold set
 * 2026-08-03): the feature set is complete (demand-first ranking, 40-task floor, inline call card,
 * owner scoreboard), so the line is billed at its worth rather than at a token rate. ₹200/day is
 * where the per-seat candidate model landed anyway — ₹40/admin-day × the customer's current 5
 * seats — taken flat, because flat is what the whole line is priced on (see above) and a flat
 * price doesn't move when the customer's roster churns. COGS ≈ ₹0.25–0.30/night (5 Flash briefings
 * + function runtime; the heavy work-state/demand/reconcile compute runs on the customer's own
 * infra), so this line is margin, not cost recovery.
 */
export const DAILY_PLAN_PRICE_PAISE = 20000; // ₹200 per plan-day, flat (repriced from ₹10, 2026-08-05)

/**
 * ── EOD WhatsApp team summary (eod_summary) ────────────────────────────────────────────────────
 * FLAT per summary-day (operator decision 2026-08-03): every evening at 18:30 IST the eodSummary
 * job asks the platform to WhatsApp the day's team scoreboard (calls done, deals, buyers-waiting,
 * per-admin breakdown) to the configured staff numbers. One event per org per IST date,
 * idempotencyKey = dateKey, settled in-process on the platform's ack — charged only when the
 * platform reports sent > 0, so a day with no plans or a failed delivery is free. Accrued on the
 * org as `eodSummaryAccrualPaise`. COGS ≈ the outbound WhatsApp messages themselves (platform's
 * Gupshup wallet) + one function invocation; Bosun's fee is the aggregation + delivery service.
 */
export const EOD_SUMMARY_PRICE_PAISE = 1000; // ₹10 per summary-day, flat (operator repriced from ₹5 before launch, 2026-08-03)

/**
 * ── Phone-hunt DM composition (dm_compose) ─────────────────────────────────────────────────────
 * FLAT per lead per IST day (operator decision 2026-08-12). The platform's phone-hunt lane works
 * sourced leads that carry NO phone number — nobody can call them, so a human opens the original
 * Facebook post and either finds the number or DMs the seller. This line composes that DM: the
 * property in the seller's own language, and the ask (their number, or the complete-your-listing
 * link the platform appends byte-exact afterwards).
 *
 * Settled IN-PROCESS on a successful compose, exactly like eod_summary — a degraded response
 * (`composed: false`) charges nothing, because the platform then sends its own canned template and
 * Bosun did no work worth billing. idempotencyKey = `${leadId}:${dateKey}`, so a hunter who
 * re-copies the same message, or reloads the lane, is billed once for that lead that day.
 *
 * Deliberately NOT priced on the platform side: per the no-price rule the platform reports what
 * happened and never what it costs. Here the fee is the composition service itself, unlike
 * wa_message_delivered where composition rides free inside the per-message rate. COGS ≈ one Flash
 * call (~₹0.02), so this is margin on a service that turns an uncallable lead into a conversation.
 * Accrued on the org as `dmComposeAccrualPaise`.
 */
export const DM_COMPOSE_PRICE_PAISE = 100; // ₹1 per composed DM, flat, once per lead per IST day

/**
 * ── Billing pause (testing / goodwill) ─────────────────────────────────────────────────────────
 * An org may pause specific metered service lines while a new capability is validated on a testing
 * environment. A paused settle still writes its idempotency log row (so re-runs stay no-ops) but
 * WAIVES the debit — no balance change, no transactions row — and records `waived:true` +
 * `waivedPaise` so the operator can reconcile (add credits back / start charging) with an exact
 * number later. The pause is per SERVICE, so live lines (e.g. sourcing relay) keep charging while
 * only the new lines (daily_plan, whatsapp_*, session/conversion) are waived.
 *
 * Shape: `organisations/{orgId}.billingPaused` = array of service kinds (e.g.
 * ['daily_plan','wa_message_delivered']). Absent/empty ⇒ nothing paused.
 */
export function isServicePaused(org, service) {
  const paused = org && org.billingPaused;
  return Array.isArray(paused) && paused.includes(service);
}

/**
 * ── Conversion popups (conversion_popup) ───────────────────────────────────────────────────────
 * Every popup the agent OPENS on the customer's portal (login popup / number-capture overlay) is a
 * billable conversion action — deterministic or LLM alike, per the operator's per-action principle.
 * Priced RANDOMLY per popup within [MIN, MAX] paise (operator decision 2026-07-19), settled once
 * per day by the nightly session-intelligence run from the action-ledger rollup. The price exists
 * ONLY here — the customer platform's events never carry a cost, and no MaadiVeedu surface shows
 * one. Accrued on the org as `popupAccrualPaise`.
 */
export const CONVERSION_POPUP_MIN_PAISE = 25;
export const CONVERSION_POPUP_MAX_PAISE = 35; // recentred 40–50 → 25–35, avg 30p (operator decision 2026-07-20)

/**
 * ── Weekly SEO report (seo_weekly_report) ──────────────────────────────────────────────────────
 * The Monday SEO agent (handlers/seoWeeklyReport.js) pulls Search Console data, computes the
 * week-over-week tables deterministically, has Flash write the narrative, delivers to the
 * platform's /api/ingest/seo-report, and settles on the 2xx ack — the daily_plan discipline.
 * Priced RANDOMLY per report within [MIN, MAX] paise (operator decision 2026-07-19, same
 * banded-flat principle as conversion popups); the drawn price is recorded on the meter-log row
 * and the seoRuns audit doc. One event per org per report week, idempotencyKey = periodKey.
 * Accrued on the org as `seoReportAccrualPaise`. The REPLAY price exists only for usageMeter's
 * SERVICE_DEFS (a ledger replay after a successful run dedupes to a no-op anyway).
 */
// HELD AT ₹50 (operator decision 2026-08-03): a flat token price per report, BELOW COGS, until the
// operator says otherwise. The customer hasn't yet worked a report — the action items, the
// accountability score and the rank tracker only pay for themselves once someone acts on them — so
// the service earns its real price on adoption, not on delivery. Measured COGS on the week-of
// 2026-07-20 run: Apify $1.4055 (three sweeps — 95 deep queries × 5 pages + 86 locality × 1 page,
// ~$0.0025/page) ≈ ₹124, plus one Flash narrative + function runtime ≈ ₹2. So ≈ ₹126/report, i.e.
// each report at ₹50 LOSES ~₹76. Restore trigger: the owner acting on action items week over week
// (the accountability score in seoRuns going non-null with improved items). The dormant band below
// is the real price to restore to — banded-flat, ~72% margin at the measured COGS.
export const SEO_REPORT_HOLD_PRICE_PAISE = 5000; // ₹50 flat — the LIVE price (temp; see above)
export const SEO_REPORT_MIN_PRICE_PAISE = 45000; // ₹450 — DORMANT restore band
export const SEO_REPORT_MAX_PRICE_PAISE = 55000; // ₹550 — DORMANT restore band
export const SEO_REPORT_REPLAY_PRICE_PAISE = SEO_REPORT_HOLD_PRICE_PAISE; // usageMeter replays price identically

/**
 * One report's price in paise. Flat while the hold is on; restore the banded draw (uniform in
 * [MIN, MAX]) by returning the commented-out expression below.
 */
export function randomSeoReportPricePaise(rng = Math.random) {
  return SEO_REPORT_HOLD_PRICE_PAISE;
  // return (
  //   SEO_REPORT_MIN_PRICE_PAISE +
  //   Math.floor(rng() * (SEO_REPORT_MAX_PRICE_PAISE - SEO_REPORT_MIN_PRICE_PAISE + 1))
  // );
}

/** Total paise for N popups, each drawn uniformly in [MIN, MAX]. */
export function pricePopupBatch(count, rng = Math.random) {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += CONVERSION_POPUP_MIN_PAISE +
      Math.floor(rng() * (CONVERSION_POPUP_MAX_PAISE - CONVERSION_POPUP_MIN_PAISE + 1));
  }
  return total;
}

/**
 * Outcome pricing (operator decision 2026-07-19): a popup that CONVERTED (the visitor signed in or
 * left their number) is worth 75 paise, not the base 25–35. Shows are billed as they happen at the
 * random base rate (average 30p), and a conversion — which can land hours after its show was
 * billed — adds a flat TOP-UP of (75 − 30) = 45p, so converted popups settle at 75p in expectation
 * while unconverted ones keep the base band. Same delta-billing discipline: each conversion tops up
 * exactly once. (TOPUP is computed from the band midpoint below, so it tracks any band change.)
 *
 * EXCEPTION — login_gate (the tools hard wall): charged ONCE per visitor, base band only
 * (operator decision 2026-07-19). Its re-shows arrive as 'reshown' events (never priced) and its
 * conversions are excluded from the top-up in the settle.
 */
export const CONVERSION_POPUP_CONVERTED_PAISE = 75;
export const CONVERSION_POPUP_TOPUP_PAISE =
  CONVERSION_POPUP_CONVERTED_PAISE -
  Math.round((CONVERSION_POPUP_MIN_PAISE + CONVERSION_POPUP_MAX_PAISE) / 2);

/**
 * ── Blog audience classification (blog_classify) ───────────────────────────────────────────────
 * The nightly blogIntelligence agent (handlers/blogIntelligence.js) reads each newly-published post
 * and decides who it's written FOR (buyer / seller / investor / neutral) so the platform's conversion
 * cards target the right reader. One Gemini Flash call per blog (thinkingBudget:0, ~750 in / ~50 out
 * tokens on a ≤1600-char excerpt). Was record-only until now; PRICED per operator decision
 * (2026-07-20): a flat per-blog fee, one-time per post.
 *
 * Cost basis (for margin visibility, not the price): ~3.4 paise/blog GST-incl at Flash rates
 * ($0.30/1M in, $2.50/1M out), rounded to a ~4 paise average to cover longer posts. The PRICE is a
 * flat 50 paise per blog (operator-set 2026-07-20) — a per-post value fee for the audience-targeting
 * the classification unlocks, comfortably above a 3× cost floor, not a thin cost-plus.
 *
 * Settled in-process by blogIntelligence PER DELIVERED BATCH on the platform's engagement-pack ack
 * — amount = BLOG_CLASSIFY_PRICE_PAISE × (blogs in that batch) — held in paise and accrued on the
 * org as `blogClassifyAccrualPaise`, whole rupees debited as the accrual crosses ₹1 (the same "sum,
 * then round once" discipline compose/auto_post/daily_plan use). idempotencyKey = the batch's
 * packRunId, so a retry, a timeout-interrupted run, or a repeat same-day backfill each bill only
 * their new batches and never double-charge a settled one. Registered in usageMeter too so a ledger
 * replay/backfill prices identically (the shared per-packRunId log row makes a replay a no-op).
 */
export const BLOG_CLASSIFY_COST_PAISE = 4;    // measured avg Gemini Flash cost per blog (GST-incl.), for margin only
export const BLOG_CLASSIFY_PRICE_PAISE = 50;  // flat 50 paise/blog (operator-set 2026-07-20)

/**
 * ── Lead call-brief (on-demand) ─────────────────────────────────────────────────────────────────
 * An admin about to phone a website-captured lead taps "Prep call": Bosun reads the lead's session
 * context (searches, viewed listings, capture reason, live inventory) and Gemini Flash writes a
 * call brief — summary, action items, and how to capture. Priced at 3× the measured Gemini cost
 * (operator directive 2026-07-20 "3x of our cost"). Settled in-process per generation, accrued on
 * the org as `leadBriefAccrualPaise`; idempotencyKey = leadId, so re-opening a cached brief is a
 * charged:0 no-op and only a REGENERATE (force) bills again.
 */
// Measured: ~300 output + ~600 input tokens on Gemini 2.5 Flash ≈ ₹0.10, GST-incl. + context
// variance ≈ 15 paise. Priced at EXACTLY 3× that (operator directive 2026-07-20 "average cost × 3x").
export const LEAD_BRIEF_COST_PAISE = 15;   // measured avg Gemini Flash cost per brief (GST-incl.)
export const LEAD_BRIEF_PRICE_PAISE = 45;  // 3× cost

/**
 * ── Defect tracking (defect_triage / defect_fix / defect_regression_test / defect_sla_report) ───
 * The customer's own staff raise defects from THEIR admin console; Bosun files them into the org's
 * GitHub repo, dedupes them, enriches them with evidence, and meters the lifecycle. A separate lane
 * from the managed-agent fix pipeline (COMPLEXITY_TIERS): there the agent does the work and the
 * price must cover token COGS, here the customer's OWN pipeline does the fixing and Bosun's marginal
 * cost is one cheap classify call. That is why a per-org price exists at all — see priceForService.
 *
 * The four lines, and why each settles where it does:
 *   defect_triage        — per report that PASSES the dedupe gate and gets a spec + evidence pack.
 *                          A duplicate costs the customer NOTHING: the gate's whole value is that
 *                          it stops work, so billing for it would invert the incentive.
 *   defect_fix           — the headline line, settled on the REPORTER'S OWN confirmation that the
 *                          thing that annoyed them stopped happening. Deliberately not "PR opened"
 *                          (bills fixes that didn't work) and not "report filed" (prices the act of
 *                          reporting a bug, which teaches staff to stay quiet). A bounced fix
 *                          re-enters the queue free — the MAX_FREE_REVISIONS discipline.
 *   defect_regression_test — opt-in per org: a merged Playwright test pinning the acceptance
 *                          criteria, so the same defect cannot come back.
 *   defect_sla_report    — the weekly accountability pack (time-to-fix, reopen rate, unconfirmed
 *                          tickets), on the seo_weekly_report rails.
 *
 * All four are DEFAULTS. The live price for any org is whatever priceForService resolves — these
 * constants are only the fallback for an org that has set no override.
 */
export const DEFECT_TRIAGE_PRICE_PAISE = 1000;           // ₹10 per non-duplicate report triaged
export const DEFECT_FIX_PRICE_PAISE = 10000;             // ₹100 per reporter-confirmed fix
export const DEFECT_REGRESSION_TEST_PRICE_PAISE = 4000;  // ₹40 per merged regression test
export const DEFECT_SLA_REPORT_PRICE_PAISE = 5000;       // ₹50 per weekly defect SLA report

/**
 * ── Per-org price override ─────────────────────────────────────────────────────────────────────
 * Resolve the live unit price (paise) for a metered service line on ONE org, falling back to the
 * module constant when that org has set no override.
 *
 * Until now every price here was global: one constant, every customer. That held while the
 * customer base was one platform, but a service whose COGS depends on WHOSE pipeline does the work
 * cannot be priced globally — a defect fixed by the customer's own Claude Code pipeline costs Bosun
 * a classify call, while the same defect routed to the managed agent costs real tokens. The
 * override exists for that, and for genuine commercial terms (a pilot rate, a volume rate).
 *
 * Shape: `organisations/{orgId}.pricing` = { [service]: <paise, integer ≥ 0> }, e.g.
 *   { defect_fix: 10000, defect_triage: 0 }
 * A 0 is HONOURED (a deliberately free line, distinct from `billingPaused` which waives a priced
 * line and records `waivedPaise` for later reconciliation). Anything not a non-negative integer —
 * a string from a bad admin write, a float, a negative — is ignored in favour of the constant, so a
 * malformed override can never make a line free or negative by accident.
 *
 * INVARIANT (shared with every meter line): the price is resolved on OUR side, from OUR data. It
 * never travels on the wire and no customer surface displays one. The customer reports what
 * happened; Bosun alone decides what it costs.
 */
export function priceForService(org, service, fallbackPaise) {
  const override = org && org.pricing ? org.pricing[service] : undefined;
  if (Number.isInteger(override) && override >= 0) return override;
  return fallbackPaise;
}

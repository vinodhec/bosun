/**
 * Nightly Session Intelligence — the ₹30k proposal's §2: classify yesterday's sessions into
 * buyer-intent segments, build the daily demand map, refresh the engagement message library
 * (Tamil + English), and flag same-day anomalies.
 *
 * 02:30 IST nightly (after the 01:30 planner), per org with sourcing.intelligence.enabled:
 *   1. Pull the platform's session digest (GET /api/sourcing/session-digest, HMAC over
 *      `${timestamp}.session-digest`) — session summaries + facet-rich search rows. Bounded reads,
 *      no raw event logs.
 *   2. DETERMINISTIC segmentation + demand aggregation (no model): segments from funnel flags,
 *      demand rows keyed (city, locality, propertyType, listingType, bhk, budgetBand) with
 *      searched/unserved counts. Auditable and free.
 *   3. Gemini Flash composes the message library ONLY — banner + popup copy per top locality in
 *      EN + TA, ≤ ~9 calls/night. Copy uses a literal `{count}` placeholder: the PLATFORM injects
 *      the live inventory count at serve time and drops the message when the count is 0, so no
 *      number in front of a visitor is ever model-invented ("no generic or inflated claims").
 *   4. Anomalies vs the trailing week of our own runs (sessions volume, lead conversion, locality
 *      heat) — deterministic checks, same-day.
 *   5. POST the engagement-pack to the platform; record the run at intelRuns/{orgId}/days/{dateKey}
 *      (idempotency pre-check — a scheduler retry no-ops) and bump the org's monthly processed-
 *      sessions counter (`sessionMeter.<yyyymm>`) — the 1,50,000/month pool the base fee covers;
 *      the operator reconciles overage (₹0.20/session) from this counter, no per-day billing here.
 *
 * Config: organisations/{orgId}.sourcing.intelligence = { enabled, digestUrl, packUrl,
 * capSessions?, capSearches?, topLocalities? }. Secret: orgSecrets/{orgId}.sourcing.secret.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { signPayload } from '../utils/sourcing.js';
import { generateJson, GEMINI_FLASH } from '../utils/gemini.js';
import { tuneRules, buildDevTaskProposals, buildStaffingProposals, rollupActions } from '../utils/rulesTuner.js';
import { clusterErrors, buildErrorDevTaskProposals } from '../utils/errorIntel.js';
import { createIssue } from '../utils/githubIssues.js';
import { pricePopupBatch, accrueComposeCharge, isServicePaused, CONVERSION_POPUP_TOPUP_PAISE } from '../shared/billing.js';

const REGION = 'asia-south1';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const COMPOSE_CONCURRENCY = 3;
const DEFAULT_TOP_LOCALITIES = 8;
const ANOMALY_BASELINE_DAYS = 7;

function istDateKey(nowMs = Date.now()) {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}${String(ist.getUTCMonth() + 1).padStart(2, '0')}${String(ist.getUTCDate()).padStart(2, '0')}`;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

/** Funnel flags → intent segment. Precedence mirrors the platform's drop-off staging. */
export function segmentOf(s) {
  const f = s.flags || {};
  if (f.postProperty || f.postSuccess) return 'seller_intent';
  if (f.enquiry || f.contact) return 'serious';
  if (f.wishlist || (f.search && f.propertyView) || f.loginOpen) return 'warm';
  if (!s.engaged && (s.pageCount || 0) <= 1) return 'bounced';
  return 'browser';
}

/** Coarse budget band from a search row's min/max — demand-map granularity, not precision. */
export function budgetBandOf(minPrice, maxPrice) {
  const anchor = maxPrice || minPrice || 0;
  if (!anchor) return '';
  if (anchor <= 50000) return 'rent'; // rupee amounts this small are monthly rents
  if (anchor < 2500000) return '<25L';
  if (anchor < 5000000) return '25-50L';
  if (anchor < 10000000) return '50L-1Cr';
  return '1Cr+';
}

/** Aggregate search rows into the demand map. Deterministic; exported for the fixture tests. */
export function buildDemandMap(searches) {
  const rows = new Map();
  for (const r of searches) {
    if (!r.city && !r.locality) continue;
    const budgetBand = budgetBandOf(r.minPrice, r.maxPrice);
    const key = [r.city, r.locality, r.propertyType, r.listingType, r.bhkType, budgetBand].join('|').toLowerCase();
    let row = rows.get(key);
    if (!row) {
      row = {
        city: r.city,
        locality: r.locality,
        propertyType: r.propertyType,
        listingType: r.listingType,
        bhkType: r.bhkType,
        budgetBand,
        searchedCount: 0,
        unservedCount: 0,
        sids: new Set(),
      };
      rows.set(key, row);
    }
    row.searchedCount += r.searches || 1;
    if (r.noFreshSupply || r.freshResultCount === 0) row.unservedCount += r.searches || 1;
    if (r.sid) row.sids.add(r.sid);
  }
  return [...rows.values()]
    .map(({ sids, ...r }) => ({ ...r, sessions: sids.size }))
    .sort((a, b) => b.searchedCount - a.searchedCount);
}

/** Top localities by search volume — the message library's targeting set. */
export function topLocalities(demandMap, n) {
  const byLoc = new Map();
  for (const r of demandMap) {
    if (!r.locality) continue;
    const key = `${r.city}|${r.locality}`.toLowerCase();
    const cur = byLoc.get(key) || { city: r.city, locality: r.locality, searchedCount: 0, unservedCount: 0 };
    cur.searchedCount += r.searchedCount;
    cur.unservedCount += r.unservedCount;
    byLoc.set(key, cur);
  }
  return [...byLoc.values()].sort((a, b) => b.searchedCount - a.searchedCount).slice(0, n);
}

const MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    banner_en: { type: 'object', properties: { headline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } }, required: ['headline', 'body', 'cta'] },
    banner_ta: { type: 'object', properties: { headline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } }, required: ['headline', 'body', 'cta'] },
    popup_en: { type: 'object', properties: { headline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } }, required: ['headline', 'body', 'cta'] },
    popup_ta: { type: 'object', properties: { headline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } }, required: ['headline', 'body', 'cta'] },
  },
  required: ['banner_en', 'banner_ta', 'popup_en', 'popup_ta'],
};

function composePrompt(loc) {
  const place = loc ? `${loc.locality}, ${loc.city}` : 'their city';
  return [
    `Write real-estate marketplace engagement copy for visitors interested in ${place}.`,
    loc ? `Yesterday ${loc.searchedCount} searches hit this locality${loc.unservedCount ? ` (${loc.unservedCount} found no fresh listings)` : ''}.` : '',
    'Produce FOUR variants as JSON: banner_en, banner_ta (Tamil), popup_en, popup_ta (Tamil).',
    'BANNER = a browse nudge shown on the landing page.',
    'POPUP = shown while the visitor is LOOKING AT A PROPERTY PAGE (their 3rd view). The headline',
    'must anchor to the property in front of them — e.g. "See this owner\'s contact details" — and',
    'the body reinforces with the wider supply: use the literal placeholders {count} and {place},',
    'e.g. "Plus {count} more owner listings in {place}." Sign-in completes what they are doing NOW.',
    'Use {count} exactly once in each banner headline or body, and once in each popup body —',
    'NEVER write a real number or place yourself; the platform substitutes live values.',
    'Keep headlines ≤ 60 chars, bodies ≤ 140 chars, CTA ≤ 20 chars. No emojis, no exclamation spam, no invented claims (no prices, no "verified" unless the copy says "listings").',
  ]
    .filter(Boolean)
    .join('\n');
}

/** One Flash call → 4 messages (banner/popup × en/ta) for a locality (or the generic fallback). */
async function composeFor(loc, segmentFor) {
  const out = await generateJson({
    model: GEMINI_FLASH,
    prompt: composePrompt(loc),
    schema: MESSAGE_SCHEMA,
    temperature: 0.6,
    maxOutputTokens: 1400, // Tamil is token-hungry — same sizing lesson as composeSelfPost
    thinkingBudget: 0,
  });
  if (!out) return [];
  const mk = (kind, lang, m) => ({
    segment: segmentFor(kind),
    kind,
    city: loc ? loc.city : '',
    locality: loc ? loc.locality : '',
    // These popups sell owner-contact access — they belong to the property-BROWSE moment. Copy for
    // other moments (tools) is composed separately; the platform never serves browse copy to a
    // tools popup (surface matching in pickMessage).
    surface: kind === 'popup' ? 'browse' : '',
    lang,
    headline: String(m.headline || '').slice(0, 140),
    body: String(m.body || '').slice(0, 280),
    cta: String(m.cta || '').slice(0, 60),
  });
  return [
    mk('banner', 'en', out.banner_en),
    mk('banner', 'ta', out.banner_ta),
    mk('popup', 'en', out.popup_en),
    mk('popup', 'ta', out.popup_ta),
  ].filter((m) => m.headline && m.body);
}

const POPUP_PAIR = {
  type: 'object',
  properties: {
    popup_en: { type: 'object', properties: { headline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } }, required: ['headline', 'body', 'cta'] },
    popup_ta: { type: 'object', properties: { headline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } }, required: ['headline', 'body', 'cta'] },
  },
  required: ['popup_en', 'popup_ta'],
};

const TOOLS_POPUP_SCHEMA = {
  type: 'object',
  properties: {
    families: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          variants: { type: 'array', items: POPUP_PAIR },
        },
        required: ['key', 'variants'],
      },
    },
    generic: { type: 'array', items: POPUP_PAIR },
  },
  required: ['families', 'generic'],
};

/**
 * The customer platform's tool families (route slugs) — copy is written per FAMILY and fanned out
 * to each slug as tool-targeted library messages, so the wall on the EMI calculator talks about
 * saving EMI plans, not generic "tools" (operator request 2026-07-19: rotate messages AND match
 * the tool the visitor is in). Keep in sync with the platform's /tools routes.
 */
const TOOL_FAMILIES = [
  { key: 'loan', slugs: ['home-loan-calculator', 'affordability-calculator', 'down-payment-calculator'], desc: 'home-loan EMI / affordability / down-payment calculators (visitor is planning a loan)' },
  { key: 'tax', slugs: ['stamp-duty-calculator', 'capital-gains-tax-calculator', 'property-tax-calculator'], desc: 'stamp duty / capital gains / property tax calculators (visitor is estimating taxes and charges)' },
  { key: 'rental', slugs: ['rental-yield-calculator', 'rental-agreement', 'buy-rent-calculator'], desc: 'rental yield / rental agreement / buy-vs-rent tools (visitor is working a rental decision)' },
  { key: 'convert', slugs: ['real-estate-unit-converter', 'convert', 'appliance-power-calculator'], desc: 'land-unit converters and power calculators (visitor is converting measurements)' },
  { key: 'value', slugs: ['property-valuation-tool', 'investment-roi-calculator'], desc: 'property valuation / investment ROI tools (visitor is sizing up an investment)' },
];

/**
 * Tools-moment popup copy — a calculator/converter user is mid-task; the pitch is CONTINUING and
 * SAVING their work (plus what an account adds), never "owner contact details" (that's the browse
 * moment's pitch — operator feedback 2026-07-19). Count-free by design: nothing to ground.
 *
 * One variant per tool family (fanned out per slug, en+ta) plus a few generic rotations — the
 * platform's picker prefers this-tool copy and rotates among equal matches, so the wall reads
 * differently across tools and across days.
 */
async function composeToolsPopup() {
  const out = await generateJson({
    model: GEMINI_FLASH,
    prompt: [
      'Write sign-in popup copy for a real-estate marketplace visitor who is actively USING free',
      'tools as a guest. Sell what signing in adds to their TOOL experience: save calculations,',
      'revisit results, personalised reports/rates. Do NOT mention owner contact details or',
      'property counts. No emojis, no invented claims, no numbers.',
      '',
      'Produce JSON {families, generic}:',
      `- families: one entry per family below, key as given, each with 2 DISTINCT variants of copy`,
      '  SPECIFIC to that moment (different angle each — e.g. save-your-work vs personalised-rates):',
      ...TOOL_FAMILIES.map((f) => `    - key "${f.key}": ${f.desc}`),
      '- generic: 3 DISTINCT variants usable on any tool (vary the angle: save work / continue',
      '  anywhere / personalised insights).',
      'Every variant has {popup_en, popup_ta (Tamil)} each {headline ≤60 chars, body ≤140, cta ≤20}.',
    ].join('\n'),
    schema: TOOLS_POPUP_SCHEMA,
    temperature: 0.7,
    maxOutputTokens: 4000,
    thinkingBudget: 0,
  });
  if (!out) return [];
  const mk = (lang, m, tool, id) => ({
    id,
    segment: 'serious',
    kind: 'popup',
    city: '',
    locality: '',
    surface: 'tools',
    tool,
    lang,
    headline: String(m?.headline || '').slice(0, 140),
    body: String(m?.body || '').slice(0, 280),
    cta: String(m?.cta || '').slice(0, 60),
  });
  const messages = [];
  for (const fam of Array.isArray(out.families) ? out.families : []) {
    const family = TOOL_FAMILIES.find((f) => f.key === fam.key);
    if (!family) continue;
    (Array.isArray(fam.variants) ? fam.variants : []).forEach((v, i) => {
      for (const slug of family.slugs) {
        // Same top score for every variant of a slug → the platform's picker rotates among them.
        messages.push(mk('en', v.popup_en, slug, `tools_gate_${slug}_${i}_en`));
        messages.push(mk('ta', v.popup_ta, slug, `tools_gate_${slug}_${i}_ta`));
      }
    });
  }
  (Array.isArray(out.generic) ? out.generic : []).forEach((g, i) => {
    messages.push(mk('en', g.popup_en, '', `tools_gate_generic_${i}_en`));
    messages.push(mk('ta', g.popup_ta, '', `tools_gate_generic_${i}_ta`));
  });
  return messages.filter((m) => m.headline && m.body);
}

/** Deterministic anomaly checks vs the trailing runs. Exported for tests. */
export function detectAnomalies(today, baselineDays) {
  const anomalies = [];
  const avg = (sel) => {
    const vals = baselineDays.map(sel).filter((v) => Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const check = (metric, value, baseline, { spikeAt = 2, dropAt = 0.5, label }) => {
    if (baseline == null || baseline < 5) return; // too little history to judge
    if (value >= baseline * spikeAt) {
      anomalies.push({ kind: `${metric}-spike`, severity: 'info', metric, value, baseline: Math.round(baseline), message: `${label} spiked: ${value} vs ~${Math.round(baseline)}/day trailing average.` });
    } else if (value <= baseline * dropAt) {
      anomalies.push({ kind: `${metric}-drop`, severity: 'high', metric, value, baseline: Math.round(baseline), message: `${label} dropped: ${value} vs ~${Math.round(baseline)}/day trailing average.` });
    }
  };
  check('sessions', today.sessions, avg((d) => d.sessions), { label: 'Visitor sessions' });
  check('leads', today.leads, avg((d) => d.leads), { label: 'Converted leads (enquiry/contact)' });
  check('searches', today.searches, avg((d) => d.searches), { label: 'Search volume' });
  // Errors invert the spike/drop meaning: MORE is the emergency (a drop is just a good day). Floor
  // of 5 error sessions so a 0→2 blip never pages; needs recorded history (errorSessions on the
  // trailing run docs) before it can judge.
  const errBase = avg((d) => d.errorSessions);
  if (errBase != null && (today.errorSessions || 0) >= Math.max(5, errBase * 2)) {
    anomalies.push({
      kind: 'errors-spike',
      severity: 'high',
      metric: 'error_sessions',
      value: today.errorSessions,
      baseline: Math.round(errBase),
      message: `App-error sessions spiked: ${today.errorSessions} vs ~${Math.round(errBase)}/day trailing average — a broken flow is likely live.`,
    });
  }
  return anomalies;
}

/**
 * Delta-bill the popups opened on `dateKey` — every overlay shown (login popup / capture overlay),
 * deterministic or LLM alike, priced randomly per popup within the billing.js band. The log doc
 * `usage_meter_log/{orgId}:conversion_popup:{dateKey}` tracks `qty` billed SO FAR for the day; each
 * settle bills only the delta, so the hourly cron, the nightly catch-up, and manual triggers are
 * all safely re-runnable and each popup is charged exactly once. Prices exist ONLY in bosun.
 */
export async function settlePopupsForDate(db, orgId, dateKey, actionRows) {
  const result = { qty: 0, converted: 0, chargedInr: 0, deltaBilled: 0 };
  try {
    const overlayRows = (actionRows || []).filter((a) => a.slot === 'overlay');
    // Only 'shown' rows are priced. The login_gate re-shows arrive as 'reshown' (ignored here):
    // operator decision 2026-07-19 — the tools gate is charged ONCE per visitor, at its original
    // fire; every latched re-appearance is free.
    const popupShows = overlayRows
      .filter((a) => a.event === 'shown')
      .reduce((n, a) => n + (Number(a.count) || 0), 0);
    // Conversions: the visitor signed in or left their number after our popup. Capped at shows —
    // a conversion without a recorded show can't out-bill reality. login_gate conversions are
    // excluded from the top-up entirely (same once-only decision: one flat base charge, no
    // outcome pricing on the gate — other overlay kinds keep the 75p outcome price).
    const popupConversions = Math.min(
      overlayRows
        .filter(
          (a) =>
            (a.event === 'login_success' || a.event === 'captured') &&
            a.actionKind !== 'login_gate',
        )
        .reduce((n, a) => n + (Number(a.count) || 0), 0),
      popupShows,
    );
    result.qty = popupShows;
    result.converted = popupConversions;
    if (popupShows <= 0) return result;

    const logRef = db.collection('usage_meter_log').doc(`${orgId}:conversion_popup:${dateKey}`);
    const settled = await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return { delta: 0, debitInr: 0 };
      const logSnap = await tx.get(logRef);
      const prev = logSnap.exists ? logSnap.data() : {};
      const billedSoFar = Number(prev.qty) || 0;
      const convBilledSoFar = Number(prev.convQty) || 0;
      const delta = popupShows - billedSoFar;
      // Outcome top-up: conversions billed exactly once each, whenever they land (possibly hours
      // after their show was billed at the base rate) — converted popup ≈ 75p total.
      const deltaConv = popupConversions - convBilledSoFar;
      if (delta <= 0 && deltaConv <= 0) return { delta: 0, debitInr: 0 };

      const org = orgSnap.data();
      const deltaPaise =
        (delta > 0 ? pricePopupBatch(delta) : 0) +
        (deltaConv > 0 ? deltaConv * CONVERSION_POPUP_TOPUP_PAISE : 0);
      const base = {
        orgId,
        service: 'conversion_popup',
        idempotencyKey: dateKey,
        qty: Math.max(popupShows, billedSoFar), // shows billed so far after this settle
        convQty: Math.max(popupConversions, convBilledSoFar), // conversions topped-up so far
        pricePaise: null, // random per popup + conversion top-up — see billing.js
        totalPaise: (Number(prev.totalPaise) || 0) + deltaPaise,
        lastDeltaQty: Math.max(delta, 0),
        lastDeltaConv: Math.max(deltaConv, 0),
        updatedAt: FieldValue.serverTimestamp(),
        ...(logSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      };

      if (isServicePaused(org, 'conversion_popup')) {
        tx.set(logRef, {
          ...base,
          debitInr: Number(prev.debitInr) || 0,
          waived: true,
          waivedPaise: (Number(prev.waivedPaise) || 0) + deltaPaise,
        }, { merge: true });
        return { delta: Math.max(delta, 0) + Math.max(deltaConv, 0), debitInr: 0 };
      }

      const { debitInr, accrualPaise } = accrueComposeCharge(org.popupAccrualPaise, deltaPaise);
      const update = { popupAccrualPaise: accrualPaise };
      if (debitInr > 0) {
        update.balance = Number(org.balance ?? 0) - debitInr;
        const parts = [];
        if (delta > 0) parts.push(`${delta} shown × ~₹0.40–0.60`);
        if (deltaConv > 0) parts.push(`${deltaConv} converted × +₹0.25 top-up (→ ~₹0.75 each)`);
        tx.set(db.collection('transactions').doc(), {
          orgId,
          type: 'debit',
          kind: 'conversion_popup',
          amount: debitInr,
          count: Math.max(delta, 0) + Math.max(deltaConv, 0),
          description: `Conversion popups (${parts.join(' · ')})`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, { ...base, debitInr: (Number(prev.debitInr) || 0) + debitInr }, { merge: true });
      return { delta: Math.max(delta, 0) + Math.max(deltaConv, 0), debitInr };
    });
    result.deltaBilled = settled.delta;
    result.chargedInr = settled.debitInr;
    return result;
  } catch (e) {
    console.error('settlePopupsForDate:err', orgId, dateKey, e?.message || e);
    return result;
  }
}

// Hourly intraday popup billing: pull ONLY the action rollup for TODAY (IST) via the digest's
// actionsOnly mode and delta-settle. Cheap (one bounded query platform-side), safely re-runnable.
export const settleConversionPopups = onSchedule(
  { region: REGION, schedule: '10 * * * *', timeZone: 'Asia/Kolkata', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const db = getFirestore();
    const snap = await db.collection('organisations').where('sourcing.enabled', '==', true).get();
    for (const orgDoc of snap.docs) {
      const cfg = orgDoc.data().sourcing || {};
      const intel = cfg.intelligence || {};
      if (!intel.enabled || !intel.digestUrl) continue;
      try {
        const secretSnap = await db.collection('orgSecrets').doc(orgDoc.id).get();
        const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
        if (!secret) continue;
        const todayKey = istDateKey(); // TODAY — intraday billing
        const { signature, timestamp } = signPayload(secret, 'session-digest');
        const url = new URL(intel.digestUrl);
        url.searchParams.set('date', todayKey);
        url.searchParams.set('actionsOnly', '1');
        const resp = await fetch(url.toString(), {
          headers: { 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp },
          signal: AbortSignal.timeout(30000),
        });
        if (!resp.ok) continue;
        const body = await resp.json();
        const res = await settlePopupsForDate(db, orgDoc.id, todayKey, body.actions || []);
        if (res.deltaBilled > 0) {
          console.log('settleConversionPopups:billed', orgDoc.id, JSON.stringify(res));
        }
      } catch (e) {
        console.error('settleConversionPopups:org', orgDoc.id, e?.message || e);
      }
    }
  },
);

export async function runIntelligenceForOrg(db, orgId, cfg) {
  const intel = cfg.intelligence || {};
  // The pack describes YESTERDAY (the last completed IST day).
  const dateKey = istDateKey(Date.now() - 24 * 60 * 60 * 1000);
  const summary = { orgId, dateKey, status: 'skipped' };
  try {
    if (!intel.enabled || !intel.digestUrl || !intel.packUrl) {
      summary.reason = 'intelligence-not-configured';
      return summary;
    }
    const runRef = db.collection('intelRuns').doc(orgId).collection('days').doc(dateKey);
    if ((await runRef.get()).exists) {
      summary.reason = 'already-ran';
      return summary;
    }
    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) {
      summary.status = 'error';
      summary.reason = 'no-secret';
      return summary;
    }

    // 1) Digest pull.
    const { signature, timestamp } = signPayload(secret, 'session-digest');
    const url = new URL(intel.digestUrl);
    url.searchParams.set('date', dateKey);
    if (intel.capSessions) url.searchParams.set('capSessions', String(intel.capSessions));
    if (intel.capSearches) url.searchParams.set('capSearches', String(intel.capSearches));
    const resp = await fetch(url.toString(), {
      headers: { 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp },
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) {
      summary.status = 'error';
      summary.reason = `digest-http-${resp.status}`;
      return summary;
    }
    const digest = await resp.json();
    if (!digest?.success) {
      summary.status = 'error';
      summary.reason = 'digest-malformed';
      return summary;
    }

    // 2) Deterministic core.
    const segments = { serious: 0, warm: 0, browser: 0, seller_intent: 0, bounced: 0, total: 0 };
    for (const s of digest.sessions || []) {
      segments[segmentOf(s)]++;
      segments.total++;
    }
    const demandMap = buildDemandMap(digest.searches || []);
    const locs = topLocalities(demandMap, Math.max(1, Number(intel.topLocalities) || DEFAULT_TOP_LOCALITIES));

    // 3) Message library: banners speak to 'warm', popups to 'serious' (popups are reserved for
    // high-intent moments per the proposal). One call per top locality + one generic fallback.
    const segmentFor = (kind) => (kind === 'popup' ? 'serious' : 'warm');
    const batches = await mapLimit([null, ...locs], COMPOSE_CONCURRENCY, (loc) => composeFor(loc, segmentFor));
    // Moment-specific copy: the tools popup is its own composition (never property-count copy).
    const toolsMessages = await composeToolsPopup();
    const messages = [...batches.flat(), ...toolsMessages];
    const composeFailures = batches.filter((b) => !b.length).length + (toolsMessages.length ? 0 : 1);

    // 4) Anomalies vs our own trailing runs (+ plan-completion escalation).
    const baselineSnap = await db
      .collection('intelRuns')
      .doc(orgId)
      .collection('days')
      .orderBy('dateKey', 'desc')
      .limit(ANOMALY_BASELINE_DAYS)
      .get();
    const baselineDocs = baselineSnap.docs.map((d) => d.data());
    const leads = (digest.sessions || []).filter((s) => s.flags?.enquiry || s.flags?.contact).length;
    const searchVolume = (digest.searches || []).reduce((a, r) => a + (r.searches || 1), 0);
    // Error intelligence: cluster the day's app_error sessions (digest.errors) — the bug-ticket
    // feed. Deterministic; clusters feed the anomaly check, the pack's appHealth block, the day
    // record (weekly/monthly raw material), and the dev-task proposals below.
    const errorRows = Array.isArray(digest.errors) ? digest.errors : [];
    const errorClusters = clusterErrors(errorRows);
    const errorSessions = errorRows.length;
    const errorEvents = errorRows.reduce((a, r) => a + (Number(r.count) || 1), 0);
    const errorRatePct = segments.total ? Math.round((errorSessions / segments.total) * 10000) / 100 : 0;
    const anomalies = detectAnomalies({ sessions: segments.total, leads, searches: searchVolume, errorSessions }, baselineDocs);
    // Escalation: admins ignoring the daily plan is an ops problem the operator must see same-day.
    const planTotals = (digest.planCompletion || []).reduce(
      (acc, p) => ({ total: acc.total + p.total, closed: acc.closed + p.done + p.skipped + p.autoDone }),
      { total: 0, closed: 0 },
    );
    if (planTotals.total >= 20 && planTotals.closed / planTotals.total < 0.4) {
      anomalies.push({
        kind: 'plan-completion-slump',
        severity: 'high',
        metric: 'plan_completion',
        value: Math.round((planTotals.closed / planTotals.total) * 100),
        baseline: 100,
        message: `Daily work-plan completion at ${Math.round((planTotals.closed / planTotals.total) * 100)}% (${planTotals.closed}/${planTotals.total} tasks) — admins may not be working from the plan.`,
      });
    }

    // 4b) Rules tuning: the digest echoes the ACTIVE pack (stored or platform defaults), so we
    // always tune what is genuinely live. Every change carries a written reason; the platform's
    // fence re-clamps whatever we send.
    const activeRules = Array.isArray(digest.activeRules) ? digest.activeRules : [];
    const tuning = activeRules.length ? tuneRules(activeRules, digest.actions || []) : { rules: null, changes: [] };

    // 4c) Proposals (human-in-the-loop): structural findings → dev tasks; planner allocation gaps
    // → staffing recommendations (recruit / re-skill / ramp — kind:'staffing', never filed to
    // GitHub). Both land in the same superadmin approval queue.
    const plannerSnap = await db
      .collection('plannerRuns')
      .doc(orgId)
      .collection('runs')
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get()
      .catch(() => ({ docs: [] }));
    const staffing = buildStaffingProposals(plannerSnap.docs.map((d) => d.data()));
    // Error-fix proposals lead the queue — they're concrete broken flows with journey evidence,
    // not tuning suggestions. Journey deep-links point at the customer console (digest origin).
    const consoleOrigin = new URL(intel.digestUrl).origin;
    const errorProposals = buildErrorDevTaskProposals(errorClusters, { consoleOrigin, dateKey });
    // Crash-class proposals (autoFile) skip the approval queue — a page death is filed the same
    // night; only the recurring/lower-stakes ones wait for the superadmin.
    const autoFileTasks = errorProposals.filter((p) => p.autoFile);
    const queuedErrorProposals = errorProposals.filter((p) => !p.autoFile);
    const devTasks = [...queuedErrorProposals, ...buildDevTaskProposals({ ...digest, anomalies }), ...staffing].slice(0, 4);

    // 4d) File real GitHub issues: same-night crash-class auto-file tasks + APPROVED proposals
    // from previous nights — capped, deduped by fingerprint via the filedTasks ledger, token =
    // the org's stored repo token.
    const filedDevTasks = [];
    const approved = (digest.approvedDevTasks || []).slice(0, 3);
    const toFile = [...autoFileTasks, ...approved].slice(0, 5);
    if (toFile.length) {
      const orgDoc = await db.collection('organisations').doc(orgId).get();
      const repoFullName = orgDoc.data()?.github?.repoFullName || '';
      const ghToken = (await db.collection('orgSecrets').doc(orgId).get()).data()?.githubToken || '';
      for (const task of toFile) {
        const filedRef = db.collection('filedDevTasks').doc(`${orgId}_${task.fingerprint}`);
        if ((await filedRef.get()).exists) continue; // already filed on a previous night
        const res = await createIssue(repoFullName, { title: task.title, body: task.body, labels: task.labels }, ghToken);
        if (res.ok) {
          await filedRef.set({
            orgId,
            fingerprint: task.fingerprint,
            issueNumber: res.number,
            issueUrl: res.url,
            createdAt: FieldValue.serverTimestamp(),
          });
          filedDevTasks.push({ fingerprint: task.fingerprint, issueUrl: res.url, issueNumber: res.number });
        }
      }
    }

    // 5) Deliver the pack — content + rules + dev-task proposals + filed confirmations in one POST.
    const packRunId = `ep_${dateKey}_${crypto.randomBytes(5).toString('hex')}`;
    const body = JSON.stringify({
      orgId,
      packRunId,
      dateKey,
      generatedAtMs: Date.now(),
      segments,
      demandMap: demandMap.slice(0, 500),
      messages,
      anomalies,
      appHealth: {
        errorSessions,
        errorEvents,
        errorRatePct,
        topErrors: errorClusters.slice(0, 8),
      },
      ...(tuning.rules ? { rules: tuning.rules } : {}),
      ...(devTasks.length ? { devTasks } : {}),
      ...(filedDevTasks.length ? { filedDevTasks } : {}),
    });
    const signed = signPayload(secret, body);
    const post = await fetch(intel.packUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bosun-signature': signed.signature,
        'x-bosun-timestamp': signed.timestamp,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (!post.ok) {
      summary.status = 'error';
      summary.reason = `pack-post-http-${post.status}`;
      return summary;
    }

    // 5b) BILL the day's popups (final catch-up — the hourly settleConversionPopups cron bills
    // intraday; this closes any remainder for the completed day). Delta-billing: only popups not
    // yet billed for this dateKey are charged.
    const popupBilling = await settlePopupsForDate(db, orgId, dateKey, digest.actions || []);

    // 6) Record the run (idempotency + weekly-report raw material) and bump the monthly pool
    // counter — no per-day charge: sessions are covered by the base fee up to the pool.
    // Action-ledger volumes recorded per day: the (later-priced) conversion_action revenue basis —
    // Bosun earns per action DELIVERED, deterministic or LLM alike; the counts are kept from day
    // one so pricing can attach retroactively.
    const actionRollup = rollupActions(digest.actions || []);
    const actionTotals = Object.values(actionRollup).reduce(
      (acc, r) => ({ shown: acc.shown + r.shown, converted: acc.converted + r.converted }),
      { shown: 0, converted: 0 },
    );

    await runRef.set({
      dateKey,
      packRunId,
      sessions: segments.total,
      leads,
      searches: searchVolume,
      segments,
      demandTop: demandMap.slice(0, 25),
      anomalies,
      errorSessions,
      errorEvents,
      errorTop: errorClusters.slice(0, 10),
      messageCount: messages.length,
      composeFailures,
      sessionsTruncated: Boolean(digest.counts?.sessionsTruncated),
      // Rules pack we delivered (the tuner's next-night baseline) + what changed and why.
      ...(tuning.rules ? { rules: tuning.rules } : {}),
      ruleChanges: tuning.changes,
      // Conversion-action volumes (billing basis, record-only until priced) + outcomes.
      actions: { byRule: actionRollup, shown: actionTotals.shown, converted: actionTotals.converted },
      devTasksProposed: devTasks.length,
      devTasksFiled: filedDevTasks.length,
      planCompletion: planTotals,
      popupBilling,
      createdAt: FieldValue.serverTimestamp(),
    });
    const monthKey = dateKey.slice(0, 6);
    await db
      .collection('organisations')
      .doc(orgId)
      .set({ sessionMeter: { [monthKey]: FieldValue.increment(segments.total) } }, { merge: true });

    summary.status = 'ok';
    summary.packRunId = packRunId;
    summary.sessions = segments.total;
    summary.demandRows = demandMap.length;
    summary.messages = messages.length;
    summary.anomalies = anomalies.length;
    return summary;
  } catch (e) {
    console.error('sessionIntelligence:org', orgId, e?.message || e);
    summary.status = 'error';
    summary.reason = e?.message || String(e);
    return summary;
  }
}

export const sessionIntelligence = onSchedule(
  {
    region: REGION,
    schedule: '30 2 * * *',
    timeZone: 'Asia/Kolkata',
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const db = getFirestore();
    const snap = await db.collection('organisations').where('sourcing.enabled', '==', true).get();
    for (const orgDoc of snap.docs) {
      const cfg = orgDoc.data().sourcing || {};
      if (!cfg.intelligence?.enabled) continue;
      const summary = await runIntelligenceForOrg(db, orgDoc.id, cfg);
      console.log('sessionIntelligence:done', orgDoc.id, JSON.stringify(summary));
    }
  },
);

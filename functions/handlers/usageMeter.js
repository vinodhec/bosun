/**
 * POST /usageMeter — receive a usage event from a customer's platform, price it, and bill it.
 *
 * Second inbound customer→Bosun endpoint (after sourcingCompose) and the first METERED one: the
 * service was rendered on the CUSTOMER's infrastructure (their sweep auto-published a Bosun-sourced
 * listing), so there is no in-request work to settle — the customer reports what happened and this
 * endpoint prices it. Events carry no price on the wire by design; the rate lives in
 * shared/billing.js (AUTOPOST_USAGE_PRICE_PAISE) and nowhere on the customer's side.
 *
 * Auth mirrors sourcingCompose exactly: the customer signs `${timestamp}.${rawBody}` with the same
 * per-org relay secret from the vault (orgSecrets/{orgId}.sourcing.secret).
 *
 * Idempotent per (orgId, service, idempotencyKey): the customer's key is their lead id, and their
 * claim transaction guarantees one publish per lead — so a redelivered or replayed event is a
 * charged:0 no-op. This is what makes historical replay safe: a customer can re-send its whole
 * ledger after an outage and only unbilled events settle.
 *
 * Billing: ₹0.50 per auto_post event, held in paise and accrued on the org
 * (`autopostAccrualPaise`) with whole rupees debited as the accrual crosses ₹1 — the same
 * "sum, then round once" discipline compose uses (see shared/billing.js).
 *
 * Request  { orgId, service:'auto_post', qty, idempotencyKey, leadId, refId, propertyId, displayId }
 *          headers: x-bosun-signature: sha256=…, x-bosun-timestamp: <ms>
 * Response { ok, charged, duplicate? }
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  AUTOPOST_USAGE_PRICE_PAISE,
  WA_MESSAGE_DELIVERED_PRICE_PAISE,
  DAILY_PLAN_PRICE_PAISE,
  SEO_REPORT_REPLAY_PRICE_PAISE,
  BLOG_CLASSIFY_PRICE_PAISE,
  EOD_SUMMARY_PRICE_PAISE,
  accrueComposeCharge,
  isServicePaused,
} from '../shared/billing.js';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';

const REGION = 'asia-south1';
const METER_LOG = 'usage_meter_log';

/**
 * Per-service pricing + ledger identity. Unknown services are rejected, not defaulted — a typo must
 * not bill. Each service accrues on its OWN org field (paise) and writes its own transaction kind,
 * so the operator's ledger stays legible per service line.
 *
 * The WhatsApp pair arrives as service:'whatsapp_outreach' with the concrete event in `event`
 * (the platform's bosunMeter payload shape) — normalised below. `daily_plan` is normally settled
 * in-process by planDailyTasks; registering it here means a ledger replay/backfill through this
 * endpoint prices identically and dedupes on the same log row.
 */
const SERVICE_DEFS = {
  auto_post: {
    pricePaise: AUTOPOST_USAGE_PRICE_PAISE,
    accrualField: 'autopostAccrualPaise',
    kind: 'autopost_usage',
    label: 'Auto-posted listing service',
  },
  wa_message_delivered: {
    pricePaise: WA_MESSAGE_DELIVERED_PRICE_PAISE,
    accrualField: 'waAccrualPaise',
    kind: 'whatsapp_usage',
    label: 'WhatsApp outreach — delivered message',
  },
  daily_plan: {
    pricePaise: DAILY_PLAN_PRICE_PAISE,
    accrualField: 'plannerAccrualPaise',
    kind: 'daily_plan',
    label: 'Nightly admin work-queue plan',
  },
  // Normally settled in-process by seoWeeklyReport at the flat held price; this tracks the same
  // constant so a ledger replay prices identically — after any successful run the shared log row
  // makes such a replay a charged:0 no-op anyway.
  seo_weekly_report: {
    pricePaise: SEO_REPORT_REPLAY_PRICE_PAISE,
    accrualField: 'seoReportAccrualPaise',
    kind: 'seo_weekly_report',
    label: 'Weekly SEO report',
  },
  // Normally settled in-process by blogIntelligence (amount = price × blogs classified that run,
  // accrued via blogClassifyAccrualPaise). Registered here so a ledger replay/backfill of a single
  // classified blog prices identically; the in-process log row makes a post-settle replay a no-op.
  blog_classify: {
    pricePaise: BLOG_CLASSIFY_PRICE_PAISE,
    accrualField: 'blogClassifyAccrualPaise',
    kind: 'blog_classify',
    label: 'Blog audience classification',
  },
  // Normally settled in-process by eodSummary on the platform's ack (charged only on sent > 0);
  // registered here so a ledger replay/backfill prices identically and dedupes on the same row.
  eod_summary: {
    pricePaise: EOD_SUMMARY_PRICE_PAISE,
    accrualField: 'eodSummaryAccrualPaise',
    kind: 'eod_summary',
    label: 'EOD WhatsApp team summary',
  },
};

export const usageMeter = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    logReject('usageMeter', { status: 405, reason: 'non-POST-method', extra: { method: req.method } });
    res.status(405).json({ error: 'POST only' });
    return;
  }

  // The signature covers the EXACT bytes sent — rawBody, never a re-serialised req.body.
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    logReject('usageMeter', { status: 400, reason: 'body-not-valid-json', extra: { bytes: raw.length } });
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const orgId = String(body.orgId || '');
  // The WhatsApp meter reports service:'whatsapp_outreach' with the billable event name in `event`
  // and its dedupe key in `eventId` — normalise both to the generic (service, idempotencyKey) pair.
  let service = String(body.service || '');
  if (service === 'whatsapp_outreach' && body.event) service = String(body.event);
  const idempotencyKey = String(body.idempotencyKey || body.eventId || '');
  const qty = Math.min(10, Math.max(1, Math.floor(Number(body.qty) || 1)));
  if (!orgId || !service || !idempotencyKey) {
    logReject('usageMeter', {
      orgId,
      status: 400,
      reason: 'missing-required-field',
      extra: { hasOrgId: !!orgId, hasService: !!service, hasIdempotencyKey: !!idempotencyKey },
    });
    res.status(400).json({ error: 'orgId, service and idempotencyKey are required' });
    return;
  }
  const def = SERVICE_DEFS[service];
  const unitPaise = def?.pricePaise;
  if (!unitPaise) {
    logReject('usageMeter', {
      orgId,
      status: 400,
      reason: 'unknown-service',
      extra: { service, known: Object.keys(SERVICE_DEFS) },
    });
    res.status(400).json({ error: `unknown service: ${service}` });
    return;
  }

  const db = getFirestore();

  // Auth: the org's own relay secret, straight from the vault — never readable by a browser.
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    logReject('usageMeter', { orgId, status: 403, reason: 'org-has-no-sourcing-secret', extra: { orgSecretsDocExists: secretSnap.exists } });
    res.status(403).json({ error: 'sourcing not configured for this org' });
    return;
  }
  const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
  if (!auth.ok) {
    // The reason stays in OUR logs only — the response is a flat 401 so a caller can't probe which
    // half of the credential was wrong.
    logReject('usageMeter', { orgId, status: 401, reason: auth.reason, extra: { skewMs: auth.skewMs ?? null, bytes: raw.length } });
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  // Idempotency: the customer keys events by lead id, and their own claim transaction guarantees a
  // lead publishes once — so an already-logged key is a redelivery, acknowledged and unbilled.
  const logRef = db.collection(METER_LOG).doc(`${orgId}:${service}:${idempotencyKey}`);
  const existing = await logRef.get();
  if (existing.exists) {
    // Not an error — this is the idempotency guarantee doing its job, and during a historical
    // ledger replay it's the signal that the already-billed events are being skipped correctly.
    console.log('usageMeter:duplicate', orgId, JSON.stringify({ service, idempotencyKey }));
    res.status(200).json({ ok: true, duplicate: true, charged: 0 });
    return;
  }

  // Settle: accrue the paise, debit whole rupees when they cross ₹1, and write the log row — all in
  // ONE transaction, so the accrual carry can never drift from the money. The log row doubles as
  // the idempotency key, exactly like the compose log.
  let charged = 0;
  try {
    charged = await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return 0;
      const dupe = await tx.get(logRef);
      if (dupe.exists) return 0; // raced with a concurrent identical event

      const org = orgSnap.data();

      // Waived line (testing / goodwill): record it for idempotency + reconciliation, charge nothing.
      if (isServicePaused(org, service)) {
        tx.set(logRef, {
          orgId,
          service,
          idempotencyKey,
          qty,
          leadId: String(body.leadId || ''),
          refId: String(body.refId || ''),
          pricePaise: unitPaise,
          debitInr: 0,
          waived: true,
          waivedPaise: unitPaise * qty,
          createdAt: FieldValue.serverTimestamp(),
        });
        return 0;
      }

      const { debitInr, accrualPaise } = accrueComposeCharge(org[def.accrualField], unitPaise * qty);

      const update = { [def.accrualField]: accrualPaise };
      if (debitInr > 0) {
        // Org may go negative — same policy as the sourcing batch debit; the operator reconciles.
        update.balance = Number(org.balance ?? 0) - debitInr;
        tx.set(db.collection('transactions').doc(), {
          orgId,
          type: 'debit',
          kind: def.kind,
          amount: debitInr,
          // Sub-₹1 unit prices settle several events per ledger row — record how many it covered.
          count: Math.max(1, Math.round((debitInr * 100) / unitPaise)),
          description: `${def.label} (₹${(unitPaise / 100).toFixed(2)} × ${Math.max(1, Math.round((debitInr * 100) / unitPaise))})`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, {
        orgId,
        service,
        idempotencyKey,
        qty,
        leadId: String(body.leadId || ''),
        refId: String(body.refId || ''),
        propertyId: String(body.propertyId || ''),
        displayId: String(body.displayId || ''),
        pricePaise: unitPaise,
        debitInr,
        createdAt: FieldValue.serverTimestamp(),
      });
      return debitInr;
    });
  } catch (e) {
    // The event is the customer telling us work already happened — failing the request makes them
    // retry, which the idempotency key absorbs. Fail loudly so it's visible.
    console.error('usageMeter:bill:err', orgId, service, idempotencyKey, e?.message || e);
    res.status(500).json({ error: 'billing failed — retry' });
    return;
  }

  console.log('usageMeter:ok', orgId, service, JSON.stringify({ idempotencyKey, qty, charged }));
  res.status(200).json({ ok: true, charged });
});

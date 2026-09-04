/**
 * Metered service registry + the ONE settle transaction behind it.
 *
 * Every metered line in Bosun follows the same three rules, and they only stay true if there is a
 * single implementation of them:
 *   1. Price is resolved on OUR side, from the org doc — never carried on the wire, never shown on
 *      a customer surface (see priceForService in shared/billing.js).
 *   2. Sub-rupee prices ACCRUE in paise on the org and debit whole rupees as the accrual crosses
 *      ₹1 — "sum, then round once", so a ₹0.25 line can't round to ₹1 four times.
 *   3. The idempotency log row and the money move in ONE transaction, so a redelivery is a
 *      charged:0 no-op and the accrual carry can never drift from the balance.
 *
 * This module was extracted when the defect lane became the eighth caller of that transaction. It
 * owns the service table (previously inline in handlers/usageMeter.js) so the price, the accrual
 * field and the ledger `kind` for a line are declared in exactly one place; `usageMeter` (the
 * customer-facing HTTP meter) and any in-process settler both go through `settleMetered`.
 */
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import {
  AUTOPOST_USAGE_PRICE_PAISE,
  WA_MESSAGE_DELIVERED_PRICE_PAISE,
  DAILY_PLAN_PRICE_PAISE,
  SEO_REPORT_REPLAY_PRICE_PAISE,
  BLOG_CLASSIFY_PRICE_PAISE,
  EOD_SUMMARY_PRICE_PAISE,
  DM_COMPOSE_PRICE_PAISE,
  DEFECT_TRIAGE_PRICE_PAISE,
  DEFECT_FIX_PRICE_PAISE,
  DEFECT_REGRESSION_TEST_PRICE_PAISE,
  DEFECT_SLA_REPORT_PRICE_PAISE,
  CONSOLE_MINUTE_PRICE_PAISE,
  accrueComposeCharge,
  isServicePaused,
  priceForService,
} from '../shared/billing.js';

export const METER_LOG = 'usage_meter_log';

/**
 * Per-service pricing + ledger identity. Unknown services are rejected, not defaulted — a typo must
 * not bill. Each service accrues on its OWN org field (paise) and writes its own transaction kind,
 * so the operator's ledger stays legible per service line.
 *
 * `pricePaise` here is the DEFAULT. An org carrying `pricing[service]` is billed that instead — the
 * price is read from the same org snapshot the debit uses, inside the settle transaction.
 */
export const SERVICE_DEFS = {
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
  // Normally settled in-process by dmCompose on a successful composition (a degraded response is
  // free); registered here so a ledger replay prices identically and dedupes on the same row.
  dm_compose: {
    pricePaise: DM_COMPOSE_PRICE_PAISE,
    accrualField: 'dmComposeAccrualPaise',
    kind: 'dm_compose',
    label: 'Phone-hunt DM composed',
  },
  // ── Defect tracking ───────────────────────────────────────────────────────────────────────────
  // `defect_triage` is settled in-process by defectIntake, and ONLY when the dedupe gate passes — a
  // duplicate report is never metered, because stopping the work is the gate's entire value. The
  // other three arrive over the HTTP meter from the customer's platform, on the lifecycle events
  // only it can observe: the reporter's own confirmation, a merged regression test, a delivered
  // SLA report.
  defect_triage: {
    pricePaise: DEFECT_TRIAGE_PRICE_PAISE,
    accrualField: 'defectTriageAccrualPaise',
    kind: 'defect_triage',
    label: 'Defect triage — spec + evidence pack',
  },
  defect_fix: {
    pricePaise: DEFECT_FIX_PRICE_PAISE,
    accrualField: 'defectFixAccrualPaise',
    kind: 'defect_fix',
    label: 'Defect fixed — confirmed by reporter',
  },
  defect_regression_test: {
    pricePaise: DEFECT_REGRESSION_TEST_PRICE_PAISE,
    accrualField: 'defectTestAccrualPaise',
    kind: 'defect_regression_test',
    label: 'Regression test — merged',
  },
  defect_sla_report: {
    pricePaise: DEFECT_SLA_REPORT_PRICE_PAISE,
    accrualField: 'defectReportAccrualPaise',
    kind: 'defect_sla_report',
    label: 'Weekly defect SLA report',
  },
  // Chat & code: reported by Bosun's OWN console box (handlers/consoleTasks.js#consoleHook), one
  // event per minute a session is live — minute 1 at session start. Time, not work, is the unit.
  console_minute: {
    pricePaise: CONSOLE_MINUTE_PRICE_PAISE,
    accrualField: 'consoleMinuteAccrualPaise',
    kind: 'console_minute',
    label: 'Chat & code — session minute',
  },
};

/** The meter-log doc id for one event. Also the idempotency key — one row, one settle, forever. */
export function meterLogId(orgId, service, idempotencyKey) {
  return `${orgId}:${service}:${idempotencyKey}`;
}

/**
 * Settle one metered event: accrue, debit whole rupees on the ₹1 crossing, write the ledger row and
 * the idempotency row — atomically.
 *
 * Returns { charged, duplicate, waived, pricePaise }:
 *   - `duplicate: true` — an identical (org, service, key) already settled. Charged 0. This is the
 *     guarantee working, not an error: it is what makes a retry after a timeout, a redelivery, and
 *     a full historical ledger replay all safe.
 *   - `waived: true`  — the line is paused for this org (testing / goodwill). The log row is still
 *     written (so re-runs stay no-ops) but the debit is skipped and `waivedPaise` recorded, so the
 *     operator can reconcile with an exact number when the line goes live.
 *
 * A missing org is charged 0 rather than throwing: the caller has already done the work, and an
 * exception here would only make them retry into the same wall.
 *
 * @param {object}  p
 * @param {string}  p.orgId
 * @param {string}  p.service          key in SERVICE_DEFS
 * @param {string}  p.idempotencyKey   caller-stable; the same event must always produce the same key
 * @param {number} [p.qty=1]           units this event covers (price × qty)
 * @param {string} [p.description]     ledger line text; defaults to the service label
 * @param {object} [p.extra]           extra fields to record on the log row (audit trail)
 */
export async function settleMetered({
  orgId,
  service,
  idempotencyKey,
  qty = 1,
  description = '',
  extra = {},
  db = getFirestore(),
}) {
  const def = SERVICE_DEFS[service];
  if (!def) throw new Error(`settleMetered: unknown service ${service}`);
  if (!orgId || !idempotencyKey) throw new Error('settleMetered: orgId and idempotencyKey are required');

  const units = Math.max(1, Math.floor(Number(qty) || 1));
  const logRef = db.collection(METER_LOG).doc(meterLogId(orgId, service, idempotencyKey));

  // Cheap pre-check outside the transaction — the common replay path costs one read, not a write
  // lock on the org doc. The in-transaction re-read below is what actually guarantees correctness.
  if ((await logRef.get()).exists) {
    return { charged: 0, duplicate: true, waived: false, pricePaise: def.pricePaise };
  }

  return db.runTransaction(async (tx) => {
    const orgRef = db.collection('organisations').doc(orgId);
    const orgSnap = await tx.get(orgRef);
    if (!orgSnap.exists) return { charged: 0, duplicate: false, waived: false, pricePaise: def.pricePaise };
    const dupe = await tx.get(logRef);
    if (dupe.exists) return { charged: 0, duplicate: true, waived: false, pricePaise: def.pricePaise };

    const org = orgSnap.data();
    // This org's live price — its own override if it carries one, else the module default.
    const pricePaise = priceForService(org, service, def.pricePaise);
    const row = {
      orgId,
      service,
      idempotencyKey,
      qty: units,
      pricePaise,
      createdAt: FieldValue.serverTimestamp(),
      ...extra,
    };

    if (isServicePaused(org, service)) {
      tx.set(logRef, { ...row, debitInr: 0, waived: true, waivedPaise: pricePaise * units });
      return { charged: 0, duplicate: false, waived: true, pricePaise };
    }

    const { debitInr, accrualPaise } = accrueComposeCharge(org[def.accrualField], pricePaise * units);
    const update = { [def.accrualField]: accrualPaise };
    if (debitInr > 0) {
      // Sub-₹1 unit prices settle several events per ledger row — record how many it covered.
      const covered = pricePaise > 0 ? Math.max(1, Math.round((debitInr * 100) / pricePaise)) : units;
      // Org may go negative — same policy as the sourcing batch debit; the operator reconciles.
      update.balance = Number(org.balance ?? 0) - debitInr;
      tx.set(db.collection('transactions').doc(), {
        orgId,
        type: 'debit',
        kind: def.kind,
        amount: debitInr,
        count: covered,
        description: description || `${def.label} (₹${(pricePaise / 100).toFixed(2)} × ${covered})`,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(orgRef, update);
    tx.set(logRef, { ...row, debitInr });
    return { charged: debitInr, duplicate: false, waived: false, pricePaise };
  });
}

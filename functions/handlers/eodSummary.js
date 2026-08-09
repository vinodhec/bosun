/**
 * eodSummary — evening WhatsApp digest of the day's admin work-plan, per org.
 *
 * At 18:30 IST (after the calling day, before the founder's evening check) this job asks the
 * PLATFORM to aggregate today's team scoreboard and WhatsApp it to the org's configured staff
 * numbers. All the heavy lifting (plan reconciliation, deal attribution, message composition,
 * Gupshup delivery) runs on the customer's infrastructure — Bosun's service is orchestrating +
 * scheduling it, billed FLAT per summary-day (EOD_SUMMARY_PRICE_PAISE) and charged only when the
 * platform acks `sent > 0`. A day with no plans, or one where every send fails, is free.
 *
 * Rest days: skipped on the team's weekly holiday (Sunday), off the PLANNER's `restDays` — the day
 * has no plan to summarise, so a digest of zeros would be the only thing to send.
 *
 * Org config (organisations/{orgId}.sourcing.eodSummary):
 *   { enabled: true, url: 'https://…/api/ingest/eod-summary', recipients: ['919443125052', …] }
 *
 * Idempotency mirrors daily_plan: the settle log row `${orgId}:eod_summary:${dateKey}` doubles as
 * "this day is already summarised & billed" — the platform additionally dedupes sends on its own
 * eod_summary_log, so even a crash between ack and settle can never double-message the staff
 * (the retry's ack comes back {duplicate:true} with the original sent count, and we settle then).
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { signPayload } from '../utils/sourcing.js';
import { EOD_SUMMARY_PRICE_PAISE, accrueComposeCharge, isServicePaused } from '../shared/billing.js';
import { istDateKey, isRestDay } from './planDailyTasks.js';

const REGION = 'asia-south1';
const METER_LOG = 'usage_meter_log';
const POST_TIMEOUT_MS = 60000; // reconcile + conversions + N sends on the platform side — generous

/** Summarise one org's day. Returns a summary object (never throws — must not break the org loop). */
export async function runEodForOrg(db, orgId, cfg) {
  const dateKey = istDateKey();
  const summary = { orgId, dateKey, status: 'skipped' };
  try {
    const eod = cfg.eodSummary || {};
    if (!eod.enabled || !eod.url) {
      summary.reason = !eod.enabled ? 'disabled' : 'no-url';
      return summary;
    }

    // Rest day — nobody worked, and the planner withheld the day, so there is no scoreboard to
    // summarise. Skipped outright rather than sending a digest of zeros to the staff's phones.
    // Read from the PLANNER's config on purpose: ONE rest-day setting governs the whole day, so a
    // plan and its evening summary can never disagree about whether the team was working.
    if (isRestDay(cfg.planner || {})) {
      summary.reason = 'weekly-holiday';
      return summary;
    }

    // Idempotency pre-check — the settle log doubles as "this day is already summarised & billed".
    const logRef = db.collection(METER_LOG).doc(`${orgId}:eod_summary:${dateKey}`);
    if ((await logRef.get()).exists) {
      summary.reason = 'already-summarised';
      return summary;
    }

    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) {
      summary.status = 'error';
      summary.reason = 'no-secret';
      return summary;
    }

    const recipients = Array.isArray(eod.recipients) ? eod.recipients.filter(Boolean).map(String) : [];
    const body = JSON.stringify({ orgId, dateKey, recipients });
    const signed = signPayload(secret, body);
    const resp = await fetch(eod.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bosun-signature': signed.signature,
        'x-bosun-timestamp': signed.timestamp,
      },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      summary.status = 'error';
      summary.reason = `eod-post-http-${resp.status}`;
      return summary;
    }
    const ack = await resp.json().catch(() => ({}));
    const sent = Number(ack.sent) || 0;
    summary.sent = sent;
    summary.duplicate = ack.duplicate === true;

    // Nothing delivered (no plans today / all sends failed) → nothing to bill, and no log row so a
    // later manual replay of the day can still succeed.
    if (sent === 0) {
      summary.status = 'ok';
      summary.reason = ack.reason || 'nothing-sent';
      return summary;
    }

    // Settle — flat per summary-day, one transaction, log row = idempotency key. Charged on the ack
    // even when the platform reports {duplicate:true}: the charge follows the FIRST acknowledged
    // delivery for the day, and the pre-check above means we only reach here unbilled.
    const charged = await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return 0;
      const dupe = await tx.get(logRef);
      if (dupe.exists) return 0;
      const org = orgSnap.data();

      // Waived line (testing / goodwill): log it for idempotency + reconciliation, charge nothing.
      if (isServicePaused(org, 'eod_summary')) {
        tx.set(logRef, {
          orgId,
          service: 'eod_summary',
          idempotencyKey: dateKey,
          qty: 1,
          sent,
          pricePaise: EOD_SUMMARY_PRICE_PAISE,
          debitInr: 0,
          waived: true,
          waivedPaise: EOD_SUMMARY_PRICE_PAISE,
          createdAt: FieldValue.serverTimestamp(),
        });
        return 0;
      }

      const { debitInr, accrualPaise } = accrueComposeCharge(org.eodSummaryAccrualPaise, EOD_SUMMARY_PRICE_PAISE);
      const update = { eodSummaryAccrualPaise: accrualPaise };
      if (debitInr > 0) {
        update.balance = Number(org.balance ?? 0) - debitInr;
        tx.set(db.collection('transactions').doc(), {
          orgId,
          type: 'debit',
          kind: 'eod_summary',
          amount: debitInr,
          count: 1, // one summary-day — adminMetrics sums `count` for the lane's Units column
          description: `EOD WhatsApp team summary (${dateKey}, ${sent} recipient${sent === 1 ? '' : 's'})`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, {
        orgId,
        service: 'eod_summary',
        idempotencyKey: dateKey,
        qty: 1,
        sent,
        pricePaise: EOD_SUMMARY_PRICE_PAISE,
        debitInr,
        createdAt: FieldValue.serverTimestamp(),
      });
      return debitInr;
    });

    summary.status = 'ok';
    summary.chargedInr = charged;
    return summary;
  } catch (e) {
    console.error('eodSummary:org', orgId, e?.message || e);
    summary.status = 'error';
    summary.reason = e?.message || String(e);
    return summary;
  }
}

// Evening at 18:30 IST — after the calling day, in time for the founder's evening check.
export const eodSummary = onSchedule(
  {
    region: REGION,
    schedule: '30 18 * * *',
    timeZone: 'Asia/Kolkata',
    timeoutSeconds: 300,
    memory: '256MiB',
  },
  async () => {
    const db = getFirestore();
    const snap = await db.collection('organisations').where('sourcing.enabled', '==', true).get();
    for (const orgDoc of snap.docs) {
      const cfg = orgDoc.data().sourcing || {};
      if (!cfg.eodSummary?.enabled) continue;
      const summary = await runEodForOrg(db, orgDoc.id, cfg);
      console.log('eodSummary:done', orgDoc.id, JSON.stringify(summary));
    }
  },
);

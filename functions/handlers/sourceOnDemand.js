/**
 * POST /sourceOnDemand — the platform's "source THIS place, NOW" trigger (customer→Bosun, HMAC).
 *
 * Born from the buyer queue: an admin has a live buyer wanting e.g. "2BHK rent in Neelambur" and
 * the shelf is empty — waiting for the locality to rotate to the top of the cron's demand ranking
 * loses the buyer. This endpoint runs ONE targeted supply leg for a locality/city the PLATFORM
 * names, immediately: Gemini bilingual queries → SERP fetch → the full gate pipeline → signed relay
 * to the org webhook → charge-on-delivery, exactly like a cron leg. The platform's admin UI polls
 * its own sourced-lead queue while this runs — leads land there through the ordinary webhook as
 * each relay 2xxes, so the caller does not need to survive until this responds.
 *
 * Auth mirrors sourcingPlanNow/usageMeter exactly: the platform signs `${timestamp}.${rawBody}`
 * with the per-org relay secret (orgSecrets/{orgId}.sourcing.secret).
 *
 * Deliberately NOT gated on sourcing.enabled (like the operator's adminRunSourcingNow) — pausing
 * the daily crons must not take away the on-demand button; the pending-cap backpressure does not
 * apply either, because a human asking for THIS locality is the opposite of an unread backlog.
 * What does gate it: a per-org cooldown (below), because every call costs real Apify credit and
 * the org wallet is debited per relayed lead.
 *
 * Request  { orgId, locality, city, listingType?: 'Sale'|'Rent'|'Lease', propertyType?, requestId? }
 *          headers: x-bosun-signature: sha256=…, x-bosun-timestamp: <ms>
 * Response { ok, runId, relayed, amountInr, examined?, note? } — the same summary shape the
 *          operator's run-now buttons return; 429 with retryAfterSeconds while cooling down.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { runForOrg } from './runSourcingJobs.js';
import { startRun } from '../utils/sourcingRun.js';
import { buildSourcingQueries } from '../utils/queryGen.js';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { APIFY_TOKEN } from '../utils/secrets.js';

const REGION = 'asia-south1';

// One targeted leg measures 1–3 min; a stuck SERP actor should die well before the platform's
// admin gives up on the panel, not at the scheduler's 25-minute wall.
const TIMEOUT_SECONDS = 540;

// Every call spends Apify credit and can debit the wallet, and the trigger sits one click from a
// buyer card — so back-to-back clicks for the same org wait out the previous run. 90s is longer
// than a duplicate double-click and shorter than the run it protects.
const COOLDOWN_MS = 90 * 1000;

export const sourceOnDemand = onRequest(
  { region: REGION, cors: false, timeoutSeconds: TIMEOUT_SECONDS, memory: '512MiB', secrets: [APIFY_TOKEN] },
  async (req, res) => {
    if (req.method !== 'POST') {
      logReject('sourceOnDemand', { status: 405, reason: 'non-POST-method', extra: { method: req.method } });
      res.status(405).json({ error: 'POST only' });
      return;
    }
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      logReject('sourceOnDemand', { status: 400, reason: 'body-not-valid-json', extra: { bytes: raw.length } });
      res.status(400).json({ error: 'invalid JSON' });
      return;
    }

    const orgId = String(body.orgId || '').trim();
    const locality = String(body.locality || '').trim();
    const city = String(body.city || '').trim();
    const listingType = String(body.listingType || '').trim();
    const propertyType = String(body.propertyType || '').trim();
    if (!orgId || (!locality && !city)) {
      res.status(400).json({ error: 'orgId and a locality or city are required' });
      return;
    }

    const db = getFirestore();
    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) {
      logReject('sourceOnDemand', { orgId, status: 403, reason: 'org-has-no-sourcing-secret' });
      res.status(403).json({ error: 'sourcing not configured for this org' });
      return;
    }
    const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
    if (!auth.ok) {
      logReject('sourceOnDemand', { orgId, status: 401, reason: auth.reason });
      res.status(401).json({ error: 'bad signature' });
      return;
    }

    const orgRef = db.collection('organisations').doc(orgId);
    const orgSnap = await orgRef.get();
    if (!orgSnap.exists) {
      res.status(404).json({ error: 'organisation not found' });
      return;
    }
    const cfg = orgSnap.data().sourcing || {};
    if (!cfg.actorId || !cfg.webhookUrl) {
      res.status(409).json({ error: 'org has no sourcing relay (actorId + webhookUrl) configured' });
      return;
    }

    // Cooldown — claimed atomically BEFORE any spend, so two racing clicks cost one run. The stamp
    // is a plain field on the org (non-secret operational state, like buyerCursor).
    const now = Date.now();
    try {
      await db.runTransaction(async (txn) => {
        const fresh = await txn.get(orgRef);
        const last = Number(fresh.data()?.sourcing?.lastOnDemandAtMs) || 0;
        if (now - last < COOLDOWN_MS) {
          const retryAfterSeconds = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
          const err = new Error('cooldown');
          err.retryAfterSeconds = retryAfterSeconds;
          throw err;
        }
        txn.update(orgRef, { 'sourcing.lastOnDemandAtMs': now });
      });
    } catch (e) {
      if (e?.message === 'cooldown') {
        res.status(429).json({ error: 'an on-demand run just started for this org — try again shortly', retryAfterSeconds: e.retryAfterSeconds });
        return;
      }
      throw e;
    }

    // From here this is exactly one cron leg: same query builder, same gate pipeline, same audit
    // trail (a 'platform-on-demand' row in the run panel), same charge-on-delivery relay.
    const run = startRun(db, orgId, 'platform-on-demand');
    try {
      const shape = [propertyType, listingType].filter(Boolean).join(' ') || undefined;
      const smart = await buildSourcingQueries({ locality: locality || city, city, shape, mode: 'supply' });
      const queries = smart.queries || [];
      const target = { locality: locality || city, city, shape: [propertyType, listingType].filter(Boolean).join(' · ') || undefined };
      const leg = run.leg({ target, queries, meta: { ...smart, requestId: String(body.requestId || '') || undefined }, mode: 'supply' });
      if (!queries.length) {
        leg.done({ note: 'query generation produced nothing' });
        await run.finish();
        res.status(200).json({ ok: true, runId: run.id, relayed: 0, amountInr: 0, note: 'no queries' });
        return;
      }
      const r = await runForOrg(db, process.env.APIFY_TOKEN, orgId, cfg, { queries, target, leg, mode: 'supply' });
      await run.finish();
      console.log('sourceOnDemand:done', orgId, JSON.stringify({ runId: run.id, locality, city, listingType, relayed: r.relayed || 0, amountInr: r.amountInr || 0 }));
      res.status(200).json({ ok: true, runId: run.id, relayed: r.relayed || 0, amountInr: r.amountInr || 0, ...(r.examined != null ? { examined: r.examined } : {}) });
    } catch (e) {
      await run.finish({ status: 'error', error: e?.message || String(e) });
      console.error('sourceOnDemand:err', orgId, e?.message || e);
      res.status(502).json({ error: 'sourcing run failed', detail: e?.message || String(e) });
    }
  },
);

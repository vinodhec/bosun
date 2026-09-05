/**
 * Listing reels — the job endpoint + the worker (customer→Bosun, HMAC-signed).
 *
 * The website assistant's `make_reel` tool lands here: the platform POSTs the listing (fields +
 * photo URLs) and gets a job id back at once; a Firestore trigger makes the video (utils/reel.js,
 * 1–3 minutes), uploads it, meters ONE `reel_photo` / `reel_animated` unit on the DELIVERED file,
 * and the widget polls `status` until it can play it.
 *
 *   action:'create'  { orgId, conversationId?, style:'photo'|'animated', locale, listing:{…}, requestedBy?, site }
 *                    → { ok, jobId, status, style, etaSeconds, existing?, videoUrl?, posterUrl?, listingId, title }
 *   action:'status'  { orgId, jobId } → { ok, jobId, status, style, styleDelivered, videoUrl, posterUrl, durationSec, listingId, title, listingUrl, error? }
 *
 * Why a Firestore trigger and not the request: Veo alone can take two minutes, and a Cloud Run
 * instance has no CPU after it answers. `reelJobs/{id}` is written `queued`, `processReelJob`
 * claims it in a transaction (so a redelivered event cannot render twice), and every outcome —
 * ready, failed, degraded-to-photo — lands on the same doc. `reelLatest/{org__listing__style}` is
 * a pointer to the newest job for a listing so a second ask within 24 h gets the same video for
 * free instead of a second render (no composite index needed).
 *
 * Guards, in order: HMAC → org enabled (`org.reel.enabled !== false`) → wallet (NEGATIVE balance
 * refuses, waived by `reel_photo` / `agent_work` in billingPaused — a public widget is unbounded
 * demand) → per-org daily caps (`org.reel.dailyCap` 40 reels, `org.reel.animatedDailyCap` 10) →
 * per-conversation cap (3 a day). Animated for a signed-in `requestedBy` only — the platform
 * enforces it first; this is the backstop. Money rules: settled by `settleMetered`, idempotent on
 * the job id, and a failed job bills nothing.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import fs from 'node:fs/promises';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { settleMetered } from '../utils/meter.js';
import { blocksNewWork, isServicePaused } from '../shared/billing.js';
import { buildReel, uploadReel, makeScratchDir, MAX_PHOTOS } from '../utils/reel.js';

const REGION = 'asia-south1';
export const JOBS = 'reelJobs';
export const LATEST = 'reelLatest';
const USAGE = 'reelUsage';
/** Job docs (and the pointer) expire — set the TTL once:
 *    gcloud firestore fields ttls update expiresAt --collection-group=reelJobs --enable-ttl */
export const TTL_DAYS = 30;
export const DEFAULT_ORG_DAILY_CAP = 40;
export const DEFAULT_ANIMATED_DAILY_CAP = 10;
export const DEFAULT_CONVERSATION_DAILY_CAP = 3;
/** A ready reel younger than this is reused for the same listing + style (no new job, no charge). */
const REUSE_MS = 24 * 3600 * 1000;
const ETA_SECONDS = { photo: 75, animated: 180 };

function istDayKey(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function s(v, max) {
  return String(v ?? '').trim().slice(0, max);
}
function latestId(orgId, listingId, style) {
  return `${orgId}__${listingId}__${style}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300);
}

/** The listing as we keep it on the job — every field bounded; only http(s) photo URLs survive. */
function cleanListing(raw) {
  const l = raw && typeof raw === 'object' ? raw : {};
  const images = (Array.isArray(l.images) ? l.images : [])
    .map((u) => s(u, 600))
    .filter((u) => /^https?:\/\//i.test(u));
  return {
    id: s(l.id, 80),
    title: s(l.title, 140),
    price: Number(l.price) || 0,
    priceLabel: s(l.priceLabel, 40),
    listingType: ['sale', 'rent'].includes(l.listingType) ? l.listingType : '',
    propertyType: s(l.propertyType, 24),
    bhk: Number(l.bhk) || null,
    areaSqft: Number(l.areaSqft) || null,
    locality: s(l.locality, 80),
    city: s(l.city, 60),
    url: /^https?:\/\//i.test(s(l.url, 400)) ? s(l.url, 400) : '',
    description: s(l.description, 300),
    images: [...new Set(images)].slice(0, MAX_PHOTOS),
  };
}

/** What the platform (and through it the widget) may see of a job. */
export function publicJob(id, job) {
  return {
    jobId: id,
    status: job.status,
    style: job.style,
    styleDelivered: job.styleDelivered || null,
    etaSeconds: ETA_SECONDS[job.style] || ETA_SECONDS.photo,
    listingId: job.listing?.id || '',
    title: job.listing?.title || '',
    listingUrl: job.listing?.url || '',
    videoUrl: job.videoUrl || '',
    posterUrl: job.posterUrl || '',
    durationSec: Number(job.durationSec) || 0,
    ...(job.status === 'failed' ? { error: job.errorPublic || 'failed' } : {}),
  };
}

export const reelJobs = onRequest(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB', cors: false },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { res.status(400).json({ error: 'invalid JSON' }); return; }

    const orgId = s(body.orgId, 128);
    const action = ['create', 'status'].includes(body.action) ? body.action : '';
    if (!orgId || !action) {
      logReject('reelJobs', { orgId, status: 400, reason: 'missing-required-field', extra: { hasOrgId: !!orgId, action: body.action } });
      res.status(400).json({ error: 'orgId and a valid action are required' });
      return;
    }
    const db = getFirestore();
    const [secretSnap, orgSnap] = await Promise.all([
      db.collection('orgSecrets').doc(orgId).get(),
      db.collection('organisations').doc(orgId).get(),
    ]);
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) {
      logReject('reelJobs', { orgId, status: 403, reason: 'org-has-no-sourcing-secret' });
      res.status(403).json({ error: 'reels not configured for this org' });
      return;
    }
    const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
    if (!auth.ok) {
      logReject('reelJobs', { orgId, status: 401, reason: auth.reason, extra: { skewMs: auth.skewMs ?? null, bytes: raw.length } });
      res.status(401).json({ error: 'bad signature' });
      return;
    }

    try {
      if (action === 'status') {
        const jobId = s(body.jobId, 64).replace(/[^A-Za-z0-9_-]/g, '');
        if (!jobId) { res.status(400).json({ error: 'jobId required' }); return; }
        const snap = await db.collection(JOBS).doc(jobId).get();
        if (!snap.exists || snap.data().orgId !== orgId) { res.status(404).json({ error: 'unknown job' }); return; }
        res.status(200).json({ ok: true, ...publicJob(snap.id, snap.data()) });
        return;
      }

      // ── create ────────────────────────────────────────────────────────────────────────────
      if (!orgSnap.exists) { res.status(403).json({ error: 'unknown org' }); return; }
      const org = orgSnap.data();
      if (org.reel?.enabled === false) {
        logReject('reelJobs', { orgId, status: 403, reason: 'reels-disabled-for-org' });
        res.status(403).json({ error: 'REELS_DISABLED' });
        return;
      }
      const style = body.style === 'animated' ? 'animated' : 'photo';
      const locale = body.locale === 'ta' ? 'ta' : 'en';
      const conversationId = s(body.conversationId, 64).replace(/[^A-Za-z0-9_-]/g, '');
      const listing = cleanListing(body.listing);
      const rb = body.requestedBy && typeof body.requestedBy === 'object' && body.requestedBy.userId
        ? { userId: s(body.requestedBy.userId, 128), name: s(body.requestedBy.name, 60) }
        : null;
      const site = { name: s(body.site?.name, 40) || 'MaadiVeedu', url: /^https?:\/\//i.test(s(body.site?.url, 200)) ? s(body.site?.url, 200) : '' };
      if (!listing.id || !listing.images.length) {
        logReject('reelJobs', { orgId, status: 400, reason: 'listing-missing-id-or-photos', extra: { id: listing.id, images: listing.images.length } });
        res.status(400).json({ error: listing.images.length ? 'listing.id required' : 'NO_PHOTOS' });
        return;
      }
      if (style === 'animated' && !rb) {
        logReject('reelJobs', { orgId, status: 403, reason: 'animated-needs-signed-in-user' });
        res.status(403).json({ error: 'SIGN_IN_REQUIRED' });
        return;
      }
      const service = style === 'animated' ? 'reel_animated' : 'reel_photo';
      const waived = isServicePaused(org, 'reel_photo') || isServicePaused(org, service) || isServicePaused(org, 'agent_work');
      if (!waived && blocksNewWork(org.balance)) {
        logReject('reelJobs', { orgId, status: 402, reason: 'negative-balance', extra: { balance: org.balance ?? null } });
        res.status(402).json({ error: 'LOW_BALANCE' });
        return;
      }

      // A reel already made for this listing + style today is the answer — no second render.
      const latestRef = db.collection(LATEST).doc(latestId(orgId, listing.id, style));
      const latest = await latestRef.get();
      if (latest.exists) {
        const p = latest.data();
        const fresh = Number(p.atMs) > Date.now() - REUSE_MS;
        if (fresh && ['queued', 'running', 'ready'].includes(p.status) && p.jobId) {
          const prior = await db.collection(JOBS).doc(p.jobId).get();
          if (prior.exists && prior.data().status !== 'failed') {
            console.log('reelJobs:reuse', orgId, JSON.stringify({ jobId: p.jobId, listingId: listing.id, style, status: prior.data().status }));
            res.status(200).json({ ok: true, existing: true, ...publicJob(prior.id, prior.data()) });
            return;
          }
        }
      }

      // Caps — read, then reserve inside the same write as the job (one usage doc per org per day).
      const dayKey = istDayKey();
      const usageRef = db.collection(USAGE).doc(`${orgId}:${dayKey}`);
      const usage = (await usageRef.get()).data() || {};
      const orgCap = Number(org.reel?.dailyCap) > 0 ? Number(org.reel.dailyCap) : DEFAULT_ORG_DAILY_CAP;
      const animCap = Number(org.reel?.animatedDailyCap) > 0 ? Number(org.reel.animatedDailyCap) : DEFAULT_ANIMATED_DAILY_CAP;
      const convCap = Number(org.reel?.conversationDailyCap) > 0 ? Number(org.reel.conversationDailyCap) : DEFAULT_CONVERSATION_DAILY_CAP;
      const total = Number(usage.total) || 0;
      const animated = Number(usage.animated) || 0;
      const convCount = conversationId ? Number(usage.conversations?.[conversationId]) || 0 : 0;
      if (total >= orgCap || (style === 'animated' && animated >= animCap)) {
        logReject('reelJobs', { orgId, status: 429, reason: 'org-daily-cap', extra: { total, animated, orgCap, animCap, style } });
        res.status(429).json({ error: 'DAILY_CAP' });
        return;
      }
      if (conversationId && convCount >= convCap) {
        logReject('reelJobs', { orgId, status: 429, reason: 'conversation-daily-cap', extra: { conversationId, convCount } });
        res.status(429).json({ error: 'CONVERSATION_CAP' });
        return;
      }

      const jobRef = db.collection(JOBS).doc();
      const now = Date.now();
      const job = {
        orgId, conversationId: conversationId || null, style, styleDelivered: null, locale, listing, requestedBy: rb, site,
        status: 'queued', attempts: 0, videoUrl: '', posterUrl: '', durationSec: 0, error: null, errorPublic: null,
        chargedInr: 0, service: null,
        createdAt: FieldValue.serverTimestamp(), createdAtMs: now, startedAt: null, finishedAt: null,
        expiresAt: Timestamp.fromMillis(now + TTL_DAYS * 24 * 3600 * 1000),
      };
      const batch = db.batch();
      batch.set(jobRef, job);
      batch.set(latestRef, { orgId, listingId: listing.id, style, jobId: jobRef.id, status: 'queued', atMs: now, expiresAt: job.expiresAt });
      batch.set(usageRef, {
        orgId, dayKey, total: FieldValue.increment(1), animated: FieldValue.increment(style === 'animated' ? 1 : 0),
        ...(conversationId ? { conversations: { [conversationId]: FieldValue.increment(1) } } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await batch.commit();
      console.log('reelJobs:create', orgId, JSON.stringify({ jobId: jobRef.id, listingId: listing.id, style, locale, photos: listing.images.length, signedIn: !!rb, conversationId }));
      res.status(200).json({ ok: true, existing: false, ...publicJob(jobRef.id, job) });
    } catch (e) {
      console.error('reelJobs:err', orgId, action, e?.message || e);
      res.status(500).json({ error: 'reel request failed — retry' });
    }
  },
);

/**
 * The worker. Claims the queued job, makes the video, uploads, bills, records. Two CPUs because
 * ffmpeg is the wall clock here (a 20 s reel encodes in ~40 s on 2 vCPU, ~90 s on 1); 540 s is
 * the ceiling for photos + Veo's worst case with room to spare.
 */
export const processReelJob = onDocumentCreated(
  { document: `${JOBS}/{jobId}`, region: REGION, timeoutSeconds: 540, memory: '2GiB', cpu: 2, maxInstances: 5, retry: false },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const jobId = snap.id;
    const db = getFirestore();
    const ref = db.collection(JOBS).doc(jobId);

    // Claim — a redelivered event (or a second instance) must not render the same job twice.
    const claimed = await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists || cur.data().status !== 'queued') return null;
      tx.update(ref, { status: 'running', startedAt: FieldValue.serverTimestamp(), attempts: FieldValue.increment(1) });
      return cur.data();
    });
    if (!claimed) { console.log('reelJobs:skip-not-queued', jobId); return; }
    const job = claimed;
    const { orgId, listing, style, locale, site } = job;
    const latestRef = db.collection(LATEST).doc(latestId(orgId, listing.id, style));
    await latestRef.set({ status: 'running' }, { merge: true }).catch(() => undefined);

    const t0 = Date.now();
    const dir = await makeScratchDir(`reel-${jobId}-`);
    const log = (...a) => console.log('reel:', jobId, ...a);
    try {
      const built = await buildReel({ listing, style, locale, site, dir, log });
      const { videoUrl, posterUrl } = await uploadReel({ orgId, jobId, videoPath: built.videoPath, posterPath: built.posterPath });

      // Bill what was DELIVERED: an animated ask that fell back to photos is a photo reel.
      const service = built.styleDelivered === 'animated' ? 'reel_animated' : 'reel_photo';
      let charged = 0;
      let waived = false;
      try {
        const settled = await settleMetered({
          db, orgId, service, idempotencyKey: jobId,
          description: `Listing reel — ${built.styleDelivered} (${listing.id})`,
          extra: { jobId, listingId: listing.id, conversationId: job.conversationId || null, style, styleDelivered: built.styleDelivered, locale, durationSec: built.durationSec },
        });
        charged = settled.charged;
        waived = settled.waived;
      } catch (e) {
        console.error('reelJobs:bill:err', orgId, jobId, e?.message || e);
      }

      const done = {
        status: 'ready', styleDelivered: built.styleDelivered, fallbackReason: built.fallbackReason, videoUrl, posterUrl,
        durationSec: built.durationSec, photos: built.photos, voiced: built.voiced, script: built.script,
        service, chargedInr: charged, waived, renderMs: built.ms, totalMs: Date.now() - t0,
        finishedAt: FieldValue.serverTimestamp(), error: null, errorPublic: null,
      };
      await Promise.all([
        ref.update(done),
        latestRef.set({ status: 'ready', videoUrl, posterUrl, styleDelivered: built.styleDelivered, atMs: Date.now() }, { merge: true }),
      ]);
      console.log('reelJobs:ready', orgId, JSON.stringify({ jobId, listingId: listing.id, style, styleDelivered: built.styleDelivered, fallback: built.fallbackReason, durationSec: built.durationSec, photos: built.photos, voiced: built.voiced, charged, waived, ms: Date.now() - t0 }));
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 400);
      console.error('reelJobs:failed', orgId, jobId, msg);
      const errorPublic = /no usable photos/i.test(msg) ? 'no_photos' : 'failed';
      await Promise.all([
        ref.update({ status: 'failed', error: msg, errorPublic, finishedAt: FieldValue.serverTimestamp(), totalMs: Date.now() - t0 }),
        latestRef.set({ status: 'failed', atMs: Date.now() }, { merge: true }),
      ]).catch((e2) => console.error('reelJobs:failed:write', jobId, e2?.message || e2));
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);

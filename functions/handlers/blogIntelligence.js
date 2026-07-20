/**
 * Nightly Blog Intelligence — the agent's "who is this article for?" pass.
 *
 * The platform's conversion cards target a blog reader by AUDIENCE (buyer → live listings,
 * seller → list-it-free CTA), but a freshly published post has no audience until someone decides
 * one. This job is that someone. Each night, per org with sourcing.intelligence.enabled:
 *   1. Pull the platform's blog digest (GET /api/sourcing/blog-digest, HMAC over
 *      `${timestamp}.blog-digest`) — every published post NOT yet classified (or classified under
 *      an older CLASSIFIER_VERSION), each as title + tags + a plain-text excerpt.
 *   2. Gemini Flash reads each and returns { audience: buyer|seller|investor|neutral, topics[],
 *      confidence } — Flash not Flash-Lite (real prose needs the nuance; measured lesson).
 *   3. POST the verdicts back in an engagement-pack (`blogClassifications`), which stamps
 *      agentAudience/agentTopics onto the blog_v2 doc. The blog page reads that on the next view.
 *
 * DRAINS the backlog in one run: it loops steps 1-3 (page by page, capReturn/page) until nothing
 * unclassified remains, a pass makes no progress, or a safety pass cap. A first-run backlog clears
 * in ONE run (was ~25/night over many nights) — bounded only by the digest's newest-capScan window
 * (max 500); if the backlog is deeper, the run doc's `moreLikely` flags it. A steady site is ~0
 * work/night. A scheduler retry no-ops via the per-day run doc; billing is idempotent per IST day
 * (flat 50p/blog delivered, settled once per run — see shared/billing.js).
 *
 * Config: organisations/{orgId}.sourcing.intelligence = { enabled, digestUrl, packUrl,
 * blogDigestUrl?, capBlogs? }. blogDigestUrl defaults to digestUrl with `session-digest` →
 * `blog-digest`. Secret: orgSecrets/{orgId}.sourcing.secret.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { signPayload } from '../utils/sourcing.js';
import { generateJson, GEMINI_FLASH, geminiConfigured } from '../utils/gemini.js';
import { BLOG_CLASSIFY_PRICE_PAISE, accrueComposeCharge, isServicePaused } from '../shared/billing.js';

const METER_LOG = 'usage_meter_log';

const REGION = 'asia-south1';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const CLASSIFY_CONCURRENCY = 4;
const AUDIENCES = ['buyer', 'seller', 'investor', 'neutral'];

function istDateKey(nowMs = Date.now()) {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}${String(ist.getUTCMonth() + 1).padStart(2, '0')}${String(ist.getUTCDate()).padStart(2, '0')}`;
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** session-digest URL → blog-digest URL (config override wins). */
function blogDigestUrlFrom(intel) {
  if (intel.blogDigestUrl) return intel.blogDigestUrl;
  if (!intel.digestUrl) return '';
  return intel.digestUrl.replace(/session-digest(\/?)(\?|$)/, 'blog-digest$1$2').replace('session-digest', 'blog-digest');
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    audience: { type: 'string', enum: AUDIENCES },
    topics: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['audience', 'topics', 'confidence'],
};

function classifyPrompt(blog) {
  return [
    'You classify Indian real-estate blog articles by the reader they are written FOR, so a website',
    'can show that reader the right call-to-action.',
    '',
    'Pick ONE audience:',
    '- "buyer": helps someone looking to BUY or RENT a home (area guides, price trends, how-to-buy,',
    '  home-loan/EMI, locality comparisons, "best places to live").',
    '- "seller": helps a property OWNER sell or list (selling process, paperwork, registration,',
    '  documentation, capital-gains tax, valuation, "how to sell", owner legal duties).',
    '- "investor": helps someone deciding where to put MONEY (ROI, rental yield, plots/land as an',
    '  asset, market outlook for returns, commercial investment).',
    '- "neutral": general news, construction/material guides, festivals, or anything that does not',
    '  clearly serve buyer, seller, or investor intent.',
    '',
    'Also return up to 5 short lowercase kebab topics (e.g. "home-loan", "stamp-duty", "vastu").',
    'confidence is 0..1 for how sure you are of the audience.',
    '',
    `TITLE: ${blog.title}`,
    blog.category ? `CATEGORY: ${blog.category}` : '',
    blog.tags?.length ? `TAGS: ${blog.tags.join(', ')}` : '',
    '',
    'ARTICLE (excerpt):',
    blog.excerpt || '(no body text)',
  ]
    .filter(Boolean)
    .join('\n');
}

async function classifyOne(blog) {
  const out = await generateJson({
    model: GEMINI_FLASH,
    prompt: classifyPrompt(blog),
    schema: CLASSIFY_SCHEMA,
    temperature: 0,
    maxOutputTokens: 256,
    thinkingBudget: 0,
  });
  if (!out || !AUDIENCES.includes(out.audience)) return null;
  const topics = (Array.isArray(out.topics) ? out.topics : [])
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40))
    .filter(Boolean)
    .slice(0, 5);
  return {
    id: blog.id,
    audience: out.audience,
    topics,
    confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)),
  };
}

/**
 * Settle ONE delivered batch: flat per-blog fee (BLOG_CLASSIFY_PRICE_PAISE) × count, accrued on the
 * org (`blogClassifyAccrualPaise`) with whole rupees debited as the accrual crosses ₹1 — the "sum,
 * then round once" discipline compose/daily_plan use. Idempotent per packRunId (unique per delivered
 * batch): a retry, a mid-loop timeout that re-runs, or a repeat same-day backfill invocation each
 * carry NEW packRunIds for new work and never re-bill an already-settled batch. Settling per batch
 * (not once per day) is what makes a multi-call backfill and a timeout-interrupted run bill correctly
 * — every batch that reached the platform is billed the moment it lands. Returns rupees debited.
 */
async function settleBlogClassifyBatch(db, orgId, dateKey, packRunId, count) {
  const logRef = db.collection(METER_LOG).doc(`${orgId}:blog_classify:${packRunId}`);
  const pricePaise = BLOG_CLASSIFY_PRICE_PAISE * count;
  return db.runTransaction(async (tx) => {
    const orgRef = db.collection('organisations').doc(orgId);
    const orgSnap = await tx.get(orgRef);
    if (!orgSnap.exists) return 0;
    const dupe = await tx.get(logRef);
    if (dupe.exists) return 0;
    const org = orgSnap.data();

    // Waived line (testing / goodwill): log it for idempotency + reconciliation, charge nothing.
    if (isServicePaused(org, 'blog_classify')) {
      tx.set(logRef, {
        orgId, service: 'blog_classify', idempotencyKey: packRunId, qty: count, dateKey,
        pricePaise: BLOG_CLASSIFY_PRICE_PAISE, debitInr: 0, waived: true, waivedPaise: pricePaise,
        createdAt: FieldValue.serverTimestamp(),
      });
      return 0;
    }

    const { debitInr, accrualPaise } = accrueComposeCharge(org.blogClassifyAccrualPaise, pricePaise);
    const update = { blogClassifyAccrualPaise: accrualPaise };
    if (debitInr > 0) {
      update.balance = Number(org.balance ?? 0) - debitInr;
      tx.set(db.collection('transactions').doc(), {
        orgId, type: 'debit', kind: 'blog_classify', amount: debitInr, count,
        description: `Blog audience classification (${dateKey}, ${count} blogs × ₹${(BLOG_CLASSIFY_PRICE_PAISE / 100).toFixed(2)})`,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(orgRef, update);
    tx.set(logRef, {
      orgId, service: 'blog_classify', idempotencyKey: packRunId, qty: count, dateKey,
      pricePaise: BLOG_CLASSIFY_PRICE_PAISE, debitInr, createdAt: FieldValue.serverTimestamp(),
    });
    return debitInr;
  });
}

export async function runBlogIntelligenceForOrg(
  db,
  orgId,
  cfg,
  { force = false, capReturn: capReturnOpt, capScan: capScanOpt, maxPasses } = {},
) {
  const intel = cfg.intelligence || {};
  const dateKey = istDateKey();
  const summary = { orgId, dateKey, status: 'skipped' };
  try {
    const digestUrl = blogDigestUrlFrom(intel);
    if (!intel.enabled || !digestUrl || !intel.packUrl) {
      summary.reason = 'intelligence-not-configured';
      return summary;
    }
    if (!geminiConfigured()) {
      summary.status = 'error';
      summary.reason = 'gemini-not-configured';
      return summary;
    }
    const runRef = db.collection('blogClassifyRuns').doc(orgId).collection('days').doc(dateKey);
    if (!force && (await runRef.get()).exists) {
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

    // 1) DRAIN the backlog: pull unclassified → classify (Flash) → deliver the verdicts, repeating
    //    until nothing unclassified remains, a pass makes no progress, or a safety cap. The digest
    //    hands back the newest `capScan` published posts and up to `capReturn` still-unclassified
    //    among them; each delivered pack stamps those posts, so the next pass sees the following
    //    slice. A big first-run backlog therefore clears in ONE run (was: 25/night over many nights).
    const capReturn = Math.min(Math.max(1, Number(intel.capBlogs || capReturnOpt || 40)), 100);
    const capScan = Math.min(Math.max(20, Number(capScanOpt || 500)), 3000);
    const passCap = Math.min(Math.max(1, Number(maxPasses || 6)), 20);

    const byAudience = {};
    const seenIds = new Set();
    const firstSamples = [];
    let delivered = 0; // blogs the platform stored this run — the billing basis
    let charged = 0; // rupees debited this run (summed across per-batch settles)
    let lastScanned = 0;
    let moreLikely = false; // scan window (capScan) was full ⇒ posts OLDER than it may still be unclassified
    let lastPackRunId = null;
    let passes = 0;
    let stopReason = 'pass-cap'; // overwritten on any explicit break; left as-is if we exhaust passCap

    while (passes < passCap) {
      passes++;
      try {
        // Pull one page of unclassified posts.
        const { signature, timestamp } = signPayload(secret, 'blog-digest');
        const url = new URL(digestUrl);
        url.searchParams.set('capReturn', String(capReturn));
        url.searchParams.set('capScan', String(capScan));
        const resp = await fetch(url.toString(), {
          headers: { 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp },
          signal: AbortSignal.timeout(60000),
        });
        if (!resp.ok) { stopReason = `digest-http-${resp.status}`; break; }
        const digest = await resp.json();
        if (!digest?.success) { stopReason = 'digest-malformed'; break; }
        lastScanned = digest.counts?.scanned || 0;
        moreLikely = Boolean(digest.counts?.moreLikely);

        const returned = Array.isArray(digest.blogs) ? digest.blogs : [];
        // Classify only ids we haven't already handled this run — guards against a slow platform stamp
        // re-surfacing the same posts (which would otherwise loop forever and double-bill within a run).
        const blogs = returned.filter((b) => b && b.id && !seenIds.has(b.id));
        if (!blogs.length) { stopReason = returned.length ? 'no-progress' : 'backlog-clear'; break; }
        blogs.forEach((b) => seenIds.add(b.id));

        // Classify (Flash, bounded concurrency).
        const results = (await mapLimit(blogs, CLASSIFY_CONCURRENCY, classifyOne)).filter(Boolean);
        if (!results.length) { stopReason = 'all-classifications-failed'; break; }

        // Deliver — engagement-pack carries just the classifications (the platform ignores absent
        // demandMap/messages; blogClassifications runs on any pack, not first-of-day).
        const packRunId = `bc_${dateKey}_${crypto.randomBytes(5).toString('hex')}`;
        const body = JSON.stringify({
          orgId,
          packRunId,
          dateKey,
          generatedAtMs: Date.now(),
          blogClassifications: results.map((r) => ({ id: r.id, audience: r.audience, topics: r.topics, confidence: r.confidence })),
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
          signal: AbortSignal.timeout(90000),
        });
        if (!post.ok) { stopReason = `pack-post-http-${post.status}`; break; }

        // Bill THIS batch immediately (idempotent per packRunId). Settling per batch — not once at the
        // end — means a later pass timing out never loses an earlier batch's charge, and a repeat
        // backfill invocation the same day bills only its new batches.
        delivered += results.length;
        lastPackRunId = packRunId;
        charged += await settleBlogClassifyBatch(db, orgId, dateKey, packRunId, results.length);
        for (const r of results) {
          byAudience[r.audience] = (byAudience[r.audience] || 0) + 1;
          if (firstSamples.length < 10) firstSamples.push({ id: r.id, audience: r.audience, confidence: r.confidence });
        }

        // A short page means the window's unclassified posts are exhausted — stop before an empty fetch.
        if (returned.length < capReturn) { stopReason = 'backlog-clear'; break; }
      } catch (passErr) {
        // A fetch abort / transient error ends the run gracefully: batches already delivered this run
        // are billed and stamped; a follow-up invocation resumes from where the digest now stands.
        stopReason = passErr?.message || 'pass-error';
        break;
      }
    }

    // Nothing delivered — the backlog was already clear, or the very first pass errored.
    if (delivered === 0) {
      const clean = stopReason === 'backlog-clear' || stopReason === 'no-progress';
      await runRef.set({
        dateKey, classified: 0, scanned: lastScanned, passes, stopReason, moreLikely,
        chargedInr: 0, createdAt: FieldValue.serverTimestamp(),
      });
      summary.status = clean ? 'ok' : 'error';
      summary.classified = 0;
      summary.reason = clean ? 'nothing-unclassified' : stopReason;
      return summary;
    }

    // 3) Record the run (idempotency + audit + billing outcome).
    await runRef.set({
      dateKey,
      packRunId: lastPackRunId,
      scanned: lastScanned,
      classified: delivered,
      passes,
      stopReason,
      byAudience,
      pricePaise: BLOG_CLASSIFY_PRICE_PAISE,
      chargedInr: charged,
      moreLikely,
      samples: firstSamples,
      createdAt: FieldValue.serverTimestamp(),
    });

    summary.status = 'ok';
    summary.packRunId = lastPackRunId;
    summary.classified = delivered;
    summary.passes = passes;
    summary.stopReason = stopReason;
    summary.byAudience = byAudience;
    summary.chargedInr = charged;
    summary.moreLikely = moreLikely;
    return summary;
  } catch (e) {
    console.error('blogIntelligence:org', orgId, e?.message || e);
    summary.status = 'error';
    summary.reason = e?.message || String(e);
    return summary;
  }
}

/** 03:00 IST nightly — after the planner (01:30) and session intelligence (02:30). */
export const blogIntelligence = onSchedule(
  {
    region: REGION,
    schedule: '0 3 * * *',
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
      const summary = await runBlogIntelligenceForOrg(db, orgDoc.id, cfg);
      console.log('blogIntelligence:done', orgDoc.id, JSON.stringify(summary));
    }
  },
);

/**
 * On-demand trigger (same shape as sourcingPlanNow): POST { orgId, force?, capReturn?, capScan?,
 * maxPasses? }. For testing + one-shot backlog backfill. The run drains the whole reachable backlog
 * by default; the cap overrides only matter for tuning a very large backfill.
 */
export const blogClassifyNow = onRequest(
  { region: REGION, timeoutSeconds: 540, memory: '512MiB', cors: true },
  async (req, res) => {
    try {
      const orgId = String(req.body?.orgId || req.query?.orgId || '');
      const force = Boolean(req.body?.force || req.query?.force);
      const capReturn = req.body?.capReturn ?? req.query?.capReturn;
      const capScan = req.body?.capScan ?? req.query?.capScan;
      const maxPasses = req.body?.maxPasses ?? req.query?.maxPasses;
      if (!orgId) {
        res.status(400).json({ error: 'orgId required' });
        return;
      }
      const db = getFirestore();
      const orgDoc = await db.collection('organisations').doc(orgId).get();
      if (!orgDoc.exists) {
        res.status(404).json({ error: 'org not found' });
        return;
      }
      const summary = await runBlogIntelligenceForOrg(db, orgId, orgDoc.data().sourcing || {}, {
        force,
        capReturn,
        capScan,
        maxPasses,
      });
      res.json(summary);
    } catch (e) {
      console.error('blogClassifyNow:err', e?.message || e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  },
);

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
 * Cheap and self-throttling: the digest returns only UNCLASSIFIED posts (default ≤25/run), so a
 * steady site is ~0 calls/night and a backlog clears over a few nights. New posts are picked up the
 * night after they publish. A scheduler retry no-ops via the per-day run doc; even without it,
 * re-running only re-classifies whatever is still unclassified.
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

export async function runBlogIntelligenceForOrg(db, orgId, cfg, { force = false } = {}) {
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

    // 1) Pull unclassified posts.
    const { signature, timestamp } = signPayload(secret, 'blog-digest');
    const url = new URL(digestUrl);
    if (intel.capBlogs) url.searchParams.set('capReturn', String(intel.capBlogs));
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
    const blogs = Array.isArray(digest.blogs) ? digest.blogs : [];
    if (!blogs.length) {
      await runRef.set({ dateKey, classified: 0, scanned: digest.counts?.scanned || 0, createdAt: FieldValue.serverTimestamp() });
      summary.status = 'ok';
      summary.classified = 0;
      summary.reason = 'nothing-unclassified';
      return summary;
    }

    // 2) Classify each (Flash, bounded concurrency).
    const results = (await mapLimit(blogs, CLASSIFY_CONCURRENCY, classifyOne)).filter(Boolean);
    if (!results.length) {
      summary.status = 'error';
      summary.reason = 'all-classifications-failed';
      return summary;
    }

    // 3) Deliver — engagement-pack carries just the classifications (the platform ignores absent
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
      signal: AbortSignal.timeout(30000),
    });
    if (!post.ok) {
      summary.status = 'error';
      summary.reason = `pack-post-http-${post.status}`;
      return summary;
    }
    const postBody = await post.json().catch(() => ({}));

    // 4) Settle — a flat per-blog fee (BLOG_CLASSIFY_PRICE_PAISE) × blogs actually classified this
    // run, held in paise and accrued on the org (blogClassifyAccrualPaise) with whole rupees debited
    // as the accrual crosses ₹1 — the same "sum, then round once" discipline daily_plan/compose use.
    // idempotencyKey = dateKey, so a forced same-day re-run finds the log row and charges ₹0. Charged
    // on the ack: we only reach here after the platform stored the classifications.
    const logRef = db.collection(METER_LOG).doc(`${orgId}:blog_classify:${dateKey}`);
    const pricePaise = BLOG_CLASSIFY_PRICE_PAISE * results.length;
    let charged = 0;
    charged = await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return 0;
      const dupe = await tx.get(logRef);
      if (dupe.exists) return 0;
      const org = orgSnap.data();

      // Waived line (testing / goodwill): log it for idempotency + reconciliation, charge nothing.
      if (isServicePaused(org, 'blog_classify')) {
        tx.set(logRef, {
          orgId,
          service: 'blog_classify',
          idempotencyKey: dateKey,
          qty: results.length,
          packRunId,
          pricePaise: BLOG_CLASSIFY_PRICE_PAISE,
          debitInr: 0,
          waived: true,
          waivedPaise: pricePaise,
          createdAt: FieldValue.serverTimestamp(),
        });
        return 0;
      }

      const { debitInr, accrualPaise } = accrueComposeCharge(org.blogClassifyAccrualPaise, pricePaise);
      const update = { blogClassifyAccrualPaise: accrualPaise };
      if (debitInr > 0) {
        update.balance = Number(org.balance ?? 0) - debitInr;
        tx.set(db.collection('transactions').doc(), {
          orgId,
          type: 'debit',
          kind: 'blog_classify',
          amount: debitInr,
          count: results.length,
          description: `Blog audience classification (${dateKey}, ${results.length} blogs × ₹${(BLOG_CLASSIFY_PRICE_PAISE / 100).toFixed(2)})`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, {
        orgId,
        service: 'blog_classify',
        idempotencyKey: dateKey,
        qty: results.length,
        packRunId,
        pricePaise: BLOG_CLASSIFY_PRICE_PAISE,
        debitInr,
        createdAt: FieldValue.serverTimestamp(),
      });
      return debitInr;
    });

    // 5) Record the run (idempotency + audit; now also the billing outcome).
    const byAudience = results.reduce((acc, r) => ({ ...acc, [r.audience]: (acc[r.audience] || 0) + 1 }), {});
    await runRef.set({
      dateKey,
      packRunId,
      scanned: digest.counts?.scanned || 0,
      returned: blogs.length,
      classified: results.length,
      byAudience,
      pricePaise: BLOG_CLASSIFY_PRICE_PAISE,
      chargedInr: charged,
      classifierVersion: digest.classifierVersion || null,
      moreLikely: Boolean(digest.counts?.moreLikely),
      samples: results.slice(0, 10).map((r) => ({ id: r.id, audience: r.audience, confidence: r.confidence })),
      createdAt: FieldValue.serverTimestamp(),
    });

    summary.status = 'ok';
    summary.packRunId = packRunId;
    summary.classified = results.length;
    summary.byAudience = byAudience;
    summary.chargedInr = charged;
    summary.serverConfirmed = postBody?.stored?.blogsClassified ?? null;
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

/** On-demand trigger (same shape as sourcingPlanNow): POST { orgId, force? }. For testing + backfill. */
export const blogClassifyNow = onRequest(
  { region: REGION, timeoutSeconds: 540, memory: '512MiB', cors: true },
  async (req, res) => {
    try {
      const orgId = String(req.body?.orgId || req.query?.orgId || '');
      const force = Boolean(req.body?.force || req.query?.force);
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
      const summary = await runBlogIntelligenceForOrg(db, orgId, orgDoc.data().sourcing || {}, { force });
      res.json(summary);
    } catch (e) {
      console.error('blogClassifyNow:err', e?.message || e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  },
);

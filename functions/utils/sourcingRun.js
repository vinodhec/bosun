/**
 * Sourcing run recorder — the audit trail for the property-sourcing relay.
 *
 * WHY THIS EXISTS. The relay's whole funnel (which targets the matrix returned, the queries Gemini
 * built for them, and every place a listing was dropped between the SERP fetch and the webhook) used
 * to live only in `console.log`. That made the two questions the operator actually asks —
 * "what did we source, and why did so few leads land?" — answerable only by grepping Cloud Logging
 * inside its retention window. This module persists the same funnel as data, so the Admin panel can
 * read it back.
 *
 * WHAT IT IS NOT. This is a RECORDER, never a gate: no method here changes what gets relayed or
 * billed. Every write is best-effort and swallowed — the audit trail must never be able to fail a
 * run that would otherwise have delivered and billed leads. If Firestore is down we lose the record,
 * not the revenue.
 *
 * SHAPE. One `sourcingRuns/{runId}` per cron invocation per org, holding the org-level funnel plus a
 * `targets[]` leg for each locality sourced. Every prospect examined gets a row in the
 * `sourcingRuns/{runId}/leads` subcollection carrying its URL, the target and query that found it,
 * and — for the dropped ones — exactly which gate killed it. Both levels carry `expiresAt` for a
 * Firestore TTL policy (see TTL_DAYS).
 *
 * The counters are deliberately funnel-shaped and ordered to match the pipeline in
 * handlers/runSourcingJobs.js, so a reader can subtract adjacent stages and get a real drop count.
 */
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

/** Retention for run + lead docs. Set the matching Firestore TTL policy on the `expiresAt` field:
 *    gcloud firestore fields ttls update expiresAt --collection-group=sourcingRuns --enable-ttl
 *    gcloud firestore fields ttls update expiresAt --collection-group=leads --enable-ttl
 *  Without the policy the docs simply persist — the field is inert, never a correctness issue. */
export const TTL_DAYS = 90;

/** Hard ceiling on lead rows per run. A runaway matrix must not write an unbounded subcollection;
 *  the funnel COUNTERS stay exact past this point, only the per-URL rows stop (surfaced as
 *  `leadsTruncated` so the panel never implies it showed everything). */
const MAX_LEAD_ROWS = 2000;

const BATCH_SIZE = 400; // Firestore's per-batch write limit is 500 — leave headroom.

/** The funnel, in pipeline order. Each key is a stage COUNT (not a drop count) unless named *Dropped
 *  / *Skipped, so the panel can render both the absolute stage size and the delta between stages. */
function blankFunnel() {
  return {
    fetched: 0,            // raw SERP items across every query
    posts: 0,              // survived the individual-post URL filter
    dupInRun: 0,           // same canonical listing key twice within this run
    seenBefore: 0,         // dedup-forever hit against sourcingSeen (relayed OR dead)
    newProspects: 0,       // genuinely new keys entering the vetting gates
    serpStaleSkipped: 0,   // 3a — cheap SERP-date pre-filter (fail-open, not marked dead)
    noSignalDropped: 0,    // 3b — deterministic property-signal pre-filter
    offTargetDropped: 0,   // 3b — Gemini classify said off-target (confident reject → dead)
    buyerDropped: 0,       // 3b — genuine buyer post, org hasn't opted into buyerLeads (→ retries)
    supplyDropped: 0,      // 3b — BUYER-mode run's by-catch: a real listing, wrong lane (→ retries)
    degradedDropped: 0,    // 3b — classifier down AND no India signal (transient → retries)
    localityPending: 0,    // 3b — genuine listing but the SERP text NAMED no place (truncated title /
                           //      adjacent-post snippet); deferred to the full-text pass (3c2)
    poolDeferred: 0,       // 3c — trimmed to the enrich pool; NOT dropped, next run picks it up
    enriched: 0,           // 3c1 — paid FB scrapes actually attempted
    enrichMissed: 0,       // 3c1 — scraper returned nothing for the URL (kept, SERP snippet stands)
    withImages: 0,         // enriched posts that yielded photos
    withPhone: 0,          // enriched posts that yielded an owner phone
    fullTextConfirmed: 0,  // 3c2 — the full post text settled a locality-unknown lead: it proceeds
    fullTextDropped: 0,    // 3c2 — the full post text confidently rejected it (→ dead)
    localityUnresolved: 0, // 3c2 — enrichment returned no text to judge (transient → retries)
    recencyDropped: 0,     // 3d — authoritative FB date older than the org window (→ dead)
    intentStaleDropped: 0, // 3e — per-intent freshness (rent vs sale) (→ dead unless re-admitted)
    staleReadmitted: 0,    // 3e — stale-fallback re-admits for a target with zero fresh leads
    capDeferred: 0,        // trimmed by maxPerRun; NOT dropped, next run picks it up
    ownerDupInRun: 0,      // 3f — same owner+property fingerprint twice within this run (→ dead)
    ownerDupSeen: 0,       // 3f — owner+property fingerprint we already relayed on a prior run (→ dead)
    ownerDeduped: 0,       // 3f — ownerDupInRun + ownerDupSeen (total same-property reposts collapsed)
    relayAttempted: 0,
    relayed: 0,            // webhook returned 2xx → marked seen AND billed
    buyerRelayed: 0,       //   … of which leadType:'buyer' (the buyer-harvest salvage lane)
    offTargetRelayed: 0,   //   … of which leadType:'off-target' (real listing, wrong locality)
    relayFailed: 0,        // non-2xx / timeout → not seen, not billed, retries next run
  };
}

function addFunnel(into, from) {
  for (const k of Object.keys(from)) into[k] = (into[k] || 0) + (from[k] || 0);
  return into;
}

/** Trim free text so one verbose FB post can't bloat a lead row (Firestore caps docs at 1 MB). */
function clip(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/** A no-op recorder. Returned when recording is off (or a caller passes nothing), so every call
 *  site can stay unconditional — `run.leg(...)` never needs a null check. */
export const NULL_RUN = {
  enabled: false,
  id: null,
  matrix() {},
  leg() { return NULL_LEG; },
  note() {},
  async finish() {},
};

export const NULL_LEG = {
  enabled: false,
  count() {},
  bump() {},
  lead() {},
  done() {},
};

/**
 * Start recording a run. Writes the run doc immediately with `status:'running'` so an in-flight (or
 * crashed/timed-out) run is visible in the panel rather than invisible until it finishes — a run
 * that hits the 30-minute scheduler wall is exactly the one an operator most wants to see.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} orgId
 * @param {'cron'|'cron-buyer'|'admin-top-target'|'admin-buyer'|'admin-run-now'} trigger  what caused this run
 */
export function startRun(db, orgId, trigger) {
  const ref = db.collection('sourcingRuns').doc();
  const startedMs = Date.now();
  const expiresAt = Timestamp.fromMillis(startedMs + TTL_DAYS * 24 * 60 * 60 * 1000);
  const legs = [];
  let leadRows = [];
  let leadsWritten = 0;
  let leadsTruncated = false;
  let matrixInfo = null;
  const notes = [];

  // Fire-and-forget the opening write; a slow Firestore must not delay the Apify fetch. MERGE is
  // load-bearing: this write is not awaited, so a short run can call finish() before it commits, and
  // the two are independent commits with no ordering guarantee. A plain set() landing second would
  // overwrite the finished record wholesale and lose the whole funnel; with merge the worst case is
  // a stale `status` field, which finish's own status write below then settles.
  const opened = ref.set({
    orgId,
    trigger,
    status: 'running',
    startedAt: Timestamp.fromMillis(startedMs),
    expiresAt,
  }, { merge: true }).catch((e) => console.error('sourcingRun:open:err', orgId, e?.message || e));

  const run = {
    enabled: true,
    id: ref.id,

    /** Record what the demand matrix returned, before any target is sourced. */
    matrix(info) {
      matrixInfo = info || null;
    },

    /** Free-text note for anything that isn't a counter (e.g. "no secret", "no due targets"). */
    note(text) {
      if (text) notes.push(String(text));
    },

    /**
     * Open a leg — one target's pass through the pipeline. A static-config org (no matrix) has a
     * single leg with `target:null`, so the run shape is identical either way.
     */
    leg({ target = null, queries = [], meta = null, mode = 'supply' } = {}) {
      const funnel = blankFunnel();
      const legRec = {
        locality: target?.locality || null,
        city: target?.city || null,
        shape: target?.shape || null,
        queries: (queries || []).map((q) => clip(q, 200)),
        // Which lane sourced this target: 'supply' (inventory) or 'buyer' (demand). The two run the
        // same pipeline over completely different queries, so a funnel is unreadable without it.
        mode: mode === 'buyer' ? 'buyer' : 'supply',
        // Gemini's query-building provenance: which language/name it chose for this locality. This
        // is the only place it surfaces — the cron discards sourceTopTargets' return value.
        category: meta?.category || null,
        englishName: meta?.englishName || null,
        regionalLanguage: meta?.regionalLanguage || null,
        regionalName: meta?.regionalName || null,
        funnel,
        relayed: 0,
        amountInr: 0,
        note: null,
        startedAtMs: Date.now(),
        ms: 0,
      };
      legs.push(legRec);

      return {
        enabled: true,
        /** Set a stage counter to an absolute value (stage sizes are known, not incremented). */
        count(key, n) {
          if (key in funnel) funnel[key] = Number(n) || 0;
        },
        /** Increment a counter (drops discovered one at a time). */
        bump(key, n = 1) {
          if (key in funnel) funnel[key] += Number(n) || 0;
        },
        /**
         * Record one examined listing. `stage` is 'relayed' | 'dropped' | 'deferred'; `dropStage`
         * says WHICH gate ended it, `dropReason` says why in that gate's own words.
         */
        lead({ key, listing, stage, dropStage = null, dropReason = null }) {
          if (leadsWritten + leadRows.length >= MAX_LEAD_ROWS) {
            leadsTruncated = true;
            return;
          }
          if (!listing?.url) return;
          leadRows.push({
            orgId,
            runId: ref.id,
            key: key || null,
            url: listing.url,
            title: clip(listing.title, 300),
            // The enriched FB text, kept long enough to judge relevance by eye but not so long it
            // threatens the doc cap.
            snippet: clip(listing.snippet, 1200),
            locality: legRec.locality,
            city: legRec.city,
            // Which query surfaced it — the recall signal. Query quality is per-target, so a lead's
            // provenance is the only way to tell a bad query from a dry locality.
            query: clip(listing.sourceQuery, 200) || null,
            stage,
            dropStage,
            dropReason: dropReason ? clip(dropReason, 200) : null,
            postedAt: listing.postedAt || null,
            serpAgeMs: listing.serpAgeMs || null,
            freshness: listing.freshness || null,
            leadType: listing.leadType || null, // 'buyer' / 'off-target' salvage lanes; null = supply
            classifyStatus: listing.classifyStatus || null,
            listingType: listing.extracted?.listingType || null,
            propertyType: listing.extracted?.propertyType || null,
            priceText: clip(listing.extracted?.price, 60) || null,
            hasPhone: Boolean(listing.phone),
            imageCount: listing.images?.length || 0,
            expiresAt,
          });
        },
        /** Close the leg with what it actually delivered and billed. */
        done({ relayed = 0, amountInr = 0, note = null } = {}) {
          legRec.relayed = relayed;
          legRec.amountInr = amountInr;
          legRec.ms = Date.now() - legRec.startedAtMs;
          if (note) legRec.note = note;
        },
      };
    },

    /**
     * Close the run: flush every lead row, then write the roll-up. Fully swallowed — a failed audit
     * write must never surface as a failed sourcing run.
     */
    async finish({ status = 'done', error = null } = {}) {
      try {
        // Settle the opening write before the closing one, so `status` can never regress to
        // 'running' on a run short enough to finish inside that write's flight time.
        await opened;
        // Leads first: the run doc is the "is it complete?" marker, so it must land last.
        while (leadRows.length) {
          const chunk = leadRows.splice(0, BATCH_SIZE);
          const batch = db.batch();
          for (const row of chunk) batch.set(ref.collection('leads').doc(), row);
          await batch.commit();
          leadsWritten += chunk.length;
        }

        const total = blankFunnel();
        for (const l of legs) addFunnel(total, l.funnel);
        const relayed = legs.reduce((n, l) => n + (l.relayed || 0), 0);
        const amountInr = legs.reduce((n, l) => n + (l.amountInr || 0), 0);

        await ref.set({
          orgId,
          trigger,
          status,
          error: error ? clip(error, 500) : null,
          startedAt: Timestamp.fromMillis(startedMs),
          finishedAt: FieldValue.serverTimestamp(),
          ms: Date.now() - startedMs,
          matrix: matrixInfo,
          funnel: total,
          targets: legs.map(({ startedAtMs, ...rest }) => rest),
          targetCount: legs.length,
          relayed,
          amountInr,
          leadRows: leadsWritten,
          leadsTruncated,
          notes,
          expiresAt,
        }, { merge: true });
      } catch (e) {
        console.error('sourcingRun:finish:err', orgId, ref.id, e?.message || e);
      }
    },
  };

  return run;
}

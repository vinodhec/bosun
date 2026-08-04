/**
 * Defect intake — org config, the DEDUPE GATE, and the evidence pack.
 *
 * The customer's staff raise defects from their own admin console; Bosun files them into that org's
 * GitHub repo. What Bosun adds over the console POSTing to GitHub directly — and the reason the
 * lane is billable at all — is everything in this file:
 *
 *   1. DEDUPE GATE. A report that matches an already-filed defect never becomes a second issue. It
 *      comes back to the reporter as "same as #531, merged 3 days ago" — no issue, no triage run,
 *      and NO CHARGE. The gate's value is that it stops work, so billing for it would invert the
 *      incentive; a duplicate is free, always.
 *   2. EVIDENCE PACK. Bosun already holds the nightly error clusters for this org (intelRuns). A
 *      filed defect arrives carrying the matching cluster — how many real sessions hit it, on which
 *      page, since when — instead of one person's sentence. That is what the repro-first gate keeps
 *      bouncing tickets for, and what a human otherwise chases by hand.
 *   3. BLAST RADIUS. Severity stops being the reporter's mood and becomes session counts.
 *
 * Everything here fails OPEN. A missing cluster, a model timeout, a malformed org config — none of
 * them may lose a bug report. The worst acceptable outcome is a plain ticket filed with no
 * enrichment; a dropped report is not an acceptable outcome.
 */
import { hashKey, normalizeErrorMessage } from './errorIntel.js';
import { generateJson, geminiConfigured, GEMINI_FLASH } from './gemini.js';

/** Reports older than this are no longer dedupe candidates — a bug that returns months later is new. */
const DEDUPE_WINDOW_DAYS = 90;
/** How many recent defects to pull as recall candidates before scoring. */
const CANDIDATE_POOL = 60;
/** How many top-scored candidates the model is asked to judge. Keeps the call cheap and focused. */
const MAX_JUDGED = 5;
/** Days of nightly error clusters to search for corroborating evidence. */
const EVIDENCE_WINDOW_DAYS = 14;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'on', 'in', 'at', 'to', 'for', 'of',
  'and', 'or', 'but', 'not', 'no', 'it', 'its', 'this', 'that', 'when', 'then', 'i', 'we', 'you',
  'page', 'button', 'click', 'clicking', 'shows', 'showing', 'show', 'getting', 'get', 'gets',
  'issue', 'problem', 'bug', 'error', 'please', 'able', 'unable', 'doesnt', 'does',
  'add', 'after', 'with', 'from', 'instead', 'while',
]);

/**
 * Org defect config, with defaults for an org that has only just connected a repo.
 *
 * Every label here is per-org on purpose. MaadiVeedu runs a needs-triage → ready-for-dev → in-dev →
 * needs-validation → ready lifecycle driven by scheduled agents; another org may run a two-label
 * board or none at all. Bosun applies what the org declares and reads nothing into it.
 *
 * Shape: `organisations/{orgId}.defects` = {
 *   enabled, areas[], types[], priorities[], intakeLabels[], ownerContact{name,phone},
 *   regressionTests, dedupe: { enabled, windowDays }
 * }
 */
export function defectConfig(org) {
  const d = (org && org.defects) || {};
  const arr = (v, fallback) => (Array.isArray(v) && v.length ? v.map(String) : fallback);
  return {
    enabled: d.enabled !== false,
    areas: arr(d.areas, ['web']),
    types: arr(d.types, ['bug']),
    priorities: arr(d.priorities, ['priority:normal']),
    // Applied at file time. `needs-triage` is a lifecycle state, `admin-raised` a permanent marker —
    // an org that wants neither simply declares its own list.
    intakeLabels: arr(d.intakeLabels, ['needs-triage']),
    ownerContact: d.ownerContact || null,
    regressionTests: d.regressionTests === true,
    dedupe: {
      enabled: d.dedupe?.enabled !== false,
      windowDays: Number.isFinite(d.dedupe?.windowDays) ? Number(d.dedupe.windowDays) : DEDUPE_WINDOW_DAYS,
    },
  };
}

/** Content words of a report, for overlap scoring — lowercase, de-punctuated, stopwords dropped. */
export function contentTokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard-ish overlap, normalised by the SMALLER set so a terse title still matches a long one. */
export function overlapScore(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * ── Why matching is scope-gated and IDF-weighted ───────────────────────────────────────────────
 * Backtested against 32 real admin-raised reports with human outcomes (2026-08-05). Plain token
 * overlap FAILED outright: for the one report humans closed as a duplicate it ranked an unrelated
 * ticket top at 0.50 and put the true match last at 0.25 — while two genuinely DISTINCT reports
 * scored 0.60. Two reasons, both structural rather than fixable by a better model:
 *
 *   1. The platform's own vocabulary is not signal. "sourced", "properties", "filter", "page"
 *      appear in nearly every report, so raw overlap measures how much a report sounds like this
 *      product, not what it says. IDF over the ORG'S OWN corpus fixes it, and self-tunes: every
 *      org's boilerplate is different, and none of it has to be configured.
 *   2. A defect is (where) + (what's broken), and the two must match SEPARATELY. "My Properties –
 *      rename Views to Clicks" and "My Lead Analytics – rename Views to Clicks" have IDENTICAL
 *      symptom text (similarity 1.00) and are different defects on different pages. No amount of
 *      text similarity can separate them — only comparing scope on its own can.
 *
 * With scope gated to an exact match and IDF cosine on the symptom, the same replay caught the
 * true duplicate at rank 1 (0.60), produced zero false positives across the hard cluster, and cut
 * the reports needing a model call from 18/31 to 3/31 — a ~90% cut in both cost and latency.
 *
 * The live path is stronger than that backtest: scope comes from the URL the reporter was on,
 * not from parsing a title.
 */

/** Everything below this is not the same defect, whatever the words say. */
export const SYMPTOM_MATCH_FLOOR = 0.20;
/** At or above this, with scope matching, the pair is worth a model verdict. */
export const SYMPTOM_JUDGE_FLOOR = 0.40;

/**
 * The WHERE half of a defect identity: the page/module, normalised so ids don't fragment it.
 *
 * Prefers the URL the reporter was actually on — deterministic and always right. Falls back to the
 * "Module – symptom" title convention staff naturally write in ("Sourced Properties – Assign to Me
 * is not working"), which is what makes this work for reports filed without a URL.
 */
export function scopeKey({ whereUrl = '', title = '' } = {}) {
  if (whereUrl) {
    try {
      const path = new URL(whereUrl, 'https://x.invalid').pathname
        .replace(/\/(?:[A-Z]{2,}-)?\d[\w-]*/g, '/<id>') // /property/SP-005234, /leads/1042
        .replace(/\/+$/, '');
      if (path && path !== '/') return path.toLowerCase();
    } catch { /* free-text "where" — fall through to the title convention */ }
  }
  const parts = String(title).split(/\s+[–—:-]\s+/);
  if (parts.length >= 2 && parts[0].split(/\s+/).length <= 4) return parts[0].toLowerCase().trim();
  return '';
}

/**
 * The WHAT half: the headline minus its scope prefix.
 *
 * TITLE ONLY, deliberately. Folding the description in was tried and it broke the backtest — it
 * re-diluted the signal with boilerplate and dropped the one true duplicate off the shortlist
 * entirely. Descriptions are long, individually worded, and (once triage has rewritten them) share
 * a spec template; the headline is where a human compresses what actually broke. The description
 * still contributes, at a quarter weight, via the detail term in rankCandidates.
 */
export function symptomText({ title = '' } = {}) {
  const parts = String(title).split(/\s+[–—:-]\s+/);
  return parts.length >= 2 && parts[0].split(/\s+/).length <= 4 ? parts.slice(1).join(' ') : String(title);
}

/** The free-text half of a report, used only as a tie-breaker behind the headline. */
export function detailText({ whatHappened = '', steps = '', expected = '', summary = '' } = {}) {
  return [whatHappened, steps, expected, summary].filter(Boolean).join(' ').slice(0, 600);
}

/** How much the headline counts vs the description. Validated on the 32-report replay. */
export const TITLE_WEIGHT = 0.75;
export const DETAIL_WEIGHT = 0.25;

/**
 * Scope equality — EXACT, deliberately.
 *
 * Containment ("properties" ⊂ "my properties") was tried and rejected: in a real product "my X" is
 * a different surface from "X" — My Properties vs Lead Analytics vs My Lead Analytics are three
 * pages — and containment produced the backtest's only false positive. Exact is also what the URL
 * path gives for free on the live path.
 */
export function scopeMatch(a, b) {
  return !!a && a === b;
}

/**
 * Inverse document frequency over this org's own report corpus. Rare words carry the meaning;
 * words appearing in every report carry none. Built per call from the candidate pool — no index to
 * maintain, and it tracks the org's vocabulary as it drifts.
 */
export function buildIdf(docs) {
  const df = new Map();
  for (const d of docs) for (const t of contentTokens(d)) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.length;
  return (term) => Math.log((n + 1) / ((df.get(term) || 0) + 1)) + 1;
}

/** Cosine similarity over IDF-weighted token sets. */
export function idfCosine(a, b, idf) {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (!ta.size || !tb.size) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const t of ta) { const w = idf(t); na += w * w; if (tb.has(t)) dot += w * w; }
  for (const t of tb) { const w = idf(t); nb += w * w; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/**
 * Stable fingerprint for a report — the cheap exact-match arm of the gate.
 *
 * Deliberately coarse: the same area + the same URL path + the same normalized headline is the same
 * defect, and `normalizeErrorMessage` already scrubs ids and numbers, so the same crash reported on
 * two different listings collapses to one fingerprint. Two people filing the identical complaint
 * minutes apart — the common real case — is caught here without a model call.
 */
export function reportFingerprint({ title = '', area = '', whereUrl = '' }) {
  let path = '';
  try {
    path = whereUrl ? new URL(whereUrl, 'https://x.invalid').pathname.replace(/\/\d+/g, '/<n>') : '';
  } catch {
    path = '';
  }
  return hashKey(`${area}|${path}|${normalizeErrorMessage(title)}`);
}

/** One line of report text for scoring + model context. */
function reportText(report) {
  return [report.title, report.whatHappened, report.steps, report.expected].filter(Boolean).join(' \n');
}

/**
 * Rank previously-filed defects against a new report. Pure — no I/O, no model.
 *
 * A candidate must be on the SAME page/module and then score on symptom similarity; see the note
 * above for why both halves are required. Returns candidates sorted best-first, each
 * { defect, score }. An empty result is the common case and the cheap one — the report is filed
 * immediately with no model call at all.
 */
export function rankCandidates(report, existing) {
  const scope = scopeKey(report);
  if (!scope) return [];
  const inScope = existing.filter((d) => scopeMatch(scope, d.scope || scopeKey(d)));
  if (!inScope.length) return [];
  // IDF is built over the FULL corpus, not just the in-scope slice: what makes a word uninformative
  // is that it's everywhere in this org's reports, which the whole corpus is what measures.
  const idf = buildIdf([reportText(report), ...existing.map((d) => `${d.title} ${d.summary || ''}`)]);
  const symptom = symptomText(report);
  const detail = detailText(report);
  return inScope
    .map((defect) => ({
      defect,
      score:
        TITLE_WEIGHT * idfCosine(symptom, defect.symptom || symptomText(defect), idf) +
        DETAIL_WEIGHT * idfCosine(detail, detailText(defect), idf),
    }))
    .filter((c) => c.score >= SYMPTOM_MATCH_FLOOR)
    .sort((a, b) => b.score - a.score);
}

/**
 * Ask the model whether the new report is the SAME underlying defect as one of the candidates.
 *
 * Biased hard toward "not a duplicate": a wrongly-suppressed report is a bug that silently never
 * gets fixed and a reporter who stops filing, while a wrongly-filed duplicate costs one triage run
 * and gets closed. Returns null on any failure — never blocks a report.
 */
async function judgeDuplicate(report, candidates) {
  if (!geminiConfigured() || !candidates.length) return null;
  const list = candidates
    .map((c, i) => `${i + 1}. [#${c.defect.issueNumber}] ${c.defect.title}${c.defect.summary ? ` — ${c.defect.summary}` : ''} (${c.defect.state}${c.defect.closedAt ? ', fixed' : ''})`)
    .join('\n');
  try {
    const out = await generateJson({
      model: GEMINI_FLASH,
      thinkingBudget: 0,
      maxOutputTokens: 200,
      system:
        'You decide whether a new bug report describes the SAME underlying defect as one already ' +
        'filed. Answer with JSON only.',
      prompt:
        `NEW REPORT\nTitle: ${report.title}\nWhat happened: ${report.whatHappened || '—'}\n` +
        `Steps: ${report.steps || '—'}\nWhere: ${report.whereUrl || '—'}\n\n` +
        `ALREADY FILED\n${list}\n\n` +
        `Respond JSON only: {"duplicateOf": <issue number or null>, "reason": "<one short line>"}\n\n` +
        `Rules:\n` +
        `- Same underlying defect = same broken behaviour in the same place. Same PAGE alone is NOT enough.\n` +
        `- Two different things broken on one screen are two defects.\n` +
        `- The same symptom with a different trigger is a DIFFERENT defect.\n` +
        `- When genuinely unsure, answer null. A missed duplicate is cheap; a suppressed real bug is not.`,
      schema: {
        type: 'object',
        properties: { duplicateOf: { type: ['integer', 'null'] }, reason: { type: 'string' } },
        required: ['duplicateOf'],
      },
    });
    const num = Number(out?.duplicateOf);
    if (!Number.isInteger(num)) return null;
    // Only ever trust a number that was actually on the shortlist — never a hallucinated issue id.
    const hit = candidates.find((c) => c.defect.issueNumber === num);
    return hit ? { defect: hit.defect, reason: String(out.reason || '').slice(0, 200) } : null;
  } catch (e) {
    console.warn('defects:judgeDuplicate:err', e?.message || e);
    return null;
  }
}

/**
 * The dedupe gate. Returns { duplicate, related } where `duplicate` is the matched defect (or null)
 * and `related` are near-misses worth linking in the issue body.
 *
 * Two arms, cheap first: an exact fingerprint hit short-circuits without a model call; otherwise the
 * top-scored candidates go to the model. Fails open in every direction.
 */
export async function dedupeReport({ db, orgId, report, config }) {
  const empty = { duplicate: null, related: [] };
  if (!config.dedupe.enabled) return empty;
  try {
    const since = new Date(Date.now() - config.dedupe.windowDays * 86400000);
    const snap = await db
      .collection('defects')
      .where('orgId', '==', orgId)
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'desc')
      .limit(CANDIDATE_POOL)
      .get();
    const existing = snap.docs.map((d) => d.data()).filter((d) => d.issueNumber);
    if (!existing.length) return empty;

    // Arm 1 — exact fingerprint. The same complaint filed twice in one afternoon, caught for free.
    const fp = reportFingerprint(report);
    const exact = existing.find((d) => d.fingerprint === fp);
    if (exact) return { duplicate: exact, related: [], reason: 'Identical report already filed', via: 'fingerprint' };

    // Arm 2 — the model, over a short, pre-scored, same-scope shortlist.
    const ranked = rankCandidates(report, existing);
    if (!ranked.length) return empty;

    // Only genuinely close pairs are worth a verdict. Everything between the match floor and the
    // judge floor is "related, not the same" — surfaced as context on the issue, never as a
    // deflection, and costing nothing. On the backtest this is what took model calls from 18/31
    // to 3/31.
    const judgeable = ranked.filter((c) => c.score >= SYMPTOM_JUDGE_FLOOR).slice(0, MAX_JUDGED);
    const related = ranked.filter((c) => c.score < SYMPTOM_JUDGE_FLOOR).slice(0, 3).map((c) => c.defect);
    if (!judgeable.length) return { duplicate: null, related };

    const judged = await judgeDuplicate(report, judgeable);
    if (judged) return { duplicate: judged.defect, related, reason: judged.reason, via: 'model' };
    return { duplicate: null, related: [...judgeable.map((c) => c.defect), ...related].slice(0, 3) };
  } catch (e) {
    // Index missing, Firestore hiccup, anything — file the ticket. Never lose a report.
    console.warn('defects:dedupe:err', orgId, e?.message || e);
    return empty;
  }
}

/**
 * Corroborating evidence from the nightly error intelligence Bosun already computes for this org.
 *
 * Matches the report against the stored clusters of the last EVIDENCE_WINDOW_DAYS on two signals:
 * the page the reporter named, and content overlap with the error message. Returns the best match
 * plus the blast radius, or null. Best-effort — no evidence is a normal outcome, not a failure.
 */
export async function findErrorEvidence({ db, orgId, report }) {
  try {
    const snap = await db
      .collection('intelRuns')
      .doc(orgId)
      .collection('days')
      .orderBy('__name__', 'desc')
      .limit(EVIDENCE_WINDOW_DAYS)
      .get();
    if (snap.empty) return null;

    let reportPath = '';
    try {
      reportPath = report.whereUrl ? new URL(report.whereUrl, 'https://x.invalid').pathname : '';
    } catch { /* a free-text "where" is fine — fall back to message overlap alone */ }
    const tokens = contentTokens(reportText(report));

    let best = null;
    for (const doc of snap.docs) {
      const dateKey = doc.id;
      for (const cluster of doc.data()?.errorTop || []) {
        const samePage = reportPath && cluster.page && cluster.page.split('?')[0] === reportPath.split('?')[0];
        const score = overlapScore(tokens, contentTokens(cluster.message)) + (samePage ? 0.5 : 0);
        if (score < 0.4) continue;
        if (!best || score > best.score) best = { score, cluster, dateKey };
        // Same cluster seen on an earlier day → that's the first-seen date, and the count grows.
        if (best && best.cluster.key === cluster.key) {
          best.firstSeen = dateKey;
          best.totalSessions = (best.totalSessions || 0) + (Number(cluster.sessions) || 0);
        }
      }
    }
    if (!best) return null;
    return {
      message: best.cluster.message,
      source: best.cluster.source,
      page: best.cluster.page,
      sessions: best.totalSessions || best.cluster.sessions || 0,
      sampleSids: best.cluster.sampleSids || [],
      lastSeen: best.dateKey,
      firstSeen: best.firstSeen || best.dateKey,
    };
  } catch (e) {
    console.warn('defects:evidence:err', orgId, e?.message || e);
    return null;
  }
}

/**
 * Severity from blast radius rather than from the reporter's mood.
 *
 * The reporter's own priority is kept as the floor — someone blocked from doing their job is
 * blocked whether or not the error tracker agrees — and evidence can only raise it.
 */
export function severityFor({ reportedPriority, evidence }) {
  const sessions = evidence?.sessions || 0;
  if (sessions >= 10) return 'priority:high';
  if (sessions >= 3) return 'priority:normal';
  return reportedPriority || 'priority:normal';
}

/**
 * Compose the GitHub issue body.
 *
 * Two audiences, in this order: the triage agent that must satisfy a repro-first gate, and the
 * human who reads it later. The reporter's own words are never rewritten or summarised away here —
 * triage may rewrite the body afterwards, so this is the last place the raw account survives, and
 * the intake doc keeps a copy regardless.
 */
export function composeIssueBody({ report, reporter, evidence, related, orgLabel = '' }) {
  const L = [];
  L.push(`> Raised from the ${orgLabel || 'customer'} admin console via Bosun.`);
  L.push('');
  L.push('## What happened');
  L.push(report.whatHappened || report.title);
  if (report.steps) {
    L.push('');
    L.push('## Steps to reproduce');
    L.push(report.steps);
  }
  if (report.expected) {
    L.push('');
    L.push('## Expected');
    L.push(report.expected);
  }
  L.push('');
  L.push('## Where');
  L.push(`- **URL:** ${report.whereUrl || '—'}`);
  L.push(`- **Area:** ${report.area || '—'}`);
  if (report.jamUrl) L.push(`- **Recording:** ${report.jamUrl}`);
  for (const url of report.screenshots || []) L.push(`- **Screenshot:** ${url}`);

  if (evidence) {
    L.push('');
    L.push('## Evidence (Bosun error intelligence)');
    L.push(
      `This is not a one-off: **${evidence.sessions} real session${evidence.sessions === 1 ? '' : 's'}** hit a matching error` +
        `${evidence.firstSeen === evidence.lastSeen ? ` on ${evidence.lastSeen}` : `, first seen ${evidence.firstSeen}, last seen ${evidence.lastSeen}`}.`,
    );
    L.push('');
    L.push(`- **Error:** \`${evidence.message}\``);
    L.push(`- **Captured at:** ${evidence.source}`);
    if (evidence.page) L.push(`- **Most-hit page:** ${evidence.page}`);
    if (evidence.sampleSids?.length) L.push(`- **Sample sessions:** ${evidence.sampleSids.join(', ')}`);
  }

  if (related?.length) {
    L.push('');
    L.push('## Possibly related');
    for (const r of related) L.push(`- #${r.issueNumber} — ${r.title}`);
  }

  L.push('');
  L.push(
    `*Reported by **${reporter?.name || 'a staff member'}**${reporter?.phone ? ` (${reporter.phone})` : ''}. ` +
      `Reply on this issue and it reaches them.*`,
  );
  return L.join('\n');
}

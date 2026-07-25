/**
 * Nightly error intelligence — pure functions, no I/O (same discipline as rulesTuner).
 *
 * The platform's session tracker records broken experiences as `app_error` journey events and
 * stamps each session summary with `didError` + a `lastError {message, source, digest, page}`
 * triage snapshot. The session digest serves those rows (`digest.errors`); this module turns them
 * into:
 *   - CLUSTERS  — one row per distinct failure (source + normalized message), with affected-session
 *     counts, pages, and sample session ids for journey deep-links. Deterministic and auditable.
 *   - DEV-TASK PROPOSALS — recurring clusters become ticket proposals on the superadmin's approval
 *     queue (never filed directly — the same human-in-the-loop rail as rulesTuner's proposals).
 *
 * Normalization strips the volatile parts of a message (ids, numbers, URLs, quoted fragments) so
 * "Cannot read properties of undefined (reading 'price') at PROP-003412" and the same crash on
 * PROP-009001 land in ONE cluster with a stable fingerprint across days.
 */

/** Volatile-part scrubber → the cluster signature for a raw error message. */
export function normalizeErrorMessage(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/['"`][^'"`]{0,80}['"`]/g, '<str>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Tiny stable hash (FNV-1a, base36) — fingerprint material, no crypto import needed. */
export function hashKey(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * digest.errors rows ({sid, count, message, source, digest, page, deviceType}) → clusters sorted by
 * affected sessions desc. Each cluster keeps a representative raw message + up to 3 sample sids.
 */
export function clusterErrors(errorRows = []) {
  const clusters = new Map();
  for (const row of errorRows) {
    const norm = normalizeErrorMessage(row.message);
    const source = String(row.source || 'unknown');
    const key = `${source}|${norm || row.digest || 'unknown'}`;
    let c = clusters.get(key);
    if (!c) {
      c = {
        key: hashKey(key),
        source,
        message: String(row.message || '').slice(0, 300), // representative raw message
        digest: String(row.digest || ''),
        pages: new Map(),
        sessions: 0,
        count: 0,
        sampleSids: [],
      };
      clusters.set(key, c);
    }
    c.sessions += 1;
    c.count += Number(row.count) || 1;
    if (row.page) c.pages.set(row.page, (c.pages.get(row.page) || 0) + 1);
    if (row.sid && c.sampleSids.length < 3) c.sampleSids.push(row.sid);
  }
  return [...clusters.values()]
    .map(({ pages, ...c }) => ({
      ...c,
      page: [...pages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
      pageCount: pages.size,
    }))
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count);
}

// Proposal floors: a ticket needs recurrence, not a one-off blip.
const MIN_SESSIONS_FOR_TICKET = 2;
const MIN_EVENTS_FOR_TICKET = 5;
const HIGH_SEVERITY_SESSIONS = 5;
const MAX_ERROR_PROPOSALS = 2;

/**
 * Recurring clusters → dev-task proposals for the superadmin queue. `consoleOrigin` is the
 * customer platform's origin (derived from the digest URL) — used for journey deep-links.
 * Auth-surface errors are labeled need-human per the dev-pipeline conventions (the pipeline
 * never auto-implements auth changes).
 */
export function buildErrorDevTaskProposals(clusters, { consoleOrigin = '', dateKey = '' } = {}) {
  const proposals = [];
  for (const c of clusters) {
    if (c.sessions < MIN_SESSIONS_FOR_TICKET && c.count < MIN_EVENTS_FOR_TICKET) continue;
    const authAdjacent = c.source === 'login';
    const severity = c.sessions >= HIGH_SEVERITY_SESSIONS ? 'high' : 'info';
    const journeyLinks = c.sampleSids
      .map((sid) => `- ${consoleOrigin}/admin/session-timelines?session=${encodeURIComponent(sid)}`)
      .join('\n');
    proposals.push({
      fingerprint: `app-error-${c.source}-${c.key}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80),
      title: `Fix recurring app error [${c.source}]: ${c.message.slice(0, 110) || c.digest || 'unknown error'}`,
      body: [
        '## Context / problem',
        `Real visitors are hitting this error — ${c.sessions} session${c.sessions === 1 ? '' : 's'} (${c.count} occurrence${c.count === 1 ? '' : 's'}) on ${dateKey || 'the last analyzed day'}.`,
        '',
        `- **Error:** ${c.message || '(no message)'}${c.digest ? `\n- **Digest:** ${c.digest}` : ''}`,
        `- **Captured at:** ${c.source} (${c.source === 'error_boundary' ? 'a "Try again" error screen was shown' : c.source === 'login' ? 'auth modal failure' : 'unhandled runtime error'})`,
        `- **Most-hit page:** ${c.page || '—'}${c.pageCount > 1 ? ` (+${c.pageCount - 1} other page${c.pageCount === 2 ? '' : 's'})` : ''}`,
        '',
        '### Broken journeys (superadmin)',
        journeyLinks || '- (no session links captured)',
        '',
        '## Acceptance criteria',
        '- [ ] Root cause identified from the session journey + stack snippet on the timeline',
        '- [ ] Fix landed; the error no longer appears in new sessions',
        '## Notes',
        'Auto-proposed by the Bosun nightly agent from real `app_error` session data; approved by the superadmin.',
      ].join('\n'),
      labels: authAdjacent ? ['web', 'need-human', 'bug'] : ['web', 'ready-for-dev', 'bug'],
      severity,
      evidence: `${c.sessions} sessions / ${c.count} occurrences of "${c.message.slice(0, 80)}" at ${c.source}`,
    });
    if (proposals.length >= MAX_ERROR_PROPOSALS) break;
  }
  return proposals;
}

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import Anthropic from '@anthropic-ai/sdk';
import { markRoundReady, markRoundFailure } from '../utils/finalize.js';
import { usageBreakdown, extractResult } from '../utils/agentResult.js';
import { fetchPrPreviewUrl } from '../utils/github.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

const BETA = 'managed-agents-2026-04-01';
// CONFIRM these status values against the sessions API reference.
const DONE = new Set(['completed', 'ended', 'idle', 'succeeded']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);
const MAX_PREVIEW_TRIES = 12; // ~12 min before we give up waiting for the Vercel preview

// Structured per-round usage line for Cloud Logging. The optimisation dashboard: token
// breakdown, cache-hit ratio, and the THIS-round split (cumulative minus what prior rounds
// already accounted for). Emitted only on a terminal transition so there's one clean line
// per round, not one a minute. `reason` is how the round ended (done|failed|timeout|over_budget).
function logAgentUsage(reason, taskId, task, bd, roundUsd, roundSec) {
  try {
    console.log(`AGENT_USAGE ${JSON.stringify({
      reason, taskId, sessionId: task.sessionId,
      complexity: task.complexity || null, model: task.model || null,
      kind: task.pendingRound?.kind || task.kind || 'initial',
      round: (Array.isArray(task.rounds) ? task.rounds.length : 0) + 1,
      input: bd.input, output: bd.output, cacheRead: bd.cacheRead,
      cacheWrite5m: bd.cacheWrite5m, cacheWrite1h: bd.cacheWrite1h,
      cacheHitRatio: bd.cacheHitRatio,
      cumulativeUsd: round4(bd.totalUsd), roundUsd: round4(roundUsd),
      cumulativeSec: bd.runtimeSec, roundSec,
    })}`);
  } catch { /* noop — logging must never break the poller */ }
}
const round4 = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4;

// Runs every minute. (1) For running tasks: read the session cost, terminate if it
// crosses the tier cap, bill on completion. (2) For completed tasks with a PR: poll
// GitHub for the Vercel preview URL and store it. Idempotent (billed / needsPreview guards).
export const pollSessions = onSchedule(
  { region: 'asia-south1', schedule: 'every 1 minutes', secrets: [ANTHROPIC_API_KEY] },
  async () => {
    const db = getFirestore();

    // (1) Finalize running sessions.
    const running = await db.collection('tasks').where('status', '==', 'running').limit(50).get();
    if (!running.empty) {
      const client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        defaultHeaders: { 'anthropic-beta': BETA },
      });
      for (const docSnap of running.docs) {
        const task = docSnap.data();
        if (!task.sessionId) continue;
        try {
          const session = await client.beta.sessions.retrieve(task.sessionId);
          const bd = usageBreakdown(session); // one parse: cost + token/cache observability
          const costUsd = bd.totalUsd; // cumulative across rounds
          const activeSec = bd.runtimeSec;
          const status = String(session?.status || '');
          // THIS round's split, used for both the cap checks below and the usage log.
          const roundUsd = costUsd - (Number(task.reviewedCostUsd) || 0);
          const roundSec = activeSec - (Number(task.reviewedSeconds) || 0);

          // Terminal status first. The runtime/budget caps below are mid-flight guards that
          // stop a runaway session — they MUST NOT override a session that already finished
          // (status=completed, PR pushed). Otherwise a run that finishes a hair over budget
          // gets marked failed even though the work is real and the customer has a PR.
          if (DONE.has(status)) {
            // Round done → ready for the customer to review. We do NOT charge here; the
            // charge happens when they approve the fix (approveFix).
            logAgentUsage('done', docSnap.id, task, bd, roundUsd, roundSec);
            const { resultSummary, filesChanged, prUrl, idealDescription } = await extractResult(client, task.sessionId);
            await markRoundReady(docSnap.id, { actualCostUsd: costUsd, activeSeconds: activeSec, resultSummary, filesChanged, prUrl, idealDescription });
            continue;
          }
          if (FAILED.has(status)) {
            logAgentUsage('failed', docSnap.id, task, bd, roundUsd, roundSec);
            await markRoundFailure(docSnap.id, { error: 'agent_failed', actualCostUsd: costUsd });
            continue;
          }

          // Still in-flight. Stamp a live snapshot for the admin UI's progress meter
          // (cost so far + active seconds + when we last polled). Customer-facing reads
          // strip these; admin reads expose them via adminListTasks.
          await docSnap.ref.update({
            liveCostUsd: costUsd,
            liveActiveSeconds: activeSec,
            liveUpdatedAt: FieldValue.serverTimestamp(),
          });

          // Enforce the per-round caps so a runaway session can't bleed us.
          const cap = task.maxBudgetUsd || Number(process.env.AGENT_MAX_BUDGET_USD) || 3;

          // Runtime backstop — the PRIMARY guard. `session.usage` can report $0 for minutes
          // while the agent really is burning tokens, so the cost check above goes blind and a
          // run can blow many times past its $ cap before the cost lands. Active runtime is
          // always reported, so we cap it per TIER. Per-round (`roundSec`, computed above)
          // so a revision isn't killed by earlier rounds. Falls back to the global
          // MAX_SESSION_SECONDS for runs with no tier cap (operator infra tests, big-job quotes).
          const maxSec = Number(task.maxSeconds) || Number(process.env.MAX_SESSION_SECONDS) || 1800;
          if (roundSec > maxSec) {
            try { await client.beta.sessions.cancel(task.sessionId); } catch { /* CONFIRM cancel */ }
            logAgentUsage('timeout', docSnap.id, task, bd, roundUsd, roundSec);
            await markRoundFailure(docSnap.id, { error: 'timeout', actualCostUsd: costUsd });
            continue;
          }

          if (roundUsd > cap) {
            try { await client.beta.sessions.cancel(task.sessionId); } catch { /* CONFIRM cancel */ }
            logAgentUsage('over_budget', docSnap.id, task, bd, roundUsd, roundSec);
            await markRoundFailure(docSnap.id, { error: 'over_budget', actualCostUsd: costUsd });
            continue;
          }
        } catch (e) {
          console.error('pollSessions:run', docSnap.id, e?.message || e);
        }
      }
    }

    // (2) Fetch the Vercel preview URL for completed-with-PR tasks.
    const pending = await db.collection('tasks').where('needsPreview', '==', true).limit(20).get();
    for (const docSnap of pending.docs) {
      const t = docSnap.data();
      try {
        const prNum = t.prUrl ? Number(String(t.prUrl).split('/').pop()) : null;
        if (!prNum || !t.repoFullName || !t.orgId) {
          await docSnap.ref.update({ needsPreview: false });
          continue;
        }
        const secret = await db.collection('orgSecrets').doc(t.orgId).get();
        const token = secret.exists ? secret.data().githubToken : null;
        if (!token) {
          await docSnap.ref.update({ needsPreview: false });
          continue;
        }
        const url = await fetchPrPreviewUrl(t.repoFullName, prNum, token);
        const tries = (t.previewTries || 0) + 1;
        if (url) {
          await docSnap.ref.update({ previewUrl: url, needsPreview: false });
        } else {
          await docSnap.ref.update({ previewTries: tries, needsPreview: tries < MAX_PREVIEW_TRIES });
        }
      } catch (e) {
        console.error('pollSessions:preview', docSnap.id, e?.message || e);
      }
    }
  }
);

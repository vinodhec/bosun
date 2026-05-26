import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore } from 'firebase-admin/firestore';
import Anthropic from '@anthropic-ai/sdk';
import { billTaskSuccess, billTaskFailure } from '../utils/finalize.js';
import { sessionCostUsd, extractResult } from '../utils/agentResult.js';
import { fetchPrPreviewUrl } from '../utils/github.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

const BETA = 'managed-agents-2026-04-01';
// CONFIRM these status values against the sessions API reference.
const DONE = new Set(['completed', 'ended', 'idle', 'succeeded']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);
const MAX_PREVIEW_TRIES = 12; // ~12 min before we give up waiting for the Vercel preview

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
          const costUsd = sessionCostUsd(session); // cumulative across rounds
          const cap = task.maxBudgetUsd || Number(process.env.AGENT_MAX_BUDGET_USD) || 3;
          // Cap the CURRENT round's spend, so a revised session isn't killed by earlier rounds.
          const roundUsd = costUsd - (Number(task.billedCostUsd) || 0);

          if (roundUsd > cap) {
            try { await client.beta.sessions.cancel(task.sessionId); } catch { /* CONFIRM cancel */ }
            await billTaskFailure(docSnap.id, { error: 'over_budget' });
            continue;
          }

          const status = String(session?.status || '');
          if (DONE.has(status)) {
            const { resultSummary, filesChanged, prUrl } = await extractResult(client, task.sessionId);
            await billTaskSuccess(docSnap.id, { actualCostUsd: costUsd, resultSummary, filesChanged, prUrl });
          } else if (FAILED.has(status)) {
            await billTaskFailure(docSnap.id, { error: 'agent_failed' });
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

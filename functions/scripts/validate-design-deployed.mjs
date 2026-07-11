#!/usr/bin/env node
/*
 * E2E of the DEPLOYED design pipeline's data path + scheduled poller + billing. Replicates exactly
 * what planDesign does server-side (create designs/{id} + dispatch the kind:'design' session task),
 * then watches the doc as the DEPLOYED pollSessions finalizes it — proving the design branch stores
 * the mock and charges priceForPlanning. (Skips only planDesign's thin HTTP/auth wrapper, which the
 * UI exercises.) No finalizing here — the deployed poller does that.
 *
 *   cd functions && ANTHROPIC_API_KEY=sk-ant-... node scripts/validate-design-deployed.mjs
 */
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const PROJECT = 'bosun-76bba';
const ORG_ID = process.env.ORG_ID || 'q0u3BNn2Hy7CowRYEilC';
const UID = process.env.UID || 'Ms7OAjDmChSwPsLtcRCApiR4nHO2';
const ASK = process.argv[2] ||
  'A simple "Contact us" page: a clear heading, a friendly intro line, and a contact form (name, email, message) with a Send button.';

function fromEnvFile(key) {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*${key}=(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* */ }
  return undefined;
}
process.env.ANTHROPIC_MANAGED_AGENT_ID ||= fromEnvFile('ANTHROPIC_MANAGED_AGENT_ID');
process.env.ANTHROPIC_MANAGED_AGENT_ID_SONNET ||= fromEnvFile('ANTHROPIC_MANAGED_AGENT_ID_SONNET');
process.env.ANTHROPIC_MANAGED_ENVIRONMENT_ID ||= fromEnvFile('ANTHROPIC_MANAGED_ENVIRONMENT_ID');
if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { startDesignSession } = await import('../utils/designSession.js');
const { firebaseSAsFromSecret } = await import('../utils/claudeAgent.js');
const { designContextFromText } = await import('../utils/figma.js');
const { agentIdForModel } = await import('../utils/routeModel.js');

const org = (await db.collection('organisations').doc(ORG_ID).get()).data();
const gh = org?.github;
const secretData = (await db.collection('orgSecrets').doc(ORG_ID).get()).data() || {};
if (!gh?.repoFullName || !gh?.vaultId || !secretData.githubToken) { console.error('org repo not connected'); process.exit(1); }
console.log('repo', gh.repoFullName, '\nask:', ASK, '\n');

// === replicate planDesign + dispatchDesignSession (admin writes) ===
const designRef = db.collection('designs').doc();
await designRef.set({
  userId: UID, orgId: ORG_ID, prompt: ASK, repoFullName: gh.repoFullName,
  status: 'clarifying', awaitingOwner: false,
  turns: [{ role: 'owner', text: ASK, at: Date.now() }],
  brief: '', mockUrl: null, screenshotFileIds: [], imageCount: 0,
  designChargeInr: 0, designCostUsd: 0, createdAt: FieldValue.serverTimestamp(),
});
const figmaDesign = await designContextFromText({ org, secretData, text: ASK });
const { sessionId, firebaseFileIds } = await startDesignSession({
  ask: ASK, repoUrl: `https://github.com/${gh.repoFullName}`, githubToken: secretData.githubToken,
  vaultId: gh.vaultId, agentId: agentIdForModel('sonnet'), firebaseSAs: firebaseSAsFromSecret(secretData),
  figmaDesign, imageFileIds: [], screenshotCount: 0,
});
const taskRef = db.collection('tasks').doc();
await taskRef.set({
  userId: UID, orgId: ORG_ID, designId: designRef.id, kind: 'design', status: 'running',
  sessionId, firebaseFileIds: firebaseFileIds || [], model: 'sonnet',
  maxBudgetUsd: 1.5, maxSeconds: 1800, reviewedCostUsd: 0, reviewedSeconds: 0,
  createdAt: FieldValue.serverTimestamp(),
});
await designRef.update({ designTaskId: taskRef.id, sessionId });
console.log('design', designRef.id, 'session', sessionId, '\nwaiting for the DEPLOYED poller (runs every 1 min)…\n');

// record org balance before, to confirm the charge debited it
const balBefore = Number((await db.collection('organisations').doc(ORG_ID).get()).data()?.balance ?? 0);

for (let i = 0; i < 44; i++) { // ~11 min
  await sleep(15000);
  const d = (await designRef.get()).data() || {};
  console.log(`t+${((i + 1) * 15 / 60).toFixed(1)}m status=${d.status} awaiting=${!!d.awaitingOwner} turns=${(d.turns || []).length} charge=₹${d.designChargeInr || 0}`);
  if (d.status === 'mockup_review') {
    const balAfter = Number((await db.collection('organisations').doc(ORG_ID).get()).data()?.balance ?? 0);
    console.log('\n=== ✅ DEPLOYED POLLER FINALIZED THE MOCK ===');
    console.log('brief:', d.brief);
    console.log('mockUrl:', d.mockUrl);
    console.log('design charge ₹:', d.designChargeInr, ' (org balance', balBefore, '→', balAfter, ')');
    process.exit(0);
  }
  if (d.status === 'clarifying' && d.awaitingOwner) {
    console.log('\n=== ✅ DEPLOYED POLLER PAUSED FOR A QUESTION ===');
    console.log((d.turns || []).filter((t) => t.role === 'agent').pop()?.text);
    process.exit(0);
  }
  if (d.status === 'failed') { console.error('design failed:', d.error); process.exit(1); }
}
console.error('timed out; design', designRef.id);
process.exit(1);

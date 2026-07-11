#!/usr/bin/env node
/*
 * E2E validation of the "Chat & build" engine against a REAL connected org's repo — no UI, no
 * callables, no Firestore writes to real chats. Resolves the org's repo + GitHub token + vault +
 * Figma from Firestore (exactly as production would), runs ONE warm session through the whole flow:
 *   clarify turns (auto-answered) → a "ready" turn (optional preview mock) → auto-APPROVE →
 *   the build turn opens a real PR.
 * Prints each turn, stores any preview mock to Storage via the real saveMockHtml(), and reports the
 * PR url + the priceForChat charge the poller would bill.
 *
 *   cd functions && ANTHROPIC_API_KEY=sk-ant-... ORG_ID=q0u3BNn2Hy7CowRYEilC \
 *     node scripts/validate-chat.mjs ["what to change or add"]
 *
 * Uses Application Default Credentials for bosun-76bba (gcloud ADC). AGENT/ENV ids come from .env.
 * NOTE: this opens a REAL PR on the org's repo (the build turn is the whole point) — run against a
 * test org/repo, and close the PR after.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GCLOUD_PROJECT_OVERRIDE || 'bosun-76bba';
const BUCKET = `${PROJECT}.firebasestorage.app`;
process.env.MOCKSHOTS_BUCKET ||= BUCKET; // mockStore.js reads this

function fromEnvFile(key) {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*${key}=(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return undefined;
}
process.env.ANTHROPIC_API_KEY ||= fromEnvFile('ANTHROPIC_API_KEY');
process.env.ANTHROPIC_MANAGED_AGENT_ID ||= fromEnvFile('ANTHROPIC_MANAGED_AGENT_ID');
process.env.ANTHROPIC_MANAGED_AGENT_ID_SONNET ||= fromEnvFile('ANTHROPIC_MANAGED_AGENT_ID_SONNET');
process.env.ANTHROPIC_MANAGED_ENVIRONMENT_ID ||= fromEnvFile('ANTHROPIC_MANAGED_ENVIRONMENT_ID');

const ORG_ID = process.env.ORG_ID;
const ASK = process.argv[2] ||
  'On the properties page, add a "Pin to top" button on each property card that moves that property to the top of the list and keeps it there on refresh, with a clear pinned marker; allow unpinning.';
if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }
if (!ORG_ID) { console.error('Set ORG_ID'); process.exit(1); }

initializeApp({ projectId: PROJECT, storageBucket: BUCKET });

// Imported AFTER admin init + env wiring so the SDK clients pick up the key.
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const { startChatSession, replyChatSession, buildChatSession, extractChatTurn, MAX_CLARIFY_TURNS } = await import('../utils/chatbotSession.js');
const { firebaseSAsFromSecret } = await import('../utils/claudeAgent.js');
const { extractResult, usageBreakdown } = await import('../utils/agentResult.js');
const { designContextFromText } = await import('../utils/figma.js');
const { agentIdForModel } = await import('../utils/routeModel.js');
const { saveMockHtml } = await import('../utils/mockStore.js');
const { priceForChat } = await import('../utils/billing.js');

const BETA = 'managed-agents-2026-04-01';
const DONE = new Set(['completed', 'ended', 'idle', 'succeeded']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, defaultHeaders: { 'anthropic-beta': BETA } });

// Resolve repo context from the connected org — same fields loadOrgCtx uses.
const db = getFirestore();
const orgSnap = await db.collection('organisations').doc(ORG_ID).get();
if (!orgSnap.exists) { console.error('org not found:', ORG_ID); process.exit(1); }
const org = orgSnap.data();
const gh = org.github;
if (!gh?.repoFullName || !gh?.vaultId) { console.error('org has no repo connected'); process.exit(1); }
const secretSnap = await db.collection('orgSecrets').doc(ORG_ID).get();
const secretData = secretSnap.exists ? secretSnap.data() : {};
if (!secretData.githubToken) { console.error('org has no GitHub token'); process.exit(1); }
console.log(`org ${ORG_ID} → repo ${gh.repoFullName}`);
console.log(`ask: ${ASK}\n`);

const figmaDesign = await designContextFromText({ org, secretData, text: ASK });
const firebaseSAs = firebaseSAsFromSecret(secretData);

// Wait for the current turn to finish (agent goes idle/completed) or fail. Building a real change on
// a real repo can take several minutes; be generous.
async function waitTurn(sessionId, label) {
  const STEP = 15, MAX = 64; // ~16 min
  let lastUsd = 0;
  for (let i = 0; i < MAX; i++) {
    await sleep(STEP * 1000);
    let s;
    try { s = await client.beta.sessions.retrieve(sessionId); } catch (e) { console.log('  retrieve err', e?.message); continue; }
    lastUsd = usageBreakdown(s).totalUsd;
    console.log(`  ${label} t+${((i + 1) * STEP / 60).toFixed(1)}m status=${s?.status} $${lastUsd.toFixed(4)}`);
    if (DONE.has(String(s?.status))) return { res: 'done', costUsd: lastUsd };
    if (FAILED.has(String(s?.status))) return { res: 'failed', costUsd: lastUsd };
  }
  return { res: 'timeout', costUsd: lastUsd };
}

const { sessionId } = await startChatSession({
  ask: ASK,
  repoUrl: `https://github.com/${gh.repoFullName}`,
  githubToken: secretData.githubToken,
  vaultId: gh.vaultId,
  agentId: agentIdForModel('sonnet'),
  firebaseSAs,
  figmaDesign,
  imageFileIds: [],
  screenshotCount: 0,
});
console.log('chat session:', sessionId);

const chatId = `validate-${Date.now()}`;
let approved = false;
let costUsd = 0;

for (let turn = 0; turn <= MAX_CLARIFY_TURNS + 1; turn++) {
  const wt = await waitTurn(sessionId, `turn${turn}`);
  costUsd = wt.costUsd;
  if (wt.res !== 'done') { console.error('turn ended:', wt.res); break; }

  // After approval, the next DONE is the BUILD turn — parse it as a fix result (a PR).
  if (approved) {
    const result = await extractResult(client, sessionId);
    console.log('\n=== BUILD TURN ===');
    console.log('summary:', result.resultSummary);
    console.log('files:', result.filesChanged);
    console.log('PR:', result.prUrl || '(none)');
    if (result.prUrl) {
      const charge = priceForChat(costUsd, { rate: 85 });
      console.log(`\n=== WOULD CHARGE ===\ntotal COGS $${costUsd.toFixed(4)} → priceForChat ₹${charge} (cap ₹1500)`);
      console.log('\n✅ PASS — clarify → approve → build → PR');
      process.exit(0);
    }
    console.error('\n❌ build turn produced no PR — inspect session', sessionId);
    process.exit(1);
  }

  const turnRes = await extractChatTurn(client, sessionId);
  if (turnRes.mode === 'ready') {
    console.log('\n=== READY TO BUILD ===\nsummary:', turnRes.summary, '\npreview:', turnRes.preview);
    if (turnRes.mockHtml) {
      try { writeFileSync(`/tmp/${chatId}.html`, turnRes.mockHtml); } catch { /* */ }
      const url = await saveMockHtml(chatId, turnRes.mockHtml);
      console.log('preview mock stored:', url, '\nlocal:', `/tmp/${chatId}.html`);
    }
    console.log('\n--- AUTO-APPROVE → BUILD ---');
    await buildChatSession({ sessionId, notes: '' });
    approved = true;
    continue;
  }

  console.log(`\n--- AGENT ASKED (turn ${turn}) ---\n${turnRes.questions}\n`);
  if (turn === MAX_CLARIFY_TURNS) { console.error('hit MAX_CLARIFY_TURNS without getting to ready'); break; }
  const answer = 'Use your best judgment and match the existing site\'s style. Keep it simple. Go ahead — you don\'t need a preview, just make the change.';
  console.log(`--- AUTO-ANSWER ---\n${answer}\n`);
  await replyChatSession({ sessionId, answer });
}

console.error('\nDid not reach a PR. Inspect session', sessionId);
process.exit(1);

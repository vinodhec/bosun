#!/usr/bin/env node
/*
 * E2E validation of the "Design a screen" engine against a REAL connected org's repo — no UI,
 * no callables. Resolves the org's repo + GitHub token + vault + Figma from Firestore (exactly
 * as production would), runs a design session (clarify chat → mock render), auto-answers any
 * clarifying questions, then persists the returned base64 PNGs to Firebase Storage via the real
 * saveMockShots(). Prints the brief + the stored image URLs, and dumps the PNGs locally to view.
 *
 *   cd functions && ANTHROPIC_API_KEY=sk-ant-... ORG_ID=q0u3BNn2Hy7CowRYEilC \
 *     node scripts/validate-design.mjs ["the screen to design"]
 *
 * Uses Application Default Credentials for mybosun-55015 (gcloud ADC). AGENT/ENV ids come from .env.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GCLOUD_PROJECT_OVERRIDE || 'mybosun-55015';
const BUCKET = `${PROJECT}.firebasestorage.app`;
process.env.MOCKSHOTS_BUCKET ||= BUCKET; // mockShots.js reads this

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
  'Add a simple "Contact us" page: a clear heading, one friendly intro line, and a contact form with name, email and message fields plus a Send button.';
if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }
if (!ORG_ID) { console.error('Set ORG_ID'); process.exit(1); }

initializeApp({ projectId: PROJECT, storageBucket: BUCKET });

// Imported AFTER admin init + env wiring so the SDK clients pick up the key.
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const { startDesignSession, replyDesignSession, extractDesignTurn, MAX_CLARIFY_TURNS } = await import('../utils/designSession.js');
const { firebaseSAsFromSecret } = await import('../utils/claudeAgent.js');
const { designContextFromText } = await import('../utils/figma.js');
const { agentIdForModel } = await import('../utils/routeModel.js');
const { saveMockHtml } = await import('../utils/mockStore.js');

const BETA = 'managed-agents-2026-04-01';
const DONE = new Set(['completed', 'ended', 'idle', 'succeeded']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, defaultHeaders: { 'anthropic-beta': BETA } });

// Resolve repo context from the connected org — same fields loadOrgCtx / startFeatureStep use.
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

// Wait for the current turn to finish (agent goes idle/completed) or fail. Generous: exploring a
// real repo + rendering can take several minutes.
async function waitTurn(sessionId, label) {
  const STEP = 15, MAX = 56; // ~14 min
  for (let i = 0; i < MAX; i++) {
    await sleep(STEP * 1000);
    let s;
    try { s = await client.beta.sessions.retrieve(sessionId); } catch (e) { console.log('  retrieve err', e?.message); continue; }
    const cost = (Number(s?.usage?.input_tokens) || 0) + (Number(s?.usage?.output_tokens) || 0);
    console.log(`  ${label} t+${((i + 1) * STEP / 60).toFixed(1)}m status=${s?.status} tok=${cost}`);
    if (DONE.has(String(s?.status))) return 'done';
    if (FAILED.has(String(s?.status))) return 'failed';
  }
  return 'timeout';
}

const { sessionId } = await startDesignSession({
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
console.log('design session:', sessionId);

const designId = `validate-${Date.now()}`;
let done = false;
for (let turn = 0; turn <= MAX_CLARIFY_TURNS && !done; turn++) {
  const res = await waitTurn(sessionId, `turn${turn}`);
  if (res !== 'done') { console.error('turn ended:', res); break; }
  const { questions, brief, ready, mockHtml } = await extractDesignTurn(client, sessionId);

  if (ready) {
    console.log('\n=== MOCK READY ===\nbrief:', brief);
    console.log('mock HTML length:', mockHtml.length, 'chars');
    // Persist locally to eyeball, and to Firebase Storage via the real helper.
    try { writeFileSync(`/tmp/${designId}.html`, mockHtml); } catch { /* */ }
    const url = await saveMockHtml(designId, mockHtml);
    console.log('\n=== STORED IN FIREBASE STORAGE ===');
    console.log(url);
    console.log('local copy: /tmp/' + designId + '.html');
    done = true;
    break;
  }

  console.log(`\n--- AGENT ASKED (turn ${turn}) ---\n${questions}\n`);
  if (turn === MAX_CLARIFY_TURNS) { console.error('hit MAX_CLARIFY_TURNS without a mock'); break; }
  const answer = 'Use your best judgment and match the existing site\'s style and colours. Keep it simple, no extra fields. Please go ahead and show me the mockup now.';
  console.log(`--- AUTO-ANSWER ---\n${answer}\n`);
  await replyDesignSession({ sessionId, answer });
}

if (!done) console.error('\nNo mock produced. Inspect session', sessionId);
console.log('\nfinal session id:', sessionId);
process.exit(done ? 0 : 1);

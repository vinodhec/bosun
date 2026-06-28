#!/usr/bin/env node
/*
 * E2E validation of the "Size up the competition" engine against a REAL connected org's repo — no
 * UI, no callables. Resolves the org's repo + GitHub token + vault from Firestore (exactly as
 * production would), runs a REAL managed-agent compare session (clone repo + read it + the agent
 * researches competitors with its own web tools), auto-answers any clarifying
 * questions, then renders the returned report to a clean standalone HTML file. READ-ONLY: the agent
 * never edits the repo or opens a PR.
 *
 *   cd functions && ANTHROPIC_API_KEY=sk-ant-... ORG_ID=q0u3BNn2Hy7CowRYEilC \
 *     node scripts/validate-compare.mjs ["the comparison ask with competitor links"]
 *
 * Uses Application Default Credentials for bosun-76bba (gcloud ADC). AGENT/ENV ids come from .env.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GCLOUD_PROJECT_OVERRIDE || 'bosun-76bba';

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
  'Compare our property listings to the big portals magicbricks.com and 99acres.com — what do buyers expect that we are missing, and where are we already ahead?';
if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }
if (!ORG_ID) { console.error('Set ORG_ID'); process.exit(1); }

initializeApp({ projectId: PROJECT });

// Imported AFTER admin init + env wiring so the SDK clients pick up the key.
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const { startCompareSession, replyCompareSession, extractCompareTurn, MAX_CLARIFY_TURNS } = await import('../utils/compareSession.js');
const { firebaseSAsFromSecret } = await import('../utils/claudeAgent.js');
const { designContextFromText } = await import('../utils/figma.js');
const { agentIdForModel } = await import('../utils/routeModel.js');
const { priceForCompare } = await import('../shared/billing.js');

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

// The agent researches competitors itself via web tools — Bosun does no server-side scraping.
const figmaDesign = await designContextFromText({ org, secretData, text: ASK });
const firebaseSAs = firebaseSAsFromSecret(secretData);

async function waitTurn(sessionId, label) {
  const STEP = 15, MAX = 80; // ~20 min
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

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SCOPE = { fix: ['Quick fix', '#fde68a'], design: ['New look', '#bfdbfe'], feature: ['Bigger add', '#ddd6fe'] };
function renderHtml(report, meta) {
  const findings = report.findings.map((f) => {
    const [label, col] = SCOPE[f.scope] || SCOPE.fix;
    return `<li class="card">
      <div class="row"><strong>${esc(f.title)}</strong><span class="badge" style="background:${col}">${label}</span></div>
      <p>${esc(f.detail)}</p>
      ${f.evidence ? `<p class="ev">Seen on a competitor: ${esc(f.evidence)}</p>` : ''}
      <p class="pre">→ ${esc(f.suggestedInput)}</p>
    </li>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Size up the competition — ${esc(meta.repo)}</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:24px auto;padding:0 16px;color:#1f2937;line-height:1.5}
  h1{font-size:22px} h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:24px 0 8px}
  .ask{color:#6b7280;font-size:14px} .summary{background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:14px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:12px} @media(max-width:640px){.cols{grid-template-columns:1fr}}
  .col{border-radius:12px;padding:12px} .ahead{background:#fffbeb;border:1px solid #fde68a} .we{background:#ecfdf5;border:1px solid #a7f3d0}
  .col h3{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.05em} .ahead h3{color:#b45309} .we h3{color:#047857}
  ul{list-style:none;padding:0;margin:0} .col li{margin:6px 0;font-size:14px}
  .card{border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:8px 0}
  .row{display:flex;justify-content:space-between;align-items:start;gap:8px} .badge{font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:6px;white-space:nowrap}
  .ev{font-size:12px;color:#6b7280;margin:4px 0 0} .pre{font-size:13px;background:#f3f4f6;border-radius:8px;padding:6px 8px;margin:8px 0 0}
  .meta{color:#9ca3af;font-size:12px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px}
  p{margin:6px 0}
</style></head><body>
<h1>📊 Size up the competition</h1>
<p class="ask">“${esc(meta.ask)}”</p>
<div class="summary">${esc(report.summary)}</div>
<div class="cols">
  <div class="col ahead"><h3>Where they're ahead</h3><ul>${report.theirEdge.map((e) => `<li>• ${esc(e.point)}${e.evidence ? ` <span style="color:#9ca3af">— ${esc(e.evidence)}</span>` : ''}</li>`).join('') || '<li>Nothing major.</li>'}</ul></div>
  <div class="col we"><h3>Where you're ahead</h3><ul>${report.ourEdge.map((e) => `<li>• ${esc(e.point)}</li>`).join('') || '<li>—</li>'}</ul></div>
</div>
<h2>What we'd do about it</h2>
<ul>${findings}</ul>
<div class="meta">Repo: ${esc(meta.repo)} · Session: ${esc(meta.sessionId)} · COGS ≈ $${meta.costUsd.toFixed(4)} · Charge: first report ₹${meta.chargeInr} (refine ₹${meta.refineInr})<br>Generated by Bosun compare engine (read-only managed-agent session; competitors researched by the agent's own web tools).</div>
</body></html>`;
}

const { sessionId } = await startCompareSession({
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
console.log('compare session:', sessionId);

const outId = `compare-${Date.now()}`;
let done = false;
for (let turn = 0; turn <= MAX_CLARIFY_TURNS && !done; turn++) {
  const res = await waitTurn(sessionId, `turn${turn}`);
  if (res !== 'done') { console.error('turn ended:', res); break; }
  const { questions, ready, report } = await extractCompareTurn(client, sessionId);

  if (ready) {
    const s = await client.beta.sessions.retrieve(sessionId);
    const costUsd = (Number(s?.usage?.input_tokens) || 0) * 3 / 1e6 + (Number(s?.usage?.output_tokens) || 0) * 15 / 1e6;
    const chargeInr = priceForCompare(costUsd, { rate: 88 });
    const refineInr = priceForCompare(costUsd, { rate: 88, isRefine: true });
    console.log('\n=== REPORT READY ===\n' + report.summary);
    console.log(`findings: ${report.findings.length} · theirEdge: ${report.theirEdge.length} · ourEdge: ${report.ourEdge.length}`);
    console.log(`COGS ≈ $${costUsd.toFixed(4)} → charge ₹${chargeInr} (refine ₹${refineInr})`);
    const html = renderHtml(report, { ask: ASK, repo: gh.repoFullName, sessionId, costUsd, chargeInr, refineInr });
    const path = `/tmp/${outId}.html`;
    writeFileSync(path, html);
    console.log('\n=== HTML REPORT ===\n' + path);
    done = true;
    break;
  }

  console.log(`\n--- AGENT ASKED (turn ${turn}) ---\n${questions}\n`);
  if (turn === MAX_CLARIFY_TURNS) { console.error('hit MAX_CLARIFY_TURNS without a report'); break; }
  const answer = 'Compare against MagicBricks and 99acres — they offer map-based search, price per sqft on every listing, an EMI calculator, price trends, and both phone and WhatsApp contact. Use your best judgment from the repo for what our site does. Please produce the comparison report now.';
  console.log(`--- AUTO-ANSWER ---\n${answer}\n`);
  await replyCompareSession({ sessionId, answer });
}

if (!done) console.error('\nNo report produced. Inspect session', sessionId);
console.log('\nfinal session id:', sessionId);
process.exit(done ? 0 : 1);

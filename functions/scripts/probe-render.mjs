#!/usr/bin/env node
/*
 * SPIKE — can the managed-agent sandbox render a standalone HTML mock to a PNG image
 * (no customer app, no build, no auth) and upload it as evidence?  This gates the
 * "Design a screen" mockup mechanism: HTML + headless Chromium (preferred, full
 * fidelity) with a browser-free Satori fallback.
 *
 * It starts a session with NO repo, hands the agent a self-contained HTML file, and asks
 * it to: (1) screenshot it headless at desktop + mobile, installing Chromium if needed;
 * (2) if a browser can't run, render the SAME html to PNG with Satori + @resvg/resvg-js
 * (pure Node, no browser); (3) upload each PNG to catbox.moe; (4) report what worked.
 *
 *   cd functions && ANTHROPIC_API_KEY=sk-ant-... \
 *     AGENT_ID=$ANTHROPIC_MANAGED_AGENT_ID ENV_ID=$ANTHROPIC_MANAGED_ENVIRONMENT_ID \
 *     node scripts/probe-render.mjs
 *
 * AGENT_ID / ENV_ID default to the ANTHROPIC_MANAGED_AGENT_ID / _ENVIRONMENT_ID in .env.
 * Installing a browser can take minutes — this polls for up to ~12 min.
 */
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';

const BETA = 'managed-agents-2026-04-01';
const DONE = ['completed', 'ended', 'idle', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal .env reader (functions/ has no dotenv) so only ANTHROPIC_API_KEY need be passed.
function fromEnvFile(key) {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^\\s*${key}=(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return undefined;
}

const apiKey = process.env.ANTHROPIC_API_KEY || fromEnvFile('ANTHROPIC_API_KEY');
const agent = process.env.AGENT_ID || process.env.ANTHROPIC_MANAGED_AGENT_ID || fromEnvFile('ANTHROPIC_MANAGED_AGENT_ID');
const environment_id = process.env.ENV_ID || process.env.ANTHROPIC_MANAGED_ENVIRONMENT_ID || fromEnvFile('ANTHROPIC_MANAGED_ENVIRONMENT_ID');
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1); }
if (!agent) { console.error('Set AGENT_ID (or ANTHROPIC_MANAGED_AGENT_ID in .env)'); process.exit(1); }
if (!environment_id) { console.error('Set ENV_ID (or ANTHROPIC_MANAGED_ENVIRONMENT_ID in .env)'); process.exit(1); }

const client = new Anthropic({ apiKey, defaultHeaders: { 'anthropic-beta': BETA } });

// A representative "screen mock" — exactly the kind of self-contained, app-free HTML the
// design session would emit (inline CSS, web-safe + Google font, flex layout, a card + form).
const MOCK_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
  *{box-sizing:border-box;margin:0} body{font-family:Inter,system-ui,sans-serif;background:#f6f7f9;color:#0f172a}
  .wrap{max-width:560px;margin:48px auto;padding:0 20px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:32px;box-shadow:0 8px 30px rgba(2,6,23,.06)}
  h1{font-size:26px;font-weight:700;margin-bottom:8px} p.sub{color:#64748b;margin-bottom:24px}
  label{display:block;font-weight:600;font-size:14px;margin:16px 0 6px}
  input,textarea{width:100%;padding:12px 14px;border:1px solid #cbd5e1;border-radius:10px;font:inherit}
  button{margin-top:24px;width:100%;padding:14px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-weight:600;font-size:16px}
</style></head><body><div class="wrap"><div class="card">
  <h1>Get in touch</h1><p class="sub">We usually reply within a day.</p>
  <label>Your name</label><input value="">
  <label>Email</label><input value="">
  <label>Message</label><textarea rows="4"></textarea>
  <button>Send message</button>
</div></div></body></html>`;

const INSTRUCTION = `This is a CAPABILITY SPIKE for an image-rendering pipeline. There is no repo. Work entirely in a scratch dir like /tmp/spike. Do NOT open a PR.

Goal: render a standalone HTML file to PNG screenshots and upload them, WITHOUT running any real app. Report exactly what works in this sandbox.

Steps:
1. Write this file to /tmp/spike/mock.html (verbatim):
\`\`\`html
${MOCK_HTML}
\`\`\`
2. PREFERRED — headless Chromium. Try to screenshot mock.html with a headless browser at desktop (1440x900) and mobile (390x844) widths, saving desktop.png and mobile.png. If no browser is present, install one (e.g. \`npx -y playwright@latest install --with-deps chromium\` then use playwright, or puppeteer). TIME how long the install takes. Record whether this worked and any errors verbatim.
3. FALLBACK — browser-free. If and only if the browser path fails, render the SAME HTML to a PNG using Satori + @resvg/resvg-js in pure Node (\`npm i satori @resvg/resvg-js\`; fetch an Inter .ttf for the font). Record whether this worked.
4. Upload each PNG that was produced to catbox.moe and collect the URLs:
   curl -s -F "reqtype=fileupload" -F "fileToUpload=@desktop.png" https://catbox.moe/user/api.php
5. Report a short plain summary, then on the VERY LAST line append ONLY:
RESULT_JSON: {"browser":{"ok":true|false,"tool":"playwright|puppeteer|none","installSeconds":<int|null>,"error":"<short|null>"},"satori":{"ok":true|false|"untried","error":"<short|null>"},"shots":["<catbox url>", ...],"recommend":"chromium|satori"}`;

const session = await client.beta.sessions.create({ agent, environment_id });
console.log('session:', session.id);
await client.beta.sessions.events.send(session.id, {
  events: [{ type: 'user.message', content: [{ type: 'text', text: INSTRUCTION }] }],
});

let s;
const STEP = 15, MAX = 48; // ~12 min
for (let i = 0; i < MAX; i++) {
  await sleep(STEP * 1000);
  try { s = await client.beta.sessions.retrieve(session.id); } catch (e) { console.log('retrieve err', e?.message); continue; }
  console.log(`t+${((i + 1) * STEP / 60).toFixed(1)}m  status=${s?.status}  usage=${JSON.stringify(s?.usage ?? {})}`);
  if (DONE.includes(String(s?.status))) break;
}

// Pull the agent's text messages and the final RESULT_JSON line.
let resultLine = null;
const agentTexts = [];
try {
  const res = await client.beta.sessions.events.list(session.id);
  const events = res?.data ?? res?.body?.data ?? (Array.isArray(res) ? res : []);
  for (const ev of events) {
    if (ev?.type === 'agent.message') {
      for (const b of ev.content ?? []) {
        if (b?.type === 'text' && b.text) {
          agentTexts.push(b.text);
          for (const line of b.text.split('\n')) {
            const m = line.match(/RESULT_JSON:\s*(\{.*\})\s*$/);
            if (m) resultLine = m[1];
          }
        }
      }
    }
  }
} catch (e) { console.log('events.list err', e?.message); }

console.log('\n=== LAST AGENT MESSAGE ===\n' + (agentTexts.at(-1) || '(none)'));
console.log('\n=== RESULT_JSON ===');
if (resultLine) {
  try { console.log(JSON.stringify(JSON.parse(resultLine), null, 2)); }
  catch { console.log('(unparseable) ' + resultLine); }
} else {
  console.log('(no RESULT_JSON — inspect the session in the platform console)');
}
console.log('\nfinal status:', s?.status, '\nsession id (left for inspection):', session.id);

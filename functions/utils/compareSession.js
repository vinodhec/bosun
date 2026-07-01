// "Size up the competition" — a code-aware, clarify-first comparison session. The agent explores the
// owner's OWN repo to understand what their site actually does (whatever the business is — Bosun makes
// NO assumption about the domain), researches the competitors with its OWN web_search/web_fetch tools
// (and/or the owner's screenshots), and writes a TWO-SIDED scorecard: where rivals beat us (catch-up)
// AND where WE beat them / they lack something (amplify). Each finding is tagged with the smallest
// Bosun tool that delivers it — a quick fix, a screen design, or a planned feature — so the owner can
// act on it in one tap. It NEVER edits the app or opens a PR.
//
// The session is async + MULTI-TURN, exactly like the design session: it goes idle after each turn.
// A question turn pauses for the owner (it asks, in plain English, for the screenshots / choices /
// competitor names it genuinely needs); a finished turn produces the report. pollSessions finalizes
// each turn; the report is charged priceForCompare. Nothing is charged until a report is ready.

import { startFixSession, continueFixSession } from './claudeAgent.js';
import { extractJamUrl } from './agentResult.js';

export const MAX_CLARIFY_TURNS = 5; // owner replies that resume the chat before we force a report

// The result contract — appended to every comparison instruction. The agent asks plain questions
// until confident, then emits ONE machine-readable report on the last line (the owner never sees the
// raw JSON; Bosun renders it into the scorecard + action buttons).
const REPORT_PROTOCOL =
  `You are COMPARING, not building. Do NOT touch the app, do NOT open a pull request, do NOT take screenshots.\n\n` +
  `Decide what you can settle on your own vs. what only the owner can give you. WORK AUTONOMOUSLY as far ` +
  `as you can: read the owner's repo to learn what their site really does, and use your web_search / ` +
  `web_fetch tools (plus any screenshots provided) to study the competitors.\n\n` +
  `ACCURACY OVER COMPLETENESS — a single wrong "you're missing X" when the site ALREADY HAS X is far ` +
  `worse than omitting a point, because it destroys the owner's trust in the whole report. So before you ` +
  `state that ANYTHING is missing from (or weaker on) the owner's site, VERIFY it against the real code: ` +
  `search the WHOLE repo (grep/glob for the feature and its common synonyms), not just one file. Only call ` +
  `something absent if a thorough search genuinely finds no implementation; if you find it — even ` +
  `partially, conditionally, or elsewhere — describe what actually exists instead of calling it missing. ` +
  `If you cannot confirm either way, leave the point out or say plainly you could not confirm — never ` +
  `assert an absence you did not verify, and never name a file or component you did not actually open.\n\n` +
  `ONLY pause to ask the ` +
  `owner when you are genuinely blocked — e.g. a ` +
  `competitor you can't read (ask for 1-2 screenshots of the exact page), the code is ambiguous (ask ` +
  `which part is the live one), or you don't know who their competitors are (ask them to name 2-3). Ask ` +
  `the FEWEST questions, in ONE short batch, in plain friendly English a shop owner would use — NEVER ` +
  `technical words (no code, files, components, API, etc.). Until you are confident, output ONLY the ` +
  `questions — NO report, NO RESULT_JSON.\n\n` +
  `When — and only when — you are confident, write the comparison. Reply with ONE short, friendly, ` +
  `plain-English sentence for the owner (a headline of how they stack up). This visible reply MUST ` +
  `contain NO technical words and NO "scope/kind" labels. Then on the VERY LAST line append ONLY this ` +
  `machine-readable result (the owner never sees it):\n` +
  `RESULT_JSON: {` +
  `"summary":"<2-3 plain sentences: the overall picture vs competitors>",` +
  `"theirEdge":[{"point":"<plain: a thing a competitor does better>","evidence":"<plain: which competitor / what you saw>"}],` +
  `"ourEdge":[{"point":"<plain: a thing WE do that they don't, or do better>"}],` +
  `"findings":[{"title":"<3-6 word plain title>","detail":"<1-2 plain sentences: what to change and why it helps>",` +
  `"evidence":"<plain: what the competitor does that prompts this, if any>",` +
  `"scope":"fix" or "design" or "feature",` +
  `"suggestedInput":"<a ready-to-use plain-English request the owner could hand us to do this>"}],` +
  `"ready":true}\n\n` +
  `Choose each finding's "scope" by the size of the work: "fix" = one small bounded change to ` +
  `something that already exists; "design" = it's about how a screen looks / its layout; "feature" = ` +
  `a brand-new, multi-step capability. Put 3-7 of the most valuable findings, most impactful first. ` +
  `Include at least one "ourEdge" if the site genuinely has a strength worth making more prominent.`;

// The complete initial instruction (a full prompt like buildDesignPrompt — replaces the fix prompt).
// Domain-agnostic: Bosun assumes nothing about the business. What to compare and against whom comes
// from the owner's ask + the org's own repo (AGENTS.md), and the agent researches with its web tools.
export function buildComparePrompt(ask, { figmaDesign = null, screenshotCount = 0 } = {}) {
  const jamUrl = extractJamUrl(ask);
  const shotNote = screenshotCount > 0
    ? `The owner attached ${screenshotCount} screenshot${screenshotCount > 1 ? 's' : ''} (their site and/or competitors) — look at ${screenshotCount > 1 ? 'them' : 'it'}.\n\n`
    : '';
  const jamNote = jamUrl
    ? `The owner shared a screen recording: ${jamUrl} — you may read it with the jam tools (getConsoleLogs / getNetworkRequests / getUserEvents, passing the URL as jamId) if it helps.\n\n`
    : '';

  return (
    `A non-technical website owner wants to know how their site compares to competitors:\n"${ask}"\n\n` +
    shotNote + jamNote +
    `First EXPLORE the owner's repo at /workspace/repo to learn what their site ACTUALLY does — read ` +
    `AGENTS.md if present (it may name the competitors to compare against, or how the owner wants the ` +
    `comparison done), then the real pages/components/data behind whatever the owner asked you to ` +
    `compare: what it shows, how it looks, what a visitor can do. Ignore generated or dependency ` +
    `folders (node_modules, dist, build, .next, vendor) and lock files.\n\n` +
    `Then research the competitors with your web_search and web_fetch tools: open the competitor sites ` +
    `the owner named (or that AGENTS.md names) and see what they offer. If a competitor blocks you or ` +
    `needs a login, ask the owner for a screenshot of the exact page instead. If nobody has said who ` +
    `the competitors are, ask the owner to name 2-3.\n\n` +
    REPORT_PROTOCOL
  );
}

// The continue text when the owner answers (a clarify reply or a "look again" refine). Sent on the
// SAME session, which already holds the protocol + repo context. Keep it short.
export function buildCompareReply(answer) {
  return (
    `The owner replied:\n"${answer}"\n\n` +
    `If you now have what you need, write the comparison and output RESULT_JSON exactly as instructed ` +
    `earlier. If something important is still unclear, ask one more short batch of plain-English questions.`
  );
}

/** Start the comparison session (async). Mirrors a fix dispatch with the compare instruction + no PR. */
export async function startCompareSession({
  ask, repoUrl, githubToken, vaultId, agentId, firebaseSAs = [],
  figmaDesign = null, imageFileIds = [], screenshotCount = 0, documents = [],
}) {
  const instruction = buildComparePrompt(ask, { figmaDesign, screenshotCount });
  return startFixSession({
    instruction,
    repoUrl, githubToken, vaultId, agentId, firebaseSAs,
    figmaDesign, imageFileIds, documents,
  });
}

/** Resume the comparison session with the owner's reply (clarify answer or refine). Carries fresh
 *  screenshots through by `images` — continueFixSession appends them so the agent sees them. */
export async function replyCompareSession({ sessionId, answer, images = [] }) {
  return continueFixSession({ sessionId, instruction: buildCompareReply(answer), images });
}

const RESULT_LINE_RE = /RESULT_JSON:\s*(\{[\s\S]*\})\s*$/m;

// Strip anything technical that leaks into the owner-facing chat text — fenced/inline code and the
// machine-readable result line. The report itself comes from RESULT_JSON, parsed separately.
function sanitizeOwnerText(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(RESULT_LINE_RE, '')
    .replace(/`[^`]*`/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanStr(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

// Normalise the parsed report into the shape the card + Firestore expect (caps + a clean scope enum).
function normalizeReport(json) {
  const theirEdge = (Array.isArray(json.theirEdge) ? json.theirEdge : [])
    .map((e) => ({ point: cleanStr(e?.point, 240), evidence: cleanStr(e?.evidence, 240) }))
    .filter((e) => e.point).slice(0, 8);
  const ourEdge = (Array.isArray(json.ourEdge) ? json.ourEdge : [])
    .map((e) => ({ point: cleanStr(e?.point, 240) }))
    .filter((e) => e.point).slice(0, 8);
  const findings = (Array.isArray(json.findings) ? json.findings : [])
    .map((f) => ({
      title: cleanStr(f?.title, 80),
      detail: cleanStr(f?.detail, 400),
      evidence: cleanStr(f?.evidence, 240),
      scope: ['fix', 'design', 'feature'].includes(f?.scope) ? f.scope : 'fix',
      suggestedInput: cleanStr(f?.suggestedInput, 600),
    }))
    .filter((f) => f.title || f.detail)
    .slice(0, 8);
  return { summary: cleanStr(json.summary, 800), theirEdge, ourEdge, findings };
}

/**
 * Parse a finished comparison turn. If the agent produced a report, returns { ready:true, report };
 * otherwise it's a question round, so `questions` is the plain-text message shown to the owner.
 * Fail-safe: a turn that parses to neither is treated as questions (never charges, never reports).
 */
export async function extractCompareTurn(client, sessionId) {
  let questions = '';
  let ready = false;
  let report = null;
  try {
    const res = await client.beta.sessions.events.list(sessionId);
    const events = res?.data ?? res?.body?.data ?? (Array.isArray(res) ? res : []);
    let lastText = '';
    for (const ev of events) {
      if (ev?.type === 'agent.message') {
        const parts = (ev.content ?? []).filter((b) => b?.type === 'text' && b.text).map((b) => b.text);
        if (parts.length) lastText = parts.join('\n');
      }
    }
    const m = lastText.match(RESULT_LINE_RE);
    if (m) {
      const json = JSON.parse(m[1]);
      if (json.ready === true) {
        const r = normalizeReport(json);
        if (r.findings.length || r.summary) { ready = true; report = r; }
      }
    }
    questions = sanitizeOwnerText(lastText);
  } catch (e) {
    console.warn('extractCompareTurn', sessionId, e?.message || e);
  }
  return { questions, ready, report };
}

// Render a finished report into a self-contained, shareable HTML page (inline CSS, no deps) — the
// same idea as the design mock: saved to Storage and opened/shared via a durable URL. Deliberately
// shows NO internal cost (the owner shares this externally). Plain-language scope labels only.
const REPORT_SCOPE_LABEL = { fix: ['Quick fix', '#92400e', '#fef3c7'], design: ['New look', '#1e40af', '#dbeafe'], feature: ['Bigger add', '#5b21b6', '#ede9fe'] };
const htmlEsc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function renderReportHtml(report, { prompt = '', repoFullName = '' } = {}) {
  const r = report || {};
  const site = (repoFullName.split('/').pop() || 'your site');
  const theirEdge = (r.theirEdge || []).map((e) => `<li>${htmlEsc(e.point)}</li>`).join('') || '<li>Nothing major.</li>';
  const ourEdge = (r.ourEdge || []).map((e) => `<li>${htmlEsc(e.point)}</li>`).join('') || '<li>—</li>';
  const actions = (r.findings || []).map((f) => {
    const [label, fg, bg] = REPORT_SCOPE_LABEL[f.scope] || REPORT_SCOPE_LABEL.fix;
    return `<li>
      <div class="t"><span class="ti">${htmlEsc(f.title)}</span><span class="badge" style="color:${fg};background:${bg}">${label}</span></div>
      <p class="d">${htmlEsc(f.detail)}</p>
      ${f.evidence ? `<p class="ev">Seen on a competitor: ${htmlEsc(f.evidence)}</p>` : ''}
      <p class="do"><strong>What we'd do:</strong> ${htmlEsc(f.suggestedInput)}</p>
    </li>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>How ${htmlEsc(site)} compares</title>
<style>
  :root{--ink:#1f2937;--soft:#6b7280;--line:#e5e7eb}
  *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);line-height:1.55;margin:0;background:#f3f4f6}
  .page{max-width:840px;margin:0 auto;background:#fff;padding:36px 28px 48px}
  .eyebrow{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#0d9488}
  h1{font-size:26px;margin:4px 0 6px} .ask{color:var(--soft);font-size:14px;margin:0 0 18px}
  .summary{background:#f9fafb;border:1px solid var(--line);border-left:4px solid #0d9488;border-radius:10px;padding:16px;font-size:15px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);margin:30px 0 10px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px} @media(max-width:620px){.cols{grid-template-columns:1fr}}
  .col{border-radius:10px;padding:14px} .ahead{background:#fffbeb;border:1px solid #fde68a} .we{background:#ecfdf5;border:1px solid #a7f3d0}
  .col h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em} .ahead h3{color:#b45309} .we h3{color:#047857}
  .col ul{margin:0;padding-left:18px} .col li{margin:7px 0;font-size:14px}
  ol.actions{counter-reset:a;list-style:none;margin:0;padding:0}
  ol.actions>li{position:relative;counter-increment:a;border:1px solid var(--line);border-radius:12px;padding:14px 16px 14px 56px;margin:12px 0}
  ol.actions>li::before{content:counter(a);position:absolute;left:14px;top:14px;width:28px;height:28px;border-radius:50%;background:#0d9488;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:14px}
  .t{display:flex;justify-content:space-between;align-items:start;gap:10px} .ti{font-weight:650;font-size:15px}
  .badge{font-size:10px;font-weight:700;text-transform:uppercase;padding:3px 8px;border-radius:999px;white-space:nowrap}
  .d{margin:6px 0 0;font-size:14px} .ev{margin:6px 0 0;font-size:12px;color:var(--soft)}
  .do{margin:8px 0 0;font-size:13px;background:#f3f4f6;border-radius:8px;padding:8px 10px}
  .meta{margin-top:30px;border-top:1px solid var(--line);padding-top:14px;color:#9ca3af;font-size:12px}
  @media print{body{background:#fff} .page{max-width:none}}
</style></head><body><div class="page">
<p class="eyebrow">Size up the competition</p>
<h1>How ${htmlEsc(site)} compares</h1>
<p class="ask">${prompt ? `“${htmlEsc(prompt)}”` : ''}</p>
<div class="summary">${htmlEsc(r.summary)}</div>
<div class="cols">
  <div class="col ahead"><h3>Where they're ahead</h3><ul>${theirEdge}</ul></div>
  <div class="col we"><h3>Where you're ahead</h3><ul>${ourEdge}</ul></div>
</div>
<h2>Action plan — ${(r.findings || []).length} things to do</h2>
<ol class="actions">${actions}</ol>
<div class="meta">Generated by Bosun — “Size up the competition”. Built from your own site plus a look at your competitors.</div>
</div></body></html>`;
}

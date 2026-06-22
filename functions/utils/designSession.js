// "Design a screen" — a clarify-first, mockup-before-build session. Unlike a fix or a feature
// breakdown, the agent here DESIGNS a new screen: it explores the repo to learn the site's real
// look (colours, fonts, components), asks the owner clarifying questions in plain English, and —
// once confident — writes a self-contained HTML mock of just that screen which Bosun renders for
// the owner in a sandboxed <iframe> (the browser is the renderer — no screenshots, no base64: a
// rendered image can't be shipped out of the managed sandbox cheaply, see scripts/probe-render.mjs).
// It NEVER edits the app or opens a PR. The session is async: started here, each turn finalized by
// pollSessions — questions reopen the chat for the owner; a finished mock charges priceForPlanning
// and opens the design for approval.

import { startFixSession, continueFixSession } from './claudeAgent.js';
import { extractJamUrl } from './agentResult.js';

export const MAX_CLARIFY_TURNS = 5; // owner replies that resume the chat before we force a mock

// The render protocol — appended to every design instruction so the agent knows exactly how to
// hand back the agreed screen. The agent emits the mock as PLAIN HTML in a fenced code block (cheap,
// reliable, no base64) — Bosun renders it in the browser. Shared text (no SDK import) so it's
// reproducible.
const RENDER_PROTOCOL =
  `When — and only when — you are confident you understand the screen, produce a VISUAL MOCKUP of it so ` +
  `the owner can see it before anything is really built. Do NOT touch the real app, do NOT open a pull ` +
  `request, and do NOT take screenshots.\n` +
  `Build ONE self-contained mockup: a single block of static HTML for JUST this screen, with ALL CSS ` +
  `inline in a <style> tag, no JavaScript, no external files and no data loading. Make it look like it ` +
  `belongs on THEIR site — reuse the exact colours (hex), fonts, spacing, button and component styles you ` +
  `saw in the repo. Use realistic placeholder text where real content would go. It must render on its own ` +
  `in a browser. Make it responsive so it looks right on phones too.\n` +
  `Reply with ONE friendly, plain-English sentence describing the screen for the owner. Then include the ` +
  `mockup as a SINGLE fenced code block, exactly like:\n` +
  '```html\n<!doctype html>\n... your full self-contained mock ...\n```\n' +
  `Then on the VERY LAST line append ONLY this machine-readable result (the owner never sees it):\n` +
  `RESULT_JSON: {"brief":"<one or two plain sentences: what this screen is and where it goes on the site>","ready":true}\n\n` +
  `Until you are confident, DO NOT output the mock or RESULT_JSON. Instead ask the owner the FEWEST ` +
  `questions needed, in ONE short batch, in plain friendly English a shop owner would use — NEVER ` +
  `technical words (no code, files, components, HTML, CSS, API, etc.). Ask only what genuinely changes ` +
  `the design.`;

// The complete initial instruction (a full prompt like buildPlanPrompt — replaces the fix prompt).
export function buildDesignPrompt(ask, { figmaDesign = null, screenshotCount = 0 } = {}) {
  const jamUrl = extractJamUrl(ask);
  const designNote = figmaDesign?.summary
    ? `The owner attached a design to match (image attached). Exact spec (positions relative to the design's top-left; px sizes; hex colours):\n${figmaDesign.summary}\n\n`
    : (figmaDesign?.image ? `The owner attached a design to match (image attached) — make the mock match it.\n\n` : '');
  const shotNote = screenshotCount > 0
    ? `The owner attached ${screenshotCount} screenshot${screenshotCount > 1 ? 's' : ''} for reference — look at ${screenshotCount > 1 ? 'them' : 'it'}.\n\n`
    : '';
  const jamNote = jamUrl
    ? `The owner shared a screen recording: ${jamUrl} — you may read it with the jam tools (getConsoleLogs / getNetworkRequests / getUserEvents, passing the URL as jamId) if it helps you understand the ask.\n\n`
    : '';

  return (
    `A non-technical website owner wants this NEW screen or page designed for their site:\n"${ask}"\n\n` +
    designNote + shotNote + jamNote +
    `You are DESIGNING this screen, not building it for real. First EXPLORE the repo at /workspace/repo ` +
    `to learn the site's actual look so your mock fits in: read AGENTS.md if present, then look at the real ` +
    `pages/components, colours, fonts and spacing the site already uses. Ignore generated or dependency ` +
    `folders (node_modules, dist, build, .next, vendor) and lock files.\n\n` +
    RENDER_PROTOCOL
  );
}

// The continue text when the owner answers a clarifying question (sent on the SAME session, which
// already holds the full protocol + repo context). Keep it short — just their answer + a nudge.
export function buildDesignReply(answer) {
  return (
    `The owner answered:\n"${answer}"\n\n` +
    `If you now have what you need, build the mockup and output RESULT_JSON exactly as instructed earlier. ` +
    `If something important is still unclear, ask one more short batch of plain-English questions instead.`
  );
}

/**
 * Start the design session (async). Mirrors a fix dispatch but with the design instruction and NO
 * PR intent. Returns { sessionId, firebaseFileIds }; pollSessions finalizes each turn.
 */
export async function startDesignSession({
  ask, repoUrl, githubToken, vaultId, agentId, firebaseSAs = [],
  figmaDesign = null, imageFileIds = [], screenshotCount = 0,
}) {
  const instruction = buildDesignPrompt(ask, { figmaDesign, screenshotCount });
  return startFixSession({
    instruction,
    repoUrl, githubToken, vaultId, agentId, firebaseSAs,
    figmaDesign, imageFileIds,
  });
}

/** Resume the design session with the owner's answer (a clarify reply). */
export async function replyDesignSession({ sessionId, answer }) {
  return continueFixSession({ sessionId, instruction: buildDesignReply(answer) });
}

const RESULT_LINE_RE = /RESULT_JSON:\s*(\{[\s\S]*?\})\s*$/m;
// The mock arrives as a fenced ```html block. Prefer an explicit html fence; fall back to any fenced
// block that looks like an HTML document. Non-greedy, last match wins (a revision re-emits the mock).
const HTML_FENCE_RE = /```html\s*([\s\S]*?)```/gi;
const ANY_DOC_FENCE_RE = /```[a-z]*\s*(<(?:!doctype|html|div|section|main|body)[\s\S]*?)```/gi;

function lastMatch(re, text) {
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

/**
 * Parse a finished design turn. Walks `agent.message` events for this turn's reply. If the agent
 * produced a mock, returns { ready:true, brief, mockHtml }; otherwise the turn is a question round,
 * so `questions` is the agent's plain-text message (shown to the owner) and ready is false.
 * Fail-safe: a turn that parses to neither is treated as questions (never charges, never builds).
 */
export async function extractDesignTurn(client, sessionId) {
  let questions = '';
  let brief = '';
  let ready = false;
  let mockHtml = '';
  try {
    const res = await client.beta.sessions.events.list(sessionId);
    const events = res?.data ?? res?.body?.data ?? (Array.isArray(res) ? res : []);
    // Last agent message is this turn's reply; earlier ones were prior turns.
    let lastText = '';
    for (const ev of events) {
      if (ev?.type === 'agent.message') {
        const parts = (ev.content ?? []).filter((b) => b?.type === 'text' && b.text).map((b) => b.text);
        if (parts.length) lastText = parts.join('\n');
      }
    }
    const html = lastMatch(HTML_FENCE_RE, lastText) || lastMatch(ANY_DOC_FENCE_RE, lastText);
    const m = lastText.match(RESULT_LINE_RE);
    if (m) {
      const json = JSON.parse(m[1]);
      if (json.ready === true && html && html.trim()) {
        ready = true;
        brief = String(json.brief || '').slice(0, 600).trim();
        mockHtml = html.trim();
      }
    }
    // The owner never sees the raw HTML or the RESULT_JSON line — strip both from any shown text.
    questions = lastText.replace(HTML_FENCE_RE, '').replace(ANY_DOC_FENCE_RE, '').replace(RESULT_LINE_RE, '').trim();
  } catch (e) {
    console.warn('extractDesignTurn', sessionId, e?.message || e);
  }
  return { questions, brief, ready, mockHtml };
}

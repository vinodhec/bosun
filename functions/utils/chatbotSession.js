// "Chat & build" — the assistant tab. ONE warm managed-agent session that talks to a non-technical
// owner, clarifies what they want in plain English (proactively asking for a screenshot / page link /
// Jam recording / Figma link so it never explores blind), and — once the owner approves — builds the
// change and opens a PR IN THE SAME SESSION. No re-clone, no re-discovery: the exploration that
// powered the conversation also powers the build.
//
// The session is multi-turn, finalized by pollSessions:
//   - a CLARIFY turn asks the owner questions            → chat pauses (awaitingOwner), replyToChat resumes it
//   - a READY turn says "here's what I'll do" (+ optional visual preview) → chat pauses for the owner to approve
//   - approveChatBuild resumes the SAME session with "build it for real" → status 'building'
//   - the BUILD turn opens a PR → charged ONCE (priceForChat = 3× the whole session's COGS, capped) and complete
//
// Nothing is charged until a build completes: clarify + preview are folded into that single final
// charge (their COGS is part of it), and a chat abandoned before a build is never charged.
//
// chats/{id}.status: clarifying → (ready_to_build | previewing) → building → complete (failed on a bad session).

import { startFixSession, continueFixSession } from './claudeAgent.js';
import { extractJamUrl, BUILD_EFFICIENCY } from './agentResult.js';

export const MAX_CLARIFY_TURNS = 6; // owner replies that resume the chat before we nudge toward a build

// What the owner can ask for that saves the agent expensive blind exploration AND sharpens the build.
// Figma links are fetched server-side and injected as an image. Jam is no longer askable — the Jam
// MCP toolset was removed from the fixer agents (2026-07-16, COGS), so a recording is unreadable.
const ASK_FOR_CONTEXT =
  `Whenever it would help you find the right page or understand the ask, ASK the owner to share the ` +
  `cheapest useful thing FIRST — before exploring blind:\n` +
  `  - a SCREENSHOT of the page or the part that's wrong (fastest way to see what they mean),\n` +
  `  - the PAGE LINK / which page it's on (so you go straight there),\n` +
  `  - a FIGMA link if they have a design to match.\n` +
  `Ask only for what genuinely helps this specific request — never demand all of them.`;

// The protocol appended to the initial instruction. The agent decides each turn between asking, being
// ready-with-a-plan (optionally a visual preview), and — only after approval, on a later turn — building.
const CHAT_PROTOCOL =
  `You are helping this owner in a back-and-forth chat. Your job on THIS turn is to understand what ` +
  `they want well enough to build it — NOT to build it yet.\n\n` +
  `${ASK_FOR_CONTEXT}\n\n` +
  `If the request is VISUAL (a new screen, a layout or look change), also offer a choice in plain words: ` +
  `"Would you like to see a quick preview first, or should I just go ahead and make the change?" — and ` +
  `respect their answer. For a plain bug/behaviour fix, don't offer a preview; just confirm and build.\n\n` +
  `Decide this turn's OUTCOME and put it in the RESULT_JSON on the very last line (the owner never sees it):\n` +
  `  - "ask": you still need something (an answer, a screenshot, the page link, a figma link). ` +
  `Put the questions in your visible reply.\n` +
  `  - "ready": you now understand the request fully and are ready to build once they say go. Your ` +
  `visible reply is ONE short, friendly, plain-English summary of what you'll change — NO technical ` +
  `words (no files, components, code, CSS, API). If they wanted a PREVIEW (or it's clearly visual and ` +
  `they didn't decline one), ALSO include a single self-contained HTML mock of just the changed screen ` +
  `in ONE fenced \`\`\`html block: all CSS inline, no JavaScript, no external files, made to look like ` +
  `THEIR site (reuse the real colours/fonts/spacing you saw in the repo), responsive for phones. Keep ` +
  `the mock MINIMAL — just enough to show the change; don't over-polish it. Do NOT touch the app or ` +
  `open a PR on a "ready" turn — wait for approval.\n\n` +
  `Until you are confident, prefer "ask": pose the FEWEST questions in ONE short batch, plain friendly ` +
  `English a shop owner would use. Never output a PR or start building on your own — building only ` +
  `happens after the owner approves, on a later turn when I explicitly tell you to build.\n\n` +
  `On the VERY LAST line append ONLY this (the owner never sees it):\n` +
  `RESULT_JSON: {"mode":"ask" or "ready","summary":"<one plain sentence: what you'll change; empty if asking>","preview":true or false}`;

// The full initial instruction (like buildDesignPrompt — replaces the fix prompt for turn 1).
export function buildChatPrompt(ask, { figmaDesign = null, screenshotCount = 0 } = {}) {
  const jamUrl = extractJamUrl(ask);
  const designNote = figmaDesign?.summary
    ? `The owner attached a design to match (image attached). Exact spec:\n${figmaDesign.summary}\n\n`
    : (figmaDesign?.image ? `The owner attached a design to match (image attached).\n\n` : '');
  const shotNote = screenshotCount > 0
    ? `The owner attached ${screenshotCount} screenshot${screenshotCount > 1 ? 's' : ''} — look at ${screenshotCount > 1 ? 'them' : 'it'}.\n\n`
    : '';
  const jamNote = jamUrl
    ? `The owner shared a screen recording link: ${jamUrl} — you cannot open recordings; it is NOT a page of their site, so ignore the link and work from their words and screenshots.\n\n`
    : '';
  return (
    `A non-technical website owner wrote to you about their site:\n"${ask}"\n\n` +
    designNote + shotNote + jamNote +
    `First EXPLORE the repo at /workspace/repo to locate what they mean and learn the site's real look: ` +
    `read AGENTS.md if present, then the relevant pages/components, colours, fonts and spacing. Ignore ` +
    `generated/dependency folders (node_modules, dist, build, .next, vendor) and lock files.\n\n` +
    CHAT_PROTOCOL
  );
}

// The continue text when the owner replies during clarifying (same session; holds the full protocol).
export function buildChatReply(answer, imageCount = 0) {
  const shotNote = imageCount > 0
    ? `The owner attached ${imageCount} screenshot${imageCount > 1 ? 's' : ''} — look at ${imageCount > 1 ? 'them' : 'it'} carefully.\n\n`
    : '';
  return (
    `The owner replied:\n"${answer}"\n\n` +
    shotNote +
    `If you now understand the request fully, reply "ready" with your plain-English summary (and a ` +
    `preview mock if they wanted one). If something important is still unclear, ask one more short ` +
    `batch of plain-English questions instead. Do NOT build yet — wait for their go-ahead.`
  );
}

// The continue text when the owner APPROVES the build (same session, which already holds the whole
// conversation + the agreed plan). NOW the agent actually implements it and opens a PR — a normal fix.
// Shares BUILD_EFFICIENCY (git CLI, fewest edits, git-diff verify, no npm/lint, no env probe) with the
// fix/feature pipeline. The RESULT_JSON line is REQUIRED — the poller reads prUrl from it (a missing
// line makes a real PR look like a failed run).
export function buildChatBuildInstruction(notes = '') {
  const extra = notes ? `\nThe owner added: "${notes}" — fold this in.\n` : '';
  return (
    `The owner approved. Build it for real now: make the change we agreed in the repo, keep everything ` +
    `else exactly as it is. Match the site's existing style and conventions.\n` +
    extra +
    `${BUILD_EFFICIENCY} Commit to a NEW branch and open the pull request.\n` +
    `When done, open the pull request, then on the VERY LAST line append ONLY this machine-readable ` +
    `result (the owner never sees it):\n` +
    `RESULT_JSON: {"summary":"<one friendly plain sentence>","filesChanged":[{"fileName":"<file>","description":"<plain English>"}],"prUrl":"<the pull request url>"}`
  );
}

// ── Session lifecycle ──
export async function startChatSession({
  ask, repoUrl, githubToken, vaultId, agentId, firebaseSAs = [],
  figmaDesign = null, imageFileIds = [], screenshotCount = 0, images = [], documents = [],
}) {
  const instruction = buildChatPrompt(ask, { figmaDesign, screenshotCount });
  return startFixSession({
    instruction, repoUrl, githubToken, vaultId, agentId, firebaseSAs,
    figmaDesign, imageFileIds, images, documents,
  });
}

export async function replyChatSession({ sessionId, answer, images = [] }) {
  return continueFixSession({ sessionId, instruction: buildChatReply(answer, images.length), images });
}

export async function buildChatSession({ sessionId, notes = '', images = [] }) {
  return continueFixSession({ sessionId, instruction: buildChatBuildInstruction(notes), images });
}

// ── Parsing a finished CLARIFY turn (not the build turn — that's parsed with agentResult.extractResult) ──
const RESULT_LINE_RE = /RESULT_JSON:\s*(\{[\s\S]*?\})\s*$/m;
const HTML_FENCE_RE = /```html\s*([\s\S]*?)```/gi;
const ANY_DOC_FENCE_RE = /```[a-z]*\s*(<(?:!doctype|html|div|section|main|body)[\s\S]*?)```/gi;

function lastMatch(re, text) {
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

// Strip anything technical that leaks into owner-facing text (fenced/inline code, the result line).
function sanitizeOwnerText(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(RESULT_LINE_RE, '')
    .replace(/`[^`]*`/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse a finished CLARIFY turn. Returns:
 *   { mode:'ask',   questions }                              → pause for the owner
 *   { mode:'ready', summary, mockHtml, preview }             → pause for the owner to approve the build
 * Fail-safe: anything that doesn't cleanly parse to "ready" is treated as "ask" (never builds, never charges).
 */
export async function extractChatTurn(client, sessionId) {
  let mode = 'ask';
  let summary = '';
  let mockHtml = '';
  let preview = false;
  let questions = '';
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
      if (json.mode === 'ready') {
        mode = 'ready';
        summary = String(json.summary || '').slice(0, 600).trim();
        preview = json.preview === true;
        const html = lastMatch(HTML_FENCE_RE, lastText) || lastMatch(ANY_DOC_FENCE_RE, lastText);
        if (preview && html && html.trim()) mockHtml = html.trim();
      }
    }
    questions = sanitizeOwnerText(lastText);
  } catch (e) {
    console.warn('extractChatTurn', sessionId, e?.message || e);
  }
  return { mode, summary, mockHtml, preview, questions };
}

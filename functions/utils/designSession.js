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
import { MAX_STEPS, STEP_KIND_RULES, STEP_JSON_SHAPE, normalizeSteps } from './featurePlan.js';

export const MAX_CLARIFY_TURNS = 5; // owner replies that resume the chat before we force a mock

// The render protocol — appended to every design instruction so the agent knows exactly how to
// hand back the agreed screen. The agent emits the mock as PLAIN HTML in a fenced code block (cheap,
// reliable, no base64) — Bosun renders it in the browser. Shared text (no SDK import) so it's
// reproducible.
const RENDER_PROTOCOL =
  `First work out the SCOPE of what the owner wants:\n` +
  `  - Is this a brand-NEW page/screen that doesn't exist yet, OR\n` +
  `  - a CHANGE to something that ALREADY exists (e.g. restyling one section, or just the cards in a list)?\n` +
  `If it's a change, find the EXACT part(s) they mean and note what must stay exactly as it is. If it isn't ` +
  `obvious HOW MUCH they want changed — just one part, or the whole page — ASK a short question first ` +
  `(e.g. "Just the property cards, or the whole listings page?"). Don't assume the bigger scope.\n\n` +
  `When — and only when — you are confident, produce a VISUAL MOCKUP so the owner can see it before ` +
  `anything is built. Do NOT touch the real app, do NOT open a pull request, do NOT take screenshots.\n` +
  `Build ONE self-contained mockup: a single block of static HTML, ALL CSS inline in a <style> tag, no ` +
  `JavaScript, no external files, no data loading. Make it look like it belongs on THEIR site — reuse the ` +
  `exact colours (hex), fonts, spacing, button and component styles you saw in the repo. Realistic ` +
  `placeholder text. It must render on its own in a browser, and be responsive for phones.\n` +
  `If the request is a CHANGE to part of an existing page, you MAY show the surrounding page for context, ` +
  `but the mock must make the CHANGED part obvious, and your brief must state plainly what changes and what ` +
  `stays the same.\n` +
  `Reply with ONE friendly, plain-English sentence for the owner — just what their screen will look like ` +
  `or what's changing. This visible reply MUST contain NO build steps, NO file or component names, NO code, ` +
  `NO CSS, NO "kind" labels and NO technical words at all — only words a shop owner would use. Then the ` +
  `mockup as a SINGLE fenced block:\n` +
  '```html\n<!doctype html>\n... your full self-contained mock ...\n```\n' +
  `The fenced block in your reply IS the deliverable — do NOT also write the mock to a file or to ` +
  `/mnt/session/outputs/. Emit it exactly once, here in the reply.\n` +
  `SEPARATELY, for our records only (the owner NEVER sees this), plan the BUILD: you already explored the ` +
  `repo and settled the scope, so break it into the FEWEST ordered, independently-shippable steps ` +
  `(1–${MAX_STEPS}; a small screen can be a single step). Each step is one self-contained change that can be ` +
  `built, previewed and shipped on its own before the next; later steps may build on earlier ones.\n` +
  `These steps + their descriptions are the ONLY build brief the builder gets — they must contain EVERY ` +
  `requirement needed to reproduce the FINAL mock in full (all changes agreed across this whole ` +
  `conversation, not just the latest refinement). If the owner refined the design, fold those refinements ` +
  `into the step descriptions so nothing earlier is lost.\n` +
  STEP_KIND_RULES + `\n` +
  `Put this breakdown ONLY inside the RESULT_JSON below — NEVER in your visible reply.\n` +
  `SEPARATELY, think like a friendly expert helping THIS business: list up to 3 small, high-impact ` +
  `improvements the owner probably hasn't thought of that would make this screen work harder for them ` +
  `(more enquiries, calls, sales, trust or clarity). Each one MUST have all three parts: a short plain ` +
  `"title" (the button label); a "why" that is REQUIRED — ONE full plain sentence, never blank and ` +
  `never just repeating the title, saying in the owner's own words how it helps their customers or ` +
  `business (NEVER technical or design reasons — no code, CSS, UX or design jargon); and a "change" ` +
  `telling us plainly what to add or change. For example: {"title":"Add a WhatsApp button","why":"Many ` +
  `of your customers prefer WhatsApp over calling, so more of them will actually message you.",` +
  `"change":"Add a WhatsApp chat button next to the phone number."} Suggest ONLY genuinely useful ones, ` +
  `each with a real "why" — if the screen is already strong, return an empty list. These are OPTIONAL ` +
  `extras the owner may pick, NOT part of the required build above. Put them ONLY in the suggestions ` +
  `field below — NEVER in your visible reply.\n` +
  `Then on the VERY LAST line append ONLY this machine-readable result (the owner never sees it):\n` +
  `RESULT_JSON: {"brief":"<1-2 plain sentences: what the screen/change is and where on the site>",` +
  `"scope":"new_page" or "modify",` +
  `"changeSummary":"<plain: EXACTLY what the FINAL mock changes vs the live site as it is RIGHT NOW. ` +
  `List EVERY change the mock represents across this WHOLE conversation — not just the latest tweak. ` +
  `If the owner refined the design several times, this must still describe ALL of those changes together>",` +
  `"keepUnchanged":"<plain: what on the page must stay exactly as-is; empty for a brand-new page>",` +
  `"steps":[${STEP_JSON_SHAPE}],` +
  `"suggestions":[{"title":"<short plain title>","why":"<one plain sentence: how it helps the owner's business>","change":"<plain: what to add or change>"}],` +
  `"ready":true}\n\n` +
  `Until you are confident, DO NOT output the mock or RESULT_JSON. Instead ask the FEWEST questions needed, ` +
  `in ONE short batch, in plain friendly English a shop owner would use — NEVER technical words (no code, ` +
  `files, components, HTML, CSS, API, etc.). Ask only what genuinely affects the design or its scope.`;

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
    `A non-technical website owner wants this designed or changed on their site:\n"${ask}"\n\n` +
    designNote + shotNote + jamNote +
    `You are DESIGNING this (a mockup for the owner to approve), not building it for real. First EXPLORE the ` +
    `repo at /workspace/repo — both to learn the site's actual look so your mock fits in, AND to LOCATE what ` +
    `the owner is referring to (the page or component they mean): read AGENTS.md if present, then look at the ` +
    `real pages/components, colours, fonts and spacing the site already uses. Ignore generated or dependency ` +
    `folders (node_modules, dist, build, .next, vendor) and lock files.\n\n` +
    RENDER_PROTOCOL
  );
}

// The `ask` for a FORKED design's first "request changes". A fork is a teammate's working copy of a
// shared design: it carries the approved mock + the prior chat but has NO live session (resuming the
// original's session would entangle two owners on one thread). So the first change starts a FRESH
// design session, seeded here with the approved mock as the starting point + the prior conversation +
// the change the owner now wants. The result flows through buildDesignPrompt's normal explore +
// RENDER_PROTOCOL, so the agent re-grounds in the repo and emits an updated mock + RESULT_JSON.
export function buildForkSeedAsk(design = {}, changes = '') {
  const turns = Array.isArray(design.turns) ? design.turns : [];
  const convo = turns.length
    ? `The earlier conversation that shaped this design:\n` +
      turns.map((t) => `${t.role === 'owner' ? 'Owner' : 'Designer'}: ${t.text}`).join('\n') + '\n\n'
    : '';
  const mock = String(design.mockHtml || '').trim();
  const mockNote = mock
    ? `Here is the mockup that was already agreed — start from this exact look and only apply the ` +
      `change below:\n\`\`\`html\n${mock.slice(0, 20000)}\n\`\`\`\n\n`
    : '';
  return (
    `${design.brief || design.prompt || 'A screen we designed earlier.'}\n\n` +
    convo + mockNote +
    `Now the owner wants this change to that mockup:\n"${changes}"\n\n` +
    `Produce the updated mockup (and the RESULT_JSON) exactly as instructed below.`
  );
}

// The continue text when the owner answers a clarifying question (sent on the SAME session, which
// already holds the full protocol + repo context). Keep it short — just their answer + a nudge.
export function buildDesignReply(answer, imageCount = 0) {
  const shotNote = imageCount > 0
    ? `The owner attached ${imageCount} marked-up screenshot${imageCount > 1 ? 's' : ''} showing exactly what they mean — look at ${imageCount > 1 ? 'them' : 'it'} carefully.\n\n`
    : '';
  return (
    `The owner answered:\n"${answer}"\n\n` +
    shotNote +
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
  figmaDesign = null, imageFileIds = [], screenshotCount = 0, images = [],
}) {
  const instruction = buildDesignPrompt(ask, { figmaDesign, screenshotCount });
  return startFixSession({
    instruction,
    repoUrl, githubToken, vaultId, agentId, firebaseSAs,
    figmaDesign, imageFileIds, images,
  });
}

/**
 * Resume the design session with the owner's answer (a clarify reply OR a change request). The owner
 * may attach marked-up screenshots (`images`, base64) to show what they mean — they ride along as
 * image blocks and the reply text tells the agent to look at them.
 */
export async function replyDesignSession({ sessionId, answer, images = [] }) {
  return continueFixSession({ sessionId, instruction: buildDesignReply(answer, images.length), images });
}

const RESULT_LINE_RE = /RESULT_JSON:\s*(\{[\s\S]*?\})\s*$/m;
// The mock arrives as a fenced ```html block. Prefer an explicit html fence; fall back to any fenced
// block that looks like an HTML document. Non-greedy, last match wins (a revision re-emits the mock).
const HTML_FENCE_RE = /```html\s*([\s\S]*?)```/gi;
const ANY_DOC_FENCE_RE = /```[a-z]*\s*(<(?:!doctype|html|div|section|main|body)[\s\S]*?)```/gi;

// Defence-in-depth for the strict UI-language rule: even with the prompt telling the agent to keep its
// visible reply plain, strip anything technical that leaks into owner-facing text — fenced/inline code
// (file names, CSS classes), a "build steps" narrative, and stray "kind" labels. The build breakdown
// lives only in RESULT_JSON; the owner never sees it.
function sanitizeOwnerText(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, '')                 // any fenced block
    .replace(RESULT_LINE_RE, '')                    // the machine-readable result line
    .replace(/`[^`]*`/g, '')                        // inline code spans (e.g. `EnhancedPropertyCard.tsx`, `min-h-[3rem]`)
    .replace(/\*{0,2}\s*build steps?\b[\s\S]*/i, '') // drop the build-steps narrative from its heading onward
    .replace(/\*+\s*kind:[^*\n]*\*+/gi, '')          // stray "*Kind: static*" labels
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function lastMatch(re, text) {
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

// Normalise the agent's optional "make it even better" enhancements: keep at most 4 with a real
// title + change, trim/cap each field. These are shown to the owner as explained, opt-in extras (the
// owner picks which to include; chosen ones ride into the build as notes — no separate charge).
export function normalizeSuggestions(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    const title = String(s?.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const why = String(s?.why || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const change = String(s?.change || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // The "why" is the whole value of a suggestion — drop any without one rather than show a bare title.
    if (title && why && change) out.push({ title, why, change });
    if (out.length >= 4) break;
  }
  return out;
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
  let scope = 'new_page';
  let changeSummary = '';
  let keepUnchanged = '';
  let steps = []; // proposed build breakdown — prepopulated into the feature on approval (no re-plan)
  let suggestions = []; // optional "make it even better" extras the owner can opt into
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
        scope = json.scope === 'modify' ? 'modify' : 'new_page';
        changeSummary = String(json.changeSummary || '').slice(0, 500).trim();
        keepUnchanged = String(json.keepUnchanged || '').slice(0, 500).trim();
        // Normalise the proposed steps with the SHARED normalizer (same as featurePlan.extractPlan)
        // so the feature can prepopulate from them without a re-plan. A miss here is fine —
        // approveDesign falls back to a single whole-screen step, so the screen always builds.
        steps = normalizeSteps(json.steps);
        suggestions = normalizeSuggestions(json.suggestions);
      }
    }
    // The owner never sees the raw HTML, the RESULT_JSON, or any leaked technical narrative.
    questions = sanitizeOwnerText(lastText);
  } catch (e) {
    console.warn('extractDesignTurn', sessionId, e?.message || e);
  }
  return { questions, brief, ready, mockHtml, scope, changeSummary, keepUnchanged, steps, suggestions };
}

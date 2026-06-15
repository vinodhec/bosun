// AI "website check-up". Like feature planning, this runs as a code-aware managed-agent SESSION
// that clones the repo and reads it (AGENTS.md + the real files) — but instead of breaking ONE ask
// into build steps, it reviews the WHOLE site and proposes a prioritised list of improvements, each
// tagged with how much it helps the business (value) and how big a change it is (effort). The owner
// picks any idea to pre-fill "Plan a feature", edits it, and plans it as normal. The session is
// async: started by requestCheckup, finalized by pollSessions (parse the items). It is FREE — we
// absorb the cost (like classify) because the check-up exists to feed the paid plan/fix flow.

import { startFixSession } from './claudeAgent.js';

export const MAX_CHECKUP_ITEMS = 8;

const LEVELS = new Set(['low', 'medium', 'high']);
// Normalise a value/effort label to one of low|medium|high, defaulting to medium.
const level = (v) => {
  const s = String(v || '').toLowerCase().trim();
  return LEVELS.has(s) ? s : 'medium';
};

// The complete check-up instruction (no SDK import, like buildPlanPrompt — so the same text is
// reproducible). The agent must NOT edit code or open a PR; it only explores and reports.
export function buildCheckupPrompt() {
  return (
    `A non-technical small-business owner wants to know how to improve their website. You are doing ` +
    `a CHECK-UP — a review, NOT a fix.\n\n` +
    `You are REVIEWING ONLY — do NOT edit any files, do NOT commit, do NOT open a pull request.\n` +
    `First EXPLORE the repo at /workspace/repo to ground your review in the REAL site: read AGENTS.md ` +
    `if present, then look at the actual pages/components/content. Ignore generated or dependency ` +
    `folders (node_modules, dist, build, .next, vendor) and lock files.\n\n` +
    `Then propose up to ${MAX_CHECKUP_ITEMS} of the MOST worthwhile improvements — a mix of things ` +
    `that look broken or rough and genuine opportunities a visitor or the owner would value. Think ` +
    `about: things that don't work, the phone/mobile layout, slow or heavy pages, unclear or missing ` +
    `wording, things a small business needs (clear contact, a WhatsApp/call button, location, ` +
    `opening hours, testimonials), being found on Google, and visual polish. Use the real code you ` +
    `explored — only suggest things that actually apply to THIS site, and don't invent problems.\n\n` +
    `For EACH idea decide:\n` +
    `  - "value":  how much it helps the business — "high" | "medium" | "low".\n` +
    `  - "effort": how big a change it is to make — "low" | "medium" | "high".\n` +
    `  - "category": one or two plain words for the area (e.g. "Mobile", "Speed", "Contact", ` +
    `"Wording", "Google", "Design").\n` +
    `Order the list with the most worthwhile first (high value, low effort at the top).\n\n` +
    `Write every title and description in plain, friendly English a shop owner would use — NEVER ` +
    `technical words (no code, files, components, API, database, deploy, etc.). The description must ` +
    `say what to improve, where on the site, and why it helps — clear enough to hand straight to the ` +
    `team to build.\n\n` +
    `Reply with a short friendly sentence, then on the VERY LAST line append ONLY this machine-` +
    `readable result (the owner won't see it):\n` +
    `RESULT_JSON: {"items":[{"title":"<3–6 word plain title>","description":"<one or two plain ` +
    `sentences: what to improve, where, and why it helps>","value":"high|medium|low","effort":` +
    `"low|medium|high","category":"<1–2 words>"}]}`
  );
}

/**
 * Start the check-up session (async). Mirrors a planning dispatch but with the check-up instruction
 * and NO design/screenshots (it reviews the whole site, the owner points at nothing). Returns
 * { sessionId, firebaseFileIds }; pollSessions finalizes it via extractCheckup.
 */
export async function startCheckupSession({ repoUrl, githubToken, vaultId, agentId, firebaseSAs = [] }) {
  const instruction = buildCheckupPrompt();
  return startFixSession({ instruction, repoUrl, githubToken, vaultId, agentId, firebaseSAs });
}

const RESULT_LINE_RE = /RESULT_JSON:\s*(\{.*\})\s*$/;

/**
 * Parse a finished check-up session's events for the last RESULT_JSON line and return its items,
 * each normalised to { title, description, value, effort, category }. Fail-safe: returns [] when
 * nothing parses, so the caller can mark the check-up failed (it was a real session, so an empty
 * fallback would hide a genuine failure).
 */
export async function extractCheckup(client, sessionId) {
  let items = [];
  try {
    const res = await client.beta.sessions.events.list(sessionId);
    const events = res?.data ?? res?.body?.data ?? (Array.isArray(res) ? res : []);
    const lines = [];
    for (const ev of events) {
      if (ev?.type === 'agent.message') {
        for (const b of ev.content ?? []) if (b?.type === 'text' && b.text) lines.push(...b.text.split('\n'));
      }
    }
    let jsonStr = null;
    for (const line of lines) {
      const m = line.match(RESULT_LINE_RE);
      if (m) jsonStr = m[1]; // keep the last
    }
    if (jsonStr) {
      const json = JSON.parse(jsonStr);
      items = Array.isArray(json.items) ? json.items : [];
    }
  } catch (e) {
    console.warn('extractCheckup', sessionId, e?.message || e);
  }
  return items
    .map((s) => ({
      title: String(s?.title || '').slice(0, 80).trim(),
      description: String(s?.description || '').slice(0, 400).trim(),
      value: level(s?.value),
      effort: level(s?.effort),
      category: String(s?.category || '').slice(0, 24).trim(),
    }))
    .filter((s) => s.title || s.description)
    .slice(0, MAX_CHECKUP_ITEMS);
}

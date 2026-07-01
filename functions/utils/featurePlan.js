// Code-aware feature planning. Unlike a stateless text split, the breakdown runs as a managed-
// agent SESSION that clones the repo, reads it (AGENTS.md + the relevant files), and looks at the
// owner's design + screenshots — so the steps are grounded in the ACTUAL code, and each is tagged
// static (fixed UI) or dynamic (needs live data / back-end wiring). The session is async: started
// here, finalized by pollSessions (parse the plan, charge 2× its real cost, open it for review).

import { startFixSession } from './claudeAgent.js';
import { extractJamUrl } from './agentResult.js';

export const MAX_STEPS = 8;

// The rules for breaking work into build steps — SHARED by the feature planner (buildPlanPrompt) and
// the design session (which emits steps alongside the mock, see designSession.js), so the two never
// drift. The caller supplies the lead-in sentence (what's being broken down); this is the shared tail.
export const STEP_KIND_RULES =
  `For EACH step decide "kind":\n` +
  `  - "static"  = fixed presentation/UI only (layout, text, colours, links) — no live data.\n` +
  `  - "dynamic" = needs live/changing data or back-end wiring (e.g. a list driven by real ` +
  `activity, a form that saves, anything computed at runtime). Use the code you explored to ` +
  `decide whether the data/source already exists or must be built, and scope the step accordingly.\n\n` +
  `Write every title and description in plain, friendly English a shop owner would use — NEVER ` +
  `technical words (no code, files, components, API, database, deploy, etc.). Describe what a ` +
  `visitor or the owner will SEE or be able to DO.`;

// The shape of each step in the agent's machine-readable RESULT_JSON. Both prompts embed it identically.
export const STEP_JSON_SHAPE =
  `{"title":"<3–6 word plain title>","description":"<one or two plain sentences: what this step ` +
  `adds and where on the site>","kind":"static|dynamic"}`;

// Normalise a raw steps array (from a RESULT_JSON) into clean {title, description, kind} entries,
// capped at MAX_STEPS. Shared by extractPlan, the design turn parser, and editFeaturePlan.
export function normalizeSteps(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((s) => ({
      title: String(s?.title || '').slice(0, 80).trim(),
      description: String(s?.description || '').slice(0, 400).trim(),
      kind: s?.kind === 'dynamic' ? 'dynamic' : 'static',
    }))
    .filter((s) => s.title || s.description)
    .slice(0, MAX_STEPS);
}

// The complete planning instruction (no SDK import, like buildFixPrompt — so the same text is
// reproducible). `priorSteps` + `changeNote` drive a re-plan: refine (keep the ask, adjust the
// existing steps) or replace (a brand-new ask). The agent must NOT edit code or open a PR.
export function buildPlanPrompt(ask, { figmaDesign = null, screenshotCount = 0, priorSteps = null, changeNote = '' } = {}) {
  const jamUrl = extractJamUrl(ask);
  const designNote = figmaDesign?.summary
    ? `The owner attached a design to match (image attached). Exact spec (positions relative to the design's top-left; px sizes; hex colours):\n${figmaDesign.summary}\n\n`
    : (figmaDesign?.image ? `The owner attached a design to match (image attached).\n\n` : '');
  const shotNote = screenshotCount > 0
    ? `The owner attached ${screenshotCount} screenshot${screenshotCount > 1 ? 's' : ''} of their site — look at ${screenshotCount > 1 ? 'them' : 'it'}.\n\n`
    : '';
  const jamNote = jamUrl
    ? `The owner shared a screen recording: ${jamUrl} — you may read it with the jam tools (getConsoleLogs / getNetworkRequests / getUserEvents, passing the URL as jamId) if it helps you understand the ask.\n\n`
    : '';
  const replanNote = priorSteps?.length
    ? `You previously proposed this plan:\n${priorSteps.map((s, i) => `${i + 1}. ${s.title} — ${s.description}`).join('\n')}\n\n` +
      `The owner wants it changed: "${changeNote}"\nProduce a REVISED plan that honours their change.\n\n`
    : '';

  return (
    `A non-technical website owner wants this added to their site:\n"${ask}"\n\n` +
    designNote + shotNote + jamNote + replanNote +
    `You are PLANNING ONLY — do NOT edit any files, do NOT commit, do NOT open a pull request.\n` +
    `First EXPLORE the repo at /workspace/repo to ground the plan in the real code: read AGENTS.md ` +
    `if present, then look at the actual files/components/data involved. Ignore generated or ` +
    `dependency folders (node_modules, dist, build, .next, vendor) and lock files.\n\n` +
    `Then break the request into the FEWEST ordered, independently-shippable steps (1–${MAX_STEPS}; ` +
    `a small ask can be a single step). Each step must be one self-contained change that can be ` +
    `built, previewed and shipped on its own before the next; later steps may build on earlier ones.\n` +
    STEP_KIND_RULES + `\n\n` +
    `Reply with a short friendly sentence, then on the VERY LAST line append ONLY this machine-` +
    `readable result (the owner won't see it):\n` +
    `RESULT_JSON: {"steps":[${STEP_JSON_SHAPE}]}`
  );
}

/**
 * Start the planning session (async). Mirrors a fix dispatch but with the planning instruction and
 * NO PR intent. Returns { sessionId, firebaseFileIds }; pollSessions finalizes it via extractPlan.
 */
export async function startPlanningSession({
  ask, repoUrl, githubToken, vaultId, agentId, firebaseSAs = [],
  figmaDesign = null, imageFileIds = [], screenshotCount = 0, priorSteps = null, changeNote = '',
  documents = [],
}) {
  const instruction = buildPlanPrompt(ask, { figmaDesign, screenshotCount, priorSteps, changeNote });
  return startFixSession({
    instruction,
    repoUrl, githubToken, vaultId, agentId, firebaseSAs,
    figmaDesign, imageFileIds, documents,
  });
}

const RESULT_LINE_RE = /RESULT_JSON:\s*(\{.*\})\s*$/;

/**
 * Parse a finished planning session's events for the last RESULT_JSON line and return its steps,
 * each normalised to { title, description, kind:'static'|'dynamic' }. Fail-safe: returns [] when
 * nothing parses, so the caller can mark the plan failed (planning was a real session, so a
 * single-step fallback would hide a genuine failure).
 */
export async function extractPlan(client, sessionId) {
  let steps = [];
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
      steps = Array.isArray(json.steps) ? json.steps : [];
    }
  } catch (e) {
    console.warn('extractPlan', sessionId, e?.message || e);
  }
  return normalizeSteps(steps);
}

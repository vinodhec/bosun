// Compute a managed-agent session's actual USD cost and extract its result.
//
// Field shapes CONFIRMED via a live session probe (2026-05): token counts live on
// `session.usage`, runtime on `session.stats.active_seconds`, there is NO reported
// cost field (we compute it), and the agent's reply is in `agent.message` events.
// The billing MATH (×2, floors) is unit-verified separately; this file only sources
// the `actualCostUsd` input.

// Token prices (USD per 1M tokens), PER MODEL FAMILY. A managed-agent session is single-model
// (the model is fixed at creation and reported on the session as `session.agent.model.id`), so
// we price every session by the model that ACTUALLY ran — never one blended rate. A flat table
// over-bills Sonnet (~1.7×) and, worse, UNDER-bills Opus (~3×), silently eroding margin on
// `complex` fixes. Source: Anthropic public pricing (2026-05). Within a family the ratios are
// uniform: cache-read = 0.1× input, 5m cache-write = 1.25× input, 1h cache-write = 2× input.
// Keyed by family so dated snapshots (claude-sonnet-5, claude-opus-4-8, …) all resolve here.
// Source: Anthropic public pricing (2026-07). Sonnet row is Sonnet 5 INTRO pricing.
export const MODEL_PRICES = {
  opus:   { input: 5,  output: 25, cacheRead: 0.5, cacheWrite5m: 6.25,  cacheWrite1h: 10 },
  // Sonnet 5 intro pricing, in effect through 2026-08-31. REVERT to standard rates on
  // 2026-09-01 → input:3, output:15, cacheRead:0.3, cacheWrite5m:3.75, cacheWrite1h:6.
  sonnet: { input: 2,  output: 10, cacheRead: 0.2, cacheWrite5m: 2.5,   cacheWrite1h: 4  },
  haiku:  { input: 1,  output: 5,  cacheRead: 0.1, cacheWrite5m: 1.25,  cacheWrite1h: 2  },
};

/** Map a managed-agent model id to a price family ('opus'|'sonnet'|'haiku'), or null if unknown. */
export function modelFamily(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  return null;
}

const sessionHourUsd = () => Number(process.env.SESSION_HOUR_USD) || 0.08;

/**
 * Decompose a session's usage into token counts, per-component USD, and cost — the single
 * source of truth for "what did this session burn". `sessionCostUsd` and the per-round
 * AGENT_USAGE log both read from here so the cost and the observability can never drift.
 *
 * `cacheHitRatio` is the optimisation signal: of the input context the agent processed this
 * session, what fraction was served from cache (billed at ~10%) rather than fresh input. Low
 * ratio on revisions = the runtime isn't reusing the conversation, which is where money leaks.
 */
export function usageBreakdown(session) {
  // Price by the model the session ACTUALLY ran (reported on the session itself). Unknown/
  // unrecognised ids fall back to OPUS (the most expensive) with a loud warning, so a mispriced
  // model can never silently UNDER-count COGS. 'fast' speed is premium-priced upstream but we
  // bill at standard rates — warn so any under-count is visible rather than hidden.
  const modelId = session?.agent?.model?.id || null;
  const speed = session?.agent?.model?.speed || 'standard';
  const family = modelFamily(modelId);
  if (!family) {
    console.error(`billing:model_unknown — session model "${modelId}" unrecognised; pricing at OPUS rates to avoid under-billing.`);
  }
  if (speed === 'fast') {
    console.warn(`billing:fast_speed — session ${session?.id} ran at 'fast' (premium) speed; standard rates applied, COGS may be under-counted.`);
  }
  const price = MODEL_PRICES[family || 'opus'];

  const u = session?.usage || {};
  const cc = u.cache_creation || {};
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheWrite5m = Number(cc.ephemeral_5m_input_tokens) || 0;
  const cacheWrite1h = Number(cc.ephemeral_1h_input_tokens) || 0;

  const tokenUsd =
    (input * price.input +
      output * price.output +
      cacheRead * price.cacheRead +
      cacheWrite5m * price.cacheWrite5m +
      cacheWrite1h * price.cacheWrite1h) /
    1e6;

  // $0.08/session-hour accrues only while running; `active_seconds` is that running time.
  const runtimeSec = Number(session?.stats?.active_seconds) || 0;
  const runtimeUsd = (runtimeSec / 3600) * sessionHourUsd();

  // Fraction of processed input context that came from cache (fresh input + cache reads is
  // the denominator; cache writes are the one-time cost of seeding it, output is separate).
  const inputBase = input + cacheRead;
  const cacheHitRatio = inputBase > 0 ? cacheRead / inputBase : 0;

  return {
    model: modelId, family: family || 'opus', speed,
    input, output, cacheRead, cacheWrite5m, cacheWrite1h,
    cacheHitRatio: Math.round(cacheHitRatio * 1000) / 1000,
    runtimeSec,
    tokenUsd, runtimeUsd,
    totalUsd: tokenUsd + runtimeUsd,
  };
}

/** Actual USD cost of a session = token cost + runtime cost. */
export function sessionCostUsd(session) {
  return usageBreakdown(session).totalUsd;
}

// A jam.dev share link the owner pasted into their problem text. Jam captures the bug with the
// console errors, failed network requests, and exact repro steps already attached — far richer
// than prose — so when one is present we point the agent at it via the jam MCP tools.
const JAM_URL_RE = /https?:\/\/(?:www\.)?jam\.dev\/[^\s)>\]"']+/i;

/** Return the first jam.dev recording URL found in free text, or null. */
export function extractJamUrl(text) {
  const m = String(text || '').match(JAM_URL_RE);
  return m ? m[0] : null;
}

// Tells the agent to mine a jam.dev recording before touching code — the console/network/repro
// data usually pinpoints the cause faster than the owner's words can. The recording URL is the
// `jamId` argument every jam tool takes.
function jamNote(text) {
  const url = extractJamUrl(text);
  if (!url) return '';
  return (
    `The owner shared a screen recording of the problem: ${url}\n` +
    `Use the jam tools FIRST to inspect it before editing — read its console errors ` +
    `(getConsoleLogs), failed network requests (getNetworkRequests), and the exact steps the ` +
    `owner took (getUserEvents) to pinpoint the cause. Pass the recording URL as the jamId ` +
    `argument. This is a recording, NOT a page of the site — do not treat it as a route to fix.\n\n`
  );
}

// Describes the read-only Firebase service-account keys we mount into the session (see
// startFixSession). Lets the agent inspect the LIVE database to diagnose a bug — but it is
// hard-bounded to reads: never write/update/delete, default to testing, prod only if the
// problem is explicitly about production data. `mounts` is [{ env, projectId, mountPath }].
function firebaseNote(mounts) {
  if (!mounts?.length) return '';
  const lines = mounts
    .map((m) => `  - ${m.env}: project "${m.projectId}", key file at ${m.mountPath}`)
    .join('\n');
  return (
    `This site is backed by Firebase. Read-only service-account keys are mounted for you:\n${lines}\n` +
    `When it helps you diagnose the problem, set GOOGLE_APPLICATION_CREDENTIALS to the key for the ` +
    `relevant environment and use the firebase CLI or the "firebase-admin" package to READ data ` +
    `(list collections, read documents, check Auth). Default to the TESTING environment; only read ` +
    `PRODUCTION if the problem is explicitly about production data.\n` +
    `STRICTLY READ-ONLY: you must NEVER write, update, delete, run, deploy, or perform ANY mutating ` +
    `Firebase/Firestore/Auth operation in ANY environment. Use this access only to understand the ` +
    `data behind the bug; fix the problem by changing the repo's code and opening a PR as usual.\n\n`
  );
}

// Describes a design the owner linked (a Figma file) that they want built. We fetched it via the
// Figma REST API in startFixSession: a rendered image (attached as the LAST image) plus an EXACT
// structural spec — per-element position, size, auto-layout gap/padding, fonts, and hex colours.
// `design` is { name, summary, image }. The brief is explicit: reproduce it pixel-perfect, using
// the EXACT values from the spec — but built in the repo's own framework/styling system.
function figmaNote(design) {
  if (!design || (!design.summary && !design.image)) return '';
  const imgLine = design.image
    ? `A rendered image of the design is attached as the LAST image — match it pixel-for-pixel.\n`
    : '';
  const struct = design.summary
    ? `Exact spec (positions are relative to the design's top-left; sizes in px; colours in hex):\n${design.summary}\n`
    : '';
  return (
    `The owner linked a design to build: "${design.name || 'design'}".\n` +
    imgLine +
    struct +
    `Reproduce this design PIXEL-PERFECT. Use the EXACT values from the spec above — colours (use the ` +
    `exact hex), spacing (padding, gaps), sizes, alignment/position, corner radius, borders, and fonts ` +
    `(family, weight, size, line-height). Do NOT approximate or "clean up" the values; match them. ` +
    `Build it in the repo's EXISTING framework and styling system — reuse its components and design ` +
    `tokens, and do NOT add new dependencies or a separate style system. If the repo has a token whose ` +
    `value equals a spec value, use the token; otherwise use the literal value from the spec.\n\n`
  );
}

/**
 * The instruction we send the agent. Lives here (no SDK import) so both the
 * production code and the standalone validation harness build the exact same prompt.
 * Asks for a friendly summary + a parseable RESULT_JSON line we read (user never sees it).
 */
export function buildFixPrompt(problem, imageCount = 0, firebaseMounts = [], figmaDesign = null) {
  const screenshotNote =
    imageCount > 0
      ? `The owner also attached ${imageCount} screenshot${imageCount > 1 ? 's' : ''} showing the problem — ` +
        `look at the image${imageCount > 1 ? 's' : ''} to understand exactly what they mean.\n\n`
      : '';
  return (
    `A website owner reports this problem (non-technical wording):\n"${problem}"\n\n` +
    screenshotNote +
    jamNote(problem) +
    firebaseNote(firebaseMounts) +
    figmaNote(figmaDesign) +
    `Investigate the repo at /workspace/repo and make the smallest safe change that resolves it. ` +
    `If a file named AGENTS.md exists at the repo root, READ IT FIRST: it's a maintainer-written ` +
    `map of where things live and which file to edit for common requests — use it to go straight ` +
    `to the right file instead of searching the whole project. If the owner names a page or pastes ` +
    `a link, match it against the URL-to-file route map in AGENTS.md to locate that page's source file. ` +
    `Focus only on the project's own source files — do NOT open, read, or scan generated or ` +
    `dependency folders (node_modules, vendor, dist, build, .next, out, coverage) or lock files; ` +
    `they are noise and reading them only wastes effort. ` +
    `Commit to a new branch, push it, and open a pull request.\n\n` +
    `Then reply with a short, friendly, plain-English summary (no technical jargon). ` +
    `On the VERY LAST line, append a machine-readable result (the user won't see it):\n` +
    `RESULT_JSON: {"summary":"<one friendly sentence>","filesChanged":[{"fileName":"<file>","description":"<plain English>"}],"prUrl":"<pull request url>","briefScore":<0-100 integer rating how clear and specific the owner's ORIGINAL description was: 80-100 if it named the page/section, gave a link, attached a screenshot, or stated expected-vs-actual; 40-70 if somewhat vague; 0-30 if just "it's broken". Score the description only — never the fix.>,"idealDescription":"<a ready-to-paste prompt the owner could send next time to get this exact fix on the first try — written in the owner's own non-technical voice, no jargon. Be specific about WHERE (page name or visible heading the owner can see) and WHAT (the exact label/button/section text or visible state). Include a page URL, on-screen label, or step only if it's something the owner would naturally know — never invent file paths, module names, or technical terms. One or two short sentences.>","idealKeywords":[{"phrase":"<a short phrase that appears VERBATIM in idealDescription>","why":"<one short clause, plain English, why this detail saved time — e.g. 'tells us exactly where', 'names the button', 'limits who sees it'>"}]}\n` +
    `Pick 2–4 idealKeywords — the smallest set that, if missing, would have made you guess. Each phrase MUST be a substring of idealDescription. Skip idealKeywords entirely if the description is already minimal.`
  );
}

/**
 * Follow-up instruction for a REVISION on the same session. The agent keeps the existing
 * branch + pull request (updates them) so the work stays in one PR / one session.
 */
export function buildRevisePrompt(changes, imageCount = 0, figmaDesign = null) {
  const screenshotNote =
    imageCount > 0
      ? `They also attached ${imageCount} screenshot${imageCount > 1 ? 's' : ''} — ` +
        `look at the image${imageCount > 1 ? 's' : ''} to see exactly what they mean.\n\n`
      : '';
  return (
    `The website owner reviewed your fix and wants these additional changes (non-technical wording):\n"${changes}"\n\n` +
    screenshotNote +
    jamNote(changes) +
    figmaNote(figmaDesign) +
    `Continue in this SAME session. Apply the changes to the SAME branch and UPDATE the existing pull request — ` +
    `do NOT open a new one. Make the smallest safe change, commit, and push to the same branch. ` +
    `As before, ignore generated/dependency folders and lock files.\n\n` +
    `Then reply with a short, friendly, plain-English summary of what you changed this time. ` +
    `On the VERY LAST line, append the machine-readable result (the user won't see it), reusing the same pull request url:\n` +
    `RESULT_JSON: {"summary":"<one friendly sentence>","filesChanged":[{"fileName":"<file>","description":"<plain English>"}],"prUrl":"<same pull request url>","briefScore":<0-100 integer rating how clear and specific the owner's change request was: 80-100 if it named the page/section, gave a link, attached a screenshot, or stated expected-vs-actual; 40-70 if somewhat vague; 0-30 if just "it's broken". Score the request only — never the fix.>,"idealDescription":"<a ready-to-paste prompt the owner could send next time to get the full ask (initial + this revision) on the first try — written in the owner's own non-technical voice, no jargon. Be specific about WHERE (page name or visible heading the owner can see) and WHAT (the exact label/button/section text or visible state). Include a page URL, on-screen label, or step only if it's something the owner would naturally know — never invent file paths, module names, or technical terms. One or two short sentences.>","idealKeywords":[{"phrase":"<a short phrase that appears VERBATIM in idealDescription>","why":"<one short clause, plain English, why this detail saved time>"}]}\n` +
    `Pick 2–4 idealKeywords — the smallest set that, if missing, would have made you guess. Each phrase MUST be a substring of idealDescription. Skip idealKeywords entirely if the description is already minimal.`
  );
}

// One RESULT_JSON line per round. We take the LAST one so a revised session reports its
// latest result, not round 1's.
const RESULT_LINE_RE = /RESULT_JSON:\s*(\{.*\})\s*$/;

/**
 * Parse the agent's `agent.message` events for the most recent RESULT_JSON line we asked
 * it to emit (summary + filesChanged + prUrl). Falls back to the last plain-text reply.
 */
export async function extractResult(client, sessionId) {
  let resultSummary = '';
  let filesChanged = [];
  let prUrl = null;
  let idealDescription = '';
  let idealKeywords = [];
  let briefScore = 0;
  try {
    const res = await client.beta.sessions.events.list(sessionId);
    const events = res?.data ?? res?.body?.data ?? (Array.isArray(res) ? res : []);
    const texts = [];
    for (const ev of events) {
      if (ev?.type === 'agent.message') {
        for (const b of ev.content ?? []) if (b?.type === 'text' && b.text) texts.push(b.text);
      }
    }
    const lines = texts.join('\n').split('\n');
    let jsonStr = null;
    for (const line of lines) {
      const mm = line.match(RESULT_LINE_RE);
      if (mm) jsonStr = mm[1]; // keep the last match
    }
    if (jsonStr) {
      let j = null;
      try {
        j = JSON.parse(jsonStr);
      } catch {
        // The agent sometimes emits unescaped double-quotes inside string values (e.g. naming
        // a UI element like "Notify Me"). Fall back to regex extraction for the fields we
        // actually need — prUrl is a plain URL with no special chars; summary can come from
        // the last plain-text reply if the JSON is unrecoverable.
        const prUrlMatch = jsonStr.match(/"prUrl"\s*:\s*"(https?:\/\/[^"]+)"/);
        if (prUrlMatch) prUrl = prUrlMatch[1];
        const scoreMatch = jsonStr.match(/"briefScore"\s*:\s*(\d+)/);
        if (scoreMatch) briefScore = Math.min(100, Number(scoreMatch[1]));
        // filesChanged and idealKeywords require valid JSON arrays — skip on parse failure.
        resultSummary = (texts[texts.length - 1] || '').slice(0, 600);
      }
      if (j) {
        resultSummary = String(j.summary || '').slice(0, 600);
        filesChanged = Array.isArray(j.filesChanged) ? j.filesChanged.slice(0, 50) : [];
        prUrl = j.prUrl || null;
        idealDescription = String(j.idealDescription || '').slice(0, 400);
        // Keep only keywords whose phrase actually appears in idealDescription — guards against
        // the model inventing a "highlight" that doesn't match anything in the tip text.
        if (Array.isArray(j.idealKeywords) && idealDescription) {
          const haystack = idealDescription.toLowerCase();
          idealKeywords = j.idealKeywords
            .map((k) => ({
              phrase: String(k?.phrase || '').slice(0, 120).trim(),
              why: String(k?.why || '').slice(0, 100).trim(),
            }))
            .filter((k) => k.phrase && k.why && haystack.includes(k.phrase.toLowerCase()))
            .slice(0, 5);
        }
        // Clarity rating for points + coaching (advisory only — never gates or prices a fix).
        // Trust the agent's score when it's a sane number; otherwise fall back to how sparse
        // idealKeywords is (few missing details ⇒ the brief was already clear ⇒ high score).
        const raw = Number(j.briefScore);
        if (Number.isFinite(raw) && raw >= 0) {
          briefScore = Math.min(100, Math.round(raw));
        } else {
          briefScore = idealKeywords.length === 0 ? 80 : Math.max(20, 80 - idealKeywords.length * 15);
        }
      }
    } else {
      resultSummary = (texts[texts.length - 1] || '').slice(0, 600);
    }
  } catch {
    /* best-effort — leave defaults */
  }
  return { resultSummary, filesChanged, prUrl, idealDescription, idealKeywords, briefScore };
}

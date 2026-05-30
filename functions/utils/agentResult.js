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
// Keyed by family so dated snapshots (claude-sonnet-4-6, claude-opus-4-7, …) all resolve here.
export const MODEL_PRICES = {
  opus:   { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  sonnet: { input: 3,  output: 15, cacheRead: 0.3, cacheWrite5m: 3.75,  cacheWrite1h: 6  },
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

/**
 * The instruction we send the agent. Lives here (no SDK import) so both the
 * production code and the standalone validation harness build the exact same prompt.
 * Asks for a friendly summary + a parseable RESULT_JSON line we read (user never sees it).
 */
export function buildFixPrompt(problem, imageCount = 0) {
  const screenshotNote =
    imageCount > 0
      ? `The owner also attached ${imageCount} screenshot${imageCount > 1 ? 's' : ''} showing the problem — ` +
        `look at the image${imageCount > 1 ? 's' : ''} to understand exactly what they mean.\n\n`
      : '';
  return (
    `A website owner reports this problem (non-technical wording):\n"${problem}"\n\n` +
    screenshotNote +
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
    `RESULT_JSON: {"summary":"<one friendly sentence>","filesChanged":[{"fileName":"<file>","description":"<plain English>"}],"prUrl":"<pull request url>","idealDescription":"<a ready-to-paste prompt the owner could send next time to get this exact fix on the first try — written in the owner's own non-technical voice, no jargon. Be specific about WHERE (page name or visible heading the owner can see) and WHAT (the exact label/button/section text or visible state). Include a page URL, on-screen label, or step only if it's something the owner would naturally know — never invent file paths, module names, or technical terms. One or two short sentences.>","idealKeywords":[{"phrase":"<a short phrase that appears VERBATIM in idealDescription>","why":"<one short clause, plain English, why this detail saved time — e.g. 'tells us exactly where', 'names the button', 'limits who sees it'>"}]}\n` +
    `Pick 2–4 idealKeywords — the smallest set that, if missing, would have made you guess. Each phrase MUST be a substring of idealDescription. Skip idealKeywords entirely if the description is already minimal.`
  );
}

/**
 * Follow-up instruction for a REVISION on the same session. The agent keeps the existing
 * branch + pull request (updates them) so the work stays in one PR / one session.
 */
export function buildRevisePrompt(changes, imageCount = 0) {
  const screenshotNote =
    imageCount > 0
      ? `They also attached ${imageCount} screenshot${imageCount > 1 ? 's' : ''} — ` +
        `look at the image${imageCount > 1 ? 's' : ''} to see exactly what they mean.\n\n`
      : '';
  return (
    `The website owner reviewed your fix and wants these additional changes (non-technical wording):\n"${changes}"\n\n` +
    screenshotNote +
    `Continue in this SAME session. Apply the changes to the SAME branch and UPDATE the existing pull request — ` +
    `do NOT open a new one. Make the smallest safe change, commit, and push to the same branch. ` +
    `As before, ignore generated/dependency folders and lock files.\n\n` +
    `Then reply with a short, friendly, plain-English summary of what you changed this time. ` +
    `On the VERY LAST line, append the machine-readable result (the user won't see it), reusing the same pull request url:\n` +
    `RESULT_JSON: {"summary":"<one friendly sentence>","filesChanged":[{"fileName":"<file>","description":"<plain English>"}],"prUrl":"<same pull request url>","idealDescription":"<a ready-to-paste prompt the owner could send next time to get the full ask (initial + this revision) on the first try — written in the owner's own non-technical voice, no jargon. Be specific about WHERE (page name or visible heading the owner can see) and WHAT (the exact label/button/section text or visible state). Include a page URL, on-screen label, or step only if it's something the owner would naturally know — never invent file paths, module names, or technical terms. One or two short sentences.>","idealKeywords":[{"phrase":"<a short phrase that appears VERBATIM in idealDescription>","why":"<one short clause, plain English, why this detail saved time>"}]}\n` +
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
      const j = JSON.parse(jsonStr);
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
    } else {
      resultSummary = (texts[texts.length - 1] || '').slice(0, 600);
    }
  } catch {
    /* best-effort — leave defaults */
  }
  return { resultSummary, filesChanged, prUrl, idealDescription, idealKeywords };
}

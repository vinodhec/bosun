// Compute a managed-agent session's actual USD cost and extract its result.
//
// Field shapes CONFIRMED via a live session probe (2026-05): token counts live on
// `session.usage`, runtime on `session.stats.active_seconds`, there is NO reported
// cost field (we compute it), and the agent's reply is in `agent.message` events.
// The billing MATH (×2, floors) is unit-verified separately; this file only sources
// the `actualCostUsd` input.

// Token prices (USD per 1M tokens) for the agent's model — set from current Anthropic
// pricing. Cache read/write rates default to standard multiples of the input price if
// not set explicitly. Read lazily so Secret-Manager/env values bind at runtime.
const inputP = () => Number(process.env.PRICE_INPUT_PER_MTOK) || 0;
const PRICE = {
  input: () => inputP(),
  output: () => Number(process.env.PRICE_OUTPUT_PER_MTOK) || 0,
  cacheRead: () => Number(process.env.PRICE_CACHE_READ_PER_MTOK) || inputP() * 0.1,
  cacheWrite5m: () => Number(process.env.PRICE_CACHE_WRITE_5M_PER_MTOK) || inputP() * 1.25,
  cacheWrite1h: () => Number(process.env.PRICE_CACHE_WRITE_1H_PER_MTOK) || inputP() * 2,
};
const sessionHourUsd = () => Number(process.env.SESSION_HOUR_USD) || 0.08;

/** Actual USD cost of a session = token cost + runtime cost. */
export function sessionCostUsd(session) {
  // Guard against a misconfigured deploy: with token prices unset, cost would be computed
  // from runtime alone and every charge would be silently too low. Warn loudly instead.
  if (inputP() <= 0 || PRICE.output() <= 0) {
    console.error('billing:price_config — PRICE_INPUT/OUTPUT_PER_MTOK is 0 or unset; token cost is undercounted.');
  }
  const u = session?.usage || {};
  const cc = u.cache_creation || {};
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheWrite5m = Number(cc.ephemeral_5m_input_tokens) || 0;
  const cacheWrite1h = Number(cc.ephemeral_1h_input_tokens) || 0;

  const tokenUsd =
    (input * PRICE.input() +
      output * PRICE.output() +
      cacheRead * PRICE.cacheRead() +
      cacheWrite5m * PRICE.cacheWrite5m() +
      cacheWrite1h * PRICE.cacheWrite1h()) /
    1e6;

  // $0.08/session-hour accrues only while running; `active_seconds` is that running time.
  const runtimeSec = Number(session?.stats?.active_seconds) || 0;
  const runtimeUsd = (runtimeSec / 3600) * sessionHourUsd();

  return tokenUsd + runtimeUsd;
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
    `Focus only on the project's own source files — do NOT open, read, or scan generated or ` +
    `dependency folders (node_modules, vendor, dist, build, .next, out, coverage) or lock files; ` +
    `they are noise and reading them only wastes effort. ` +
    `Commit to a new branch, push it, and open a pull request.\n\n` +
    `Then reply with a short, friendly, plain-English summary (no technical jargon). ` +
    `On the VERY LAST line, append a machine-readable result (the user won't see it):\n` +
    `RESULT_JSON: {"summary":"<one friendly sentence>","filesChanged":[{"fileName":"<file>","description":"<plain English>"}],"prUrl":"<pull request url>"}`
  );
}

/**
 * Follow-up instruction for a REVISION on the same session. The agent keeps the existing
 * branch + pull request (updates them) so the work stays in one PR / one session.
 */
export function buildRevisePrompt(changes) {
  return (
    `The website owner reviewed your fix and wants these additional changes (non-technical wording):\n"${changes}"\n\n` +
    `Continue in this SAME session. Apply the changes to the SAME branch and UPDATE the existing pull request — ` +
    `do NOT open a new one. Make the smallest safe change, commit, and push to the same branch. ` +
    `As before, ignore generated/dependency folders and lock files.\n\n` +
    `Then reply with a short, friendly, plain-English summary of what you changed this time. ` +
    `On the VERY LAST line, append the machine-readable result (the user won't see it), reusing the same pull request url:\n` +
    `RESULT_JSON: {"summary":"<one friendly sentence>","filesChanged":[{"fileName":"<file>","description":"<plain English>"}],"prUrl":"<same pull request url>"}`
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
    } else {
      resultSummary = (texts[texts.length - 1] || '').slice(0, 600);
    }
  } catch {
    /* best-effort — leave defaults */
  }
  return { resultSummary, filesChanged, prUrl };
}

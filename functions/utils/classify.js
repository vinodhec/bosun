import Anthropic from '@anthropic-ai/sdk';

// Classify a website-fix request into a complexity tier. SHARED by classifyTask (the
// estimate step) and createTask (which binds the agent's hard budget cap to the tier, so
// the spend cap always matches the complexity we quoted). Cheap call (~₹0.50), absorbed
// by us. Fails safe to 'medium'.
//
// When `repoTree` is supplied (createTask has the repo + GitHub token in hand), the
// classifier sees the project's actual file map and judges how much of the codebase the
// request really touches — far more accurate than reading the request text blind. The
// code-aware model is env-tunable (CLASSIFY_CODE_MODEL); without a tree we keep the
// cheap Haiku text-only path unchanged.
export async function classifyComplexity(prompt, { repoTree } = {}) {
  const problem = String(prompt ?? '').trim();
  if (!problem) return { complexity: 'medium', reason: '' };

  const codeAware = !!(repoTree && Array.isArray(repoTree.paths) && repoTree.paths.length);
  const model = codeAware ? (process.env.CLASSIFY_CODE_MODEL || 'claude-haiku-4-5') : 'claude-haiku-4-5';
  const repoBlock = codeAware
    ? `\nThe project's source files (${repoTree.paths.length}` +
      `${repoTree.total > repoTree.paths.length ? ` of ${repoTree.total}` : ''} shown):\n` +
      repoTree.paths.join('\n') +
      `\nUse this file map to judge how much of the codebase the request really touches.\n`
    : '';

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 200,
      system: 'You classify website fix requests. Respond with JSON only — no prose, no code fences.',
      messages: [
        {
          role: 'user',
          content:
            `Classify this website fix request.\n` +
            `Request: "${problem}"\n` +
            repoBlock +
            `\nRespond JSON only:\n` +
            `{"complexity":"simple|medium|complex|large","reason":"one short line in plain English, no technical words"}\n\n` +
            `Guide:\n` +
            `- simple  = one small change, e.g. something not showing or a styling issue\n` +
            `- medium  = a whole page or several parts affected\n` +
            `- complex = something stops working / many parts affected\n` +
            `- large   = a major job: multiple features, a redesign, or several pages of new work (too big for one quick fix)`,
        },
      ],
    });
    const text = msg.content.find((c) => c.type === 'text')?.text ?? '{}';
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const complexity = ['simple', 'medium', 'complex', 'large'].includes(json.complexity) ? json.complexity : 'medium';
    return { complexity, reason: String(json.reason || '').slice(0, 160) };
  } catch {
    // Any classifier hiccup → safe middle estimate.
    return { complexity: 'medium', reason: '' };
  }
}

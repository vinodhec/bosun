import Anthropic from '@anthropic-ai/sdk';

// Classify a website-fix request into a complexity tier. SHARED by classifyTask (the
// estimate step) and createTask (which binds the agent's hard budget cap to the tier, so
// the spend cap always matches the complexity we quoted). Cheap Haiku call (~₹0.50),
// absorbed by us. Fails safe to 'medium'.
export async function classifyComplexity(prompt) {
  const problem = String(prompt ?? '').trim();
  if (!problem) return { complexity: 'medium', reason: '' };

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: 'You classify website fix requests. Respond with JSON only — no prose, no code fences.',
      messages: [
        {
          role: 'user',
          content:
            `Classify this website fix request.\n` +
            `Request: "${problem}"\n\n` +
            `Respond JSON only:\n` +
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

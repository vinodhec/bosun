import Anthropic from '@anthropic-ai/sdk';

// Conservative model routing. Use the cheaper Sonnet model ONLY for clearly trivial,
// purely visual/text changes; default to Opus (better fix quality) for anything with
// logic/behaviour or any uncertainty. Returns 'sonnet' | 'opus'. Fails safe to 'opus'.
export async function chooseModel(prompt) {
  try {
    const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await c.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 8,
      system:
        'Route a website-fix request to a model. Reply with exactly one word: "sonnet" if the ' +
        'request is a clearly TRIVIAL, purely visual or text change (CSS, colour, spacing, ' +
        'copy/wording, show or hide an element, a label). Reply "opus" for anything involving ' +
        'behaviour, logic, data, forms, APIs, multiple files, or any uncertainty. When unsure, "opus".',
      messages: [{ role: 'user', content: `Request: "${String(prompt).slice(0, 500)}"` }],
    });
    const text = (msg.content.find((b) => b.type === 'text')?.text || '').toLowerCase();
    return text.includes('sonnet') ? 'sonnet' : 'opus';
  } catch {
    return 'opus'; // fail safe to the higher-quality model
  }
}

// Resolve the model choice to a managed-agent id (env-configured). Falls back to Opus.
export function agentIdForModel(model) {
  const opus = process.env.ANTHROPIC_MANAGED_AGENT_ID;
  const sonnet = process.env.ANTHROPIC_MANAGED_AGENT_ID_SONNET || opus;
  return model === 'sonnet' ? sonnet : opus;
}

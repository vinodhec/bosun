import Anthropic from '@anthropic-ai/sdk';

// Break a plain-language feature request into a list of individual tasks. SHARED shape with
// classify.js: a cheap Haiku call returning structured JSON, cost absorbed by us (this is the
// FREE preview step — nothing is charged until the customer publishes). Fails safe to an empty
// list so a model hiccup degrades to "no suggestions" rather than an error.

const MAX_TASKS = 12;

function cleanStringList(arr, cap) {
  return Array.isArray(arr)
    ? arr.map((s) => String(s || '').trim()).filter(Boolean).slice(0, cap)
    : [];
}

/** Normalise one raw task object from the model (or the client) into our canonical shape. */
export function normalisePlanTask(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim().slice(0, 140);
  if (!title) return null;
  return {
    title,
    description: String(raw.description || '').trim().slice(0, 2000),
    acceptanceCriteria: cleanStringList(raw.acceptanceCriteria, 8).map((s) => s.slice(0, 240)),
    dependsOn: cleanStringList(raw.dependsOn, 8).map((s) => s.slice(0, 140)),
  };
}

export function normalisePlanTasks(rawTasks) {
  return (Array.isArray(rawTasks) ? rawTasks : [])
    .map(normalisePlanTask)
    .filter(Boolean)
    .slice(0, MAX_TASKS);
}

export async function decomposeFeature(prompt) {
  const ask = String(prompt ?? '').trim();
  if (!ask) return { tasks: [] };

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      system:
        'You break a small business owner’s feature request into a short list of clear, ' +
        'individual tasks a team can pick up. Respond with JSON only — no prose, no code fences.',
      messages: [
        {
          role: 'user',
          content:
            `Break this feature request into individual tasks.\n` +
            `Request: "${ask}"\n\n` +
            `Respond JSON only, in this exact shape:\n` +
            `{"tasks":[{"title":"short imperative title","description":"1-3 plain sentences",` +
            `"acceptanceCriteria":["a checkable outcome","another"],"dependsOn":["title of a task this needs first"]}]}\n\n` +
            `Rules:\n` +
            `- Aim for 2 to ${MAX_TASKS} tasks. Prefer fewer, well-scoped tasks over many tiny ones.\n` +
            `- Plain, non-technical language a shop owner would understand. No jargon.\n` +
            `- Each task should be a single deliverable with 1-4 acceptance criteria.\n` +
            `- Use "dependsOn" only when a task genuinely needs another finished first; otherwise [].`,
        },
      ],
    });
    const text = msg.content.find((c) => c.type === 'text')?.text ?? '{}';
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    return { tasks: normalisePlanTasks(json.tasks) };
  } catch {
    // Any decompose hiccup → empty list; the UI lets the owner add tasks by hand.
    return { tasks: [] };
  }
}

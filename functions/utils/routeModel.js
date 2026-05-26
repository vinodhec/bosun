// Deterministic, cost-aware model routing. Sonnet is the workhorse for all but the most
// involved fixes; Opus is reserved for `complex` requests (something stopped working /
// many parts affected) where the extra quality is worth ~5× the token price.
//
// The choice is DERIVED from the complexity the Haiku classifier already produced in
// `classifyTask`, so we never spend a second model call just to pick a model. (Revisions
// resume the SAME session, whose model is fixed at creation — so the initial complexity is
// the only point at which the model can be chosen.)

/** Map a complexity tier to a model. 'complex'/'large' -> opus; everything else -> sonnet. */
export function modelForComplexity(complexity) {
  return complexity === 'complex' || complexity === 'large' ? 'opus' : 'sonnet';
}

// Resolve the model choice to a managed-agent id (env-configured). Falls back to the Opus
// agent if no dedicated Sonnet agent is set — set ANTHROPIC_MANAGED_AGENT_ID_SONNET or the
// cheaper routing silently runs on Opus.
export function agentIdForModel(model) {
  const opus = process.env.ANTHROPIC_MANAGED_AGENT_ID;
  const sonnet = process.env.ANTHROPIC_MANAGED_AGENT_ID_SONNET || opus;
  return model === 'sonnet' ? sonnet : opus;
}

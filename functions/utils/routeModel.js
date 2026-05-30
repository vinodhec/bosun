// Deterministic, cost-aware model routing.
//
// TEMPORARY POLICY: every fix runs on Sonnet, regardless of complexity. Opus was costing
// ~5× the token price and pushing customer charges far above expectation (a "complex" admin
// tweak billed ₹800–1,335). We'll reintroduce Opus for `complex`/`large` later, gated on
// observed quality results — the complexity-based mapping is preserved in comments below so
// it's a one-line revert.
//
// The choice is DERIVED from the complexity the Haiku classifier already produced in
// `classifyTask`, so we never spend a second model call just to pick a model. (Revisions
// resume the SAME session, whose model is fixed at creation — so the initial complexity is
// the only point at which the model can be chosen.)

/** Map a complexity tier to a model. Currently Sonnet-only (see policy note above). */
export function modelForComplexity(complexity) {
  // Reintroduce when ready:
  //   return complexity === 'complex' || complexity === 'large' ? 'opus' : 'sonnet';
  return 'sonnet';
}

// Resolve the model choice to a managed-agent id (env-configured). Falls back to the Opus
// agent if no dedicated Sonnet agent is set — set ANTHROPIC_MANAGED_AGENT_ID_SONNET or the
// cheaper routing silently runs on Opus.
export function agentIdForModel(model) {
  const opus = process.env.ANTHROPIC_MANAGED_AGENT_ID;
  const sonnet = process.env.ANTHROPIC_MANAGED_AGENT_ID_SONNET || opus;
  return model === 'sonnet' ? sonnet : opus;
}

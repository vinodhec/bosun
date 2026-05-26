# scripts — validate the fix engine before any UI

Goal: prove steps 2–5 (start session → agent fixes + PR → poll → cost + bill) work
against the **real** Managed Agents API, in isolation. No Firebase, no UI.

## 0. Prereqs
- A Claude API key with the `managed-agents-2026-04-01` beta (on by default).
- A **throwaway GitHub repo** with an obvious, simple bug to fix.
- A fine-grained GitHub **PAT** with `repo` scope on that test repo (for the live run
  we use a PAT directly; in production the GitHub App mints this token instead).
- A recent `@anthropic-ai/sdk` (installed in `functions/`). If `beta.sessions` is
  missing, bump it: `cd functions && npm i @anthropic-ai/sdk@latest`.

## 1. Create the agent (once)
```bash
cd functions && ANTHROPIC_API_KEY=sk-ant-... node ../scripts/create-agent.mjs
# → prints ANTHROPIC_MANAGED_AGENT_ID=agt_...
```

## 2. Dry run (no key) — eyeball the payloads
```bash
cd functions && node ../scripts/validate-core.mjs --dry
```

## 3. Live run — the real end-to-end test
```bash
cd functions && \
  ANTHROPIC_API_KEY=sk-ant-... AGENT_ID=agt_... GITHUB_TOKEN=ghp_... \
  REPO=https://github.com/you/test-site PROBLEM="menu broken on mobile" \
  PRICE_INPUT_PER_MTOK=... PRICE_OUTPUT_PER_MTOK=... SESSION_HOUR_USD=0.08 \
  node ../scripts/validate-core.mjs
```
Expect: a session id, status ticking to done, a **PR opened on the test repo**, and a
final cost + parsed result (`summary`, `filesChanged`, `prUrl`).

## 4. Confirm + lock the field names
The session **status values**, **usage/cost fields**, and the **events list / cancel**
methods are marked `CONFIRM` in `functions/utils/agentResult.js` and
`functions/handlers/pollSessions.js`. The live run tells you the real shapes — fix them
in `agentResult.js` (one place; the poller reuses it). The billing math itself
(`shared/billing.js`) is already unit-verified, so once `actualCostUsd` is sourced
correctly, billing is correct.

Only after this passes do we wire it into the UI.

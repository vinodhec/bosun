# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bosun — a SaaS for non-technical small business owners in India to fix website problems with AI.
Customer describes what's broken → managed Claude Agent edits their GitHub repo and opens a PR →
the org wallet is billed only on success. Currency is INR; the canonical billing math lives in
`shared/billing.js` (see "Money rules" below).

## Common commands

```bash
# Frontend (Vite + React 19 + Tailwind 4, port 5190)
npm run dev
npm run build           # outputs to dist/ (the Hosting public dir)

# Cloud Functions emulator (auto-runs sync-shared.sh first)
cd functions && npm run serve

# Deploy
npm run build && firebase deploy            # hosting + functions + rules + indexes
cd functions && npm run deploy              # functions only
firebase deploy --only hosting              # SPA only
firebase deploy --only firestore:rules      # rules only

# Validate the fix engine against the real Managed Agents API (no Firebase, no UI)
cd functions && ANTHROPIC_API_KEY=... node ../scripts/create-agent.mjs        # one-time
cd functions && node ../scripts/validate-core.mjs --dry                       # payload eyeball
cd functions && ANTHROPIC_API_KEY=... AGENT_ID=... GITHUB_TOKEN=... \
  REPO=... PROBLEM="..." node ../scripts/validate-core.mjs                    # live E2E
```

There is no test runner, linter, or type checker wired up. `vite build` is the only
correctness gate for the frontend; `firebase emulators:start` is the only one for functions.

## The cardinal architectural rule

**The browser can READ a user's own data but can NEVER write money** (balance, cost, charge,
task.billed, transactions). All money-bearing writes go through Cloud Functions using the Admin
SDK (which bypasses security rules). The Firestore rules in `firestore.rules` enforce this with
`allow write: if false` on every collection — clients write nothing directly. Any new collection
must follow the same pattern unless it's strictly user-owned, non-financial data.

Credits live on the **organisation**, not the user. A user is scoped to one org via an `orgId`
custom claim set by the operator; that claim gates org + transaction reads in the rules.

## How the code is organised

```
shared/         Canonical billing + currency. The only place pricing/markup/floors live.
src/            Vite SPA — pages/, components/, hooks/, firebase/ (clients), utils/
functions/      Cloud Functions (gen2, nodejs22, region asia-south1)
  handlers/     One file per callable group (createTask, classifyTask, customerTasks, admin, adminGithub, adminTrello, adminFigma, planFeature, publishPlan, pollSessions, ensureUser)
  utils/        Server-side helpers (billing, claudeAgent, vault, github, secrets, routeModel, finalize, classify, planTasks, trello, figma)
  scripts/      Standalone Managed-Agents E2E scripts (no Firebase) — see scripts/README.md
  shared/       GENERATED at predeploy from /shared (gitignored)
scripts/sync-shared.sh   Copies /shared → /functions/shared. Runs before deploy AND emulate.
templates/github-workflows/   deploy-testing.yml + deploy-prod.yml seeded into customer repos
docs/ARCHITECTURE.md          Mermaid sequence diagrams for sign-up, fix, billing, lifecycle
```

The `shared/` ↔ `functions/shared/` split exists because Cloud Functions only bundle their own
folder — never edit `functions/shared/` directly, it's regenerated. Edit `/shared/*.js` and the
predeploy hook (declared in `firebase.json`) copies it across.

## Money rules (do not fork)

All charge math goes through `shared/billing.js`. Key invariants:

- **Fixed-tier pricing.** `COMPLEXITY_TIERS` (`simple` ₹149 / `medium` ₹375 / `complex` ₹749)
  is the price the customer pays on approval, irrespective of token cost. `maxBudgetUsd` is the
  hard $ cap the poller enforces (Managed Agents have no native spend cap). `maxSeconds` is a
  second, independent runtime cap — kept because `session.usage` can stay at $0 for minutes
  while tokens burn, so the cost-based check alone is unreliable.
- **`large`** is a fourth tier with no fixed price — `createTask` parks it as `needs_quote`
  for the operator to quote via `adminQuoteTask`; nothing runs until `confirmQuote`.
- **Approve-before-charge.** A round ends in `pendingReview`; the user pays the tier price
  on `approveFix` (or revises). `MAX_FREE_REVISIONS = 1` for `unresolved` (our shortfall);
  `new_scope` always pays the tier price again. The classification is server-authoritative
  (`classifyTask` re-runs; never trust client-supplied "it's unresolved").
- **Idempotent + atomic billing.** Billing runs inside Firestore transactions in `pollSessions`
  / `customerTasks` and gates on `billed: false`. Failed runs are never charged.
- The legacy `MARKUP_MULTIPLIER` / `computeCharge` paths still exist for transaction estimates
  but the production path is fixed-tier (`priceForComplexity`).

## The fix pipeline (where state lives)

1. `classifyTask` — Haiku call returns `{ complexity, reason }` for the estimate UI; we absorb its cost.
2. `createTask` — gates on `org.balance >= requiredBalanceFor(complexity)`, writes `tasks/{id}`,
   pulls the org's GitHub token from `orgSecrets/{orgId}` (the **vault** — clients have no read
   access, even via rules), mints/uses it for the Managed Agent session, stores `sessionId`.
3. Managed Agent (Anthropic-hosted, NOT our infra) clones the repo via the GitHub MCP server,
   fixes, pushes a branch, opens a PR. Beta header `managed-agents-2026-04-01` is required.
4. `pollSessions` (scheduled) reads `session.usage` + runtime, terminates over-cap sessions,
   parses the final result via `utils/agentResult.js`, flips the task to `pendingReview`.
5. `approveFix` / `reviseSession` (customer callables) — approval debits the org wallet in a
   transaction and marks `billed: true`. Revisions create a child task linked by `parentTaskId`.

Task lifecycle: `queued → running → (pendingReview ↔ revising) → complete | failed | needs_quote`.

## "Plan a feature" (a separate task type — does NOT touch GitHub/agent/pollSessions)

A second customer flow at `/plan` (RequireAuth). The owner describes a feature → we decompose it
into editable tasks → on approval we publish them as cards to the org's Trello board → the wallet
is billed a single flat price. Key points:

- `planFeature` (callable) — FREE preview, mirrors `classifyTask`: a cheap model (`utils/planTasks.js`)
  returns `{ tasks: [{ title, description, acceptanceCriteria[], dependsOn[] }] }`. Cost absorbed.
- `publishPlan` (callable) — gates on `org.balance >= priceForPlan()`, pulls Trello creds from
  `orgSecrets/{orgId}.trello` (vault), writes one card per task via `utils/trello.js`, records a
  `tasks/{id}` of `type:'plan'`, and debits the wallet in a Firestore transaction gated on
  `billed:false`. **Idempotent** via a client `planId` (the doc id `plan_<planId>`): a retry never
  duplicates cards or double-charges. Charge lands only on a successful publish.
- Pricing lives in `shared/billing.js` (`PLAN_PRICE_INR` / `priceForPlan()`); `requiredBalanceFor('plan')`
  returns the flat price. Do NOT fork the math.
- Trello uses an API key + per-user token (not the static-bearer MCP shape) — an operator connects
  them via `adminTrello.js` callables (Admin panel). Token never returned to the browser; a non-secret
  `org.trello.connected` status is mirrored to the org doc for the `/plan` readiness check.
- `firestore.rules` is unchanged: plan tasks reuse the `tasks` collection (owner-read, backend-write)
  and `orgSecrets` stays fully client-unreadable.

## Figma design-to-code (enriches a fix — NOT a separate task type)

When a customer pastes a **figma.com link** into "what's broken", the fix is enriched with the
design so the agent builds it **pixel-perfect**. This rides the normal fix pipeline + tier pricing —
no new task type, no billing change. It mirrors the `jam` link pattern, but because Figma's official
MCP is OAuth-only/client-gated (can't be a vault `static_bearer` like GitHub/Jam), we use the **Figma
REST API** instead:

- An operator connects the org's Figma **Personal Access Token** via `adminFigma.js` (Admin panel).
  It's validated against `GET /v1/me` and stored backend-only in `orgSecrets/{orgId}.figma` (the
  vault — never returned to the browser); a non-secret `org.figma.connected` + handle is mirrored.
- `utils/figma.js` is the only integration point: `designContextFromText({ org, secretData, text })`
  fires iff the text has a figma link AND the org is connected. It pulls the node tree
  (`/v1/files/:key/nodes`) into an **exact spec** (positions, sizes, auto-layout gap/padding, fonts,
  hex colours) + a rendered PNG (`/v1/images`). Any failure degrades to `null` — a bad link never
  blocks the fix.
- `createTask` (initial) and `reviseSession` (revision) call it and pass `figmaDesign` to
  `startFixSession` / `continueFixSession`; `buildFixPrompt` / `buildRevisePrompt` add a `figmaNote`
  that attaches the PNG as the LAST image and instructs exact-value, repo-native reproduction.
- `firestore.rules` unchanged — `orgSecrets.figma` is client-unreadable; the `org.figma` mirror is
  owner-readable like `org.trello`.

## Frontend conventions

- Vite aliases: `@` → `src/`, `@shared` → `shared/`. Use them in imports.
- React Router v7, three top-level routes (`/`, `/auth`, `/dashboard`, `/admin`). Auth is
  guarded by `RequireAuth` in `App.jsx`.
- Tailwind v4 via `@tailwindcss/vite` — config lives inline in `index.css`, not a separate file.
- Customer-facing UI is read-only on Firestore via `onSnapshot` hooks (`useBalance`, `useTasks`,
  `useOrg`, `useSite`). All mutations go through callable functions in `src/firebase/functions.js`.
- The customer UI never reads `tasks/{id}` directly for the chat — it uses the `listMySessions`
  callable which strips operator-only fields (PR url, raw model, raw API cost).

## UI language rules (strict — repeated from README)

Never show technical words in customer-facing UI: prompt, token, agent, API, deploy, diff,
repository, CSS, etc. Use plain phrasing: "What's broken", "Fix is ready", "What we changed",
"Working on it". The operator-only Admin panel and adminGithub callables are exempt.

## Secrets & config

- Frontend env: `.env.local` with `VITE_*` keys (see `.env.example`).
- Functions env: `functions/.env` for local; production secrets are bound via `defineSecret`
  in `functions/utils/secrets.js` and listed in each callable's `secrets:` array.
- Operator-only callables (everything in `admin.js` / `adminGithub.js`) gate on
  `ADMIN_EMAILS` — do not assume Firebase Auth role claims.
- Firebase project id: `bosun-76bba` (`.firebaserc`).
- Default Functions region: `asia-south1`. Keep new callables on the same region.

## MCP servers & environment switching

The repo declares two MCP servers in `.mcp.json` (auto-enabled via `.claude/settings.json`):
**firebase** (official `firebase-tools experimental:mcp`) and **jam** (`https://mcp.jam.dev/mcp`,
per-user OAuth — call `mcp__jam__authenticate` once to sign in).

`.firebaserc` defines three project aliases: `default`/`testing`/`production`. The Firebase MCP has
no `--project` flag — switch the active project at runtime with the MCP tool
`firebase_update_environment(active_project: "testing" | "production")`. Rules:

- **Default to `testing` (`maadiveedu-6b8ce`).** Before any Firebase MCP read/write, check the
  active project with `firebase_get_environment`; if it isn't the intended env, switch it.
- **Use `production` (`maadiveeduvas`) only when a production URL/domain or the word "production" is
  explicitly given.** Otherwise stay on testing.
- **Switch back to `testing` after a production task** (active project is sticky per project dir),
  and **confirm before any production write** (data/auth/config changes).
- **Deploy guard:** these aliases are for MCP project *context* only. NEVER `firebase deploy`
  against `testing`/`production` from this repo — `firebase.json` here is Bosun's app, and those
  projects are deployed from the `maadiveedu-unified-platform` repo. Bosun deploys only ever target
  `default` (`bosun-76bba`).
- **Jam** has no environment dimension — use it to inspect a shared Jam recording (console/network/
  repro) whenever a jam.dev link is referenced.

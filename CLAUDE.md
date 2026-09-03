# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bosun — a SaaS for non-technical small business owners in India to fix website problems with AI.
Customer describes what's broken → managed Claude Agent edits their GitHub repo and opens a PR →
the org wallet is billed only on success. Customers can also **plan a feature** — a bigger ask
is broken into fix-sized steps that build one at a time (see "The feature pipeline"). Currency is
INR; the canonical billing math lives in `shared/billing.js` (see "Money rules" below).

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
  handlers/     One file per callable group (createTask, classifyTask, customerTasks, featureTasks, admin, adminGithub, adminFigma, pollSessions, ensureUser)
  utils/        Server-side helpers (billing, claudeAgent, vault, github, secrets, routeModel, finalize, classify, agentResult, featurePlan, featureRun, sessionView, figma)
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

- **Bracketed cost-plus pricing (the live path).** A completed round is charged
  `priceFromCostUsd(actualCOGS)` in `utils/finalize.js` — the `PRICING_BRACKETS` markup on the
  run's real token cost (FLAT 3× since 2026-07-16 — the owner capped markup at 3× for
  everything; capped at `MAX_CHARGE_INR` ₹690, no minimum). Nothing is quoted upfront. `COMPLEXITY_TIERS` is still
  consulted, but only for `maxBudgetUsd` (the poller's hard $ cap — Managed Agents have no
  native cap) and `maxSeconds` (an independent runtime cap, kept because `session.usage` can
  read $0 for minutes while tokens burn) plus model routing — **NOT** for the price. The fixed
  `priceInr` tier values (`simple` ₹149 / `medium` ₹375 / `complex` ₹749) and `priceForComplexity`
  are dormant for the auto path.
- **`large`** has no auto price — `createTask` parks it as `needs_quote` for the operator to set
  a flat `priceInr` via `adminQuoteTask`; nothing runs until `confirmQuote`. That operator quote
  is the one place `priceInr` is actually charged.
- **Approve-before-charge is per-ORG.** `org.requireApproval = true` ends a round in
  `pendingReview` and waits for `approveFix`; the DEFAULT (`false`) auto-charges the bracketed
  price the moment the agent finishes (`markRoundReady`). Either way `MAX_FREE_REVISIONS = 1`
  free `unresolved` re-fix (our shortfall, charged ₹0); `new_scope` is charged again. A revision
  appends to `task.rounds` — there is no child task / `parentTaskId` — and runs EITHER by resuming
  the managed-agent session or in a fresh one (see "Warm vs fresh revisions" below).
- **Idempotent + atomic billing.** Billing runs inside Firestore transactions in `finalize.js`
  (called from `pollSessions` / `approveFix`) and gates on the round transition. Failed runs are
  never charged (`markRoundFailure`).
- **Feature charges are NOT bracketed.** Planning is billed `priceForPlanning(cost)` =
  `PLANNING_MULTIPLIER` (2×) the planning call's actual COGS, debited on breakdown. Each PLANNED
  build step is billed `priceForFeatureStep` — a flat `FEATURE_STEP_MULTIPLIER` (3×) on the step's
  own incremental COGS, clamped per step (`MAX_FEATURE_STEP_CHARGE_INR` ₹600) and by a hard
  per-feature ceiling `FEATURE_BUILD_CAP_INR` (₹1599) across the whole plan (headroom tracked on
  `features/{id}.buildChargedInr`, consumed inside the `markRoundReady` transaction). Planning and
  post-completion `added` changes bill OUTSIDE the cap (`added` steps use the normal brackets with
  the ₹600 step cap).
- The `MARKUP_MULTIPLIER` / `computeCharge` (×2.5, ₹75 floor) path is legacy — it still backs the
  `actualCostInr` analytics field and a couple of scripts, but the customer charge is
  `priceFromCostUsd`, never `computeCharge` and never `priceForComplexity`.

## GST reports (the software line's slice of a shared GSTIN)

Bosun invoices under the proprietor's EXISTING trading-business GSTIN (`33ACJPT9393A1ZC`), on a
separate `SW/` invoice series. So Bosun never files a return — it produces the software line's
half, which the CA merges with the trading business. `utils/gstReport.js` builds all five reports
the trading business's package produces (Sale, Purchase, GSTR-1, GSTR-2, GSTR-3B) as pure
functions over rows; `adminGstReport({ kind, from, to })` fetches the rows and returns printable
HTML. Sales come from `invoices`, purchases from `purchases`.

**The purchase side is a treatment problem, not a data problem** (`utils/purchase.js`). The line
buys one thing — Anthropic API credits — and how it is taxed turns on whether our GSTIN was on the
Anthropic account when the bill was raised:

- `rcm` — GSTIN on file, Anthropic charges 0% ("tax to be paid on reverse charge basis"). We owe
  IGST @18% **in cash** and claim the same back as import-of-services ITC. Net ₹0. **The only
  treatment that reaches GSTR-2 / GSTR-3B.**
- `oidar_charged` — GSTIN absent, so Anthropic charged 18% under its OIDAR registration
  (`9924USA29003OSI`). That tax never lands in our GSTR-2B and is **not claimable** — plain cost.
  Recorded and shown on the Purchase Report, deliberately excluded from the return.
- `domestic` / `refunded` — ordinary Indian supplier; and cancelled bills, kept so their absence
  from the return is explained.

`taxableInr` is the rupees **actually debited** on the statement, never a converted estimate — GST
is a rupee tax and the statement is what reconciles. `config/fxRate` is for COGS analytics, not
for tax. `purchases/{id}` follows the cardinal rule and is stricter than most: operator data, so
`allow read: if false` too — reachable only via the admin callables.

## The fix pipeline (where state lives)

1. `classifyTask` — Haiku call (`utils/classify.js`) returns `{ complexity, reason }`; drives the
   caps + model routing, not a price. We absorb its cost.
2. `createTask` — classifies if no complexity is passed, writes `tasks/{id}`, pulls the org's
   GitHub token from `orgSecrets/{orgId}` (the **vault** — clients have no read access, even via
   rules), starts the Managed Agent session, stores `sessionId`. Balance is **NOT** gated — orgs
   may go negative; the operator reconciles via top-ups / `adminDeductCredits`.
3. Managed Agent (Anthropic-hosted, NOT our infra) clones the repo via the GitHub MCP server,
   fixes, pushes a branch, opens a PR. Beta header `managed-agents-2026-04-01` is required.
4. `pollSessions` (scheduled) reads `session.usage` + runtime, terminates over-cap sessions,
   parses the final result via `utils/agentResult.js`, then `markRoundReady` either auto-charges
   (default) or flips the task to `pendingReview` (requireApproval orgs).
5. `approveFix` (requireApproval orgs) debits the wallet; `reviseSession` runs another round on the
   same task (no child task). `customerDeployTesting` merges the PR into `main` (testing
   deploy); `customerDeployProd` tags `main` (go live).

Task lifecycle: `queued → running → (pendingReview ↔ revising) → complete | failed | needs_quote`.

### Warm vs fresh revisions (a COGS rule, not a UX one)

A revision always produces the same thing — more commits on the SAME branch, updating the SAME PR
— but `reviseSession` picks HOW based on `claudeAgent.js#isSessionWarm`:

- **Warm** (last round closed < `SESSION_WARM_MINUTES` = 4 ago AND fewer than `MAX_WARM_ROUNDS` = 3
  rounds so far) → `continueFixSession` resumes the session, as before.
- **Cold** → `startFixSession` with `buildResumePrompt`: a NEW session that checks out the existing
  branch, gets a short recap of the earlier rounds (~900 tokens), and updates the same PR.

Why: a managed-agent session's prompt cache is ephemeral (~5 min) and its context grows every
round, and every tool call replays that context. Resuming a cold session therefore pays a full
cache re-write plus a growing replay before doing any work — on one real 8-round session that
overhead was ~⅓ of the total COGS, marked up to the owner by the cost-plus price. Going fresh also
makes the price independent of how long the owner took to reply.

**Two invariants when changing this code:**
- Fresh sessions are only safe when the branch is resolvable from `task.prUrl` (`getPrHeadRef`) —
  a fresh clone lands on the DEFAULT branch, so with no branch we MUST fall back to a resume or
  we'd silently drop the earlier rounds' work.
- Swapping `task.sessionId` MUST reset `reviewedCostUsd` and `reviewedSeconds` to 0. `markRoundReady`
  computes the round's COGS as `cumulative session usage − reviewedCostUsd`, and a new session's
  usage restarts at zero — leaving the old baseline makes the subtraction underflow and the round
  bills as free. Prior rounds keep their own deltas in `task.rounds` (which is what `actualCostUsd`
  sums), and `priorSessionIds` retains the sessions the task has moved off for cost forensics.

## The feature pipeline ("Plan a feature")

A bigger ask, broken into a sequence of fix-sized steps that build one at a time. Planning is
**code-aware** and the plan is **reviewed before any building**.

Feature lifecycle: `planning → plan_review → running (step by step) → complete` (`plan_failed` on a
bad plan; refine/redo loop back to `planning`).

1. `planFeature` (customer callable, `handlers/featureTasks.js`) — persists the owner's screenshots
   once (Files API, `claudeAgent.js#uploadImagesToFiles`), fetches the Figma design, and starts a
   **code-aware managed-agent PLANNING session** (`utils/featurePlan.js#startPlanningSession`): it
   clones the repo, reads it (`AGENTS.md` + relevant files), sees the design + screenshots, and emits
   the ordered steps each tagged `kind:'static'|'dynamic'`. This is ASYNC (a real session) — the
   feature is written `status:'planning'`; **nothing is charged or built yet**. The planning session
   is a `tasks/{id}` of `kind:'planning'` so `pollSessions` picks it up.
2. `pollSessions` planning branch — on the planning session finishing, `featurePlan.js#extractPlan`
   parses its `RESULT_JSON`, writes `feature.steps` (`{title, description, kind, status, taskId}`),
   sets `status:'plan_review'`, and charges the breakdown (`priceForPlanning` = 2× the session's real
   COGS, in a transaction). Failed/over-cap planning → `plan_failed`, **never charged**.
3. Owner reviews in the dashboard: **approve** (`approveFeaturePlan` → `running`, start step 0),
   **request changes** (`reviseFeaturePlan {mode:'refine'}` — re-plan with the prior steps + note),
   or **start over** (`{mode:'replace'}` — re-plan a new prompt). Each re-plan is a fresh planning
   session, charged the same way.
4. Each step is an ORDINARY fix task carrying `featureId` + `stepIndex` — same pipeline, but
   charged the flat feature-step price under the per-feature cap (see "Money rules"). `startFeatureStep` carries **Figma + the owner's screenshots
   (by file_id) + Jam** (Jam rides in the embedded `feature.prompt`) into every step. The owner sees
   a clean step title; the agent gets the "step N of M, build on earlier steps" framing.
5. Owner tests → deploys the step to testing (merges to `main`). `deployTaskToTesting` →
   `advanceFeature` marks the step done and starts the next (its agent clones the updated `main`).
   `listMyFeatures` composes the view (proposed steps with `kind` while reviewing; the active step via
   `utils/sessionView.js` while building). `listMySessions` filters out `featureId` tasks.
6. When every step is on testing, one go-live tags `main` and publishes the whole feature.
7. After a feature is `complete`, `addFeatureChange` appends a follow-up change as a NEW step
   (`added:true`, carrying its own `changeText`/screenshots) — same review/approve/charge lifecycle,
   so its cost rolls into the feature total, and `buildAgentPrompt` gives the agent the whole feature
   as context (it's all merged into the repo). This is the in-feature alternative to a standalone fix.

New collection `features/{id}` follows the cardinal rule: owner-read, backend-only writes
(`firestore.rules`). Screenshots persist as Anthropic Files (`feature.screenshotFileIds`) so they
carry into the plan + every step without bloating the doc (Firestore caps at 1 MB).

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
  owner-readable like other non-secret org status fields.

## Property sourcing relay

A separate, near-zero-COGS metered lane — it never touches the fix pipeline or `finalize.js`.
Cron `runSourcingJobs` (`functions/handlers/runSourcingJobs.js`, every 2h around the clock — 12
runs/day, IST-anchored) runs for every org with `sourcing.enabled`:

- **Matrix pull** — orgs with `sourcing.matrixUrl` pull the platform's demand-ranked query matrix
  (HMAC-signed GET, `utils/sourcing.js#fetchQueryMatrix`): `targets` plus a per-intent freshness
  `policy { saleMonths, rentMonths, fallbackMaxLeads }` (defaults 3/1/3 via
  `DEFAULT_SOURCING_POLICY`). Orgs without a matrix run static `cfg.queries` (no classify/policy).
- **Fetch → gates** — Apify Google-SERP fetch, individual-post filter, dedup-forever vs
  `sourcingSeen/{orgId}/keys`, FB-post enrichment (real `postedAt`), hard org-level recency cutoff
  (`freshnessMonths`, the outer bound), then (matrix path only) a Gemini classify gate
  (`utils/classifyListing.js`, fails OPEN → lead relayed as `classifyStatus:'unverified'`).
  Locality-UNKNOWN is not locality-wrong: a genuine listing whose SERP text names NO place (Google
  truncates titles mid-phrase; group-page snippets get lifted from adjacent posts) is detoured
  (`localityNamed:false` → `localityPending`), enriched, and re-classified on the FULL post text
  (pass 3c2) — it only dies on evidence, never on a truncated snippet.
- **Per-intent freshness** — after classify, rent/lease leads older than `rentMonths` and
  sale/unknown-intent leads older than `saleMonths` are dropped (unknown `postedAt` is kept). A
  target left with ZERO fresh leads re-admits up to `fallbackMaxLeads` newest stale ones as
  `freshness:'stale-fallback'`; everything else relays as `'fresh'`.
- **The buyer lane (`mode:'buyer'`)** — a SEPARATE cron (`runBuyerSourcingJobs`, every 2h at :15, so it
  never collides with the supply ticks), opt-in per org via `sourcing.buyerLane`. Same pipeline, three
  differences: `queryGen.js` swaps the intent OR-group to demand phrasing (`wanted OR "looking for" OR
  required …`, translated per-locality), the side gate INVERTS (a `seeking` post is the product; an
  `offering` post drops as `supply-post`, RETRYABLY, so a buyer run can never bury inventory), and the
  lane carries its own budget (`buyerMaxPerRun`, default UNCAPPED) plus its own window
  (`buyerFreshnessMonths`, default = the org window). It always pulls the matrix DRY and rotates
  through the ranking with `sourcing.buyerCursor` — stamping cadence here would make the supply cron
  skip the localities the buyer run just visited. Why it exists: over the 60 runs to 2026-09-01 the
  by-product harvest relayed 9 buyers out of 420 leads, and 90 of the 99 buyer posts it found died on
  recency (59 posted >12 months ago) — a supply query surfaces old high-engagement "looking for a
  2BHK?" threads, not this week's requirement. Lanes are toggled with `adminSetSourcingLanes`.
  **The SERP leg of this cron is RETIRED (2026-09-03)** — it runs only for an org that opts back in
  with `sourcing.buyerSerpLane`. Per relayed buyer lead over the 10 days to 2026-09-03 it cost 135
  SERP results + 4.8 paid FB post scrapes + 32 classify calls, against the GROUP lane's 35 feed items,
  ZERO paid scrapes and 25 classify calls, for the same ~1 lead per leg — ~4× the fetch spend, and the
  only leg still paying the per-post enrichment fee, to buy the staler version of the same lead. The
  hand-fired probe stays ("Source buyers (SERP, retired)" → `adminSourceBuyers` with no `source`) so
  the two sources can be re-compared without paying for the comparison every two hours.
- **The GROUP lane (`sourceBuyerGroups`) — the buyer lane's FRESH source.** The SERP buyer lane above
  topped out at year-old posts, because Google's index of facebook group feeds is 300–700 days stale;
  reading the feeds directly (`utils/sourcing.js#fetchGroupFeed`, actor
  `apify~facebook-groups-scraper` — NOT the posts actor, which answers `no_items` for every feed)
  returns same-day posts. Groups are configured as `sourcing.buyerGroups: [{url, city}]`
  (`adminSetSourcingLanes`; the CITY is the classify target, since a metro group has no single
  locality) and run twice a day on the buyer cron's 08:15/20:15 IST ticks, one leg per city, in
  buyer mode through the ordinary pipeline. The one upstream difference: feed items arrive ALREADY
  FULL (`origin:'group-feed'` — complete text, real date, phone, photos, author), so step 3c1 skips
  the paid per-post enrichment and lifts `author` off the listing (dedup fuel, never forwarded).
  First live pass (2026-09-01, 52 groups / 10 TN cities): 21 buyer leads relayed, 0–19 days old,
  ~95% genuine — versus 9 in 28h from the by-product and 2/run from the SERP buyer lane. Manual
  trigger: "Scan buyer groups now" (`adminSourceBuyers {source:'groups'}`). **Since 2026-09-03 this
  is the buyer cron's only scheduled leg**, so the demand lane's whole cost knob is
  `buyerGroupPostsPerVisit` / the per-group `posts` override.
- **Salvage lanes (opt-in per org)** — the classifier also returns `side` (offering vs seeking).
  With `sourcing.buyerLeads`, a genuine on-target "wanted / looking for" post relays as
  `listing.leadType:'buyer'` (usually phone-less — the value is the post link + request text); with
  `sourcing.offTargetLeads`, a confident genuine listing whose only failure is the locality relays
  as `leadType:'off-target'` carrying its real place in `extracted.locality`. Both flags default OFF
  — the platform webhook must route the tag first. Flag-off buyer posts drop RETRYABLY (never
  buried); off-target rejects stay dead as before. `maxPerRun` is the SUPPLY budget — supply and
  off-target compete for it, buyer draws on `buyerMaxPerRun` (default uncapped) so a full supply cap
  can no longer starve the demand lane. Within the supply budget the lanes still rank supply →
  off-target so salvage never displaces on-target inventory.
- **Repost dedup is per-lane** (`utils/sourcing.js`). Supply keys on `ownerListingKey` (phone + coarse
  price/BHK/type). That returns null for nearly every buyer post — they carry no phone (0/4 in the
  2026-07-17 measurement; buyers say "DM me") — so the buyer lane keys on `buyerRequestKey`: the phone
  if there is one, else the POSTER (`extractAuthor`, best-effort off the scraper item), fingerprinted
  against what they want. Null on either path means "relay it", never a silent drop.
- **Relay & billing** — each lead is HMAC-signed and POSTed to the org webhook; only a 2xx marks
  it seen and debits the org wallet (charge-on-delivery; non-2xx retries next run). Seller/supply
  leads draw the jittered band (₹2.54–₹2.74); BUYER leads bill the flat `SOURCED_BUYER_UNIT_INR`
  (**₹12.40 since 2026-09-03**, owner-set; was ₹5.20 from 2026-09-01) —
  `priceForSourcedBatch(count, {buyerCount})`, one debit per batch, the split recorded on the
  transaction (`buyerCount`) and in `unitPrices`. The buyer unit is a HAND-SET **scarcity** price,
  NOT cost-plus: Bosun's own COGS on a buyer lead is the Gemini classify alone (₹1.82–₹2.42), so
  ₹12.40 is ~5–7× cost against the house 3× rule — what it is priced on is ~12 buyer leads/day
  against ~360 seller listings. **Apify is the customer org's cost, not Bosun's** — the group actor's
  $2.60/1,000 posts (~₹150/day, ~35–50 posts per relayed lead) sets the ORG's all-in economics
  (~₹21–25 per buyer lead with this charge on top) and must never be folded into the unit price.
  Re-price by editing that one constant; nothing else in the lane reads a rate.
- **Operator override** — `adminSourcingRelayLead` relays ONE recorded (dropped) lead by hand from
  the run-detail panel ("Relay & bill"): enrich → same HMAC webhook → mark seen → debit the same
  one-lead unit price. The gates are advice, the human is the backstop — the money rules never bend
  for the override (a webhook reject bills nothing).
- **Audit trail** — `utils/sourcingRun.js` records each run to `sourcingRuns/{runId}`: the per-target
  funnel (matrix targets, the Gemini queries built for each, and every gate from SERP fetch to
  webhook) plus a `leads` subcollection with a row per listing examined — its URL, originating query,
  and which gate dropped it. Backend-only writes, read ONLY via the operator callables
  (`adminSourcingRuns` / `adminSourcingRunDetail` / `adminSourcingLeadLedger`). The recorder is a
  RECORDER, never a gate: every write is best-effort and swallowed, so a failed audit write can never
  fail a run that would have delivered and billed. `expiresAt` carries a 90-day TTL (see `TTL_DAYS`
  for the one-time `gcloud firestore fields ttls update` needed to activate the policy). Counters are
  pinned by `functions/scripts/validate-sourcing-funnel.mjs` — an in-memory Firestore + stubbed
  network drives the real `runForOrg` through every gate (`node scripts/validate-sourcing-funnel.mjs`,
  no Firebase/Apify/network).
- **The three metered lanes.** Sourcing is only one of them: `selfpost_compose` (₹0.25/WhatsApp
  message, `sourcingCompose`) and `autopost_usage` (₹0.50/auto-published listing, `usageMeter`) are
  billed the same wallet. `adminMetrics` returns all three as `lanes` + `propertyTotal`; the sub-rupee
  ones accrue in paise on the org, so some earned revenue is always still held as `pendingAccrualInr`
  rather than debited.

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

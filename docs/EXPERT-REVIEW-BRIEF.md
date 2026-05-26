# Bosun — Architecture, Billing & Revenue Brief (for expert review)

> Purpose: a self-contained description of how the product is built and how it makes money,
> so an outside expert can review and recommend improvements. **This brief is written from the
> actual code, not the README** — where the two disagree, the discrepancy is flagged in
> §7 "Implementation gaps." Please read §7 before forming conclusions.

---

## 1. What the product is

**Bosun** is a pay-as-you-go SaaS for **non-technical small-business owners in India** to fix
problems on their existing website using an AI agent.

User flow: *Describe what's broken (plain English, optional screenshots) → AI agent edits the
site's code and opens a pull request → user previews the fix → user can request further changes →
the fix is deployed.* The user is charged **only on success**, in rupees, from a prepaid wallet.

UI language rule (strict, enforced by convention): never expose technical words to the user
(no "prompt", "token", "agent", "API", "deploy", "repository", "CSS", etc.). Everything is phrased
as "What's broken", "Fix is ready", "What we changed", "Working on it".

---

## 2. Tech stack & high-level architecture

| Layer | Technology |
|---|---|
| Frontend | Vite + React SPA, Tailwind, React Router |
| Hosting | Firebase Hosting (static SPA) |
| Backend | Firebase Cloud Functions (2nd gen, Node 22, ESM), region `asia-south1` |
| Data | Cloud Firestore |
| Auth | Firebase Auth (Google + Email/Password) |
| AI execution | **Anthropic Claude "Managed Agents"** (beta) — the agent runs in Anthropic's managed cloud; Bosun runs **no execution infrastructure of its own** |
| Code access | A **GitHub App** mints short-lived installation tokens; the agent edits the repo via a GitHub MCP server and opens/updates a PR |
| Payments (intended) | Razorpay — **see §7, not actually wired on the backend** |

### Request / data flow

```
Browser (SPA)
  │
  │ 1. classifyTask(prompt)         ── cheap Haiku call → complexity + INR estimate (shown, non-binding)
  │ 2. createTask(prompt, images)   ── validates wallet + connected repo, creates task doc,
  │                                     starts a Managed Agent session (Opus or Sonnet)
  │
  │ (agent works in Anthropic cloud: edits repo on a branch, opens a PR)
  │
  │ listMySessions()  ── polled every ~4s; returns SAFE fields only (no PR link/model/raw cost)
  │
  ▼
pollSessions (scheduled, every 1 min)
  │  • reads the session's cumulative USD cost from the Anthropic API
  │  • if this round's spend exceeds the budget cap → cancel session, bill nothing
  │  • on success → billTaskSuccess(): atomic + idempotent charge to the org wallet
  │  • also polls GitHub for the Vercel preview URL of the PR
  │
  ▼
reviseSession(taskId, changes)  ── "Request changes": re-opens the SAME agent session,
                                    same branch/PR; cost accrues; poller bills the increment
```

The agent emits a machine-readable `RESULT_JSON` line at the end of its reply
(`{summary, filesChanged[], prUrl}`) which the backend parses; the user never sees it.

---

## 3. Data model (Firestore)

| Collection | Key fields | Notes |
|---|---|---|
| `users/{uid}` | `email, role, orgId` | Credits do **not** live here. New users start with `orgId: null`. |
| `organisations/{orgId}` | `name, balance` (INR), `github.repoFullName` | **The wallet lives at the org level.** Multiple users can share one org. |
| `orgSecrets/{orgId}` | `githubToken` | Backend-only; never readable by clients. |
| `tasks/{taskId}` | `prompt, kind, status, model, sessionId, billed, billedCostUsd, actualCostUsd, finalCharge, lastRoundCharge, round, revisePrompt, rounds[], prUrl, previewUrl` | One doc per fix; revisions accrue on the same doc. `rounds[]` is the per-iteration thread (prompt + summary + per-round charge). |
| `transactions/{id}` | `orgId, type(credit\|debit), amount, taskId, kind, by` | Append-only ledger. |
| `sites/{uid}` | connected repo | One site per user in v1. |

All money-bearing writes happen **only** via the Cloud Functions Admin SDK (which bypasses
security rules). Clients can read their own data but can never write balances, tasks, or
transactions. (See §6.)

---

## 4. Billing model (canonical logic in `shared/billing.js`)

### Core charge formula (per completed round)
```
actual_cost_inr = actual_cost_usd × rate          (rate is backend-authoritative, env USD_TO_INR, default 83)
raw_charge      = actual_cost_inr × 2.5            (MARKUP_MULTIPLIER)
final_charge    = ceil(raw_charge)                 (round UP to whole rupees, favours business)
final_charge    = max(final_charge, 75)            (₹75 floor — see revision exception below)
```
- **Markup multiplier: 2.5×** (framed internally as "2× base cost + 25% margin").
- **Minimum charge: ₹75** per chargeable round.
- **Failed tasks are never charged** — including sessions killed for going over budget (the business eats that cost).

### How `actual_cost_usd` is computed (`agentResult.js`)
There is **no cost field** returned by the Managed Agents API, so Bosun computes it:
```
token_cost   = input·P_in + output·P_out + cache_read·P_cr + cache_write_5m·P_cw5 + cache_write_1h·P_cw1   (per-MTok prices from env)
runtime_cost = active_seconds / 3600 × SESSION_HOUR_USD     (default $0.08 / session-hour)
actual_cost_usd = token_cost + runtime_cost
```
Token prices are env-configured (`PRICE_*_PER_MTOK`) and must be kept in sync with Anthropic's
published pricing by hand.

### Complexity tiers (`COMPLEXITY_TIERS`)
A cheap Haiku classifier labels each request `simple | medium | complex`. Each tier defines a
hard budget cap and the friendly INR range shown to the user:

| Tier | Budget cap (USD) | True max charge | Range shown to user |
|---|---|---|---|
| simple | $0.45 | ₹94 | ₹75–₹150 |
| medium | $1.50 | ₹312 | ₹150–₹375 |
| complex | $3.00 | ₹623 | ₹300–₹650 |

The cap is chosen so the true maximum chargeable is always ≤ the top of the shown range
("we never charge more than the maximum shown").

### Budget enforcement
Managed Agents have **no native `max_budget` knob**. Instead, the scheduled poller reads the
session's accrued cost every minute and **cancels** the session if *this round's* spend exceeds
the cap. So overruns are bounded by the 1-minute polling granularity (a session can overspend
by up to ~1 minute of work before it's killed; that overage is absorbed, not billed).

### Revision policy ("Request changes")
A round carries a `kind`:
- `initial` — first attempt at a problem → **₹75 floor applies**
- `new_scope` — a new/expanded request → **₹75 floor applies**
- `unresolved` — we fell short, re-fixing our own miss → charged at actual × 2.5 but **no ₹75 floor**

Billing is **incremental**: the Anthropic session reports *cumulative* cost across rounds, so each
round is billed for `cumulative − already_billed`. `finalCharge` accumulates; the UI shows a
per-round cost thread plus a cumulative "Total charged".

---

## 5. Revenue model

- **Gross take per fix = actual Anthropic cost × 2.5, min ₹75.** The 2.5× is the entire margin
  mechanism. At the ₹75 floor on a cheap fix, the effective markup is much higher than 2.5×.
- **Cost of goods = Anthropic token + runtime cost only.** No self-hosted compute (agent runs in
  Anthropic's cloud), so COGS ≈ the Anthropic bill. Hosting/Firestore/Functions are near-zero at
  low volume.
- **Absorbed (un-billed) costs:** the Haiku classifier call (~₹0.50/request), the Haiku model-router
  call, any over-budget session that gets killed, and any `unresolved` re-fix's ₹75 floor waiver.
- **Wallet model:** prepaid credits held at the **organisation** level (INR). A fix only starts if
  the wallet holds the tier's true-max charge, so work is never run that can't be billed.
- **Intended top-up packages** (frontend `TopUp.jsx`): ₹500 ("~6 fixes"), ₹1,000 ("~13 fixes",
  marked popular), ₹2,000 ("~26 fixes"). *(These "fixes" counts assume ~₹75/fix.)*
- **Low-balance nudge** at < ₹200.

---

## 6. Security model

- Firestore rules **deny all client writes** to `users`, `organisations`, `tasks`, `transactions`,
  `sites`, `orgSecrets`. Every money-bearing mutation goes through Cloud Functions (Admin SDK).
- Reads are scoped: a user reads only their own `users`/`sites`/`tasks`; org + transactions are
  scoped by an `orgId` **custom claim** the operator sets when assigning a user to an org.
- The customer UI reads fixes via the `listMySessions` callable, which **whitelists** safe fields
  — it never returns the PR URL, the model used, or the raw USD cost/margin.
- The GitHub token is operator-provisioned, stored in backend-only `orgSecrets`, and used to mint
  short-lived installation tokens — **the user never handles a token**.
- Admin callables are gated by an `ADMIN_EMAILS` allowlist (server-side).
- Billing is **atomic + idempotent** (Firestore transaction guarded by a `billed` flag), so a
  retry or duplicate poll can't double-charge.

---

## 7. Implementation gaps (README claims vs. actual code) — READ THIS

These are places where the documentation/UI promises something the deployed code does **not** do.
They matter for any revenue/financial review:

1. **Self-serve payments (Razorpay) are NOT wired.** `TopUp.jsx` calls a `createRazorpayOrder`
   callable and the README claims a "Razorpay order + webhook," but **no such Cloud Function
   exists** (`functions/index.js` exports none; there is no webhook handler). Today the **only**
   way credit enters a wallet is the operator manually calling `adminAddCredits`. The product is
   effectively **invite-only / operator-funded**, not self-serve.

2. **The "₹75 free signup credit" does not exist in code.** README says new users get ₹75 free.
   `ensureUser` creates a user with `orgId: null` and **no credit**; the operator must create an
   org and seed its balance. A brand-new user cannot run anything until an operator acts.

3. **Estimate vs. run-time budget drift.** Three different budget numbers coexist:
   - `classifyTask` shows tiered estimates (caps $0.45 / $1.50 / $3.00).
   - `createTask` **ignores the tier** and uses a flat `AGENT_MAX_BUDGET_USD` env (default **$3**,
     i.e. always the "complex" cap) — so the cap actually enforced may not match the estimate shown.
   - The README quotes yet another range ("₹75–₹187" from a $0.90 cap).
   The "we never charge more than the maximum shown" guarantee can break if the shown estimate was
   `simple`/`medium` but the run uses the flat $3 cap.

4. **Every revision is billed as `unresolved` (no floor).** `reviseSession` hard-codes
   `kind: 'unresolved'`, even though the policy distinguishes `new_scope` (which *should* keep the
   ₹75 floor). So **all** change-requests waive the floor and are charged pure actual × 2.5 —
   including genuinely new scope. This is a revenue leak vs. the stated policy.

5. **Token prices are manual env values.** `PRICE_*_PER_MTOK` must be hand-updated to match
   Anthropic pricing; if stale, every charge is silently wrong. (Also note `.env.example` lists a
   single `PRICE_CACHE_PER_MTOK` while the code reads `PRICE_CACHE_READ/WRITE_5M/WRITE_1H` — naming
   mismatch.)

6. **Cost is estimated, not authoritative.** Because the Managed Agents API returns no cost,
   billing depends on Bosun's own token×price + runtime formula. Any drift between this formula and
   Anthropic's actual invoice is unrecovered margin error (in either direction).

---

## 8. Questions I'd like the expert to weigh in on

1. **Pricing structure:** Is a flat 2.5× markup on a volatile, hard-to-predict COGS (LLM tokens)
   the right model for non-technical Indian SMB buyers, or should this be fixed-price-per-tier
   (predictable to the buyer, margin risk on us) or subscription/credit-bundle? What's the
   psychological price ceiling for "fix my website" in this segment?

2. **Margin safety:** With COGS = a self-computed estimate of the Anthropic bill and a 1-minute
   polling kill-switch, how exposed are we to cost overruns or mis-estimation? What guardrails
   would you add before enabling self-serve?

3. **The floor + revision policy:** Is waiving the ₹75 floor on *all* revisions (gap #4) sound, or
   does it invite abuse (endless cheap "change requests")? How should re-fixes be priced fairly?

4. **Go-to-market readiness:** Given payments and free-credit aren't wired (gaps #1, #2), is the
   right next step to (a) finish self-serve Razorpay + onboarding credit, or (b) stay
   operator-funded/concierge while validating willingness-to-pay?

5. **Unit economics:** At ₹75 floor with bundles sold as "~₹75/fix," are we underpricing simple
   fixes (where true cost is cents) and overexposed on complex ones? What target gross margin %
   should we design the tiers around?

6. **Trust & refunds:** There's no refund/dispute path and the user can't see what they're paying
   for until after. What billing-transparency or satisfaction-guarantee would you recommend for
   this trust-sensitive, non-technical audience?
```

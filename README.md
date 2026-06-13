# Bosun

A SaaS for non-technical small business owners in India to fix website problems with AI.
Describe what's broken → AI fixes it → download the fixed files. Pay-as-you-go from ₹75.

## How billing works (single source of truth: `shared/billing.js`)

```
actual_cost_inr = actual_cost_usd × rate          (rate is backend-authoritative)
final_charge    = max( ceil(actual_cost_inr × 2.5), 75 )   // whole rupees, min ₹75
```

- The markup multiplier is **2.5×** (2× base + an extra 25% margin).
- The user is charged **only on success**, in an **atomic + idempotent** Firestore transaction.
- The displayed estimate (₹75–₹187) is derived from the agent's hard budget cap
  (`AGENT_MAX_BUDGET_USD=0.90` → max charge ₹187) so the quote can never drift from reality.
- New users get **₹75 free credit** on signup (one minimum fix).

## Architecture

```
Browser (Vite SPA)
  │  createTask (callable)            ┌───────────── Firebase ─────────────┐
  ├──────────────────────────────────▶ createTask: check balance, queue,  │
  │                                   │             dispatch to runner      │
  │  live status (Firestore onSnapshot)                                     │
  │◀──────────────────────────────────┐                                    │
  │                                   │ completeTask (token-authed):        │
  │                                   │   atomic + idempotent billing       │
  └─ Razorpay Checkout ──▶ webhook ───▶ credit wallet (idempotent)          │
                                       └─────────────────────────────────────┘
                                                  ▲ result + actual cost
   Managed environment (EC2 / sandbox) ───────────┘
   runs the Claude Agent SDK on the user's uploaded files with a hard budget cap.
   (Reuses the Bosun `runner/` + `provision/` engine.)
```

## Project layout

| Path | Purpose |
|---|---|
| `shared/` | Canonical billing + currency logic. Imported by web **and** functions. |
| `src/` | Vite + React app (pages, components, hooks, firebase clients). |
| `functions/` | Firebase Cloud Functions (auth trigger, callables, webhook, billing). |
| `scripts/sync-shared.sh` | Copies `shared/` into `functions/shared/` (predeploy + pre-emulate). |

## Plan a feature (task type beside the fix pipeline)

A second customer flow that does **not** touch GitHub or the managed agent. At `/plan` the
owner describes a feature in plain language; a cheap model breaks it into individual tasks
(title + description + acceptance criteria), which they review/edit. On "Send to my board" the
tasks are published as cards to the org's connected Trello board, and the org wallet is billed a
single flat price (`PLAN_PRICE_INR`, in `shared/billing.js`).

- **Preview is free** (`planFeature`) — the decompose cost is absorbed, exactly like `classifyTask`.
- **Publish charges once** (`publishPlan`) — atomic + idempotent (a client-supplied `planId` is
  the task doc id, so a retry never duplicates cards or double-charges). The charge lands only on
  a successful publish; if the board writes fail, nothing is charged.
- **Board credentials** (Trello key + token + target board/list) live in `orgSecrets/{orgId}.trello`
  (the vault — client-unreadable). An operator connects them from the Admin panel; a non-secret
  `connected` status is mirrored onto the org doc so `/plan` can tell the board is ready.
- Plan tasks (`type: 'plan'`) share the `tasks` collection but are filtered out of the fix
  dashboard (`listMySessions`).

## Setup

1. **Firebase project** — create one, then in the console enable:
   - Authentication → **Google** + **Email/Password**
   - **Firestore**, **Storage**, **Functions** (Functions needs the **Blaze** plan)
2. **Frontend env** — `cp .env.example .env.local` and fill the `VITE_*` values from
   Firebase console → Project settings → Web app, plus your `VITE_RAZORPAY_KEY_ID`.
3. **Functions env** — `cp functions/.env.example functions/.env` and fill
   `ANTHROPIC_API_KEY`, `RAZORPAY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, the runner URL/token.
4. **Set the project id** — replace `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID` in `.firebaserc`.
5. **Install** — `npm install` (root) and `cd functions && npm install`.
6. **Run** — `npm run dev` (web) and `cd functions && npm run serve` (emulator).
7. **Deploy** — `npm run build && firebase deploy` (hosting + functions + rules).
8. **Razorpay webhook** — point it at the deployed `razorpayWebhook` URL, event
   `payment.captured`, secret = `RAZORPAY_WEBHOOK_SECRET`.

## UI language rules (strict)

Never show technical words (prompt, token, agent, API, deploy, diff, repository, CSS, …).
Use friendly phrasing: "What's broken", "Fix is ready", "What we changed", "Working on it".

## Status

- ✅ Foundation, Firebase wiring, shared billing logic, security rules
- ✅ Cloud Functions: signup credit, createTask, completeTask (billing), Razorpay order + webhook
- ⏳ Pages: Landing, Auth, Dashboard, Confirm, Running, Result, History, TopUp
- ⏳ Components: Navbar, BalanceBadge, TaskCard, LowBalanceWarner
- ⏳ Managed runner integration (the file-fix mechanic — see note below)

> **Open product decision:** how the user's website files reach the fixer. Current
> assumption is **ZIP upload → fixed ZIP download**. GitHub/FTP connectors are future.

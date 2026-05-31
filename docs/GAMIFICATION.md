# Gamification & Progress — Design

A per-organisation progress system (points, levels, streaks, badges) that rewards
**healthy outcomes**, not spend. This is a design doc — nothing here is built yet.

Decisions locked in for v1:

- **Reward basis:** healthy outcomes (fixes that go live, stay fixed, steady return usage) — not raw spend.
- **Shape:** single-player progression first (works for one-person orgs). Anonymized cross-org board is a later phase.
- **Status:** design only. v1 implementation is sketched in §6.

---

## 1. Why outcomes, not spend

Bosun charges real money per fix (₹149–749) and the customer is a non-technical small-business
owner. A system that rewards *spending* nudges anxious owners to manufacture problems and pay for
fixes they don't need — a dark pattern that works for a quarter, then collapses trust and churns
the customer (and poisons word-of-mouth, the cheapest channel in this segment).

So points reward the things that are good for the customer *and* for us:

- A problem fixed that **stayed fixed** (no immediate revision).
- The fix actually **went live** (deployed, not rotting in a PR).
- **Coming back** when something genuinely breaks (habit, not bingeing).
- **Bringing other owners in** (referrals).

Behaviourally this leans on *competence* and *progress* (durable motivators) rather than
loss-chasing (a short-lived one). It is also the lower-churn business choice.

> **Money rule unaffected.** Points are not currency, never convert to balance, and never alter a
> charge. The canonical billing math in `shared/billing.js` is untouched. Points are a read-only
> motivational layer on top of outcomes that already happened.

---

## 2. The org/user reality (and what "leaderboard per org" means)

A user is scoped to **one** org via the `orgId` custom claim, and an org is **one** small business
with **one** repo. That makes a naive "leaderboard" ambiguous:

| Shape | Works when | Risk |
|---|---|---|
| **Single-player progression** (levels/streaks/badges per org) | always — even a one-person org | none; this is the v1 spine |
| **Anonymized cross-org percentile** ("top 15% of healthy sites") | enough orgs for ranks to mean something | privacy — must be anonymized + opt-in |
| Within-org user-vs-user board | org has multiple team members | empty board for solo orgs |

**v1 = single-player progression only.** The cross-org percentile is phase 2 (§7); the within-org
board is out of scope until multi-user orgs are common.

---

## 3. The points formula

Points are awarded **only on server-confirmed good outcomes**, never on task *creation* — otherwise
the board can be farmed by spamming trivial requests. The natural hook is the existing Firestore
transaction in `functions/utils/finalize.js` that already writes the debit and updates
`org.balance`, so points become as atomic and tamper-proof as money.

| Event | Fires in | Points | Rationale |
|---|---|---|---|
| Fix approved / auto-charged | `chargeApprovedFix` / auto-charge path | `simple 10 / medium 25 / complex 50` | tier-weighted by `complexity` so effort scales |
| **First-try bonus** | round closes with `freeRevisionsUsed === 0` | +50% of the row above | rewards a clean win; already tracked |
| Fix went live | `deployedProd` flips `true` | +15 | the outcome that matters to the business |
| Weekly active streak | a fix completes within 7d of the last | +5 × streak weeks (cap +50) | habit loop; cap kills spend-maxing |
| Referral converts | a new org is credited via referral | +200 | cheapest growth channel for this segment |
| **Clear brief + efficient fix** | round closes, see §3.1 | +20 | the brief was clear *and* the fix was first-try + under budget |
| Failed run | `markRoundFailure` | **0** | we never charge failures — never penalise them |

Two deliberate statistical choices:

1. **Diminishing returns on volume.** Streak points are capped and there is *no* points-per-rupee
   term, so the score-optimal strategy is steady real usage, not bingeing. This is the structural
   guardrail against the dark pattern in §1.
2. **Tier-weighting, not flat counts.** A flat "fixes done" count would reward many cheap requests;
   weighting by `complexity` keeps the score honest about effort.

### 3.1 Brief quality — the efficiency loop

A clear, specific problem description leads to a first-try fix with fewer tokens burned → lower
COGS → better margin. So we reward **good briefs**, which makes the customer's game-incentive point
the same direction as our unit economics. This is the one gamification lever that *also* lowers cost.

**Reward the best brief, not the biggest.** Score on specificity and outcome efficiency, never
length — otherwise we'd just train people to pad their descriptions. The bonus fires only when both
hold:

- the brief scored well (`briefScore >= threshold`, see below), **and**
- the fix was efficient — first-try (`freeRevisionsUsed === 0`) and comfortably under the tier's
  `maxBudgetUsd` (`actualCostUsd < efficiencyFraction × maxBudgetUsd`).

**The score is nearly free, because the agent already produces the signal.** Every result already
carries `idealDescription` and `idealKeywords` (the gap between what the customer wrote and the
ideal brief). The same agent output that emits the *tip for next time* emits a `briefScore` (0–100)
— "same agent can give this as well." A cheap proxy if we don't want a new field: small/empty
`idealKeywords` ⇒ the brief was already clear ⇒ high score.

**The coaching loop closes itself.** We already show the customer their tip ("next time, mention
…"). Tie it to the score and a badge, and: clear brief → bonus + cheaper for us → tip nudges the
*next* brief higher → compounding. Plain-language only: "Great description — that helped us fix it
first time. ✨ Next time, mentioning *the page it's on* makes it even faster."

> The score is advisory for points and coaching only. It **never** gates whether a fix runs, never
> changes price, and a low score is never penalised — only a high one is rewarded.

All constants live next to the billing constants conceptually but in their own module
(`shared/gamification.js`) so tuning them never risks touching money math.

---

## 4. Levels & badges

**Levels** come from cumulative points on a gently superlinear curve — early levels arrive fast
(onboarding momentum), later ones feel earned. Draft thresholds (tune later):

| Level | Name | Cumulative points |
|---|---|---|
| 1 | Sprout | 0 |
| 2 | Steady | 75 |
| 3 | Trusted | 200 |
| 4 | Pro | 450 |
| 5 | Champion | 900 |

**Badges** are milestone identity markers (psychologically stronger than raw numbers, and they map
cleanly onto the plain-language UI rules):

- **First fix live** — `deployedProd` true for the first time.
- **Steady Hands** — 3 clean (first-try) fixes in a row.
- **Always On** — site healthy 90 days (a window with no failed deploy).
- **Good Neighbour** — referred a business that joined.
- **Clear Brief** — 3 clear-brief + efficient fixes (§3.1); celebrates good descriptions, the habit that's cheapest for us.

Badges, level and counters are denormalized onto the org doc (§5) — never recomputed by scanning
all tasks on read (that pattern is fine for the operator's `adminMetrics`, but won't scale to a
live customer-facing card).

---

## 5. Data model

Add one map to `organisations/{orgId}` — no new collection needed for v1:

```jsonc
orgStats: {
  points: 0,            // cumulative lifetime points
  level: 1,             // derived from points, stored for cheap reads
  streakWeeks: 0,       // consecutive active weeks
  cleanStreak: 0,       // consecutive first-try fixes (for Steady Hands)
  fixesLive: 0,         // count of fixes deployed to prod
  lastFixAt: Timestamp, // for streak math
  clearBriefs: 0,       // count of clear-brief + efficient fixes (§3.1)
  briefStreak: 0,       // consecutive clear briefs (for Clear Brief badge)
  badges: ["first_live"], // unlocked badge ids
  optInLeaderboard: false // §7 cross-org opt-in
}
```

Per-round, the agent result also carries a `briefScore` (0–100), stored on the task/round next to
the existing `idealDescription` / `idealKeywords` — it drives the §3.1 bonus and the coaching copy.
The score lives on the task, not `orgStats`; only the derived counters above roll up to the org.

```jsonc
// added to each tasks/{id}.rounds[] entry (alongside idealDescription, idealKeywords)
briefScore: 82           // 0–100; emitted by the same agent output that produces the tip
```

**Rules:** the org doc is already `allow read: if request.auth.token.orgId == orgId;
allow write: if false;` — so customers can read their own stats and can never forge them. No rule
change needed; `orgStats` inherits the org doc's read gate. ✅

**Writes:** updated inside the *existing* `db.runTransaction()` in `finalize.js`, gated on the same
`billed`/`charged` flags that already make billing idempotent — so a re-run can't double-count
points.

---

## 6. v1 implementation sketch (smallest motivating slice)

Ship the single-player core; skip the cross-org board (riskiest + weakest at low org count).

1. **`shared/gamification.js`** — points table, level thresholds, badge rules, and pure functions
   (`pointsForOutcome`, `levelForPoints`, `nextBadge`). Synced to `functions/shared/` by the
   existing `sync-shared.sh` predeploy hook. No money logic.
2. **Agent result → `briefScore`** — extend the result parser (`functions/utils/agentResult.js`)
   to read a `briefScore` the agent emits *alongside* the tip it already produces
   (`idealDescription` / `idealKeywords`). No extra model call: it rides the same output. Fallback
   proxy if we skip the new field: score from how sparse `idealKeywords` is.
3. **`functions/utils/finalize.js`** — inside the existing transaction, after the debit/balance
   write, fold in the `orgStats` update (points, streaks, level, badge unlocks), including the
   §3.1 clear-brief + efficient-fix bonus computed from `briefScore`, `freeRevisionsUsed`, and
   `actualCostUsd` vs the tier `maxBudgetUsd`.
4. **`deployedProd` hook** — wherever the prod-deploy flag flips, add the +15 and `fixesLive`/badge
   update (same atomic-write discipline).
5. **`src/hooks/useOrgStats.js`** — mirrors `useOrg`; live `onSnapshot` on the org doc, returns the
   `orgStats` map.
6. **`src/components/ProgressCard.jsx`** — Dashboard card: level + name, points, current streak,
   "1 more clean fix to earn *Steady Hands*", and a tasteful celebration when a fix goes live or a
   badge unlocks. Surface the brief tip + score on the result view ("Great description — that helped
   us fix it first time ✨").

**UI language (strict).** No technical words. "Level 3 · Trusted", "2-week streak — keep it going",
"Site healthy 90 days" — never "deploy", "PR", "repo", "agent".

**No test runner exists** — the gates are `vite build` (frontend) and the functions emulator. The
pure functions in `shared/gamification.js` are written to be trivially eyeballable.

---

## 7. Phase 2 — anonymized cross-org percentile

Only worth doing once there are enough orgs for a rank to be meaningful, and only **opt-in**
(`orgStats.optInLeaderboard`) and **anonymized** (no names, no activity detail).

- A scheduled function (alongside `pollSessions`) computes rank buckets across opted-in orgs and
  writes a single public `leaderboard/current` doc holding **only** anonymized buckets/thresholds —
  never org identities.
- A customer callable returns the caller's own percentile ("top 15% of businesses keeping their
  site healthy"). This delivers the social-comparison kick with zero data leakage.

---

## 8. Open questions for later

- Exact point constants and level curve — needs real usage data to calibrate; the §3/§4 numbers are
  starting points.
- Whether referral attribution exists yet (the +200 row assumes a referral signal we may not track).
- Reset policy: are streaks purely lifetime, or do we show a "this season" view to re-engage lapsed
  orgs?

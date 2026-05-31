# Gamification & Progress — Design

A per-organisation progress system (points, levels, streaks, badges) that rewards
**healthy outcomes**, not spend. This is a design doc — nothing here is built yet.

Decisions locked in for v1:

- **Reward basis:** healthy outcomes (fixes that ship to testing, stay fixed, clear briefs) — not raw spend.
- **Shape:** a **board between the employees of one org**. This org has 3 people using Bosun; the
  board ranks *them* against each other. (Single-player progression and the anonymized cross-org
  board become later phases — see §7.)
- **"Shipped" = reached testing.** A fix that lands in the testing environment counts as a win;
  going to prod is a separate, gated step we don't require for points.
- **Status:** design only. v1 implementation is sketched in §6.

---

## 1. The goal is revenue — here's the math that gets there

The point of this feature is to **grow revenue**. Revenue ≈
**active employees × fixes per employee × price × how long they stay**. A board can push every term,
but the terms differ wildly in value and risk:

| Mechanic | Revenue lever | Risk |
|---|---|---|
| **Employee board** (rank the org's users) | **Seat activation** — pulls the employees who *aren't* raising fixes yet into using it. Same org, same wallet, more usage. Biggest near-term win. | Low |
| **Streaks + weekly board** | **Frequency** — turns "fix it when I remember" into a habit; more genuine problems get fixed. | Low |
| **First-try + clear briefs (§3.1)** | **Retention + margin** — better experience keeps them paying (retention dominates LTV); clear briefs cut COGS so each rupee earned is worth more. | Low |
| **"Site health" nudges** (surface *real* issues) | **Expansion** — legitimately more fixes. | Medium — only if issues are real, never invented |
| ~~Direct spend nudges~~ ("₹500 to reach next level") | One-time ARPU bump | **High — net-negative** |

Why we **don't** reward spend directly: Bosun's customers are price-sensitive, non-technical SMBs in
India where word-of-mouth *is* the funnel. A spend-nudge produces a one-time ARPU bump that **decays**,
followed by churn, refunds, and reputational damage. Frequency + retention instead **compound** —
each activated, retained seat keeps paying. So the revenue-maximizing move and the trust-preserving
move are the **same** move here; this design optimizes the levers that compound.

Concretely, points reward: a problem **fixed that stayed fixed**, a fix that **shipped to testing**,
a **clear brief** that let us fix it first time, and **coming back** when something genuinely breaks.

> **Money rule unaffected.** Points are not currency, never convert to balance, and never alter a
> charge. The canonical billing math in `shared/billing.js` is untouched. Points are a read-only
> motivational layer on top of outcomes that already happened — the revenue comes from *more real
> usage by more seats*, not from inflating any single charge.

---

## 2. The shape: a board between employees of one org

Several users can share an org (they all carry the same `orgId` claim). This org has **3 employees**
using Bosun, and the goal is to rank *them* against each other. So v1 is a **within-org employee
leaderboard**, and it's a good fit because:

- **Attribution is already there.** Every task carries a `userId`, so each fix already belongs to a
  specific employee — no new tracking needed, just a per-user roll-up.
- **Social comparison works at this size *without* anonymization** — three coworkers who know each
  other. The privacy problem that blocks a cross-org board doesn't exist inside one team.

| Shape | Works when | Status |
|---|---|---|
| **Within-org employee board** (rank the org's users) | org has ≥2 active users | **v1 — this doc** |
| Single-player progression (levels/streaks for a solo user) | one-person orgs | falls out for free — a solo user just sees their own row |
| Anonymized cross-org percentile | many orgs, opt-in | phase 2 (§7) |

### 2.1 Designing for a *small* board (the 3-person trap)

A 3-person leaderboard has a known failure mode: the person who's structurally 3rd disengages, and
a permanent ranking demotivates more than it motivates. Mitigations are part of v1, not afterthoughts:

- **Multiple boards, not one.** Rank on several axes — *most fixes shipped*, *best briefs*, *longest
  streak* — so different people can lead different boards. Almost everyone is #1 at *something*.
- **A rolling "this week" board** alongside the all-time one, so the standing resets and is always
  winnable — last week's 3rd can win this week. Lifetime points still accrue for the level/badges.
- **Personal progress is always shown** next to the rank, so a lower-ranked employee still sees
  their own streak and badges climbing. The board motivates; progress reassures.

---

## 3. The points formula

Points are awarded **only on server-confirmed good outcomes**, never on task *creation* — otherwise
the board can be farmed by spamming trivial requests. Each award is **credited to the task's
`userId`** (the employee who raised it), which is what drives the board. The natural hook is the
existing Firestore transaction in `functions/utils/finalize.js` that already writes the debit and
updates `org.balance`, so points become as atomic and tamper-proof as money.

| Event | Fires in | Points | Rationale |
|---|---|---|---|
| Fix approved / auto-charged | `chargeApprovedFix` / auto-charge path | `simple 10 / medium 25 / complex 50` | tier-weighted by `complexity` so effort scales |
| **First-try bonus** | round closes with `freeRevisionsUsed === 0` | +50% of the row above | rewards a clean win; already tracked |
| Fix shipped to testing | `deployedTesting` flips `true` | +15 | the delivery milestone that matters — prod is a separate gated step we don't require |
| Weekly active streak | a fix completes within 7d of the last | +5 × streak weeks (cap +50) | habit loop; cap kills spend-maxing |
| **Clear brief + efficient fix** | round closes, see §3.1 | +20 | the brief was clear *and* the fix was first-try + under budget |
| Failed run | `markRoundFailure` | **0** | we never charge failures — never penalise them |

> Prod deploy (`deployedProd`) can carry a small extra bonus later if you want, but it's **not**
> required to "count" — shipping to testing is the win for the employee doing the work.

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

**What lifts the score (the specificity rubric).** Concrete, checkable signals that remove ambiguity
about *what* and *where* — because the less the agent has to guess, the fewer tokens it burns and
the more likely a first-try fix. Headline signals, strongest first:

| Signal | Why it helps | How we detect it |
|---|---|---|
| **Page URL of the broken page** | pinpoints *where* — agent doesn't crawl the site hunting | regex for a link in the `prompt` (deterministic, free) |
| **Screenshot attached** | shows the symptom exactly | `imageCount > 0` (already tracked) |
| Names the exact page/section ("the checkout page") | narrows scope | agent's semantic read |
| Expected vs actual ("button does nothing when tapped") | states the bug, not just "it's broken" | agent's semantic read |

So `briefScore` is best as a **hybrid**: a free deterministic component (URL present? screenshot
present?) plus the agent's semantic judgement of clarity. The deterministic part is hard to fake
*usefully* — a real link genuinely helps, and the bonus only pays out when paired with an efficient
outcome (below), so pasting a junk URL earns nothing.

**The semantic half is nearly free, because the agent already produces it.** Every result already
carries `idealDescription` and `idealKeywords` (the gap between what the customer wrote and the
ideal brief). The same agent output that emits the *tip for next time* emits the semantic
`briefScore` component — "same agent can give this as well." Cheap fallback if we skip the new
field entirely: small/empty `idealKeywords` ⇒ the brief was already clear ⇒ high score.

**The coaching loop closes itself.** We already show the customer their tip ("next time, mention
…"). Tie it to the score and a badge, and: clear brief → bonus + cheaper for us → tip nudges the
*next* brief higher → compounding. The single most actionable nudge is asking for the link:
"Great description — that helped us fix it first time. ✨ Tip: next time, paste the link to the page
that's broken and we'll be even faster." (And when they *do* include a URL, the card acknowledges
it: "Nice — the link made this quick.")

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

- **First Ship** — first fix to reach testing (`deployedTesting`).
- **Steady Hands** — 3 clean (first-try) fixes in a row.
- **Clear Brief** — 3 clear-brief + efficient fixes (§3.1); celebrates good descriptions, the habit that's cheapest for us.
- **On a Roll** — a 4-week active streak.

Badges are **per employee** (their own identity markers), so a lower-ranked teammate still collects
them — this is the "personal progress reassures" half of §2.1.

Badges, level and counters are denormalized onto the org doc (§5) — never recomputed by scanning
all tasks on read (that pattern is fine for the operator's `adminMetrics`, but won't scale to a
live customer-facing card).

---

## 5. Data model

The board needs **per-employee** stats that **every teammate can read**. The cleanest fit that needs
**no rules change** is a `members` map on `organisations/{orgId}`, keyed by `userId` — because the
org doc is already readable by everyone carrying that `orgId` claim. With only a handful of
employees this map stays tiny.

```jsonc
// organisations/{orgId}
orgStats: {
  members: {
    "<uid>": {
      name: "Asha",          // denormalized display name (backend writes it from auth)
      points: 0,             // cumulative lifetime points (drives level + all-time board)
      level: 1,              // derived from points, stored for cheap reads
      weekPoints: 0,         // points in the current week (drives "this week" board, §2.1)
      weekStart: Timestamp,  // start of the week weekPoints counts; reset lazily when stale
      fixesShipped: 0,       // fixes that reached testing
      cleanStreak: 0,        // consecutive first-try fixes (Steady Hands)
      clearBriefs: 0,        // clear-brief + efficient fixes (§3.1)
      briefStreak: 0,        // consecutive clear briefs (Clear Brief badge)
      streakWeeks: 0,        // consecutive active weeks (On a Roll)
      lastFixAt: Timestamp,  // for streak math
      badges: ["first_ship"] // unlocked badge ids
    }
    // ... one entry per employee
  }
}
```

Per-round, the agent result also carries a `briefScore` (0–100), stored on the task/round next to
the existing `idealDescription` / `idealKeywords` — it drives the §3.1 bonus and the coaching copy.
The score lives on the task; only the derived counters above roll up to the member entry.

```jsonc
// added to each tasks/{id}.rounds[] entry (alongside idealDescription, idealKeywords)
briefScore: 82           // 0–100; emitted by the same agent output that produces the tip
```

**Rules:** the org doc is already `allow read: if request.auth.token.orgId == orgId;
allow write: if false;` — so all three employees can read the whole `members` map (that's the
point: they see each other's scores) and **none** can forge it. **No rule change needed.** ✅

**Writes:** the member entry for `task.userId` is updated inside the *existing* `db.runTransaction()`
in `finalize.js`, gated on the same `billed`/`charged` flags that already make billing idempotent —
so a re-run can't double-count points. The shipped-to-testing award rides the existing write that
flips `deployedTesting`.

> If team size ever grows past a couple dozen, move `members` to an
> `organisations/{orgId}/members/{uid}` subcollection (with a rule allowing read when the caller's
> `orgId` claim matches) to avoid a fat org doc. For 3 employees the map is simpler and cheaper.

---

## 6. v1 implementation sketch

The whole feature rides machinery that already exists; nothing here touches money math.

1. **`shared/gamification.js`** — points table, level thresholds, badge rules, and pure functions
   (`pointsForOutcome`, `levelForPoints`, `nextBadge`, `applyAward(member, award, now)` which also
   handles weekly reset + streaks). Synced to `functions/shared/` by the existing `sync-shared.sh`
   predeploy hook. No money logic.
2. **Agent result → `briefScore`** — extend the result parser (`functions/utils/agentResult.js`)
   to read a `briefScore` the agent emits *alongside* the tip it already produces
   (`idealDescription` / `idealKeywords`). No extra model call: it rides the same output. Fallback
   proxy if we skip the new field: score from how sparse `idealKeywords` is.
3. **`functions/utils/finalize.js`** — inside the existing transaction, after the debit/balance
   write, update `orgStats.members[task.userId]` (points, level, streaks, badges, weekly reset),
   including the §3.1 clear-brief + efficient-fix bonus from `briefScore`, `freeRevisionsUsed`, and
   `actualCostUsd` vs the tier `maxBudgetUsd`. Seed the member's `name` from the task's user on
   first write.
4. **`deployedTesting` hook** — wherever the testing-deploy flag flips, credit the +15 and
   `fixesShipped`/`First Ship` badge to that task's `userId` (same atomic-write discipline).
5. **`src/hooks/useOrgStats.js`** — mirrors `useOrg`; live `onSnapshot` on the org doc, returns the
   `orgStats.members` map.
6. **`src/components/Leaderboard.jsx`** — the board itself: ranked rows of the org's employees with
   a toggle between **This Week** (`weekPoints`) and **All Time** (`points`), plus per-axis mini-boards
   (most shipped, best briefs, longest streak) per §2.1. The signed-in employee's own row is
   highlighted, with their level, streak, and next badge shown beside it.
7. **Result view** — surface the brief tip + score ("Great description — that helped us fix it first
   time ✨ Tip: next time, paste the link…"), and a small celebration when a fix ships or a badge
   unlocks.

**UI language (strict).** No technical words. "Shipped to testing" → say **"went live for review"** or
**"ready to preview"**; "Level 3 · Trusted"; "2-week streak — keep it going" — never "deploy", "PR",
"repo", "agent".

**No test runner exists** — the gates are `vite build` (frontend) and the functions emulator. The
pure functions in `shared/gamification.js` are written to be trivially eyeballable.

---

## 7. Later phases

- **Cross-org percentile (anonymized, opt-in).** Once many orgs exist, a scheduled function
  (alongside `pollSessions`) computes rank buckets across opted-in orgs and writes a single public
  `leaderboard/current` doc holding **only** anonymized buckets/thresholds — never org identities.
  A callable returns the caller's own percentile ("top 15% of businesses keeping their site
  healthy") — the social kick with zero data leakage.
- **Team vs team.** If multiple multi-employee orgs adopt this, an org-aggregate board (sum of
  member points) could rank teams — same anonymization rules as above.

---

## 8. Open questions for later

- Exact point constants and level curve — needs real usage data to calibrate; the §3/§4 numbers are
  starting points.
- **Display name source** — the board shows `members[uid].name`; confirm where we read it (Firebase
  Auth `displayName`, the `users/{uid}` doc, or an admin-set value) and how it updates if it changes.
- Reset policy — v1 keeps **lifetime** points (level/badges) *and* a **weekly** board (§2.1). Decide
  later whether to add a monthly "season" with a visible winner to re-energise the team.
- Prod bonus — whether reaching `deployedProd` should add a small extra on top of the testing award.

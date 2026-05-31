/**
 * Gamification — CANONICAL source of truth for the within-org employee leaderboard.
 *
 * PURE + MONEY-FREE. Points are a read-only motivational layer on top of outcomes that
 * already happened: they never convert to balance and never change a charge. This module
 * is kept SEPARATE from shared/billing.js on purpose, so tuning points can never touch
 * money math (see docs/GAMIFICATION.md §3/§4).
 *
 * Imported by both the web app (@shared/gamification.js) and Cloud Functions
 * (functions/utils/gamification.js → ../shared, synced at predeploy by sync-shared.sh).
 *
 * All award functions are PURE: callers pass `nowMs` (Date.now()) so the math is
 * deterministic and trivially eyeballable — there is no test runner in this repo.
 */

// --- Tunable constants (starting hypotheses; calibrate with real usage data) ---------------

/** Base points per completed, charged fix — weighted by tier so effort scales. */
export const POINTS_BY_COMPLEXITY = { simple: 10, medium: 25, complex: 50 };
/** A clean (first-try) fix adds this fraction of the base on top. */
export const FIRST_TRY_BONUS_FRACTION = 0.5;
/** Points for a fix that went live for review (the delivery milestone). */
export const SHIP_POINTS = 15;
/** Weekly-active-streak reward, per consecutive active week, capped. */
export const STREAK_POINTS_PER_WEEK = 5;
export const STREAK_POINTS_CAP = 50;
/** Bonus for a clear brief that produced an efficient, first-try fix. */
export const CLEAR_BRIEF_POINTS = 20;

/** A brief earns the clarity bonus only when it scored well AND the fix was efficient. */
export const CLEAR_BRIEF_SCORE_THRESHOLD = 70; // briefScore is 0–100
export const EFFICIENCY_FRACTION = 0.6;        // actualCost < 0.6 × the tier's budget cap

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Levels — cumulative points on a gently superlinear curve (early levels arrive fast). */
export const LEVELS = [
  { level: 1, name: 'Sprout', minPoints: 0 },
  { level: 2, name: 'Steady', minPoints: 75 },
  { level: 3, name: 'Trusted', minPoints: 200 },
  { level: 4, name: 'Pro', minPoints: 450 },
  { level: 5, name: 'Champion', minPoints: 900 },
];

/** Badges — milestone identity markers, per employee. Plain-language labels (no jargon). */
export const BADGES = {
  first_ship: { id: 'first_ship', label: 'First Fix', hint: 'Your first fix went live for review' },
  steady_hands: { id: 'steady_hands', label: 'Steady Hands', hint: '3 first-try fixes in a row' },
  clear_brief: { id: 'clear_brief', label: 'Clear Brief', hint: '3 clear, efficient descriptions' },
  on_a_roll: { id: 'on_a_roll', label: 'On a Roll', hint: '4 active weeks in a row' },
};

// --- Pure helpers --------------------------------------------------------------------------

/** The level a cumulative point total falls into. */
export function levelForPoints(points) {
  const p = Math.max(0, Number(points) || 0);
  let cur = LEVELS[0];
  for (const l of LEVELS) if (p >= l.minPoints) cur = l;
  return cur;
}

/** The next level up (or null at the top), for "X to go" copy. */
export function nextLevel(points) {
  const p = Math.max(0, Number(points) || 0);
  return LEVELS.find((l) => l.minPoints > p) || null;
}

/** Map a 0–100 brief score to a 1–5 ⭐ rating (0 = no score yet, hide the badge). */
export function clarityStars(briefScore) {
  const s = Number(briefScore);
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.min(5, Math.max(1, Math.round(s / 20)));
}

/** Did this round earn the clear-brief bonus? Clear AND first-try AND comfortably under cap. */
export function isClearBrief({ briefScore, freeRevisionsUsed, actualCostUsd, maxBudgetUsd } = {}) {
  const scored = (Number(briefScore) || 0) >= CLEAR_BRIEF_SCORE_THRESHOLD;
  const firstTry = (Number(freeRevisionsUsed) || 0) === 0;
  const cap = Number(maxBudgetUsd) || 0;
  const efficient = cap > 0 && (Number(actualCostUsd) || 0) < EFFICIENCY_FRACTION * cap;
  return scored && firstTry && efficient;
}

const weekBucket = (ms) => Math.floor((Number(ms) || 0) / WEEK_MS) * WEEK_MS;

/** A fresh, zeroed member entry. `name` is the denormalized display name. */
export function emptyMember(name = '') {
  return {
    name: String(name || ''),
    points: 0,
    level: 1,
    weekPoints: 0,
    weekStart: 0,
    fixesShipped: 0,
    cleanStreak: 0,
    clearBriefs: 0,
    briefStreak: 0,
    streakWeeks: 0,
    lastFixAt: 0,
    badges: [],
  };
}

/** Recompute the unlocked badge set from a member's counters (monotonic — never removes). */
function withBadges(member) {
  const set = new Set(member.badges || []);
  if (member.fixesShipped >= 1) set.add('first_ship');
  if (member.cleanStreak >= 3) set.add('steady_hands');
  if (member.clearBriefs >= 3) set.add('clear_brief');
  if (member.streakWeeks >= 4) set.add('on_a_roll');
  return [...set];
}

// --- Awards (pure: return a NEW member + what was gained, for celebration UI) --------------

/**
 * Award points for ONE completed, charged fix round.
 * @param {object|null} prev   the member's current entry (null/undefined → seeded fresh)
 * @param {object} award       { name, complexity, freeRevisionsUsed, briefScore, actualCostUsd, maxBudgetUsd }
 * @param {number} nowMs       Date.now() — when the round closed
 * @returns {{ member: object, gained: number, newBadges: string[] }}
 */
export function applyFixAward(prev, award = {}, nowMs = 0) {
  const m = { ...emptyMember(award.name), ...(prev || {}) };
  if (award.name && !m.name) m.name = String(award.name);

  const bucket = weekBucket(nowMs);
  if (m.weekStart !== bucket) { m.weekPoints = 0; m.weekStart = bucket; }

  const base = POINTS_BY_COMPLEXITY[award.complexity] ?? POINTS_BY_COMPLEXITY.medium;
  const firstTry = (Number(award.freeRevisionsUsed) || 0) === 0;
  const firstTryBonus = firstTry ? Math.round(base * FIRST_TRY_BONUS_FRACTION) : 0;

  // Weekly active streak: consecutive active weeks. Same week → unchanged; next week → +1;
  // a gap → reset to this week.
  const prevBucket = m.lastFixAt ? weekBucket(m.lastFixAt) : null;
  if (prevBucket === null) m.streakWeeks = 1;
  else if (bucket === prevBucket) m.streakWeeks = Math.max(1, m.streakWeeks);
  else if (bucket - prevBucket === WEEK_MS) m.streakWeeks += 1;
  else m.streakWeeks = 1;
  const streakPts = Math.min(m.streakWeeks * STREAK_POINTS_PER_WEEK, STREAK_POINTS_CAP);

  const clear = isClearBrief(award);
  const clearPts = clear ? CLEAR_BRIEF_POINTS : 0;

  m.cleanStreak = firstTry ? m.cleanStreak + 1 : 0;
  if (clear) { m.clearBriefs += 1; m.briefStreak += 1; } else { m.briefStreak = 0; }

  const gained = base + firstTryBonus + streakPts + clearPts;
  m.points += gained;
  m.weekPoints += gained;
  m.lastFixAt = Number(nowMs) || m.lastFixAt;
  m.level = levelForPoints(m.points).level;

  const before = new Set(m.badges || []);
  m.badges = withBadges(m);
  return { member: m, gained, newBadges: m.badges.filter((b) => !before.has(b)) };
}

/** Award the "went live for review" milestone (+ First Fix badge). Pure. */
export function applyShipAward(prev, { name } = {}, nowMs = 0) {
  const m = { ...emptyMember(name), ...(prev || {}) };
  if (name && !m.name) m.name = String(name);

  const bucket = weekBucket(nowMs);
  if (m.weekStart !== bucket) { m.weekPoints = 0; m.weekStart = bucket; }

  m.fixesShipped += 1;
  m.points += SHIP_POINTS;
  m.weekPoints += SHIP_POINTS;
  m.level = levelForPoints(m.points).level;

  const before = new Set(m.badges || []);
  m.badges = withBadges(m);
  return { member: m, gained: SHIP_POINTS, newBadges: m.badges.filter((b) => !before.has(b)) };
}

/**
 * A member's points for the CURRENT week, honest at read time. Stored `weekPoints` only
 * resets lazily on the next award, so a member who was active last week but not this week
 * would otherwise show a stale total under "This Week". This zeroes it out unless the stored
 * week is the one `nowMs` falls in.
 */
export function effectiveWeekPoints(member, nowMs) {
  const ws = Number(member?.weekStart) || 0;
  return weekBucket(ws) === weekBucket(nowMs) ? (Number(member?.weekPoints) || 0) : 0;
}

/** The next badge to nudge toward (in unlock order), or null if all are earned. */
export function nextBadge(member) {
  const have = new Set(member?.badges || []);
  const id = ['first_ship', 'steady_hands', 'clear_brief', 'on_a_roll'].find((b) => !have.has(b));
  return id ? BADGES[id] : null;
}

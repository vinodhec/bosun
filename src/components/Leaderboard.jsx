// The within-org team board (docs/GAMIFICATION.md). Ranks the org's employees against each
// other to drive seat activation. Strict plain language: no technical words — points, levels,
// streaks and "went live for review", never deploy/PR/repo/agent.
import { useState } from 'react';
import { levelForPoints, nextBadge, emptyMember, effectiveWeekPoints } from '@shared/gamification.js';

// The board labels people by email (unique — display names like "Admin"/"Maadi" collide).
const label = (s, fallback = 'Teammate') => (String(s || '').trim() || fallback);
// A short handle for tight spots (the call-to-action, the leaders line): the part before "@".
const short = (s, fallback = 'you') => {
  const v = String(s || '').trim();
  if (!v) return fallback;
  return v.includes('@') ? v.split('@')[0] : v.split(/\s+/)[0];
};
const medal = (rank) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`);

// Build the ranked rows for the chosen board, always including the signed-in user. `weekPoints`
// is normalized to the current week at read time (stale weeks count as 0 — see gamification.js).
function buildRows(members, meId, metric) {
  const now = Date.now();
  const map = { ...(members || {}) };
  if (meId && !map[meId]) map[meId] = emptyMember('You');
  const rows = Object.entries(map).map(([uid, m]) => {
    const row = { uid, ...emptyMember(), ...m };
    row.weekPoints = effectiveWeekPoints(row, now);
    return row;
  });
  rows.sort((a, b) =>
    (b[metric] - a[metric]) || (b.points - a.points) || String(a.name).localeCompare(String(b.name)),
  );
  return rows;
}

function topBy(rows, key) {
  const best = rows.filter((r) => (r[key] || 0) > 0).sort((a, b) => b[key] - a[key])[0];
  return best ? { name: best.name, value: best[key] } : null;
}

function personalLine(rows, meId, metric) {
  const idx = rows.findIndex((r) => r.uid === meId);
  if (idx < 0) return 'Raise your first fix to get on the board.';
  const me = rows[idx];
  const started = me.points > 0 || me.fixesShipped > 0;
  if (!started) return 'Raise your first fix to get on the board.';
  if (idx === 0) {
    return me.streakWeeks >= 2
      ? `You’re #1 — keep your ${me.streakWeeks}-week streak alive!`
      : 'You’re #1 on the team right now 🎉';
  }
  const ahead = rows[idx - 1];
  const gap = Math.max(1, (ahead[metric] || 0) - (me[metric] || 0) + 1);
  return `${gap} ${gap === 1 ? 'point' : 'points'} to overtake ${short(ahead.name)} for #${idx}.`;
}

export default function Leaderboard({ members, meId, compact = false }) {
  const [tab, setTab] = useState('week'); // 'week' | 'all'
  const [openMobile, setOpenMobile] = useState(false);

  if (members === undefined) return null; // loading — render nothing rather than an empty box
  const metric = tab === 'week' ? 'weekPoints' : 'points';
  const rows = buildRows(members, meId, metric);
  const cta = personalLine(rows, meId, metric);
  const myIdx = rows.findIndex((r) => r.uid === meId);
  const me = myIdx >= 0 ? rows[myIdx] : null;
  const badge = me ? nextBadge(me) : null;

  // Mobile: a single compact strip above the fix box, tap to expand the full board.
  if (compact) {
    return (
      <div className="card p-3">
        <button
          onClick={() => setOpenMobile((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="text-sm font-medium text-ink">
            <span className="mr-1.5 text-xs font-semibold uppercase tracking-wide text-brand-700">Team</span>
            {cta}
          </span>
          <span className="shrink-0 text-xs font-semibold text-brand-600">{openMobile ? 'Hide' : 'View board'}</span>
        </button>
        {openMobile && <div className="mt-3"><Board rows={rows} meId={meId} tab={tab} setTab={setTab} cta={cta} badge={badge} /></div>}
      </div>
    );
  }

  return (
    <div className="card p-4">
      <Board rows={rows} meId={meId} tab={tab} setTab={setTab} cta={cta} badge={badge} />
    </div>
  );
}

function Board({ rows, meId, tab, setTab, cta, badge }) {
  const metric = tab === 'week' ? 'weekPoints' : 'points';
  const shipped = topBy(rows, 'fixesShipped');
  const briefs = topBy(rows, 'clearBriefs');
  const streak = topBy(rows, 'streakWeeks');
  const leaders = [
    shipped && { label: 'Most fixes live', who: short(shipped.name) },
    briefs && { label: 'Clearest briefs', who: short(briefs.name) },
    streak && streak.value >= 2 && { label: 'Longest streak', who: `${short(streak.name)} · ${streak.value}w` },
  ].filter(Boolean);

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">Team</h2>
        <div className="tab-group text-xs font-medium">
          <button
            onClick={() => setTab('week')}
            className={`tab-item ${tab === 'week' ? 'tab-item-active' : ''}`}
          >
            This Week
          </button>
          <button
            onClick={() => setTab('all')}
            className={`tab-item ${tab === 'all' ? 'tab-item-active' : ''}`}
          >
            All Time
          </button>
        </div>
      </div>

      <ol className="mt-3 space-y-1.5">
        {rows.map((r, i) => {
          const rank = i + 1;
          const value = r[metric] || 0;
          const started = r.points > 0 || r.fixesShipped > 0;
          const isMe = r.uid === meId;
          const level = levelForPoints(r.points);
          return (
            <li
              key={r.uid}
              className={`flex items-center gap-2 rounded-xl px-2.5 py-2 transition ${isMe ? 'bg-brand-50 ring-1 ring-brand-200/80' : 'hover:bg-canvas'}`}
            >
              <span className="w-6 shrink-0 text-center text-sm font-semibold text-ink-soft">
                {started ? medal(rank) : '·'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {isMe ? `${label(r.name, 'You')} (you)` : label(r.name)}
                </p>
                <p className="truncate text-xs text-ink-soft">
                  {started ? `Level ${level.level} · ${level.name}` : 'Not started yet'}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold text-ink">
                {started ? value : '—'}
              </span>
            </li>
          );
        })}
      </ol>

      {leaders.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <ul className="space-y-1 text-xs text-ink-soft">
            {leaders.map((l) => (
              <li key={l.label} className="flex justify-between gap-2">
                <span>{l.label}</span>
                <span className="font-medium text-ink">{l.who}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 rounded-xl bg-gradient-to-br from-brand-50 to-brand-100/60 p-3.5 ring-1 ring-brand-200/50">
        <p className="text-sm font-medium text-brand-800">{cta}</p>
        {badge && (
          <p className="mt-1 text-xs text-brand-700">✦ Next badge: <span className="font-semibold">{badge.label}</span> — {badge.hint}</p>
        )}
      </div>
    </>
  );
}

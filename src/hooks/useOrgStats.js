import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase/config.js';

/**
 * Live within-org leaderboard data. Mirrors useOrg: reads the orgId from the user's auth
 * claim, then subscribes to the org doc and returns its `orgStats.members` map plus the
 * signed-in uid (so the board can highlight "you").
 *
 * `members` is `undefined` while loading, `{}` once loaded if the org has no stats yet.
 * The org doc is already member-readable via Firestore rules, and the members map holds
 * only non-financial board data (names + points) — safe for teammates to see each other.
 */
export function useOrgStats(user) {
  const [state, setState] = useState({ members: undefined, meId: null });
  useEffect(() => {
    if (!user) { setState({ members: undefined, meId: null }); return undefined; }
    let unsub;
    let cancelled = false;
    user.getIdTokenResult().then((res) => {
      if (cancelled) return;
      const orgId = res.claims?.orgId;
      if (!orgId) { setState({ members: {}, meId: user.uid }); return; }
      unsub = onSnapshot(
        doc(db, 'organisations', orgId),
        (snap) => setState({ members: (snap.exists() && snap.data()?.orgStats?.members) || {}, meId: user.uid }),
        () => setState({ members: {}, meId: user.uid }),
      );
    });
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [user]);
  return state;
}

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase/config.js';

/**
 * The user's organisation (credit wallet). `undefined` while loading, `null` if the
 * user isn't linked to an org yet. Reads the `orgId` from the user's auth claim (set by
 * the operator via adminSetUserOrg), then live-subscribes to the org doc.
 */
export function useOrg(user) {
  const [org, setOrg] = useState(undefined);
  useEffect(() => {
    if (!user) { setOrg(null); return undefined; }
    let unsub;
    let cancelled = false;
    user.getIdTokenResult().then((res) => {
      if (cancelled) return;
      const orgId = res.claims?.orgId;
      if (!orgId) { setOrg(null); return; }
      unsub = onSnapshot(doc(db, 'organisations', orgId), (snap) =>
        setOrg(snap.exists() ? { id: snap.id, ...snap.data() } : null)
      );
    });
    return () => { cancelled = true; if (unsub) unsub(); };
  }, [user]);
  return org;
}

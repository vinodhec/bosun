import { useEffect, useState } from 'react';
import { onSnapshot, siteDocRef } from '../firebase/firestore.js';

/**
 * The user's connected website (GitHub repo). `undefined` while loading,
 * `null` when nothing connected yet, else `{ id, repoFullName, ... }`.
 */
export function useSite(uid) {
  const [site, setSite] = useState(undefined);
  useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(siteDocRef(uid), (snap) =>
      setSite(snap.exists() ? { id: snap.id, ...snap.data() } : null)
    );
  }, [uid]);
  return site;
}

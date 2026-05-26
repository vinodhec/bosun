import { useEffect, useState } from 'react';
import { onSnapshot, userDocRef } from '../firebase/firestore.js';

/** Live wallet balance (INR) for a user. `null` while loading. */
export function useBalance(uid) {
  const [balance, setBalance] = useState(null);
  useEffect(() => {
    if (!uid) return undefined;
    return onSnapshot(userDocRef(uid), (snap) => {
      setBalance(snap.exists() ? Number(snap.data().balance ?? 0) : 0);
    });
  }, [uid]);
  return balance;
}

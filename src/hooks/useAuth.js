import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../firebase/config.js';

/**
 * Auth state. `user` is `undefined` while loading, `null` when signed out,
 * and the Firebase user object when signed in.
 */
export function useAuth() {
  const [user, setUser] = useState(undefined);
  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u ?? null)), []);
  return { user, loading: user === undefined };
}

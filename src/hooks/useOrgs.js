import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase/config.js';

/**
 * Every organisation the signed-in user belongs to, plus which one is active. Reads the user
 * doc (`orgIds` + `activeOrgId`, written backend-only), then live-subscribes to each org
 * document so the wallet/repo/board stay current as the user switches between them.
 *
 * Returns `{ orgs, activeOrgId, loading }`:
 *   - `orgs`        — array of org docs ({ id, name, balance, github, deploy, … }), or [].
 *   - `activeOrgId` — the user's selected org (falls back to the first membership).
 *   - `loading`     — true until the user doc + its org docs have resolved once.
 */
export function useOrgs(user) {
  const [state, setState] = useState({ orgs: [], activeOrgId: null, loading: true });
  useEffect(() => {
    if (!user) { setState({ orgs: [], activeOrgId: null, loading: false }); return undefined; }
    let orgUnsubs = [];
    const cleanupOrgs = () => { orgUnsubs.forEach((u) => u()); orgUnsubs = []; };

    const userUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
      const data = snap.exists() ? snap.data() : {};
      const ids = Array.isArray(data.orgIds) && data.orgIds.length
        ? [...new Set(data.orgIds.filter(Boolean))]
        : (data.orgId ? [data.orgId] : []);
      const activeOrgId = (data.activeOrgId && ids.includes(data.activeOrgId)) ? data.activeOrgId : (ids[0] || null);

      cleanupOrgs();
      if (!ids.length) { setState({ orgs: [], activeOrgId: null, loading: false }); return; }

      const docs = new Map();
      const emit = () => setState({ orgs: ids.map((id) => docs.get(id)).filter(Boolean), activeOrgId, loading: false });
      orgUnsubs = ids.map((id) => onSnapshot(
        doc(db, 'organisations', id),
        (os) => { docs.set(id, os.exists() ? { id: os.id, ...os.data() } : { id, name: '(unavailable)' }); emit(); },
        () => { docs.set(id, { id, name: '(unavailable)' }); emit(); },
      ));
    });

    return () => { userUnsub(); cleanupOrgs(); };
  }, [user]);
  return state;
}

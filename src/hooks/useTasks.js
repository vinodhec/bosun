import { useEffect, useState } from 'react';
import { onSnapshot, recentTasksQuery } from '../firebase/firestore.js';

/** Live list of a user's tasks, newest first. */
export function useTasks(uid, max = 50) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!uid) return undefined;
    setLoading(true);
    return onSnapshot(recentTasksQuery(uid, max), (snap) => {
      setTasks(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
  }, [uid, max]);
  return { tasks, loading };
}

import {
  doc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
} from 'firebase/firestore';
import { db } from './config.js';

export const userDocRef = (uid) => doc(db, 'users', uid);
export const taskDocRef = (taskId) => doc(db, 'tasks', taskId);
export const siteDocRef = (uid) => doc(db, 'sites', uid);

export const recentTasksQuery = (uid, max = 50) =>
  query(
    collection(db, 'tasks'),
    where('userId', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(max)
  );

export const transactionsQuery = (uid, max = 100) =>
  query(
    collection(db, 'transactions'),
    where('userId', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(max)
  );

export { onSnapshot };

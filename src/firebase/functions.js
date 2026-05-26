import { httpsCallable } from 'firebase/functions';
import { functions } from './config.js';

// Customer callables.
export const ensureUser = httpsCallable(functions, 'ensureUser');
export const classifyTask = httpsCallable(functions, 'classifyTask');
export const createTask = httpsCallable(functions, 'createTask');
export const listMySessions = httpsCallable(functions, 'listMySessions');
export const reviseSession = httpsCallable(functions, 'reviseSession');

// Operator-only admin callables (gated server-side by ADMIN_EMAILS).
export const adminCreateOrg = httpsCallable(functions, 'adminCreateOrg');
export const adminAddCredits = httpsCallable(functions, 'adminAddCredits');
export const adminListOrgs = httpsCallable(functions, 'adminListOrgs');
export const adminSetUserOrg = httpsCallable(functions, 'adminSetUserOrg');
export const adminSetGithubRepo = httpsCallable(functions, 'adminSetGithubRepo');
export const adminRunFix = httpsCallable(functions, 'adminRunFix');
export const adminListTasks = httpsCallable(functions, 'adminListTasks');
export const deployTesting = httpsCallable(functions, 'deployTesting');
export const deployProd = httpsCallable(functions, 'deployProd');

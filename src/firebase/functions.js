import { httpsCallable } from 'firebase/functions';
import { functions } from './config.js';

// Customer callables.
export const ensureUser = httpsCallable(functions, 'ensureUser');
export const classifyTask = httpsCallable(functions, 'classifyTask');
export const createTask = httpsCallable(functions, 'createTask');
export const listMySessions = httpsCallable(functions, 'listMySessions');
export const reviseSession = httpsCallable(functions, 'reviseSession');
export const approveFix = httpsCallable(functions, 'approveFix');
export const confirmQuote = httpsCallable(functions, 'confirmQuote');
export const declineQuote = httpsCallable(functions, 'declineQuote');
export const customerDeployTesting = httpsCallable(functions, 'customerDeployTesting');
export const customerDeployProd = httpsCallable(functions, 'customerDeployProd');
// "Plan a feature": decompose into ordered steps, each built as a fix, billed per step.
export const planFeature = httpsCallable(functions, 'planFeature');
export const listMyFeatures = httpsCallable(functions, 'listMyFeatures');
export const retryFeatureStep = httpsCallable(functions, 'retryFeatureStep');

// Operator-only admin callables (gated server-side by ADMIN_EMAILS).
export const adminCreateOrg = httpsCallable(functions, 'adminCreateOrg');
export const adminAddCredits = httpsCallable(functions, 'adminAddCredits');
export const adminDeductCredits = httpsCallable(functions, 'adminDeductCredits');
export const adminListTransactions = httpsCallable(functions, 'adminListTransactions');
export const adminListOrgs = httpsCallable(functions, 'adminListOrgs');
export const adminMetrics = httpsCallable(functions, 'adminMetrics');
export const adminSetUserOrg = httpsCallable(functions, 'adminSetUserOrg');
export const adminSetOrgApproval = httpsCallable(functions, 'adminSetOrgApproval');
export const adminListUsers = httpsCallable(functions, 'adminListUsers');
export const adminSetUserDeploy = httpsCallable(functions, 'adminSetUserDeploy');
export const adminQuoteTask = httpsCallable(functions, 'adminQuoteTask');
export const adminBackfillGamification = httpsCallable(functions, 'adminBackfillGamification');
export const adminSetGithubRepo = httpsCallable(functions, 'adminSetGithubRepo');
export const adminRunFix = httpsCallable(functions, 'adminRunFix');
export const adminListTasks = httpsCallable(functions, 'adminListTasks');
export const adminStopTask = httpsCallable(functions, 'adminStopTask');
export const deployTesting = httpsCallable(functions, 'deployTesting');
export const deployProd = httpsCallable(functions, 'deployProd');
export const adminConnectFigma = httpsCallable(functions, 'adminConnectFigma');
export const adminDisconnectFigma = httpsCallable(functions, 'adminDisconnectFigma');

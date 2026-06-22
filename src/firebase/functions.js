import { httpsCallable } from 'firebase/functions';
import { functions } from './config.js';

// Customer callables.
export const ensureUser = httpsCallable(functions, 'ensureUser');
export const classifyTask = httpsCallable(functions, 'classifyTask');
export const createTask = httpsCallable(functions, 'createTask');
export const listMySessions = httpsCallable(functions, 'listMySessions');
export const setActiveOrg = httpsCallable(functions, 'setActiveOrg');
export const reviseSession = httpsCallable(functions, 'reviseSession');
export const approveFix = httpsCallable(functions, 'approveFix');
export const confirmQuote = httpsCallable(functions, 'confirmQuote');
export const declineQuote = httpsCallable(functions, 'declineQuote');
export const customerDeployTesting = httpsCallable(functions, 'customerDeployTesting');
export const customerDeployProd = httpsCallable(functions, 'customerDeployProd');
// Firebase-hosting orgs only: deploy a fix's branch to the testing site to see it, then undo.
export const customerPreviewTesting = httpsCallable(functions, 'customerPreviewTesting');
export const customerRevertTesting = httpsCallable(functions, 'customerRevertTesting');
// "Plan a feature": code-aware breakdown → review/approve/refine → ordered steps, billed per step.
export const planFeature = httpsCallable(functions, 'planFeature');
export const approveFeaturePlan = httpsCallable(functions, 'approveFeaturePlan');
export const reviseFeaturePlan = httpsCallable(functions, 'reviseFeaturePlan');
export const addFeatureChange = httpsCallable(functions, 'addFeatureChange');
export const listMyFeatures = httpsCallable(functions, 'listMyFeatures');
export const retryFeatureStep = httpsCallable(functions, 'retryFeatureStep');
// "Design a screen": clarify chat + a live HTML mock the owner approves before a real build runs.
export const planDesign = httpsCallable(functions, 'planDesign');
export const replyToClarify = httpsCallable(functions, 'replyToClarify');
export const refineMockup = httpsCallable(functions, 'refineMockup');
export const approveDesign = httpsCallable(functions, 'approveDesign');
export const listMyDesigns = httpsCallable(functions, 'listMyDesigns');

// Operator-only admin callables (gated server-side by ADMIN_EMAILS).
export const adminCreateOrg = httpsCallable(functions, 'adminCreateOrg');
export const adminAddCredits = httpsCallable(functions, 'adminAddCredits');
export const adminDeductCredits = httpsCallable(functions, 'adminDeductCredits');
export const adminListTransactions = httpsCallable(functions, 'adminListTransactions');
export const adminListOrgs = httpsCallable(functions, 'adminListOrgs');
export const adminMetrics = httpsCallable(functions, 'adminMetrics');
export const adminSetUserOrg = httpsCallable(functions, 'adminSetUserOrg');
export const adminRemoveUserOrg = httpsCallable(functions, 'adminRemoveUserOrg');
export const adminSetOrgApproval = httpsCallable(functions, 'adminSetOrgApproval');
export const adminListUsers = httpsCallable(functions, 'adminListUsers');
export const adminSetUserDeploy = httpsCallable(functions, 'adminSetUserDeploy');
export const adminQuoteTask = httpsCallable(functions, 'adminQuoteTask');
export const adminBackfillGamification = httpsCallable(functions, 'adminBackfillGamification');
export const adminSetGithubRepo = httpsCallable(functions, 'adminSetGithubRepo');
export const adminRunFix = httpsCallable(functions, 'adminRunFix');
export const adminListTasks = httpsCallable(functions, 'adminListTasks');
export const adminListFeatures = httpsCallable(functions, 'adminListFeatures');
export const adminStopTask = httpsCallable(functions, 'adminStopTask');
export const deployTesting = httpsCallable(functions, 'deployTesting');
export const deployProd = httpsCallable(functions, 'deployProd');
export const previewTesting = httpsCallable(functions, 'previewTesting');
export const revertTesting = httpsCallable(functions, 'revertTesting');
export const adminConnectFigma = httpsCallable(functions, 'adminConnectFigma');
export const adminDisconnectFigma = httpsCallable(functions, 'adminDisconnectFigma');

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
export const editFeaturePlan = httpsCallable(functions, 'editFeaturePlan');
export const addFeatureChange = httpsCallable(functions, 'addFeatureChange');
export const listMyFeatures = httpsCallable(functions, 'listMyFeatures');
export const retryFeatureStep = httpsCallable(functions, 'retryFeatureStep');
// "Design a screen": clarify chat + a live HTML mock the owner approves before a real build runs.
export const planDesign = httpsCallable(functions, 'planDesign');
export const replyToClarify = httpsCallable(functions, 'replyToClarify');
export const refineMockup = httpsCallable(functions, 'refineMockup');
export const approveDesign = httpsCallable(functions, 'approveDesign');
export const listMyDesigns = httpsCallable(functions, 'listMyDesigns');
export const getDesignMockHtml = httpsCallable(functions, 'getDesignMockHtml');
// Share a finished design / fix / feature with a teammate (same org), who can fork it and build their
// own version. Design forks the mock, feature forks the plan, fix pre-fills the "fix a website" box.
export const shareDesign = httpsCallable(functions, 'shareDesign');
export const unshareDesign = httpsCallable(functions, 'unshareDesign');
export const getSharedDesign = httpsCallable(functions, 'getSharedDesign');
export const forkDesign = httpsCallable(functions, 'forkDesign');
export const shareSession = httpsCallable(functions, 'shareSession');
export const unshareSession = httpsCallable(functions, 'unshareSession');
export const getSharedSession = httpsCallable(functions, 'getSharedSession');
export const shareFeature = httpsCallable(functions, 'shareFeature');
export const unshareFeature = httpsCallable(functions, 'unshareFeature');
export const getSharedFeature = httpsCallable(functions, 'getSharedFeature');
export const forkFeature = httpsCallable(functions, 'forkFeature');

// "Size up the competition": code-aware comparison vs competitors → a two-sided scorecard + scoped
// actions that route into Fix / Design / Plan. Clarify-first; charged when the report is ready.
export const startComparison = httpsCallable(functions, 'startComparison');
export const replyToComparison = httpsCallable(functions, 'replyToComparison');
export const refineComparison = httpsCallable(functions, 'refineComparison');
export const listMyComparisons = httpsCallable(functions, 'listMyComparisons');

// "Chat & build": one warm session that clarifies (asking for a screenshot / page link / recording /
// design when it helps) then builds the change on approval — all in one thread. Charged once, on build.
export const startChat = httpsCallable(functions, 'startChat');
export const replyToChat = httpsCallable(functions, 'replyToChat');
export const approveChatBuild = httpsCallable(functions, 'approveChatBuild');
export const getChatMockHtml = httpsCallable(functions, 'getChatMockHtml');
export const listMyChats = httpsCallable(functions, 'listMyChats');

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
export const adminListDesigns = httpsCallable(functions, 'adminListDesigns');
export const adminStopTask = httpsCallable(functions, 'adminStopTask');
export const deployTesting = httpsCallable(functions, 'deployTesting');
export const deployProd = httpsCallable(functions, 'deployProd');
export const previewTesting = httpsCallable(functions, 'previewTesting');
export const revertTesting = httpsCallable(functions, 'revertTesting');
export const adminConnectFigma = httpsCallable(functions, 'adminConnectFigma');
export const adminDisconnectFigma = httpsCallable(functions, 'adminDisconnectFigma');
export const adminListInvoices = httpsCallable(functions, 'adminListInvoices');
export const adminInvoiceHtml = httpsCallable(functions, 'adminInvoiceHtml');
export const adminSetUserInvoices = httpsCallable(functions, 'adminSetUserInvoices');
export const adminGstReport = httpsCallable(functions, 'adminGstReport');

// Customer-facing GST invoices.
export const listMyInvoices = httpsCallable(functions, 'listMyInvoices');
export const getMyInvoiceHtml = httpsCallable(functions, 'getMyInvoiceHtml');

import { initializeApp } from 'firebase-admin/app';

initializeApp();

// Called by the app right after sign-in to create the user record (gen2 callable).
export { ensureUser } from './handlers/ensureUser.js';

// Customer-facing callables.
export { classifyTask } from './handlers/classifyTask.js';   // step 1: estimate
export { createTask } from './handlers/createTask.js';        // step 2: run
export { listMySessions, reviseSession, approveFix, confirmQuote, declineQuote, setActiveOrg, shareSession, unshareSession, getSharedSession } from './handlers/customerTasks.js'; // view + revise + approve + big-job quotes + active-org switch + share
// Plan a feature → code-aware breakdown, owner reviews/approves/refines, then sequential fix steps.
export { planFeature, approveFeaturePlan, reviseFeaturePlan, editFeaturePlan, addFeatureChange, listMyFeatures, retryFeatureStep, shareFeature, unshareFeature, getSharedFeature, forkFeature } from './handlers/featureTasks.js';
// Design a screen → clarify chat + a live HTML mock the owner approves before a real build runs.
export { planDesign, replyToClarify, refineMockup, approveDesign, listMyDesigns, getDesignMockHtml, shareDesign, unshareDesign, getSharedDesign, forkDesign } from './handlers/designTasks.js';
// Size up the competition → code-aware comparison vs competitors, a two-sided scorecard + scoped
// actions that route into Fix / Design / Plan. Clarify-first; charged when the report is ready.
export { startComparison, replyToComparison, refineComparison, listMyComparisons } from './handlers/compareTasks.js';

// Operator-only admin callables — credits live at the organisation level.
export {
  adminCreateOrg,
  adminAddCredits,
  adminDeductCredits,
  adminListTransactions,
  adminListOrgs,
  adminSetUserOrg,
  adminRemoveUserOrg,
  adminSetOrgApproval,
  adminListUsers,
  adminSetUserDeploy,
  adminQuoteTask,
  adminMetrics,
  adminBackfillGamification,
} from './handlers/admin.js';

// Operator-only: connect an org's Figma account so a pasted design link enriches a fix with
// exact design context (the agent builds the UI pixel-perfect).
export { adminConnectFigma, adminDisconnectFigma } from './handlers/adminFigma.js';

// Operator: connect an org's GitHub repo (+ token + MCP vault) so fixes can run,
// and run a fix against any org's repo for testing.
export {
  adminSetGithubRepo,
  adminRunFix,
  adminListTasks,
  adminListFeatures,
  adminListDesigns,
  adminStopTask,
  deployTesting,
  deployProd,
  customerDeployTesting,
  customerDeployProd,
  previewTesting,
  revertTesting,
  customerPreviewTesting,
  customerRevertTesting,
} from './handlers/adminGithub.js';

// Scheduled: finalize finished sessions → bill the org; terminate over-budget ones.
export { pollSessions } from './handlers/pollSessions.js';

// Scheduled: refresh the cached live USD->INR rate the billing path converts COGS at.
export { refreshExchangeRate } from './handlers/fxRate.js';

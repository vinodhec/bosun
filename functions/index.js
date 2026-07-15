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
export { startChat, replyToChat, approveChatBuild, getChatMockHtml, listMyChats } from './handlers/chatbotTasks.js';

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
  adminSetOrgBilling,
  adminListUsers,
  adminSetUserDeploy,
  adminQuoteTask,
  adminMetrics,
  adminBackfillGamification,
  adminListInvoices,
  adminInvoiceHtml,
  adminSetUserInvoices,
  adminGstReport,
} from './handlers/admin.js';

// Customer-facing GST tax invoices (issued on wallet top-ups). List + printable HTML.
export { listMyInvoices, getMyInvoiceHtml } from './handlers/invoices.js';

// Operator-only: connect an org's Figma account so a pasted design link enriches a fix with
// exact design context (the agent builds the UI pixel-perfect).
export { adminConnectFigma, adminDisconnectFigma } from './handlers/adminFigma.js';

// Operator-only: configure an org's sourced-listing relay (Apify query matrix + webhook + HMAC),
// plus an on-demand trigger to run one org's relay immediately for end-to-end testing.
export { adminConfigureSourcing, adminDisableSourcing, adminRunSourcingNow, adminSourceTopTarget } from './handlers/adminSourcing.js';

// Operator: connect an org's GitHub repo (+ token + MCP vault) so fixes can run,
// and run a fix against any org's repo for testing.
export {
  adminSetGithubRepo,
  adminRunFix,
  adminListTasks,
  adminListFeatures,
  adminListDesigns,
  adminListChats,
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
export { pollSessions, reconcileFailedCosts } from './handlers/pollSessions.js';

// Scheduled: relay fresh sourced property listings to each org's webhook → bill per listing.
export { runSourcingJobs } from './handlers/runSourcingJobs.js';

// HTTP (customer→Bosun, HMAC-signed with the org's own relay secret): compose the WhatsApp message
// the customer sends a property owner, in the owner's language. Billed ₹0.25 per compose, settled
// in-request.
export { sourcingCompose } from './handlers/sourcingCompose.js';

// HTTP (customer→Bosun, same HMAC): usage-event meter. The customer's platform reports each
// listing its sweep auto-published off a Bosun-sourced lead; priced here (₹0.50/auto_post,
// shared/billing.js) — the event carries no price on the wire. Idempotent per lead, replay-safe.
export { usageMeter } from './handlers/usageMeter.js';

// Scheduled: refresh the cached live USD->INR rate the billing path converts COGS at.
export { refreshExchangeRate } from './handlers/fxRate.js';

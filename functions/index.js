import { initializeApp } from 'firebase-admin/app';

initializeApp();

// Called by the app right after sign-in to create the user record (gen2 callable).
export { ensureUser } from './handlers/ensureUser.js';

// Customer-facing callables.
export { classifyTask } from './handlers/classifyTask.js';   // step 1: estimate
export { createTask } from './handlers/createTask.js';        // step 2: run
export { listMySessions, reviseSession, approveFix, confirmQuote, declineQuote } from './handlers/customerTasks.js'; // view + revise + approve + big-job quotes

// Operator-only admin callables — credits live at the organisation level.
export {
  adminCreateOrg,
  adminAddCredits,
  adminListOrgs,
  adminSetUserOrg,
  adminSetOrgApproval,
  adminSetOrgDeploy,
  adminQuoteTask,
} from './handlers/admin.js';

// Operator: connect an org's GitHub repo (+ token + MCP vault) so fixes can run,
// and run a fix against any org's repo for testing.
export {
  adminSetGithubRepo,
  adminRunFix,
  adminListTasks,
  adminStopTask,
  deployTesting,
  deployProd,
  customerDeployTesting,
  customerDeployProd,
} from './handlers/adminGithub.js';

// Scheduled: finalize finished sessions → bill the org; terminate over-budget ones.
export { pollSessions } from './handlers/pollSessions.js';

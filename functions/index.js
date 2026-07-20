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
// plus the read side: the per-run funnel audit trail (which targets, which queries, what was
// relayed vs dropped and at which gate) and the historical lead ledger.
export {
  adminConfigureSourcing,
  adminDisableSourcing,
  adminRunSourcingNow,
  adminSourceTopTarget,
  adminSourcingRuns,
  adminSourcingRunDetail,
  adminSourcingLeadLedger,
  adminSourcingRelayLead,
} from './handlers/adminSourcing.js';

// Customer-facing (HMAC-signed) read of the org's own sourcing run history — powers the platform
// admin console's "Bosun runs" popup ("did that serve really fetch/scrape/relay?").
export { sourcingRunsFeed } from './handlers/sourcingRunsFeed.js';

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
// Also prices the WhatsApp outreach events (wa_message_delivered / wa_lead_accepted) and can
// replay daily_plan events — see SERVICE_DEFS in the handler.
export { usageMeter } from './handlers/usageMeter.js';

// Nightly admin work-queue planner (daily_plan service line): 01:30 IST cron pulls the platform's
// work-state, allocates per-admin task plans (utils/planTasks.js — the ONLY copy of the rules),
// composes Flash briefings, POSTs the plan back, settles ₹/plan-day. sourcingPlanNow is the
// platform's 07:00 IST on-demand safety trigger (same HMAC as usageMeter).
export { planDailyTasks, sourcingPlanNow } from './handlers/planDailyTasks.js';

// Nightly Session Intelligence (02:30 IST): classify yesterday's sessions into intent segments,
// build the daily demand map, refresh the engagement message library (EN+TA, {count}-grounded),
// flag anomalies, deliver the engagement-pack to the platform. Covered by the base fee up to the
// monthly session pool (org.sessionMeter.<yyyymm> counts toward it).
export { sessionIntelligence, settleConversionPopups } from './handlers/sessionIntelligence.js';

// Blog Intelligence (03:00 IST nightly): read each newly-published post, classify its audience
// (buyer/seller/investor/neutral) with Gemini Flash, deliver the verdicts to the platform so the
// blog conversion cards target the right reader. blogClassifyNow is the on-demand test/backfill.
export { blogIntelligence, blogClassifyNow } from './handlers/blogIntelligence.js';

// Composed reports: weekly intelligence (Mon 03:30 IST) + monthly proof-of-value (1st 04:00 IST) —
// deterministic aggregates from our ledgers, Flash prose, delivered to the platform's report ingest.
export { weeklyIntelligence, monthlyProofOfValue } from './handlers/intelligenceReports.js';

// Weekly SEO report (seo_weekly_report service line): Mon 05:00 IST cron pulls Search Console for
// the last complete week, computes WoW tables deterministically, re-scores last week's action items
// (the accountability loop), Flash narrates, delivers to the platform's /api/ingest/seo-report,
// settles a banded flat fee on the ack. seoReportNow is the on-demand/test trigger (same HMAC).
export { weeklySeoReport, seoReportNow } from './handlers/seoWeeklyReport.js';

// Scheduled: refresh the cached live USD->INR rate the billing path converts COGS at.
export { refreshExchangeRate } from './handlers/fxRate.js';

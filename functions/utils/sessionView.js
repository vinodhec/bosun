import { MAX_FREE_REVISIONS } from './billing.js';

// Customer-safe projection of a task document → the "session" shape the dashboard renders.
// SHARED by listMySessions (standalone fixes) and listMyFeatures (a feature's active step) so
// the two never drift. NEVER includes operator-only fields (PR link, model, raw API cost,
// margin). `userCanDeployProd` is the per-user go-live grant, applied to canDeployProd.
export function sessionView(t, id, { userCanDeployProd = false, deploy = null } = {}) {
  const merged = !!(t.deployedTesting || t.deployedProd);
  const pendingReview = !!t.pendingReview;
  // Firebase-host orgs have no automatic preview — the owner deploys a branch to the testing
  // site on demand (previewTesting) and can put it back (revertTesting). `deploy` carries the
  // org's { host, testingUrl }. Vercel orgs ignore all of this (host defaults to 'vercel').
  const deployHost = deploy?.host || 'vercel';
  const isFirebase = deployHost === 'firebase';
  const previewable = isFirebase && t.status === 'complete' && !!t.prUrl && !merged;
  return {
    id,
    problem: t.prompt ?? '',
    status: t.status ?? null, // queued | running | complete | failed | needs_quote | quoted | cancelled
    complexity: t.complexity ?? null,
    quoteInr: t.status === 'quoted' ? (Number(t.priceInr) || 0) : null,
    summary: t.resultSummary ?? null,
    idealDescription: t.idealDescription || '',
    idealKeywords: Array.isArray(t.idealKeywords)
      ? t.idealKeywords
          .map((k) => ({ phrase: String(k?.phrase || ''), why: String(k?.why || '') }))
          .filter((k) => k.phrase && k.why)
          .slice(0, 5)
      : [],
    changes: Array.isArray(t.filesChanged)
      ? t.filesChanged.map((f) => String(f?.description || '')).filter(Boolean).slice(0, 12)
      : [],
    previewUrl: t.previewUrl ?? null,
    // "deploying" covers the Vercel preview poll, an in-flight Firebase deploy, and the brief
    // window after a Firebase fix is ready but before the poller has dispatched the auto-deploy.
    buildingPreview: !!t.needsPreview || !!t.previewDeploying || !!t.needsAutoDeploy,
    // Firebase preview/revert surface (all false/absent for Vercel orgs).
    deployHost,
    testingUrl: deploy?.testingUrl || null,
    previewActive: !!t.previewActive,
    previewError: t.previewError || null,
    previewStartedAt: t.previewRequestedAt?.toMillis?.() ?? null, // anchors the "deploying" timer

    canPreview: previewable && !t.previewDeploying,
    canRevert: isFirebase && !!t.previewActive && !merged && !t.previewDeploying,
    // Money: what they've already paid, and what tapping "Looks good" will charge now.
    paidInr: Number(t.finalCharge) || 0,
    owedInr: pendingReview ? Number(t.currentRoundCharge) || 0 : 0,
    ciChargeInr: Number(t.ciChargeInr) || 0, // at-cost test-site/CI run charges, metered per run
    ciRunCount: Number(t.ciRunCount) || 0,

    priceInr: t.priceInr ?? null,
    // Approval state (approve-before-charge): a finished round waits for the customer.
    pendingReview,
    approved: !!t.approved,
    freeRevisionsLeft: Math.max(0, MAX_FREE_REVISIONS - (Number(t.freeRevisionsUsed) || 0)),
    // The change request currently being applied — echoed while it runs.
    revisePrompt: t.revisePrompt ?? null,
    // The iteration thread: initial fix + each revision.
    rounds: Array.isArray(t.rounds)
      ? t.rounds.map((r) => ({
          kind: r.kind || 'initial', // 'initial' | 'unresolved' | 'new_scope'
          prompt: String(r.prompt || ''),
          summary: String(r.summary || ''),
          changes: Array.isArray(r.changes)
            ? r.changes.map((c) => String(c || '')).filter(Boolean).slice(0, 12)
            : [],
          idealDescription: String(r.idealDescription || ''),
          idealKeywords: Array.isArray(r.idealKeywords)
            ? r.idealKeywords
                .map((k) => ({ phrase: String(k?.phrase || ''), why: String(k?.why || '') }))
                .filter((k) => k.phrase && k.why)
                .slice(0, 5)
            : [],
          briefScore: Number(r.briefScore) || 0,
          addedInr: Number(r.addedInr) || 0,
          free: r.kind !== 'initial' && (Number(r.addedInr) || 0) === 0,
          charged: !!r.charged,
          at: r.at ?? null,
        }))
      : [],
    canApprove: t.status === 'complete' && pendingReview,
    canRevise: t.status === 'complete' && !merged,
    // Self-deploy: finished + approved (paid / auto-charged) and it produced a PR. Testing is
    // open to every org member; going live (production) needs the per-user grant.
    canDeployTesting: t.status === 'complete' && t.approved === true && !!t.prUrl && !t.deployedProd,
    canDeployProd: userCanDeployProd && t.status === 'complete' && t.approved === true && !!t.prUrl && !t.deployedProd,
    deployedTesting: !!t.deployedTesting,
    deployedProd: !!t.deployedProd,
    deployed: merged,
    // Sharing state for the "Share with my team" control on a finished fix (token builds the link).
    shared: !!t.shared,
    shareToken: t.shareToken || null,
    forkedFromTaskId: t.forkedFromTaskId || null,
    createdAt: t.createdAt?.toMillis?.() ?? null,
  };
}

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { startDesignSession, replyDesignSession, buildForkSeedAsk, MAX_CLARIFY_TURNS } from '../utils/designSession.js';
import { designContextFromText } from '../utils/figma.js';
import { firebaseSAsFromSecret, uploadImagesToFiles } from '../utils/claudeAgent.js';
import { agentIdForModel } from '../utils/routeModel.js';
import { sanitizeImages } from '../utils/images.js';
import { sanitizeDocuments } from '../utils/documents.js';
import { resolveOrgId, isMember } from '../utils/orgs.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// "Design a screen" — a clarify-first flow that previews a NEW screen as a live HTML mock the owner
// approves BEFORE any real build. The clarify chat + mock render run as a CODE-AWARE managed-agent
// session (clones the repo, learns the site's look, never edits) — async, so it's a tasks/{id} of
// kind:'design' that pollSessions finalizes turn by turn. The design phase is charged like planning
// (priceForPlanning = 2× its real COGS) when a mock is ready; the real build after approval is a
// normal fix, charged the bracketed way. Nothing is charged or built until the owner acts.
//
// designs/{id}.status: clarifying → mockup_review → building → complete (failed on a bad session).

// Operational caps for the design SESSION (exploration + a text mock — cheap; no screenshots).
// Cumulative across clarify turns + refines, since they resume the same session.
const DESIGN_MAX_USD = 1.5;
const DESIGN_MAX_SEC = 1800;

async function loadOrgCtx(db, orgId) {
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = orgSnap.data();
  const gh = org.github;
  if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secretData = secretSnap.exists ? secretSnap.data() : {};
  if (!secretData.githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  return { org, gh, secretData };
}

// Start (or restart, after a fresh prompt) the design session and record it as a kind:'design' task
// pollSessions will finalize. Returns the task id. `ask` is the text the mock is based on.
async function dispatchDesignSession(db, { designId, userId, orgId, org, gh, secretData, ask, imageFileIds = [], screenshotCount = 0, images = [], documents = [] }) {
  const figmaDesign = await designContextFromText({ org, secretData, text: ask });
  const firebaseSAs = firebaseSAsFromSecret(secretData);
  const { sessionId, firebaseFileIds } = await startDesignSession({
    ask,
    repoUrl: `https://github.com/${gh.repoFullName}`,
    githubToken: secretData.githubToken,
    vaultId: gh.vaultId,
    agentId: agentIdForModel('sonnet'),
    firebaseSAs,
    figmaDesign,
    imageFileIds,
    screenshotCount,
    images, // freshly attached marked-up screenshots (base64), in addition to persisted ones
    documents,
  });
  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    userId,
    orgId,
    designId,
    kind: 'design',
    status: 'running',
    sessionId,
    firebaseFileIds: firebaseFileIds || [],
    model: 'sonnet',
    maxBudgetUsd: DESIGN_MAX_USD,
    maxSeconds: DESIGN_MAX_SEC,
    reviewedCostUsd: 0,
    reviewedSeconds: 0,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { taskId: taskRef.id, sessionId };
}

// "Design a screen": kick off the clarify + mock session. We persist the owner's screenshots once
// (Files API) so they carry into the design AND the build, fetch any Figma design, and start the
// session. The design is created `clarifying`; NOTHING is charged or built yet.
export const planDesign = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const prompt = String(request.data?.prompt ?? '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Please describe the screen you want.');
  const images = sanitizeImages(request.data?.images);
  // Reference documents (a content plan, copy, a spec) informing the screen. Inline text.
  const documents = sanitizeDocuments(request.data?.documents);

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');
  const { org, gh, secretData } = await loadOrgCtx(db, orgId);

  const screenshotFileIds = await uploadImagesToFiles(images);

  const designRef = db.collection('designs').doc();
  await designRef.set({
    userId: uid,
    orgId,
    prompt,
    repoFullName: gh.repoFullName,
    status: 'clarifying',
    awaitingOwner: false,
    turns: [{ role: 'owner', text: prompt, at: Date.now() }],
    brief: '',
    mockUrl: null,
    screenshotFileIds,
    imageCount: images.length,
    designChargeInr: 0,
    designCostUsd: 0,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { taskId, sessionId } = await dispatchDesignSession(db, {
      designId: designRef.id, userId: uid, orgId, org, gh, secretData,
      ask: prompt, imageFileIds: screenshotFileIds, screenshotCount: images.length, documents,
    });
    await designRef.update({ designTaskId: taskId, sessionId });
  } catch (e) {
    console.error('planDesign:dispatch', designRef.id, e?.message || e);
    await designRef.update({ status: 'failed', error: 'design_dispatch_failed' });
    throw new HttpsError('internal', 'We could not start designing this screen. You were not charged.');
  }

  return { designId: designRef.id };
});

// Owner answers the agent's clarifying questions → resume the SAME session with their reply.
export const replyToClarify = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const designId = String(request.data?.designId ?? '').trim();
  const answer = String(request.data?.answer ?? '').trim();
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');
  if (!answer) throw new HttpsError('invalid-argument', 'Please type your answer.');

  const db = getFirestore();
  const designRef = db.collection('designs').doc(designId);
  const snap = await designRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Design not found.');
  const d = snap.data();
  if (d.userId !== uid) throw new HttpsError('permission-denied', 'Not your design.');
  if (d.status !== 'clarifying' || !d.awaitingOwner) throw new HttpsError('failed-precondition', 'NOT_AWAITING');
  if (!d.sessionId || !d.designTaskId) throw new HttpsError('failed-precondition', 'NO_SESSION');
  const ownerTurns = (Array.isArray(d.turns) ? d.turns : []).filter((t) => t.role === 'owner').length;
  if (ownerTurns > MAX_CLARIFY_TURNS) throw new HttpsError('failed-precondition', 'TOO_MANY_REPLIES');

  await designRef.update({
    turns: FieldValue.arrayUnion({ role: 'owner', text: answer.slice(0, 1000), at: Date.now() }),
    awaitingOwner: false,
  });
  try {
    await replyDesignSession({ sessionId: d.sessionId, answer });
    await db.collection('tasks').doc(d.designTaskId).update({ status: 'running' });
  } catch (e) {
    console.error('replyToClarify', designId, e?.message || e);
    await designRef.update({ awaitingOwner: true }); // let them retry
    throw new HttpsError('internal', 'We could not send your answer. Please try again.');
  }
  return { ok: true };
});

// Owner wants the mock changed before building → resume the session with the change; a fresh mock is
// produced and charged like the first (priceForPlanning), same as reviseFeaturePlan.
export const refineMockup = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const designId = String(request.data?.designId ?? '').trim();
  const changes = String(request.data?.changes ?? '').trim();
  // The owner may attach marked-up screenshots showing the change they want — base64, validated/capped.
  const images = sanitizeImages(request.data?.images);
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');
  if (!changes && images.length === 0) throw new HttpsError('invalid-argument', 'Please describe the change you want.');

  const db = getFirestore();
  const designRef = db.collection('designs').doc(designId);
  const snap = await designRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Design not found.');
  const d = snap.data();
  if (d.userId !== uid) throw new HttpsError('permission-denied', 'Not your design.');
  if (d.status !== 'mockup_review') throw new HttpsError('failed-precondition', 'NOT_REVIEWABLE');

  // A FORKED design (a teammate's copy of a shared design) has the approved mock + chat but no live
  // session — resuming the original's session would entangle two owners on one thread. So its first
  // change starts a FRESH session seeded from the mock + prior chat. A normal design (and a fork that
  // has already refined once) has a session and simply resumes it.
  const isFork = !d.sessionId || !d.designTaskId;

  // The change as plain text (the marked-up screenshots, if any, carry the rest of the meaning).
  const changeText = changes || 'See the attached marked-up screenshot(s) for the change I want.';
  const turnText = changes
    ? changes.slice(0, 1000)
    : `🖼️ ${images.length} marked-up screenshot${images.length > 1 ? 's' : ''}`;

  await designRef.update({
    status: 'clarifying',
    awaitingOwner: false,
    turns: FieldValue.arrayUnion({ role: 'owner', text: turnText, at: Date.now() }),
  });
  try {
    if (isFork) {
      const { org, gh, secretData } = await loadOrgCtx(db, d.orgId);
      // A fork's fresh session must NOT re-reference old Files-API IDs (they may have been deleted —
      // that terminates the session). The approved mock HTML (in buildForkSeedAsk) is the visual
      // reference; only freshly attached marked-up screenshots ride along, as inline base64.
      const { taskId, sessionId } = await dispatchDesignSession(db, {
        designId, userId: uid, orgId: d.orgId, org, gh, secretData,
        ask: buildForkSeedAsk(d, changeText),
        imageFileIds: [],
        screenshotCount: images.length,
        images,
      });
      await designRef.update({ designTaskId: taskId, sessionId });
    } else {
      await replyDesignSession({ sessionId: d.sessionId, answer: `Please change the mockup: ${changeText}`, images });
      await db.collection('tasks').doc(d.designTaskId).update({ status: 'running' });
    }
  } catch (e) {
    console.error('refineMockup', designId, e?.message || e);
    await designRef.update({ status: 'mockup_review' }); // leave the existing mock intact to retry
    throw new HttpsError('internal', 'We could not start that change. Your mockup is unchanged.');
  }
  return { ok: true };
});

// Return the mock's raw HTML to its OWNER only. The browser shows the mock in a cross-origin,
// sandboxed iframe (from Storage), which it cannot draw onto a canvas — so to let the owner mark it
// up and capture a screenshot, we re-render this HTML same-origin in the browser. Read-only,
// owner-gated; kept OUT of listMyDesigns so that projection stays lean (the HTML is tens of KB).
export const getDesignMockHtml = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const designId = String(request.data?.designId ?? '').trim();
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');

  const db = getFirestore();
  const snap = await db.collection('designs').doc(designId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Design not found.');
  if (snap.data().userId !== uid) throw new HttpsError('permission-denied', 'Not your design.');
  return { mockHtml: snap.data().mockHtml || '' };
});

// ─── Share & fork a design ──────────────────────────────────────────────────────────────────────
// A teammate can SHARE a finished design (the approved mock + the chat) with another member of the
// SAME organisation, who FORKS it into their own design and builds their own version from there.
// Same org ⇒ same repo + same wallet, so a fork is just a working copy — no new billing. All
// cross-member access goes through these callables (Admin SDK) returning a safe projection; we never
// open the owner-only design doc to other members via rules.

// A signed-in member of the design's org (read from their own users doc). Throws if not a member.
async function requireOrgMember(db, uid, orgId) {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!isMember(userSnap.exists ? userSnap.data() : null, orgId)) {
    throw new HttpsError('permission-denied', 'NOT_A_MEMBER');
  }
}

// Load a shared design and verify the requester may see it (member of its org + sharing on + token
// matches). Returns { ref, d }. The token is an unguessable capability so designIds can't be probed.
async function loadSharedDesign(db, uid, designId, shareToken) {
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');
  const ref = db.collection('designs').doc(designId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'NOT_FOUND');
  const d = snap.data();
  if (!d.shared || !d.shareToken || d.shareToken !== String(shareToken || '')) {
    throw new HttpsError('permission-denied', 'NOT_SHARED');
  }
  await requireOrgMember(db, uid, d.orgId);
  return { ref, d };
}

// Owner turns sharing ON for a finished design (a real mock exists). Mints a capability token for the
// link (reused if already shared). Returns the token so the client can build the share URL.
export const shareDesign = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const designId = String(request.data?.designId ?? '').trim();
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');

  const db = getFirestore();
  const ref = db.collection('designs').doc(designId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Design not found.');
  const d = snap.data();
  if (d.userId !== uid) throw new HttpsError('permission-denied', 'Not your design.');
  if (!['mockup_review', 'handed_off'].includes(d.status)) {
    throw new HttpsError('failed-precondition', 'NOT_SHAREABLE'); // nothing to share until a mock exists
  }
  const shareToken = d.shareToken || randomUUID();
  await ref.update({ shared: true, shareToken, sharedBy: uid, sharedAt: FieldValue.serverTimestamp() });
  return { ok: true, shareToken };
});

// Owner turns sharing OFF — existing links stop working (the token check still passes but `shared`
// is false, so loadSharedDesign rejects).
export const unshareDesign = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const designId = String(request.data?.designId ?? '').trim();
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');

  const db = getFirestore();
  const ref = db.collection('designs').doc(designId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Design not found.');
  if (snap.data().userId !== uid) throw new HttpsError('permission-denied', 'Not your design.');
  await ref.update({ shared: false });
  return { ok: true };
});

// A teammate opens a share link — read-only view of the mock + chat. Strips all operator/internal
// fields (session, task, cost). Same projection discipline as listMyDesigns.
export const getSharedDesign = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();
  const { d } = await loadSharedDesign(db, uid, String(request.data?.designId ?? '').trim(), request.data?.shareToken);
  return {
    design: {
      prompt: d.prompt || '',
      brief: d.brief || '',
      mockUrl: d.mockUrl || null,
      // The raw mock HTML so the teammate can mark it up: the displayed iframe is cross-origin and
      // can't be drawn onto, so the markup tool re-renders this same-origin to screenshot it.
      mockHtml: d.mockHtml || '',
      turns: Array.isArray(d.turns) ? d.turns : [],
      status: d.status || 'mockup_review',
      forkable: true,
      isOwn: d.userId === uid, // the owner opening their own link — no point forking
    },
  };
});

// A teammate forks the shared design into their OWN design (same org/repo). Instant + free: we copy
// the approved mock + chat + design context; no managed-agent session starts here. The fork lands in
// mockup_review so they can approve it as-is or request changes (refineMockup's fork path starts a
// fresh session on the first change). Returns the new designId.
export const forkDesign = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();
  const sourceId = String(request.data?.designId ?? '').trim();
  const { d } = await loadSharedDesign(db, uid, sourceId, request.data?.shareToken);
  if (d.userId === uid) throw new HttpsError('failed-precondition', 'ALREADY_YOURS'); // your own design

  const forkRef = db.collection('designs').doc();
  await forkRef.set({
    userId: uid,
    orgId: d.orgId,
    prompt: `(Building on a shared design) ${d.prompt || ''}`.slice(0, 1000),
    repoFullName: d.repoFullName,
    status: 'mockup_review',
    awaitingOwner: false,
    turns: Array.isArray(d.turns) ? d.turns : [],
    brief: d.brief || '',
    mockUrl: d.mockUrl || null,
    mockHtml: d.mockHtml || null,
    scope: d.scope || 'new_page',
    changeSummary: d.changeSummary || '',
    keepUnchanged: d.keepUnchanged || '',
    steps: Array.isArray(d.steps) ? d.steps : [],
    // Deliberately DO NOT carry the original's screenshotFileIds: those Anthropic Files-API IDs were
    // uploaded at the original's plan time and may no longer exist — re-referencing them in the fork's
    // fresh session terminates it ("a file referenced in this conversation no longer exists"). The fork
    // carries the approved mock HTML as its visual reference instead; the owner can attach fresh ones.
    screenshotFileIds: [],
    imageCount: 0,
    designChargeInr: 0,
    designCostUsd: 0,
    sessionId: null,
    designTaskId: null,
    forkedFromDesignId: sourceId,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, designId: forkRef.id };
});

// Owner approves the mock → HAND OFF into the "Plan a feature" pipeline, PREPOPULATED from the design
// (no re-plan, no planning charge): a features/{id} is created in plan_review with the proposed steps
// (the design session already broke the build down) shown for the owner to edit, while the full design
// context (approved mock, scope, the whole clarify Q&A, build notes) rides behind the scenes into each
// build step. Returns { featureId } so the client can redirect to it.
export const approveDesign = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const designId = String(request.data?.designId ?? '').trim();
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');
  // The owner may add extra build instructions when approving — these ride into the build handoff.
  const notes = String(request.data?.notes ?? '').trim().slice(0, 1500);

  const db = getFirestore();
  const designRef = db.collection('designs').doc(designId);
  const snap = await designRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Design not found.');
  const d = snap.data();
  if (d.userId !== uid) throw new HttpsError('permission-denied', 'Not your design.');
  if (d.status !== 'mockup_review') throw new HttpsError('failed-precondition', 'NOT_REVIEWABLE');
  if (!d.brief) throw new HttpsError('failed-precondition', 'NO_MOCK');

  // Prepopulate the steps from what the design session proposed. If none parsed (older designs / a
  // parse miss), fall back to a single whole-screen step so the screen always builds.
  const proposed = Array.isArray(d.steps) && d.steps.length
    ? d.steps
    : [{ title: 'Build the screen', description: d.brief || d.prompt || '', kind: 'static' }];
  const steps = proposed.map((s) => ({
    title: s.title || '',
    description: s.description || '',
    kind: s.kind === 'dynamic' ? 'dynamic' : 'static',
    status: 'proposed',
    taskId: null,
  }));

  try {
    const featureRef = db.collection('features').doc();
    await featureRef.set({
      userId: uid,
      orgId: d.orgId,
      prompt: d.brief || d.prompt || '',
      repoFullName: d.repoFullName,
      status: 'plan_review',
      currentStep: 0,
      steps,
      // Carried so every step keeps the owner's original screenshots (persisted at design time).
      screenshotFileIds: Array.isArray(d.screenshotFileIds) ? d.screenshotFileIds : [],
      imageCount: Number(d.imageCount) || 0,
      planningChargeInr: 0, // no planning session ran — the design phase already did (and was paid for) the thinking
      // Where this feature came from + the behind-the-scenes build context (mock, scope, full Q&A,
      // notes) handed to each step's agent (see featureRun.buildAgentPrompt → designRun.buildDesignHandoff).
      fromDesign: true,
      designId,
      design: {
        mockHtml: d.mockHtml || '',
        mockUrl: d.mockUrl || '',
        scope: d.scope || 'new_page',
        changeSummary: d.changeSummary || '',
        keepUnchanged: d.keepUnchanged || '',
        brief: d.brief || '',
        originalPrompt: d.prompt || '',
        turns: Array.isArray(d.turns) ? d.turns : [],
        buildNotes: notes || '',
      },
      createdAt: FieldValue.serverTimestamp(),
    });
    // Link the design to its feature and mark it handed off — the design card now points at the feature.
    await designRef.update({ status: 'handed_off', featureId: featureRef.id, buildNotes: notes || null });
    // The design session task is done with its job (clarify + mock); stop polling it.
    if (d.designTaskId) await db.collection('tasks').doc(d.designTaskId).update({ status: 'complete' }).catch(() => {});
    return { ok: true, featureId: featureRef.id };
  } catch (e) {
    console.error('approveDesign', designId, e?.message || e);
    throw new HttpsError('internal', 'We could not hand this off to a feature. You were not charged.');
  }
});

// Customer-facing view of their designs, newest first: the clarify chat and the live mock URL (for
// the iframe) through review, then — once approved — a pointer to the feature it was handed off to
// (the build lives there, step by step). Strips operator-only fields.
export const listMyDesigns = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();

  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) return { designs: [] };

  const snap = await db
    .collection('designs')
    .where('userId', '==', uid)
    .where('orgId', '==', orgId)
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  if (snap.empty) return { designs: [] };

  const designs = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      prompt: d.prompt || '',
      status: d.status || 'clarifying', // clarifying | mockup_review | handed_off | failed
      awaitingOwner: !!d.awaitingOwner,
      turns: Array.isArray(d.turns) ? d.turns : [],
      brief: d.brief || '',
      mockUrl: d.mockUrl || null,
      // Explained, opt-in "make it even better" enhancements shown under the mock while reviewing.
      // Only surface ones that carry a real "why" — the explanation is the whole point (older/partial
      // entries without one are hidden rather than shown as a bare title).
      suggestions: (Array.isArray(d.suggestions) ? d.suggestions : []).filter((s) => s && s.title && s.why && s.change),
      designChargeInr: Number(d.designChargeInr) || 0,
      totalPaidInr: Number(d.designChargeInr) || 0,
      // Once approved, the build runs as a feature — the card links across to it.
      featureId: d.featureId || null,
      // Sharing state for the "Share with my team" control (token builds the link).
      shared: !!d.shared,
      shareToken: d.shareToken || null,
      forkedFromDesignId: d.forkedFromDesignId || null,
      createdAt: d.createdAt?.toMillis?.() ?? null,
    };
  });

  return { designs };
});

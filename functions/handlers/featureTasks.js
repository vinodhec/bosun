import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { breakdownFeature } from '../utils/featurePlan.js';
import { startFeatureStep } from '../utils/featureRun.js';
import { sessionView } from '../utils/sessionView.js';
import { priceForPlanning } from '../utils/billing.js';
import { sanitizeImages } from '../utils/images.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// "Plan a feature": one Sonnet call breaks the owner's request into an ordered list of fix-
// sized steps. We charge for the breakdown IMMEDIATELY (PLANNING_MULTIPLIER × its actual cost —
// priceForPlanning), store the plan as features/{id}, and start the first step. Each step then
// runs and is charged exactly like a standalone fix; deploying a step to testing advances to
// the next (advanceFeature, fired from deployTaskToTesting). Re-planning = a new planFeature
// call, charged separately.
export const planFeature = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const prompt = String(request.data?.prompt ?? '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Please describe the feature you want.');
  const images = sanitizeImages(request.data?.images);

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = userSnap.exists ? userSnap.data().orgId : null;
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const gh = orgSnap.data().github;
  if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');

  // Break it down FIRST — this is the cost we bill PLANNING_MULTIPLIER× of. Validate the repo
  // before spending it, so a customer without a connected site is never charged.
  let steps;
  let costUsd;
  try {
    ({ steps, costUsd } = await breakdownFeature(prompt, { images }));
  } catch (e) {
    console.error('planFeature:breakdown', e?.message || e);
    throw new HttpsError('internal', 'We could not plan this feature. You were not charged.');
  }
  const planningChargeInr = priceForPlanning(costUsd);

  // Charge the breakdown immediately + create the feature, atomically. Balance may go negative
  // (the operator reconciles), exactly like a fix charge in finalize.js.
  const featureRef = db.collection('features').doc();
  const orgRef = db.collection('organisations').doc(orgId);
  await db.runTransaction(async (tx) => {
    const oSnap = await tx.get(orgRef);
    const balance = oSnap.exists ? Number(oSnap.data().balance ?? 0) : 0;
    if (planningChargeInr > 0) {
      tx.update(orgRef, { balance: balance - planningChargeInr });
      tx.set(db.collection('transactions').doc(), {
        orgId,
        userId: uid,
        type: 'debit',
        amount: planningChargeInr,
        featureId: featureRef.id,
        kind: 'planning',
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.set(featureRef, {
      userId: uid,
      orgId,
      prompt,
      repoFullName: gh.repoFullName,
      status: 'running',
      currentStep: 0,
      planningCostUsd: costUsd,       // internal COGS (analytics) — never shown to the customer
      planningChargeInr,              // the 2× planning charge actually debited
      steps: steps.map((s) => ({ title: s.title, description: s.description, status: 'pending', taskId: null })),
      imageCount: images.length,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  // Start step 1 (session dispatch is a network call — outside the transaction). If it fails to
  // start, the feature still exists (planning was paid for) and the owner can retry the step.
  try {
    await startFeatureStep(db, featureRef.id, 0);
  } catch (e) {
    console.error('planFeature:startStep0', featureRef.id, e?.message || e);
  }

  return { featureId: featureRef.id, steps: steps.length, planningChargeInr };
});

// Customer-facing view of their features, newest first. Reads each feature + its steps' tasks
// and composes a safe view: per-step status, the running total paid, and the FULL session view
// of the active step (so the dashboard reuses the normal fix card for approve / request-changes
// / deploy on it). Step status is recomputed from the actual tasks so the view can't drift.
export const listMyFeatures = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();

  const userSnap = await db.collection('users').doc(uid).get();
  const userCanDeployProd = userSnap.exists && userSnap.data().canDeployProd === true;

  const snap = await db
    .collection('features')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  if (snap.empty) return { features: [] };

  // Batch-load every step's task in one round-trip.
  const taskIds = [];
  for (const d of snap.docs) {
    for (const s of d.data().steps || []) if (s.taskId) taskIds.push(s.taskId);
  }
  const taskById = {};
  if (taskIds.length) {
    const taskSnaps = await db.getAll(...taskIds.map((id) => db.collection('tasks').doc(id)));
    for (const ts of taskSnaps) if (ts.exists) taskById[ts.id] = ts.data();
  }

  const features = snap.docs.map((d) => {
    const f = d.data();
    const rawSteps = Array.isArray(f.steps) ? f.steps : [];

    let paidStepsInr = 0;
    let activeIndex = -1;
    let lastTaskId = null;
    const steps = rawSteps.map((s, i) => {
      const t = s.taskId ? taskById[s.taskId] : null;
      const deployed = !!(t && (t.deployedTesting || t.deployedProd));
      // Status from the task itself (source of truth): no task = pending; deployed = done;
      // failed = failed; anything in between = running (the active step).
      let status;
      if (!t) status = 'pending';
      else if (deployed) status = 'done';
      else if (t.status === 'failed') status = 'failed';
      else status = 'running';

      if (t) {
        paidStepsInr += Number(t.finalCharge) || 0;
        lastTaskId = s.taskId;
      }
      if ((status === 'running' || status === 'failed') && activeIndex === -1) activeIndex = i;

      return {
        title: s.title || '',
        description: s.description || '',
        status,
        summary: t?.resultSummary ?? null,
        paidInr: t ? Number(t.finalCharge) || 0 : 0,
        // Full session view ONLY for the active step — it drives approve / request-changes /
        // deploy via the existing fix card. Other steps stay lightweight.
        session: t && (status === 'running' || status === 'failed') ? sessionView(t, s.taskId, { userCanDeployProd }) : null,
      };
    });

    const allDone = rawSteps.length > 0 && steps.every((st) => st.status === 'done');
    const planningChargeInr = Number(f.planningChargeInr) || 0;

    return {
      id: d.id,
      prompt: f.prompt || '',
      status: allDone ? 'complete' : 'running',
      stepCount: rawSteps.length,
      currentStep: activeIndex === -1 ? rawSteps.length : activeIndex,
      planningChargeInr,
      totalPaidInr: planningChargeInr + paidStepsInr,
      steps,
      // Once every step is on testing (i.e. merged to main), one go-live tags main and
      // publishes the whole feature at once. Gated by the per-user production grant.
      canGoLive: allDone && userCanDeployProd && !!lastTaskId,
      goLiveTaskId: allDone ? lastTaskId : null,
      createdAt: f.createdAt?.toMillis?.() ?? null,
    };
  });

  return { features };
});

// Retry the current step of a feature when it failed to run (or never started). Re-dispatches
// the step as a fresh task — failed runs were never charged, and planning was already paid, so
// no new charge. Refuses if the current step is still running or already finished.
export const retryFeatureStep = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const featureId = String(request.data?.featureId ?? '').trim();
  if (!featureId) throw new HttpsError('invalid-argument', 'featureId required.');

  const db = getFirestore();
  const fSnap = await db.collection('features').doc(featureId).get();
  if (!fSnap.exists) throw new HttpsError('not-found', 'Feature not found.');
  const f = fSnap.data();
  if (f.userId !== uid) throw new HttpsError('permission-denied', 'Not your feature.');

  const stepIndex = Number(f.currentStep) || 0;
  const cur = f.steps?.[stepIndex];
  if (cur?.taskId) {
    const tSnap = await db.collection('tasks').doc(cur.taskId).get();
    if (tSnap.exists && tSnap.data().status !== 'failed') {
      throw new HttpsError('failed-precondition', 'NOT_RETRYABLE');
    }
  }

  try {
    await startFeatureStep(db, featureId, stepIndex);
  } catch (e) {
    console.error('retryFeatureStep', featureId, e?.message || e);
    throw new HttpsError('internal', 'We could not start this step. You were not charged.');
  }
  return { ok: true };
});

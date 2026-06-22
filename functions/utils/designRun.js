import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { classifyComplexity } from './classify.js';
import { startFixSession, firebaseSAsFromSecret } from './claudeAgent.js';
import { designContextFromText } from './figma.js';
import { modelForComplexity, agentIdForModel } from './routeModel.js';
import { tierFor } from './billing.js';

// The real build for an approved design. It's an ORDINARY fix task carrying `designId`: same
// pipeline, same bracketed charge on completion, same testing→go-live deploy. The only difference
// from a standalone fix is the instruction — it adds the agreed NEW screen rather than fixing a bug —
// and that listMySessions hides it (it shows inside the design card). Mirrors featureRun.startFeatureStep.

function buildAgentPrompt(design) {
  return (
    `A website owner approved a design for a NEW screen to add to their site. Build it for real.\n\n` +
    `What to build:\n"${design.brief || design.prompt}"\n\n` +
    `Add this as a new screen/page in the project at /workspace/repo, built in the repo's EXISTING ` +
    `framework, components, design tokens and styling — it must look like it belongs on the site (the ` +
    `owner already approved a mockup in that style). Wire it into the site's navigation/routing where it ` +
    `naturally belongs. Read AGENTS.md first if present. Do NOT add new dependencies or a separate style ` +
    `system. If any screenshots or a design image are attached, use them as the reference for how the ` +
    `screen should look. Commit to a new branch, push it, and open a pull request.\n\n` +
    `Then reply with a short, friendly, plain-English summary (no technical jargon). On the VERY LAST ` +
    `line, append a machine-readable result (the user won't see it):\n` +
    `RESULT_JSON: {"summary":"<one friendly sentence>","filesChanged":[{"fileName":"<file>","description":"<plain English>"}],"prUrl":"<pull request url>"}`
  );
}

async function loadRepoContext(db, orgId) {
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  const gh = orgSnap.exists ? orgSnap.data().github : null;
  if (!gh?.repoFullName || !gh?.vaultId) throw new Error('NO_REPO_CONNECTED');
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secretData = secretSnap.exists ? secretSnap.data() : {};
  const githubToken = secretData.githubToken;
  if (!githubToken) throw new Error('NO_REPO_CONNECTED');
  return { gh, githubToken, firebaseSAs: firebaseSAsFromSecret(secretData), org: orgSnap.data(), secretData };
}

/**
 * Build the approved design for real. Classifies the brief, writes tasks/{id} carrying designId,
 * dispatches the managed-agent session (with the owner's screenshots + any Figma), and returns the
 * task id. Flows through the NORMAL fix finalize path (pollSessions → markRoundReady, bracketed
 * charge). On dispatch failure the task is marked failed and the error rethrown.
 */
export async function startDesignBuild(db, designId) {
  const designRef = db.collection('designs').doc(designId);
  const dSnap = await designRef.get();
  if (!dSnap.exists) throw new Error('design_not_found');
  const design = dSnap.data();

  const { gh, githubToken, firebaseSAs, org, secretData } = await loadRepoContext(db, design.orgId);

  // Enrich the build with any Figma link the owner pasted + the screenshots they attached (persisted
  // once at design time as Files API ids) — exactly like a feature step / standalone fix.
  const figmaDesign = await designContextFromText({ org, secretData, text: design.prompt || '' });
  const imageFileIds = Array.isArray(design.screenshotFileIds) ? design.screenshotFileIds : [];

  // The owner sees the design card; the agent gets the build framing. Classify on the brief.
  const displayPrompt = design.brief || design.prompt || '';
  const agentPrompt = buildAgentPrompt(design);
  const { complexity: raw } = await classifyComplexity(displayPrompt);
  const complexity = raw === 'large' ? 'complex' : raw; // a scoped screen always runs, never parks
  const tier = tierFor(complexity);
  const model = modelForComplexity(complexity);

  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    userId: design.userId,
    orgId: design.orgId,
    prompt: displayPrompt,
    repoFullName: gh.repoFullName,
    // Links this task to its design. listMySessions filters these out (they show inside the design
    // card); deploying one goes through the normal testing→go-live path.
    designId,
    kind: 'initial',
    complexity,
    model,
    status: 'queued',
    billed: false,
    approved: false,
    pendingReview: false,
    maxBudgetUsd: tier.maxBudgetUsd,
    maxSeconds: tier.maxSeconds,
    currentRoundCharge: 0,
    finalCharge: 0,
    freeRevisionsUsed: 0,
    pendingRound: { kind: 'initial', reason: null, addedInr: 0, prompt: displayPrompt },
    imageCount: imageFileIds.length,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { sessionId, firebaseFileIds } = await startFixSession({
      prompt: agentPrompt,
      images: [],
      imageFileIds,
      repoUrl: `https://github.com/${gh.repoFullName}`,
      githubToken,
      vaultId: gh.vaultId,
      agentId: agentIdForModel(model),
      firebaseSAs,
      figmaDesign,
      instruction: agentPrompt, // the complete build instruction (already PR + RESULT_JSON framed)
    });
    await taskRef.update({ status: 'running', sessionId, firebaseFileIds: firebaseFileIds || [] });
  } catch (e) {
    await taskRef.update({ status: 'failed', error: 'dispatch_failed' });
    throw e;
  }

  return taskRef.id;
}

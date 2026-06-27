// The handoff from an approved design into a feature build. An approved design no longer runs as a
// standalone fix — approveDesign prepopulates a feature from it (no re-plan, no planning charge) and
// it builds step by step through the feature pipeline. Each build step's agent still needs the full
// design context so it builds exactly what was approved and ONLY what was asked: this module produces
// that context block, which featureRun.buildAgentPrompt prepends to the step framing.

// The design context handed to the builder for a design-origin feature step: the owner's original
// words, the full clarify conversation, the agreed brief, the scope (new page vs change-in-place +
// what must stay untouched), the APPROVED mock markup as the visual target, and any extra build notes
// the owner added at approval. NO PR / RESULT_JSON framing — buildFixPrompt (via startFixSession's
// `prompt`) adds that, and featureRun adds the "step N of M" framing.
export function buildDesignHandoff(design = {}) {
  const turns = Array.isArray(design.turns) ? design.turns : [];
  const convo = turns.length
    ? `The conversation while we agreed the design (full context):\n` +
      turns.map((t) => `${t.role === 'owner' ? 'Owner' : 'Designer'}: ${t.text}`).join('\n') + '\n\n'
    : '';
  const scopeNote = design.scope === 'modify'
    ? `IMPORTANT — this is a CHANGE to something that ALREADY exists on the site, NOT a new page.\n` +
      `The approved mockup below is the COMPLETE, final design the owner signed off — it already reflects ` +
      `EVERY change they asked for across the whole design conversation, not just their last message. ` +
      `Build ALL of it; do not drop earlier changes.\n` +
      (design.changeSummary ? `The full set of changes to make: ${design.changeSummary}\n` : '') +
      (design.keepUnchanged
        ? `Leave UNRELATED parts of the page exactly as they are — in particular: ${design.keepUnchanged}.\n`
        : `Do NOT redesign, restructure or restyle parts of the page the mockup doesn't change.\n`) +
      `Find the EXISTING component/section in the repo and edit it IN PLACE. Do NOT create a new page or ` +
      `rebuild the surrounding page.\n`
    : `Add this as a NEW page/screen and wire it into the site's navigation/routing where it belongs.\n`;
  const mockHtml = String(design.mockHtml || '');
  const mockUrl = String(design.mockUrl || '');
  const mockNote = mockHtml
    ? `\nThe owner APPROVED this exact mockup. Reproduce its look — layout, spacing, colours, fonts, ` +
      `proportions — faithfully, but built in the repo's REAL framework, components and design tokens (do ` +
      `NOT paste this HTML into the app; it is a VISUAL REFERENCE only).` +
      (design.scope === 'modify' ? ` The mock may show surrounding context — only apply the CHANGED part.` : ``) +
      (mockUrl ? `\nYou can open the approved mock rendered live here: ${mockUrl}` : ``) +
      `\nAPPROVED MOCKUP:\n\`\`\`html\n${mockHtml.slice(0, 20000)}\n\`\`\`\n`
    : '';
  const notesNote = design.buildNotes
    ? `\nThe owner added these extra instructions for the build — follow them:\n"${design.buildNotes}"\n`
    : '';
  return (
    `This build comes from a design the owner already approved with us.\n` +
    `What the owner originally asked for:\n"${design.originalPrompt || ''}"\n\n` +
    convo +
    `The agreed result:\n"${design.brief || design.originalPrompt || ''}"\n\n` +
    scopeNote +
    mockNote +
    notesNote
  );
}

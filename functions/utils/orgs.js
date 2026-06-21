// Multi-org membership helpers.
//
// A user can belong to one or more organisations (`users.orgIds`), with exactly one selected
// as active (`users.activeOrgId`). The legacy single `users.orgId` field (and the matching
// custom claim) is kept as a MIRROR of the active org so older reads keep working during and
// after the migration. Reads in firestore.rules are gated on the `orgIds` claim (membership),
// so switching the active org is purely an app concern — it never needs a token refresh.

// Every org the user belongs to. Falls back to the legacy single `orgId` for un-migrated users.
export function memberOrgIds(userData) {
  if (!userData) return [];
  const ids = Array.isArray(userData.orgIds) ? userData.orgIds.filter(Boolean) : [];
  if (ids.length) return [...new Set(ids)];
  return userData.orgId ? [userData.orgId] : [];
}

// Is the user a member of this org?
export function isMember(userData, orgId) {
  return !!orgId && memberOrgIds(userData).includes(orgId);
}

// The org a request should act on: the explicitly requested org if the user is a member of it,
// else the user's active org, else their first/only org. Returns null if they have no orgs.
export function resolveOrgId(userData, requestedOrgId) {
  const ids = memberOrgIds(userData);
  const requested = String(requestedOrgId || '').trim();
  if (requested && ids.includes(requested)) return requested;
  const active = userData?.activeOrgId;
  if (active && ids.includes(active)) return active;
  return ids[0] || null;
}

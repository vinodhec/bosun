// Minimal Trello REST wrappers used by the "Plan a feature" flow. Trello authenticates with
// an API key + a per-user OAuth token (NOT a static bearer like our GitHub/Jam MCP creds), so
// every call carries both as query params. The key+token live ONLY in orgSecrets/{orgId} (the
// vault — client-unreadable) and are passed in here by the backend; they never reach the
// browser. nodejs22 has a global `fetch`, so there's no SDK dependency.

const API = 'https://api.trello.com/1';

function authQuery(key, token, extra = {}) {
  const p = new URLSearchParams({ key, token, ...extra });
  return p.toString();
}

async function call(method, path, key, token, params = {}) {
  if (!key || !token) throw new Error('NO_TRELLO_CREDENTIALS');
  const url = `${API}${path}?${authQuery(key, token, params)}`;
  const res = await fetch(url, { method, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`trello_${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 300);
    throw err;
  }
  // Some endpoints (rare) return empty bodies; guard the JSON parse.
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** The boards the connected member can see. Returns [{ id, name, url }]. */
export async function listBoards({ key, token }) {
  const boards = await call('GET', '/members/me/boards', key, token, {
    fields: 'name,url',
    filter: 'open',
  });
  return Array.isArray(boards)
    ? boards.map((b) => ({ id: b.id, name: b.name || '(untitled board)', url: b.url || '' }))
    : [];
}

/** The lists (columns) on a board. Returns [{ id, name }]. */
export async function lists({ key, token, boardId }) {
  if (!boardId) throw new Error('NO_BOARD');
  const ls = await call('GET', `/boards/${boardId}/lists`, key, token, { fields: 'name' });
  return Array.isArray(ls) ? ls.map((l) => ({ id: l.id, name: l.name || '(untitled list)' })) : [];
}

/** Create one card in a list. Returns { id, url } (short url when available). */
export async function createCard({ key, token, listId, name, desc }) {
  if (!listId) throw new Error('NO_LIST');
  const card = await call('POST', '/cards', key, token, {
    idList: listId,
    name: String(name || 'Untitled task').slice(0, 16384),
    desc: String(desc || '').slice(0, 16384),
    pos: 'bottom',
  });
  return { id: card?.id || '', url: card?.shortUrl || card?.url || '' };
}

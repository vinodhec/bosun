// Share an invoice over WhatsApp. wa.me with a prefilled text works on phones (opens the app with
// a contact picker) and on desktop (WhatsApp Web), so one path serves both. The message already
// carries the public invoice link (minted server-side) — nothing else is needed.
export function shareOnWhatsApp(message) {
  const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
  const w = window.open(url, '_blank', 'noopener');
  if (!w) window.location.href = url;
}

/** Best-effort clipboard copy; resolves true on success. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

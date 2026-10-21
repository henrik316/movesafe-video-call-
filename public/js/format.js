export function formatWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCode(id) {
  if (!id) return '';
  if (id.length === 8) return `${id.slice(0, 4)} ${id.slice(4)}`;
  return id;
}

export function routeLabel(origin, destination) {
  if (origin && destination) return `${origin} → ${destination}`;
  return origin || destination || '';
}

export function inviteText({ customerName, link }) {
  const first = String(customerName || 'there').trim().split(/\s+/)[0];
  return `Hi ${first} — your MoveSafe Relocation video walkthrough is ready.

Join from your phone or computer. There is no app to install:
${link}

This visit may be recorded so we can prepare your estimate. A red banner appears on screen for everyone while recording is on.

Tip: use the rear camera to walk through each room.`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

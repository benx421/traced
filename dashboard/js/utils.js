import { FETCH_TIMEOUT_MS } from './constants.js';

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toBigIntNs(val) {
  const s = String(val ?? 0).split('.')[0];
  return s === '' ? 0n : BigInt(s);
}

export function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

export function showToast(message, ok) {
  const el = document.createElement('div');
  el.className = `px-3 py-2 rounded text-xs shadow-lg transition-opacity duration-300
    ${ok ? 'bg-green-900 text-green-300 border border-green-700'
          : 'bg-red-900 text-red-300 border border-red-700'}`;
  el.textContent = message;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

export function sanitizeTargetURL(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch { return null; }
}

export function copyToClipboard(text) {
  navigator.clipboard.writeText(text)
    .then(() => showToast('Trace ID copied', true))
    .catch(() => showToast('Copy failed', false));
}

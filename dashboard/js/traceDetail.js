import { STATUS_OK, NS_PER_MS, PCT_SCALE, MIN_BAR_WIDTH_PCT, DEPTH_INDENT_PX, FETCH_TIMEOUT_MS } from './constants.js';
import { escHtml, toBigIntNs, fetchWithTimeout, copyToClipboard } from './utils.js';
import { serviceColor } from './colors.js';
import { targetURL } from './state.js';

let selectedTraceId  = null;
let detailRequestId  = 0;
let silentController = null;

export function getSelectedTraceId() { return selectedTraceId; }

export function resetDetail() {
  if (silentController) { silentController.abort(); silentController = null; }
  selectedTraceId = null;
  detailRequestId = 0;
  document.getElementById('detail-panel').style.height = '0';
  document.getElementById('trace-detail').innerHTML =
    '<div class="text-center text-gray-600 text-xs py-10">Click a trace to inspect</div>';
  document.getElementById('detail-header-bar').innerHTML =
    '<span class="text-xs text-gray-500 uppercase tracking-widest select-none">Trace Detail</span>';
}

function computeDepths(spans) {
  const byId  = Object.fromEntries(spans.map(s => [s.span_id, s]));
  const cache = {};
  for (const s of spans) {
    if (cache[s.span_id] !== undefined) continue;
    const path    = [];
    const visited = new Set();
    let cur = s;
    while (cur && cache[cur.span_id] === undefined && !visited.has(cur.span_id)) {
      visited.add(cur.span_id);
      path.push(cur.span_id);
      cur = cur.parent_span_id ? byId[cur.parent_span_id] : null;
    }
    const base = cur ? cache[cur.span_id] : 0;
    for (let i = path.length - 1; i >= 0; i--)
      cache[path[i]] = base + (path.length - 1 - i);
  }
  return cache;
}

export function renderTraceDetail(spans) {
  const traceDetailEl   = document.getElementById('trace-detail');
  const detailHeaderBar = document.getElementById('detail-header-bar');

  if (!spans.length) {
    traceDetailEl.innerHTML = '<div class="text-gray-600 text-xs">No spans found</div>';
    return;
  }

  const sorted = [...spans].sort((a, b) => {
    const diff = toBigIntNs(a.start_time) - toBigIntNs(b.start_time);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  });

  const root      = sorted.find(s => !s.parent_span_id) || sorted[0];
  const rootStart = toBigIntNs(root.start_time);
  const rootEnd   = toBigIntNs(root.end_time);
  const rootNs    = rootEnd - rootStart || 1n;
  const rootMs    = Number(rootNs) / NS_PER_MS;
  const rootColor = serviceColor(root.service);
  const traceId   = selectedTraceId || '';

  detailHeaderBar.innerHTML = `
    <span class="text-xs font-medium">
      <span style="color:${rootColor}">${escHtml(root.service)}</span><span class="text-gray-500">/</span><span class="text-gray-200">${escHtml(root.operation)}</span>
    </span>
    <span class="text-xs px-1.5 py-0.5 rounded ${root.status === STATUS_OK ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}">
      ${escHtml(root.status)}
    </span>
    <button id="copy-trace-btn" data-traceid="${escHtml(traceId)}"
      class="ml-1 font-mono text-gray-600 hover:text-gray-300 text-xs transition-colors cursor-pointer"
      title="Copy full trace ID">
      ${escHtml(traceId.slice(0, 8))}…
    </button>
    <span class="text-gray-500 text-xs ml-auto tabular-nums">${rootMs.toFixed(1)}ms total &middot; ${sorted.length} spans</span>
    <button id="close-detail-btn" class="ml-3 text-gray-600 hover:text-gray-300 transition-colors text-xs leading-none" title="Close">&times;</button>`;

  document.getElementById('copy-trace-btn')
    ?.addEventListener('click', e => copyToClipboard(e.currentTarget.dataset.traceid));
  document.getElementById('close-detail-btn')
    ?.addEventListener('click', resetDetail);

  const depths = computeDepths(spans);

  traceDetailEl.innerHTML = `<div>${sorted.map(span => {
    const d          = depths[span.span_id] || 0;
    const spanStart  = toBigIntNs(span.start_time);
    const spanEnd    = toBigIntNs(span.end_time);
    const spanNs     = spanEnd - spanStart;
    const offsetPct  = Number((spanStart - rootStart) * PCT_SCALE / rootNs) / 100;
    const widthPct   = Math.max(MIN_BAR_WIDTH_PCT, Number(spanNs * PCT_SCALE / rootNs) / 100);
    const durationMs = (Number(spanNs) / NS_PER_MS).toFixed(1);
    const isOk       = span.status === STATUS_OK;
    const barColor   = isOk ? serviceColor(span.service) : '#ef4444';
    const svcColor   = serviceColor(span.service);

    const tagsHtml = span.tags && Object.keys(span.tags).length
      ? `<div class="mt-1 flex flex-wrap gap-1">${Object.entries(span.tags).map(([k, v]) =>
          `<span class="px-1.5 py-0.5 bg-gray-800 rounded text-gray-500 text-xs">${escHtml(k)}=<span class="text-gray-400">${escHtml(v)}</span></span>`
        ).join('')}</div>`
      : '';

    return `
      <div class="mb-2.5" style="padding-left:${d * DEPTH_INDENT_PX}px">
        <div class="flex items-baseline gap-1.5 mb-1">
          <span class="text-xs" style="color:${svcColor}">${escHtml(span.service)}</span>
          <span class="text-gray-500 text-xs">/${escHtml(span.operation)}</span>
          ${!isOk ? '<span class="text-red-500 text-xs font-medium">error</span>' : ''}
          <span class="text-gray-600 text-xs ml-auto tabular-nums">${durationMs}ms</span>
        </div>
        <div class="relative h-3 bg-gray-800/60 rounded overflow-hidden">
          <div class="h-full rounded opacity-80 absolute"
               style="left:${offsetPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${barColor}"></div>
        </div>
        ${tagsHtml}
      </div>`;
  }).join('')}</div>`;
}

export async function silentRefreshDetail() {
  if (!selectedTraceId) return;
  if (silentController) silentController.abort();
  silentController = new AbortController();
  const timer = setTimeout(() => silentController.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${targetURL}/traces/${selectedTraceId}`, { signal: silentController.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = await res.json();
    renderTraceDetail(data.spans || []);
  } catch {
    clearTimeout(timer);
  }
}

export async function loadTrace(traceId) {
  selectedTraceId = traceId;
  const myRequest = ++detailRequestId;

  const traceDetailEl   = document.getElementById('trace-detail');
  const detailHeaderBar = document.getElementById('detail-header-bar');

  document.getElementById('detail-panel').style.height = '300px';
  traceDetailEl.innerHTML = '<div class="text-gray-600 text-xs py-6 text-center">Loading…</div>';
  detailHeaderBar.innerHTML = '<span class="text-xs text-gray-500 uppercase tracking-widest select-none">Trace Detail</span>';

  try {
    const res = await fetchWithTimeout(`${targetURL}/traces/${traceId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (myRequest !== detailRequestId) return;
    renderTraceDetail(data.spans || []);
  } catch (e) {
    if (myRequest !== detailRequestId) return;
    const msg = e.name === 'AbortError' ? 'Request timed out' : e.message;
    traceDetailEl.innerHTML = `<div class="text-red-500 text-xs py-6 text-center">Failed: ${escHtml(msg)}</div>`;
  }
}

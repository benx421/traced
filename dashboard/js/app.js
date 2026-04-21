const STORAGE_KEY      = 'traced-target-url';
const DEFAULT_URL      = 'http://localhost:8080';
const POLL_INTERVAL_MS = 3000;
const TRACE_LIMIT      = 50;
const DEPTH_INDENT_PX  = 20;
const MIN_BAR_WIDTH_PCT = 0.5;
const MS_PER_SEC       = 1000;
const MS_PER_MIN       = 60_000;
const NS_PER_MS        = 1e6;
const PCT_SCALE        = 10000n;
const STATUS_OK        = 'ok';
const FETCH_TIMEOUT_MS = 5000;

function sanitizeTargetURL(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch { return null; }
}

let targetURL       = sanitizeTargetURL(localStorage.getItem(STORAGE_KEY) || DEFAULT_URL) ?? DEFAULT_URL;
let pollTimer       = null;
let selectedTraceId = null;
let detailRequestId = 0;  // incremented on every loadTrace call to cancel stale fetches
let everConnected   = false;
let connecting      = false;
let fetchController  = null;
let silentController = null;

const toastContainer  = document.getElementById('toast-container');
const urlInput        = document.getElementById('target-url');
const connectBtn      = document.getElementById('connect-btn');
const statusDotEl     = document.getElementById('status-dot');
const statusTextEl    = document.getElementById('status-text');
const traceCountEl    = document.getElementById('trace-count');
const traceListEl     = document.getElementById('trace-list');
const traceDetailEl   = document.getElementById('trace-detail');
const detailHeaderBar = document.getElementById('detail-header-bar');

urlInput.value = targetURL;

function showToast(message, ok) {
  const el = document.createElement('div');
  el.className = `px-3 py-2 rounded text-xs shadow-lg transition-opacity duration-300
    ${ok ? 'bg-green-900 text-green-300 border border-green-700'
          : 'bg-red-900 text-red-300 border border-red-700'}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// handles null/undefined and float strings (e.g. "1700000000.5") some exporters emit
function toBigIntNs(val) {
  const s = String(val ?? 0).split('.')[0];
  return s === '' ? 0n : BigInt(s);
}

function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function relativeTime(nanos) {
  // clamp: future timestamps (clock skew) show as "just now"
  const msAgo = Math.max(0, Date.now() - Number(nanos) / NS_PER_MS);
  if (msAgo < MS_PER_SEC) return `${Math.round(msAgo)}ms ago`;
  if (msAgo < MS_PER_MIN) return `${Math.round(msAgo / MS_PER_SEC)}s ago`;
  return `${Math.round(msAgo / MS_PER_MIN)}m ago`;
}

function statusDot(status) {
  const cls = status === STATUS_OK ? 'bg-green-500' : 'bg-red-500';
  return `<span class="inline-block w-2 h-2 rounded-full ${cls} flex-shrink-0 mt-0.5"></span>`;
}

function setConnectionStatus(ok) {
  if (ok) {
    everConnected = true;
    statusDotEl.className = 'w-1.5 h-1.5 rounded-full bg-green-500';
    statusTextEl.textContent = 'live';
    statusTextEl.className = 'text-green-400';
  } else if (everConnected) {
    statusDotEl.className = 'w-1.5 h-1.5 rounded-full bg-red-500';
    statusTextEl.textContent = 'error';
    statusTextEl.className = 'text-red-400';
  }
}

function computeDepths(spans) {
  const byId = Object.fromEntries(spans.map(s => [s.span_id, s]));
  const cache = {};
  for (const s of spans) {
    if (cache[s.span_id] !== undefined) continue;
    const path = [];
    let cur = s;
    while (cur && cache[cur.span_id] === undefined) {
      path.push(cur.span_id);
      cur = cur.parent_span_id ? byId[cur.parent_span_id] : null;
    }
    const base = cur ? cache[cur.span_id] : 0;
    for (let i = path.length - 1; i >= 0; i--)
      cache[path[i]] = base + (path.length - 1 - i);
  }
  return cache;
}

function renderTraceList(traces) {
  traceCountEl.textContent = traces.length || '';

  if (!traces.length) {
    traceListEl.innerHTML = '<div class="px-4 py-10 text-center text-gray-600 text-xs">No traces in window</div>';
    return;
  }

  const prevScrollTop = traceListEl.scrollTop;

  traceListEl.innerHTML = traces.map(t => {
    const sel = t.trace_id === selectedTraceId ? 'bg-gray-800' : '';
    return `
      <div class="trace-row ${sel} flex items-start gap-2 px-3 py-2.5
                  border-b border-gray-800/40 cursor-pointer hover:bg-gray-800/60
                  transition-colors" data-id="${escHtml(t.trace_id)}">
        ${statusDot(t.status)}
        <div class="min-w-0 flex-1">
          <div class="text-gray-200 text-xs truncate leading-tight">
            ${escHtml(t.root_service)}<span class="text-gray-500">/</span>${escHtml(t.root_operation)}
          </div>
          <div class="text-gray-600 text-xs mt-0.5 tabular-nums">
            ${t.span_count} span${t.span_count !== 1 ? 's' : ''} &middot; ${t.duration_ms}ms &middot; ${relativeTime(t.start_time)}
          </div>
        </div>
      </div>`;
  }).join('');

  traceListEl.scrollTop = prevScrollTop;

  traceListEl.querySelectorAll('.trace-row').forEach(row => {
    row.addEventListener('click', () => loadTrace(row.dataset.id));
  });
}

function renderTraceDetail(spans) {
  if (!spans.length) {
    traceDetailEl.innerHTML = '<div class="text-gray-600 text-xs">No spans found</div>';
    return;
  }

  const sorted = [...spans].sort((a, b) => {
    const diff = toBigIntNs(a.start_time) - toBigIntNs(b.start_time);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  });

  const root       = sorted.find(s => !s.parent_span_id) || sorted[0];
  const rootStart  = toBigIntNs(root.start_time);
  const rootEnd    = toBigIntNs(root.end_time);
  const rootSpanNs = rootEnd - rootStart || 1n;
  const rootMs     = Number(rootSpanNs) / NS_PER_MS;

  detailHeaderBar.innerHTML = `
    <span class="text-gray-200 text-xs font-medium">
      ${escHtml(root.service)}<span class="text-gray-500">/</span>${escHtml(root.operation)}
    </span>
    <span class="text-xs px-1.5 py-0.5 rounded ${root.status === STATUS_OK ? 'bg-green-900/50 text-green-400' : 'bg-red-900/50 text-red-400'}">
      ${escHtml(root.status)}
    </span>
    <span class="text-gray-500 text-xs ml-auto tabular-nums">${rootMs.toFixed(1)}ms total · ${sorted.length} spans</span>`;

  const depths = computeDepths(spans);

  const rows = sorted.map(span => {
    const d          = depths[span.span_id] || 0;
    const spanStart  = toBigIntNs(span.start_time);
    const spanEnd    = toBigIntNs(span.end_time);
    const spanNs     = spanEnd - spanStart;
    const offsetPct  = Number((spanStart - rootStart) * PCT_SCALE / rootSpanNs) / 100;
    const widthPct   = Math.max(MIN_BAR_WIDTH_PCT, Number(spanNs * PCT_SCALE / rootSpanNs) / 100);
    const durationMs = (Number(spanNs) / NS_PER_MS).toFixed(1);
    const isOk       = span.status === STATUS_OK;
    const barColor   = isOk ? 'bg-green-600' : 'bg-red-500';
    const nameColor  = isOk ? 'text-green-400' : 'text-red-400';

    const tagsHtml = span.tags && Object.keys(span.tags).length
      ? `<div class="mt-1 flex flex-wrap gap-1">
           ${Object.entries(span.tags).map(([k, v]) =>
             `<span class="px-1.5 py-0.5 bg-gray-800 rounded text-gray-500 text-xs">${escHtml(k)}=<span class="text-gray-400">${escHtml(v)}</span></span>`
           ).join('')}
         </div>`
      : '';

    return `
      <div class="mb-2.5" style="padding-left:${d * DEPTH_INDENT_PX}px">
        <div class="flex items-baseline gap-1.5 mb-1">
          <span class="${nameColor} text-xs">${escHtml(span.service)}</span>
          <span class="text-gray-500 text-xs">/${escHtml(span.operation)}</span>
          <span class="text-gray-600 text-xs ml-auto tabular-nums">${durationMs}ms</span>
        </div>
        <div class="relative h-3 bg-gray-800/60 rounded overflow-hidden">
          <div class="${barColor} h-full rounded opacity-75 absolute"
               style="left:${offsetPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%"></div>
        </div>
        ${tagsHtml}
      </div>`;
  }).join('');

  traceDetailEl.innerHTML = `<div>${rows}</div>`;
}

async function fetchTraces() {
  if (fetchController) fetchController.abort();
  fetchController = new AbortController();
  const timer = setTimeout(() => fetchController.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${targetURL}/traces?limit=${TRACE_LIMIT}`, { signal: fetchController.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setConnectionStatus(true);
    renderTraceList(data.traces || []);
    if (selectedTraceId) silentRefreshDetail();
    return true;
  } catch (e) {
    clearTimeout(timer);
    if (e.name !== 'AbortError') setConnectionStatus(false);
    return false;
  }
}

async function silentRefreshDetail() {
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

async function loadTrace(traceId) {
  selectedTraceId = traceId;
  const myRequest = ++detailRequestId;

  traceListEl.querySelectorAll('.trace-row').forEach(row => {
    row.classList.toggle('bg-gray-800', row.dataset.id === traceId);
  });

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

async function connect() {
  try {
    const res = await fetchWithTimeout(`${targetURL}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setConnectionStatus(true);
    showToast(`Connected to ${targetURL}`, true);
    return true;
  } catch (e) {
    statusDotEl.className = 'w-1.5 h-1.5 rounded-full bg-red-500';
    statusTextEl.textContent = 'error';
    statusTextEl.className = 'text-red-400';
    showToast(e.name === 'AbortError' ? 'Connection timed out' : `Could not connect to ${targetURL}`, false);
    return false;
  }
}

async function startPolling() {
  if (connecting) return;
  connecting = true;
  connectBtn.disabled = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  try {
    const ok = await connect();
    if (ok) {
      fetchTraces();
      pollTimer = setInterval(fetchTraces, POLL_INTERVAL_MS);
    }
  } finally {
    connecting = false;
    connectBtn.disabled = false;
  }
}

connectBtn.addEventListener('click', () => {
  const sanitized = sanitizeTargetURL(urlInput.value);
  if (!sanitized) {
    showToast('Invalid URL — must be http:// or https://', false);
    return;
  }
  targetURL = sanitized;
  urlInput.value = targetURL;
  localStorage.setItem(STORAGE_KEY, targetURL);
  startPolling();
});

urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') connectBtn.click();
});

import { POLL_INTERVAL_MS, TRACE_LIMIT, FETCH_TIMEOUT_MS } from './constants.js';
import { fetchWithTimeout, showToast } from './utils.js';
import { targetURL } from './state.js';
import { renderStats } from './stats.js';
import { plotTraces, resetChart, startRolling, stopRolling, getViewRange } from './chart.js';
import { silentRefreshDetail, getSelectedTraceId, resetDetail } from './traceDetail.js';

let pollTimer       = null;
let fetchController = null;
let everConnected   = false;
let connecting      = false;

export function isPolling() { return pollTimer !== null; }

function setConnectBtnState(connected) {
  const btn = document.getElementById('connect-btn');
  btn.textContent = connected ? 'Disconnect' : 'Connect';
  btn.className   = connected
    ? 'px-3 py-1 bg-gray-700 hover:bg-gray-600 active:bg-gray-800 rounded text-xs font-medium transition-colors select-none text-gray-300'
    : 'px-3 py-1 bg-blue-700 hover:bg-blue-600 active:bg-blue-800 rounded text-xs font-medium transition-colors select-none';
}

export function setConnectionStatus(ok) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (ok) {
    everConnected    = true;
    dot.className    = 'w-1.5 h-1.5 rounded-full bg-green-500';
    text.textContent = 'live';
    text.className   = 'text-green-400';
  } else if (everConnected) {
    dot.className    = 'w-1.5 h-1.5 rounded-full bg-red-500';
    text.textContent = 'error';
    text.className   = 'text-red-400';
  }
}

export function disconnect() {
  if (pollTimer)       { clearInterval(pollTimer); pollTimer = null; }
  if (fetchController) { fetchController.abort(); fetchController = null; }
  everConnected = false;
  stopRolling();
  resetChart();
  resetDetail();

  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className    = 'w-1.5 h-1.5 rounded-full bg-gray-600';
  text.textContent = 'disconnected';
  text.className   = 'text-gray-500';
  setConnectBtnState(false);

  document.getElementById('stat-total').textContent  = '—';
  document.getElementById('stat-errors').textContent = '—';
  document.getElementById('stat-avg').textContent    = '—';
  document.getElementById('stat-p95').textContent    = '—';
}

async function fetchTraces() {
  if (fetchController) fetchController.abort();
  const controller = new AbortController();
  fetchController  = controller;
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const view = getViewRange();
    const rangeParams = view
      ? `&after=${Math.round(view.minT)}&before=${Math.round(view.maxT)}`
      : '';
    const res = await fetch(`${targetURL}/traces?limit=${TRACE_LIMIT}${rangeParams}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data   = await res.json();
    const traces = data.traces || [];
    const total  = data.total ?? traces.length;
    setConnectionStatus(true);
    renderStats(traces, total);
    plotTraces(traces);
    if (getSelectedTraceId()) silentRefreshDetail();
  } catch (e) {
    clearTimeout(timer);
    if (e.name !== 'AbortError') setConnectionStatus(false);
  }
}

async function connect() {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  try {
    const res = await fetchWithTimeout(`${targetURL}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setConnectionStatus(true);
    showToast(`Connected to ${targetURL}`, true);
    return true;
  } catch (e) {
    dot.className    = 'w-1.5 h-1.5 rounded-full bg-red-500';
    text.textContent = 'error';
    text.className   = 'text-red-400';
    showToast(e.name === 'AbortError' ? 'Connection timed out' : `Could not connect to ${targetURL}`, false);
    return false;
  }
}

export async function startPolling() {
  if (connecting) return;
  connecting = true;
  const btn = document.getElementById('connect-btn');
  btn.disabled = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  try {
    const ok = await connect();
    if (ok) {
      setConnectBtnState(true);
      startRolling();
      await fetchTraces();
      pollTimer = setInterval(fetchTraces, POLL_INTERVAL_MS);
    }
  } finally {
    connecting   = false;
    btn.disabled = false;
  }
}

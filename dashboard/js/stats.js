import { STATUS_OK } from './constants.js';

export function p95(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function renderStats(traces, total) {
  const statTotal  = document.getElementById('stat-total');
  const statErrors = document.getElementById('stat-errors');
  const statAvg    = document.getElementById('stat-avg');
  const statP95    = document.getElementById('stat-p95');

  if (!traces.length) {
    statTotal.textContent  = '—';
    statErrors.textContent = '—';
    statErrors.className   = 'tabular-nums text-gray-400';
    statAvg.textContent    = '—';
    statP95.textContent    = '—';
    return;
  }

  const errorCount = traces.filter(t => t.status !== STATUS_OK).length;
  const errorPct   = (errorCount / traces.length * 100).toFixed(1);
  const durations  = traces.map(t => t.duration_ms);
  const avg        = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

  statTotal.textContent  = total ?? traces.length;
  statErrors.textContent = `${errorCount} (${errorPct}%)`;
  statErrors.className   = errorCount > 0 ? 'tabular-nums text-red-400' : 'tabular-nums text-gray-400';
  statAvg.textContent    = `${avg}ms`;
  statP95.textContent    = `${p95(durations)}ms`;
}

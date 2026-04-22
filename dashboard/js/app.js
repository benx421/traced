import { sanitizeTargetURL, showToast } from './utils.js';
import { targetURL, setTargetURL } from './state.js';
import { startPolling, disconnect, isPolling } from './connection.js';
import { initChart, setChartFilter, redraw } from './chart.js';
import { loadTrace } from './traceDetail.js';

document.getElementById('target-url').value = targetURL;

initChart(loadTrace);

document.getElementById('connect-btn').addEventListener('click', () => {
  if (isPolling()) { disconnect(); return; }
  const sanitized = sanitizeTargetURL(document.getElementById('target-url').value);
  if (!sanitized) { showToast('Invalid URL — must be http:// or https://', false); return; }
  setTargetURL(sanitized);
  document.getElementById('target-url').value = sanitized;
  startPolling();
});

document.getElementById('target-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('connect-btn').click();
});

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setChartFilter(btn.dataset.filter);
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

new ResizeObserver(redraw).observe(document.getElementById('chart-container'));

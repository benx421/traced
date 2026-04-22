import { STATUS_OK } from './constants.js';
import { serviceColor } from './colors.js';
import { escHtml } from './utils.js';

const R_MIN = 2;
const R_MAX = 5;
const PAD   = { l: 44, r: 16, t: 16, b: 26 };

let _traces   = [];
let _filter   = 'all';
let _onSelect = null;
let _dots     = [];
let _rafId    = null;

// View state: null means "auto-fit to data"
let _viewMinT = null;
let _viewMaxT = null;
let _dataMinT = 0;
let _dataMaxT = 0;

let _drag    = null;
let _didDrag = false; // true if the last mousedown produced actual movement

export function initChart(selectCallback) {
  _onSelect = selectCallback;
  const canvas = document.getElementById('chart-canvas');
  canvas.addEventListener('mousemove',  _onMouseMove);
  canvas.addEventListener('mouseleave', _onMouseLeave);
  canvas.addEventListener('mousedown',  _onMouseDown);
  canvas.addEventListener('click',      _onClick);
  canvas.addEventListener('wheel',      _onWheel, { passive: false });
  canvas.addEventListener('dblclick',   _resetView);
  window.addEventListener('mousemove',  _onWindowMouseMove);
  window.addEventListener('mouseup',    _onMouseUp);
}

export function startRolling() {
  if (_rafId) return;
  let last = 0;
  const tick = ts => {
    _rafId = requestAnimationFrame(tick);
    if (ts - last < 250) return; // ~4 fps
    last = ts;
    _draw();
  };
  _rafId = requestAnimationFrame(tick);
}

export function stopRolling() {
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
}

export function plotTraces(incoming) {
  _traces = incoming;
  _draw();
}

export function setChartFilter(f) {
  _filter = f;
  _draw();
}

export function resetChart() {
  _traces   = [];
  _dots     = [];
  _viewMinT = null;
  _viewMaxT = null;
  const canvas = document.getElementById('chart-canvas');
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  _hideTooltip();
}

export function redraw() { _draw(); }

export function getViewRange() {
  if (_viewMinT === null) return null;
  return { minT: _viewMinT, maxT: _viewMaxT };
}

function _resetView() {
  _viewMinT = null;
  _viewMaxT = null;
  _draw();
}

function _visible() {
  if (_filter === 'ok')    return _traces.filter(t => t.status === STATUS_OK);
  if (_filter === 'error') return _traces.filter(t => t.status !== STATUS_OK);
  return _traces;
}

function _draw() {
  const canvas = document.getElementById('chart-canvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth;
  const H   = canvas.offsetHeight;
  if (!W || !H) return;

  const bW = Math.round(W * dpr), bH = Math.round(H * dpr);
  if (canvas.width !== bW || canvas.height !== bH) {
    canvas.width  = bW;
    canvas.height = bH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cL = PAD.l, cR = W - PAD.r, cT = PAD.t, cB = H - PAD.b;
  const cW = cR - cL, cH = cB - cT;

  const vis = _visible();

  if (!vis.length) {
    _dots = [];
    ctx.fillStyle = 'rgba(107,114,128,0.35)';
    ctx.font      = '11px ui-monospace,monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No traces. connect and emit spans', W / 2, H / 2);
    return;
  }

  // X axis: data range with 5% padding. Minimum 2 s so a tight cluster
  // doesn't collapse to a vertical line.
  let dataMinT = Infinity, dataMaxT = -Infinity, maxD = 1, maxS = 1;
  for (const t of vis) {
    if (t.start_time  < dataMinT) dataMinT = t.start_time;
    if (t.start_time  > dataMaxT) dataMaxT = t.start_time;
    if (t.duration_ms > maxD)     maxD     = t.duration_ms;
    if (t.span_count  > maxS)     maxS     = t.span_count;
  }
  const dataSpan = Math.max(dataMaxT - dataMinT, 2e9);
  const autoPad  = dataSpan * 0.05;
  _dataMinT = dataMinT - autoPad;
  _dataMaxT = dataMaxT + autoPad;

  const minT = _viewMinT ?? _dataMinT;
  const maxT = _viewMaxT ?? _dataMaxT;

  const xOf = t  => cL + ((t - minT) / (maxT - minT)) * cW;
  const yOf = ms => cB - (ms / maxD) * cH;
  const rOf = s  => R_MIN + Math.sqrt(s / maxS) * (R_MAX - R_MIN);

  ctx.font      = '9px ui-monospace,monospace';
  ctx.textAlign = 'right';
  [0.25, 0.5, 0.75, 1.0].forEach(f => {
    const y = cB - f * cH;
    ctx.strokeStyle = 'rgba(75,85,99,0.22)';
    ctx.lineWidth   = 0.5;
    ctx.beginPath(); ctx.moveTo(cL, y); ctx.lineTo(cR, y); ctx.stroke();
    ctx.fillStyle = 'rgba(107,114,128,0.5)';
    ctx.fillText(`${Math.round(maxD * f)}ms`, cL - 4, y + 3);
  });

  const fmtTs = ns => {
    const d  = new Date(Math.round(ns / 1e6));
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  };
  ctx.fillStyle = 'rgba(107,114,128,0.45)';
  ctx.font      = '9px ui-monospace,monospace';
  ctx.textAlign = 'left';
  ctx.fillText(fmtTs(minT), cL, H - 8);
  ctx.textAlign = 'right';
  ctx.fillText(fmtTs(maxT), cR, H - 8);

  if (_viewMinT !== null) {
    ctx.strokeStyle = 'rgba(59,130,246,0.25)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(cL, cT, cW, cH);
    ctx.fillStyle = 'rgba(107,114,128,0.35)';
    ctx.font      = '9px ui-monospace,monospace';
    ctx.textAlign = 'right';
    ctx.fillText('double-click to reset view', cR, cT + 11);
  }

  _dots = [];
  for (const t of vis) {
    const x   = xOf(t.start_time);
    if (x < cL - R_MAX || x > cR + R_MAX) continue;
    const y    = yOf(t.duration_ms);
    const r    = rOf(t.span_count);
    const isErr = t.status !== STATUS_OK;
    const color = isErr ? '#ef4444' : serviceColor(t.root_service);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle   = color + 'b0';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.stroke();

    _dots.push({ x, y, r, traceId: t.trace_id, isError: isErr,
                 service: t.root_service, op: t.root_operation,
                 durationMs: t.duration_ms, spanCount: t.span_count });
  }
}

function _hitTest(mx, my) {
  for (let i = _dots.length - 1; i >= 0; i--) {
    const d = _dots[i];
    if ((mx - d.x) ** 2 + (my - d.y) ** 2 <= (d.r + 2) ** 2) return d;
  }
  return null;
}

function _canvasXY(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function _onMouseMove(e) {
  if (_drag) return;
  const [mx, my] = _canvasXY(this, e);
  const hit = _hitTest(mx, my);
  this.style.cursor = hit ? 'pointer' : (_viewMinT !== null ? 'grab' : 'default');
  if (hit) _showTooltip(e, hit); else _hideTooltip();
}

function _onMouseLeave() {
  if (_drag) return;
  this.style.cursor = 'default';
  _hideTooltip();
}

function _onMouseDown(e) {
  if (e.button !== 0) return;
  const [mx, my] = _canvasXY(this, e);
  if (_hitTest(mx, my)) return; // let click handle dot selection
  _didDrag = false;
  _drag = {
    startX:    e.clientX,
    originMin: _viewMinT ?? _dataMinT,
    originMax: _viewMaxT ?? _dataMaxT,
  };
  this.style.cursor = 'grabbing';
  e.preventDefault();
}

function _onWindowMouseMove(e) {
  if (!_drag) return;
  _didDrag = true;
  const canvas = document.getElementById('chart-canvas');
  const cW     = canvas.offsetWidth - PAD.l - PAD.r;
  const rangeNs = _drag.originMax - _drag.originMin;
  const shift   = -((e.clientX - _drag.startX) / cW) * rangeNs;
  _viewMinT = _drag.originMin + shift;
  _viewMaxT = _drag.originMax + shift;
  _draw();
}

function _onMouseUp() {
  if (!_drag) return;
  _drag = null;
  const canvas = document.getElementById('chart-canvas');
  if (canvas) canvas.style.cursor = _viewMinT !== null ? 'grab' : 'default';
}

function _onWheel(e) {
  e.preventDefault();
  const canvas = document.getElementById('chart-canvas');
  const [mx]   = _canvasXY(canvas, e);
  const cL     = PAD.l;
  const cW     = canvas.offsetWidth - PAD.l - PAD.r;
  const minT   = _viewMinT ?? _dataMinT;
  const maxT   = _viewMaxT ?? _dataMaxT;
  const fx     = Math.max(0, Math.min(1, (mx - cL) / cW));
  const pivot  = minT + fx * (maxT - minT);
  const factor = e.deltaY > 0 ? 1.25 : 0.8; // wheel-down = zoom out, wheel-up = zoom in
  _viewMinT = pivot - (pivot - minT) * factor;
  _viewMaxT = pivot + (maxT - pivot) * factor;
  _draw();
}

function _onClick(e) {
  if (_didDrag) { _didDrag = false; return; }
  const [mx, my] = _canvasXY(this, e);
  const hit = _hitTest(mx, my);
  if (hit && _onSelect) _onSelect(hit.traceId);
}

function _showTooltip(e, dot) {
  const tt = document.getElementById('chart-tooltip');
  if (!tt) return;
  const color = dot.isError ? '#ef4444' : serviceColor(dot.service);
  tt.innerHTML = `
    <div class="font-medium mb-0.5" style="color:${color}">${escHtml(dot.service)}</div>
    <div class="text-gray-400">${escHtml(dot.op)}</div>
    <div class="text-gray-500 mt-1 tabular-nums">${dot.durationMs}ms &middot; ${dot.spanCount} span${dot.spanCount !== 1 ? 's' : ''}${dot.isError ? ' &middot; <span class="text-red-400">error</span>' : ''}</div>`;
  tt.classList.remove('hidden');

  const container = document.getElementById('chart-container');
  const rect      = container.getBoundingClientRect();
  let left = e.clientX - rect.left + 14;
  let top  = e.clientY - rect.top  + 14;
  tt.style.left = `${left}px`;
  tt.style.top  = `${top}px`;

  requestAnimationFrame(() => {
    const tw = tt.offsetWidth, th = tt.offsetHeight;
    if (left + tw > rect.width  - 8) left = e.clientX - rect.left - tw - 14;
    if (top  + th > rect.height - 8) top  = e.clientY - rect.top  - th - 14;
    tt.style.left = `${Math.max(4, left)}px`;
    tt.style.top  = `${Math.max(4, top)}px`;
  });
}

function _hideTooltip() {
  document.getElementById('chart-tooltip')?.classList.add('hidden');
}

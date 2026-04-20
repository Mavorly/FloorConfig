// SVG canvas rendering, pan/zoom, selection, and manual board dragging.

import { state } from './state.js';
import { roomBBox, roomRects, pointInRoom, formatLen, polygonEdges } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let svg;
let gRoot;    // transform group (zoom/pan)
let gGrid;
let gRoom;
let gBoards;
let gOverlay;
let gDraw;    // polygon-draw preview layer (in-progress outline)

// callbacks registered from app.js
let onSelect = () => {};
let onMoveEnd = () => {};
let onCursor = () => {};
let onDrawComplete = () => {};
let onDrawCancel = () => {};

// Ephemeral draw-mode state (not undo-tracked).
let draftPoly = [];          // committed vertices
let draftCursor = null;      // snapped pointer position in room coords

export function initCanvas(root, opts) {
  svg = root;
  onSelect = opts.onSelect || onSelect;
  onMoveEnd = opts.onMoveEnd || onMoveEnd;
  onCursor = opts.onCursor || onCursor;
  onDrawComplete = opts.onDrawComplete || onDrawComplete;
  onDrawCancel = opts.onDrawCancel || onDrawCancel;

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  gRoot = el('g', { id: 'root' });
  gGrid = el('g', { id: 'grid' });
  gRoom = el('g', { id: 'room' });
  gBoards = el('g', { id: 'boards' });
  gOverlay = el('g', { id: 'overlay' });
  gDraw = el('g', { id: 'draw' });
  gRoot.append(gGrid, gRoom, gBoards, gOverlay, gDraw);
  svg.append(gRoot);

  // Pan with middle mouse or shift+drag; zoom with wheel.
  let panning = false, lastX = 0, lastY = 0;
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.pow(1.0015, -e.deltaY);
    const pt = clientToRoom(e.clientX, e.clientY);
    state.view.zoom *= factor;
    state.view.zoom = Math.min(Math.max(state.view.zoom, 0.05), 50);
    const pt2 = clientToRoom(e.clientX, e.clientY);
    state.view.pan.x += pt2.x - pt.x;
    state.view.pan.y += pt2.y - pt.y;
    applyTransform();
  }, { passive: false });

  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || e.shiftKey) {
      panning = true; lastX = e.clientX; lastY = e.clientY;
      svg.setPointerCapture(e.pointerId);
      svg.style.cursor = 'grabbing';
      return;
    }
    if (state.view.drawing && e.button === 0) {
      const pt = snapDrawPoint(clientToRoom(e.clientX, e.clientY));
      // Close if clicking near the first vertex (with >=3 verts).
      if (draftPoly.length >= 3 && near(pt, draftPoly[0])) {
        finishDraft();
        return;
      }
      // Enforce orthogonal constraint after the first vertex.
      const prev = draftPoly[draftPoly.length - 1];
      const next = prev ? orthogonalize(prev, pt) : pt;
      draftPoly.push(next);
      renderDraft();
      e.preventDefault();
    }
  });
  svg.addEventListener('pointermove', (e) => {
    const pt = clientToRoom(e.clientX, e.clientY);
    onCursor(pt);
    if (panning) {
      const dx = (e.clientX - lastX);
      const dy = (e.clientY - lastY);
      lastX = e.clientX; lastY = e.clientY;
      const { scale } = getDisplayMetrics();
      state.view.pan.x += dx / scale;
      state.view.pan.y += dy / scale;
      applyTransform();
    }
    if (state.view.drawing) {
      draftCursor = snapDrawPoint(pt);
      renderDraft();
    }
  });
  svg.addEventListener('pointerup', (e) => {
    if (panning) {
      panning = false;
      svg.releasePointerCapture(e.pointerId);
      svg.style.cursor = '';
    }
  });
  svg.addEventListener('pointerleave', () => onCursor(null));
  svg.addEventListener('dblclick', (e) => {
    if (state.view.drawing && draftPoly.length >= 3) {
      finishDraft();
      e.preventDefault();
    }
  });

  // Clicking on empty canvas clears selection.
  svg.addEventListener('click', (e) => {
    if (state.view.drawing) return; // swallowed by pointerdown logic
    if (e.target === svg || e.target === gRoot || e.target.dataset?.type === 'room-fill') {
      onSelect(null);
    }
  });
}

// ---- Draw mode ----

export function startDrawing() {
  state.view.drawing = true;
  draftPoly = [];
  draftCursor = null;
  svg.style.cursor = 'crosshair';
  renderDraft();
}

export function cancelDrawing() {
  state.view.drawing = false;
  draftPoly = [];
  draftCursor = null;
  svg.style.cursor = '';
  renderDraft();
  onDrawCancel();
}

export function undoDrawPoint() {
  if (!state.view.drawing) return;
  draftPoly.pop();
  renderDraft();
}

function finishDraft() {
  if (draftPoly.length < 3) return;
  // Close path orthogonally back to the first vertex.
  const first = draftPoly[0];
  const last = draftPoly[draftPoly.length - 1];
  const poly = draftPoly.slice();
  if (Math.abs(last.x - first.x) > 1e-6 && Math.abs(last.y - first.y) > 1e-6) {
    // Need an L-shaped closure. Pick axis opposite to the last edge so we keep
    // alternating axes.
    const prev = poly[poly.length - 2] || first;
    const lastHoriz = Math.abs(last.y - prev.y) < 1e-6;
    poly.push(lastHoriz ? { x: last.x, y: first.y } : { x: first.x, y: last.y });
  }
  // Remove duplicate/collinear vertices.
  const cleaned = dedupeCollinear(poly);
  if (cleaned.length < 4) { cancelDrawing(); return; }
  state.view.drawing = false;
  draftPoly = [];
  draftCursor = null;
  svg.style.cursor = '';
  renderDraft();
  onDrawComplete(cleaned);
}

function snapDrawPoint(pt) {
  const step = Math.max(state.view.snapStep || 1, 0.0625);
  return { x: Math.round(pt.x / step) * step, y: Math.round(pt.y / step) * step };
}

function orthogonalize(prev, pt) {
  const dx = Math.abs(pt.x - prev.x);
  const dy = Math.abs(pt.y - prev.y);
  if (dx >= dy) return { x: pt.x, y: prev.y }; // horizontal
  return { x: prev.x, y: pt.y };               // vertical
}

function near(a, b) {
  const tol = Math.max(state.view.snapStep || 1, 0.25) * 0.75;
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

function dedupeCollinear(poly) {
  const out = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-6 || Math.abs(last.y - p.y) > 1e-6) out.push(p);
  }
  // Drop collinear middle vertices.
  const r = [];
  for (let i = 0; i < out.length; i++) {
    const a = out[(i - 1 + out.length) % out.length];
    const b = out[i];
    const c = out[(i + 1) % out.length];
    const abH = Math.abs(a.y - b.y) < 1e-6;
    const bcH = Math.abs(b.y - c.y) < 1e-6;
    if (abH && bcH) continue;
    if (!abH && !bcH) continue;
    r.push(b);
  }
  return r;
}

function renderDraft() {
  while (gDraw.firstChild) gDraw.removeChild(gDraw.firstChild);
  if (!state.view.drawing) return;
  if (!draftPoly.length) return;

  // Segments between committed vertices.
  const pts = draftPoly.slice();
  const preview = draftCursor && pts.length
    ? orthogonalize(pts[pts.length - 1], draftCursor)
    : null;
  const all = preview ? [...pts, preview] : pts;

  const polyPath = all.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  gDraw.append(el('path', {
    d: polyPath, fill: 'none', stroke: '#4ea1ff', 'stroke-width': 0.4,
    'stroke-dasharray': preview ? '2 2' : '',
  }));

  // Vertex markers.
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    gDraw.append(el('circle', {
      cx: p.x, cy: p.y, r: i === 0 ? 1.2 : 0.8,
      fill: i === 0 ? '#ffd36b' : '#4ea1ff',
      stroke: '#0a0d12', 'stroke-width': 0.2,
    }));
  }
  if (preview) {
    gDraw.append(el('circle', {
      cx: preview.x, cy: preview.y, r: 0.8,
      fill: '#7dd3fc', stroke: '#0a0d12', 'stroke-width': 0.2,
    }));
    // Live dimension label on the in-progress edge.
    const last = pts[pts.length - 1];
    const len = Math.hypot(preview.x - last.x, preview.y - last.y);
    if (len > 1e-6) {
      gDraw.append(edgeLabel(last, preview, formatLen(len, state.units), '#7dd3fc'));
    }
  }

  // Dimension labels on committed edges.
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 1e-6) gDraw.append(edgeLabel(a, b, formatLen(len, state.units), '#c9e6ff'));
  }
}

function edgeLabel(a, b, text, color) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const horizontal = Math.abs(a.y - b.y) < 1e-6;
  const dx = horizontal ? 0 : 2;
  const dy = horizontal ? -1.2 : 0;
  const g = el('g', {});
  g.append(el('text', {
    x: mx + dx, y: my + dy,
    'text-anchor': horizontal ? 'middle' : 'start',
    'dominant-baseline': horizontal ? 'auto' : 'central',
    fill: color, 'font-size': 2.2,
    'font-family': 'system-ui, sans-serif',
    'paint-order': 'stroke', stroke: '#0a0d12', 'stroke-width': 0.6,
  }, [ document.createTextNode(text) ]));
  return g;
}

function el(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) {
    if (attrs[k] == null) continue;
    n.setAttribute(k, attrs[k]);
  }
  for (const c of children) n.append(c);
  return n;
}

function getDisplayMetrics() {
  let bbox = roomBBox(state.room);
  // Empty room (e.g. polygon mode with no outline yet, or before drawing):
  // fall back to a default canvas so the grid and cursor have a useful scale.
  if (bbox.w < 1 || bbox.h < 1) {
    bbox = { x: 0, y: 0, w: 240, h: 240 };
  }
  const rect = svg.getBoundingClientRect();
  const pad = 40;
  const scale = Math.min(
    (rect.width - pad * 2) / Math.max(bbox.w, 1),
    (rect.height - pad * 2) / Math.max(bbox.h, 1),
  );
  return { bbox, rect, pad, scale };
}

function applyTransform() {
  const { bbox, rect, pad, scale } = getDisplayMetrics();
  const s = scale * state.view.zoom;
  const tx = pad - bbox.x * s + state.view.pan.x * s + (rect.width - pad * 2 - bbox.w * s) / 2;
  const ty = pad - bbox.y * s + state.view.pan.y * s + (rect.height - pad * 2 - bbox.h * s) / 2;
  gRoot.setAttribute('transform', `translate(${tx}, ${ty}) scale(${s})`);
  svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
}

export function fitView() {
  state.view.zoom = 1;
  state.view.pan.x = 0;
  state.view.pan.y = 0;
  applyTransform();
}

export function zoomBy(f) {
  state.view.zoom = Math.min(Math.max(state.view.zoom * f, 0.05), 50);
  applyTransform();
}

function clientToRoom(clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const ctm = gRoot.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

export function render() {
  applyTransform();
  renderGrid();
  renderRoom();
  renderBoards();
  renderOverlay();
  renderDraft();
}

function renderGrid() {
  while (gGrid.firstChild) gGrid.removeChild(gGrid.firstChild);
  if (!state.view.showGrid) return;
  const bbox = roomBBox(state.room);
  const step = gridStep(state.units);
  const strokeMinor = { stroke: '#1f2a36', 'stroke-width': 0.25, fill: 'none' };
  const strokeMajor = { stroke: '#2a394a', 'stroke-width': 0.5, fill: 'none' };

  // Minor grid
  const pathMinor = [];
  const pathMajor = [];
  for (let x = Math.floor(bbox.x / step) * step; x <= bbox.x + bbox.w; x += step) {
    (Math.round(x / step) % 5 === 0 ? pathMajor : pathMinor)
      .push(`M ${x} ${bbox.y} L ${x} ${bbox.y + bbox.h}`);
  }
  for (let y = Math.floor(bbox.y / step) * step; y <= bbox.y + bbox.h; y += step) {
    (Math.round(y / step) % 5 === 0 ? pathMajor : pathMinor)
      .push(`M ${bbox.x} ${y} L ${bbox.x + bbox.w} ${y}`);
  }
  gGrid.append(el('path', { ...strokeMinor, d: pathMinor.join(' ') }));
  gGrid.append(el('path', { ...strokeMajor, d: pathMajor.join(' ') }));
}

function gridStep(units) {
  // Stored internally in inches.
  if (units === 'ft') return 12;
  if (units === 'cm') return 1 / 0.393700787;  // 1 cm in inches
  if (units === 'mm') return 10 / 0.393700787 / 10; // 1 mm
  return 1; // inches
}

function renderRoom() {
  while (gRoom.firstChild) gRoom.removeChild(gRoom.firstChild);

  // Fill rectangles (base + add) make the floor. In polygon mode, the base is
  // degenerate and the add-rects produced from the polygon paint the shape.
  for (const r of roomRects(state.room)) {
    if (r.w <= 0 || r.h <= 0) continue;
    gRoom.append(el('rect', {
      x: r.x, y: r.y, width: r.w, height: r.h,
      fill: '#2a3442', stroke: 'none',
      'data-type': 'room-fill',
    }));
  }

  // Subtractive jut-ins punch holes.
  for (const r of (state.room.regions || [])) {
    if (r.type !== 'sub') continue;
    gRoom.append(el('rect', {
      x: r.x, y: r.y, width: r.w, height: r.h,
      fill: '#0a0d12', stroke: '#e5a23b', 'stroke-width': 0.5,
      'stroke-dasharray': '2 2',
    }));
    gRoom.append(el('text', {
      x: r.x + r.w / 2, y: r.y + r.h / 2,
      fill: '#e5a23b', 'font-size': Math.min(r.w, r.h) * 0.2,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-family': 'system-ui, sans-serif',
      'paint-order': 'stroke', stroke: '#0a0d12', 'stroke-width': 0.5,
    }, [ document.createTextNode('JUT-IN') ]));
  }

  // Outline: either the rectangle(s) outline, or — in polygon mode — the
  // saved polygon.
  if (state.room.mode === 'polygon' && state.room.polygon?.length >= 3) {
    const d = state.room.polygon
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ') + ' Z';
    gRoom.append(el('path', {
      d, fill: 'none', stroke: '#4e6782', 'stroke-width': 0.5,
    }));
    // Edge dimension labels.
    for (const e of polygonEdges(state.room.polygon)) {
      const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
      if (len > 1e-6) gRoom.append(edgeLabel(e.a, e.b, formatLen(len, state.units), '#8b97a8'));
    }
  } else {
    const bbox = roomBBox(state.room);
    gRoom.append(el('rect', {
      x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h,
      fill: 'none', stroke: '#4e6782', 'stroke-width': 0.4,
    }));
    gRoom.append(el('text', {
      x: bbox.x + bbox.w / 2, y: bbox.y - 4,
      fill: '#8b97a8', 'font-size': 4, 'text-anchor': 'middle',
      'font-family': 'system-ui, sans-serif',
    }, [ document.createTextNode(formatLen(bbox.w, state.units)) ]));
    gRoom.append(el('text', {
      x: bbox.x - 4, y: bbox.y + bbox.h / 2,
      fill: '#8b97a8', 'font-size': 4, 'text-anchor': 'end', 'dominant-baseline': 'central',
      transform: `rotate(-90 ${bbox.x - 4} ${bbox.y + bbox.h / 2})`,
      'font-family': 'system-ui, sans-serif',
    }, [ document.createTextNode(formatLen(bbox.h, state.units)) ]));
  }
}

function renderBoards() {
  while (gBoards.firstChild) gBoards.removeChild(gBoards.firstChild);
  for (const b of state.layout.boards) {
    const rect = el('rect', {
      x: b.x, y: b.y, width: b.w, height: b.l,
      fill: b.gap ? 'url(#gapFill)' : boardColor(b),
      stroke: state.selection === b.id ? '#ffd36b' : '#6a4a22',
      'stroke-width': state.selection === b.id ? 0.8 : 0.25,
      'data-id': b.id,
      'data-type': 'board',
      style: state.view.manualMode && !b.gap ? 'cursor: grab' : 'cursor: pointer',
    });
    gBoards.append(rect);

    // Wood grain stripes.
    if (!b.gap) {
      const stripeCount = Math.max(2, Math.floor(b.w / 0.6));
      for (let i = 1; i < stripeCount; i++) {
        const y = b.y + (b.l / stripeCount) * 0;
        const x = b.x + (b.w / stripeCount) * i;
        gBoards.append(el('line', {
          x1: x, y1: b.y, x2: x, y2: b.y + b.l,
          stroke: 'rgba(0,0,0,0.15)', 'stroke-width': 0.08,
          'pointer-events': 'none',
        }));
      }
    }

    if (state.view.showLabels && !b.gap) {
      const fontSize = Math.max(1.2, Math.min(b.w * 0.35, b.l * 0.08));
      const label = `${b.name}${b.cut ? ' ✂' : ''}${b.reused ? ' ↺' : ''}`;
      gBoards.append(el('text', {
        x: b.x + b.w / 2, y: b.y + b.l / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        fill: '#3b2a10', 'font-size': fontSize,
        'font-family': 'system-ui, sans-serif',
        'pointer-events': 'none',
      }, [ document.createTextNode(label) ]));
    }

    if (b.gap) {
      gBoards.append(el('text', {
        x: b.x + b.w / 2, y: b.y + b.l / 2,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        fill: '#e5484d', 'font-size': Math.max(1.2, Math.min(b.w * 0.35, b.l * 0.08)),
        'font-family': 'system-ui, sans-serif',
        'pointer-events': 'none',
      }, [ document.createTextNode('GAP') ]));
    }
  }

  // Attach interactions.
  for (const node of gBoards.querySelectorAll('rect[data-type="board"]')) {
    attachBoardInteractions(node);
  }
}

function renderOverlay() {
  while (gOverlay.firstChild) gOverlay.removeChild(gOverlay.firstChild);
  // Defs for gap pattern.
  const defs = el('defs');
  defs.innerHTML = `
    <pattern id="gapFill" width="2" height="2" patternUnits="userSpaceOnUse">
      <rect width="2" height="2" fill="#2a0a0a" />
      <path d="M 0 2 L 2 0" stroke="#5a1a1a" stroke-width="0.4"/>
    </pattern>
  `;
  gOverlay.append(defs);
}

function boardColor(b) {
  // Deterministic hue from srcId for visual variety per source board type.
  let h = 0;
  const s = String(b.srcId || b.name || 'x');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = 25 + (h % 24);      // warm browns
  const sat = 35 + (h % 15);
  const lgt = 55 + (h % 10);
  return `hsl(${hue} ${sat}% ${lgt}%)`;
}

function attachBoardInteractions(node) {
  const id = node.getAttribute('data-id');
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    onSelect(id);
  });
  if (!state.view.manualMode) return;

  let dragging = false;
  let offset = { x: 0, y: 0 };
  let origin = null;
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.shiftKey) return;
    const board = state.layout.boards.find(b => b.id === id);
    if (!board || board.gap) return;
    dragging = true;
    node.setPointerCapture(e.pointerId);
    const pt = clientToRoom(e.clientX, e.clientY);
    offset.x = pt.x - board.x;
    offset.y = pt.y - board.y;
    origin = { x: board.x, y: board.y };
    node.style.cursor = 'grabbing';
    onSelect(id);
    e.stopPropagation();
  });
  node.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const board = state.layout.boards.find(b => b.id === id);
    if (!board) return;
    const pt = clientToRoom(e.clientX, e.clientY);
    board.x = snap(pt.x - offset.x);
    board.y = snap(pt.y - offset.y);
    node.setAttribute('x', board.x);
    node.setAttribute('y', board.y);
    // Re-render labels lazily (cheap: just re-render boards).
    renderBoards();
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    node.releasePointerCapture?.(e.pointerId);
    node.style.cursor = 'grab';
    const board = state.layout.boards.find(b => b.id === id);
    // Validate: require center of board inside room. If outside, revert.
    if (board) {
      const cx = board.x + board.w / 2;
      const cy = board.y + board.l / 2;
      if (!pointInRoom(state.room, cx, cy)) {
        board.x = origin.x; board.y = origin.y;
      }
    }
    onMoveEnd(id);
  };
  node.addEventListener('pointerup', finish);
  node.addEventListener('pointercancel', finish);
}

function snap(v) {
  // Snap to 1/8" in inch-based internal units.
  return Math.round(v * 8) / 8;
}

// Serialize the current <svg> to an SVG string with a white background and
// with the current transform baked in so it stands alone.
export function toSVGString() {
  const { bbox } = getDisplayMetrics();
  const pad = 2;
  const w = bbox.w + pad * 2;
  const h = bbox.h + pad * 2;
  // Clone the SVG and replace the root transform so the viewBox matches room coords.
  const clone = svg.cloneNode(true);
  clone.setAttribute('viewBox', `${bbox.x - pad} ${bbox.y - pad} ${w} ${h}`);
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  // Remove the pan/zoom transform.
  const rootG = clone.querySelector('#root');
  if (rootG) rootG.removeAttribute('transform');
  // Prepend background.
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', bbox.x - pad);
  bg.setAttribute('y', bbox.y - pad);
  bg.setAttribute('width', w);
  bg.setAttribute('height', h);
  bg.setAttribute('fill', '#ffffff');
  rootG?.insertBefore(bg, rootG.firstChild);
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n';
  return header + new XMLSerializer().serializeToString(clone);
}

export async function toPNGBlob(scale = 2) {
  const svgStr = toSVGString();
  const img = new Image();
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej; img.src = url;
    });
    const { bbox } = getDisplayMetrics();
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(64, Math.floor((bbox.w + 4) * scale));
    canvas.height = Math.max(64, Math.floor((bbox.h + 4) * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

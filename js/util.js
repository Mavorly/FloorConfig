// Small utilities used across the app.

export const UNITS = {
  in: { label: 'in', toBase: 1 },       // base = inches
  ft: { label: 'ft', toBase: 12 },
  cm: { label: 'cm', toBase: 0.393700787 },
  mm: { label: 'mm', toBase: 0.0393700787 },
};

export function round(n, places = 3) {
  const p = Math.pow(10, places);
  return Math.round(n * p) / p;
}

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// Deterministic pseudo-random (mulberry32) seeded by integer.
export function seededRng(seed) {
  let a = (seed | 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatLen(val, units) {
  const u = UNITS[units] || UNITS.in;
  if (units === 'ft') {
    // Show feet-inches hybrid if it's a nice fraction.
    const inches = val; // values are stored in inches
    const ft = Math.floor(inches / 12);
    const rem = inches - ft * 12;
    return `${ft}′ ${round(rem, 2)}″`;
  }
  // Convert from base (inches) to chosen unit for display.
  const disp = val / u.toBase;
  return `${round(disp, 3)} ${u.label}`;
}

// Union of 1D intervals [a,b]. Returns sorted list of merged intervals.
export function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= prev[1] + 1e-9) prev[1] = Math.max(prev[1], cur[1]);
    else out.push(cur.slice());
  }
  return out;
}

// Subtract set `subs` of intervals from a single interval [a,b]. Returns list.
export function subtractIntervals(base, subs) {
  let parts = [base.slice()];
  for (const s of subs) {
    const next = [];
    for (const p of parts) {
      if (s[1] <= p[0] || s[0] >= p[1]) { next.push(p); continue; }
      if (s[0] > p[0]) next.push([p[0], s[0]]);
      if (s[1] < p[1]) next.push([s[1], p[1]]);
    }
    parts = next.filter(([a, b]) => b - a > 1e-6);
  }
  return parts;
}

// For a horizontal strip [y1,y2], find x-intervals fully inside the room.
// Room is defined as union of additive rects minus union of subtractive rects.
// Strategy: find all base+add rects that fully contain [y1,y2] vertically, union
// their x-intervals; then subtract x-intervals of any sub rect that intersects
// the strip (even partially — we want boards to avoid the jut-in entirely).
export function stripIntervals(room, y1, y2) {
  const adds = [];
  for (const r of roomRects(room)) {
    if (r.y <= y1 + 1e-6 && r.y + r.h >= y2 - 1e-6) {
      adds.push([r.x, r.x + r.w]);
    }
  }
  const merged = mergeIntervals(adds);
  const subs = [];
  for (const r of (room.regions || [])) {
    if (r.type !== 'sub') continue;
    // Any vertical overlap with the strip means we must avoid that x-range.
    if (r.y < y2 - 1e-6 && r.y + r.h > y1 + 1e-6) {
      subs.push([r.x, r.x + r.w]);
    }
  }
  const out = [];
  for (const seg of merged) {
    for (const p of subtractIntervals(seg, subs)) out.push(p);
  }
  return out;
}

// Vertical variant: for a vertical strip [x1,x2], find y-intervals fully inside.
export function stripIntervalsV(room, x1, x2) {
  const adds = [];
  for (const r of roomRects(room)) {
    if (r.x <= x1 + 1e-6 && r.x + r.w >= x2 - 1e-6) {
      adds.push([r.y, r.y + r.h]);
    }
  }
  const merged = mergeIntervals(adds);
  const subs = [];
  for (const r of (room.regions || [])) {
    if (r.type !== 'sub') continue;
    if (r.x < x2 - 1e-6 && r.x + r.w > x1 + 1e-6) {
      subs.push([r.y, r.y + r.h]);
    }
  }
  const out = [];
  for (const seg of merged) {
    for (const p of subtractIntervals(seg, subs)) out.push(p);
  }
  return out;
}

// The list of additive rectangles: base + "add" regions. In 'polygon' mode the
// base rect is ignored and the room shape is entirely carried by the "add"
// regions produced by polygonToRects().
export function roomRects(room) {
  const out = [];
  if (room.mode !== 'polygon') {
    out.push({ x: 0, y: 0, w: room.width, h: room.length });
  }
  for (const r of (room.regions || [])) {
    if (r.type === 'add') out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }
  return out;
}

// Decompose an orthogonal simple polygon into axis-aligned rectangles using
// horizontal slab decomposition. Each slab is [y_i, y_{i+1}] between
// consecutive distinct polygon y-coordinates; within a slab, the polygon
// interior is a union of x-intervals determined by the crossing vertical edges.
export function polygonToRects(poly) {
  if (!poly || poly.length < 4) return [];
  const ys = [...new Set(poly.map(p => p.y))].sort((a, b) => a - b);
  const edges = polygonEdges(poly);
  const rects = [];
  for (let i = 0; i < ys.length - 1; i++) {
    const y1 = ys[i], y2 = ys[i + 1];
    const yMid = (y1 + y2) / 2;
    // Collect vertical edges that span this slab.
    const crossings = [];
    for (const e of edges) {
      if (e.horizontal) continue;
      const yMin = Math.min(e.a.y, e.b.y);
      const yMax = Math.max(e.a.y, e.b.y);
      if (yMin <= y1 + 1e-9 && yMax >= y2 - 1e-9) crossings.push(e.a.x);
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const x1 = crossings[k], x2 = crossings[k + 1];
      if (x2 - x1 > 1e-6) rects.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    }
  }
  return rects;
}

export function polygonEdges(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    out.push({ a, b, horizontal: Math.abs(a.y - b.y) < 1e-9 });
  }
  return out;
}

// Convert a polygon into the room's internal rect representation. Returns the
// patched { width, length, regions } to drop into `state.room`.
export function applyPolygonToRoom(poly) {
  const rects = polygonToRects(poly);
  const regions = rects.map((r, i) => ({
    id: `poly_${i}`, type: 'add', x: r.x, y: r.y, w: r.w, h: r.h,
  }));
  return {
    mode: 'polygon',
    width: 0,
    length: 0,
    regions,
    polygon: poly.map(p => ({ x: p.x, y: p.y })),
  };
}

// Signed area of polygon; used to show if it is CW/CCW. Positive = CCW.
export function polygonArea(poly) {
  if (!poly || poly.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

// Point-in-room test (for manual drag bounds).
export function pointInRoom(room, x, y) {
  let inBase = false;
  for (const r of roomRects(room)) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { inBase = true; break; }
  }
  if (!inBase) return false;
  for (const r of (room.regions || [])) {
    if (r.type !== 'sub') continue;
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return false;
  }
  return true;
}

// Room bounding box that includes any add regions outside the base.
export function roomBBox(room) {
  const polygon = room.mode === 'polygon';
  let minX = polygon ?  Infinity : 0;
  let minY = polygon ?  Infinity : 0;
  let maxX = polygon ? -Infinity : (room.width || 0);
  let maxY = polygon ? -Infinity : (room.length || 0);
  for (const r of (room.regions || [])) {
    if (r.type === 'add') {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
  }
  for (const p of (room.polygon || [])) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Compute the usable floor area (sum of additive rects - subtractive rects,
// all clipped to base). Simple inclusion-exclusion assuming non-overlapping
// regions. Good enough for a stat readout.
export function roomArea(room) {
  let area = 0;
  for (const r of roomRects(room)) area += r.w * r.h;
  for (const r of (room.regions || [])) {
    if (r.type === 'sub') area -= r.w * r.h;
  }
  return Math.max(0, area);
}

export function download(filename, content, mime = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

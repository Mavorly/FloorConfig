// Main application orchestrator.
// Ties DOM → state → layout engine → canvas → storage/export.

import { state, pushHistory, undo, redo, addRegion, removeRegion,
         addInventory, removeInventory, clearLayout } from './state.js';
import { generateLayout } from './layout.js';
import { initCanvas, render, fitView, zoomBy, toSVGString, toPNGBlob } from './canvas.js';
import { parseCSV, toCSV, rowsToInventory } from './csv.js';
import { saveProfile, deleteProfile, getProfile, listProfiles } from './storage.js';
import { UNITS, formatLen, roomArea, roomBBox, download } from './util.js';

// ---------- Init ----------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const svg = $('#svg');
initCanvas(svg, {
  onSelect: (id) => { state.selection = id; render(); updateSelectionInfo(); renderBoardEditor(); },
  onMoveEnd: () => { pushHistory(); render(); updateStats(); },
  onCursor: (pt) => {
    $('#cursor-readout').textContent = pt
      ? `x: ${formatLen(pt.x, state.units)}  y: ${formatLen(pt.y, state.units)}`
      : '—';
  },
});

seedDefaults();
pushHistory();
renderAll();

window.addEventListener('resize', () => render());

// ---------- Defaults ----------

function seedDefaults() {
  if (state.inventory.length === 0) {
    addInventory({ name: 'Long',  width: 5, length: 48, qty: 40 });
    addInventory({ name: 'Med',   width: 5, length: 36, qty: 20 });
    addInventory({ name: 'Short', width: 5, length: 24, qty: 15 });
  }
  if (!state.layout.rowWidth) state.layout.rowWidth = 5;
}

// ---------- Top-level render ----------

function renderAll() {
  syncInputs();
  renderRegions();
  renderInventory();
  renderRowWidthOptions();
  renderProfileSelect();
  updateStats();
  updateSelectionInfo();
  renderBoardEditor();
  render();
}

function syncInputs() {
  $('#units').value = state.units;
  $('#room-w').value = displayVal(state.room.width);
  $('#room-l').value = displayVal(state.room.length);
  $('#pattern').value = state.layout.pattern;
  $('#orientation').value = state.layout.orientation;
  $('#min-cut').value = displayVal(state.layout.minCut);
  $('#stagger').value = displayVal(state.layout.stagger);
  $('#seed').value = state.layout.seed;
  $('#reuse-cutoffs').checked = state.layout.reuseCutoffs;
  $('#toggle-grid').checked = state.view.showGrid;
  $('#toggle-labels').checked = state.view.showLabels;
  $('#toggle-manual').checked = state.view.manualMode;
}

// Internal values are inches. Display in chosen unit for user fields.
function displayVal(internalInches) {
  const u = UNITS[state.units];
  return Math.round((internalInches / u.toBase) * 1000) / 1000;
}
function toInternal(displayed) {
  const u = UNITS[state.units];
  return Number(displayed) * u.toBase;
}

// ---------- Left panel: room + regions ----------

$('#units').addEventListener('change', (e) => {
  state.units = e.target.value;
  syncInputs();
  renderRegions();
  renderInventory();
  updateStats();
  render();
});
['#room-w', '#room-l'].forEach(sel => {
  $(sel).addEventListener('change', (e) => {
    const v = toInternal(e.target.value);
    if (!isFinite(v) || v <= 0) return;
    if (sel === '#room-w') state.room.width = v; else state.room.length = v;
    pushHistory();
    updateStats();
    render();
  });
});

$('#btn-add-sub').addEventListener('click', () => { addRegion('sub'); pushHistory(); renderRegions(); updateStats(); render(); });
$('#btn-add-add').addEventListener('click', () => { addRegion('add'); pushHistory(); renderRegions(); updateStats(); render(); });

function renderRegions() {
  const list = $('#region-list');
  list.innerHTML = '';
  const tpl = $('#tpl-region-row');
  for (const r of state.room.regions) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = r.id;
    node.querySelector('.r-type').value = r.type;
    node.querySelector('.r-x').value = displayVal(r.x);
    node.querySelector('.r-y').value = displayVal(r.y);
    node.querySelector('.r-w').value = displayVal(r.w);
    node.querySelector('.r-h').value = displayVal(r.h);
    node.querySelector('.r-type').addEventListener('change', (e) => { r.type = e.target.value; pushHistory(); render(); });
    node.querySelector('.r-x').addEventListener('change', (e) => { r.x = toInternal(e.target.value); pushHistory(); render(); });
    node.querySelector('.r-y').addEventListener('change', (e) => { r.y = toInternal(e.target.value); pushHistory(); render(); });
    node.querySelector('.r-w').addEventListener('change', (e) => { r.w = toInternal(e.target.value); pushHistory(); updateStats(); render(); });
    node.querySelector('.r-h').addEventListener('change', (e) => { r.h = toInternal(e.target.value); pushHistory(); updateStats(); render(); });
    node.querySelector('.r-del').addEventListener('click', () => { removeRegion(r.id); pushHistory(); renderRegions(); updateStats(); render(); });
    list.append(node);
  }
}

// ---------- Right panel: inventory ----------

$('#btn-add-board').addEventListener('click', () => { addInventory({}); pushHistory(); renderInventory(); renderRowWidthOptions(); });
$('#btn-clear-boards').addEventListener('click', () => {
  if (!confirm('Clear all board types?')) return;
  state.inventory = []; pushHistory(); renderInventory(); renderRowWidthOptions();
});
$('#csv-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const rows = parseCSV(text);
  const items = rowsToInventory(rows);
  if (!items.length) { alert('No valid rows in CSV.'); return; }
  for (const it of items) addInventory(it);
  pushHistory();
  renderInventory();
  renderRowWidthOptions();
  e.target.value = '';
  flashStatus(`Imported ${items.length} board type(s).`);
});
$('#btn-csv-template').addEventListener('click', () => {
  const csv = toCSV([
    ['width', 'length', 'qty', 'name'],
    [5, 48, 20, 'Long'],
    [5, 36, 10, 'Med'],
    [5, 24, 8, 'Short'],
  ]);
  download('board-inventory-template.csv', csv, 'text/csv');
});

function renderInventory() {
  const root = $('#inventory');
  root.innerHTML = '';
  const tpl = $('#tpl-inv-row');
  const usage = computeUsage();
  for (const b of state.inventory) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = b.id;
    node.querySelector('.i-name').value = b.name;
    node.querySelector('.i-w').value = displayVal(b.width);
    node.querySelector('.i-l').value = displayVal(b.length);
    node.querySelector('.i-q').value = b.qty;
    const used = usage.get(b.id) || 0;
    node.querySelector('.i-used').textContent = `${used}/${b.qty}`;
    if (used > b.qty) node.classList.add('oversubscribed');
    node.querySelector('.i-name').addEventListener('change', (e) => { b.name = e.target.value; pushHistory(); render(); });
    node.querySelector('.i-w').addEventListener('change', (e) => {
      b.width = toInternal(e.target.value); pushHistory(); renderRowWidthOptions(); render();
    });
    node.querySelector('.i-l').addEventListener('change', (e) => {
      b.length = toInternal(e.target.value); pushHistory(); render();
    });
    node.querySelector('.i-q').addEventListener('change', (e) => {
      b.qty = Math.max(0, Math.round(Number(e.target.value) || 0)); pushHistory(); updateStats();
    });
    node.querySelector('.i-del').addEventListener('click', () => {
      removeInventory(b.id); pushHistory(); renderInventory(); renderRowWidthOptions(); render();
    });
    root.append(node);
  }
}

function renderRowWidthOptions() {
  const sel = $('#row-width');
  const widths = [...new Set(state.inventory.map(b => b.width))].sort((a, b) => a - b);
  sel.innerHTML = '';
  const mix = document.createElement('option');
  mix.value = '';
  mix.textContent = 'Mixed (cycle widths)';
  sel.append(mix);
  for (const w of widths) {
    const opt = document.createElement('option');
    opt.value = String(w);
    opt.textContent = formatLen(w, state.units);
    sel.append(opt);
  }
  const cur = state.layout.rowWidth;
  if (cur && widths.includes(cur)) sel.value = String(cur);
  else if (cur == null || cur === '') sel.value = '';
  else sel.value = '';
}

$('#row-width').addEventListener('change', (e) => {
  state.layout.rowWidth = e.target.value === '' ? null : Number(e.target.value);
  pushHistory();
});
$('#pattern').addEventListener('change', (e) => { state.layout.pattern = e.target.value; pushHistory(); });
$('#orientation').addEventListener('change', (e) => { state.layout.orientation = e.target.value; pushHistory(); });
$('#min-cut').addEventListener('change', (e) => { state.layout.minCut = toInternal(e.target.value); pushHistory(); });
$('#stagger').addEventListener('change', (e) => { state.layout.stagger = toInternal(e.target.value); pushHistory(); });
$('#seed').addEventListener('change', (e) => { state.layout.seed = Math.round(Number(e.target.value) || 1); pushHistory(); });
$('#reuse-cutoffs').addEventListener('change', (e) => { state.layout.reuseCutoffs = e.target.checked; pushHistory(); });

// ---------- Toolbar ----------

$('#btn-undo').addEventListener('click', () => { if (undo()) { renderAll(); flashStatus('Undid.'); } });
$('#btn-redo').addEventListener('click', () => { if (redo()) { renderAll(); flashStatus('Redid.'); } });
$('#btn-generate').addEventListener('click', () => {
  if (!state.inventory.length) { alert('Add at least one board type first.'); return; }
  const res = generateLayout(state.room, state.inventory, state.layout);
  state.layout.boards = res.boards;
  state.selection = null;
  pushHistory();
  updateStats();
  renderInventory();
  render();
  flashStatus(`Placed ${res.boards.filter(b => !b.gap).length} board(s).`);
});
$('#btn-clear-layout').addEventListener('click', () => {
  clearLayout(); pushHistory(); renderInventory(); updateStats(); render();
});
$('#toggle-manual').addEventListener('change', (e) => { state.view.manualMode = e.target.checked; render(); });
$('#toggle-grid').addEventListener('change', (e) => { state.view.showGrid = e.target.checked; render(); });
$('#toggle-labels').addEventListener('change', (e) => { state.view.showLabels = e.target.checked; render(); });
$('#btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
$('#btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
$('#btn-zoom-reset').addEventListener('click', () => fitView());

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); if (undo()) renderAll(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); if (redo()) renderAll(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selection) {
      state.layout.boards = state.layout.boards.filter(b => b.id !== state.selection);
      state.selection = null;
      pushHistory(); updateStats(); renderInventory(); render();
    }
  } else if (e.key === 'r' && state.selection) {
    rotateSelection();
  } else if (e.key === 'g') { $('#btn-generate').click(); }
});

// ---------- Profiles ----------

function renderProfileSelect() {
  const sel = $('#profile-select');
  sel.innerHTML = '';
  for (const name of listProfiles()) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.append(opt);
  }
}

$('#btn-save-profile').addEventListener('click', () => {
  const name = ($('#profile-name').value || '').trim();
  if (!name) { alert('Enter a profile name first.'); return; }
  saveProfile(name, {
    units: state.units,
    room: state.room,
    inventory: state.inventory,
    layout: state.layout,
  });
  renderProfileSelect();
  $('#profile-select').value = name;
  flashStatus(`Saved profile "${name}".`);
});
$('#btn-load-profile').addEventListener('click', () => {
  const name = $('#profile-select').value;
  if (!name) return;
  const p = getProfile(name);
  if (!p) return;
  Object.assign(state, { units: p.units });
  state.room = JSON.parse(JSON.stringify(p.room));
  state.inventory = JSON.parse(JSON.stringify(p.inventory));
  state.layout = JSON.parse(JSON.stringify(p.layout));
  state.selection = null;
  pushHistory();
  $('#profile-name').value = name;
  renderAll();
  flashStatus(`Loaded "${name}".`);
});
$('#btn-delete-profile').addEventListener('click', () => {
  const name = $('#profile-select').value;
  if (!name) return;
  if (!confirm(`Delete profile "${name}"?`)) return;
  deleteProfile(name);
  renderProfileSelect();
});
$('#btn-duplicate-profile').addEventListener('click', () => {
  const name = $('#profile-select').value;
  if (!name) return;
  const p = getProfile(name);
  if (!p) return;
  const copy = `${name} copy`;
  saveProfile(copy, p);
  renderProfileSelect();
  $('#profile-select').value = copy;
});

// ---------- Export ----------

$('#btn-export-svg').addEventListener('click', () => {
  download(`${profileName()}.svg`, toSVGString(), 'image/svg+xml');
});
$('#btn-export-png').addEventListener('click', async () => {
  const blob = await toPNGBlob(3);
  if (blob) download(`${profileName()}.png`, blob);
});
$('#btn-export-cutlist').addEventListener('click', () => {
  const rows = [['#', 'source', 'x', 'y', 'width', 'length_used', 'original_length', 'rotated', 'reused_cutoff', 'notes']];
  let i = 1;
  for (const b of state.layout.boards) {
    rows.push([
      i++,
      b.name || (b.gap ? 'GAP' : ''),
      round(b.x), round(b.y),
      round(b.w),
      round(b.l),
      round(b.cut?.origLen ?? b.l),
      b.rotated ? 'yes' : 'no',
      b.reused ? 'yes' : 'no',
      b.gap ? 'GAP — missing coverage' : (b.cut ? `cut from ${round(b.cut.origLen)} → ${round(b.l)}` : ''),
    ]);
  }
  download(`${profileName()}-cutlist.csv`, toCSV(rows), 'text/csv');
});
$('#btn-export-json').addEventListener('click', () => {
  download(`${profileName()}.json`, JSON.stringify({
    units: state.units,
    room: state.room,
    inventory: state.inventory,
    layout: state.layout,
    exportedAt: new Date().toISOString(),
  }, null, 2), 'application/json');
});
$('#json-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const p = JSON.parse(await file.text());
    state.units = p.units || 'in';
    state.room = p.room;
    state.inventory = p.inventory;
    state.layout = p.layout;
    state.selection = null;
    pushHistory();
    renderAll();
    flashStatus('Imported profile JSON.');
  } catch (err) {
    alert('Invalid JSON: ' + err.message);
  }
  e.target.value = '';
});
$('#btn-print').addEventListener('click', () => window.print());

// ---------- Board editor (selection) ----------

function renderBoardEditor() {
  const pane = $('#board-editor');
  const b = state.layout.boards.find(x => x.id === state.selection);
  if (!b || b.gap) { pane.classList.add('hidden'); return; }
  pane.classList.remove('hidden');
  $('#be-x').value = displayVal(b.x);
  $('#be-y').value = displayVal(b.y);
  $('#be-w').value = displayVal(b.w);
  $('#be-l').value = displayVal(b.l);

  const sel = $('#be-replace');
  sel.innerHTML = '<option value="">—</option>';
  for (const src of state.inventory) {
    const opt = document.createElement('option');
    opt.value = src.id;
    opt.textContent = `${src.name} · ${formatLen(src.width, state.units)} × ${formatLen(src.length, state.units)}`;
    sel.append(opt);
  }
  sel.value = '';
}

$('#be-close').addEventListener('click', () => { state.selection = null; render(); renderBoardEditor(); updateSelectionInfo(); });
$('#be-x').addEventListener('change', (e) => { withSel(b => b.x = toInternal(e.target.value)); });
$('#be-y').addEventListener('change', (e) => { withSel(b => b.y = toInternal(e.target.value)); });
$('#be-w').addEventListener('change', (e) => { withSel(b => b.w = toInternal(e.target.value)); });
$('#be-l').addEventListener('change', (e) => { withSel(b => b.l = toInternal(e.target.value)); });
$('#be-rotate').addEventListener('click', rotateSelection);
$('#be-delete').addEventListener('click', () => {
  if (!state.selection) return;
  state.layout.boards = state.layout.boards.filter(x => x.id !== state.selection);
  state.selection = null;
  pushHistory(); render(); renderBoardEditor(); updateStats(); renderInventory();
});
$('#be-replace').addEventListener('change', (e) => {
  const src = state.inventory.find(s => s.id === e.target.value);
  if (!src) return;
  const b = state.layout.boards.find(x => x.id === state.selection);
  if (!b) return;
  b.srcId = src.id;
  b.name = src.name;
  b.w = src.width;
  b.l = src.length;
  b.cut = null;
  pushHistory(); render(); renderBoardEditor(); updateStats(); renderInventory();
});

function withSel(fn) {
  const b = state.layout.boards.find(x => x.id === state.selection);
  if (!b) return;
  fn(b);
  pushHistory(); render(); updateStats();
}

function rotateSelection() {
  const b = state.layout.boards.find(x => x.id === state.selection);
  if (!b || b.gap) return;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.l / 2;
  [b.w, b.l] = [b.l, b.w];
  b.x = cx - b.w / 2;
  b.y = cy - b.l / 2;
  b.rotated = !b.rotated;
  pushHistory(); render(); renderBoardEditor();
}

// ---------- Stats ----------

function computeUsage() {
  const m = new Map();
  for (const b of state.layout.boards) {
    if (b.gap) continue;
    if (!b.reused) m.set(b.srcId, (m.get(b.srcId) || 0) + 1);
  }
  return m;
}

function updateStats() {
  const area = roomArea(state.room);
  const placedArea = state.layout.boards.filter(b => !b.gap).reduce((s, b) => s + b.w * b.l, 0);
  const gapArea = state.layout.boards.filter(b => b.gap).reduce((s, b) => s + b.w * b.l, 0);
  const coverage = area > 0 ? (placedArea / area) * 100 : 0;

  const used = computeUsage();
  let totalSrc = 0, totalUsed = 0, totalOrigLen = 0, totalUsedLen = 0;
  for (const b of state.inventory) totalSrc += b.qty;
  for (const [, n] of used) totalUsed += n;
  for (const b of state.layout.boards) {
    if (b.gap) continue;
    totalUsedLen += b.l * b.w;
    totalOrigLen += (b.cut?.origLen ?? b.l) * b.w;
  }
  const waste = totalOrigLen > 0 ? ((totalOrigLen - totalUsedLen) / totalOrigLen) * 100 : 0;

  const bbox = roomBBox(state.room);
  $('#room-stats').innerHTML = [
    statLi('Bounding',   `${formatLen(bbox.w, state.units)} × ${formatLen(bbox.h, state.units)}`),
    statLi('Usable area', formatArea(area)),
    statLi('Jut-ins', state.room.regions.filter(r => r.type === 'sub').length),
    statLi('Bump-outs', state.room.regions.filter(r => r.type === 'add').length),
  ].join('');

  $('#inv-stats').innerHTML = [
    statLi('Total source', totalSrc),
    statLi('Used (full)',  totalUsed),
    statLi('Cut-offs reused', state.layout.boards.filter(b => b.reused).length),
  ].join('');

  $('#layout-stats').innerHTML = [
    statLi('Boards placed', state.layout.boards.filter(b => !b.gap).length),
    statLi('Coverage',      `${coverage.toFixed(1)}%`),
    statLi('Gaps',          state.layout.boards.filter(b => b.gap).length),
    statLi('Waste est.',    `${waste.toFixed(1)}%`),
  ].join('');
}

function formatArea(inchesSquared) {
  // Internal area is in square inches. Convert to chosen unit squared.
  const u = UNITS[state.units];
  const disp = inchesSquared / (u.toBase * u.toBase);
  const label = state.units === 'in' ? 'in²'
             : state.units === 'ft' ? 'ft²'
             : state.units === 'cm' ? 'cm²'
             : 'mm²';
  return `${round(disp)} ${label}`;
}

function statLi(label, value) {
  return `<li><span>${label}</span><b>${value}</b></li>`;
}

function updateSelectionInfo() {
  const b = state.layout.boards.find(x => x.id === state.selection);
  const el = $('#selection-info');
  if (!b) { el.textContent = 'Nothing selected. Click a board to edit; hold Shift + drag to pan; wheel to zoom.'; return; }
  if (b.gap) { el.textContent = `GAP at (${formatLen(b.x, state.units)}, ${formatLen(b.y, state.units)}) — ${formatLen(b.w, state.units)} × ${formatLen(b.l, state.units)}.`; return; }
  el.textContent = `${b.name} · ${formatLen(b.w, state.units)} × ${formatLen(b.l, state.units)} @ (${formatLen(b.x, state.units)}, ${formatLen(b.y, state.units)})${b.cut ? ` · cut from ${formatLen(b.cut.origLen, state.units)}` : ''}${b.reused ? ' · reused cut-off' : ''}`;
}

function round(n) { return Math.round(n * 1000) / 1000; }

function profileName() {
  const n = ($('#profile-name').value || '').trim();
  return (n || 'floor-plan').replace(/[^a-z0-9-_\. ]/gi, '_');
}

let flashTimer;
function flashStatus(msg) {
  $('#status').textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('#status').textContent = 'Ready.'; }, 2200);
}

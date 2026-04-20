// Global app state + simple undo/redo ring buffer.
import { uid } from './util.js';

export const state = {
  units: 'in',
  room: {
    width: 144,
    length: 192,
    regions: [], // [{id, type: 'sub'|'add', x, y, w, h}]
  },
  inventory: [], // [{id, name, width, length, qty}]
  layout: {
    pattern: 'running',
    orientation: 'horizontal',
    rowWidth: null, // picked width for each row
    minCut: 6,
    stagger: 16,
    seed: 1,
    reuseCutoffs: true,
    boards: [], // placed boards: {id, srcId, x, y, w, l, rotated, cut}
  },
  view: {
    showGrid: true,
    showLabels: true,
    manualMode: false,
    zoom: 1,
    pan: { x: 0, y: 0 },
  },
  selection: null, // selected board id
};

const history = [];
const future = [];
const HIST_MAX = 60;

export function snapshot() {
  // Only snapshot room/inventory/layout — view/selection are ephemeral.
  return JSON.stringify({
    units: state.units,
    room: state.room,
    inventory: state.inventory,
    layout: state.layout,
  });
}

export function pushHistory() {
  const snap = snapshot();
  if (history.length && history[history.length - 1] === snap) return;
  history.push(snap);
  if (history.length > HIST_MAX) history.shift();
  future.length = 0;
}

function restore(json) {
  const obj = JSON.parse(json);
  state.units = obj.units;
  state.room = obj.room;
  state.inventory = obj.inventory;
  state.layout = obj.layout;
}

export function undo() {
  if (history.length < 2) return false;
  future.push(history.pop());
  restore(history[history.length - 1]);
  return true;
}

export function redo() {
  if (!future.length) return false;
  const snap = future.pop();
  history.push(snap);
  restore(snap);
  return true;
}

export function addRegion(type = 'sub') {
  state.room.regions.push({ id: uid('reg'), type, x: 0, y: 0, w: 24, h: 24 });
}

export function removeRegion(id) {
  state.room.regions = state.room.regions.filter(r => r.id !== id);
}

export function addInventory(board = {}) {
  state.inventory.push({
    id: uid('brd'),
    name: board.name || `B${state.inventory.length + 1}`,
    width: Number(board.width) || 5,
    length: Number(board.length) || 48,
    qty: board.qty == null ? 10 : Number(board.qty),
  });
}

export function removeInventory(id) {
  state.inventory = state.inventory.filter(b => b.id !== id);
}

export function clearLayout() {
  state.layout.boards = [];
  state.selection = null;
}

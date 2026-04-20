// Layout generation. Produces a list of placed boards covering the room shape,
// respecting the chosen pattern, orientation, row width, min cut, and stagger.
//
// Model: we pick rows along the across-axis. In horizontal orientation rows
// are horizontal strips (row height = board width, board length runs along x).
// In vertical orientation rows are vertical strips.
//
// Inventory is consumed proportional to quantities; cut-offs can be reused in
// later rows when `reuseCutoffs` is enabled (practical for real flooring jobs).

import { stripIntervals, stripIntervalsV, roomBBox, seededRng } from './util.js';
import { uid } from './util.js';

const EPS = 1e-6;

export function generateLayout(room, inventory, opts) {
  if (opts.orientation === 'vertical') {
    return generateVertical(room, inventory, opts);
  }
  return generateHorizontal(room, inventory, opts);
}

function cloneInv(inventory) {
  return inventory.map(b => ({ ...b, remaining: b.qty }));
}

// Pick the next board to place. Goal: minimize cuts.
//   - If any board fits in the remaining space uncut, take the LONGEST such
//     board (fills the most space with no cut at all).
//   - Otherwise, we must cut. Pick the longest board overall so the leftover
//     becomes the biggest, most reusable cut-off.
//   - For small leader/offset pieces, pass {preferShort:true} so a huge plank
//     isn't chopped up just to start a staggered row.
// Ties broken by highest remaining quantity (spread wear across stock).
function pickBoard(inv, maxLen, { preferShort = false } = {}) {
  const eligible = inv.filter(b => b.remaining > 0);
  if (!eligible.length) return null;

  const fits = eligible.filter(b => b.length <= maxLen + EPS);
  if (fits.length) {
    const cmp = preferShort
      ? (a, b) => (a.length - b.length) || (b.remaining - a.remaining)
      : (a, b) => (b.length - a.length) || (b.remaining - a.remaining);
    return fits.slice().sort(cmp)[0];
  }
  // Nothing fits uncut — take the longest so the cut-off is maximally reusable.
  return eligible.slice().sort((a, b) =>
    (b.length - a.length) || (b.remaining - a.remaining))[0];
}

function rowStartOffset(rowIndex, pattern, primaryLen, stagger, rng) {
  switch (pattern) {
    case 'sequential': return 0;
    case 'half':       return (rowIndex % 2) * (primaryLen / 2);
    case 'running':    return ((rowIndex % 3) * stagger) % Math.max(primaryLen, stagger);
    case 'random':     return rng() * stagger;
    case 'herringbone':return (rowIndex % 2) * (primaryLen / 2);
    default:           return 0;
  }
}

// Decide the width used for a given row. If multiple widths exist, cycle
// through them for visual mix.
function pickRowWidth(rowIndex, rowWidth, inventory) {
  if (rowWidth && rowWidth > 0) return rowWidth;
  const widths = [...new Set(inventory.map(b => b.width))].sort((a, b) => a - b);
  if (!widths.length) return 5;
  return widths[rowIndex % widths.length];
}

function generateHorizontal(room, inventory, opts) {
  const inv = cloneInv(inventory);
  const widths = [...new Set(inventory.map(b => b.width))];
  const primaryLen = inventory.length
    ? inventory.reduce((s, b) => s + b.length, 0) / inventory.length
    : 48;
  const rng = seededRng(opts.seed || 1);
  const bbox = roomBBox(room);
  const boards = [];
  // A pool of cut-off pieces: {srcId, name, width, length}
  const cutoffs = [];

  const consumeBoard = (src) => { src.remaining = Math.max(0, src.remaining - 1); };

  let rowIndex = 0;
  let y = bbox.y;
  const yMax = bbox.y + bbox.h;
  const guard = 10000;
  let iter = 0;

  while (y < yMax - EPS && iter++ < guard) {
    const rowW = pickRowWidth(rowIndex, opts.rowWidth, inventory);
    const y1 = y, y2 = y + rowW;
    if (y2 > yMax + EPS) break;

    const segments = stripIntervals(room, y1, y2);
    const startOffset = rowStartOffset(rowIndex, opts.pattern, primaryLen, opts.stagger, rng);

    for (const [x1, x2] of segments) {
      let x = x1;
      // Apply row start offset only on the first segment that starts at the
      // leftmost edge; this creates the staggered look. We emulate it by
      // "consuming" a virtual offset length as a cut piece that we drop.
      if (x1 === segments[0][0] && startOffset > 0) {
        const offsetLen = Math.min(startOffset, x2 - x1);
        if (offsetLen >= opts.minCut) {
          // Prefer a cut-off for the leader so we don't chop a long plank
          // just to start the stagger.
          let usedCutoff = false;
          if (opts.reuseCutoffs) {
            const idx = pickCutoff(cutoffs, rowW, offsetLen, opts.minCut);
            if (idx >= 0) {
              const c = cutoffs.splice(idx, 1)[0];
              let useLen = c.length;
              let cutInfo = null;
              if (useLen > offsetLen + EPS) {
                cutInfo = { from: 0, to: offsetLen, origLen: c.length };
                if (c.length - offsetLen >= opts.minCut) {
                  cutoffs.push({ srcId: c.srcId, name: c.name, width: c.width, length: c.length - offsetLen });
                }
                useLen = offsetLen;
              }
              boards.push({
                id: uid('pb'), srcId: c.srcId, name: c.name,
                x, y: y1, w: c.width, l: useLen,
                rotated: false, cut: cutInfo, reused: true,
              });
              x += useLen;
              usedCutoff = true;
            }
          }
          if (!usedCutoff) {
            // Use the shortest available board so long stock stays intact.
            const src = pickBoard(inv, Infinity, { preferShort: true });
            if (src) {
              const useLen = Math.min(offsetLen, src.length);
              boards.push(makeBoard(src, x, y1, src.width, useLen, false,
                useLen < src.length - EPS ? { from: 0, to: useLen, origLen: src.length } : null));
              consumeBoard(src);
              if (opts.reuseCutoffs && src.length - useLen >= opts.minCut) {
                cutoffs.push({ srcId: src.id, name: src.name, width: src.width, length: src.length - useLen });
              }
              x += useLen;
            } else {
              x += offsetLen;
            }
          }
        } else {
          // too small to stagger — just shift; the next board starts here.
          x += offsetLen;
        }
      }

      // Fill the rest of the segment.
      while (x < x2 - EPS) {
        const spaceLeft = x2 - x;

        // Try a cut-off first if it fits nicely.
        let placed = false;
        if (opts.reuseCutoffs) {
          const idx = pickCutoff(cutoffs, rowW, spaceLeft, opts.minCut);
          if (idx >= 0) {
            const c = cutoffs.splice(idx, 1)[0];
            let useLen = c.length;
            let cutInfo = null;
            if (useLen > spaceLeft + EPS) {
              cutInfo = { from: 0, to: spaceLeft, origLen: c.length };
              if (c.length - spaceLeft >= opts.minCut) {
                cutoffs.push({ srcId: c.srcId, name: c.name, width: c.width, length: c.length - spaceLeft });
              }
              useLen = spaceLeft;
            }
            boards.push({
              id: uid('pb'),
              srcId: c.srcId,
              name: c.name,
              x, y: y1, w: c.width, l: useLen,
              rotated: false,
              cut: cutInfo || null,
              reused: true,
            });
            x += useLen;
            placed = true;
          }
        }
        if (placed) continue;

        const src = pickBoard(inv, spaceLeft) || pickBoard(inv, Infinity);
        if (!src) {
          // Out of boards; stop filling this segment.
          boards.push({
            id: uid('gap'), gap: true,
            x, y: y1, w: rowW, l: spaceLeft,
          });
          x = x2;
          break;
        }

        const useLen = Math.min(src.length, spaceLeft);
        const cutInfo = src.length > spaceLeft + EPS
          ? { from: 0, to: spaceLeft, origLen: src.length }
          : null;
        boards.push(makeBoard(src, x, y1, rowW, useLen, false, cutInfo));
        consumeBoard(src);

        if (cutInfo && opts.reuseCutoffs) {
          const leftover = src.length - spaceLeft;
          if (leftover >= opts.minCut) {
            cutoffs.push({ srcId: src.id, name: src.name, width: src.width, length: leftover });
          }
        }
        x += useLen;
      }
    }

    y += rowW;
    rowIndex++;
  }

  return { boards, cutoffs, usedInventory: inv };
}

function generateVertical(room, inventory, opts) {
  // Mirror the horizontal algorithm along the diagonal: iterate columns, fill
  // top-to-bottom. We reuse the helpers by treating columns as rows.
  const inv = cloneInv(inventory);
  const primaryLen = inventory.length
    ? inventory.reduce((s, b) => s + b.length, 0) / inventory.length
    : 48;
  const rng = seededRng(opts.seed || 1);
  const bbox = roomBBox(room);
  const boards = [];
  const cutoffs = [];
  const consumeBoard = (src) => { src.remaining = Math.max(0, src.remaining - 1); };

  let colIndex = 0;
  let x = bbox.x;
  const xMax = bbox.x + bbox.w;
  const guard = 10000;
  let iter = 0;

  while (x < xMax - EPS && iter++ < guard) {
    const colW = pickRowWidth(colIndex, opts.rowWidth, inventory);
    const x1 = x, x2 = x + colW;
    if (x2 > xMax + EPS) break;

    const segments = stripIntervalsV(room, x1, x2);
    const startOffset = rowStartOffset(colIndex, opts.pattern, primaryLen, opts.stagger, rng);

    for (const [y1, y2] of segments) {
      let y = y1;
      if (y1 === segments[0][0] && startOffset > 0) {
        const offsetLen = Math.min(startOffset, y2 - y1);
        if (offsetLen >= opts.minCut) {
          let usedCutoff = false;
          if (opts.reuseCutoffs) {
            const idx = pickCutoff(cutoffs, colW, offsetLen, opts.minCut);
            if (idx >= 0) {
              const c = cutoffs.splice(idx, 1)[0];
              let useLen = c.length;
              let cutInfo = null;
              if (useLen > offsetLen + EPS) {
                cutInfo = { from: 0, to: offsetLen, origLen: c.length };
                if (c.length - offsetLen >= opts.minCut) {
                  cutoffs.push({ srcId: c.srcId, name: c.name, width: c.width, length: c.length - offsetLen });
                }
                useLen = offsetLen;
              }
              boards.push({
                id: uid('pb'), srcId: c.srcId, name: c.name,
                x: x1, y, w: c.width, l: useLen,
                rotated: true, cut: cutInfo, reused: true,
              });
              y += useLen;
              usedCutoff = true;
            }
          }
          if (!usedCutoff) {
            const src = pickBoard(inv, Infinity, { preferShort: true });
            if (src) {
              const useLen = Math.min(offsetLen, src.length);
              boards.push(makeBoard(src, x1, y, src.width, useLen, true,
                useLen < src.length - EPS ? { from: 0, to: useLen, origLen: src.length } : null));
              consumeBoard(src);
              if (opts.reuseCutoffs && src.length - useLen >= opts.minCut) {
                cutoffs.push({ srcId: src.id, name: src.name, width: src.width, length: src.length - useLen });
              }
              y += useLen;
            } else { y += offsetLen; }
          }
        } else { y += offsetLen; }
      }

      while (y < y2 - EPS) {
        const spaceLeft = y2 - y;
        let placed = false;
        if (opts.reuseCutoffs) {
          const idx = pickCutoff(cutoffs, colW, spaceLeft, opts.minCut);
          if (idx >= 0) {
            const c = cutoffs.splice(idx, 1)[0];
            let useLen = c.length;
            let cutInfo = null;
            if (useLen > spaceLeft + EPS) {
              cutInfo = { from: 0, to: spaceLeft, origLen: c.length };
              if (c.length - spaceLeft >= opts.minCut) {
                cutoffs.push({ srcId: c.srcId, name: c.name, width: c.width, length: c.length - spaceLeft });
              }
              useLen = spaceLeft;
            }
            boards.push({
              id: uid('pb'),
              srcId: c.srcId,
              name: c.name,
              x: x1, y, w: c.width, l: useLen,
              rotated: true,
              cut: cutInfo || null,
              reused: true,
            });
            y += useLen;
            placed = true;
          }
        }
        if (placed) continue;

        const src = pickBoard(inv, spaceLeft) || pickBoard(inv, Infinity);
        if (!src) {
          boards.push({
            id: uid('gap'), gap: true,
            x: x1, y, w: colW, l: spaceLeft,
          });
          y = y2;
          break;
        }

        const useLen = Math.min(src.length, spaceLeft);
        const cutInfo = src.length > spaceLeft + EPS
          ? { from: 0, to: spaceLeft, origLen: src.length }
          : null;
        boards.push(makeBoard(src, x1, y, colW, useLen, true, cutInfo));
        consumeBoard(src);
        if (cutInfo && opts.reuseCutoffs) {
          const leftover = src.length - spaceLeft;
          if (leftover >= opts.minCut) {
            cutoffs.push({ srcId: src.id, name: src.name, width: src.width, length: leftover });
          }
        }
        y += useLen;
      }
    }

    x += colW;
    colIndex++;
  }

  return { boards, cutoffs, usedInventory: inv };
}

function makeBoard(src, x, y, w, l, rotated, cut) {
  return {
    id: uid('pb'),
    srcId: src.id,
    name: src.name,
    x, y, w, l,
    rotated,
    cut: cut || null,
    reused: false,
  };
}

// Find a cut-off of matching width whose length is useful for this space.
// Prefers a near-exact fit; otherwise one we can trim further (>= minCut keep).
function pickCutoff(cutoffs, width, spaceLeft, minCut) {
  let bestIdx = -1;
  let bestScore = Infinity;
  for (let i = 0; i < cutoffs.length; i++) {
    const c = cutoffs[i];
    if (Math.abs(c.width - width) > EPS) continue;
    let score;
    if (c.length <= spaceLeft + EPS) {
      score = spaceLeft - c.length; // smaller is better
    } else {
      const leftover = c.length - spaceLeft;
      if (leftover < minCut) continue; // not worth cutting into waste
      score = leftover * 2 + 1;
    }
    if (score < bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

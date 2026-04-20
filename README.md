# FloorConfig

A browser-based flooring layout planner. Draw your room (with jut-ins and
bump-outs), import your board inventory from a CSV, and generate, tweak, and
export template layouts.

## Run

No build step, no server required. Just open `index.html` in a modern browser.

```
# Quickest:
python3 -m http.server 8000
# then visit http://localhost:8000/
```

(Opening `file://.../index.html` directly also works.)

## Features

- **Room shape.** Base rectangle plus any number of *subtract* (jut-ins) or
  *add* (bump-outs) rectangles for non-rectangular rooms.
- **Units.** Inches / feet / cm / mm. Values stored internally in inches.
- **Board inventory.** Import CSV (`width,length,qty,name`), add/edit rows
  manually, or download a starter template.
- **Layout generator.** Running-bond, half-offset, random-stagger, sequential,
  and herringbone patterns. Orientation, row width, minimum end-cut, stagger,
  and a deterministic random seed are all configurable.
- **Jut-in aware.** The generator splits each row by the room shape so boards
  never cross a jut-in.
- **Cut-off reuse.** Cut pieces are tracked and preferred on later rows to
  reduce waste (toggleable).
- **Manual edit mode.** Click a board to select it; drag to reposition,
  rotate (R), delete, or swap its source board. Snaps to 1/8″.
- **Profiles.** Save / load / duplicate / delete named profiles in the browser
  (LocalStorage). Export / import profiles as JSON.
- **Exports.** SVG, PNG, a cut-list CSV (position, size, cut-from, reused),
  and the full profile JSON. Print view also included.
- **Live stats.** Coverage %, waste estimate, gap detection, per-board-type
  usage, total board count.
- **Undo/redo**, pan (shift+drag or middle mouse), wheel zoom.

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Delete / Backspace | Remove selected board |
| R | Rotate selected board 90° |
| G | Generate layout |

## CSV format

The `width,length,qty,name` columns are the recognized headers. `qty` and
`name` are optional. See `sample-boards.csv` for an example with varied
lengths.

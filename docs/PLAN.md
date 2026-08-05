# StudyPlanner — improvement plan (completed)

Serve:

```bash
cd study-planner
python3 -m http.server 8000
# http://localhost:8000/
```

## File structure

```
study-planner/
  index.html
  css/main.css
  js/app.js
  data/MasterProgramme.json
  data/{MP,TP,NP,SE,AS}.json
  docs/PLAN.md
```

## Phases

| Phase | Status | Summary |
|-------|--------|---------|
| **P1** Structure + RelativeVal | **Done** | Modular files; RelativeVal = [master GridPosition.col, 0, 0] |
| **P2** Spatial collisions + snap | **Done** | GridMatrix removed; visible-only AABB; snap 1 / ½ / ¼ |
| **P3** Layout modes + frozen gutter | **Done** | stack / absolute / relative; frozen left Year–Period strip |
| **P4** Flexible periods | **Done** | Nested alternatives, legacy ["*",…], year-wrap [[4,1]] |

## Behaviour notes

### Collisions (P2)

- Only isVisibleOnGrid(c) courses participate in overlap / push.
- canPlace and push chain use axis-aligned rects in column–row units.
- magnetStep in {1, 0.5, 0.25}; stored in save JSON and localStorage.
- Fractional GridPosition.col allowed (after snap).

### Layout modes (P3)

- **stack** — pack left per period-row (default).
- **absolute** — col = RelativeVal[0]; light right-push on clash.
- **relative** — keep order; remove empty column gaps.
- Recompute Layout clears movable positions then runs the selected mode.

### Frozen gutter (P3)

- #bulk-gutter overlays the left of P_Bulk; follows vertical scroll only.

### Periods (P4)

- Flat [1,2] — single span.
- Nested [[2],[1],[3]] — OR of starts; default first; drag may switch.
- ["*", 3, 4] — flexible any-start with recommended duration.
- [[4,1]] — spans year boundary.
- activePeriodAlt is saved and loaded with the course.


## Changelog — post-P4 batch (2026-08-02)

1. Col–row units kept (scaled by FIVE_WIDTH / PERIOD_HEIGHT for pixels).
2. Hit-box = visible rectangle (`hitW`/`hitH` from renderWidth/Height), not matrix cWidth.
3. Aggressive push-right on any overlapping movable; fail on locked in target; chain jumps over locked.
4. Layout labels: Absolute / Remove gaps.
5. Remove gaps = Absolute then delete empty integer columns globally.
6. Safari context-menu: 400ms grace + stopPropagation so control-click keeps menu open.
7. 1FA204 Astrophysics I Periods → `[[2],[4]]` in all data JSON files.
8. Gutter fully opaque, fixed to left of P_Bulk viewport, Y-synced 1:1 with scrollTop, continuation grid lines.
9. After upload/auto-load scroll to centre-of-mass of visible courses.
10. Undo/redo stack (max 40) of full save payloads; ← → buttons + Ctrl/Cmd-Z / Shift-Z; Reset still uses last upload snapshot.


## Changelog v3

1. Undo/redo restores `ui.bulkScrollLeft/Top` from the target snapshot (no jump to COM).
2. Drag-move now calls `pushHistory`; history seed no longer wipes the stack on apply; Name+Code / snap / layout mode also recorded.
3. Curly undo/redo arrows (↶ ↷) left of “Layout:”, native `title` tooltips “Undo” / “Redo”.
4. Periods in description: `1-3`, `Default is 1-2 but can be any`, `2 or 4`.
5. Gutter — understanding summary only (awaiting user correction); no code change this pass.


## Changelog v4 — gutter fix

- Root cause of 2× vertical scroll: gutter lived *inside* `#P_Bulk` (moved with scroll)
  **and** received `translateY(-scrollTop)` → double motion. At scrollTop=0 it looked correct.
- Fix: `#workspace` flex row = `#bulk-gutter` | `#P_Bulk`. Gutter is a sibling of the
  scrollport, pinned to the **window left edge** under the header. Only one vertical
  motion source (the transform). Overlay panes still sit above (higher z-index).
- Line spans in gutter (right-aligned, meet canvas with `right:0`):
  - thick (0,4,8,…) full width
  - medium (2,6,10,…) left: 33.3% (≈2/3 width)
  - thin (1,3,5,…) left: 66.7% (≈1/3 width)


## Changelog v5

1. Gutter scroll: direct transform on scroll (no extra lag path).
2. Undo/Redo quick-tip at 350ms (half of typical native title delay).
3. Document title → Study Planner.
4. YearParity Any|Odd|Even; Master starts 2024–2028 (default 2026); calendar years on gutter thick boundaries; snap blocked when parity mismatches; periods line shows “(odd/even years only)”.
5. Layout option “Auto without gaps”; separate **Remove gaps** button packs empty integer columns from current positions.

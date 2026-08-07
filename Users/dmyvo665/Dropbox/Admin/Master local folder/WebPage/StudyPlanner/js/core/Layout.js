/* ============================================================
   LAYOUT — algorithms (stack, absolute, relative, remove gaps)
   Depends on Geometry for spatial primitives
   ============================================================ */

import {
  MATRIX_COLS,
  MATRIX_ROWS,
} from "../constants.js";

import {
  courses,
  layoutMode,
  magnetStep,
} from "../state.js";

import {
  snapCol,
  courseRect,
  proposedRect,
  visiblePlacedCourses,
  rectsOverlap,
  canPlace,
  occupy,
  blockersAt,
  naturalRow,
  tryPushAndPlace,
  placeFixedCourses,
} from "./Geometry.js";

import { relativeOrderKey } from "../data/normalise.js";

/** Stack layout: pack left per period-row */
export function autoLayoutMovable(isVisibleOnGrid) {
  if (layoutMode === "absolute") {
    layoutAbsolute(isVisibleOnGrid);
    return;
  }
  if (layoutMode === "relative") {
    layoutRelative(isVisibleOnGrid);
    return;
  }
  // stack (default): pack left per period-row
  const groups = {};
  courses.forEach(c => {
    if (!c.CanMove || !isVisibleOnGrid(c)) return;
    const key = c.Year * 4 + c.primaryPeriod;
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  });
  Object.keys(groups).sort((a, b) => a - b).forEach(key => {
    const list = groups[key];
    list.sort((a, b) => {
      const d = relativeOrderKey(a) - relativeOrderKey(b);
      if (d !== 0) return d;
      return (a.Code || "").localeCompare(b.Code || "");
    });
    const row = naturalRow(list[0]);
    let col = 0;
    list.forEach(c => {
      let placed = false;
      while (col + c.hitW <= MATRIX_COLS) {
        if (canPlace(c, col, row)) {
          occupy(c, col, row);
          col += c.hitW;
          placed = true;
          break;
        }
        col += magnetStep || 1;
      }
      if (!placed) occupy(c, Math.max(0, MATRIX_COLS - c.hitW), row);
    });
  });
}

/** Absolute layout: col := RelativeVal[0]; row := saved or natural; light right-push on overlap */
export function layoutAbsolute(isVisibleOnGrid) {
  const list = courses.filter(c => isVisibleOnGrid(c)).slice();
  list.sort((a, b) => {
    const ca = (a.RelativeVal && a.RelativeVal[0]) || 0;
    const cb = (b.RelativeVal && b.RelativeVal[0]) || 0;
    if (ca !== cb) return ca - cb;
    return (a.Code || "").localeCompare(b.Code || "");
  });
  // clear positions of movable visible so canPlace sees only locked
  list.forEach(c => {
    if (c.CanMove) c.GridPosition = null;
  });
  list.forEach(c => {
    if (!c.CanMove && c.GridPosition) return;
    let col = snapCol((c.RelativeVal && c.RelativeVal[0]) || 0);
    let row = (c.GridPosition && c.GridPosition.row != null) ? c.GridPosition.row : naturalRow(c);
    // fix period band
    const periodOffset = (c.primaryPeriod - 1) % 4;
    const block = Math.floor(row / 4);
    row = block * 4 + periodOffset;
    col = Math.max(0, Math.min(MATRIX_COLS - c.hitW, col));
    if (!canPlace(c, col, row)) {
      let found = false;
      for (let nc = col; nc <= MATRIX_COLS - c.hitW; nc += (magnetStep || 1)) {
        if (canPlace(c, nc, row)) { col = nc; found = true; break; }
      }
      if (!found) col = Math.max(0, MATRIX_COLS - c.hitW);
    }
    occupy(c, col, row);
  });
}

/** Pack current visible positions by deleting empty integer columns (no Absolute) */
export function removeGapsOnly() {
  const occupied = new Set();
  visiblePlacedCourses().forEach(c => {
    const r = courseRect(c);
    if (!r) return;
    const c0 = Math.floor(r.col + 1e-9);
    const c1 = Math.ceil(r.col + r.w - 1e-9) - 1;
    for (let i = c0; i <= c1; i++) occupied.add(i);
  });
  const map = {};
  let next = 0;
  for (let i = 0; i < MATRIX_COLS; i++) {
    if (occupied.has(i)) {
      map[i] = next;
      next++;
    }
  }
  visiblePlacedCourses().forEach(c => {
    const col = c.GridPosition.col;
    const base = Math.floor(col + 1e-9);
    const frac = col - base;
    const mapped = (map[base] != null) ? map[base] + frac : col;
    occupy(c, mapped, c.GridPosition.row);
  });
}

/** Relative = Absolute layout, then delete entire empty integer columns */
export function layoutRelative(isVisibleOnGrid) {
  layoutAbsolute(isVisibleOnGrid);

  // Collect integer columns occupied by any visible course (using hit rect)
  const occupied = new Set();
  visiblePlacedCourses().forEach(c => {
    const r = courseRect(c);
    if (!r) return;
    const c0 = Math.floor(r.col + 1e-9);
    const c1 = Math.ceil(r.col + r.w - 1e-9) - 1;
    for (let i = c0; i <= c1; i++) occupied.add(i);
  });

  // Mapping: old integer col → new col after removing empties
  const maxCol = MATRIX_COLS;
  const map = {};
  let next = 0;
  for (let i = 0; i < maxCol; i++) {
    if (occupied.has(i)) {
      map[i] = next;
      next++;
    }
  }

  visiblePlacedCourses().forEach(c => {
    const col = c.GridPosition.col;
    const base = Math.floor(col + 1e-9);
    const frac = col - base;
    const mapped = (map[base] != null) ? map[base] + frac : col;
    occupy(c, mapped, c.GridPosition.row);
  });
}

/** Full recompute: fixed first, then movable per current layoutMode */
export function recomputeLayout(isVisibleOnGrid) {
  // Clear movable positions
  courses.forEach(c => {
    if (c.CanMove) c.GridPosition = null;
  });
  placeFixedCourses(isVisibleOnGrid, naturalRow);
  autoLayoutMovable(isVisibleOnGrid);
}
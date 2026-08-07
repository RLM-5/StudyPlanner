/* ============================================================
   GEOMETRY — pure spatial math & collision detection
   No DOM manipulation except buildCanvas/syncGutterScroll
   ============================================================ */

import {
  MATRIX_COLS,
  MATRIX_ROWS,
  LABEL_COLS,
  EXTRA_SCROLL_COLS_LEFT,
  EXTRA_SCROLL_COLS_RIGHT,
  EXTRA_SCROLL_ROWS,
} from "../constants.js";

import {
  courses,
  magnetStep,
  FIVE_WIDTH,
  PERIOD_HEIGHT,
} from "../state.js";

/** Snap a column value to the current magnetisation grid */
export function snapCol(col) {
  const m = magnetStep || 1;
  return Math.round(col / m) * m;
}

/** Visible rectangle of a placed course in matrix units */
export function courseRect(c) {
  if (!c || !c.GridPosition) return null;
  return {
    course: c,
    code: c.Code,
    col: Number(c.GridPosition.col),
    row: Number(c.GridPosition.row),
    w: c.hitW,
    h: c.hitH,
    canMove: !!c.CanMove
  };
}

/** Proposed rectangle for placement test */
export function proposedRect(course, col, row) {
  return { col, row, w: course.hitW, h: course.hitH };
}

/** All currently visible courses that have a position */
export function visiblePlacedCourses(excludeCode) {
  return courses.filter(c => {
    if (!isVisibleOnGrid(c)) return false;
    if (!c.GridPosition) return false;
    if (excludeCode && c.Code === excludeCode) return false;
    return true;
  });
}

/** Rectangle overlap test (matrix units) */
export function rectsOverlap(a, b) {
  return a.col < b.col + b.w && a.col + a.w > b.col &&
         a.row < b.row + b.h && a.row + a.h > b.row;
}

/**
 * Can `course` occupy (col,row) without overlapping any other *visible* course?
 * excludeCodes: set of codes ignored (the course itself, or temporarily lifted).
 */
export function canPlace(course, col, row, excludeCodes, showParityIssues, isParityAllowedAtRow) {
  if (col < 0 || row < 0) return false;
  if (col + course.hitW > MATRIX_COLS + 1e-9) return false;
  if (row + course.hitH > MATRIX_ROWS + 1e-9) return false;
  const self = proposedRect(course, col, row);
  const skip = excludeCodes || new Set([course.Code]);
  for (const other of visiblePlacedCourses()) {
    if (skip.has(other.Code)) continue;
    const r = courseRect(other);
    if (r && rectsOverlap(self, r)) return false;
  }
  // Parity is advisory only (checked by caller if needed)
  return true;
}

/** Set GridPosition; no matrix write */
export function occupy(course, col, row) {
  course.GridPosition = { col: snapCol(col), row: Math.round(row) };
}

/** Keep GridPosition for restore; visibility gating is what matters for collisions */
export function clearCourseFromMatrix(course) {
  // Callers that truly remove use course.GridPosition = null
}

/**
 * Collect overlapping visible courses at proposed placement.
 * Returns null if any non-movable blocker is present.
 * Otherwise returns the set of movable courses that must be pushed.
 */
export function blockersAt(course, col, row, excludeCodes) {
  const self = proposedRect(course, col, row);
  const skip = excludeCodes || new Set([course.Code]);
  const set = new Set();
  for (const other of visiblePlacedCourses()) {
    if (skip.has(other.Code)) continue;
    const r = courseRect(other);
    if (!r || !rectsOverlap(self, r)) continue;
    if (!other.CanMove) return null; // hard block
    set.add(other);
  }
  return set;
}

/** Natural row for a course based on its Year and primaryPeriod */
export function naturalRow(course) {
  // Year -2 → block 0 … Year 3 → block 5
  const yearBase = (Number(course.Year) + 2) * 4;
  const periodOffset = ((course.primaryPeriod || 1) - 1) % 4;
  return Math.max(0, Math.min(MATRIX_ROWS - 1, yearBase + periodOffset));
}

/**
 * Allowed rows for a course given its period alternatives and year block preference.
 * Year may change; period band follows chosen alternative.
 */
export function allowedRowsForCourse(course, preferredBlock, expandPeriodAlternatives) {
  const exp = expandPeriodAlternatives(course.Periods, course.activePeriodAlt);
  const nBlocks = MATRIX_ROWS / 4;
  const blocks = [];
  if (preferredBlock != null) blocks.push(preferredBlock);
  for (let b = 0; b < nBlocks; b++) if (!blocks.includes(b)) blocks.push(b);
  const rows = [];
  for (const b of blocks) {
    for (let ai = 0; ai < exp.alternatives.length; ai++) {
      const start = exp.alternatives[ai][0];
      const h = exp.alternatives[ai].length;
      const row = b * 4 + ((start - 1) % 4);
      if (row + h <= MATRIX_ROWS) rows.push({ row, altIndex: ai, height: h });
    }
  }
  return rows;
}

/** Pixel X of matrix column 0 (courses start after left pad + label gutter) */
export function courseOriginX() {
  return (EXTRA_SCROLL_COLS_LEFT + LABEL_COLS) * FIVE_WIDTH;
}

/** Pixel X of label gutter origin */
export function labelOriginX() {
  return EXTRA_SCROLL_COLS_LEFT * FIVE_WIDTH;
}

/** Build the canvas and gutter grid lines + labels */
export function buildCanvas(
  renderCourses,
  syncGutterScroll,
  isParityAllowedAtRow,
  showParityIssues
) {
  const canvas = document.getElementById("bulk-canvas");
  const gutterInner = document.getElementById("bulk-gutter-inner");
  const gutter = document.getElementById("bulk-gutter");
  canvas.innerHTML = "";
  if (gutterInner) gutterInner.innerHTML = "";

  const w = (EXTRA_SCROLL_COLS_LEFT + LABEL_COLS + MATRIX_COLS + EXTRA_SCROLL_COLS_RIGHT) * FIVE_WIDTH;
  const h = (MATRIX_ROWS + EXTRA_SCROLL_ROWS) * PERIOD_HEIGHT;
  canvas.style.width  = w + "px";
  canvas.style.height = h + "px";
  if (gutterInner) gutterInner.style.height = h + "px";
  if (gutter) {
    gutter.style.flexBasis = (LABEL_COLS * FIVE_WIDTH) + "px";
    gutter.style.width = (LABEL_COLS * FIVE_WIDTH) + "px";
  }

  const ox = courseOriginX();
  const mediumStart = ox + (-2 + 0.5) * FIVE_WIDTH;
  const thinStart   = ox + (-2 + 1.0) * FIVE_WIDTH;

  // Main canvas horizontal grid lines
  for (let i = 0; i <= MATRIX_ROWS; i++) {
    const line = document.createElement("div");
    line.className = "grid-line";
    const mod = i % 4;
    if (mod === 0) {
      line.classList.add("thick");
      line.style.left = "0";
    } else if (mod === 2) {
      line.classList.add("medium");
      line.style.left = Math.max(0, mediumStart) + "px";
    } else {
      line.classList.add("thin");
      line.style.left = Math.max(0, thinStart) + "px";
    }
    line.style.right = "0";
    line.style.top = (i * PERIOD_HEIGHT) + "px";
    canvas.appendChild(line);
  }

  // Gutter: same line tops + labels (opaque fixed strip; Y synced via scrollTop)
  if (gutterInner) {
    for (let i = 0; i <= MATRIX_ROWS; i++) {
      const gl = document.createElement("div");
      gl.className = "gutter-line";
      const mod = i % 4;
      if (mod === 0) gl.classList.add("thick");
      else if (mod === 2) gl.classList.add("medium");
      else gl.classList.add("thin");
      gl.style.top = (i * PERIOD_HEIGHT) + "px";
      gutterInner.appendChild(gl);
    }
    for (let block = 0; block < MATRIX_ROWS / 4; block++) {
      const baseRow = block * 4;
      const yearIdx = block - 2;
      if (yearIdx !== 3) {
        const yearLbl = document.createElement("div");
        yearLbl.className = "grid-label year";
        yearLbl.textContent = "Year " + yearIdx;
        yearLbl.style.left = "4px";
        yearLbl.style.top  = ((baseRow + 2) * PERIOD_HEIGHT - 5) + "px";
        gutterInner.appendChild(yearLbl);
      }
      const fallLbl = document.createElement("div");
      fallLbl.className = "grid-label season";
      fallLbl.textContent = "Fall";
      fallLbl.style.left = (0.25 * FIVE_WIDTH) + "px";
      fallLbl.style.top  = ((baseRow + 1) * PERIOD_HEIGHT - 5) + "px";
      gutterInner.appendChild(fallLbl);

      const springLbl = document.createElement("div");
      springLbl.className = "grid-label season";
      springLbl.textContent = "Spring";
      springLbl.style.left = (0.25 * FIVE_WIDTH) + "px";
      springLbl.style.top  = ((baseRow + 3) * PERIOD_HEIGHT - 5) + "px";
      gutterInner.appendChild(springLbl);

      for (let p = 0; p < 4; p++) {
        const pLbl = document.createElement("div");
        pLbl.className = "grid-label period";
        pLbl.textContent = "P" + (p + 1);
        pLbl.style.right = "6px";
        pLbl.style.left = "auto";
        pLbl.style.top  = ((baseRow + p) * PERIOD_HEIGHT + PERIOD_HEIGHT / 2 - 5) + "px";
        gutterInner.appendChild(pLbl);
      }
    }
    // Calendar years at thick boundaries between Yr-2…Yr-2 only
    const calBoundaries = [
      { row: 4,  nextYear: -1 },
      { row: 8,  nextYear: 0 },
      { row: 12, nextYear: 1 },
      { row: 16, nextYear: 2 }
    ];
    calBoundaries.forEach(({ row, nextYear }) => {
      const cal = masterStartYear + (nextYear - 1);
      const lbl = document.createElement("div");
      lbl.className = "grid-label year";
      lbl.textContent = String(cal);
      lbl.style.left = "4px";
      lbl.style.top = (row * PERIOD_HEIGHT - 11) + "px";
      lbl.style.fontSize = "12px";
      lbl.style.color = "#fc6";
      gutterInner.appendChild(lbl);
    });
  }
  syncGutterScroll();
}

/**
 * Keep gutter labels/lines glued to canvas grid lines.
 * Gutter is OUTSIDE #P_Bulk, so it does not scroll by itself —
 * we apply a single translateY(-scrollTop).
 */
export function syncGutterScroll() {
  const bulk = document.getElementById("P_Bulk");
  const inner = document.getElementById("bulk-gutter-inner");
  if (!bulk || !inner) return;
  const y = -bulk.scrollTop;
  inner.style.transform = "translate3d(0," + y + "px,0)";
  inner.style.top = "0px";
}

/** Scroll so the centre-of-mass of visible courses is centred in the viewport */
export function scrollToCoursesCenter() {
  const bulk = document.getElementById("P_Bulk");
  if (!bulk) return;
  const ox = courseOriginX();
  const vis = courses.filter(c => isVisibleOnGrid(c) && c.GridPosition);
  if (vis.length === 0) {
    scrollToYear1();
    return;
  }
  let sx = 0, sy = 0;
  vis.forEach(c => {
    sx += ox + (c.GridPosition.col + c.hitW / 2) * FIVE_WIDTH;
    sy += (c.GridPosition.row + c.hitH / 2) * PERIOD_HEIGHT;
  });
  const cx = sx / vis.length;
  const cy = sy / vis.length;
  bulk.scrollLeft = Math.max(0, cx - bulk.clientWidth / 2);
  bulk.scrollTop  = Math.max(0, cy - bulk.clientHeight / 2);
  syncGutterScroll();
}

export function scrollToYear1() {
  const bulk = document.getElementById("P_Bulk");
  const row = (1 + 2) * 4;   // 12
  bulk.scrollTop = row * PERIOD_HEIGHT;
  bulk.scrollLeft = EXTRA_SCROLL_COLS_LEFT * FIVE_WIDTH;
}

/** Place fixed (non-movable) courses at their natural positions */
export function placeFixedCourses(isVisibleOnGrid, naturalRow) {
  courses.forEach(c => {
    if (!c.CanMove && isVisibleOnGrid(c)) {
      if (!c.GridPosition) {
        const row = naturalRow(c);
        c.GridPosition = { col: 0, row: row };
      }
      occupy(c, c.GridPosition.col, c.GridPosition.row);
    }
  });
}

// Re-export isVisibleOnGrid dependency - imported from UI/visibility
let isVisibleOnGrid = null;
let masterStartYear = 2026;

export function setVisibilityChecker(fn) { isVisibleOnGrid = fn; }
export function setMasterStartYear(year) { masterStartYear = year; }
export function getMasterStartYear() { return masterStartYear; }
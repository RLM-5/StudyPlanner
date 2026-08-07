/* ============================================================
   MUTABLE GLOBAL STATE — all let/var declarations
   ============================================================ */

import { BASE_FIVE_WIDTH, BASE_PERIOD_HEIGHT } from "./constants.js";

/** Current pixels per matrix column (scales with zoom) */
export let FIVE_WIDTH = BASE_FIVE_WIDTH;

/** Current pixels per matrix row (scales with zoom) */
export let PERIOD_HEIGHT = BASE_PERIOD_HEIGHT;

/** Current zoom percentage (50–150) */
export let zoomPercent = 100;

/** All course instances */
export let courses = [];

/** Currently selected course codes */
export let selectedCodes = new Set();

/** Legacy removed codes; prefer course.Visibility = "Hidden" */
export let removedCodes = new Set();

/** Currently active tag filters */
export let activeTags = new Set();

/** Horizontal magnetisation step in column units: 1 | 0.5 | 0.25 */
export let magnetStep = 1;

/** Layout recompute mode: "stack" | "absolute" | "relative" */
export let layoutMode = "stack";

/** Calendar year of Fall of academic Year 1 (default 2026) */
export let masterStartYear = 2026;

/** When true, boxes on wrong calendar parity get a red frame */
export let showParityIssues = true;

/** Undo stack: each entry is a JSON string of buildSavePayload() */
export let undoStack = [];

/** Redo stack */
export let redoStack = [];

/** True while applying undo/redo/load (suppresses history pushes) */
export let historySuspended = false;

/** Drag state: { course, startX, startY, origCol, origRow, offsetX, offsetY } */
export let dragState = null;

/** Course under right-click (main grid) */
export let contextTarget = null;

/** Course under right-click (hidden panel) */
export let contextTargetHidden = null;

/** Last successful upload snapshot (for Reset button) */
export let lastUploadSnapshot = null;

/** Panel widths persisted in localStorage */
export const panelWidths = {
  P_Choices: null,
  P_Hidden: null,
  P_Description: null,
};

/** Current colour scheme (merged with defaults) */
export let colorScheme = {};
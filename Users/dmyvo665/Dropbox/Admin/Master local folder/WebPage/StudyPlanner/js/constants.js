/* ============================================================
   CONSTANTS — true constants only (no mutable state)
   ============================================================ */

/** Application version — keep in sync with latest study-planner-v# zip */
export const APP_VERSION = "0.33";

/** Base pixels per matrix column at 100% zoom */
export const BASE_FIVE_WIDTH = 80;

/** Base pixels per matrix row at 100% zoom */
export const BASE_PERIOD_HEIGHT = 48;

/** Logical matrix columns (expanded for denser catalogues) */
export const MATRIX_COLS = 67;

/** Logical matrix rows (6 year-blocks × 4 period-rows) */
export const MATRIX_ROWS = 24;

/** Reserved left columns; courses start at visual col ≥ 2 */
export const LABEL_COLS = 2;

/** Extra empty space for scrolling */
export const EXTRA_SCROLL_COLS_LEFT = 16;
export const EXTRA_SCROLL_COLS_RIGHT = 120;
export const EXTRA_SCROLL_ROWS = 8;

/** Track tag keys (university pathways) */
export const TRACK_TAG_KEYS = ["MP", "TP", "NP", "SE", "AS", "MC", "GP"];

/** Special logical tag keys (disjoint from tracks) */
export const SPECIAL_TAG_KEYS = ["Prog", "TO", "Proj"];

/** All tag keys combined */
export const ALL_TAG_KEYS = [...TRACK_TAG_KEYS, ...SPECIAL_TAG_KEYS];

/** Maximum undo/redo history entries */
export const MAX_HISTORY = 40;

/** Project course codes (hardcoded list) */
export const PROJECT_COURSE_CODES = new Set([
  "1FA193", "1FA195", "1FA298", "1FA392", "1FA394", "1FA467", "1FA565",
  "1FA566", "1FA593", "1FA595", "1FA597", "1FA598", "1FA599",
]);

/** Programming course codes */
export const PROGR_COURSE_CODES = new Set([
  "1TD062", "1TD354"
]);

/** Degree project depth codes */
export const DEGREE_PROJECT_DEPTHS = new Set(["G1E", "G2E", "A1E", "A2E"]);

/** Default colour scheme (track → hex) */
export const DEFAULT_COLOR_SCHEME = {
  MP: "#2f3d6b",          // mathematical — blue-indigo
  TP: "#1e6b3a",          // theoretical physics — green
  NP: "#6b2f2f",          // nuclear — deep red
  SE: "#5a3a6b",          // space — purple
  AS: "#6b5a2f",          // applied — amber
  MC: "#2f6b6b",          // medical — teal
  GP: "#6b2f4a",          // geophysics — magenta
  Prog: "#2f5a6b",        // programming — cyan-blue
  TO: "#5a6b2f",          // teaching & outreach — lime-green
  Proj: "#6b4a2f",        // projects — orange-brown
};

/** Text fields that may contain HTML entities needing decoding */
export const TEXT_FIELDS_TO_DECODE = [
  "Name", "ShortName", "About", "Content", "Instruction", "Assesment",
  "Learning Outcomes", "Entry Requirements", "otherDirectives",
];
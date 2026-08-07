/* ============================================================
   CONSTANTS & GLOBAL STATE
   ============================================================ */
const APP_VERSION = "0.33";  // keep in sync with latest study-planner-v# zip
const BASE_FIVE_WIDTH    = 80;     // px per matrix column at 100% zoom
const BASE_PERIOD_HEIGHT = 48;     // px per matrix row at 100% zoom
let FIVE_WIDTH    = BASE_FIVE_WIDTH;
let PERIOD_HEIGHT = BASE_PERIOD_HEIGHT;
let zoomPercent = 100;             // 50..150
const MATRIX_COLS   = 67; // was 40; expanded by 5/3 for denser catalogues
const MATRIX_ROWS   = 24;          // 6 year-blocks × 4 period-rows
const LABEL_COLS    = 2;           // reserved left columns; courses from col-2 onwards
// Extra empty space so the view can scroll freely
const EXTRA_SCROLL_COLS_LEFT  = 16; // empty space left of labels (clear side panels)
const EXTRA_SCROLL_COLS_RIGHT = 120; // long horizontal lines to the right
const EXTRA_SCROLL_ROWS       = 8;  // further down past the last year

// Coordinate system:
// (0, 0) in matrix space is the top-left of the logical grid.
// Screen y increases downward; we map matrix row 0 to the top.
// The origin of the bulk coordinate system is the top-left of the canvas.

let courses = [];                 // array of Course objects
// positionMatrix retired — collisions use visible course rects only
let selectedCodes = new Set();    // currently selected course codes
let removedCodes  = new Set();    // legacy; prefer course.Visibility = "Hidden"
const TRACK_TAG_KEYS = ["MP","TP","NP","SE","AS","MC","GP"];
const SPECIAL_TAG_KEYS = ["Prog","TO","Proj"]; // Programming, Teaching&Outreach, Projects
const ALL_TAG_KEYS = TRACK_TAG_KEYS.concat(SPECIAL_TAG_KEYS);
let activeTags = new Set(ALL_TAG_KEYS);


/**
 * Font scale for course *names* only: linear with zoom in [75%, 125%],
 * clamped outside that range (75% floor, 125% ceiling).
 */
function nameFontZoomFactor() {
  const z = Math.max(75, Math.min(125, Number(zoomPercent) || 100));
  return z / 100;
}

function applyZoom(percent, preserveFocus) {
  percent = Math.max(50, Math.min(150, Math.round(percent / 5) * 5));
  const bulk = document.getElementById("P_Bulk");
  let focusCol = 0, focusRow = 0;
  if (preserveFocus && bulk) {
    // centre of viewport in matrix units before zoom
    focusCol = (bulk.scrollLeft + bulk.clientWidth / 2) / FIVE_WIDTH;
    focusRow = (bulk.scrollTop + bulk.clientHeight / 2) / PERIOD_HEIGHT;
  }
  zoomPercent = percent;
  FIVE_WIDTH = BASE_FIVE_WIDTH * (zoomPercent / 100);
  PERIOD_HEIGHT = BASE_PERIOD_HEIGHT * (zoomPercent / 100);
  document.documentElement.style.setProperty("--five-width", FIVE_WIDTH + "px");
  document.documentElement.style.setProperty("--period-height", PERIOD_HEIGHT + "px");
  const zl = document.getElementById("zoom-label");
  if (zl) zl.textContent = zoomPercent + "%";
  const zr = document.getElementById("zoom-range");
  if (zr) zr.value = String(zoomPercent);
  buildCanvas();
  renderCourses();
  if (preserveFocus && bulk) {
    bulk.scrollLeft = Math.max(0, focusCol * FIVE_WIDTH - bulk.clientWidth / 2);
    bulk.scrollTop  = Math.max(0, focusRow * PERIOD_HEIGHT - bulk.clientHeight / 2);
    syncGutterScroll();
  }
}

/** Horizontal magnetisation step in column units: 1 | 0.5 | 0.25 */
let magnetStep = 1;
/** Layout recompute mode: "stack" | "absolute" | "relative" */
let layoutMode = "stack";
/** Calendar year of Fall of academic Year 1 (default 2026) */
let masterStartYear = 2026;
/** When true, boxes on wrong calendar parity get a red frame */
let showParityIssues = true;

/** Undo / redo stacks: each entry is a JSON string of buildSavePayload() */
const MAX_HISTORY = 40;
let undoStack = [];
let redoStack = [];
let historySuspended = false; // true while applying undo/redo/load


/** Strip trailing depth codes (A1N, G2F, …) from a main-field string */
function stripDepthSuffixFromField(s) {
  return String(s || "").replace(/\s+[A-Za-z]+\d[A-Za-z]?\s*$/g, "").trim();
}

/**
 * Normalize Main Field(s) to a clean string array.
 * Accepts string, comma-separated string, or array; strips depth suffixes.
 */
function getMainFieldsList(course) {
  if (!course) return [];
  let raw = course["Main Field(s)"];
  if (raw == null || raw === "") {
    raw = course["Main Field(s) of Studies"] || course["Main Fields"];
  }
  if (raw == null || raw === "") return [];
  let parts;
  if (Array.isArray(raw)) parts = raw;
  else parts = String(raw).split(/\s*,\s*/);
  return parts
    .map(p => stripDepthSuffixFromField(p))
    .filter(p => p.length > 0);
}

let dragState = null;             // { course, startX, startY, origCol, origRow, offsetX, offsetY }
let contextTarget = null;         // course under right-click (main grid)
let contextTargetHidden = null;   // course under right-click (hidden panel)

/* ============================================================
   IMPORT NORMALISATION (MaFy / UU syllabus JSON → planner fields)
   ============================================================ */
/**
 * Parse Periods into a canonical form supporting:
 *  - legacy [1,2] or ["*",3,4]
 *  - alternatives [[2],[1],[3]]  // OR of single periods; default = first
 *  - multi-block [[1,2],[2,3]]   // OR of spans
 *  - year-wrap [[4,1]]           // period 4 then period 1 next year
 *  - string forms "{{2},{1},{3}}" (rare; usually already arrays from JSON)
 *
 * Returns a flat legacy-compatible array for storage when only one alternative,
 * or nested arrays when multiple alternatives exist. Always arrays of numbers,
 * optionally with leading "*" for fully flexible courses.
 */
function parsePeriodsField(raw) {
  if (raw == null) return [1];
  // string like "{{1,2},{2,3}}"
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("{{") || t.startsWith("{")) {
      try {
        // normalize to JSON-ish: {{1,2},{2,3}} → [[1,2],[2,3]]
        const jsonish = t.replace(/\{/g, "[").replace(/\}/g, "]");
        raw = JSON.parse(jsonish);
      } catch (_) {
        raw = [1];
      }
    } else {
      raw = t.split(/[,;\s]+/).filter(Boolean);
    }
  }
  if (!Array.isArray(raw) || raw.length === 0) return [1];

  // Nested alternatives: array of arrays (or mix)
  const looksNested = raw.some(item => Array.isArray(item));
  if (looksNested) {
    const alts = [];
    raw.forEach(item => {
      if (Array.isArray(item)) {
        const nums = item.map(x => parseInt(x, 10)).filter(n => !isNaN(n) && n >= 1 && n <= 4);
        if (nums.length) alts.push(nums);
      } else if (item === "*" || String(item).trim() === "*") {
        // flexible marker at top level with nested alts ignored
      } else {
        const n = parseInt(item, 10);
        if (!isNaN(n) && n >= 1 && n <= 4) alts.push([n]);
      }
    });
    if (!alts.length) return [1];
    if (alts.length === 1) return alts[0];
    return alts; // multiple alternatives
  }

  // Flat legacy
  let any = false;
  const nums = [];
  raw.forEach(item => {
    if (item === "*" || String(item).trim() === "*") {
      any = true;
      return;
    }
    const s = String(item).trim();
    if (!s) return;
    if (s.includes("-")) {
      const parts = s.split("-").map(x => parseInt(x, 10));
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        for (let i = parts[0]; i <= parts[1]; i++) {
          if (i >= 1 && i <= 4) nums.push(i);
        }
      }
    } else {
      const n = parseInt(s, 10);
      if (!isNaN(n) && n >= 1 && n <= 4) nums.push(n);
    }
  });
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  if (any) return ["*", ...(uniq.length ? uniq : [1])];
  return uniq.length ? uniq : [1];
}

/**
 * Expand Periods into { alternatives: number[][], flexible: boolean, activeIndex }.
 * flexible: course may start in any period (legacy "*").
 */
function expandPeriodAlternatives(periods, activeIndex) {
  if (!Array.isArray(periods) || periods.length === 0) {
    return { alternatives: [[1]], flexible: false, activeIndex: 0 };
  }
  const flexible = periods[0] === "*" || String(periods[0]).trim() === "*";
  const body = flexible ? periods.slice(1) : periods;

  let alternatives;
  if (body.some(item => Array.isArray(item))) {
    alternatives = body
      .filter(Array.isArray)
      .map(a => a.map(Number).filter(n => n >= 1 && n <= 4))
      .filter(a => a.length);
  } else {
    const nums = body.map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 4);
    alternatives = [nums.length ? nums : [1]];
  }
  if (!alternatives.length) alternatives = [[1]];

  // Flexible with a recommended span: allow any start with same duration
  if (flexible) {
    const dur = Math.max(1, (alternatives[0] || [1]).length);
    const alts = [];
    for (let start = 1; start <= 4; start++) {
      const block = [];
      for (let k = 0; k < dur; k++) {
        block.push(((start - 1 + k) % 4) + 1);
      }
      alts.push(block);
    }
    // put recommended first if it matches one of the original nums
    const rec = alternatives[0];
    const recKey = rec.join(",");
    alts.sort((a, b) => (a.join(",") === recKey ? -1 : b.join(",") === recKey ? 1 : 0));
    alternatives = alts;
  }

  let idx = Number.isInteger(activeIndex) ? activeIndex : 0;
  if (idx < 0 || idx >= alternatives.length) idx = 0;
  return { alternatives, flexible, activeIndex: idx };
}

/** Numeric period list for the *active* alternative (ignores "*") */
function numericPeriods(periods, activeIndex) {
  const exp = expandPeriodAlternatives(periods, activeIndex);
  return exp.alternatives[exp.activeIndex] || [1];
}

const PROJECT_COURSE_CODES = new Set([
  "1FA193", "1FA195", "1FA298", "1FA392", "1FA394", "1FA467", "1FA565",
  "1FA566", "1FA593", "1FA595", "1FA597", "1FA598", "1FA599",
  "1FA605", "1FA650", "1FA669", "1FA690", "1FA691", "1FA692", "1FA693",
  "1FA694", "1FA696", "1GE029", "1GE030", "1GE031", "1GE032", "1GE034", 
  "1GE038", "1ME411", "1ME422", "1ME425", "1ME426", "1ME436", "1ME446",
  "1FA029", "1ME421"
]);

const PROGR_COURSE_CODES = new Set([
  "1TD062", "1TD354"
]);

const DEGREE_PROJECT_DEPTHS = new Set(["G1E", "G2E", "A1E", "A2E"]);

function isProjectCourse(data) {
  return PROJECT_COURSE_CODES.has(String(data.Code || ""));
}

/** True if Periods already starts with "*" (properly formatted flexible course) */
function periodsStartWithStar(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  return raw[0] === "*" || String(raw[0]).trim() === "*";
}

/**
 * Format a project course Periods as ["*", start, …, 4] so duration ends in period 4.
 * Duration = ceil(credits / 15).
 */
function formatProjectPeriods(credits) {
  const n = Math.max(1, Math.ceil((Number(credits) || 15) / 15));
  const start = Math.max(1, 5 - n);
  const nums = [];
  for (let p = start; p <= 4; p++) nums.push(p);
  return ["*", ...nums];
}

function parseSeasonFromData(data, periods) {
  const af = String(data.appliesFrom || "").toLowerCase();
  if (af.includes("spring") || af.startsWith("vt")) return "spring";
  if (af.includes("autumn") || af.includes("fall") || af.startsWith("ht")) return "autumn";
  // Fall = periods 1–2, Spring = periods 3–4
  const p0 = (periods && periods[0]) || 1;
  return p0 <= 2 ? "autumn" : "spring";
}

/**
 * Year index from Depth + season (planner years −2…3):
 *  G1N, G1F-spring → −2
 *  G1F-autumn, G2F-spring → −1
 *  G2F (else), G2E, G1E → 0
 *  A1N, A1E, A1F-spring → 1
 *  A1F-fall, A2E → 2
 */
function computeYearFromDepth(depth, season) {
  const d = String(depth || "").toUpperCase().trim();
  if (d === "G1N") return -2;
  if (d === "G1F") return season === "spring" ? -2 : -1;
  if (d === "G2F") return season === "spring" ? -1 : 0;
  if (d === "G2E" || d === "G1E") return 0;
  if (d === "A1N" || d === "A1E") return 1;
  if (d === "A1F") return season === "spring" ? 1 : 2;
  if (d === "A2E") return 2;
  return 0;
}

/**
 * Decode syllabus text macros / entities into plain display text.
 * Applied on load; saved JSON stores the decoded form.
 *  \n → newline; &bullet; → •; &apos; &quot; &amp; etc.
 */
function decodeSyllabusText(s) {
  if (s == null) return "";
  if (typeof s !== "string") return s;
  let t = s;
  t = t.replace(/\\n/g, "\n");
  t = t.replace(/\\t/g, "\t");
  t = t.replace(/&bullet;/gi, "•");
  t = t.replace(/&bull;/gi, "•");
  t = t.replace(/&apos;/g, "'");
  t = t.replace(/&quot;/g, "\"");
  t = t.replace(/&nbsp;/g, "\u00a0");
  t = t.replace(/&ndash;/g, "–");
  t = t.replace(/&mdash;/g, "—");
  t = t.replace(/&hellip;/g, "…");
  t = t.replace(/&Aring;/g, "Å");
  t = t.replace(/&aring;/g, "å");
  t = t.replace(/&Auml;/g, "Ä");
  t = t.replace(/&auml;/g, "ä");
  t = t.replace(/&Ouml;/g, "Ö");
  t = t.replace(/&ouml;/g, "ö");
  t = t.replace(/&#(\d+);/g, (_, n) => {
    const c = parseInt(n, 10);
    return (c >= 0 && c <= 0x10ffff) ? String.fromCodePoint(c) : _;
  });
  t = t.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    const c = parseInt(h, 16);
    return (c >= 0 && c <= 0x10ffff) ? String.fromCodePoint(c) : _;
  });
  t = t.replace(/&lt;/g, "<");
  t = t.replace(/&gt;/g, ">");
  t = t.replace(/&amp;/g, "&");
  return t;
}

const TEXT_FIELDS_TO_DECODE = [
  "Name", "ShortName", "About", "Content", "Instruction", "Assesment",
  "Learning Outcomes", "Entry Requirements", "otherDirectives",
  "generalProvisions", "gradingSystem", "Department", "level", "levelFormal",
  "Main Field(s) of Studies", "appliesFrom", "finalisedBy"
];

/**
 * Suggest a compact ShortName from the full course title.
 * Prefers meaningful words (skips stop-words), builds an acronym-style
 * or truncated phrase that fits in a course box.
 */
function suggestShortName(name, code) {
  const STOP = new Set([
    "a","an","the","of","and","or","in","on","for","to","with","from","by","at",
    "into","onto","via","as","is","are","be","its","their","this","that","these",
    "those","course","courses","introduction","intro","basic","basics","advanced",
    "i","ii","iii","iv","v","part","level","programme","program","study","studies"
  ]);
  const raw = String(name || "").trim();
  if (!raw) return code || "Course";

  // Split on spaces / punctuation, keep alphanumeric tokens
  const tokens = raw
    .replace(/[–—]/g, " ")
    .split(/[\s/&,;:()[\]{}]+/)
    .map(t => t.trim())
    .filter(Boolean);

  const meaningful = tokens.filter(t => {
    const low = t.toLowerCase();
    // keep roman numerals / short codes that are not pure stop words
    if (/^[IVX]+$/i.test(t)) return true;
    if (/^\d+$/.test(t)) return false;
    return !STOP.has(low);
  });

  const words = meaningful.length ? meaningful : tokens;

  // Prefer readable phrases (no ellipsis). Font scaling on the box handles fit.
  // 1–4 words: keep as title-cased phrase
  if (words.length <= 4) {
    return words.map(w =>
      /^[IVX]+$/i.test(w) ? w.toUpperCase()
        : (w.charAt(0).toUpperCase() + w.slice(1))
    ).join(" ") || code || "Course";
  }

  // Longer titles: keep first few meaningful words (up to ~40 chars), whole words only
  let suggestion = "";
  for (const w of words) {
    const piece = /^[IVX]+$/i.test(w) ? w.toUpperCase()
      : (w.charAt(0).toUpperCase() + w.slice(1));
    const next = suggestion ? suggestion + " " + piece : piece;
    if (next.length > 40) break;
    suggestion = next;
  }
  return suggestion || code || "Course";
}

/** Fill missing planner fields from MaFy-style records; keep all original keys */
function normalizeImportedCourse(raw) {
  const data = Object.assign({}, raw);

  // Credits first (needed for project period span)
  if (typeof data.Credits === "string") data.Credits = parseFloat(data.Credits) || 5;
  if (data.Credits == null) data.Credits = 5;

  // Project courses: flexible periods with "*" + recommended span ending in period 4
  if (isProjectCourse(data)) {
    if (periodsStartWithStar(data.Periods)) {
      // already formatted — keep periods; do not recompute Year if present
      data.Periods = parsePeriodsField(data.Periods);
      if (data.Year === undefined || data.Year === null || data.Year === "") {
        const depth = String(data.Depth || "").toUpperCase();
        if (DEGREE_PROJECT_DEPTHS.has(depth)) {
          const season = parseSeasonFromData(data, numericPeriods(data.Periods));
          data.Year = computeYearFromDepth(data.Depth, season);
        } else {
          data.Year = 3;
        }
      } else {
        data.Year = Number(data.Year);
      }
    } else {
      data.Periods = formatProjectPeriods(data.Credits);
      const depth = String(data.Depth || "").toUpperCase();
      if (DEGREE_PROJECT_DEPTHS.has(depth)) {
        const season = parseSeasonFromData(data, numericPeriods(data.Periods));
        data.Year = computeYearFromDepth(data.Depth, season);
      } else {
        data.Year = 3;
      }
    }
  } else {
    data.Periods = parsePeriodsField(data.Periods);
    if (data.Year === undefined || data.Year === null || data.Year === "") {
      const season = parseSeasonFromData(data, numericPeriods(data.Periods));
      data.Year = computeYearFromDepth(data.Depth, season);
    } else {
      data.Year = Number(data.Year);
    }
  }

  // Tracks = official pathways only; Tags = non-track grouping. No intersection.
  {
    const TRACK_SET = new Set(TRACK_TAG_KEYS);
    let tracks = Array.isArray(data.Tracks) ? data.Tracks.slice() : [];
    let tags = Array.isArray(data.Tags) ? data.Tags.slice() : [];
    // Migrate any track codes that still sit in Tags → Tracks
    tags.forEach(t => {
      if (TRACK_SET.has(t) && !tracks.includes(t)) tracks.push(t);
    });
    tracks = tracks.filter(t => TRACK_SET.has(t));
    tags = tags.filter(t => !TRACK_SET.has(t));
    // Special categories own Tags exclusively
    const special = classifySpecialTag(data);
    if (special) tags = [special];
    data.Tracks = tracks;
    data.Tags = tags;
  }

  // Description is retired — drop on load; use About only (empty string if absent)
  delete data.Description;
  if (data.About == null) data.About = "";

  // Decode syllabus macros/entities on all known text fields + any other strings
  TEXT_FIELDS_TO_DECODE.forEach(k => {
    if (typeof data[k] === "string") data[k] = decodeSyllabusText(data[k]);
  });
  Object.keys(data).forEach(k => {
    if (typeof data[k] === "string" && !TEXT_FIELDS_TO_DECODE.includes(k)) {
      // skip URLs / codes
      if (/Link$/i.test(k) || k === "Code" || k === "ID") return;
      data[k] = decodeSyllabusText(data[k]);
    }
  });

  if (!data.ShortName || data.ShortName === "Default") {
    data.ShortName = suggestShortName(data.Name, data.Code);
  }

  if (!Array.isArray(data.RelativeVal)) data.RelativeVal = [0, 0, 0];
  // [0,0,0] means undefined → derive from track (theoretical → experimental)
  if (
    data.RelativeVal.length < 3 ||
    (Number(data.RelativeVal[0]) === 0 &&
      Number(data.RelativeVal[1]) === 0 &&
      Number(data.RelativeVal[2]) === 0)
  ) {
    data.RelativeVal = computeRelativeVal(data);
  }
  if (data.CanMove === undefined) data.CanMove = true;
  if (data.CanJumpOver === undefined) data.CanJumpOver = false;
  if (!data.Status) data.Status = "Default";
  if (!data.Visibility) data.Visibility = "Automatic";
  if (typeof data.Credits === "string") data.Credits = parseFloat(data.Credits) || 5;
  if (data.Credits == null) data.Credits = 5;
  if (!Array.isArray(data.Prerequisites)) data.Prerequisites = [];

  return data;
}

/**
 * Special non-track categories derived from name / code.
 * Returns "Prog" | "TO" | "Proj" | null
 */
function classifySpecialTag(data) {
  const name = String(data.Name || "");
  const code = String(data.Code || "");
  if (
    PROJECT_COURSE_CODES.has(code) ||
    (/project/i.test(name) && !/space\s*mission\s*design/i.test(name))
  ) {
    return "Proj";
  }
  if (
    /deep\s*learning/i.test(name) ||
    /\bpython\b/i.test(name) ||
    /\bmathematica\b/i.test(name) ||
    /numerical\s*methods?/i.test(name) ||
    PROGR_COURSE_CODES.has(code)
  ) {
    return "Prog";
  }
  if (
    /astrophysical\s*tests/i.test(name) ||
    /physics\s*nobel\s*prizes?/i.test(name) ||
    /fails?\s*in\s*physics/i.test(name) ||
    /finance/i.test(name) ||
    /\bteaching\b/i.test(name) ||
    (/\blearning\b/i.test(name) && !/deep\s*learning/i.test(name))
  ) {
    return "TO";
  }
  return null;
}

/**
 * Track progression (theoretical → experimental):
 *   MP → TP → NP → SE → AS → MC → GP
 * RelativeVal = [x, 0, 0]; small x = more theoretical, large x = more experimental (≤100).
 * Special Prog/TO/Proj → [100, 1, 0]
 * No track → [100, 0, 1]
 */
function isIntroductoryCourse(data) {
  const name = String(data.Name || "");
  return (
    /\bintroductory\b/i.test(name) ||
    /\bintroduction\s+to\b/i.test(name) ||
    /^intro\b/i.test(name)
  );
}

function computeRelativeVal(data) {
  // Introductory courses pack leftmost
  if (isIntroductoryCourse(data)) {
    return [2, 0, 0];
  }
  // Prefer union for ordering; Tracks and Tags are already normalised disjoint
  const tags = [
    ...(Array.isArray(data.Tracks) ? data.Tracks : []),
    ...(Array.isArray(data.Tags) ? data.Tags : [])
  ];
  if (tags.some(t => SPECIAL_TAG_KEYS.includes(t))) {
    return [1, 0, 0];
  }
  const TRACK_X = {
    MP: 8,
    TP: 22,
    NP: 36,
    SE: 50,
    AS: 64,
    MC: 78,
    GP: 92
  };
  const xs = tags.map(t => TRACK_X[t]).filter(v => v != null);
  if (xs.length === 0) {
    return [100, 0, 1]; // no track — extreme right when sorted ascending
  }
  const x = Math.min(100, Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));
  return [x, 0, 0];
}

/** Sort key for layout: smaller = further left. No-track [100,0,1] is rightmost. */
function relativeOrderKey(course) {
  const rv = course.RelativeVal || [0, 0, 0];
  return (Number(rv[0]) || 0) * 1000 + (Number(rv[1]) || 0) * 10 + (Number(rv[2]) || 0);
}

/** rWidth / rHeight: "Automatic" or a positive pixel number */
function normalizeRenderDim(v) {
  if (v == null || v === "" || v === "Automatic" || v === "automatic" || v === "default" || v === "Default") {
    return "Automatic";
  }
  const n = Number(v);
  if (!isNaN(n) && n > 0) return n;
  return "Automatic";
}

/* ============================================================
   COURSE CLASS
   ============================================================ */
class Course {
  constructor(raw) {
    const data = normalizeImportedCourse(raw || {});

    this.Name        = data.Name        || "Unnamed";
    this.ShortName   = data.ShortName   || "Default";
    this.Code        = data.Code;
    this.RelativeVal = data.RelativeVal || [0,0,0];
    this.GridPosition= data.GridPosition|| null;   // {col, row} – top-left
    this.CanMove     = data.CanMove !== undefined ? data.CanMove : true;
    this.CanJumpOver = data.CanJumpOver || false;
    this.Status      = data.Status      || "Default";
    this.Credits     = data.Credits     || 5;
    this.Periods     = parsePeriodsField(data.Periods != null ? data.Periods : [1]);
    // Index into expandPeriodAlternatives(...).alternatives for flexible / multi-option courses
    this.activePeriodAlt = Number.isInteger(data.activePeriodAlt) ? data.activePeriodAlt : 0;
    this.Year        = (data.Year !== undefined && data.Year !== null) ? Number(data.Year) : 0;
    this.Tags        = Array.isArray(data.Tags) ? data.Tags : [];
    this.Tracks      = Array.isArray(data.Tracks) ? data.Tracks : [];
    this.Prerequisites = data.Prerequisites || [];
    // Description intentionally not stored — use About
    // per-box style overrides
    this.BoxColor    = data.BoxColor    || null;   // null = default by year
    // LabelMode: "Automatic" | "Name" | "Both"  (legacy ShowCode → Both/Automatic)
    if (data.LabelMode === "Name" || data.LabelMode === "Both" || data.LabelMode === "Automatic") {
      this.LabelMode = data.LabelMode;
    } else if (data.ShowCode === true) {
      this.LabelMode = "Both";
    } else {
      this.LabelMode = "Automatic";
    }
    // Visibility: "Hidden" | "Automatic" | "Visible"
    this.Visibility  = data.Visibility  || "Automatic";

    // Normalize main fields to string[]; drop legacy Level (duplicates Depth)
    {
      const mfList = getMainFieldsList(data);
      if (mfList.length) this["Main Field(s)"] = mfList;
      else delete this["Main Field(s)"];
    }
    delete this.level;
    delete this.levelFormal;
    delete this.Level;
    delete this["Main Field(s) of Studies"];
    delete this["Main Fields"];

    // Render size overrides (pixels). "Automatic" → derived from cWidth/cHeight × cell size.
    // Name "Automatic" matches Visibility / LabelMode convention.
    this.rWidth  = normalizeRenderDim(data.rWidth);
    this.rHeight = normalizeRenderDim(data.rHeight);

    // Preserve any extra fields from the source JSON (forward-compatible)
    // Never keep Description
    const known = new Set([
      "Name","ShortName","Code","RelativeVal","GridPosition","CanMove","CanJumpOver",
      "Status","Credits","Periods","Year","Tags","Tracks","Prerequisites","Description",
      "BoxColor","ShowCode","LabelMode","Visibility","cWidth","cHeight","rWidth","rHeight","activePeriodAlt"
    ]);
    Object.keys(data || {}).forEach(k => {
      if (k === "Description") return;
      if (!known.has(k) && typeof data[k] !== "function") {
        this[k] = data[k];
      }
    });
    // Ensure About exists
    if (this.About == null) this.About = data.About != null ? data.About : "";

    // YearParity: Any | Odd | Even (calendar-year restriction)
    const yp = data.YearParity || data.yearParity || "Any";
    this.YearParity = (yp === "Odd" || yp === "Even") ? yp : "Any";

    this.computeDims();
  }

  /** Integer matrix span from active period alternative + credits */
  computeDims() {
    const nums = numericPeriods(this.Periods, this.activePeriodAlt);
    this.cHeight = Math.max(1, nums.length || 1);
    this.cWidth  = Math.floor(0.5 + this.Credits / (this.cHeight * 5));
    if (this.cWidth < 1) this.cWidth = 1;
  }

  /** Hit-box width in column units (= visible rectangle, not matrix cWidth) */
  get hitW() {
    return Math.max(0.25, this.renderWidth / FIVE_WIDTH);
  }
  /** Hit-box height in row units (= visible rectangle) */
  get hitH() {
    return Math.max(0.25, this.renderHeight / PERIOD_HEIGHT);
  }

  /** Pixel width used when drawing the box.
   *  Automatic: Credits / (number of periods) * (FIVE_WIDTH / 5)  (may be fractional).
   *  FIVE_WIDTH is one matrix column ≈ 5 credits, so divide by 5 for per-credit width.
   */
  get renderWidth() {
    let w;
    if (typeof this.rWidth === "number" && this.rWidth > 0) {
      w = this.rWidth;
    } else {
      const nPer = Math.max(1, numericPeriods(this.Periods, this.activePeriodAlt).length || this.cHeight || 1);
      const credits = Number(this.Credits) || 5;
      w = (credits / nPer) * (FIVE_WIDTH / 5);
    }
    // Never narrower than half a matrix column
    return Math.max(w, FIVE_WIDTH / 2);
  }

  /** Pixel height used when drawing the box */
  get renderHeight() {
    if (typeof this.rHeight === "number" && this.rHeight > 0) return this.rHeight;
    return this.cHeight * PERIOD_HEIGHT;
  }

  /** Full serialisable snapshot of this course (all data fields) */
  toJSON() {
    // Description is never saved; cWidth/cHeight derived; Level duplicates Depth; old MainField keys dropped
    const skip = new Set([
      "cWidth", "cHeight", "Description",
      "level", "Level", "levelFormal", "LevelFormal",
      "MainField", "Main Fields", "MainField(s)", "Main Field(s) of Studies"
    ]);
    const out = {};
    for (const key of Object.keys(this)) {
      if (skip.has(key)) continue;
      if (typeof this[key] === "function") continue;
      if (key === "GridPosition" && this.GridPosition) {
        out.GridPosition = { col: this.GridPosition.col, row: this.GridPosition.row };
      } else if (key === "Main Field(s)") {
        const list = getMainFieldsList(this);
        if (list.length) out["Main Field(s)"] = list;
      } else {
        out[key] = this[key];
      }
    }
    return out;
  }

  get displayName() {
    return (this.ShortName && this.ShortName !== "Default")
      ? this.ShortName
      : this.Name;
  }

  get primaryPeriod() {
    const nums = numericPeriods(this.Periods, this.activePeriodAlt);
    return nums[0] || 1;
  }

  get periodAlternatives() {
    return expandPeriodAlternatives(this.Periods, this.activePeriodAlt);
  }

  get isPeriodFlexible() {
    const exp = this.periodAlternatives;
    return exp.flexible || exp.alternatives.length > 1;
  }

  /** Pick alternative whose start period equals `period` (1–4). */
  selectPeriodAlternativeByStart(period) {
    const exp = expandPeriodAlternatives(this.Periods, this.activePeriodAlt);
    const idx = exp.alternatives.findIndex(a => a[0] === period);
    if (idx < 0) return false;
    if (idx === this.activePeriodAlt) return false;
    this.activePeriodAlt = idx;
    this.computeDims();
    return true;
  }

  // visual style — track-based default; BoxColor override wins
  get style() {
    const bg = this.BoxColor || defaultColorForCourse(this);
    return {
      background: bg,
      color: "#fff",
      border: this.CanMove ? "2px solid #5a9" : "2px solid #a55",
      borderRadius: "6px"
    };
  }
}

/**
 * Named colour scheme — mutable via right-click on track tags.
 * Course.BoxColor (user override) always wins over these defaults.
 */
const DEFAULT_COLOR_SCHEME = {
  MP: "#2f3d6b",          // mathematical — blue-indigo
  TP: "#1e6b3a",          // theoretical physics — green
  NP: "#8a5a1a",          // nuclear — orange (near SE)
  SE: "#6b4a1a",          // solar energy — amber
  AS: "#1a3558",          // astronomy — deep blue
  MC: "#1e4a5a",          // meteorology — cyan-steel
  GP: "#4a3a1e",          // geoscience — earth brown
  Project: "#6b2a8a",     // project courses — purple
  Programming: "#0e7480", // computational / methods — cyan
  Pedagogy: "#8a2a5a",    // outreach / teaching / special topics — rose
  Intro: "#4a5568",       // introductory courses — slate
  Default: "#333844"      // no tags / unknown
};

let colorScheme = Object.assign({}, DEFAULT_COLOR_SCHEME);

function applyTrackTagStyles() {
  TRACK_TAG_KEYS.forEach(t => {
    const el = document.querySelector(`#P_Header label.track-${t}`);
    if (el) el.style.background = colorScheme[t] || DEFAULT_COLOR_SCHEME[t];
  });
  // Special tags share category colours
  const specialMap = {
    Prog: colorScheme.Programming || DEFAULT_COLOR_SCHEME.Programming,
    TO: colorScheme.Pedagogy || DEFAULT_COLOR_SCHEME.Pedagogy,
    Proj: colorScheme.Project || DEFAULT_COLOR_SCHEME.Project
  };
  SPECIAL_TAG_KEYS.forEach(t => {
    const el = document.querySelector(`#P_Header label.track-${t}`);
    if (el) el.style.background = specialMap[t];
  });
}

function setSchemeColor(key, hex) {
  if (!key || !hex) return;
  colorScheme[key] = hex;
  try { localStorage.setItem("colorScheme", JSON.stringify(colorScheme)); } catch (_) {}
  applyTrackTagStyles();
  renderCourses();
}

function loadColorSchemeFromStorage() {
  try {
    const raw = localStorage.getItem("colorScheme");
    if (raw) {
      const saved = JSON.parse(raw);
      Object.keys(DEFAULT_COLOR_SCHEME).forEach(k => {
        if (typeof saved[k] === "string" && /^#/.test(saved[k])) colorScheme[k] = saved[k];
      });
    }
  } catch (_) {}
}

/**
 * Resolve which track colour a dual-tagged (esp. MP+TP) course should use,
 * based on course name heuristics.
 */
function resolveTrackKey(course) {
  const name = String(course.Name || "");
  const tags = effectiveTagKeys(course);
  const has = t => tags.includes(t);

  // Explicit topic overrides (even if tags differ)
  if (/gravitation/i.test(name)) return "TP";
  if (/cosmology/i.test(name)) return "AS";
  if (/dynamical\s*systems/i.test(name) || /\bchaos\b/i.test(name)) return "MP";

  // Strong physics-theory signals → TP
  if (
    /quantum\s*field|conformal\s*field|string\s*theory|gauge\s*theory|supersymmetr|mechanic|classical|renormaliz|\bqft\b|\bcft\b|particle\s*physics|standard\s*model|higgs|black\s*hole|general\s*relativity|quantum\s*gravity|yang[\s-]?mills/i.test(name)
  ) {
    return "TP";
  }

  // Strong mathematical signals → MP
  if (
    /\bmmp\b|mathematical\s*methods|lie\s*groups?|differential\s*geometry|algebraic|topology|functional\s*analysis|manifold|representation\s*theory|complex\s*analysis|harmonic\s*analysis/i.test(name)
  ) {
    return "MP";
  }

  // Single-track cases
  if (has("MP") && !has("TP")) return "MP";
  if (has("TP") && !has("MP")) return "TP";

  // Both MP and TP: lean physics if the name looks physical, else math
  if (has("MP") && has("TP")) {
    if (/physics|quantum|field\s*theory|particle|relativity|mechanics|gravity|string|gauge|spin|boson|fermion|lagrangian|hamiltonian/i.test(name)) {
      return "TP";
    }
    return "MP";
  }

  // Remaining tracks in theoretical → experimental order
  for (const t of TRACK_TAG_KEYS) {
    if (has(t)) return t;
  }
  return null;
}

/**
 * Default box colour from name specials, then resolved track.
 * Name category rules take precedence over track colour.
 * Returns a colourScheme variable value (not a hardcoded absolute, except via the scheme).
 */
function defaultColorForCourse(course) {
  const tags = effectiveTagKeys(course);
  // Special category tags map to named scheme colours
  if (tags.includes("Proj")) return colorScheme.Project;
  if (tags.includes("Prog")) return colorScheme.Programming;
  if (tags.includes("TO")) return colorScheme.Pedagogy;

  const name = String(course.Name || "");

  // Fallback name heuristics (in case Tags not yet specialised)
  if (
    PROJECT_COURSE_CODES.has(String(course.Code || "")) ||
    (/project/i.test(name) && !/space\s*mission\s*design/i.test(name))
  ) {
    return colorScheme.Project;
  }
  if (
    /deep\s*learning/i.test(name) ||
    /\bpython\b/i.test(name) ||
    /\bmathematica\b/i.test(name) ||
    /numerical\s*methods?/i.test(name)
  ) {
    return colorScheme.Programming;
  }
  if (
    /astrophysical\s*tests\s*of\s*physics\s*theor/i.test(name) ||
    /physics\s*nobel\s*prizes?/i.test(name) ||
    /fails?\s*in\s*physics/i.test(name) ||
    /finance/i.test(name) ||
    /\bteaching\b/i.test(name) ||
    (/\blearning\b/i.test(name) && !/deep\s*learning/i.test(name))
  ) {
    return colorScheme.Pedagogy;
  }

  // Introductory courses
  if (
    /\bintroductory\b/i.test(name) ||
    /\bintroduction\s+to\b/i.test(name) ||
    /^intro\b/i.test(name)
  ) {
    return colorScheme.Intro;
  }

  const trackKey = resolveTrackKey(course);
  if (trackKey && colorScheme[trackKey]) return colorScheme[trackKey];
  return colorScheme.Default;
}

/** Palette offered in course + track colour pickers */
const BOX_COLOURS = [
  "#2f3d6b", "#1e6b3a", "#8a5a1a", "#6b4a1a", "#1a3558",
  "#1e4a5a", "#4a3a1e", "#6b2a8a", "#0e7480", "#8a2a5a",
  "#4a5568", "#1e3a5f", "#5a1e1e", "#333333", "#555555",
  "#2d4a2d", "#4a2d4a", "#1e4a4a"
];

/** Track currently being recoloured via the track context menu */
let trackColorTarget = null;

/* ============================================================
   DATA LOADING
   - Tries data/MasterProgramme.json (then courses.json) when a server is available
   - If that fails (e.g. file://), shows a friendly message
     and waits for the user to use the Upload button
   ============================================================ */
let originalData = [];   // keeps the pristine course array from last load
/** Full planner state snapshot after the most recent Upload / successful load (for Reset). */
let lastUploadSnapshot = null;

function showUploadPrompt() {
  const canvas = document.getElementById("bulk-canvas");
  // make canvas tall enough so the message is visible
  canvas.style.width  = "100%";
  canvas.style.height = "auto";
  canvas.innerHTML = `
    <div style="color:#ccc;padding:48px 40px;font-size:16px;max-width:720px;line-height:1.6">
      <strong style="font-size:18px;color:#9cf">No courses loaded yet</strong><br><br>
      Click the green <strong style="color:#8d8">Upload</strong> button, select any
      <code>*.catalog.json</code> file first (for example
      <code>MaFyCourses.catalog.json</code>) — this loads the course data.
      Then click <strong style="color:#8d8">Upload</strong> again and choose a layout
      JSON file of your choice (for example <code>MasterProgramme.json</code> or a track file).<br><br>
      The default place for these files is the <code>data</code> subfolder of the website folder.<br><br>
      It is preferable to <em>serve</em> the website folder so the necessary files load automatically.
      If you have Python installed, open a terminal, change into the website folder, and run:<br><br>
      <code style="display:block;background:#1a1a28;padding:10px 12px;border-radius:6px;color:#cde;font-size:14px;white-space:pre-wrap">cd path/to/study-planner
python3 -m http.server</code><br>
      Then open <code>http://localhost:8000</code> in your browser
      (on Windows you can use <code>py -m http.server</code> if <code>python3</code> is not available;
      on macOS and Linux, <code>python3 -m http.server</code> is usual).
    </div>`;
}


async function tryAutoLoad() {
  const candidates = [
    "data/MasterProgramme.json",
    "MasterProgramme.json",
    "courses.json"
  ];
  for (const path of candidates) {
    try {
      const resp = await fetch(path);
      if (!resp.ok) continue;
      console.info("Auto-loaded", path);
      const raw = await resp.json();
      return await resolveCoursePayload(raw);
    } catch (err) {
      console.info("Auto-load skip", path, err.message);
    }
  }
  return null;
}

/* ============================================================
   INITIALISATION
   ============================================================ */
function syncHeaderHeight() {
  const h = document.getElementById("P_Header").offsetHeight;
  document.documentElement.style.setProperty("--header-h", h + "px");
}

async function init() {
  document.title = "Study Planner, version " + APP_VERSION;
  // always wire up the UI first so Upload works even with no data
  syncHeaderHeight();
  window.addEventListener("resize", syncHeaderHeight);

  buildCanvas();
  loadColorSchemeFromStorage();
  applyTrackTagStyles();
  loadDescFieldPrefs();
  setupEventListeners();
  setupPanelResizers();
  updateOverlaysVisibility();

  const data = await tryAutoLoad();
  if (data) {
    applyLoadedData(data);
    try {
      lastUploadSnapshot = JSON.parse(JSON.stringify(buildSavePayload()));
      undoStack = [JSON.stringify(lastUploadSnapshot)];
      redoStack = [];
      updateUndoRedoButtons();
    } catch (_) {}
    scrollToCoursesCenter();
  } else {
    showUploadPrompt();
  }
}

/* ============================================================
   SPATIAL OCCUPANCY (visible courses only — GridMatrix retired)
   Positions are in column / period-row units; col may be fractional.
   Only courses for which isVisibleOnGrid(c) is true participate.
   ============================================================ */

function resetMatrix() {
  // no dense matrix; positions live on Course.GridPosition
}

/** Snap a column value to the current magnetisation grid */
function snapCol(col) {
  const m = magnetStep || 1;
  return Math.round(col / m) * m;
}

function courseRect(c) {
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

function proposedRect(course, col, row) {
  return { col, row, w: course.hitW, h: course.hitH };
}

/** All currently visible courses that have a position */
function visiblePlacedCourses(excludeCode) {
  return courses.filter(c => {
    if (!isVisibleOnGrid(c)) return false;
    if (!c.GridPosition) return false;
    if (excludeCode && c.Code === excludeCode) return false;
    return true;
  });
}

function rectsOverlap(a, b) {
  return a.col < b.col + b.w && a.col + a.w > b.col &&
         a.row < b.row + b.h && a.row + a.h > b.row;
}

/**
 * Can `course` occupy (col,row) without overlapping any other *visible* course?
 * excludeCodes: set of codes ignored (the course itself, or temporarily lifted).
 */
function canPlace(course, col, row, excludeCodes) {
  if (col < 0 || row < 0) return false;
  if (col + course.hitW > MATRIX_COLS + 1e-9) return false;
  if (row + course.hitH > MATRIX_ROWS + 1e-9) return false;
  // Parity is advisory only (red frame when "Parity Issues" is checked)
  const self = proposedRect(course, col, row);
  const skip = excludeCodes || new Set([course.Code]);
  for (const other of visiblePlacedCourses()) {
    if (skip.has(other.Code)) continue;
    const r = courseRect(other);
    if (r && rectsOverlap(self, r)) return false;
  }
  return true;
}

/** Set GridPosition; no matrix write */
function occupy(course, col, row) {
  course.GridPosition = { col: snapCol(col), row: Math.round(row) };
}

function clearCourseFromMatrix(course) {
  // Keep GridPosition for restore; visibility gating is what matters for collisions.
  // Callers that truly remove use course.GridPosition = null.
}

/**
 * Collect overlapping visible courses at proposed placement.
 * Returns null if any non-movable blocker is present.
 */
/**
 * Courses whose visible rect overlaps the proposed placement of `course`.
 * Returns null if any overlapping course is non-movable (placement forbidden).
 * Otherwise returns the set of movable courses that must be pushed.
 */
function blockersAt(course, col, row, excludeCodes) {
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

function placeFixedCourses() {
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

function naturalRow(course) {
  // Year -2 → block 0 … Year 3 → block 5
  const yearBase = (Number(course.Year) + 2) * 4;
  const periodOffset = ((course.primaryPeriod || 1) - 1) % 4;
  return Math.max(0, Math.min(MATRIX_ROWS - 1, yearBase + periodOffset));
}

/**
 * Allowed rows for a course given its period alternatives and year block preference.
 * Year may change; period band follows chosen alternative.
 */
function allowedRowsForCourse(course, preferredBlock) {
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

function autoLayoutMovable() {
  if (layoutMode === "absolute") {
    layoutAbsolute();
    return;
  }
  if (layoutMode === "relative") {
    layoutRelative();
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

/** col := RelativeVal[0]; row := saved or natural; light right-push on overlap */
function layoutAbsolute() {
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

/** Keep order by current/RelativeVal col; remove empty column gaps */
/**
 * Relative = Absolute layout, then delete entire empty integer columns
 * (a column is empty if no visible course covers that integer col in any row).
 */
/** Pack current visible positions by deleting empty integer columns (no Absolute). */
function removeGapsOnly() {
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

function layoutRelative() {
  layoutAbsolute();

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

function labelOriginX() {
  return EXTRA_SCROLL_COLS_LEFT * FIVE_WIDTH;
}

/** Pixel X of matrix column 0 (courses start after left pad + label gutter) */
function courseOriginX() {
  return (EXTRA_SCROLL_COLS_LEFT + LABEL_COLS) * FIVE_WIDTH;
}

function buildCanvas() {
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
    // width is primarily CSS flex-basis; keep inline in sync with constants
    gutter.style.flexBasis = (LABEL_COLS * FIVE_WIDTH) + "px";
    gutter.style.width = (LABEL_COLS * FIVE_WIDTH) + "px";
  }

  const ox = courseOriginX();
  // Thin/medium: start at matrix col -2, keep relative indent (0.5 / 1.0 col), stretch right
  // Thick: full width left→right
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
    // Calendar years at thick boundaries between Yr-2…Yr-2 only (not outside)
    // Boundaries after Year -2,-1,0,1 → rows 4,8,12,16 → Fall of next academic year
    const calBoundaries = [
      { row: 4,  nextYear: -1 },  // between -2 and -1 → Fall of Year -1
      { row: 8,  nextYear: 0 },
      { row: 12, nextYear: 1 },
      { row: 16, nextYear: 2 }
    ];
    calBoundaries.forEach(({ row, nextYear }) => {
      const cal = masterStartYear + (nextYear - 1); // Fall calendar of nextYear
      const lbl = document.createElement("div");
      lbl.className = "grid-label year";
      lbl.textContent = String(cal);
      lbl.style.left = "4px";
      lbl.style.top = (row * PERIOD_HEIGHT - 11) + "px";
      lbl.style.fontSize = "12px"; /* +30% vs old 9px */
      lbl.style.color = "#fc6";
      gutterInner.appendChild(lbl);
    });
  }
  syncGutterScroll();
}

/**
 * Keep gutter labels/lines glued to canvas grid lines.
 * Gutter is OUTSIDE #P_Bulk, so it does not scroll by itself —
 * we apply a single translateY(-scrollTop). (Previously the gutter
 * lived inside the scrollport *and* got this transform → 2× speed.)
 */
function syncGutterScroll() {
  const bulk = document.getElementById("P_Bulk");
  const inner = document.getElementById("bulk-gutter-inner");
  if (!bulk || !inner) return;
  // Direct style assignment (no rAF) so gutter tracks P_Bulk in the same frame
  const y = -bulk.scrollTop;
  inner.style.transform = "translate3d(0," + y + "px,0)";
  inner.style.top = "0px"; // ensure no second offset
}

/** Scroll so the centre-of-mass of visible courses is centred in the viewport */
function scrollToCoursesCenter() {
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

function scrollToYear1() {
  const bulk = document.getElementById("P_Bulk");
  // Year index 1 → block = 1+2 = 3 → row 12
  const row = (1 + 2) * 4;   // 12
  bulk.scrollTop = row * PERIOD_HEIGHT;
  // Start scrolled so the label gutter is near the left of the viewport
  // (left pad remains available to scroll under an open side panel)
  bulk.scrollLeft = EXTRA_SCROLL_COLS_LEFT * FIVE_WIDTH;
}

function renderCourses() {
  const canvas = document.getElementById("bulk-canvas");
  // remove old boxes only (keep lines & labels)
  canvas.querySelectorAll(".course-box").forEach(el => el.remove());

  const ox = courseOriginX();

  courses.forEach(c => {
    if (!isVisibleOnGrid(c)) return;
    if (!c.GridPosition) return;

    const box = document.createElement("div");
    box.className = "course-box";
    box.dataset.code = c.Code;
    let badge = "";
    if (c.isPeriodFlexible) {
      badge = `<span class="box-badge badge-star">*</span>`;
    } else if (c.YearParity === "Odd") {
      badge = `<span class="box-badge badge-parity">odd</span>`;
    } else if (c.YearParity === "Even") {
      badge = `<span class="box-badge badge-parity">even</span>`;
    }
    if (courseShowsCode(c)) {
      box.classList.add("has-code");
      box.innerHTML =
        badge +
        `<span class="box-name">${c.displayName}</span>` +
        `<span class="box-code">${c.Code}</span>`;
    } else {
      box.innerHTML = badge + `<span class="box-name">${c.displayName}</span>`;
    }

    const st = c.style;
    box.style.background = st.background;
    box.style.color = st.color;
    box.style.border = st.border;
    box.style.borderRadius = st.borderRadius;

    // Red frame only when "Parity Issues" is checked
    if (showParityIssues && c.GridPosition && !isParityAllowedAtRow(c, c.GridPosition.row)) {
      box.classList.add("parity-error");
    }

    box.style.width  = c.renderWidth  + "px";
    box.style.height = c.renderHeight + "px";
    // shift right by LABEL_COLS so col 0 starts at visual col-5
    box.style.left   = (ox + c.GridPosition.col * FIVE_WIDTH) + "px";
    box.style.top    = (c.GridPosition.row * PERIOD_HEIGHT) + "px";
    // Max name lines: 2 for single-period, up to 4 when the box spans ≥2 periods
    box.dataset.maxNameLines = String(c.cHeight >= 2 ? 4 : 2);

    if (selectedCodes.has(c.Code)) box.classList.add("selected");
    if (!c.CanMove) box.classList.add("locked");

    box.addEventListener("mousedown", e => onBoxMouseDown(e, c));
    box.addEventListener("click", e => onBoxClick(e, c));
    box.addEventListener("contextmenu", e => onBoxContext(e, c));

    canvas.appendChild(box);
    fitBoxName(box);
  });
}

/**
 * Scale .box-name font so the full name fits in at most maxLines (whole words).
 * Also shrink .box-code when the box is narrower than one matrix column.
 * maxLines = 2 (1 period) or 4 (≥2 periods).
 */
function fitBoxName(box) {
  const nameEl = box.querySelector(".box-name");
  const codeEl = box.querySelector(".box-code");
  if (!nameEl && !codeEl) return;

  const maxLines = parseInt(box.dataset.maxNameLines || "2", 10) || 2;
  if (nameEl) nameEl.style.webkitLineClamp = String(maxLines);

  const cs = getComputedStyle(box);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const availW = Math.max(8, box.clientWidth - padX);

  // Course code: for rWidth < FIVE_WIDTH use condensed mono and scale font down
  if (codeEl) {
    const narrow = box.clientWidth < FIVE_WIDTH;
    box.classList.toggle("narrow-code", narrow);
    codeEl.style.whiteSpace = "nowrap";
    codeEl.style.overflow = "hidden";
    codeEl.style.maxWidth = availW + "px";
    codeEl.style.textOverflow = "clip";

    // Start smaller already when narrow; floor lower so 1FA002 can fit half-column
    let codeFont = narrow ? 8.5 : 10;
    const minCodeFont = narrow ? 5 : 6.5;
    codeEl.style.fontSize = codeFont + "px";
    codeEl.style.letterSpacing = narrow ? "-0.04em" : "0";

    // Binary-ish shrink until code fits width
    while (codeFont > minCodeFont && codeEl.scrollWidth > availW + 1) {
      codeFont -= 0.25;
      codeEl.style.fontSize = codeFont + "px";
      if (narrow && codeFont < 7) {
        codeEl.style.letterSpacing = "-0.06em";
      }
    }
    // Last resort: slightly transform scaleX if still overflowing
    if (codeEl.scrollWidth > availW + 1) {
      const scale = Math.max(0.72, availW / codeEl.scrollWidth);
      codeEl.style.transform = `scaleX(${scale})`;
      codeEl.style.transformOrigin = "center center";
    } else {
      codeEl.style.transform = "";
    }
  }

  if (!nameEl) return;

  const codeH = codeEl ? (codeEl.offsetHeight + 2) : 0;
  const availH = Math.max(8, box.clientHeight - padY - codeH);

  nameEl.style.width = availW + "px";
  nameEl.style.maxWidth = availW + "px";

  // Base sizes at 100% zoom; scaled by nameFontZoomFactor() (clamped 75–125%)
  const zf = nameFontZoomFactor();
  const maxFont = 13 * zf;
  const minFont = 7 * zf;
  let best = minFont;

  for (let fs = maxFont; fs >= minFont - 1e-6; fs -= 0.5 * zf) {
    nameEl.style.fontSize = fs + "px";
    const lineH = fs * 1.15;
    const maxNameH = Math.min(availH, lineH * maxLines + 0.75);
    const sh = nameEl.scrollHeight;
    const sw = nameEl.scrollWidth;
    if (sh <= maxNameH + 1 && sw <= availW + 2) {
      best = fs;
      break;
    }
  }
  nameEl.style.fontSize = best + "px";
}

/** Global default for courses with LabelMode === "Automatic" */
let globalShowCode = false;

/** Whether this course box should show name + code */
function courseShowsCode(course) {
  if (course.LabelMode === "Both") return true;
  if (course.LabelMode === "Name") return false;
  // Automatic → follow global checkbox
  return globalShowCode;
}

/**
 * Union of Tracks + Tags for filtering, colouring, hidden-panel membership, etc.
 * Tracks and Tags are disjoint; this recreates the old "all keys" behaviour.
 */
function effectiveTagKeys(course) {
  const out = [];
  const seen = new Set();
  (course.Tracks || []).forEach(t => {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  });
  (course.Tags || []).forEach(t => {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  });
  return out;
}

/** True when the course should appear on the main grid */
function isVisibleOnGrid(course) {
  if (course.Visibility === "Hidden") return false;
  if (course.Visibility === "Visible") return true;
  // Automatic → depends on active track/tag checkboxes.
  // Standalone courses with empty Tracks and empty Tags: not shown until
  // Visibility is set to Visible (or Hidden-by-user path in the hidden panel).
  const keys = effectiveTagKeys(course);
  if (keys.length === 0) return false;
  return keys.some(t => activeTags.has(t));
}

/** True when the course belongs in the Hidden panel */
function isHiddenCourse(course) {
  return !isVisibleOnGrid(course);
}

function shouldShow(course) {
  return isVisibleOnGrid(course);
}

/* ============================================================
   DRAG & DROP
   ============================================================ */
function onBoxMouseDown(e, course) {
  if (e.button !== 0) return; // left button only

  // Locked courses: no drag, description is shown via the normal click handler
  if (!course.CanMove) return;

  e.preventDefault();
  e.stopPropagation();

  const box = e.currentTarget;
  const rect = box.getBoundingClientRect();
  const bulk = document.getElementById("P_Bulk");

  dragState = {
    course,
    box,
    origCol: course.GridPosition.col,
    origRow: course.GridPosition.row,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    startScrollLeft: bulk.scrollLeft,
    startScrollTop: bulk.scrollTop
  };

  box.classList.add("dragging");
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e) {
  if (!dragState) return;
  const { box, offsetX, offsetY, startX, startY } = dragState;

  // Mark as a real drag once the pointer moves more than a few pixels
  if (!dragState.moved) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dx * dx + dy * dy > 16) {   // ~4 px threshold
      dragState.moved = true;
    }
  }

  const canvasRect = document.getElementById("bulk-canvas").getBoundingClientRect();
  const x = e.clientX - canvasRect.left - offsetX;
  const y = e.clientY - canvasRect.top  - offsetY;

  box.style.left = x + "px";
  box.style.top  = y + "px";
}

function onMouseUp(e) {
  if (!dragState) return;
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);

  const { course, box, origCol, origRow, moved } = dragState;
  box.classList.remove("dragging");

  const ox = courseOriginX();

  if (!moved) {
    dragState = null;
    box.style.left = (ox + origCol * FIVE_WIDTH) + "px";
    box.style.top  = (origRow * PERIOD_HEIGHT) + "px";
    showDescription(course);
    return;
  }

  const left = parseFloat(box.style.left);
  const top  = parseFloat(box.style.top);

  let newCol = snapCol((left - ox) / FIVE_WIDTH);
  let newRow = Math.round(top / PERIOD_HEIGHT);

  // Year block from drop; period from alternative rules
  const nBlocks = MATRIX_ROWS / 4;
  let block = Math.max(0, Math.min(nBlocks - 1, Math.floor(newRow / 4)));
  let periodOffset = (course.primaryPeriod - 1) % 4;

  if (course.isPeriodFlexible) {
    // allow switching among alternatives: use dropped period within block
    const droppedPeriod = (newRow % 4) + 1;
    if (course.selectPeriodAlternativeByStart(droppedPeriod)) {
      periodOffset = (course.primaryPeriod - 1) % 4;
    }
  }
  newRow = block * 4 + periodOffset;
  // clamp height for year-wrap alternatives spanning beyond block
  if (newRow + course.cHeight > MATRIX_ROWS) {
    newRow = Math.max(0, MATRIX_ROWS - course.cHeight);
  }

  newCol = Math.max(0, Math.min(MATRIX_COLS - course.hitW, newCol));
  newRow = Math.max(0, Math.min(MATRIX_ROWS - course.hitH, newRow));

  // Temporarily un-place so self does not collide
  const savedPos = course.GridPosition ? { ...course.GridPosition } : null;
  course.GridPosition = null;

  if (canPlace(course, newCol, newRow)) {
    occupy(course, newCol, newRow);
  } else if (!tryPushAndPlace(course, newCol, newRow)) {
    if (savedPos) occupy(course, savedPos.col, savedPos.row);
    else occupy(course, origCol, origRow);
  }

  dragState = null;
  renderCourses();
  pushHistory();
}

/**
 * Place course at (col,row). Any visible movable course whose rectangle
 * overlaps the proposed rect is pushed right (chain reaction).
 * Non-movable in the target rect → fail.
 * During the chain, if the next snap position is blocked by a non-movable,
 * jump over that course (place just to its right) and continue.
 */
function tryPushAndPlace(course, col, row) {
  const saved = new Map();
  courses.forEach(c => {
    if (c.GridPosition) saved.set(c.Code, { col: c.GridPosition.col, row: c.GridPosition.row });
  });

  function restoreAll() {
    saved.forEach((pos, code) => {
      const c = courses.find(x => x.Code === code);
      if (c) c.GridPosition = { col: pos.col, row: pos.row };
    });
  }

  const step = magnetStep || 1;

  /** First column ≥ startCol where `c` does not overlap any non-movable (may overlap movables). */
  function nextFreeOfLocked(c, startCol, atRow) {
    let nc = snapCol(startCol);
    const limit = MATRIX_COLS - c.hitW + 1e-9;
    while (nc <= limit) {
      const self = proposedRect(c, nc, atRow);
      let lockedHit = false;
      for (const other of visiblePlacedCourses()) {
        if (other.Code === c.Code) continue;
        if (other.CanMove) continue;
        const r = courseRect(other);
        if (r && rectsOverlap(self, r)) { lockedHit = true; break; }
      }
      if (!lockedHit) return nc;
      // jump over the rightmost overlapping locked course
      let jumpTo = nc + step;
      for (const other of visiblePlacedCourses()) {
        if (other.CanMove || !other.GridPosition) continue;
        const r = courseRect(other);
        if (!r) continue;
        const self2 = proposedRect(c, nc, atRow);
        if (rectsOverlap(self2, r)) {
          jumpTo = Math.max(jumpTo, snapCol(r.col + r.w));
        }
      }
      nc = snapCol(Math.max(jumpTo, nc + step));
    }
    return null;
  }

  function placeWithPush(c, atCol, atRow, visiting) {
    atCol = snapCol(atCol);
    if (atCol < 0 || atRow < 0) return false;
    if (atCol + c.hitW > MATRIX_COLS + 1e-9) return false;
    if (atRow + c.hitH > MATRIX_ROWS + 1e-9) return false;

    const prev = c.GridPosition;
    c.GridPosition = null; // lift self

    // If non-movable occupies the target, fail for the dragged root; for chain members, caller jumps
    const blockers = blockersAt(c, atCol, atRow);
    if (blockers === null) {
      c.GridPosition = prev;
      return false;
    }

    if (blockers.size === 0) {
      occupy(c, atCol, atRow);
      return true;
    }

    // Push overlapping movables, rightmost first
    const ordered = Array.from(blockers).sort(
      (a, b) => (b.GridPosition?.col || 0) - (a.GridPosition?.col || 0)
    );

    for (const b of ordered) {
      if (visiting.has(b.Code)) {
        c.GridPosition = prev;
        return false;
      }
      visiting.add(b.Code);
      const bRow = b.GridPosition ? b.GridPosition.row : atRow;
      // Push at least past the right edge of the course that is taking the slot
      let startCol = snapCol(atCol + c.hitW);
      if (b.GridPosition) {
        startCol = Math.max(startCol, snapCol(b.GridPosition.col + step));
      }
      // Also clear the full width of `c` if b sat under it
      startCol = Math.max(startCol, snapCol(atCol + step));

      let moved = false;
      let nc = nextFreeOfLocked(b, startCol, bRow);
      while (nc != null) {
        if (placeWithPush(b, nc, bRow, visiting)) {
          moved = true;
          break;
        }
        // try further right (jump one step past failed attempt)
        nc = nextFreeOfLocked(b, snapCol(nc + step), bRow);
      }
      visiting.delete(b.Code);
      if (!moved) {
        c.GridPosition = prev;
        return false;
      }
    }

    // Re-check after pushes
    const blockers2 = blockersAt(c, atCol, atRow);
    if (blockers2 === null || blockers2.size > 0) {
      c.GridPosition = prev;
      return false;
    }
    occupy(c, atCol, atRow);
    return true;
  }

  const ok = placeWithPush(course, col, row, new Set([course.Code]));
  if (!ok) {
    restoreAll();
    return false;
  }
  return true;
}

/* ============================================================
   CLICK / CONTEXT MENU
   ============================================================ */
function onBoxClick(e, course) {
  if (dragState) return; // ignore if we were dragging
  e.stopPropagation();
  showDescription(course);
}


/** Place a fixed menu near (x,y) so it stays fully inside the viewport (flip up / clamp). */
function positionMenuInViewport(menu, x, y) {
  menu.style.display = "block";
  menu.style.left = "0px";
  menu.style.top = "0px";
  // force layout
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 200;
  const pad = 8;
  let left = x;
  let top = y;
  if (left + mw > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - mw - pad);
  if (left < pad) left = pad;
  if (top + mh > window.innerHeight - pad) top = Math.max(pad, y - mh); // flip above cursor
  if (top + mh > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - mh - pad);
  if (top < pad) top = pad;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  // If still taller than viewport, make scrollable
  if (mh > window.innerHeight - 2 * pad) {
    menu.style.maxHeight = (window.innerHeight - 2 * pad) + "px";
    menu.style.overflowY = "auto";
  } else {
    menu.style.maxHeight = "";
    menu.style.overflowY = "";
  }
}

function onBoxContext(e, course) {
  e.preventDefault();
  e.stopPropagation();
  contextTarget = course;
  const menu = document.getElementById("context-menu");
  // Safari: control-click synthesizes mouseup/click that would close the menu
  menu.dataset.openedAt = String(Date.now());

  // rebuild colour swatches so active state matches this course
  const row = document.getElementById("color-swatches");
  row.innerHTML = "";
  const current = course.BoxColor || course.style.background;
  BOX_COLOURS.forEach(col => {
    const btn = document.createElement("button");
    btn.className = "color-swatch" + (col.toLowerCase() === String(current).toLowerCase() ? " active" : "");
    btn.style.background = col;
    btn.dataset.action = "color";
    btn.dataset.color = col;
    btn.title = col;
    row.appendChild(btn);
  });

  // Single checkmarks via class "on" only (CSS ::before) — never set textContent
  const setCheck = (name, on) => {
    const el = menu.querySelector('[data-check="' + name + '"]');
    if (el) {
      el.textContent = ""; // clear any leftover text so only ::before shows
      el.classList.toggle("on", !!on);
    }
  };
  setCheck("select", selectedCodes.has(course.Code));
  setCheck("always-visible", course.Visibility === "Visible");
  setCheck("lock", course.CanMove === false);
  const lm = course.LabelMode || "Automatic";
  setCheck("label-auto", lm === "Automatic" || lm === "Auto");
  setCheck("label-name", lm === "Name");
  setCheck("label-both", lm === "Both");

  // Hide is disabled while the course is Selected
  const hideBtn = menu.querySelector('[data-action="remove"]');
  if (hideBtn) {
    const isSel = selectedCodes.has(course.Code);
    hideBtn.disabled = isSel;
    hideBtn.title = isSel ? "Deselect the course before hiding it" : "";
  }

  positionMenuInViewport(menu, e.clientX, e.clientY);
}

/* ---- Description panel: field registry & visibility ---- */
const DESC_FIELDS = [
  // section 0 — technical (no header)
  { id: "gridPos",     label: "Grid position",   section: 0 },
  { id: "rWidth",      label: "rWidth",           section: 0 },
  { id: "rHeight",     label: "rHeight",          section: 0 },
  { id: "tags",        label: "Tags",             section: 0, defaultOff: true },
  { id: "visibility",  label: "Visibility",       section: 0, defaultOff: true },
  { id: "labelMode",   label: "Label mode",       section: 0, defaultOff: true },
  { id: "canMove",     label: "Can Move",         section: 0, defaultOff: true },
  { id: "status",      label: "Status",           section: 0, defaultOff: true },
  // section 1 — Meta (Name / Short name before Code)
  { id: "name",        label: "Name",             section: 1 },
  { id: "shortName",   label: "Short name",       section: 1, defaultOff: true },
  { id: "code",        label: "Code",             section: 1 },
  { id: "credits",     label: "Credits",          section: 1 },
  { id: "depth",       label: "Depth",            section: 1 },
  { id: "periods",     label: "Periods",          section: 1 },
  { id: "tracks",      label: "Tracks",           section: 1 },
  { id: "mainFields",  label: "Main Field(s)",    section: 1 },
  { id: "department",  label: "Department",       section: 1, defaultOff: true },
  { id: "appliesFrom", label: "Applies from",     section: 1, defaultOff: true },
  // section 2 — Entry requirements
  { id: "entryReq",    label: "Entry requirements", section: 2 },
  // section 3 — Comments (before Details)
  { id: "comments",    label: "Comments",         section: 3 },
  // section 4 — Details
  { id: "about",       label: "About",            section: 4 },
  { id: "outcomes",    label: "Learning Outcomes", section: 4 },
  { id: "content",     label: "Content",          section: 4 },
  { id: "instruction", label: "Instruction",      section: 4 },
  { id: "assessment",  label: "Assessment",       section: 4 },
  { id: "examination", label: "Examination",      section: 4 },
  { id: "grading",     label: "Grading",          section: 4 },
  // section 5 — Links
  { id: "courseLink",  label: "Course page",      section: 5 },
  { id: "syllabus",    label: "Syllabus",         section: 5 },
  { id: "literature",  label: "Literature",       section: 5 }
];

const DESC_SECTION_TITLES = {
  1: "Meta",
  2: "Entry requirements",
  3: "Comments",
  4: "Details",
  5: "Links"
};

let descFieldVisible = {};
let lastDescribedCourse = null;

function loadDescFieldPrefs() {
  descFieldVisible = {};
  DESC_FIELDS.forEach(f => {
    descFieldVisible[f.id] = !f.defaultOff;
  });
  try {
    const raw = localStorage.getItem("descFieldVisible");
    if (raw) {
      const saved = JSON.parse(raw);
      Object.keys(saved).forEach(k => {
        if (k in descFieldVisible) descFieldVisible[k] = !!saved[k];
      });
    }
  } catch (_) {}
}

function saveDescFieldPrefs() {
  try {
    localStorage.setItem("descFieldVisible", JSON.stringify(descFieldVisible));
  } catch (_) {}
}


/**
 * Human-readable periods:
 *  [1,2,3]           → "1-3"
 *  ["*",1,2]         → "Default is 1-2 but can be any"
 *  [[2],[4]]         → "2 or 4"
 *  [[1,2],[2,3]]     → "1-2 or 2-3"
 *  [[4,1]]           → "4-1 (cross-year)"
 */
function formatPeriodsDisplay(raw) {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return null;
  const exp = expandPeriodAlternatives(raw, 0);
  const fmtSpan = (nums) => {
    if (!nums || !nums.length) return "?";
    if (nums.length === 1) return String(nums[0]);
    // consecutive range?
    let consec = true;
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] !== nums[i - 1] + 1) { consec = false; break; }
    }
    if (consec) return nums[0] + "-" + nums[nums.length - 1];
    // year-wrap e.g. 4,1
    if (nums.length === 2 && nums[0] === 4 && nums[1] === 1) return "4-1 (cross-year)";
    return nums.join(",");
  };

  if (exp.flexible) {
    const rec = exp.alternatives[0] || [1];
    return "Default is " + fmtSpan(rec) + " but can be any";
  }
  if (exp.alternatives.length === 1) {
    return fmtSpan(exp.alternatives[0]);
  }
  return exp.alternatives.map(fmtSpan).join(" or ");
}

function getDescFieldValue(course, id) {
  switch (id) {
    case "gridPos": {
      if (!course.GridPosition) return "not placed";
      return `pos (${course.GridPosition.col},${course.GridPosition.row}); size ${course.cWidth} x ${course.cHeight}`;
    }
    case "rWidth": {
      const mode = course.rWidth === "Automatic" || course.rWidth == null ? "Automatic" : course.rWidth;
      return `rWidth: ${mode} → ${Math.round(course.renderWidth)} px`;
    }
    case "rHeight": {
      const mode = course.rHeight === "Automatic" || course.rHeight == null ? "Automatic" : course.rHeight;
      return `rHeight: ${mode} → ${Math.round(course.renderHeight)} px`;
    }
    case "tags":        return (course.Tags && course.Tags.length) ? course.Tags.join(", ") : null;
    // tracks field already handled separately below if present
    case "visibility":  return course.Visibility || null;
    case "labelMode":   return course.LabelMode || null;
    case "canMove":     return course.CanMove != null ? String(course.CanMove) : null;
    case "status":      return course.Status && course.Status !== "Default" ? course.Status : null;
    case "code":        return course.Code || null;
    case "credits":     return course.Credits != null ? String(course.Credits) : null;
    case "depth":       return course.Depth || null;
    case "periods": {
      let base = formatPeriodsDisplay(course.Periods);
      if (!base) return null;
      const yp = course.YearParity || "Any";
      if (yp === "Odd") base += " (odd years only)";
      else if (yp === "Even") base += " (even years only)";
      return base;
    }
    case "tracks":      return (course.Tracks && course.Tracks.length) ? course.Tracks.join(", ") : null;
    case "name":        return course.Name || null;
    case "shortName":   return course.ShortName || null;
    case "mainFields": {
      const list = getMainFieldsList(course);
      return list.length ? list.join(", ") : null;
    }
    case "department":  return course.Department || null;
    case "appliesFrom": return course.appliesFrom || null;
    case "entryReq":    return course["Entry Requirements"] || null;
    case "about":       return course.About || null;
    case "outcomes":    return course["Learning Outcomes"] || null;
    case "content":     return course.Content || null;
    case "instruction": return course.Instruction || null;
    case "assessment":  return course.Assesment || null;
    case "examination": return course.Examination || course.examination || null;
    case "grading":     return course.gradingSystem || null;
    case "courseLink":  return course["Course Link"] || null;
    case "syllabus":    return course["Syllabus Link"] || null;
    case "literature":  return course["Literature Link"] || null;
    case "comments":    return course.Comments || course.comments || null;
    default:            return null;
  }
}

function showDescription(course) {
  lastDescribedCourse = course;
  const cont = document.getElementById("desc-content");
  if (!course) {
    cont.innerHTML = `<p style="color:#888">Click a course box to see its details.</p>`;
    return;
  }
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const bySection = {};
  DESC_FIELDS.forEach(f => {
    if (!descFieldVisible[f.id]) return;
    const val = getDescFieldValue(course, f.id);
    if (val == null || val === "") return;
    if (!bySection[f.section]) bySection[f.section] = [];
    bySection[f.section].push({ id: f.id, label: f.label, value: val });
  });

  let html = "";
  for (let sec = 0; sec <= 5; sec++) {
    const items = bySection[sec];
    if (!items || !items.length) continue;

    html += `<div class="desc-section">`;
    if (sec !== 0 && DESC_SECTION_TITLES[sec]) {
      html += `<div class="desc-section-title">${esc(DESC_SECTION_TITLES[sec])}</div>`;
    }

    if (sec === 1) {
      // Meta: Name / Short name → label then value on next line;
      // other fields → label + value on same line, each field on its own row
      items.forEach(it => {
        if (it.id === "name" || it.id === "shortName") {
          html += `<div class="field"><div class="label">${esc(it.label)}</div>` +
                  `<div class="value">${esc(it.value)}</div></div>`;
        } else {
          html += `<div class="meta-line"><span class="meta-item">` +
                  `<span class="label">${esc(it.label)}</span> ` +
                  `<span class="value">${esc(it.value)}</span></span></div>`;
        }
      });
    } else if (sec === 5) {
      // Links: bare anchors, no per-field labels
      html += `<div class="link-list">`;
      items.forEach(it => {
        const url = it.value;
        const text = it.label;
        html += `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
      });
      html += `</div>`;
    } else if (sec === 0) {
      // Technical: grid pos as single line without heavy labels for grid; others labeled
      items.forEach(it => {
        if (it.id === "gridPos") {
          html += `<div class="field"><div class="value">${esc(it.value)}</div></div>`;
        } else {
          html += `<div class="field"><div class="label">${esc(it.label)}</div>` +
                  `<div class="value">${esc(it.value)}</div></div>`;
        }
      });
    } else if (sec === 2 || sec === 3) {
      // Entry requirements / Comments: section title only, no gray field label
      items.forEach(it => {
        html += `<div class="field"><div class="value">${esc(it.value)}</div></div>`;
      });
    } else {
      // Details and other labeled sections
      items.forEach(it => {
        html += `<div class="field"><div class="label">${esc(it.label)}</div>` +
                `<div class="value">${esc(it.value)}</div></div>`;
      });
    }
    html += `</div>`;
  }

  if (!html) {
    html = `<p style="color:#888">No visible fields for this course. Right-click the panel to choose fields.</p>`;
  }
  cont.innerHTML = html;
}

function openDescFieldsMenu(e) {
  e.preventDefault();
  e.stopPropagation();
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
  const menu = document.getElementById("desc-fields-menu");
  let html = "";
  let lastSec = -1;
  DESC_FIELDS.forEach(f => {
    if (f.section !== lastSec) {
      lastSec = f.section;
      const title = f.section === 0 ? "Technical" : (DESC_SECTION_TITLES[f.section] || ("Section " + f.section));
      html += `<div class="menu-label">${title}</div>`;
    }
    const checked = descFieldVisible[f.id] ? "checked" : "";
    html += `<label><input type="checkbox" data-desc-field="${f.id}" ${checked}> ${f.label}</label>`;
  });
  menu.innerHTML = html;
  menu.dataset.openedAt = String(Date.now());
  positionMenuInViewport(menu, e.clientX, e.clientY);

  menu.querySelectorAll("input[data-desc-field]").forEach(cb => {
    cb.addEventListener("change", () => {
      descFieldVisible[cb.dataset.descField] = cb.checked;
      saveDescFieldPrefs();
      if (lastDescribedCourse) showDescription(lastDescribedCourse);
    });
  });
}

/** Map matrix row → academic year index (-2 … 3) and level label */
const YEAR_LEVEL_LABELS = {
  "-2": "Bac-1",
  "-1": "Bac-2",
  "0":  "Bac-3",
  "1":  "Mas-1",
  "2":  "Mas-2",
  "3":  "Mas-3"
};

function yearIndexFromRow(row) {
  // rows 0-3 → -2, 4-7 → -1, …, 20-23 → 3
  return Math.floor(row / 4) - 2;
}

/** Calendar year for academic year index Y and period 1..4 */
function calendarYearFor(academicYear, period) {
  const fallCal = masterStartYear + (Number(academicYear) - 1);
  const p = ((Number(period) - 1) % 4) + 1;
  return (p <= 2) ? fallCal : (fallCal + 1);
}

/** True if course may occupy matrix row (parity + period) */
function isParityAllowedAtRow(course, row) {
  const parity = course.YearParity || "Any";
  if (parity === "Any" || !parity) return true;
  const yIdx = yearIndexFromRow(row);
  const period = (row % 4) + 1;
  const nums = numericPeriods(course.Periods, course.activePeriodAlt);
  const periods = nums.length ? nums : [period];
  for (const p of periods) {
    // map each period of the alternative onto the same academic year block
    const cal = calendarYearFor(yIdx, p);
    if (parity === "Odd" && (cal % 2 === 0)) return false;
    if (parity === "Even" && (cal % 2 === 1)) return false;
  }
  return true;
}



/** Plain-text export of the Your Choices panel (including Summary). */
function formatChoicesPlainText() {
  const lines = [];
  const selected = [];
  selectedCodes.forEach(code => {
    const c = courses.find(x => x.Code === code);
    if (c) selected.push(c);
  });
  if (!selected.length) return "(no courses selected)";

  const groups = {};
  selected.forEach(c => {
    let yi = c.GridPosition != null ? yearIndexFromRow(c.GridPosition.row) : Number(c.Year);
    if (isNaN(yi)) yi = 0;
    if (!groups[yi]) groups[yi] = [];
    groups[yi].push(c);
  });
  Object.keys(groups).map(Number).sort((a, b) => a - b).forEach(yi => {
    const label = YEAR_LEVEL_LABELS[String(yi)] || ("Y" + yi);
    lines.push(`Year ${yi} (${label})`);
    const list = groups[yi];
    const fall = list.filter(c => (c.primaryPeriod || 1) <= 2)
      .sort((a, b) => (a.primaryPeriod || 0) - (b.primaryPeriod || 0) || (a.Code || "").localeCompare(b.Code || ""));
    const spring = list.filter(c => (c.primaryPeriod || 1) > 2)
      .sort((a, b) => (a.primaryPeriod || 0) - (b.primaryPeriod || 0) || (a.Code || "").localeCompare(b.Code || ""));
    if (fall.length) {
      lines.push("  Fall");
      fall.forEach(c => lines.push(`    ${c.Credits} | ${c.Code} | ${c.displayName}`));
    }
    if (spring.length) {
      lines.push("  Spring");
      spring.forEach(c => lines.push(`    ${c.Credits} | ${c.Code} | ${c.displayName}`));
    }
  });

  // Summary (same aggregation as panel)
  const agg = new Map();
  selected.forEach(c => {
    const fields = getMainFieldsList(c);
    if (!fields.length) return;
    const depth = String(c.Depth || "").trim();
    const letter = depth ? depth.charAt(0).toUpperCase() : "?";
    const credits = Number(c.Credits) || 0;
    fields.forEach(f => {
      const key = f + "\0" + letter;
      agg.set(key, (agg.get(key) || 0) + credits);
    });
  });
  if (agg.size) {
    lines.push("Summary");
    const rows = Array.from(agg.entries()).map(([key, cr]) => {
      const [field, letter] = key.split("\0");
      return { credits: cr, letter, field };
    });
    rows.sort((a, b) => {
      if (b.credits !== a.credits) return b.credits - a.credits;
      const ap = a.field === "Physics" ? 0 : 1;
      const bp = b.field === "Physics" ? 0 : 1;
      if (ap !== bp) return ap - bp;
      if (a.letter !== b.letter) return a.letter.localeCompare(b.letter);
      return a.field.localeCompare(b.field);
    });
    rows.forEach(r => lines.push(`  ${r.credits} | ${r.letter} | ${r.field}`));
  }
  return lines.join("\n");
}

async function copyChoicesToClipboard() {
  const text = formatChoicesPlainText();
  const btn = document.getElementById("btn-copy-choices");
  const flashOk = () => {
    if (!btn) return;
    btn.classList.add("copied");
    btn.setAttribute("aria-label", "Copied");
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.setAttribute("aria-label", "Copy choices");
    }, 900);
  };
  try {
    await navigator.clipboard.writeText(text);
    flashOk();
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); flashOk(); } catch (_) {
      alert("Could not copy to clipboard.");
    }
    document.body.removeChild(ta);
  }
}

function updateChoicesList() {
  const ul = document.getElementById("choices-list");
  ul.innerHTML = "";

  // Collect selected courses that still exist
  const selected = [];
  selectedCodes.forEach(code => {
    const c = courses.find(x => x.Code === code);
    if (c) selected.push(c);
  });

  if (selected.length === 0) return;

  // Group by year index derived from GridPosition.row (fallback: course.Year)
  const groups = {};  // yearIndex → [courses]
  selected.forEach(c => {
    let yi;
    if (c.GridPosition != null) {
      yi = yearIndexFromRow(c.GridPosition.row);
    } else {
      yi = Number(c.Year);
      if (isNaN(yi)) yi = 0;
    }
    if (!groups[yi]) groups[yi] = [];
    groups[yi].push(c);
  });

  // Sort year indices ascending (-2 … 3)
  const yearKeys = Object.keys(groups).map(Number).sort((a, b) => a - b);

  yearKeys.forEach(yi => {
    const list = groups[yi];

    const groupDiv = document.createElement("div");
    groupDiv.className = "year-group";

    const header = document.createElement("div");
    header.className = "year-header";
    const label = YEAR_LEVEL_LABELS[String(yi)] || ("Y" + yi);
    header.textContent = `Year ${yi} (${label})`;
    groupDiv.appendChild(header);

    // Split into Fall (periods 1–2) and Spring (periods 3–4)
    const fall = [];
    const spring = [];
    list.forEach(c => {
      const p = c.primaryPeriod || 1;
      if (p <= 2) fall.push(c);
      else spring.push(c);
    });
    const byPeriodThenCode = (a, b) => {
      const pa = a.primaryPeriod || 0;
      const pb = b.primaryPeriod || 0;
      if (pa !== pb) return pa - pb;
      return (a.Code || "").localeCompare(b.Code || "");
    };
    fall.sort(byPeriodThenCode);
    spring.sort(byPeriodThenCode);

    const appendCourseRow = (c, parent) => {
      const li = document.createElement("li");
      li.classList.add("selected-course");
      li.innerHTML =
        `<span class="col-credits">${c.Credits}</span>` +
        `<span class="col-code">${c.Code}</span>` +
        `<span class="col-name">${c.displayName}</span>`;
      li.addEventListener("click", () => showDescription(c));
      li.addEventListener("contextmenu", e => {
        e.preventDefault();
        e.stopPropagation();
        selectedCodes.delete(c.Code);
        updateChoicesList();
        renderCourses();
        pushHistory();
      });
      parent.appendChild(li);
    };

    if (fall.length > 0) {
      const sh = document.createElement("div");
      sh.className = "season-header";
      sh.textContent = "Fall";
      groupDiv.appendChild(sh);
      fall.forEach(c => appendCourseRow(c, groupDiv));
    }
    if (spring.length > 0) {
      const sh = document.createElement("div");
      sh.className = "season-header";
      sh.textContent = "Spring";
      groupDiv.appendChild(sh);
      spring.forEach(c => appendCourseRow(c, groupDiv));
    }

    ul.appendChild(groupDiv);
  });

  // ---- Summary: credits × depth-letter × main field ----
  // Always show when there is at least one selected course.
  const agg = new Map(); // key = field + "\x00" + letter → credits
  selected.forEach(c => {
    const fields = getMainFieldsList(c);
    if (!fields.length) return;
    const depth = String(c.Depth || "").trim();
    const letter = depth ? depth.charAt(0).toUpperCase() : "?";
    const credits = Number(c.Credits) || 0;
    fields.forEach(f => {
      const key = f + "\x00" + letter;
      agg.set(key, (agg.get(key) || 0) + credits);
    });
  });
  {
    const sumDiv = document.createElement("div");
    sumDiv.className = "year-group choices-summary";
    const sh = document.createElement("div");
    sh.className = "year-header";
    sh.textContent = "Summary";
    sumDiv.appendChild(sh);

    if (agg.size === 0) {
      const empty = document.createElement("div");
      empty.className = "summary-empty";
      empty.textContent = "No main-field data on selected courses.";
      sumDiv.appendChild(empty);
    } else {
      const rows = Array.from(agg.entries()).map(([key, cr]) => {
        const sep = key.indexOf("\x00");
        const field = key.slice(0, sep);
        const letter = key.slice(sep + 1);
        return { credits: cr, letter, field };
      });
      rows.sort((a, b) => {
        if (b.credits !== a.credits) return b.credits - a.credits;
        const ap = a.field === "Physics" ? 0 : 1;
        const bp = b.field === "Physics" ? 0 : 1;
        if (ap !== bp) return ap - bp;
        if (a.letter !== b.letter) return a.letter.localeCompare(b.letter);
        return a.field.localeCompare(b.field);
      });
      rows.forEach(r => {
        const li = document.createElement("li");
        li.className = "summary-row";
        li.innerHTML =
          `<span class="col-credits">${r.credits}</span>` +
          `<span class="col-code">${r.letter}</span>` +
          `<span class="col-name">${r.field}</span>`;
        sumDiv.appendChild(li);
      });
    }
    ul.appendChild(sumDiv);
  }
}


/* ============================================================
   EVENT LISTENERS (header, overlays, menu)
   ============================================================ */
function setupEventListeners() {
  // tag checkboxes – keep placed courses; add newly visible ones from a left border
  ALL_TAG_KEYS.forEach(tag => {
    const cb = document.getElementById("tag-" + tag);
    if (!cb) return;
    cb.addEventListener("change", e => {
      if (e.target.checked) activeTags.add(tag);
      else activeTags.delete(tag);
      onTrackTagsChanged();
    });
    // Right-click the tag label → change that colour variable
    const label = cb.closest("label.track-tag");
    if (label) {
      label.addEventListener("contextmenu", e => {
        e.preventDefault();
        e.stopPropagation();
        openTrackColorMenu(e, tag);
      });
    }
  });

  // overlay visibility (Choices ↔ Hidden are mutually exclusive)
  document.getElementById("show-choices").addEventListener("change", e => {
    if (e.target.checked) {
      document.getElementById("show-hidden").checked = false;
    }
    updateOverlaysVisibility();
  });
  document.getElementById("show-hidden").addEventListener("change", e => {
    if (e.target.checked) {
      document.getElementById("show-choices").checked = false;
      updateHiddenList();
    }
    updateOverlaysVisibility();
  });
  document.getElementById("show-description").addEventListener("change", updateOverlaysVisibility);

  document.getElementById("global-show-code").addEventListener("change", e => {
    globalShowCode = e.target.checked;
    renderCourses();
    pushHistory();
  });

  // Description panel: right-click to choose visible fields
  const pDesc = document.getElementById("P_Description");
  pDesc.addEventListener("contextmenu", openDescFieldsMenu);
  // Safari: prevent the synthetic click from immediately dismissing the menu
  pDesc.addEventListener("contextmenu", e => {
    e.preventDefault();
  }, true);

  // recompute layout from current course state (keeps visibility / locks / selection)
  const msy = document.getElementById("master-start-year");
  if (msy) {
    msy.value = String(masterStartYear);
    msy.addEventListener("change", () => {
      masterStartYear = parseInt(msy.value, 10) || 2026;
      buildCanvas();
      renderCourses(); // refresh parity highlights for new calendar map
      pushHistory();
    });
  }
  const spi = document.getElementById("show-parity-issues");
  if (spi) {
    spi.checked = !!showParityIssues;
    spi.addEventListener("change", () => {
      showParityIssues = !!spi.checked;
      renderCourses();
      pushHistory();
    });
  }

  // Zoom: scales FIVE_WIDTH & PERIOD_HEIGHT (bulk + gutter only)
  const zr = document.getElementById("zoom-range");
  if (zr) {
    zr.addEventListener("input", () => applyZoom(parseInt(zr.value, 10) || 100, true));
  }
  document.getElementById("btn-zoom-in")?.addEventListener("click", () => {
    applyZoom(zoomPercent + 10, true);
  });
  document.getElementById("btn-zoom-out")?.addEventListener("click", () => {
    applyZoom(zoomPercent - 10, true);
  });

  document.getElementById("btn-remove-gaps")?.addEventListener("click", () => {
    removeGapsOnly();
    renderCourses();
    pushHistory();
  });

  // Fast tooltips for undo/redo (~350ms instead of browser ~1s title delay)
  (function setupQuickTips() {
    let tipEl = document.getElementById("quick-tip");
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "quick-tip";
      document.body.appendChild(tipEl);
    }
    let timer = null;
    function showTip(el, text) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        tipEl.textContent = text;
        tipEl.style.display = "block";
        const r = el.getBoundingClientRect();
        tipEl.style.left = Math.min(r.left, window.innerWidth - 80) + "px";
        tipEl.style.top = (r.bottom + 4) + "px";
      }, 350);
    }
    function hideTip() {
      clearTimeout(timer);
      tipEl.style.display = "none";
    }
    ["btn-undo", "btn-redo"].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.removeAttribute("title");
      el.addEventListener("mouseenter", () => showTip(el, el.dataset.tip || ""));
      el.addEventListener("mouseleave", hideTip);
      el.addEventListener("click", hideTip);
    });
  })();

  document.getElementById("btn-recompute").addEventListener("click", () => {
    // Clear movable positions so layout modes can recompute from RelativeVal / stack
    if (layoutMode === "stack" || layoutMode === "absolute" || layoutMode === "relative") {
      courses.forEach(c => {
        if (c.CanMove) c.GridPosition = null;
      });
    }
    placeFixedCourses();
    autoLayoutMovable();
    renderCourses();
    updateHiddenList();
    pushHistory();
  });

  document.getElementById("btn-undo")?.addEventListener("click", () => undo());
  document.getElementById("btn-redo")?.addEventListener("click", () => redo());
  document.addEventListener("keydown", e => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      redo();
    }
  });

  // Magnetisation radios
  document.querySelectorAll('input[name="magnet"]').forEach(r => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      magnetStep = parseFloat(r.value) || 1;
      try { localStorage.setItem("magnetStep", String(magnetStep)); } catch (_) {}
      pushHistory();
    });
  });
  try {
    const ms = parseFloat(localStorage.getItem("magnetStep"));
    if (ms === 1 || ms === 0.5 || ms === 0.25) {
      magnetStep = ms;
      const radio = document.querySelector(`input[name="magnet"][value="${ms}"]`);
      if (radio) radio.checked = true;
    }
  } catch (_) {}

  // Layout mode
  const lm = document.getElementById("layout-mode");
  if (lm) {
    try {
      const saved = localStorage.getItem("layoutMode");
      if (saved === "stack" || saved === "absolute" || saved === "relative") {
        layoutMode = saved;
        lm.value = saved;
      }
    } catch (_) {}
    lm.addEventListener("change", () => {
      layoutMode = lm.value || "stack";
      try { localStorage.setItem("layoutMode", layoutMode); } catch (_) {}
      pushHistory();
    });
  }

  // Frozen gutter follows vertical scroll
  const bulkEl = document.getElementById("P_Bulk");
  if (bulkEl) {
    // Non-passive + direct sync — minimise lag vs passive rAF-batched scroll
    bulkEl.addEventListener("scroll", syncGutterScroll, { passive: true, capture: true });
  }

  // Reset → restore page to state right after the most recent Upload / load
  document.getElementById("btn-reset-upload").addEventListener("click", () => {
    if (!lastUploadSnapshot) {
      alert("Nothing to reset to yet. Upload a JSON file first (or wait for auto-load).");
      return;
    }
    applyLoadedData(JSON.parse(JSON.stringify(lastUploadSnapshot)));
  });

  // Help overlay
  document.getElementById("btn-help").addEventListener("click", () => {
    const ov = document.getElementById("help-overlay");
    ov.classList.add("visible");
    ov.setAttribute("aria-hidden", "false");
  });
  document.getElementById("btn-help-close").addEventListener("click", () => {
    const ov = document.getElementById("help-overlay");
    ov.classList.remove("visible");
    ov.setAttribute("aria-hidden", "true");
  });
  document.getElementById("btn-disclaimer")?.addEventListener("click", () => {
    const ov = document.getElementById("disclaimer-overlay");
    if (!ov) return;
    ov.classList.add("visible");
    ov.setAttribute("aria-hidden", "false");
  });
  document.getElementById("btn-disclaimer-close")?.addEventListener("click", () => {
    const ov = document.getElementById("disclaimer-overlay");
    if (!ov) return;
    ov.classList.remove("visible");
    ov.setAttribute("aria-hidden", "true");
  });
  document.getElementById("disclaimer-overlay")?.addEventListener("click", e => {
    if (e.target.id === "disclaimer-overlay") {
      e.target.classList.remove("visible");
      e.target.setAttribute("aria-hidden", "true");
    }
  });
  // Copy button (delegation — survives any panel re-render / Safari pointer quirks)
  const choicesPanel = document.getElementById("P_Choices");
  if (choicesPanel) {
    choicesPanel.addEventListener("click", e => {
      const btn = e.target.closest("#btn-copy-choices");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      copyChoicesToClipboard();
    });
  }
  document.getElementById("help-overlay").addEventListener("click", e => {
    if (e.target.id === "help-overlay") {
      e.target.classList.remove("visible");
      e.target.setAttribute("aria-hidden", "true");
    }
  });

  // Right-click tips on pane / Name+Code controls
  const CONTROL_TIPS = {
    "show-choices": "Shows or hides the Your Choices panel (selected courses). Opening it closes Hidden courses.",
    "show-hidden": "Shows or hides the Hidden courses panel. Opening it closes Your Choices.",
    "show-description": "Shows or hides the Course Description panel on the right. Clicking a course updates its content only when this panel is open.",
    "global-show-code": "When on, course boxes with Label mode Automatic show both short name and course code. Per-course Label mode can override this."
  };
  Object.keys(CONTROL_TIPS).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const target = el.closest("label") || el;
    target.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      showControlTip(e.clientX, e.clientY, CONTROL_TIPS[id]);
    });
  });

  // ---- Upload / Save ----
  document.getElementById('catalog-select').addEventListener('change', async (event) => {
    const selectedPath = event.target.value; // e.g., "data/NP.json"
    if (!selectedPath) return;

    // Extract just the filename (e.g., "NP.json") from the path
    const fileName = selectedPath.split('/').pop();

    try {
      const response = await fetch(selectedPath);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const parsedData = await response.json();
      
      // Register the dataset using your app's actual function!
      registerLocalJson(fileName, parsedData);

    } catch (error) {
      console.error('Failed to load dataset:', error);
      alert('Failed to load the selected dataset.');
    }
  });

  document.getElementById("btn-upload").addEventListener("click", () => {
    document.getElementById("file-upload").click();
  });

  document.getElementById("file-upload").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    try {
      const parsedList = [];
      for (const file of files) {
        const text = await file.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          throw new Error(file.name + ": " + err.message);
        }
        registerLocalJson(file.name, parsed);
        parsedList.push({ name: file.name, data: parsed });
      }

      function isCatalog(d) {
        return d && typeof d === "object" && !Array.isArray(d) && (
          d.type === "course-catalog" ||
          (typeof d.description === "string" && /catalog/i.test(d.description) && Array.isArray(d.courses) && d.courses.length > 20)
        );
      }
      function score(entry) {
        const d = entry.data;
        if (!d || typeof d !== "object" || Array.isArray(d)) return 1;
        if (isCatalog(d)) return 0;
        if (d.type === "planner-config" || (Array.isArray(d.parents) && d.parents.length)) return 3;
        const courses = d.courses || [];
        if (courses.length && courses.every(c => c && c.Code && Object.keys(c).length <= 8)) return 3;
        return 2;
      }

      // Only catalogue file(s): register and guide the user — do not replace the planner view
      if (parsedList.every(e => isCatalog(e.data)) && parsedList.some(e => isCatalog(e.data))) {
        alert("Course catalogue loaded. Click Upload again and choose a layout JSON file (for example MasterProgramme.json).");
        e.target.value = "";
        return;
      }

      parsedList.sort((a, b) => score(b) - score(a));
      const primary = parsedList[0].data;
      const resolved = await resolveCoursePayload(primary);

      if (resolved && resolved._missingParents && resolved._missingParents.length) {
        alert("You must load any *.catalog.json first; after that other JSON files will work.");
      }

      applyLoadedData(resolved);
      try {
        lastUploadSnapshot = JSON.parse(JSON.stringify(buildSavePayload()));
        undoStack = [JSON.stringify(lastUploadSnapshot)];
        redoStack = [];
        updateUndoRedoButtons();
      } catch (_) {}
      scrollToCoursesCenter();
    } catch (err) {
      alert("Failed to read JSON file:\n" + err.message);
    }
    e.target.value = "";
  });

  document.getElementById("btn-save").addEventListener("click", async () => {
    const payload = buildSavePayload();
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: "application/json" });

    // Always try the native Save-As dialog when the API exists
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: "courses_save.json",
          types: [{
            description: "JSON files",
            accept: { "application/json": [".json"] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return; // success
      } catch (err) {
        if (err.name === "AbortError") return; // user cancelled – stop
        console.info("Save-As dialog unavailable (" + err.name + "), using download fallback.");
      }
    } else {
      console.info("showSaveFilePicker not supported in this browser – using download fallback.");
    }

    // Fallback: classic download (Downloads folder)
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "courses_save.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  // context menu actions
  document.getElementById("context-menu").addEventListener("click", e => {
    const btn = e.target.closest("[data-action]");
    const action = btn && btn.dataset.action;
    if (!action || !contextTarget) return;
    if (btn.disabled) return;
    const c = contextTarget;

    if (action === "select") {
      if (selectedCodes.has(c.Code)) selectedCodes.delete(c.Code);
      else selectedCodes.add(c.Code);
      updateChoicesList();
      renderCourses();
    } else if (action === "remove") {
      if (selectedCodes.has(c.Code)) return; // safety: Hide disabled while selected
      // Hide from grid; clears Always visible (Visible → Hidden)
      c.Visibility = "Hidden";
      clearCourseFromMatrix(c);
      renderCourses();
      updateHiddenList();
    } else if (action === "always-visible") {
      // Toggle Always visible (Visibility === "Visible") vs Automatic
      if (c.Visibility === "Visible") c.Visibility = "Automatic";
      else c.Visibility = "Visible";
      renderCourses();
      updateHiddenList();
    } else if (action === "lock") {
      c.CanMove = !c.CanMove;
      renderCourses();
    } else if (action === "color") {
      c.BoxColor = e.target.dataset.color;
      renderCourses();
    } else if (action === "label-auto") {
      c.LabelMode = "Automatic";
      renderCourses();
    } else if (action === "label-name") {
      c.LabelMode = "Name";
      renderCourses();
    } else if (action === "label-both") {
      c.LabelMode = "Both";
      renderCourses();
    }

    document.getElementById("context-menu").style.display = "none";
    contextTarget = null;
    pushHistory();
  });

  // hidden-panel context menu actions
  document.getElementById("hidden-context-menu").addEventListener("click", e => {
    const action = e.target.dataset.action;
    if (!action || !contextTargetHidden) return;
    if (e.target.disabled) return;
    const c = contextTargetHidden;

    if (action === "make-visible") {
      makeHiddenCourseVisible(c);
    } else if (action === "restore-default") {
      restoreDefaultVisibility(c);
    }

    document.getElementById("hidden-context-menu").style.display = "none";
    contextTargetHidden = null;
    pushHistory();
  });

  // track colour menu
  document.getElementById("track-color-menu").addEventListener("click", e => {
    if (!trackColorTarget) return;
    if (e.target.dataset.action === "reset-track-color") {
      setSchemeColor(trackColorTarget, DEFAULT_COLOR_SCHEME[trackColorTarget]);
      document.getElementById("track-color-menu").style.display = "none";
      trackColorTarget = null;
      return;
    }
    if (e.target.classList.contains("color-swatch") && e.target.dataset.color) {
      setSchemeColor(trackColorTarget, e.target.dataset.color);
      document.getElementById("track-color-menu").style.display = "none";
      trackColorTarget = null;
    }
  });

  // Close context menus on outside click — but ignore the synthetic click
  // that Safari fires immediately after control-click / contextmenu.
  function closeMenusIfOutside(e) {
    const menus = ["context-menu", "hidden-context-menu", "track-color-menu", "desc-fields-menu"]
      .map(id => document.getElementById(id));
    const now = Date.now();
    for (const menu of menus) {
      if (!menu) continue;
      if (menu.style.display === "none" || menu.style.display === "") continue;
      const openedAt = parseInt(menu.dataset.openedAt || "0", 10);
      if (now - openedAt < 600) continue; // Safari control-click synthesises click soon after
      if (e && menu.contains(e.target)) continue;
      menu.style.display = "none";
    }
    const tip = document.getElementById("control-tip");
    if (tip) tip.style.display = "none";
  }
  document.addEventListener("click", closeMenusIfOutside);
  // Also listen to pointerup for Safari edge cases
  document.addEventListener("pointerup", closeMenusIfOutside);

  // prevent default context menu on bulk (menus use preventDefault on the target)
  document.getElementById("P_Bulk").addEventListener("contextmenu", e => e.preventDefault());

  // Stop menu internal clicks from bubbling to document close
  ["context-menu", "hidden-context-menu", "track-color-menu", "desc-fields-menu"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", e => e.stopPropagation());
    el.addEventListener("pointerup", e => e.stopPropagation());
    el.addEventListener("pointerdown", e => e.stopPropagation());
  });
}

/** Map UI tag id → colorScheme key (special tags share category colours) */
function schemeKeyForTag(tag) {
  if (tag === "Prog") return "Programming";
  if (tag === "TO") return "Pedagogy";
  if (tag === "Proj") return "Project";
  return tag;
}

function openTrackColorMenu(e, tag) {
  const schemeKey = schemeKeyForTag(tag);
  trackColorTarget = schemeKey;
  const menu = document.getElementById("track-color-menu");
  menu.dataset.openedAt = String(Date.now());
  const titles = { Prog: "Programming", TO: "Teaching & Outreach", Proj: "Projects" };
  document.getElementById("track-color-title").textContent = (titles[tag] || tag) + " colour";
  const row = document.getElementById("track-color-swatches");
  row.innerHTML = "";
  const current = colorScheme[schemeKey] || DEFAULT_COLOR_SCHEME[schemeKey];
  BOX_COLOURS.forEach(col => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "color-swatch" + (col.toLowerCase() === String(current).toLowerCase() ? " active" : "");
    btn.style.background = col;
    btn.dataset.color = col;
    row.appendChild(btn);
  });
  menu.style.display = "block";
  positionMenuInViewport(menu, e.clientX, e.clientY);
}

/* ============================================================
   SAVE / LOAD HELPERS
   ============================================================ */

/**
 * Build a complete JSON payload that can be re-loaded later.
 * Two formats are accepted on load:
 *   1. Plain array of course objects  (the original courses.json style)
 *   2. Full state object { courses, selected, removed, tags }
 */

function pushHistory() {
  if (historySuspended) return;
  try {
    const snap = JSON.stringify(buildSavePayload());
    // skip if identical to top
    if (undoStack.length && undoStack[undoStack.length - 1] === snap) return;
    undoStack.push(snap);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
  } catch (err) {
    console.warn("pushHistory failed", err);
  }
}

function updateUndoRedoButtons() {
  const u = document.getElementById("btn-undo");
  const r = document.getElementById("btn-redo");
  // need at least 2 snapshots to undo (current + previous)
  if (u) u.disabled = undoStack.length < 2;
  if (r) r.disabled = redoStack.length < 1;
}

function undo() {
  if (undoStack.length < 2) return;
  const current = undoStack.pop();
  redoStack.push(current);
  const prev = undoStack[undoStack.length - 1];
  historySuspended = true;
  try {
    // Preserve canvas scroll — do not jump focus on undo
    const bulk = document.getElementById("P_Bulk");
    const keepL = bulk ? bulk.scrollLeft : 0;
    const keepT = bulk ? bulk.scrollTop : 0;
    applyLoadedData(JSON.parse(prev));
    if (bulk) {
      bulk.scrollLeft = keepL;
      bulk.scrollTop = keepT;
      syncGutterScroll();
    }
  } finally {
    historySuspended = false;
    updateUndoRedoButtons();
  }
}

function redo() {
  if (!redoStack.length) return;
  const next = redoStack.pop();
  undoStack.push(next);
  historySuspended = true;
  try {
    const bulk = document.getElementById("P_Bulk");
    const keepL = bulk ? bulk.scrollLeft : 0;
    const keepT = bulk ? bulk.scrollTop : 0;
    applyLoadedData(JSON.parse(next));
    if (bulk) {
      bulk.scrollLeft = keepL;
      bulk.scrollTop = keepT;
      syncGutterScroll();
    }
  } finally {
    historySuspended = false;
    updateUndoRedoButtons();
  }
}

function buildSavePayload() {
  // Every course field (design, visibility, position, extras, …)
  const courseList = courses.map(c => c.toJSON());

  const bulk = document.getElementById("P_Bulk");
  return {
    version: 2,
    savedAt: new Date().toISOString(),
    courses: courseList,
    selected: Array.from(selectedCodes),
    activeTags: Array.from(activeTags),
    globalShowCode: globalShowCode,
    colorScheme: Object.assign({}, colorScheme),
    magnetStep: magnetStep,
    layoutMode: layoutMode,
    masterStartYear: masterStartYear,
    zoomPercent: zoomPercent,
    showParityIssues: !!showParityIssues,
    ui: {
      showChoices: !!document.getElementById("show-choices")?.checked,
      showHidden: !!document.getElementById("show-hidden")?.checked,
      showDescription: !!document.getElementById("show-description")?.checked,
      bulkScrollLeft: bulk ? bulk.scrollLeft : 0,
      bulkScrollTop: bulk ? bulk.scrollTop : 0
    },
    panelWidths: {
      P_Choices: loadPanelWidth("P_Choices"),
      P_Hidden: loadPanelWidth("P_Hidden"),
      P_Description: loadPanelWidth("P_Description")
    }
  };
}

/**
 * Accept either a plain array or a full state object and rebuild the UI.
 */

/* ============================================================
   PARENT JSON INHERITANCE
   Config files may declare:
     "parents": ["data/MaFyCourses.json", ...]
   Parents are loaded in order; later parents override earlier.
   Config "courses" entries match by Code and only need override fields.
   ============================================================ */

const COURSE_LAYOUT_KEYS = new Set([
  "GridPosition", "Visibility", "CanMove", "CanJumpOver",
  "BoxColor", "LabelMode", "ShowCode", "rWidth", "rHeight", "activePeriodAlt"
]);

function deepMergeCourse(base, over) {
  // Any field present on the config entry overrides the parent (not only layout keys).
  if (!base) return Object.assign({}, over);
  if (!over) return Object.assign({}, base);
  const out = Object.assign({}, base);
  Object.keys(over).forEach(k => {
    if (over[k] === undefined) return;
    // nested GridPosition replace as whole
    if (k === "GridPosition" && over[k] && typeof over[k] === "object") {
      out[k] = Object.assign({}, over[k]);
    } else if (k === "RelativeVal" && Array.isArray(over[k])) {
      out[k] = over[k].slice();
    } else if (Array.isArray(over[k])) {
      out[k] = over[k].slice();
    } else {
      out[k] = over[k];
    }
  });
  return out;
}

/** JSON from multi-file Upload — works offline / file:// without a server */
const localJsonRegistry = new Map();

function registerLocalJson(fileName, data) {
  if (!fileName || data == null) return;
  const base = String(fileName).split(/[/\\]/).pop().toLowerCase();
  localJsonRegistry.set(base, data);
}

function lookupLocalJson(path) {
  if (!path) return null;
  const base = String(path).split(/[/\\]/).pop().toLowerCase();
  if (localJsonRegistry.has(base)) return localJsonRegistry.get(base);
  return null;
}

async function fetchJsonRelative(path, baseUrl) {
  // 1) Files the user already chose in this session (file:// safe)
  const local = lookupLocalJson(path);
  if (local) return local;

  // 2) HTTP when the folder is served (e.g. python3 -m http.server)
  const tries = [path];
  if (!String(path).startsWith("data/") && !String(path).startsWith("http")) {
    tries.push("data/" + String(path).replace(/^\.\//, ""));
  }
  const base = String(path).split("/").pop();
  if (base && base !== path) tries.push("data/" + base);
  if (base && /\.json$/i.test(base) && !/\.catalog\.json$/i.test(base)) {
    const cat = base.replace(/\.json$/i, ".catalog.json");
    tries.push(cat);
    tries.push("data/" + cat);
  }
  // Prefer new catalog filename
  tries.push("data/MaFyCourses.catalog.json");
  tries.push("MaFyCourses.catalog.json");
  for (const t of tries) {
    try {
      const resp = await fetch(t);
      if (resp.ok) return await resp.json();
    } catch (_) {}
  }
  throw new Error("Could not load parent JSON: " + path);
}

/**
 * Resolve parents + local courses into a flat courses array (config order).
 * Returns { ...parsed, courses: merged[] } without mutating original heavily.
 */
async function resolveCoursePayload(parsed, _seen) {
  if (!parsed || typeof parsed !== "object") return parsed;
  if (Array.isArray(parsed)) return { courses: parsed };

  const seen = _seen || new Set();
  const parents = [];
  if (Array.isArray(parsed.parents)) parents.push(...parsed.parents);
  else if (typeof parsed.parent === "string") parents.push(parsed.parent);

  // Map Code → merged course from parents (in order)
  const fromParents = new Map();
  const missingParents = [];
  for (const p of parents) {
    if (seen.has(p)) continue;
    seen.add(p);
    let pdata;
    try {
      pdata = await fetchJsonRelative(p);
    } catch (err) {
      console.warn(err.message);
      missingParents.push(p);
      continue;
    }
    const resolved = await resolveCoursePayload(pdata, seen);
    const list = (resolved && resolved.courses) || [];
    list.forEach(c => {
      if (!c || !c.Code) return;
      fromParents.set(c.Code, deepMergeCourse(fromParents.get(c.Code), c));
    });
  }

  const local = Array.isArray(parsed.courses) ? parsed.courses : [];
  if (!parents.length && local.length) {
    // standalone full file
    return parsed;
  }

  // Config defines which courses exist in this view; merge overrides onto parent
  const merged = [];
  const used = new Set();
  local.forEach(c => {
    if (!c || !c.Code) return;
    const base = fromParents.get(c.Code);
    merged.push(deepMergeCourse(base, c));
    used.add(c.Code);
  });

  // If no local courses listed but parents exist, use all parent courses
  if (!local.length && fromParents.size) {
    fromParents.forEach(c => merged.push(c));
  }

  const out = Object.assign({}, parsed, { courses: merged });
  if (missingParents.length) out._missingParents = missingParents;
  return out;
}

function applyLoadedData(parsed) {
  let courseArray, sel, rem, tags;

  if (Array.isArray(parsed)) {
    // classic courses.json format
    courseArray = parsed;
    sel = [];
    rem = [];
    tags = null;   // keep current tag filters
  } else if (parsed && Array.isArray(parsed.courses)) {
    // full state format produced by Save
    courseArray = parsed.courses;
    sel = parsed.selected || [];
    rem = parsed.removed || [];
    tags = parsed.activeTags || null;
  } else {
    alert("Unrecognised JSON format.\nExpected an array of courses or a {courses:[…]} object.");
    return;
  }

  // store as the new “original” baseline for Reset
  originalData = courseArray.map(d => ({ ...d }));

  // rebuild Course objects
  courses = courseArray.map(d => new Course(d));

  // restore selection
  selectedCodes = new Set(sel);

  // legacy "removed" list → Visibility Hidden
  rem.forEach(code => {
    const c = courses.find(x => x.Code === code);
    if (c) c.Visibility = "Hidden";
  });

  // optionally restore tag checkboxes (tracks + special)
  if (tags) {
    activeTags = new Set(tags);
    ALL_TAG_KEYS.forEach(t => {
      const cb = document.getElementById("tag-" + t);
      if (cb) cb.checked = activeTags.has(t);
    });
  }

  // optionally restore panel widths from save file
  if (parsed && parsed.panelWidths) {
    Object.keys(parsed.panelWidths).forEach(id => {
      const w = parsed.panelWidths[id];
      if (typeof w === "number" && w >= 180) savePanelWidth(id, w);
    });
  }

  // restore global Name+Code toggle
  if (parsed && typeof parsed.globalShowCode === "boolean") {
    globalShowCode = parsed.globalShowCode;
    const cb = document.getElementById("global-show-code");
    if (cb) cb.checked = globalShowCode;
  }

  // restore colour scheme (track + category variables)
  if (parsed && parsed.colorScheme && typeof parsed.colorScheme === "object") {
    Object.keys(DEFAULT_COLOR_SCHEME).forEach(k => {
      if (typeof parsed.colorScheme[k] === "string" && /^#/.test(parsed.colorScheme[k])) {
        colorScheme[k] = parsed.colorScheme[k];
      }
    });
    try { localStorage.setItem("colorScheme", JSON.stringify(colorScheme)); } catch (_) {}
    applyTrackTagStyles();
  }

  // restore magnetisation + layout mode
  if (parsed && (parsed.magnetStep === 1 || parsed.magnetStep === 0.5 || parsed.magnetStep === 0.25)) {
    magnetStep = parsed.magnetStep;
    const radio = document.querySelector(`input[name="magnet"][value="${magnetStep}"]`);
    if (radio) radio.checked = true;
    try { localStorage.setItem("magnetStep", String(magnetStep)); } catch (_) {}
  }
  if (parsed && (parsed.layoutMode === "stack" || parsed.layoutMode === "absolute" || parsed.layoutMode === "relative")) {
    layoutMode = parsed.layoutMode;
    const lmEl = document.getElementById("layout-mode");
    if (lmEl) lmEl.value = layoutMode;
    try { localStorage.setItem("layoutMode", layoutMode); } catch (_) {}
  }

  // restore panel visibility + bulk scroll (full UI snapshot)
  if (parsed && parsed.ui && typeof parsed.ui === "object") {
    const ui = parsed.ui;
    const setChk = (id, val) => {
      const el = document.getElementById(id);
      if (el && typeof val === "boolean") el.checked = val;
    };
    // Pane open/close is a view preference — do not change it on undo/redo
    if (!historySuspended) {
      setChk("show-choices", ui.showChoices);
      setChk("show-hidden", ui.showHidden);
      setChk("show-description", ui.showDescription);
      if (ui.showChoices && ui.showHidden) {
        document.getElementById("show-hidden").checked = false;
      }
    }
  }

  // ---- Place courses ----
  resetMatrix();

  const hasSavedPositions = courses.some(c => c.GridPosition != null);

  if (hasSavedPositions) {
    courses.forEach(c => {
      if (!isVisibleOnGrid(c)) return;
      if (c.GridPosition != null) {
        occupy(c, c.GridPosition.col, c.GridPosition.row);
      }
    });
    autoLayoutMovableOnlyUnplaced();
  } else {
    placeFixedCourses();
    autoLayoutMovable();
  }

  buildCanvas();
  renderCourses();
  updateChoicesList();
  updateHiddenList();
  updateOverlaysVisibility();

  // Scroll: skip entirely during undo/redo (caller restores). On normal load use saved or COM.
  if (!historySuspended) {
    const bulk = document.getElementById("P_Bulk");
    if (parsed && parsed.ui && bulk &&
        (typeof parsed.ui.bulkScrollLeft === "number" || typeof parsed.ui.bulkScrollTop === "number")) {
      bulk.scrollLeft = parsed.ui.bulkScrollLeft || 0;
      bulk.scrollTop = parsed.ui.bulkScrollTop || 0;
    } else {
      scrollToCoursesCenter();
    }
    syncGutterScroll();
  }
  document.getElementById("desc-content").innerHTML = '<p style="color:#888">Click a course box to see its details.</p>';

  // Seed history only when empty (first load). Upload handler resets stack explicitly.
  // Undo/redo set historySuspended and must not touch the stack here.
  if (!historySuspended && undoStack.length === 0) {
    try {
      undoStack = [JSON.stringify(buildSavePayload())];
      redoStack = [];
      updateUndoRedoButtons();
    } catch (_) {}
  }
}

function showControlTip(x, y, text) {
  let tip = document.getElementById("control-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "control-tip";
    document.body.appendChild(tip);
  }
  tip.textContent = text;
  tip.style.display = "block";
  tip.style.left = Math.min(x + 8, window.innerWidth - 300) + "px";
  tip.style.top = Math.min(y + 8, window.innerHeight - 80) + "px";
  clearTimeout(showControlTip._timer);
  showControlTip._timer = setTimeout(() => { tip.style.display = "none"; }, 4500);
}

/** Like autoLayoutMovable, but skips courses that already have a GridPosition */
function autoLayoutMovableOnlyUnplaced() {
  const groups = {};
  courses.forEach(c => {
    if (!c.CanMove || !isVisibleOnGrid(c)) return;
    if (c.GridPosition != null) return;
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
    const step = magnetStep || 1;
    list.forEach(c => {
      while (col + c.hitW <= MATRIX_COLS) {
        if (canPlace(c, col, row)) {
          occupy(c, col, row);
          col += c.hitW;
          break;
        }
        col = snapCol(col + step);
      }
    });
  });
}

/**
 * Tag checkbox change:
 * - Invisible courses never participate in collisions.
 * - Visible courses that already have GridPosition stay if free; conflicts push right.
 * - Visible courses without GridPosition pack from the right edge of existing ones.
 */
function onTrackTagsChanged() {
  const visible = courses.filter(isVisibleOnGrid);
  const already = visible.filter(c => c.GridPosition);
  const fresh = visible.filter(c => !c.GridPosition);

  let leftBorder = 0;
  already.forEach(c => {
    leftBorder = Math.max(leftBorder, c.GridPosition.col + c.hitW);
  });

  // Resolve pairwise overlaps among already-placed (e.g. two tracks reclaiming same slot)
  already.sort((a, b) => a.GridPosition.col - b.GridPosition.col);
  already.forEach(c => {
    const pos = c.GridPosition;
    c.GridPosition = null;
    if (canPlace(c, pos.col, pos.row)) {
      occupy(c, pos.col, pos.row);
    } else if (!tryPushAndPlace(c, pos.col, pos.row)) {
      // push to right edge of occupied band
      let col = leftBorder;
      const step = magnetStep || 1;
      while (col + c.hitW <= MATRIX_COLS && !canPlace(c, col, pos.row)) {
        col = snapCol(col + step);
      }
      occupy(c, Math.min(col, MATRIX_COLS - c.hitW), pos.row);
    }
    leftBorder = Math.max(leftBorder, (c.GridPosition.col + c.hitW));
  });

  placeNewlyVisibleFromBorder(fresh, leftBorder);

  renderCourses();
  updateHiddenList();
  pushHistory();
}

function placeNewlyVisibleFromBorder(list, minCol) {
  if (!list || list.length === 0) return;
  const byRow = {};
  list.forEach(c => {
    let row = (c.GridPosition && c.GridPosition.row != null) ? c.GridPosition.row : naturalRow(c);
    row = Math.max(0, Math.min(MATRIX_ROWS - c.cHeight, row));
    if (!byRow[row]) byRow[row] = [];
    byRow[row].push(c);
  });

  const step = magnetStep || 1;
  Object.keys(byRow).map(Number).sort((a, b) => a - b).forEach(row => {
    const group = byRow[row];
    group.sort((a, b) => {
      const d = relativeOrderKey(a) - relativeOrderKey(b);
      if (d !== 0) return d;
      return (a.Code || "").localeCompare(b.Code || "");
    });
    let col = Math.max(minCol, 0);
    group.forEach(c => {
      let placed = false;
      let tryCol = col;
      while (tryCol + c.hitW <= MATRIX_COLS) {
        if (canPlace(c, tryCol, row)) {
          occupy(c, tryCol, row);
          col = tryCol + c.hitW;
          placed = true;
          break;
        }
        tryCol = snapCol(tryCol + step);
      }
      if (!placed) {
        occupy(c, Math.max(0, MATRIX_COLS - c.hitW), row);
      }
    });
  });
}

function rebuildMatrixFromPositions() {
  // no-op: occupancy is derived live from visible GridPositions
}

/** Place a restored course to the right of all courses on the same period-row band */
function placeToTheRight(course, preferredRow) {
  let row = preferredRow;
  if (row == null || row < 0) row = naturalRow(course);
  const periodOffset = (course.primaryPeriod - 1) % 4;
  const block = Math.floor(row / 4);
  row = block * 4 + periodOffset;
  row = Math.max(0, Math.min(MATRIX_ROWS - course.hitH, row));

  let maxEnd = 0;
  courses.forEach(c => {
    if (c === course || !isVisibleOnGrid(c) || !c.GridPosition) return;
    const r = courseRect(c);
    if (!r) return;
    if (r.row + r.h <= row || r.row >= row + course.hitH) return;
    maxEnd = Math.max(maxEnd, r.col + r.w);
  });

  let col = snapCol(maxEnd);
  if (col + course.hitW > MATRIX_COLS) col = Math.max(0, MATRIX_COLS - course.hitW);

  course.GridPosition = null;
  if (!canPlace(course, col, row)) {
    let found = false;
    const step = magnetStep || 1;
    for (let c = col; c <= MATRIX_COLS - course.hitW + 1e-9; c = snapCol(c + step)) {
      if (canPlace(course, c, row)) { col = c; found = true; break; }
    }
    if (!found) {
      for (let c = 0; c < col; c = snapCol(c + step)) {
        if (canPlace(course, c, row)) { col = c; found = true; break; }
      }
    }
    if (!found) col = maxEnd;
  }
  occupy(course, col, row);
}


function updateHiddenList() {
  const ul = document.getElementById("hidden-list");
  if (!ul) return;
  ul.innerHTML = "";

  const hidden = courses.filter(isHiddenCourse);
  if (hidden.length === 0) {
    const li = document.createElement("li");
    li.style.color = "#888";
    li.style.cursor = "default";
    li.textContent = "No hidden courses";
    ul.appendChild(li);
    return;
  }

  const byCode = (a, b) => (a.Code || "").localeCompare(b.Code || "");

  const specialTitles = {
    Prog: "Programming",
    TO: "Teaching & Outreach",
    Proj: "Projects"
  };
  // Sections: user-hidden, per-track, special categories, then no tags
  const sections = [
    {
      title: "Hidden by user",
      list: hidden.filter(c => c.Visibility === "Hidden").sort(byCode)
    },
    ...TRACK_TAG_KEYS.map(tag => ({
      title: tag + " track",
      list: hidden
        .filter(c => c.Visibility === "Automatic" && effectiveTagKeys(c).includes(tag))
        .sort(byCode)
    })),
    ...SPECIAL_TAG_KEYS.map(tag => ({
      title: specialTitles[tag] || tag,
      list: hidden
        .filter(c => c.Visibility === "Automatic" && effectiveTagKeys(c).includes(tag))
        .sort(byCode)
    })),
    {
      title: "Courses without tags",
      list: hidden
        .filter(c =>
          c.Visibility !== "Hidden" &&
          effectiveTagKeys(c).length === 0
        )
        .sort(byCode)
    }
  ];

  let any = false;
  sections.forEach(sec => {
    if (sec.list.length === 0) return;
    any = true;
    const group = document.createElement("div");
    group.className = "hidden-section";

    const title = document.createElement("div");
    title.className = "hidden-section-title";
    title.textContent = sec.title;
    group.appendChild(title);

    sec.list.forEach(c => {
      const li = document.createElement("li");
      li.textContent = `${c.Code} – ${c.displayName}`;
      li.title = "Left-click: description · Right-click: options";
      li.addEventListener("click", e => {
        e.stopPropagation();
        showDescription(c);
      });
      li.addEventListener("contextmenu", e => {
        e.preventDefault();
        e.stopPropagation();
        openHiddenContextMenu(e, c);
      });
      group.appendChild(li);
    });

    ul.appendChild(group);
  });

  if (!any) {
    const li = document.createElement("li");
    li.style.color = "#888";
    li.style.cursor = "default";
    li.textContent = "No hidden courses";
    ul.appendChild(li);
  }
}

function openHiddenContextMenu(e, course) {
  contextTargetHidden = course;
  const menu = document.getElementById("hidden-context-menu");
  menu.dataset.openedAt = String(Date.now());
  const restoreBtn = document.getElementById("hidden-restore-default");
  // Gray out "Restore default" when already Automatic
  restoreBtn.disabled = (course.Visibility === "Automatic");
  positionMenuInViewport(menu, e.clientX, e.clientY);
  // hide the main grid context menu if open
  document.getElementById("context-menu").style.display = "none";
}

/** Force onto the grid (Visibility = Visible), place to the right */
function makeHiddenCourseVisible(course) {
  const savedRow = course.GridPosition ? course.GridPosition.row : null;
  course.Visibility = "Visible";
  placeToTheRight(course, savedRow);
  renderCourses();
  updateHiddenList();
  showDescription(course);
}

/** Set Visibility back to Automatic; show on grid only if tags allow */
function restoreDefaultVisibility(course) {
  if (course.Visibility === "Automatic") return;
  const savedRow = course.GridPosition ? course.GridPosition.row : null;
  course.Visibility = "Automatic";
  if (isVisibleOnGrid(course)) {
    placeToTheRight(course, savedRow);
  }
  renderCourses();
  updateHiddenList();
  showDescription(course);
}

/* ============================================================
   PANEL WIDTHS (resizable + remembered)
   ============================================================ */
const PANEL_WIDTH_KEYS = {
  P_Choices: "panelWidth_Choices",
  P_Hidden: "panelWidth_Hidden",
  P_Description: "panelWidth_Description"
};
const PANEL_MIN_W = 180;
const PANEL_MAX_FRAC = 0.8;

function defaultPanelWidth() {
  return Math.round(window.innerWidth / 3);
}

function loadPanelWidth(panelId) {
  const maxW = Math.floor(window.innerWidth * PANEL_MAX_FRAC);
  try {
    const v = localStorage.getItem(PANEL_WIDTH_KEYS[panelId]);
    if (v) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= PANEL_MIN_W) return Math.min(n, maxW);
    }
  } catch (_) {}
  return Math.min(defaultPanelWidth(), maxW);
}

function savePanelWidth(panelId, px) {
  try {
    localStorage.setItem(PANEL_WIDTH_KEYS[panelId], String(Math.round(px)));
  } catch (_) {}
}

function applyPanelWidth(panelId) {
  const el = document.getElementById(panelId);
  if (!el) return;
  const w = loadPanelWidth(panelId);
  el.style.width = w + "px";
}

function setupPanelResizers() {
  ["P_Choices", "P_Hidden", "P_Description"].forEach(applyPanelWidth);

  document.querySelectorAll(".panel-resizer").forEach(handle => {
    handle.addEventListener("mousedown", e => {
      e.preventDefault();
      e.stopPropagation();
      const panelId = handle.dataset.panel;
      const side = handle.dataset.side; // "left" panel grows to the right; "right" grows to the left
      const panel = document.getElementById(panelId);
      if (!panel) return;

      handle.classList.add("dragging");
      // disable transition while dragging for snappy feel
      panel.style.transition = "none";

      const onMove = ev => {
        const maxW = Math.floor(window.innerWidth * PANEL_MAX_FRAC);
        let w;
        if (side === "left") {
          w = ev.clientX; // distance from left edge of viewport
        } else {
          w = window.innerWidth - ev.clientX;
        }
        w = Math.max(PANEL_MIN_W, Math.min(maxW, w));
        panel.style.width = w + "px";
      };

      const onUp = () => {
        handle.classList.remove("dragging");
        panel.style.transition = "";
        const finalW = panel.offsetWidth;
        savePanelWidth(panelId, finalW);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

function updateOverlaysVisibility() {
  const ch = document.getElementById("show-choices").checked;
  const hi = document.getElementById("show-hidden").checked;
  const de = document.getElementById("show-description").checked;

  // re-apply stored widths whenever panels are shown
  if (ch) applyPanelWidth("P_Choices");
  if (hi) applyPanelWidth("P_Hidden");
  if (de) applyPanelWidth("P_Description");

  document.getElementById("P_Choices").classList.toggle("visible", ch);
  document.getElementById("P_Hidden").classList.toggle("visible", hi);
  document.getElementById("P_Description").classList.toggle("visible", de);
}

/* ============================================================
   START
   ============================================================ */
init();

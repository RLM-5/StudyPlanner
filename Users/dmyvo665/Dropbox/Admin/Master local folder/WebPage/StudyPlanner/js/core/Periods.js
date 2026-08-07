/* ============================================================
   PERIODS — parsing, expansion, formatting
   Pure functions, no DOM, no mutable state
   ============================================================ */

import {
  PROJECT_COURSE_CODES,
  DEGREE_PROJECT_DEPTHS,
} from "./constants.js";

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
export function parsePeriodsField(raw) {
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
export function expandPeriodAlternatives(periods, activeIndex) {
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
export function numericPeriods(periods, activeIndex) {
  const exp = expandPeriodAlternatives(periods, activeIndex);
  return exp.alternatives[exp.activeIndex] || [1];
}

/** True if Periods already starts with "*" (properly formatted flexible course) */
export function periodsStartWithStar(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  return raw[0] === "*" || String(raw[0]).trim() === "*";
}

/**
 * Format a project course Periods as ["*", start, …, 4] so duration ends in period 4.
 * Duration = ceil(credits / 15).
 */
export function formatProjectPeriods(credits) {
  const n = Math.max(1, Math.ceil((Number(credits) || 15) / 15));
  const start = Math.max(1, 5 - n);
  const nums = [];
  for (let p = start; p <= 4; p++) nums.push(p);
  return ["*", ...nums];
}

/**
 * Infer season (autumn/spring) from course data and periods.
 * Fall = periods 1–2, Spring = periods 3–4
 */
export function parseSeasonFromData(data, periods) {
  const af = String(data.appliesFrom || "").toLowerCase();
  if (af.includes("spring") || af.startsWith("vt")) return "spring";
  if (af.includes("autumn") || af.includes("fall") || af.startsWith("ht")) return "autumn";
  const p0 = (periods && periods[0]) || 1;
  return p0 <= 2 ? "autumn" : "spring";
}

/**
 * Check if a course is a project course (degree project / thesis)
 */
export function isProjectCourse(data) {
  return PROJECT_COURSE_CODES.has(String(data.Code || ""));
}

/**
 * Year index from Depth + season (planner years −2…3):
 *  G1N, G1F-spring → −2
 *  G1F-autumn, G2F-spring → −1
 *  G2F (else), G2E, G1E → 0
 *  A1N, A1E, A1F-spring → 1
 *  A1F-fall, A2E → 2
 */
export function computeYearFromDepth(depth, season) {
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
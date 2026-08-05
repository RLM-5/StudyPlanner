# Study Planner — continuation handoff (for future agent sessions)

**Purpose:** Restore enough project state to continue development **without** re-reading the full chat. Point the new session at this file + the live `study-planner/` tree (and optionally the latest zip).

**Canonical live tree:** `/home/workdir/artifacts/study-planner/`  
**Latest release zip (as of this write):** `artifacts/study-planner-v0.33.zip`  
**Older zips (< v0.3):** `artifacts/zip-archive/`  
**APP_VERSION** in `js/app.js` and `<title>` in `index.html` must stay in sync with the latest zip label (currently **0.33**).

**There is no separate persistent agent memory across long gaps.** This markdown + the source tree **is** the handoff mechanism. Prefer updating this file after non-trivial batches of work.

---

## 1. What the product is

Client-side **Study Planner** for Uppsala University Master Programme in Physics (MaFy) and specialisations:

- Draggable course boxes on a multi-year period grid
- Track/tag filtering, hidden courses panel, “Your choices”, description panel
- JSON catalog + sparse layout configs (inheritance)
- Undo/redo, zoom, parity (odd/even calendar years), flexible periods, colour schemes

**Run for development (preferred):**

```bash
cd /path/to/study-planner
python3 -m http.server          # Windows may use: py -m http.server
# open http://localhost:8000
```

Auto-load tries `data/MasterProgramme.json` (which pulls `MaFyCourses.catalog.json` via `parents`).

**Offline / no server:** open `index.html` via `file://`. Auto-load fails. User must **Upload**:

1. First any `*.catalog.json` (e.g. `data/MaFyCourses.catalog.json`) — registers course data only  
2. Then a layout JSON (`MasterProgramme.json` or track file)

Multi-file select in one dialog also works (registry resolves parents from uploaded basenames).

---

## 2. File structure

```
study-planner/
  index.html          # shell: header, panes, help/disclaimer overlays, workspace
  css/main.css        # layout, gutter, boxes, menus, panels
  js/app.js           # almost all logic (~3.5k+ lines, single module)
  data/
    MaFyCourses.catalog.json   # type: course-catalog — full course records
    MasterProgramme.json       # type: planner-config — parents + overrides + UI state
    MP.json TP.json NP.json SE.json AS.json   # track-focused configs (same inheritance model)
    # Note: MC.json / GP.json may be absent; tracks MC/GP still exist as tags in UI
  docs/
    PLAN.md           # older phase notes (partially superseded)
    CONTINUATION.md   # THIS FILE — prefer for new sessions
```

Do **not** re-monolith into one HTML file. Modular structure is intentional.

---

## 3. Coordinate / geometry model (do not rewrite casually)

- Logical units: **column** and **row** (matrix space).
- Pixels: `col * FIVE_WIDTH`, `row * PERIOD_HEIGHT`.
- At 100% zoom: `BASE_FIVE_WIDTH = 80`, `BASE_PERIOD_HEIGHT = 48`.
- Zoom 50–150% scales FIVE_WIDTH / PERIOD_HEIGHT; rebuilds canvas; preserves viewport centre.
- **Course name font** scales with zoom only in **[75%, 125%]** (clamped outside).
- `MATRIX_COLS = 67`, `MATRIX_ROWS = 24` (years −2…3 × 4 periods), courses allowed from **col ≥ 2** (`LABEL_COLS = 2`).
- Extra scroll padding: left 16 cols, right 120, bottom 8 rows.
- **GridMatrix retired.** Collisions use **visible rectangles** (`courseRect` from `GridPosition` + `rWidth`/`rHeight` in column–row units).
- Snap steps: 1 / ½ / ¼ column (`magnetStep`); vertical period alignment still period-row based.
- Boxes may **draw** fractional width (`rWidth`); logical occupancy is the visible rect for hit-testing.

### Years and rows

- Academic years −2…3 map to row blocks of 4 (periods 1–4).
- Gutter shows Year N, Fall/Spring, period labels; thick lines get **calendar years** near Yr−2…Yr2 depending on **Master starts** year (default 2026).
- `YearParity`: `Any` | `Odd` | `Even` (calendar year of the relevant autumn/spring). Checkbox **Parity Issues** toggles red frame; snapping is **allowed** on wrong parity when unchecked highlighting only.

---

## 4. Data model

### 4.1 Catalog (`type: "course-catalog"`)

File: `data/MaFyCourses.catalog.json` (~129 courses).

Important fields (non-exhaustive):

| Field | Notes |
|-------|--------|
| Code | Primary key |
| Name, ShortName | ShortName auto-suggested if missing on import |
| Credits, Depth, Year | Year may be derived from Depth/period rules on import |
| Periods | See §5 |
| Tracks | Official pathways only: MP TP NP SE AS MC GP |
| Tags | **Disjoint** from Tracks (Prog, TO, Proj, etc.) |
| Main Field(s) | **Array of strings**; depth suffixes stripped for display |
| RelativeVal | `[n,0,0]` style; n used by Absolute layout |
| YearParity | Any / Odd / Even |
| About, Learning Outcomes, Content, … | Description body |
| Comments | Shown in description before Details |
| Course Link, Syllabus Link, Literature Link | Links section |
| Visibility, LabelMode, BoxColor, CanMove | Often overridden in configs |
| rWidth, rHeight | `"default"`/`"automatic"` or numeric; default formulas below |

**Default size formulas (when automatic):**

- `rHeight` from period span / cHeight conventions in code  
- `rWidth = Credits / nPeriods * FIVE_WIDTH/5`, floor at half FIVE_WIDTH for readability of codes  

Typo in source data: `Assesment` (keep as-is unless cleaning).

### 4.2 Config / layout JSON (`type: "planner-config"`)

- `"parents": ["MaFyCourses.catalog.json"]` (basename; also tried under `data/`)
- `courses`: sparse objects keyed by `Code` — **only overrides**
- Plus UI: `selected`, `activeTags`, `globalShowCode`, `colorScheme`, `ui` (scroll, panes, snap, layoutMode, masterStartYear, parityIssues, …), `panelWidths`

**Inheritance:** `resolveCoursePayload` deep-merges parent(s) then local overrides by Code. Any field can be overridden. Save writes a **full** usable payload (not sparse export of catalog).

### 4.3 Tags vs Tracks (critical)

- **Tracks** = university pathways: `MP TP NP SE AS MC GP` only  
- **Tags** = logical groups: `Prog`, `TO` (Teaching and Outreach), `Proj`, …  
- Must **not** intersect after `normalizeTracksAndTags`  
- **Filtering / colouring / hidden panel membership** use `effectiveTagKeys(course) = Tracks ∪ Tags`  
- Empty Tracks **and** empty Tags: Automatic visibility → **not** on grid (standalone until Visibility = Visible / Always visible)

Special colour/tag rules exist for Programming, Teaching, Projects, Intro, Deep Learning/Python/Mathematica, etc. Track colours are variables; right-click track checkboxes can recolour scheme (user absolute BoxColor wins).

---

## 5. Periods notation

| Form | Meaning |
|------|---------|
| `[1,2]` | Single span periods 1–2 |
| `[[2],[4]]` | Start in 2 **or** 4 (default first alt); badge `*` if flexible any-period style |
| `["*", 1, 2]` | Flexible / any period; recommended 1–2 |
| `[[4,1]]` | Cross year-boundary span |

`activePeriodAlt` stores chosen alternative. Description formatting: `1-3`, `2 or 4`, `Default is 1-2 but can be any`.

Project course codes (hardcoded list in app.js) get special period/year normalisation on import if not already `*`-formatted.

---

## 6. UI chrome (header rows)

Roughly four header lines:

1. Track/tag tickboxes (coloured backgrounds)  
2. Panes: Your choices | Hidden courses | Course Description  
3. Name+Code | Master starts (year dropdown) | Parity Issues | Zoom  
4. Snap | Layout mode | Remove gaps | Recompute Layout | Reset | Upload | Save | Help | Disclaimer  

**Layout modes:** Stack (pack left) | Absolute (RelativeVal column) | Auto without gaps / Remove gaps button.

**Reset** = restore **last successful Upload** snapshot (not undo stack).

**Undo/redo:** stack of full save payloads (max ~40); Ctrl/Cmd-Z; must **not** change pane open/close or (ideally) bulk scroll unless restoring snapshot scroll fields. History suspended during apply.

---

## 7. Panels

| Panel | Behaviour |
|-------|-----------|
| Your choices | Selected courses by year/period; Summary credits by Main Field(s)×Depth letter; **copy** button (modern layered-pages icon) |
| Hidden courses | Hidden by user, then by inactive track/tag sections; right-click restore visibility options |
| Description | Field visibility via right-click menu; sections ordered (position/technical, Meta, Entry requirements, Comments, Details, Links, …) |
| Gutter | Fixed to **browser left** under header; opaque; vertical scroll synced **immediately** to P_Bulk; thick/medium/thin lines right-aligned with different widths; calendar years on thick lines |

Panel widths: user-resizable; persisted (localStorage / save payload).

Pointer events: side panels semi-transparent overlays; bulk still receives interaction where designed (check CSS `pointer-events`).

---

## 8. Interaction rules (boxes)

- Drag with magnetic snap; aggressive **push-right** chain on overlap; locked courses block target or are jumped in chain  
- Click: description **only if description pane already open** (tickbox controls open state)  
- Right-click menu: Select (checkmark), Hide (disabled if selected), Always visible, Lock position, Label mode (Automatic / Name / Name+Code), Style colours, …  
- Hide renames old “Remove from view”; toggles off Always visible  
- Right-click in Your choices → deselect  

Badges top-right (muted grey): `*` flexible periods; `odd`/`even` for YearParity.

---

## 9. Load / save / offline

- `localJsonRegistry`: maps basename → parsed JSON from Upload (session)  
- `fetchJsonRelative`: registry first, then HTTP `data/…`  
- Aliases: `MaFyCourses.json` ↔ `MaFyCourses.catalog.json`  
- Missing parent alert (user-facing): *You must load any \*.catalog.json first; after that other JSON files will work.*  
- Save: prefer `showSaveFilePicker`, fallback download  

**Main Field(s)** in catalog were last bulk-updated from `CoursesPerTrack.xlsx` column **MainFields** only (merge across sheets by Code). Configs do not store that field → no config edit required.

---

## 10. Key functions in `js/app.js` (orientation)

| Area | Functions |
|------|-----------|
| Zoom | `applyZoom`, `nameFontZoomFactor` |
| Periods | `parsePeriodsField`, `expandPeriodAlternatives`, `formatPeriodsForDescription` |
| Inheritance | `resolveCoursePayload`, `deepMergeCourse`, `fetchJsonRelative`, `registerLocalJson` |
| Visibility | `effectiveTagKeys`, `isVisibleOnGrid`, `normalizeTracksAndTags` |
| Collision | `courseRect`, `canPlaceAt`, `tryPushAndPlace`, … |
| Layout | `recomputeLayout` / stack / absolute / remove gaps |
| History | `pushHistory`, undo/redo apply with `historySuspended` |
| UI lists | `updateChoicesList`, `updateHiddenList`, description builders |
| Import normalise | `normalizeImportedCourse`, year from depth, RelativeVal, short names |

`getMainFieldsList` / `stripDepthSuffixFromField` must remain **top-level** (load path calls them; missing caused runtime errors historically).

---

## 11. Versioning policy

- Zip name: `study-planner-v0.XX.zip` under `artifacts/`  
- Increment by **0.01** unless user specifies otherwise  
- Zips **below 0.3** live in `artifacts/zip-archive/`  
- Keep prior zips; replace only the **unarchived** `study-planner/` tree with the working copy  
- Bump `APP_VERSION` + document title together  

---

## 12. Known pitfalls / regressions to avoid

1. **Gutter scroll:** must be sibling of bulk, single `translateY(-scrollTop)` — never nested double scroll.  
2. **Undo** must not toggle pane visibility; scroll restore from snapshot only.  
3. **Context menu** checkmarks: CSS `.on::before` only — never also set text “✓” (double marks).  
4. **Hide** disabled while selected.  
5. **Tags/Tracks split:** filter via union; JSON fields stay separate; no reintroduction of track codes into Tags.  
6. **Description click** must not open the pane.  
7. **file://** parent fetch fails without prior catalog upload.  
8. Safari control-click menus need grace period / stopPropagation.  
9. Medium/thin horizontal lines extend to col ≈ −2; thick lines full width.  

---

## 13. Recent intentional product decisions (do not “fix” without asking)

- Catalog extension style: **`*.catalog.json`**, not a proprietary non-JSON type  
- Empty Tracks+Tags allowed; Automatic ⇒ hidden until explicit Visible  
- Parity: soft warning via checkbox, not hard block (user reversed hard block)  
- Save state includes colours, visibility, label mode, UI, etc.  
- Disclaimer + Help overlays; Help text kept short (no long Snap/Layout essay)  

---

## 14. How the human wants to work

- Prefer **edit existing files**, not regenerate from scratch  
- After multi-step batches: summary + **zip** of whole `study-planner/`  
- British English for user-facing prose when polishing  
- Chat may go quiet for **weeks**; this file is the recovery path  

**Suggested first message in a new thread:**

> Continue Study Planner from `study-planner/docs/CONTINUATION.md` and tree under `artifacts/study-planner/` (version 0.33). [task…]

---

## 15. Quick verification checklist after changes

- [ ] `node --check js/app.js`  
- [ ] Serve folder; MasterProgramme auto-loads with full course bodies  
- [ ] file:// : catalog upload then layout upload works  
- [ ] Drag push-right; lock blocks; undo of move  
- [ ] Track tick shows/hides; Tags/Tracks still disjoint in JSON  
- [ ] Description sections + Main Field(s) list display  
- [ ] Gutter scroll 1:1, opaque, left-edge fixed  
- [ ] Version string matches zip  

---

*Last updated for release **v0.33** (catalog rename, offline messaging, Main Field(s) from CoursesPerTrack.xlsx column H). Extend this changelog section when shipping the next zip.*
'''
Path("/home/workdir/artifacts/study-planner/docs/CONTINUATION.md").write_text(open("/home/workdir/artifacts/study-planner/docs/CONTINUATION.md").read() if False else """

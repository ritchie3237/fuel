---
name: verify
description: How to build/launch/drive this repo's static HTML apps for verification.
---

# Verifying this repo

This repo is a collection of self-contained static HTML pages (no build, no server).
Open them directly with `file://` URLs in the preinstalled Chromium via Playwright.

## Launch

```bash
cd <scratchpad> && npm install playwright   # browsers are preinstalled, no download
node -e "..." # executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
```

Note: the generic `/opt/pw-browsers/chromium` path is a marker file, not a directory —
use the versioned `chromium-<rev>/chrome-linux/chrome` binary.

## Gotchas learned

- `ravensburger-shelf-planner.html` persists the working state in localStorage key
  `rvShelfPlanner6`, and a named **project library** (history) under `rvProjects6`
  (`{id:{name,snap,savedAt,accessedAt}}`; `saveProjectToLibrary`/`openProjectFromLibrary`).
  Uploading a new order never touches `rvProjects6`, and offers to save unsaved work first
  (`guardUnsavedBeforeReplace`). Run `localStorage.clear(); location.reload()` before asserting.
- `rv-front-image-filler.html` writes the Front column as `<f>_xlfn.IMAGE("url","alt")</f>` —
  the `_xlfn.` prefix is REQUIRED for post-2007 functions (without it Excel shows `=@IMAGE`/
  `#NAME?`). German Excel renders/evaluates it as `=BILD(…)`.
- Per-shelf blende (fascia) config lives in `shelfBlende` keyed by shelf id; icons are
  inline white SVGs by category (kids/toddler/metime/fan/games/explorers/flora), and the
  Special Offer category renders as a red gradient panel (all others blue). The blende
  editor has an explicit icon/category picker (7 categories per Nina's Übersicht PDF); an
  explicit `kind` in shelfBlende wins over the theme-name guess. Import splits products by
  sheet-tab name → matching theme; a single unmatched tab lands on the SOLE theme area when
  only one exists (Nina's "one Kids shelf" flow), else the active theme. Front/side/open map
  to labelled columns (front→J, side→K, open→L); Front never borrows the Side image when a
  Front column exists. NB: real Ravensburger files store the Front (J) photo as an Excel
  "image in cell" rich value (cell `vm=` → metadata.xml futureMetadata → rdrichvalue.xml →
  rdRichValueWebImage.xml blip → media), NOT a drawing anchor — the reader resolves that
  chain; Side (K) photos are ordinary floating drawings. Test file: scratchpad NZ2.xlsx.
- HTML5 drag-and-drop tests: use a viewport tall enough that the whole page fits
  (e.g. 1500×2100). If Playwright scrolls mid-drag, the dragstart hit-tests against
  the post-scroll element and grabs the wrong block — a harness artifact, not an app bug.
- Validate the app's .xlsx exports with `pip3 install openpyxl` + `load_workbook`,
  and `unzip -t` for zip integrity.

## Flows worth driving (shelf planner)

Demo auto-loads on first boot. Drive: held-aside dims form → block click editor →
drag between levels → Export Excel / Export PNG downloads → reload (persistence) →
CSV import with German headers/semicolons/mm units → junk-file error path →
Top100 CSV (stars + eye-level) → shrink level heights (unplaced list).

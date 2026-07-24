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

- `ravensburger-shelf-planner.html` persists state in localStorage key `rvShelfPlanner5`;
  run `localStorage.clear(); location.reload()` for a fresh boot before asserting.
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

# Ravensburger Shelf Planner — Handoff

**Owner (through mid-2026):** Mike Ritchie (Head of AI Transformation) — going on paternity leave.
**End user / stakeholder:** Nina Zimmerer (Nina.Zimmerer@ravensburger.de), category management. She is the person who tests each build and sends feedback; she is the benchmark for "is this right."
**Repo:** `github.com/ritchie3237/fuel` · **Working branch:** `claude/ravensburger-shelf-planner-m29m21`

This document is the single place to pick up the project. Read it top to bottom once; after that the code and the `verify` skill are enough.

---

## 1. What this project is

Nina's team plans true-to-scale **retail shelf planograms** for Ravensburger toy ranges (BRIO Flora, Tiptoi, etc.) and hands the result to store-stocking teams. Two problems were solved, as **two separate, self-contained tools**:

| Tool | File | Job |
|---|---|---|
| **Shelf Planner** | `ravensburger-shelf-planner.html` | Takes a product/order Excel → generates a scale planogram + an editable Excel shelf assignment, applying Ravensburger merchandising rules. |
| **Front-Image Filler** | `rv-front-image-filler.html` | Fills the "Front view" column of an order Excel with each product's front pack shot automatically (from a public CDN link derived from the EAN). |

**Design constraint that governs everything:** each tool is a **single, self-contained HTML file**. No build step, no server, no dependencies, no network at runtime. Nina saves the file and double-clicks it; it runs offline in her browser and her data never leaves her machine. Keep it that way — it's a hard requirement (corporate/data-privacy driven).

---

## 2. Tool A — Shelf Planner (`ravensburger-shelf-planner.html`)

### What it does
- Loads an **order Excel** (`.xlsx`) or CSV: EAN, article no., title, order qty, package W×H×D, category, and product photos.
- Splits products into **theme areas** (BRIO Flora, Toddler, Kids, …), each mapped to a set of numbered **store shelves** built from **shelf templates** (fixture width, level heights, plinth, blende/fascia).
- **Auto-arranges** each shelf to Nina's "consistent look": up to **2 different products face-out in the centre**, everything else turned **sideways** on the left/right to fill the shelf; up to 2 identical facings; larger / higher-value / Top-100 items pushed to eye level (~140 cm). Manual edits (drag, duplicate, change view/facings) are preserved and never re-arranged.
- Renders a **true-to-scale** planogram (wood-look shelves, per-shelf coloured **blende** header with category icon) and lets the user **drag/duplicate/edit** blocks.
- Exports an **editable Excel** shelf-assignment workbook and a **PNG/print** planogram.
- Persists to `localStorage` (key `rvShelfPlanner6`) and can **save/load a project file** per store.

### Architecture (all in the one file, one `<script>`)
- **Custom XLSX reader** (`readXlsx`, ~line 1300–1470): parses the zip via `DecompressionStream('deflate-raw')` + `DOMParser`. Reads sheet grids, shared strings, sheet tab names, and **two kinds of embedded images** (see §4 — this is the subtle part).
- **Custom XLSX writer**: builds a valid `.xlsx` from scratch (zip + CRC32, inline strings, OOXML) for the export.
- **Data model:**
  - `products[]` — each has `article, ean, title, qty, w/h/d, price, category, img (front), imgSide, imgOpen, selTheme, star, …`.
  - `templates[]` — fixture definitions (`widthCm, plinthCm, blendeCm, levelsTop[]`).
  - `shelves[]` — numbered shelves, each `{num, templateId, theme}`. **Themes are defined by the distinct `theme` values across shelves** (`themeNames()`).
  - `layouts{}` — per-theme computed placement; `shelfBlende{}` — per-shelf header config `{text, kind, blank}`.
  - **View lives per placement (block), not per product** — the same product can be front on one shelf and side on another.
- **Placement algorithm** (`generate()`, ~line 540): centre/sides packing, eye-level priority, fills shelves one at a time, reports anything that doesn't fit as "unplaced."
- **Per-shelf blende** (`blendeForShelf`, `themeKind`, `themeIconSvg`, `themeColor`, ~line 386–425): white inline-SVG category icons (kids/toddler/metime/fan/games/explorers/flora), red gradient for Special Offer, blue otherwise. Editor at `openBlendeEditor` lets the user pick icon/category, custom text, or a plain panel — **per shelf, independently**.

### Version history (what each round fixed)
The commit log on the branch is the detailed record. High level:
- **v1–v3** — initial app, BRIO Flora pilot, photos on shelves, aligned to Nina's prototype + real data.
- **v4/v4.1** — restructured around store shelves & theme areas per her brief; handled her real 246 MB Tiptoi order file.
- **v5/v5.1** — centre/sides layout, per-placement views, project save/load, shelf-like visual polish.
- **v6** — Nina's July-21 feedback: theme split by tab, J/K/L image columns, per-shelf blende icons.
- **v7 (current)** — fixes verified against her **real** Tiptoi file. This is the important one; see §4.

### Current known-good behaviour (verified v7)
- Front/side images map to labelled columns: **Front → column J, Side → column K, Open → column L**. Front never borrows the side image.
- A single-tab order whose tab name matches no theme lands entirely on the **sole** theme area if only one exists (Nina's "I made only a Kids shelf" flow); otherwise the active theme.
- Per-shelf blende with correct icons; Special Offer red.

---

## 3. Tool B — Front-Image Filler (`rv-front-image-filler.html`)

### Why it exists
Nina needs product images **inside** her order Excel — **front in column J, side in column K** — but pulling them from PIM one item at a time (via the PIM/MAM Office add-in, a mix of link + manual) is far too slow. She asked whether an "AI-generated link" could insert them automatically.

### The key discovery
Every product's **front pack shot** is published at a **fixed, public, tokenless CDN address** built from the 5-digit article number inside the EAN:

```
EAN 4005556 00168 2   →   https://cdn.ravensburger.de/images/produktseiten/240/00168.jpg
              ^^^^^  = article number (EAN digits 8–12)
```
(`240` is a fixed size bucket; 120/480/960 return 404.) This is confirmed against Nina's file for every item.

### What the tool does
Load an order `.xlsx` → for each row whose EAN is a `4005556…` article, it writes `=IMAGE("<cdn url>")` into the **Front view** column, and hands the file back. Opened in **Excel 365 with internet**, the front picture appears in each cell. The **Side column K and everything else** (side-image drawings, rich data, the PIM add-in, styles) are copied through untouched. Same zip reader/writer + EAN→article logic as the shelf planner.

### The half that is NOT solved (and why) — important
The clean **side/spine** shot (`…_RIGHT_FLAT.tif`) is **not** on the public CDN. It lives only in **PIM/ContentServ**, and its URL carries an internal asset-ID hash **plus an expiring auth token** (`CSToken=…`). So it **cannot** be derived from the EAN, and a copied link stops working. To automate the side column too, PIM must expose **one thing**: a **stable/permanent delivery URL by EAN + view type** (e.g. `…/ImageServer.php?ean=…&view=RIGHT_FLAT`, no expiring token). If they provide that, extend this tool to fill column K exactly like J. This is a small, specific PIM request — not a full PIM project. See the "PIM pictures" email thread.

---

## 4. The single most important technical gotcha: two image systems

Real Ravensburger order files store the two views in **two completely different OOXML mechanisms**, and any code touching these files must handle both:

1. **Front (column J)** = Excel **"image in cell" rich values.** The cell holds `#VALUE!` with a `vm=` (value-metadata) attribute. The picture is resolved through a chain:
   `cell vm=` → `xl/metadata.xml` `futureMetadata[XLRICHVALUE].bk[vm-1]` → `rvb i` → `xl/richData/rdrichvalue.xml` `rv[i]` first `<v>` = web-image id → `xl/richData/rdRichValueWebImage.xml` `webImageSrd[id]` `<blip r:id>` → `…/_rels/…rels` → `xl/media/…`.
   (The `<address r:id>` in the same entry is the **public CDN URL** — that's where Tool B's discovery came from.)
2. **Side (column K)** = ordinary **floating drawing anchors** (`xl/drawings/drawing1.xml`, `twoCellAnchor`, all in col 10).

The earlier shelf-planner builds only read #2, so Front had no image and fell back to the Side one — that was the long-standing "Front shows the side photo" bug. v7's reader resolves chain #1 as well. If you ever see images "missing" from a real file, this is the first place to look.

---

## 5. How to develop & verify

There is no build. Edit the HTML, open it in a browser. For automated checks the repo ships a **`verify` skill** (`.claude/skills/verify/SKILL.md`) with the exact gotchas.

- **Syntax check** (fast): extract each `<script>` and `new Function(...)` it in Node.
- **Drive it headlessly** with the pre-installed Chromium via Playwright:
  `executablePath: /opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
  Always `localStorage.clear(); location.reload()` before asserting. Use a tall viewport for drag tests.
- **Validate `.xlsx` output** with Python `openpyxl` + `unzip -t`.
- **Read `.xlsx` internals / rich images** with the Python snippets used in this project (unzip the file, inspect `xl/worksheets/sheet1.xml`, `xl/richData/*`, `xl/drawings/*`).
- **Render a supplied PDF** (Nina's icon overview) with `pymupdf` (`fitz`) — it's an image-based InDesign export, so text extraction is useless; render the page to an image and read it.

Test material: the shelf planner has a **built-in Flora demo** (loads on first boot) and a **"Download order template"** button — both are safe, non-confidential ways to exercise it. Nina's real files are internal Ravensburger data (product names, EANs, dimensions, images) — see §7 before putting them anywhere shared.

---

## 6. Open items / decisions pending

1. **Theme-per-tab behaviour (waiting on Nina).** Current: a single unmatched tab lands on the sole theme area if only one exists, else the active theme. The open question put to her: should each Excel **tab** instead **auto-create its own named area** (a "tiptoi" tab → a "tiptoi" area)? Both are easy; implement whichever she prefers. (Asked in the shelf-planner reply email.)
2. **Side-image automation (waiting on PIM).** Needs the stable per-EAN+view delivery URL from ContentServ (§3). Once available, extend `rv-front-image-filler.html` to fill column K.
3. **`=IMAGE()` round-trip nuance.** A file freshly filled by Tool B holds *formulas*, not embedded bytes. The **shelf planner won't show those front images** until Nina opens the filled file in Excel and **saves** it (Excel then bakes the pictures into rich values, which the planner reads). Worth telling her explicitly if she chains the two tools.
4. **No formal tests.** Verification is manual/Playwright. If this grows, a small Playwright suite would be the natural next step.

---

## 7. Communication & where things live

- **Email threads (Nina ⇄ Mike):** in Gmail. Recent subjects: *"Shelf Planner v5 — your latest feedback…"* (planogram feedback rounds) and *"PIM pictures"* (the image-in-Excel ask). Nina forwards feedback; Mike relays builds. Draft replies for both were prepared and are in the Drafts folder.
- **Delivery to Nina:** always the single HTML file(s) as an email attachment. She does **not** use GitHub.
- **The colleague taking over** works from this repo/branch + this doc.
- **Nina's real test files** (`Tiptoi_Order_example_NZ*.xlsx`, the `Übersicht_Maße` icon PDF, the 246 MB full Tiptoi order) are **Ravensburger-internal**. They were used locally for verification and are **not committed** to the repo. If the colleague needs them, get them from Nina directly — do not push customer data to GitHub.

---

## 8. Quick start for the colleague

1. Clone the repo, check out `claude/ravensburger-shelf-planner-m29m21`.
2. Open `ravensburger-shelf-planner.html` in a browser — the Flora demo auto-loads. Click around: load the template, drag a block, export Excel/PNG.
3. Open `rv-front-image-filler.html` — pick any order `.xlsx` with `4005556…` EANs and download the filled result.
4. Read §2, §3, and **§4** (the two-image-systems gotcha).
5. Skim the commit log for the feedback history; read the `verify` skill before making changes.
6. Pending work is in §6. Nina is the decision-maker on behaviour; PIM is the blocker on side images.

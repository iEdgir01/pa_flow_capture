# Technical context

## Overview

This is a Firefox MV3 extension. It captures the Power Automate / Power Apps
flow designer canvas tile-by-tile and stitches the tiles into one PNG. It
has no backend, no build tooling, and no dependencies — plain JS across 4
runtime files.

## Stack

- Manifest V3 (Firefox `browser_specific_settings.gecko`, `strict_min_version: 120.0`)
- `background.js`: a `"type": "module"` background script (service-worker-style
  in Firefox MV3). It owns `tabs.captureVisibleTab`, `OffscreenCanvas`
  stitching, and `downloads.download`.
- `content.js`: injected into `all_frames: true` at `document_idle` on PA
  maker-portal URLs. It owns canvas detection, the anchor UI, the
  scroll-and-capture loop, and per-tile crop dispatch.
- `popup.js` / `popup.html`: a minimal start/cancel UI. It routes messages
  to whichever frame won the capture-owner claim.
- Permissions: `activeTab`, `scripting`, `downloads`, `webNavigation`.
  Host permissions are restricted to `make.powerautomate.com` and
  `make.powerapps.com`.
- There is no package.json and no build step. Packaging uses `npx web-ext build`.

## Architecture

This is a message-passing flow. All messages use
`browser.runtime.sendMessage` or `browser.tabs.sendMessage`.

1. The user clicks the popup. The popup sends `broadcast-activate` to the
   background script. The background script resets tab zoom to 100% if
   auto-zoom is checked, then sends `activate` to every frame.
2. Each frame's `content.js` runs `detectCanvas()`. This function scores
   scrollable elements by area and overflow style. Each frame sends a
   `claim` message with its canvas score.
3. The background script races the claims per `tabId:runId` key, within a
   150ms window. It picks the highest-scoring frame. Ties break toward the
   deeper `frameId`. The winning frame is stored in `captureOwnerByTab`. The
   background script responds `{claimed: true}` to the winner only.
4. The winning frame shows the overlay bar. The user Ctrl+clicks Point A,
   then Point B, on the canvas. `computeAndShowRegion()` derives the tile
   grid (columns and rows) with a 10% overlap step.
5. `runCapture()` in content.js loops over tiles. For each tile: scroll the
   canvas, wait for it to settle, send a `capture` message, and the
   background script calls `tabs.captureVisibleTab()`. The content script
   does not crop the tile itself — it ships the crop rect to the background
   script via `stitch-tile` messages.
6. The background script's `drawStitchTile()` draws each tile onto a
   running `OffscreenCanvas`. It applies grayscale-SAD seam matching for
   non-first columns. A `stitch-finish` message then calls
   `finalizeStitchSession()`, which trims the header band (`excludeBox`)
   and downloads the PNG.

## Run / test

- Dev: open `about:debugging#/runtime/this-firefox`, click Load Temporary
  Add-on, and select `manifest.json`. No build is required.
- Package: run `npx web-ext build` from the repo root. See
  `published-versions/` for prior output, for example
  `pa_flow_capture_V1.0.1.zip`.
- No automated test suite exists. Validation is manual (see the AGENTS.md
  Debugging priorities and Validation checklist). Run a real capture against
  a live PA flow. Check that trigger and action cards are not clipped.
  Check the seams. Open the downloaded PNG.

## Gotchas

- **Debug flags default off.** Do not flip them in committed code. In
  `content.js`: `PA_CAPTURE_DEBUG_RAW_TILES`, `PA_CAPTURE_DIAG_LOG`,
  `PA_CAPTURE_USE_MAIN_FRAME_METRICS`, `PA_CAPTURE_RECALC_SCALE_EACH_TILE`,
  and various `PA_CAPTURE_DEBUG_DOWNLOAD_*_ONCE` flags. In `background.js`:
  `PA_CAPTURE_DIAG_LOG` defaults to `true` there. Verbose background
  console logging is the extension's normal state, unlike in `content.js`.
- **`PA_CAPTURE_GUIDE_LAYER_SELECTORS`** in `content.js` is deliberately
  narrow (`[class*="guideline"]` only). A comment warns that broader
  alignment, snap, or guide class-substring selectors break normal PA
  layout, because flex alignment reuses those substrings. Add new selectors
  only after you verify the exact class in DevTools.
- **`fetch(data:...)` is unreliable in the Firefox extension background.**
  For this reason, `dataURLToBlob()` decodes base64 manually instead of
  using `fetch`.
- **`window.devicePixelRatio` is unreliable in embedded or zoomed PA
  frames.** Scale is instead measured via `get-tab-capture-metrics`
  (`scripting.executeScript` in the main frame) plus `visualViewport`, with
  a fallback chain: `visualViewport` to `innerWidth`/`innerHeight` to
  `clientWidth`/`clientHeight`.
- Frame ownership races last only 150ms. If PA's designer iframe loads
  slowly, the claim can pick the wrong (smaller or placeholder) frame. The
  canvas score weighting exists specifically to reduce this risk.
- Auto-zoom applies a CSS `zoom` style on `documentElement`, restored after
  capture or cancel. This is a whole-page effect, not centered on the
  anchors.

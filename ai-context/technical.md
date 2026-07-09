# Technical context

## Overview

Firefox MV3 extension. Captures the Power Automate/Power Apps flow designer
canvas tile-by-tile and stitches into one PNG. No backend, no build tooling,
no dependencies — plain JS across 4 runtime files.

## Stack

- Manifest V3 (Firefox `browser_specific_settings.gecko`, `strict_min_version: 120.0`)
- `background.js`: `"type": "module"` background script (service-worker-style
  in Firefox MV3), owns `tabs.captureVisibleTab`, `OffscreenCanvas` stitching,
  `downloads.download`.
- `content.js`: injected into `all_frames: true` at `document_idle` on PA
  maker-portal URLs. Owns canvas detection, anchor UI, scroll+capture loop,
  per-tile crop dispatch.
- `popup.js` / `popup.html`: minimal start/cancel UI, routes messages to
  whichever frame won the capture-owner claim.
- Permissions: `activeTab`, `scripting`, `downloads`, `webNavigation`.
  Host permissions restricted to `make.powerautomate.com` and
  `make.powerapps.com`.
- No package.json, no build step. Packaging is `npx web-ext build`.

## Architecture

Message-passing flow (all via `browser.runtime.sendMessage` /
`browser.tabs.sendMessage`):

1. Popup click → `broadcast-activate` to background → background resets tab
   zoom to 100% if auto-zoom checked, then sends `activate` to every frame.
2. Each frame's `content.js` runs `detectCanvas()` (scores scrollable
   elements by area + overflow style) and sends a `claim` message with its
   canvas score.
3. Background races claims per `tabId:runId` key (150ms window), picks the
   highest-scoring frame (ties broken toward deeper `frameId`), stores it in
   `captureOwnerByTab`, responds `{claimed: true}` to the winner only.
4. Winning frame shows the overlay bar, user Ctrl+clicks Point A then Point B
   on the canvas → `computeAndShowRegion()` derives tile grid (cols/rows with
   10% overlap step).
5. `runCapture()` in content.js loops tiles: scroll canvas → dwell/settle →
   `capture` message → background `tabs.captureVisibleTab()` → content crops
   nothing itself, ships crop rect to background via `stitch-tile` messages.
6. Background `drawStitchTile()` draws each tile onto a running
   `OffscreenCanvas`, applying grayscale-SAD seam matching for non-first
   columns, then `stitch-finish` → `finalizeStitchSession()` trims header
   band (`excludeBox`) and downloads the PNG.

## Run / test

- Dev: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
  select `manifest.json`. No build required.
- Package: `npx web-ext build` from repo root (see `published-versions/` for
  prior output, e.g. `pa_flow_capture_V1.0.1.zip`).
- No automated test suite exists. Validation is manual (see AGENTS.md
  Debugging priorities / Validation checklist): run a real capture against a
  live PA flow, check trigger/action cards aren't clipped, check seams, open
  the downloaded PNG.

## Gotchas

- **Debug flags default off** — do not flip in committed code. In
  `content.js`: `PA_CAPTURE_DEBUG_RAW_TILES`, `PA_CAPTURE_DIAG_LOG`,
  `PA_CAPTURE_USE_MAIN_FRAME_METRICS`, `PA_CAPTURE_RECALC_SCALE_EACH_TILE`,
  various `PA_CAPTURE_DEBUG_DOWNLOAD_*_ONCE`. In `background.js`:
  `PA_CAPTURE_DIAG_LOG` (defaults `true` there — verbose background console
  logging is the extension's normal state, unlike content.js).
- **`PA_CAPTURE_GUIDE_LAYER_SELECTORS`** in content.js is deliberately narrow
  (`[class*="guideline"]` only) — a comment warns broader alignment/snap/guide
  class-substring selectors break normal PA layout (flex alignment reuses
  those substrings). Only add selectors after verifying the exact class in
  DevTools.
- **Firefox `fetch(data:...)` unreliable** in extension background — hence
  `dataURLToBlob()` manually decodes base64 instead of `fetch`.
- **`window.devicePixelRatio` unreliable in embedded/zoomed PA frames** —
  scale is instead measured via `get-tab-capture-metrics` (`scripting.executeScript`
  in the main frame) plus `visualViewport`, with fallback chain
  vv → innerWidth/Height → clientWidth/Height.
- Frame ownership races only last 150ms; if PA's designer iframe loads slowly
  the claim can pick the wrong (smaller/placeholder) frame — canvas score
  weighting exists specifically to reduce this.
- Auto-zoom applies a CSS `zoom` style on `documentElement`, restored after
  capture/cancel — not centered on anchors, whole-page effect only.

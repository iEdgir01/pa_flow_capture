# AGENTS.md - PA Flow Capture

Guidance for AI coding agents working in this repository.

## Scope

This repo contains only the Firefox extension for capturing and stitching Power Automate flow screenshots.

Core runtime files:

- `manifest.json`
- `popup.html`
- `popup.js`
- `content.js`
- `background.js`

## Architecture summary

- `popup.js` starts capture, passes dwell/zoom options, and routes commands to the winning frame.
- `content.js` runs in all frames, claims ownership, detects the scrollable flow canvas, places anchors, scrolls/captures tiles, and streams tile metadata.
- `background.js` captures visible tab bitmaps, stitches tiles on `OffscreenCanvas`, applies seam logic, and downloads the final PNG.

## Editing rules

1. Keep changes minimal and focused on capture correctness.
2. Do not add build tooling unless explicitly requested.
3. Keep extension permissions minimal in `manifest.json`.
4. Preserve frame-claim routing behavior (`all_frames` plus owner frame dispatch).
5. Keep capture and stitch responsibilities split (`content.js` vs `background.js`).
6. Avoid introducing page-injected bridge scripts unless essential to runtime behavior.

## Debugging priorities

When investigating capture defects, check in this order:

1. Canvas/scroll element detection in `content.js`.
2. Crop rectangle mapping from CSS space to screenshot pixel space.
3. Tile placement coordinates in `background.js`.
4. Seam logic (alignment and overlap cuts).
5. Timing issues (dwell/settle delays).

## Validation checklist

After substantive edits:

1. Load temporary add-on in Firefox and run a real capture test.
2. Verify trigger and action cards are not clipped.
3. Verify seams between columns/rows do not introduce missing blocks.
4. Confirm downloaded PNG opens and has expected resolution.

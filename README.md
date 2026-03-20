# PA Flow Capture

Firefox extension for capturing large Power Automate flows as one stitched PNG.

## What it does

- Detects the flow designer canvas in Power Automate / Power Apps maker pages.
- Lets you place two anchor points (`Ctrl+click`) to define capture bounds.
- Scrolls the canvas tile-by-tile and captures with dwell/settle timing.
- Crops each raw tab screenshot to the flow viewport before stitching.
- Stitches in the background (`OffscreenCanvas`) and downloads one PNG.
- Uses horizontal seam matching (grayscale SAD) to reduce column join artifacts.
- Supports optional auto-zoom to normalize tab zoom to 100% before capture.

## Project layout

- `manifest.json` - Firefox extension manifest (MV3).
- `popup.html` / `popup.js` - popup UI and start/cancel flow.
- `content.js` - canvas detection, anchor placement, tile capture loop.
- `background.js` - tab capture, stitch pipeline, seam logic, download.
- `icons/` - extension icons.

## Run locally (Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on...**
3. Select this repo's `manifest.json`
4. Open a Power Automate flow and run capture from the extension popup

## Packaging

From this directory:

```bash
npx web-ext build
```

## Notes

- No build step is required for development.
- If capture alignment is off, increase dwell in the popup and retry.
- Enable diagnostic constants in `content.js` / `background.js` only when debugging.

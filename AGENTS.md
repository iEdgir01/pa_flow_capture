# AGENTS.md - PA Flow Capture

Guidance for AI coding agents working in this repository.

## Project overview

Firefox MV3 extension (`manifest.json` v1.0.1) that captures a Power Automate /
Power Apps maker-portal flow designer canvas — which can be far larger than one
screen — as a single stitched PNG. User Ctrl+clicks two anchor points on the
canvas to define capture bounds, the extension scrolls the canvas tile-by-tile
(`content.js`), captures each tile via `tabs.captureVisibleTab` and stitches
them on an `OffscreenCanvas` with horizontal seam-matching to hide column
joins (`background.js`).

Host permissions are scoped only to `make.powerautomate.com` and
`make.powerapps.com`. No build step; loaded as a temporary add-on for dev, or
packaged with `web-ext build` for release.

## Current status

- Latest packaged release: `published-versions/pa_flow_capture_V1.0.1.zip`
  (Mar 20), matching `manifest.json` version `1.0.1`.
- Repo history (7 commits) shows an initial feature commit followed
  entirely by hardening/fix commits: AMO data-collection consent schema,
  removing unsafe `innerHTML` in the precision cursor overlay, icon cleanup.
  No new capture features have landed since v1.0.1 — the project is in a
  stabilization/maintenance phase, not active feature development.
- Working tree is clean except `ai-context/` (untracked — this session's
  scaffolding work).
- Numerous debug/diagnostic constants exist in both `content.js` and
  `background.js` (see Gotchas in `ai-context/technical.md`) — all currently
  `false`/off for normal use.

## Key decisions

- **Frame-claim race for iframe ownership**: PA embeds the flow designer in a
  same- or cross-origin iframe. Because `content_scripts.all_frames: true`
  injects into every frame, `background.js` runs a short-timeout "claim" race
  (`captureClaims` map, 150ms timer) so exactly one frame — scored by
  detected canvas size — becomes the capture owner. Popup and later messages
  route to that owner frame only (`captureOwnerByTab`). This avoids duplicate
  overlays and wrong-frame state.
- **Crop math done in background, not content script**: Firefox content
  scripts had issues with canvas/`toDataURL` on captured tab screenshots, so
  cropping/stitching happens in `background.js` off `OffscreenCanvas`
  (module-type background script, MV3).
- **Seam matching over fixed overlap**: tiles are captured with ~10% overlap
  (`stepX`/`stepY` = 90% of viewport) and a grayscale SAD (sum of absolute
  differences) search picks the best horizontal shift + seam cut column per
  tile join, rather than trusting a fixed overlap width — PA's own
  virtualization/rendering can shift content slightly between scrolls.
- **Precision cursor and Ctrl+click anchors**: plain click was too easy to
  trigger accidentally while scrolling the canvas, so anchor placement
  requires Ctrl+click; a custom SVG crosshair cursor replaces the OS cursor
  during placement mode for exact pixel targeting.
- **No data collection**: `browser_specific_settings.gecko.data_collection_permissions`
  is explicitly `{ required: ["none"], optional: [] }` — required for AMO
  submission (see fix commit `1359bac`).

## To-do

- [x] Governance scaffold created; AGENTS.md and ai-context/ populated with
      real content from repo survey — verified by reading README, manifest,
      content.js, background.js, popup.js, git log, and published-versions/.
- [ ] pending — confirm whether `ai-context/` should be added to `.gitignore`
      (repo has no existing agent-context convention; currently untracked).
- [ ] pending — no active feature work identified; next session should ask
      the user what's next (bug report, new PA UI compat, or new release).

## File map (ai-context/)

- `technical.md` — stack (vanilla JS, no build), MV3 architecture, message
  types, debug flags, run/package commands.
- `resume.md` — cold-start summary for a new agent session.
- `todo.md` — active task list.
- `build-plan.md` — phase history / milestones.

## Rules for all agents working on this project

1. Read this file and all linked ai-context/ files before writing any code or making any plan.
2. After completing any task, update the to-do list: mark it [x] complete with a one-line test result summary and any user feedback received.
3. If a design decision changes during implementation, update the relevant ai-context/ file immediately — do not leave it stale.
4. If you discover something important that is not documented (an undocumented constraint, a gotcha, a key dependency), add it to the relevant ai-context/ file before moving on.
5. Do not start the next sub-project until the current one is marked [x] complete with passing tests confirmed.
6. If the user provides feedback that changes scope or approach, update AGENTS.md and the relevant ai-context/ file before continuing.
7. At the end of every session, verify AGENTS.md and ai-context/ accurately reflect the current state of the project.

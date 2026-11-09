# AGENTS.md - PA Flow Capture

Guidance for AI coding agents working in this repository.

## Project overview

This project is a Firefox MV3 extension (`manifest.json` v1.0.1).
The extension captures a Power Automate / Power Apps maker-portal flow designer canvas as a single stitched PNG.
The canvas can be far larger than one screen.

User flow:

1. User Ctrl+clicks two anchor points on the canvas. This defines the capture bounds.
2. The extension scrolls the canvas tile-by-tile (`content.js`).
3. The extension captures each tile with `tabs.captureVisibleTab`.
4. The extension stitches the tiles on an `OffscreenCanvas`.
5. The extension applies horizontal seam-matching to hide column joins (`background.js`).

Host permissions apply only to `make.powerautomate.com` and `make.powerapps.com`.
The extension has no build step.
For development, load it as a temporary add-on.
For release, package it with `web-ext build`.

## Current status

- Latest packaged release: `published-versions/pa_flow_capture_V1.0.1.zip` (Mar 20). Matches `manifest.json` version `1.0.1`.
- Repo history: 7 commits. First commit adds the feature. Later commits are hardening or fix commits (AMO data-collection consent schema, removal of unsafe `innerHTML` in precision cursor overlay, icon cleanup).
- No new capture features have landed since v1.0.1. The project is in stabilization and maintenance.
- Working tree is clean except for `ai-context/` (untracked — this session's scaffolding).
- Both `content.js` and `background.js` contain many debug constants (see Gotchas in `ai-context/technical.md`). All are currently `false` or off for normal use.

## Key decisions

- **Frame-claim race for iframe ownership:** PA embeds the flow designer in an iframe. `content_scripts.all_frames: true` injects into every frame. `background.js` runs a short-timeout claim race (`captureClaims` map, 150ms). The race scores each frame by detected canvas size. Exactly one frame becomes the capture owner. Later messages route only to that owner (`captureOwnerByTab`).
- **Crop math in background, not content script:** Firefox content scripts had issues with canvas and `toDataURL` on tab screenshots. Cropping and stitching happen in `background.js` with `OffscreenCanvas` (MV3 module background).
- **Seam matching over fixed overlap:** Tiles use about 10% overlap (`stepX`/`stepY` = 90% of viewport). A grayscale SAD search picks the best horizontal shift and seam cut column. This does not rely on a fixed overlap width.
- **Precision cursor and Ctrl+click anchors:** Plain click was too easy to trigger by accident. Anchor placement requires Ctrl+click. A custom SVG crosshair replaces the OS cursor during placement.
- **No data collection:** `browser_specific_settings.gecko.data_collection_permissions` is `{ required: ["none"], optional: [] }`. AMO submission requires this (see commit `1359bac`).

## To-do

- [x] Governance scaffold created. AGENTS.md and ai-context/ hold real content from a repo survey.
- [ ] pending — confirm whether `ai-context/` should be added to `.gitignore` (currently untracked; no existing agent-context convention).
- [ ] pending — no active feature work identified. Ask the user for the next task in the next session.

## File map (ai-context/)

- `technical.md` — stack (vanilla JS, no build), MV3 architecture, message types, debug flags, run and package commands
- `resume.md` — cold-start summary
- `todo.md` — active task list
- `build-plan.md` — phase history and milestones

## Rules for all agents working on this project

1. Read this file and all linked ai-context/ files before writing any code or making any plan.
2. After completing any task, update the to-do list: mark it [x] complete with a one-line test result summary and any user feedback received.
3. If a design decision changes during implementation, update the relevant ai-context/ file immediately — do not leave it stale.
4. If you discover something important that is not documented (an undocumented constraint, a gotcha, a key dependency), add it to the relevant ai-context/ file before moving on.
5. Do not start the next sub-project until the current one is marked [x] complete with passing tests confirmed.
6. If the user provides feedback that changes scope or approach, update AGENTS.md and the relevant ai-context/ file before continuing.
7. At the end of every session, verify AGENTS.md and ai-context/ accurately reflect the current state of the project.

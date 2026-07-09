# Resume guide

Read this first when opening the project from a new shell or agent session.

## One-line summary

Firefox extension that Ctrl+click-anchors a region of a Power Automate/Power
Apps flow designer canvas, scrolls it tile-by-tile, and stitches the tiles
into one downloaded PNG.

## What exists today

- Working v1.0.1 extension, 4 runtime files (`manifest.json`, `popup.js`/
  `popup.html`, `content.js`, `background.js`), no build step, no deps.
- Packaged release exists at `published-versions/pa_flow_capture_V1.0.1.zip`.
- Git history: 1 feature commit (`967536d` initial repo) + 6 hardening/fix
  commits (AMO consent schema, innerHTML removal, icon cleanup, gecko data
  collection permissions). No new capture features since v1.0.1 — repo is in
  maintenance mode.
- Working tree clean apart from this session's `ai-context/` scaffolding.

## Next action

1. Read `AGENTS.md` and `ai-context/todo.md`.
2. No open feature work is defined — if the user hasn't given a task, ask
   what's needed (bug report against a specific PA flow, packaging a new
   version, etc.) rather than assuming scope.
3. Mark `[x]` with a one-line test result when done.

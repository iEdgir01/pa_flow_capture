# Resume guide

Read this first when opening the project from a new shell or agent session.

## One-line summary

This Firefox extension lets the user Ctrl+click-anchor a region of a Power
Automate / Power Apps flow designer canvas, scrolls the region tile-by-tile,
and stitches the tiles into one downloaded PNG.

## What exists today

- A working v1.0.1 extension with 4 runtime files: `manifest.json`,
  `popup.js`/`popup.html`, `content.js`, `background.js`. It has no build
  step and no dependencies.
- A packaged release at `published-versions/pa_flow_capture_V1.0.1.zip`.
- Git history: 1 feature commit (`967536d`, initial repo) plus 6
  hardening/fix commits (AMO consent schema, innerHTML removal, icon
  cleanup, gecko data collection permissions).
- A clean working tree, apart from this session's `ai-context/` scaffolding.

## Next action

See `ai-context/todo.md` for the active task list. Read it and `AGENTS.md`
before starting work. Mark items `[x]` with a one-line test result when
done.

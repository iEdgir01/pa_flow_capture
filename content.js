// PA Flow Capture — content script

/** Set `true` to download cropped tiles via background `download-blob` (data URLs are too large for `sendMessage`). */
const PA_CAPTURE_DEBUG_RAW_TILES = false;
const PA_CAPTURE_DEBUG_TILE_LIMIT = 12;

// Debug-only downloads.
// Keep these OFF during normal use so we only download the final stitched PNG.
const PA_CAPTURE_DEBUG_DOWNLOAD_RAW_CAPTURE_ONCE = false;
const PA_CAPTURE_DEBUG_DOWNLOAD_CROPPED_TILE_ONCE = false;
const PA_CAPTURE_DEBUG_DOWNLOAD_CROP_ANNOTATED_ONCE = false;
const PA_CAPTURE_DEBUG_CROP_IN_BG_ONCE = false;

/**
 * Verbose stitch/capture logging (content). Also set `PA_CAPTURE_DIAG_LOG` in `background.js`.
 * Reload extension after changing. Check **page** console on PA tab + **extension** console in about:debugging.
 */
const PA_CAPTURE_DIAG_LOG = false;

/**
 * `false` (**default**): scale/crop use only `getTopViewportCssSize()` in this frame + `getRectRelativeToTopWindow` (older, working path for most users).
 * `true`: main-frame `scripting.executeScript` metrics + largest-iframe rect fallback (only if iframe offset chain is broken).
 */
// Prefer main-frame metrics (often fixes Firefox iframe crop scaling).
const PA_CAPTURE_USE_MAIN_FRAME_METRICS = true;

/**
 * If `true`, recompute `captureScaleX/Y` on every tile using viewport size.
 * Older/working behavior computed scale once and reused it for stability.
 */
const PA_CAPTURE_RECALC_SCALE_EACH_TILE = false;

/**
 * After each scroll + dwell, wait this long so PA layout, virtualization, and
 * guide lines can settle before `captureVisibleTab` (plan A: stability before stitch).
 */
const PA_SCROLL_SETTLE_MS = 300;

/** Minimum dwell per tile (ms). User slider can go higher; this is the floor. */
const PA_TILE_DWELL_MIN_MS = 1200;

/**
 * Tile-relative top trim (CSS px): remove pixels with y in [0, N) from each tile.
 *
 * Your observed issue is that the trigger step is getting clipped; for this
 * build we follow the requirement: crop only up to `y = 40` (not 40+extra).
 */
const PA_TILE_TOP_TRIM_BAR_CSS = 40;
const PA_TILE_TOP_TRIM_SEPARATOR_CSS = 0;
const PA_TILE_TOP_TRIM_END_CSS = PA_TILE_TOP_TRIM_BAR_CSS + PA_TILE_TOP_TRIM_SEPARATOR_CSS;

// Small extra padding to cover borders/separators that sit just outside the
// measured element box (prevents 1-2px “hairline” repetition).
const PA_TILE_TOP_EXCLUDE_EXTRA_CSS = 2;


/**
 * Hide only nodes that are very likely snap/guide overlays.
 *
 * Do NOT use broad patterns like `[class*="alignment"]`, `[class*="snap"]`, or
 * `[class*="guide"]` — Power Automate uses those substrings on normal layout
 * (flex alignment, etc.). Hiding them breaks the canvas and shows grid-like
 * seams / thick lines in stitched output.
 *
 * Add PA-specific selectors here only after verifying in DevTools (copy exact
 * class or `data-automation-id` from a real guideline node).
 */
const PA_CAPTURE_GUIDE_LAYER_SELECTORS = [
  '[class*="guideline"]'
];

// ─── Canvas Detection ────────────────────────────────────────────────────────

/**
 * Find the PA flow canvas element.
 * Returns the element and logs which strategy matched.
 */
function detectCanvas() {
  let best = null;
  let bestScore = 0;

  const canActuallyScroll = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const beforeL = node.scrollLeft;
    const beforeT = node.scrollTop;
    let movedX = false;
    let movedY = false;
    try {
      node.scrollLeft = beforeL + 1;
      node.scrollTop = beforeT + 1;
      movedX = node.scrollLeft !== beforeL;
      movedY = node.scrollTop !== beforeT;
    } catch {
      movedX = false;
      movedY = false;
    } finally {
      try {
        node.scrollLeft = beforeL;
        node.scrollTop = beforeT;
      } catch {
        // Ignore restoration failures on non-scrollable nodes.
      }
    }
    return movedX || movedY;
  };

  const scoreCandidate = (node) => {
    const rect = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    if (rect.width < 50 || rect.height < 50) return 0;
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return 0;
    const hasScrollableOverflow =
      node.scrollWidth > node.clientWidth + 2 || node.scrollHeight > node.clientHeight + 2;
    if (!hasScrollableOverflow) return 0;
    // Avoid non-viewport wrappers whose dimensions suggest overflow but do not
    // actually react to scrollLeft/scrollTop changes.
    if (!canActuallyScroll(node)) return 0;
    const overflowIsScrollable =
      cs.overflowX === 'auto' || cs.overflowX === 'scroll' ||
      cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    const viewportBonus = overflowIsScrollable ? 1000000 : 0;
    return viewportBonus + rect.width * rect.height + (node.scrollWidth - node.clientWidth) * (node.scrollHeight - node.clientHeight) * 0.01;
  };

  const maybeConsider = (el, label) => {
    if (!(el instanceof HTMLElement)) return;
    const score = scoreCandidate(el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  };

  // Try explicit selectors first (but do not early-return — score/select later).
  let el = document.querySelector('[data-automation-id="canvas-container"]');
  if (el) maybeConsider(el, 'data-automation-id');

  el = document.querySelector('.msla-workflow-graph');
  if (el) maybeConsider(el, '.msla-workflow-graph');

  // Deepest scrollable element inside #app
  const root = document.querySelector('#app') || document.body;
  const candidates = root.querySelectorAll('*');
  for (const node of candidates) {
    const scrollW = node.scrollWidth;
    const scrollH = node.scrollHeight;
    const clientW = node.clientWidth;
    const clientH = node.clientHeight;
    if (!(scrollW > clientW + 2 || scrollH > clientH + 2)) continue;

    const rect = node.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) continue;

    const cs = getComputedStyle(node);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;

    // Prefer the largest visible scrollable viewport.
    const score = scoreCandidate(node);
    if (score > bestScore) { bestScore = score; best = node; }
  }
  if (best) {
    return best;
  }


  return document.documentElement;
}

function isLikelyPaCanvas(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el === document.documentElement || el === document.body) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 50 || rect.height < 50) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;

  // Prefer explicit selectors when available.
  if (el.getAttribute?.('data-automation-id') === 'canvas-container') return true;
  if (el.classList?.contains('msla-workflow-graph')) return true;

  // Fallback heuristic: must be scrollable enough to indicate a canvas viewport.
  return (el.scrollWidth > el.clientWidth + 10) || (el.scrollHeight > el.clientHeight + 10);
}

function getCanvasScore(el) {
  if (!isLikelyPaCanvas(el)) return 0;
  const rect = el.getBoundingClientRect();
  const scrollW = el.scrollWidth;
  const scrollH = el.scrollHeight;
  const clientW = el.clientWidth;
  const clientH = el.clientHeight;
  return rect.width * rect.height + (scrollW - clientW) * (scrollH - clientH) * 0.01;
}

function getRectRelativeToTopWindow(el) {
  // Canvas lives inside a potentially nested iframe. `getBoundingClientRect()`
  // is relative to the current frame viewport, but `captureVisibleTab()`
  // produces a screenshot relative to the top browsing context.
  // We convert rect coordinates to the top window by summing frame offsets.
  const base = el.getBoundingClientRect();
  let left = base.left;
  let top = base.top;
  const width = base.width;
  const height = base.height;
  let win = window;
  let reachedTop = (win === win.top);

  // In same-origin frames we can access frameElement/parent.
  // Add frame offsets until we reach the top window or we cannot continue.
  while (win !== win.top) {
    let frameEl = null;
    try {
      frameEl = win.frameElement;
    } catch {
      break;
    }
    if (!frameEl) break;

    const fr = frameEl.getBoundingClientRect();
    left += fr.left;
    top += fr.top;

    try {
      win = win.parent;
      reachedTop = (win === win.top);
    } catch {
      break;
    }
  }

  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    reachedTop
  };
}

/**
 * CSS layout size of the tab’s root viewport (what `captureVisibleTab` usually maps to).
 * `innerWidth` alone misses pinch-zoom and some Fx layouts; prefer `visualViewport`.
 */
function getTopViewportCssSize() {
  try {
    const top = window.top;
    const vv = top.visualViewport;
    const w = Number(vv?.width || top.innerWidth || 0);
    const h = Number(vv?.height || top.innerHeight || 0);
    if (w > 8 && h > 8) return { w, h };
  } catch {
    // Cross-origin access to top — fall back to this frame.
  }
  const w = Math.max(1, window.innerWidth || 1);
  const h = Math.max(1, window.innerHeight || 1);
  return { w, h };
}

/**
 * Map screenshot device pixels → CSS layout px. Legacy path uses one `getTopViewportCssSize()` pair.
 * Main-frame path tries vv → inner → client in order (first valid), then averages X/Y if skewed.
 */
function pickCaptureScalesFromViewport(nw, nh, tabMetrics) {
  const m = tabMetrics?.metrics;
  let bw;
  let bh;
  if (m && (m.vvW > 8 && m.vvH > 8)) {
    bw = m.vvW;
    bh = m.vvH;
  } else if (m && (m.iw > 8 && m.ih > 8)) {
    bw = m.iw;
    bh = m.ih;
  } else if (m && (m.cw > 8 && m.ch > 8)) {
    bw = m.cw;
    bh = m.ch;
  } else {
    const { w, h } = getTopViewportCssSize();
    bw = Math.max(1, w);
    bh = Math.max(1, h);
  }
  const sx = nw / bw;
  const sy = nh / bh;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) {
    return { captureScaleX: null, captureScaleY: null };
  }
  const ratio = sx / sy;
  if (ratio > 1.08 || ratio < 0.92) {
    const s = (sx + sy) / 2;
    return { captureScaleX: s, captureScaleY: s };
  }
  return { captureScaleX: sx, captureScaleY: sy };
}

/**
 * When iframe→top offset chain breaks (`reachedTop: false`), approximate top-window CSS
 * coords as (largest iframe on main doc) + (local viewport rect inside this frame).
 */
function resolveRectForTabScreenshot(cropTargetEl, rect, tabMetrics) {
  if (rect.reachedTop) return rect;
  const big = tabMetrics?.bestIframe;
  if (!big || typeof big.left !== 'number' || typeof big.top !== 'number') return rect;
  const local = cropTargetEl.getBoundingClientRect();
  if (!(local.width > 4 && local.height > 4)) return rect;
  if (PA_CAPTURE_DIAG_LOG) {
    console.warn('[PA Capture] rect fallback: largest iframe + local getBoundingClientRect()', {
      big,
      local: { left: local.left, top: local.top, width: local.width, height: local.height }
    });
  }
  const left = big.left + local.left;
  const top = big.top + local.top;
  return {
    left,
    top,
    width: local.width,
    height: local.height,
    right: left + local.width,
    bottom: top + local.height,
    reachedTop: true
  };
}

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  mode: 'idle',   // idle | placing-a | placing-b | ready | capturing | done | error
  pointA: null,   // { scrollLeft, scrollTop, clientX, clientY }
  pointB: null,
  dwellMs: 1200,
  tiles: [],
  canvasEl: null,
  scrollEl: null,
  dotA: null,     // overlay dot element
  dotB: null,
  _cancelled: false,
  _runId: 0,
  _runClaimId: 0,
  _claimed: false,
  _current: 0,
  _region: null,
  _ctrlDown: false,
  _lastError: '',
  _zoomRestore: null, // { origHtmlZoom, appliedZoomFactor, effectiveScaleBefore }
};

function getEffectiveVisualViewportScale() {
  try {
    const s = Number(window?.visualViewport?.scale);
    if (Number.isFinite(s) && s > 0) return s;
  } catch { /* ignore */ }
  return 1;
}

function applyCaptureEffectiveZoom(autoZoomEnabled) {
  // Reset any previous zoom we might have applied in an earlier run.
  restoreCaptureEffectiveZoom();

  let autoZoomFactor = 1;
  let effectiveScaleBefore = null;
  if (autoZoomEnabled) {
    effectiveScaleBefore = getEffectiveVisualViewportScale();
    if (!Number.isFinite(effectiveScaleBefore) || effectiveScaleBefore <= 0) effectiveScaleBefore = null;
    if (effectiveScaleBefore) {
      autoZoomFactor = 1 / effectiveScaleBefore;
      if (!Number.isFinite(autoZoomFactor) || autoZoomFactor <= 0) autoZoomFactor = 1;
    }
  }

  if (!Number.isFinite(autoZoomFactor) || autoZoomFactor <= 0) return;

  // Avoid layout churn if we're effectively at 1x.
  if (Math.abs(autoZoomFactor - 1) < 0.001) return;
  if (autoZoomFactor < 0.25 || autoZoomFactor > 6) return; // safety clamp

  const htmlEl = document.documentElement;
  const origHtmlZoom = htmlEl?.style?.zoom ?? '';

  try {
    htmlEl.style.zoom = String(autoZoomFactor);
    state._zoomRestore = {
      origHtmlZoom,
      appliedZoomFactor: autoZoomFactor,
      effectiveScaleBefore
    };
    if (PA_CAPTURE_DIAG_LOG) {
      console.log('[PA Capture] zoom applied', {
        autoZoomEnabled,
        effectiveZoom: autoZoomFactor,
        effectiveScaleBefore,
        origHtmlZoom
      });
    }
  } catch {
    // If zoom style assignment fails, just continue without it.
    state._zoomRestore = null;
  }
}

function restoreCaptureEffectiveZoom() {
  const restore = state._zoomRestore;
  if (!restore) return;
  try {
    const htmlEl = document.documentElement;
    if (!htmlEl?.style) return;
    if (typeof restore.origHtmlZoom === 'string' && restore.origHtmlZoom) {
      htmlEl.style.zoom = restore.origHtmlZoom;
    } else {
      htmlEl.style.removeProperty('zoom');
    }
  } catch { /* ignore */ }
  state._zoomRestore = null;
}

function canElementActuallyScroll(node) {
  if (!(node instanceof HTMLElement)) return false;
  const beforeL = node.scrollLeft;
  const beforeT = node.scrollTop;
  let movedX = false;
  let movedY = false;
  try {
    node.scrollLeft = beforeL + 1;
    node.scrollTop = beforeT + 1;
    movedX = node.scrollLeft !== beforeL;
    movedY = node.scrollTop !== beforeT;
  } catch {
    movedX = false;
    movedY = false;
  } finally {
    try {
      node.scrollLeft = beforeL;
      node.scrollTop = beforeT;
    } catch {
      // ignore
    }
  }
  return movedX || movedY;
}

function resolvePrimaryScrollElement(canvasEl) {
  if (!(canvasEl instanceof HTMLElement)) return canvasEl;

  const collectAncestors = [];
  let cur = canvasEl;
  while (cur && cur instanceof HTMLElement) {
    collectAncestors.push(cur);
    if (cur === document.body || cur === document.documentElement) break;
    cur = cur.parentElement;
  }

  const descendants = Array.from(canvasEl.querySelectorAll('*')).filter(n => n instanceof HTMLElement);
  const all = [...new Set([...collectAncestors, ...descendants])];
  let best = canvasEl;
  let bestScore = -Infinity;
  const canvasRect = canvasEl.getBoundingClientRect();

  for (const el of all) {
    if (!(el instanceof HTMLElement)) continue;
    const hasOverflow = el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2;
    if (!hasOverflow) continue;
    if (!canElementActuallyScroll(el)) continue;

    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const overflowBonus =
      cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowY === 'auto' || cs.overflowY === 'scroll'
        ? 200000
        : 0;
    const paBonus = (el.className || '').includes('flow-designer-container') ? 500000 : 0;
    const overlapW = Math.max(0, Math.min(rect.right, canvasRect.right) - Math.max(rect.left, canvasRect.left));
    const overlapH = Math.max(0, Math.min(rect.bottom, canvasRect.bottom) - Math.max(rect.top, canvasRect.top));
    const overlapArea = overlapW * overlapH;
    const scrollArea = (el.scrollWidth - el.clientWidth) * (el.scrollHeight - el.clientHeight);
    const score = paBonus + overflowBonus + overlapArea + scrollArea * 0.01;

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

function getActiveScrollEl() {
  return state.scrollEl || state.canvasEl;
}

function findScrollableAncestor(startEl, stopEl) {
  let cur = startEl instanceof Element ? startEl : null;
  while (cur) {
    if (cur instanceof HTMLElement) {
      const canScrollX = cur.scrollWidth > cur.clientWidth + 2;
      const canScrollY = cur.scrollHeight > cur.clientHeight + 2;
      if (canScrollX || canScrollY) return cur;
    }
    if (cur === stopEl) break;
    cur = cur.parentElement;
  }
  return null;
}

// ─── Overlay UI ──────────────────────────────────────────────────────────────

let overlayBar = null;
let clickHandler = null;
let keyHandler = null;
let canvasClickTarget = null;
let captureBtn = null;
let captureLockEl = null;
let canvasScrollListener = null;
let canvasScrollTarget = null;
let blockInputHandler = null;
let placementDotTimer = null;
let shiftKeyDownHandler = null;
let shiftKeyUpHandler = null;
let pointerMoveHandler = null;
let precisionCursorEl = null;

function isPlacementMode(mode) {
  return mode === 'placing-a' || mode === 'placing-b';
}

function ensurePrecisionCursor() {
  if (precisionCursorEl) return;

  // IMPORTANT: `left`/`top` + `translate(-50%,-50%)` place the **center of this box**
  // at the pointer — that is the same point as `e.clientX`/`e.clientY` used for anchors.
  // The reticle **must** be drawn at (W/2, H/2) or placement looks wrong.
  const W = 64;
  const H = 64;
  const cx = W / 2;
  const cy = H / 2;
  const r = 18;

  precisionCursorEl = document.createElement('div');
  precisionCursorEl.id = '__pa-capture-precision-cursor';
  Object.assign(precisionCursorEl.style, {
    position: 'fixed',
    width: `${W}px`,
    height: `${H}px`,
    pointerEvents: 'none',
    zIndex: '2147483647',
    transform: 'translate(-50%, -50%)',
    display: 'none',
    overflow: 'visible',
  });

  const arm = 11;
  const gap = 3.5;

  precisionCursorEl.innerHTML = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
  <defs>
    <filter id="__pa-cursor-drop" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="2.2" flood-color="#000" flood-opacity="0.5"/>
    </filter>
    <radialGradient id="__pa-cursor-lens" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.5)"/>
      <stop offset="50%" stop-color="rgba(255,255,255,0.14)"/>
      <stop offset="100%" stop-color="rgba(70,80,100,0.22)"/>
    </radialGradient>
  </defs>
  <!-- Handle (bottom-right; does not shift the optical center) -->
  <path d="M ${cx + r * 0.65} ${cy + r * 0.65} L ${W - 6} ${H - 6}" stroke="#0d0d0d" stroke-width="4.5" stroke-linecap="round" filter="url(#__pa-cursor-drop)"/>
  <path d="M ${cx + r * 0.65} ${cy + r * 0.65} L ${W - 6} ${H - 6}" stroke="rgba(255,255,255,0.9)" stroke-width="1.75" stroke-linecap="round"/>
  <!-- Lens (centered on pointer = exact anchor) -->
  <circle cx="${cx}" cy="${cy}" r="${r + 0.8}" fill="none" stroke="#0a0a0a" stroke-width="2.2" filter="url(#__pa-cursor-drop)"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#__pa-cursor-lens)" stroke="rgba(255,255,255,0.95)" stroke-width="1.4"/>
  <!-- Gap reticle: center of gap = (cx,cy) = click point -->
  <g stroke-linecap="round" shape-rendering="geometricPrecision">
    <g stroke="#0a0a0a" stroke-width="3.25" opacity="0.92">
      <line x1="${cx - arm}" y1="${cy}" x2="${cx - gap}" y2="${cy}"/>
      <line x1="${cx + gap}" y1="${cy}" x2="${cx + arm}" y2="${cy}"/>
      <line x1="${cx}" y1="${cy - arm}" x2="${cx}" y2="${cy - gap}"/>
      <line x1="${cx}" y1="${cy + gap}" x2="${cx}" y2="${cy + arm}"/>
    </g>
    <g stroke="#ffffff" stroke-width="1.4">
      <line x1="${cx - arm}" y1="${cy}" x2="${cx - gap}" y2="${cy}"/>
      <line x1="${cx + gap}" y1="${cy}" x2="${cx + arm}" y2="${cy}"/>
      <line x1="${cx}" y1="${cy - arm}" x2="${cx}" y2="${cy - gap}"/>
      <line x1="${cx}" y1="${cy + gap}" x2="${cx}" y2="${cy + arm}"/>
    </g>
  </g>
  <circle cx="${cx}" cy="${cy}" r="1.5" fill="#0a0a0a" opacity="0.85"/>
  <circle cx="${cx}" cy="${cy}" r="0.7" fill="#ffffff"/>
</svg>`;

  document.body.appendChild(precisionCursorEl);
}

function removePrecisionCursor() {
  precisionCursorEl?.remove();
  precisionCursorEl = null;
}

function updatePrecisionCursorMode() {
  const active = isPlacementMode(state.mode);
  if (!active) {
    if (pointerMoveHandler) {
      document.removeEventListener('pointermove', pointerMoveHandler, true);
      pointerMoveHandler = null;
    }
    if (precisionCursorEl) precisionCursorEl.style.display = 'none';
    document.documentElement.style.cursor = '';
    document.body.style.cursor = '';
    return;
  }

  ensurePrecisionCursor();
  precisionCursorEl.style.display = 'block';
  document.documentElement.style.cursor = 'none';
  document.body.style.cursor = 'none';

  if (!pointerMoveHandler) {
    pointerMoveHandler = (e) => {
      if (!precisionCursorEl) return;
      // Align with pointer event coordinates (same as anchor placement).
      precisionCursorEl.style.left = `${e.clientX}px`;
      precisionCursorEl.style.top = `${e.clientY}px`;
    };
    document.addEventListener('pointermove', pointerMoveHandler, true);
  }
}

function createOverlay() {
  overlayBar = document.createElement('div');
  overlayBar.id = '__pa-capture-bar';
  Object.assign(overlayBar.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647',
    background: 'rgba(0,120,212,0.92)', color: '#fff',
    padding: '8px 16px', fontSize: '13px', fontFamily: 'sans-serif',
    display: 'flex', alignItems: 'center', gap: '12px',
    boxSizing: 'border-box',
  });

  const label = document.createElement('span');
  label.id = '__pa-capture-label';
  label.style.flex = '1';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel (ESC)';
  Object.assign(cancelBtn.style, {
    background: 'rgba(255,255,255,0.2)', color: '#fff', border: 'none',
    borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px',
  });
  cancelBtn.onclick = cancelCapture;

  captureBtn = document.createElement('button');
  captureBtn.textContent = 'Capture!';
  Object.assign(captureBtn.style, {
    background: 'rgba(34,197,94,0.95)',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: '12px',
    display: 'none',
  });
  captureBtn.onclick = () => {
    if (state.mode === 'ready') runCapture();
  };

  overlayBar.appendChild(label);
  overlayBar.appendChild(cancelBtn);
  overlayBar.appendChild(captureBtn);
  document.body.appendChild(overlayBar);
  updateOverlayButtons();
}

function updateOverlayButtons() {
  if (!captureBtn) return;
  captureBtn.style.display = state.mode === 'ready' ? 'block' : 'none';
}

function setOverlayVisible(visible) {
  if (!overlayBar) return;
  overlayBar.style.display = visible ? 'flex' : 'none';
}

function setLabel(text) {
  const label = document.getElementById('__pa-capture-label');
  if (label) label.textContent = text;
}

function setCaptureButtonVisible(visible) {
  if (!captureBtn) return;
  captureBtn.style.display = visible ? 'block' : 'none';
  updateOverlayButtons();
}


function placeDot(x, y, color) {
  const dot = document.createElement('div');
  Object.assign(dot.style, {
    position: 'fixed', left: x + 'px', top: y + 'px',
    width: '12px', height: '12px', borderRadius: '50%',
    background: color, border: '2px solid #fff',
    zIndex: '2147483647', transform: 'translate(-50%,-50%)',
    pointerEvents: 'none',
  });
  document.body.appendChild(dot);
  return dot;
}

function docFromPoint(pt) {
  return {
    docX: pt.scrollLeft + pt.clientX,
    docY: pt.scrollTop + pt.clientY,
  };
}

function updateDotPosition(dotEl, pt) {
  const scrollEl = getActiveScrollEl();
  if (!dotEl || !pt || !scrollEl) return;
  const rect = scrollEl.getBoundingClientRect();
  const { docX, docY } = docFromPoint(pt);
  const x = rect.left + (docX - scrollEl.scrollLeft);
  const y = rect.top  + (docY - scrollEl.scrollTop);
  dotEl.style.left = `${x}px`;
  dotEl.style.top = `${y}px`;
}

function ensureCanvasScrollListener() {
  const scrollEl = getActiveScrollEl();
  if (!scrollEl || canvasScrollListener) return;
  canvasScrollListener = () => {
    if (state.dotA && state.pointA) updateDotPosition(state.dotA, state.pointA);
    if (state.dotB && state.pointB) updateDotPosition(state.dotB, state.pointB);
  };
  canvasScrollTarget = scrollEl;
  scrollEl.addEventListener('scroll', canvasScrollListener, { passive: true });
}

function removeCanvasScrollListener() {
  if (!canvasScrollTarget || !canvasScrollListener) return;
  canvasScrollTarget.removeEventListener('scroll', canvasScrollListener);
  canvasScrollListener = null;
  canvasScrollTarget = null;
}

function startPlacementDotTracking() {
  if (placementDotTimer) return;
  placementDotTimer = setInterval(() => {
    if (state.dotA && state.pointA) updateDotPosition(state.dotA, state.pointA);
    if (state.dotB && state.pointB) updateDotPosition(state.dotB, state.pointB);
  }, 80);
}

function stopPlacementDotTracking() {
  if (!placementDotTimer) return;
  clearInterval(placementDotTimer);
  placementDotTimer = null;
}

function showCaptureLock() {
  if (captureLockEl) return;
  // Keep lock non-visual so it never contaminates captured tiles.
  // We only install capture-phase blockers.
  captureLockEl = document.createElement('div');
  captureLockEl.id = '__pa-capture-lock';

  blockInputHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    return false;
  };

  document.addEventListener('wheel', blockInputHandler, { capture: true, passive: false });
  document.addEventListener('touchmove', blockInputHandler, { capture: true, passive: false });
  document.addEventListener('pointerdown', blockInputHandler, { capture: true, passive: false });
  document.addEventListener('mousedown', blockInputHandler, { capture: true, passive: false });
  document.addEventListener('click', blockInputHandler, { capture: true, passive: false });
}

function hideCaptureLock() {
  if (!captureLockEl) return;
  try {
    if (blockInputHandler) {
      document.removeEventListener('wheel', blockInputHandler, { capture: true });
      document.removeEventListener('touchmove', blockInputHandler, { capture: true });
      document.removeEventListener('pointerdown', blockInputHandler, { capture: true });
      document.removeEventListener('mousedown', blockInputHandler, { capture: true });
      document.removeEventListener('click', blockInputHandler, { capture: true });
    }
  } catch { /* ignore */ }
  captureLockEl = null;
  blockInputHandler = null;
}

function removeOverlay() {
  overlayBar?.remove();
  overlayBar = null;
  state.dotA?.remove();
  state.dotA = null;
  state.dotB?.remove();
  state.dotB = null;
  if (clickHandler) {
    document.removeEventListener('pointerdown', clickHandler, true);
    canvasClickTarget?.removeEventListener('click', clickHandler, true);
    canvasClickTarget = null;
  }
  if (keyHandler) document.removeEventListener('keydown', keyHandler);
  clickHandler = null;
  keyHandler = null;
  state._ctrlDown = false;
  if (shiftKeyDownHandler) document.removeEventListener('keydown', shiftKeyDownHandler, true);
  if (shiftKeyUpHandler) document.removeEventListener('keyup', shiftKeyUpHandler, true);
  shiftKeyDownHandler = null;
  shiftKeyUpHandler = null;
  captureBtn = null;
  hideCaptureLock();
  removeCanvasScrollListener();
  stopPlacementDotTracking();
  updatePrecisionCursorMode();
  removePrecisionCursor();
}

function setInternalCaptureUiVisible(visible) {
  const elements = document.querySelectorAll('[id^="__pa-capture-"]');
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    // Keep the non-visual lock out of visibility toggles.
    if (el.id === '__pa-capture-lock') continue;
    el.style.display = visible ? '' : 'none';
  }
}

/** Restore entries for PA overlay nodes we hide during capture (not extension UI). */
let paOverlayStyleRestore = [];

function preparePageForCapture() {
  try {
    document.activeElement?.blur?.();
  } catch { /* ignore */ }
  try {
    window.getSelection?.()?.removeAllRanges?.();
  } catch { /* ignore */ }
  try {
    document.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 0,
      clientY: 0,
      view: window
    }));
  } catch { /* ignore */ }

  paOverlayStyleRestore = [];
  for (const sel of PA_CAPTURE_GUIDE_LAYER_SELECTORS) {
    let nodes;
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    nodes.forEach((el) => {
      if (!(el instanceof Element)) return;
      if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return;
      paOverlayStyleRestore.push({
        el,
        prevVisibility: el.style.visibility,
        hadHideAttr: el.hasAttribute('data-pa-flow-cap-hide')
      });
      el.setAttribute('data-pa-flow-cap-hide', '1');
      el.style.visibility = 'hidden';
    });
  }
}

function restorePageAfterCapture() {
  for (const entry of paOverlayStyleRestore) {
    const { el, prevVisibility, hadHideAttr } = entry;
    if (el?.isConnected) {
      el.style.visibility = prevVisibility;
      if (!hadHideAttr) el.removeAttribute('data-pa-flow-cap-hide');
    }
  }
  paOverlayStyleRestore = [];
}

function cancelCapture() {
  restoreCaptureEffectiveZoom();
  state._cancelled = true;
  state._claimed = false;
  hideCaptureLock();
  const scrollEl = getActiveScrollEl();
  if (scrollEl && state.pointA) {
    scrollEl.scrollLeft = state.pointA.scrollLeft;
    scrollEl.scrollTop  = state.pointA.scrollTop;
  }
  state.mode = 'idle';
  state.pointA = null;
  state.pointB = null;
  state.tiles = [];
  state._current = 0;
  state._region  = null;
  state.scrollEl = null;
  state.canvasEl = null;
  state._lastError = '';
  setInternalCaptureUiVisible(true);
  removeOverlay();
  browser.runtime.sendMessage({ type: 'state-update', mode: 'idle' }).catch(() => {});
  browser.runtime.sendMessage({ type: 'release-capture-owner' }).catch(() => {});
}

function failCapture(message, details) {
  state.mode = 'error';
  state._lastError = String(message || 'Capture failed');
  hideCaptureLock();
  setInternalCaptureUiVisible(true);
  setCaptureButtonVisible(false);
  setOverlayVisible(true);
  updateOverlayButtons();
  setLabel(`Capture failed: ${state._lastError} (press ESC to cancel)`);
  const d = details && typeof details === 'object' && 'name' in details
    ? { name: details.name, message: details.message }
    : details;
  console.error('[PA Capture] failCapture', { message: state._lastError, details: d });
  browser.runtime.sendMessage({
    type: 'state-update',
    mode: 'error',
    error: state._lastError
  }).catch(() => {});
}

// ─── Activation (called from popup) ─────────────────────────────────────────

/**
 * @param {number} dwellMs
 * @param {number} [claimRunId]  When set (from background `broadcast-activate`), all frames share one `claim` race key.
 *   Without it, local `++state._runId` is used (legacy single-frame activate).
 * @param {boolean} [autoZoom]  When true, applies an effective zoom adjustment
 *   so capture text is closer to crisp "100%" rendering. This zoom is a
 *   whole-page CSS zoom (not centered on anchors).
 */
function activate(dwellMs, claimRunId, autoZoom) {
  if (state.mode === 'capturing') return;
  // Cleanup any previous run (placing/ready/done) so handlers/overlay can't stack.
  if (state.mode !== 'idle') cancelCapture();

  state._cancelled = false;
  if (typeof claimRunId === 'number' && claimRunId > 0) {
    state._runClaimId = claimRunId;
  } else {
    state._runClaimId = ++state._runId;
  }
  state._claimed = false;
  const nonce = Math.random().toString(36).slice(2);

  state.canvasEl = detectCanvas();
  state.scrollEl = resolvePrimaryScrollElement(state.canvasEl);
  const canvasScore = getCanvasScore(state.canvasEl);

  // Only a single frame should become the "owner frame" for this run.
  // Others injected by `all_frames: true` must stay idle to avoid duplicate banners
  // and to ensure popup state comes from the correct frame.
  browser.runtime.sendMessage({ type: 'claim', runId: state._runClaimId, nonce, canvasScore }).then(resp => {
    if (!resp?.claimed) {
      // This frame lost the race — do not leave detectCanvas() refs (confuses __paCapture.inspect).
      state.canvasEl = null;
      state.scrollEl = null;
      return;
    }
    if (state._cancelled) {
      browser.runtime.sendMessage({ type: 'release-capture-owner' }).catch(() => {});
      return;
    }

    if (!isLikelyPaCanvas(state.canvasEl)) {
      state.mode = 'idle';
      state.canvasEl = null;
      state.scrollEl = null;
      removeOverlay();
      browser.runtime.sendMessage({ type: 'release-capture-owner' }).catch(() => {});
      return;
    }

    applyCaptureEffectiveZoom(!!autoZoom);
    state.dwellMs  = dwellMs ?? PA_TILE_DWELL_MIN_MS;
    state.mode     = 'placing-a';
    state.pointA   = null;
    state.pointB   = null;
    state.tiles    = [];
    state._claimed = true;
    state._ctrlDown = false;

    createOverlay();
    setLabel('PA Capture: Ctrl+click top-left of the flow to set Point A');
    setCaptureButtonVisible(false);
    ensureCanvasScrollListener();
    startPlacementDotTracking();
    updatePrecisionCursorMode();
    updateOverlayButtons();

    shiftKeyDownHandler = (e) => {
      if (e.key === 'Control') state._ctrlDown = true;
    };
    shiftKeyUpHandler = (e) => {
      if (e.key === 'Control') state._ctrlDown = false;
    };
    document.addEventListener('keydown', shiftKeyDownHandler, true);
    document.addEventListener('keyup', shiftKeyUpHandler, true);

    clickHandler = (e) => {
      const canvasRect = state.canvasEl.getBoundingClientRect();
      const scrollElNow = getActiveScrollEl();
      const scrollRect = scrollElNow ? scrollElNow.getBoundingClientRect() : canvasRect;
      const tol = 12;
      const insideRect =
        e.clientX >= canvasRect.left - tol &&
        e.clientX <= canvasRect.right + tol &&
        e.clientY >= canvasRect.top - tol &&
        e.clientY <= canvasRect.bottom + tol;

      const insideEl = (() => {
        const t = e.target;
        if (!t || !(t instanceof Node)) return false;
        return state.canvasEl === t || state.canvasEl.contains(t);
      })();

      if (!insideRect && !insideEl) {
        return;
      }

      // Scrollbars or other UI inside the scroll container can trigger pointer
      // events that look like "inside the canvas". Require Ctrl+click to
      // place anchors so users can scroll without accidentally dropping points.
      const ctrlPressed =
        !!e.ctrlKey ||
        !!state._ctrlDown ||
        (typeof e.getModifierState === 'function' && e.getModifierState('Control') === true);

      if (!ctrlPressed) {
        setLabel('Hold Ctrl and click the canvas to place anchors.');
        return;
      }

      e.stopPropagation();
      // Don't preventDefault; PA's own handlers should not break scrolling/virtualization.

      const pt = {
        scrollLeft: (getActiveScrollEl()?.scrollLeft ?? 0),
        scrollTop:  (getActiveScrollEl()?.scrollTop ?? 0),
        // Coordinates are relative to the same element whose scroll offsets are
        // stored above, so docFromPoint() and updateDotPosition() stay consistent.
        clientX:    e.clientX - scrollRect.left,
        clientY:    e.clientY - scrollRect.top,
      };

      if (state.mode === 'placing-a') {
        // Keep the pre-resolved primary scroll container. Rebinding from click
        // targets can pick non-viewport wrappers and break alignment.
        state.pointA = pt;

        state.dotA   = placeDot(e.clientX, e.clientY, '#22c55e');
        updateDotPosition(state.dotA, state.pointA);
        state.mode   = 'placing-b';
        setLabel('Point A set — Ctrl+click bottom-right to set Point B');
        updatePrecisionCursorMode();
        updateOverlayButtons();
        browser.runtime.sendMessage({ type: 'state-update', mode: 'placing-b' }).catch(() => {});
      } else if (state.mode === 'placing-b') {
        state.pointB = pt;
        state.mode   = 'ready';
        state.dotB = placeDot(e.clientX, e.clientY, '#ef4444');
        updateDotPosition(state.dotB, state.pointB);
        computeAndShowRegion();
        updatePrecisionCursorMode();
        updateOverlayButtons();
      }
    };

    keyHandler = (e) => { if (e.key === 'Escape') cancelCapture(); };

    // Use pointerdown only so a single user action doesn't trigger both
    // pointerdown and click (which would place Point A and then immediately
    // Point B at the same coordinates).
    document.addEventListener('pointerdown', clickHandler, true);
    document.addEventListener('keydown', keyHandler);
    browser.runtime.sendMessage({ type: 'state-update', mode: 'placing-a' }).catch(() => {});
  }).catch(() => {
    // If claim fails, stay idle silently.
  });
}

function computeAndShowRegion() {
  const A = state.pointA, B = state.pointB;
  const ALeft   = A.scrollLeft + A.clientX;
  const ATop    = A.scrollTop  + A.clientY;
  const BLeft   = B.scrollLeft + B.clientX;
  const BTop    = B.scrollTop  + B.clientY;

  // Normalize region bounds so users can click corners in either order.
  let docLeft   = Math.min(ALeft, BLeft);
  let docTop    = Math.min(ATop, BTop);
  let docRight  = Math.max(ALeft, BLeft);
  let docBottom = Math.max(ATop, BTop);

  // If one point clearly represents the top-left and the other the bottom-right,
  // normalize pointA/pointB for correct scroll restoration on Cancel.
  if (ALeft <= BLeft && ATop <= BTop) {
    state.pointA = A;
    state.pointB = B;
  } else if (BLeft <= ALeft && BTop <= ATop) {
    state.pointA = B;
    state.pointB = A;
  }

  const scrollEl = getActiveScrollEl();
  const tileRect = (() => {
    try {
      return (scrollEl instanceof HTMLElement ? scrollEl : state.canvasEl).getBoundingClientRect();
    } catch {
      return state.canvasEl.getBoundingClientRect();
    }
  })();
  const tileW  = tileRect.width;
  const tileH  = tileRect.height;

  // Clamp region bounds to what the scroll container can actually display.
  // Anchor clicks are allowed with a small tolerance, so the calculated
  // doc bounds can be slightly outside the true content area.
  const maxScrollLeft = Math.max(0, (scrollEl?.scrollWidth ?? 0) - (scrollEl?.clientWidth ?? 0));
  const maxScrollTop  = Math.max(0, (scrollEl?.scrollHeight ?? 0) - (scrollEl?.clientHeight ?? 0));
  const maxContentX = maxScrollLeft + tileW;
  const maxContentY = maxScrollTop + tileH;
  docLeft   = Math.max(0, Math.min(docLeft, maxContentX));
  docTop    = Math.max(0, Math.min(docTop, maxContentY));
  docRight  = Math.max(docLeft + 1, Math.min(docRight, maxContentX));
  docBottom = Math.max(docTop + 1, Math.min(docBottom, maxContentY));

  // 10% overlap: step = 90% of viewport (paint-over stitch in background).
  const stepX  = Math.max(1, Math.floor(tileW * 0.9));
  const stepY  = Math.max(1, Math.floor(tileH * 0.9));

  const regionW = docRight - docLeft;
  const regionH = docBottom - docTop;
  if (regionW <= 0 || regionH <= 0) {
    setLabel('Invalid region (check points) — press ESC to cancel.');
    state.mode = 'idle';
    state._region = null;
    browser.runtime.sendMessage({ type: 'state-update', mode: 'idle' }).catch(() => {});
    return;
  }

  const cols   = Math.max(1, Math.ceil(regionW / stepX));
  const rows   = Math.max(1, Math.ceil(regionH / stepY));
  const total  = cols * rows;

  state._region = { docLeft, docTop, docRight, docBottom, tileW, tileH, stepX, stepY, cols, rows, total };

  setLabel(`Region defined — ${cols}×${rows} tiles (${total} total). Click Capture!`);
  setCaptureButtonVisible(true);
  updateOverlayButtons();
  browser.runtime.sendMessage({
    type: 'state-update',
    mode: 'ready',
    total,
  }).catch(() => {});
}

function buildInspectSnapshot() {
  const scrollEl = getActiveScrollEl();
  const canvasEl = state.canvasEl;
  const sr = scrollEl instanceof HTMLElement ? getRectRelativeToTopWindow(scrollEl) : null;
  const cr = canvasEl instanceof HTMLElement ? canvasEl.getBoundingClientRect() : null;
  const elInfo = (el) => {
    if (!(el instanceof HTMLElement)) return null;
    return {
      tag: el.tagName,
      id: el.id || undefined,
      automationId: el.getAttribute?.('data-automation-id') || undefined,
      className: typeof el.className === 'string' ? el.className.slice(0, 160) : undefined,
    };
  };
  let sameScrollAsCanvas = null;
  if (scrollEl instanceof HTMLElement && canvasEl instanceof HTMLElement) {
    sameScrollAsCanvas = scrollEl === canvasEl;
  }
  const isTopWindow = (() => {
    try { return window === window.top; } catch { return false; }
  })();
  let hint = 'Tiles crop to getRectRelativeToTopWindow(getActiveScrollEl()||canvasEl) × captureScale.';
  if (!state._claimed && (scrollEl || canvasEl)) {
    hint += ' This frame did NOT win capture claim (or lost refs) — switch DevTools console to the iframe where you placed points; look for claimed:true there.';
  } else if (!canvasEl) {
    hint += ' canvasEl is null: start from extension popup in this frame, and use the iframe context that contains the flow canvas.';
  }
  return {
    claimed: state._claimed,
    mode: state.mode,
    /** True only in the frame that won `claim` and passed isLikelyPaCanvas. */
    captureOwnerFrame: !!(state._claimed && canvasEl instanceof HTMLElement),
    /** This inspect runs in one content-script frame; PA often embeds the designer in an iframe. */
    devtoolsConsoleFrame: isTopWindow ? 'top' : 'iframe',
    scrollEl: elInfo(scrollEl),
    canvasEl: elInfo(canvasEl),
    sameScrollAsCanvas,
    rectTopWindowForCrop: sr,
    canvasBoundingRect: cr
      ? { left: cr.left, top: cr.top, width: cr.width, height: cr.height }
      : null,
    hint,
  };
}

// Expose for popup and Test A (extension / content-script console only — not page console).
window.__paCapture = window.__paCapture || {};
window.__paCapture.activate       = activate;
window.__paCapture.cancelCapture  = cancelCapture;
window.__paCapture.state          = state;
window.__paCapture.inspect        = function inspectPaCaptureLayerFromContentWorld() {
  const out = buildInspectSnapshot();
  console.log('[PA Capture] inspect()', out);
  return out;
};

console.log('[PA Capture] content script loaded');
document.documentElement.setAttribute('data-pa-flow-capture', 'loaded');

// ─── Crop helper ─────────────────────────────────────────────────────────────

/**
 * Crop a dataURL image to a sub-rectangle (all values in device pixels).
 * Returns a new dataURL.
 */
async function cropImage(dataURL, cropX, cropY, cropW, cropH) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const imgW = img.width;
      const imgH = img.height;

      // Clamp crop rectangle to screenshot bounds.
      const x0 = Math.max(0, cropX);
      const y0 = Math.max(0, cropY);
      const w0 = Math.min(cropW, imgW - x0);
      const h0 = Math.min(cropH, imgH - y0);

      if (w0 <= 0 || h0 <= 0) {
        console.error('[PA Capture] crop clamp resulted in empty rect', {
          cropX, cropY, cropW, cropH, imgW, imgH, x0, y0, w0, h0
        });
        reject(new Error('Crop rect out of bounds'));
        return;
      }

      const c = document.createElement('canvas');
      c.width  = Math.max(1, Math.round(w0));
      c.height = Math.max(1, Math.round(h0));
      c.getContext('2d').drawImage(img, x0, y0, w0, h0, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

// ─── Tile capture loop ───────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCapture() {
  const region = state._region;
  const pointA = state.pointA;
  if (!region || !pointA) return;

  state._cancelled = false;
  const runId = ++state._runId;

  const { docLeft, docTop, docRight, docBottom,
          tileW, tileH, stepX, stepY, cols, rows, total } = region;
  // Measure the effective screenshot scale from `tabs.captureVisibleTab()`.
  // `window.devicePixelRatio` can differ in embedded/zoomed PowerApps frames,
  // which makes crop/stitch coordinates incorrect (blank tiles).
  let captureScaleX = null;
  let captureScaleY = null;
  /** Fetched once per run from main frame (`scripting.executeScript`) — matches `captureVisibleTab` layout. */
  let tabCaptureMetrics = null;
  state.tiles = [];
  let debugRawCaptured = false;
  let debugCroppedCaptured = false;
  let debugCropLogged = false;
  let debugCropAnnotatedDownloaded = false;
  let debugCropInBgDownloaded = false;

  let tileIndex = 0;
  state.mode = 'capturing';
  setCaptureButtonVisible(false);
  setOverlayVisible(false);
  setInternalCaptureUiVisible(false);
  showCaptureLock();
  updatePrecisionCursorMode();
  removeCanvasScrollListener();
  // Hide placement dots during capture; they can drift visually while we scroll tiles.
  state.dotA?.remove();
  state.dotA = null;
  state.dotB?.remove();
  state.dotB = null;
  browser.runtime.sendMessage({ type: 'state-update', mode: 'capturing', current: 0, total }).catch(() => {});

  preparePageForCapture();
  try {
  for (let row = 0; row < rows; row++) {
    let scrollTop = docTop + row * stepY;
    if (row === rows - 1) scrollTop = Math.max(scrollTop, docBottom - tileH);

    for (let col = 0; col < cols; col++) {
      const scrollEl = getActiveScrollEl();
      if (!scrollEl) {
        failCapture('No scroll container resolved');
        return;
      }
      let scrollLeft = docLeft + col * stepX;
      if (col === cols - 1) scrollLeft = Math.max(scrollLeft, docRight - tileW);

      scrollEl.scrollLeft = scrollLeft;
      scrollEl.scrollTop  = scrollTop;
      const effectiveDwellMs = Math.max(PA_TILE_DWELL_MIN_MS, state.dwellMs);
      await sleep(effectiveDwellMs);
      await sleep(PA_SCROLL_SETTLE_MS);

      if (state._cancelled || runId !== state._runId) return;

      // PA may clamp/round scroll positions. Re-read actual scroll so tile offsets
      // match what was actually rendered and stitched.
      const actualScrollLeft = scrollEl.scrollLeft;
      const actualScrollTop  = scrollEl.scrollTop;

      let dataURL;
      try {
        setInternalCaptureUiVisible(false);
        const resp = await browser.runtime.sendMessage({ type: 'capture' });
        if (resp.error) throw new Error(resp.error);
        dataURL = resp.dataURL;
      } catch (err) {
        failCapture('Tile capture failed', err);
        return;
      }

      if (state._cancelled || runId !== state._runId) return;

      // Download raw capture once to validate captureVisibleTab output is not blank.
      if (!debugRawCaptured && PA_CAPTURE_DEBUG_DOWNLOAD_RAW_CAPTURE_ONCE) {
        debugRawCaptured = true;
        try {
          const rawBlob = await (await fetch(dataURL)).blob();
          await browser.runtime.sendMessage({
            type: 'download-blob',
            blob: rawBlob,
            filename: `pa-capture-debug-raw-${Date.now()}.png`,
          });
        } catch (e) {
          console.error('[PA Capture] debug raw capture download failed', e);
        }
      }

      const measuredImg = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataURL;
      });
      const shotW = measuredImg.naturalWidth;
      const shotH = measuredImg.naturalHeight;

      if (PA_CAPTURE_USE_MAIN_FRAME_METRICS && !tabCaptureMetrics) {
        tabCaptureMetrics = await browser.runtime.sendMessage({ type: 'get-tab-capture-metrics' })
          .catch(() => null);
      }
      const metricsForCrop = PA_CAPTURE_USE_MAIN_FRAME_METRICS ? tabCaptureMetrics : null;

      // Crop to the active scroll viewport bounds (not broader wrapper canvas).
      // This excludes fixed chrome/toolbars that may surround the flow canvas.
      // `captureVisibleTab()` produces a screenshot in the top browsing context,
      // so we convert frame-local rects to top-window coordinates.
      const cropTargetEl = getActiveScrollEl() || state.canvasEl;
      const rectRaw = getRectRelativeToTopWindow(cropTargetEl);
      const rect = resolveRectForTabScreenshot(cropTargetEl, rectRaw, metricsForCrop);

      if (PA_CAPTURE_RECALC_SCALE_EACH_TILE || captureScaleX == null || captureScaleY == null) {
        const scales = pickCaptureScalesFromViewport(shotW, shotH, metricsForCrop);
        if (scales.captureScaleX == null || scales.captureScaleY == null) {
          failCapture('Capture scale invalid');
          return;
        }
        captureScaleX = scales.captureScaleX;
        captureScaleY = scales.captureScaleY;
      }

      if (PA_CAPTURE_DIAG_LOG && !rectRaw.reachedTop) {
        console.warn('[PA Capture] iframe chain may be incomplete — used main-frame metrics + optional largest-iframe rect', {
          href: (() => { try { return location.href.slice(0, 120); } catch { return ''; } })(),
          resolvedReachedTop: rect.reachedTop,
        });
      }

      let cropX = Math.round(rect.left  * captureScaleX);
      let cropY = Math.round(rect.top   * captureScaleY);
      let cropW = Math.max(1, Math.round(rect.width  * captureScaleX));
      let cropH = Math.max(1, Math.round(rect.height * captureScaleY));

      // Clamp crop rect to screenshot bounds before cropImage().
      // Without this, large negative coordinates can silently clamp to (0,0) and
      // effectively re-crop the whole viewport.
      const x0 = Math.max(0, Math.min(cropX, shotW - 1));
      const y0 = Math.max(0, Math.min(cropY, shotH - 1));
      const x1 = Math.max(x0 + 1, Math.min(cropX + cropW, shotW));
      const y1 = Math.max(y0 + 1, Math.min(cropY + cropH, shotH));
      const clampedCrop = {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0
      };

      // Debug-only: crop in the background (OffscreenCanvas) using the same
      // crop rectangle, to isolate whether the issue is content-script
      // canvas draw/toDataURL or the crop coordinates themselves.
      if (
        PA_CAPTURE_DEBUG_CROP_IN_BG_ONCE &&
        row === 0 &&
        col === 0 &&
        !debugCropInBgDownloaded
      ) {
        debugCropInBgDownloaded = true;
        try {
          const rawBlob = await (await fetch(dataURL)).blob();
          await browser.runtime.sendMessage({
            type: 'debug-crop-in-bg-download',
            blob: rawBlob,
            crop: clampedCrop,
            filename: `pa-capture-debug-cropped-inbg-${Date.now()}.png`,
          });
        } catch (e) {
          console.error('[PA Capture] debug crop-in-bg download failed', e);
        }
      }

      if (!debugCropLogged && row === 0 && col === 0) {
        debugCropLogged = true;
        console.log('[PA Capture] crop debug first tile', {
          shotW,
          shotH,
          captureScaleX,
          captureScaleY,
          cropTargetEl: {
            tag: cropTargetEl?.tagName,
            automationId: cropTargetEl?.getAttribute?.('data-automation-id') ?? null,
          },
          rectRaw,
          rect,
          cropX,
          cropY,
          cropW,
          cropH,
          clampedCrop
        });
      }

      // If the top-window rect couldn't be resolved through frame parents,
      // fall back to frame-local viewport coords.
      if (!rect.reachedTop) {
        const local = cropTargetEl.getBoundingClientRect();
        cropX = Math.round(local.left * captureScaleX);
        cropY = Math.round(local.top * captureScaleY);
        cropW = Math.max(1, Math.round(local.width * captureScaleX));
        cropH = Math.max(1, Math.round(local.height * captureScaleY));
      } else {
        cropX = clampedCrop.x;
        cropY = clampedCrop.y;
        cropW = clampedCrop.w;
        cropH = clampedCrop.h;
      }

      // Download an annotated raw screenshot with the crop rect overlay.
      // Helps validate that our crop coordinates land on the intended area.
      if (
        !debugCropAnnotatedDownloaded &&
        PA_CAPTURE_DEBUG_DOWNLOAD_CROP_ANNOTATED_ONCE &&
        row === 0 &&
        col === 0
      ) {
        debugCropAnnotatedDownloaded = true;
        try {
          const annCanvas = document.createElement('canvas');
          annCanvas.width = shotW;
          annCanvas.height = shotH;
          const ctx = annCanvas.getContext('2d');
          // measuredImg is already loaded above
          ctx.drawImage(measuredImg, 0, 0, shotW, shotH);
          ctx.strokeStyle = 'red';
          ctx.lineWidth = 4;
          ctx.strokeRect(clampedCrop.x, clampedCrop.y, clampedCrop.w, clampedCrop.h);

          const blob = await new Promise((resolve, reject) => {
            annCanvas.toBlob(b => {
              if (!b) reject(new Error('toBlob returned null'));
              else resolve(b);
            }, 'image/png');
          });
          await browser.runtime.sendMessage({
            type: 'download-blob',
            blob,
            filename: `pa-capture-debug-crop-annotated-${Date.now()}.png`,
          });
        } catch (e) {
          console.error('[PA Capture] debug crop annotated download failed', e);
        }
      }

      state.tiles.push({
        // Critical: don't crop in the content script.
        // Firefox content-script canvas -> toDataURL produced "no image" for PA tiles,
        // while background-cropping works.
        dataURL: dataURL, // raw captureVisibleTab screenshot
        docX:    actualScrollLeft - docLeft,
        docY:    actualScrollTop  - docTop,
        row,
        col,
        cssW:    rect.width,
        cssH:    rect.height,
        pxW:     cropW,
        pxH:     cropH,
        srcX:    cropX,
        srcY:    cropY,
        srcW:    cropW,
        srcH:    cropH,
      });

      if (PA_CAPTURE_DEBUG_RAW_TILES && tileIndex < PA_CAPTURE_DEBUG_TILE_LIMIT) {
        // Never send multi‑MB data: URLs through runtime.sendMessage — Firefox drops/limit errors (silent .catch before).
        (async () => {
          try {
            const res = await fetch(dataURL);
            if (!res.ok) throw new Error(`fetch data URL ${res.status}`);
            const blob = await res.blob();
            if (!blob?.size) throw new Error('empty debug tile blob');
            const dl = await browser.runtime.sendMessage({
              type: 'download-blob',
              blob,
              filename: `pa-capture-debug-tile-raw-r${row}-c${col}.png`
            });
            if (!dl?.ok) console.error('[PA Capture] debug tile download-blob rejected', dl);
          } catch (e) {
            console.error('[PA Capture] debug raw tile failed', e);
          }
        })();
      }

      tileIndex++;
      state._current = tileIndex;
      setLabel(`Capturing tile ${tileIndex} / ${total}…`);
      browser.runtime.sendMessage({ type: 'state-update', mode: 'capturing', current: tileIndex, total }).catch(() => {});

    }
  }

  if (state._cancelled || runId !== state._runId) return;

  // Restore scroll to Point A position
  const restoreScrollEl = getActiveScrollEl();
  if (restoreScrollEl) {
    restoreScrollEl.scrollLeft = pointA.scrollLeft;
    restoreScrollEl.scrollTop  = pointA.scrollTop;
  }

  await stitch(region, state.tiles, captureScaleX, captureScaleY);
  } finally {
    restorePageAfterCapture();
    restoreCaptureEffectiveZoom();
    setInternalCaptureUiVisible(true);
    updatePrecisionCursorMode();
  }
}

window.__paCapture.runCapture = runCapture;

// ─── Stitcher ─────────────────────────────────────────────────────────────────

/**
 * Stream tiles to the background: one `dataURL` per message so IPC never carries
 * the full stitched bitmap as a string/Blob from the page. The background keeps an
 * OffscreenCanvas, applies header bands, then `convertToBlob` + object URL for download
 * (no content-script `toDataURL` / `toBlob` on the full canvas).
 */
async function stitch(region, tiles, scaleX, scaleY) {
  const regionW = region.docRight - region.docLeft;
  const regionH = region.docBottom - region.docTop;

  setLabel(`Stitching ${tiles.length} / ${region.total}…`);

  if (!tiles?.length) {
    failCapture('No tiles to stitch');
    return;
  }
  if (scaleX == null || scaleY == null
      || !Number.isFinite(scaleX) || !Number.isFinite(scaleY)
      || scaleX <= 0 || scaleY <= 0) {
    failCapture('Invalid capture scale');
    return;
  }

  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  const ts   = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`
             + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `pa-flow-capture-${ts}.png`;

  const orderedTiles = [...tiles].sort((a, b) => {
    const ar = Number(a.row || 0);
    const br = Number(b.row || 0);
    if (ar !== br) return ar - br;
    const ac = Number(a.col || 0);
    const bc = Number(b.col || 0);
    return ac - bc;
  });

  const tileExcludeBox = { y: 0, h: 0 };

  const stitchRunId = `st-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (PA_CAPTURE_DIAG_LOG) {
    const t0 = orderedTiles[0];
    console.log('[PA Capture] stitch start', {
      stitchRunId,
      tileCount: orderedTiles.length,
      regionW,
      regionH,
      scaleX,
      scaleY,
      firstTile: t0 && {
        row: t0.row,
        col: t0.col,
        docX: t0.docX,
        docY: t0.docY,
        dataUrlLen: t0.dataURL?.length ?? 0,
        dataUrlPrefix: typeof t0.dataURL === 'string' ? t0.dataURL.slice(0, 48) : null,
      },
    });
  }

  const beginResp = await browser.runtime.sendMessage({
    type: 'stitch-begin',
    stitchRunId,
    regionW,
    regionH,
    scaleX,
    scaleY,
    excludeBox: tileExcludeBox,
    filename
  }).catch(err => ({ ok: false, error: err?.message || String(err) }));

  if (!beginResp?.ok) {
    failCapture(`Stitch init failed${beginResp?.error ? `: ${beginResp.error}` : ''}`);
    return;
  }

  let i = 0;
  for (const tile of orderedTiles) {
    i += 1;
    setLabel(`Stitching tile ${i} / ${orderedTiles.length}…`);
    const resp = await browser.runtime.sendMessage({
      type: 'stitch-tile',
      stitchRunId,
      dataURL: tile.dataURL,
      docX: tile.docX,
      docY: tile.docY,
      row: tile.row,
      col: tile.col,
      srcX: tile.srcX,
      srcY: tile.srcY,
      srcW: tile.srcW,
      srcH: tile.srcH
    }).catch(err => ({ ok: false, error: err?.message || String(err) }));

    if (!resp?.ok) {
      if (PA_CAPTURE_DIAG_LOG) {
        console.warn('[PA Capture] stitch-tile failed', { i, stitchRunId, resp });
      }
      await browser.runtime.sendMessage({ type: 'stitch-abort', stitchRunId }).catch(() => {});
      failCapture(`Stitch failed (tile ${i})${resp?.error ? `: ${resp.error}` : ''}`);
      return;
    }
    if (PA_CAPTURE_DIAG_LOG && resp.stats) {
      console.log('[PA Capture] stitch-tile ok', i, resp.stats);
    }
  }

  setLabel('Finalizing and downloading…');

  const fin = await browser.runtime.sendMessage({ type: 'stitch-finish', stitchRunId })
    .catch(err => ({ ok: false, error: err?.message || String(err) }));

  if (!fin?.ok) {
    await browser.runtime.sendMessage({ type: 'stitch-abort', stitchRunId }).catch(() => {});
    failCapture(`Download failed${fin?.error ? `: ${fin.error}` : ''}`);
    return;
  }

  setLabel('Done — downloading…');
  state.mode = 'done';
  setOverlayVisible(true);
  updateOverlayButtons();
  browser.runtime.sendMessage({ type: 'state-update', mode: 'done' }).catch(() => {});
  setTimeout(() => removeOverlay(), 2000);
}

// ─── Message listener (from popup) ───────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get-state') {
    // If this frame is idle, don't respond.
    // With `all_frames: true`, the popup `sendMessage()` may otherwise get the
    // response from an unrelated frame first.
    if (!state._claimed) return false;
    if (state.mode === 'idle' && !state._region) return false;

    sendResponse({
      mode: state.mode,
      current: state._current,
      total: state._region?.total,
      error: state._lastError || undefined,
    });
    return false;
  }
  if (msg.type === 'activate') {
    activate(msg.dwellMs, msg.claimRunId);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'cancel') {
    cancelCapture();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'start-capture') {
    if (!state._claimed) return false;
    runCapture();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'get-inspect-snapshot') {
    try {
      sendResponse(buildInspectSnapshot());
    } catch (e) {
      sendResponse({ error: e?.message || String(e) });
    }
    return false;
  }
});

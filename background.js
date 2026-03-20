// PA Flow Capture — background script
// Must run in background context: only place captureVisibleTab is available.

const pendingRevocations = new Map(); // downloadId → blobUrl
const captureClaims = new Map(); // key => { createdAt, candidates: Array<{ nonce, score, frameId, sendResponse }>, timer }
/** After a successful `claim`, popup + tools target this frame so the user does not pick an iframe manually. */
const captureOwnerByTab = new Map(); // tabId → { frameId, runId }
/** Monotonic per-tab id so every frame shares one `claim` bucket when `broadcast-activate` runs (isolated worlds each had their own `++_runId` before). */
const tabClaimRunSeq = new Map(); // tabId → number

function nextTabClaimRunId(tabId) {
  const n = (tabClaimRunSeq.get(tabId) ?? 0) + 1;
  tabClaimRunSeq.set(tabId, n);
  return n;
}

/**
 * Fill colour under tiles / band-copy gaps. Match PA flow canvas (#fff) so any 1px
 * slit from rounding is invisible; see seam plan (A) in repo docs / PA capture notes.
 */
const PA_FLOW_CANVAS_BG = '#ffffff';

/** Set `true` to log console.assert if band merge + segments do not partition canvas height. */
const PA_STITCH_DEBUG_ASSERT = false;

/**
 * Verbose logging in extension background (about:debugging → Inspect). Mirror flag name in content.js.
 */
const PA_CAPTURE_DIAG_LOG = true;

function diagLog(...args) {
  if (PA_CAPTURE_DIAG_LOG) console.log('[PA Capture bg]', ...args);
}

// Horizontal seam matching knobs (lightweight grayscale SAD).
const PA_SEAM_MATCH_MAX_SHIFT_PX = 12;
const PA_SEAM_MATCH_MAX_OVERLAP_PX = 220;
const PA_SEAM_MATCH_MIN_OVERLAP_PX = 24;
const PA_SEAM_MATCH_SAMPLE_STEP = 2;
const PA_SEAM_MATCH_MIN_SHARED_HEIGHT = 40;
const PA_SEAM_MATCH_EDGE_MARGIN_PX = 6;

/**
 * Decode `data:image/...;base64,...` without `fetch(data:...)`.
 * Firefox (and some Chromium) extension backgrounds reject or mishandle `fetch` on data URLs,
 * which yields empty/failed tile decode → no `drawImage` calls → solid fill PNG (looks “blank”).
 */
function dataURLToBlob(dataURL) {
  if (typeof dataURL !== 'string' || !dataURL.startsWith('data:')) {
    throw new Error('Not a data URL');
  }
  const comma = dataURL.indexOf(',');
  if (comma < 0) throw new Error('Malformed data URL');
  const meta = dataURL.slice(0, comma);
  const payload = dataURL.slice(comma + 1);
  const mimeMatch = /^data:([^;,]+)/.exec(meta);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  if (/;base64/i.test(meta)) {
    let binary;
    try {
      binary = atob(payload);
    } catch (e) {
      throw new Error(`atob: ${e?.message || e}`);
    }
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(payload)], { type: mime });
}

/** In-progress stitch: one tile per message (avoids single giant IPC payload). */
const stitchSessions = new Map(); // stitchRunId → session

function pruneCaptureClaims(maxAgeMs = 5 * 60 * 1000) {
  const now = Date.now();
  for (const [k, v] of captureClaims.entries()) {
    if (!v?.createdAt || now - v.createdAt > maxAgeMs) {
      try {
        if (v?.timer) clearTimeout(v.timer);
      } catch { /* ignore */ }
      captureClaims.delete(k);
    }
  }
}

function pruneStitchSessions(maxAgeMs = 15 * 60 * 1000) {
  const now = Date.now();
  for (const [id, s] of stitchSessions.entries()) {
    if (!s?.createdAt || now - s.createdAt > maxAgeMs) stitchSessions.delete(id);
  }
}

/** Merge vertical cut intervals and copy kept spans into one output canvas. */
function applyMergedHorizontalBands(sourceCanvas, bands) {
  if (!bands.length) return sourceCanvas;
  const H = sourceCanvas.height;
  const merged = [];
  const sorted = [...bands].map(b => ({
    y0: Math.max(0, Math.min(H, b.y0)),
    y1: Math.max(0, Math.min(H, b.y1))
  })).filter(b => b.y1 > b.y0).sort((a, b) => a.y0 - b.y0);

  for (const b of sorted) {
    if (!merged.length || b.y0 > merged[merged.length - 1].y1) {
      merged.push({ y0: b.y0, y1: b.y1 });
    } else {
      merged[merged.length - 1].y1 = Math.max(merged[merged.length - 1].y1, b.y1);
    }
  }

  const segments = [];
  let cur = 0;
  for (const iv of merged) {
    if (iv.y0 > cur) segments.push({ y0: cur, h: iv.y0 - cur });
    cur = Math.max(cur, iv.y1);
  }
  if (cur < H) segments.push({ y0: cur, h: H - cur });

  if (PA_STITCH_DEBUG_ASSERT) {
    const removedPx = merged.reduce((s, m) => s + (m.y1 - m.y0), 0);
    const keptPx = segments.reduce((s, g) => s + g.h, 0);
    console.assert(
      keptPx + removedPx === H,
      '[PA Capture] band partition',
      { keptPx, removedPx, H, mergedCount: merged.length, segmentCount: segments.length }
    );
  }

  const outH = segments.reduce((s, g) => s + g.h, 0);
  if (outH <= 0 || segments.length === 0) return sourceCanvas;
  const out = new OffscreenCanvas(sourceCanvas.width, Math.max(1, outH));
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.fillStyle = PA_FLOW_CANVAS_BG;
  octx.fillRect(0, 0, out.width, out.height);
  const W = sourceCanvas.width;
  let dy = 0;
  for (const seg of segments) {
    octx.drawImage(
      sourceCanvas,
      0, seg.y0, W, seg.h,
      0, dy, W, seg.h
    );
    dy += seg.h;
  }
  return out;
}

function lumaAt(data, idx) {
  // Integer approximation of Rec.709 luma.
  return (54 * data[idx] + 183 * data[idx + 1] + 19 * data[idx + 2]) >> 8;
}

function computeShiftSad(canvasData, tileData, w, h, shift, sampleStep) {
  let sad = 0;
  let count = 0;
  const xStart = Math.max(0, -shift);
  const xEnd = Math.min(w, w - shift);
  if (xEnd <= xStart) return Number.POSITIVE_INFINITY;

  for (let y = 0; y < h; y += sampleStep) {
    const rowBase = y * w;
    for (let x = xStart; x < xEnd; x += sampleStep) {
      const xi = x + shift;
      const i1 = ((rowBase + x) << 2);
      const i2 = ((rowBase + xi) << 2);
      sad += Math.abs(lumaAt(canvasData, i1) - lumaAt(tileData, i2));
      count += 1;
    }
  }
  return count > 0 ? sad / count : Number.POSITIVE_INFINITY;
}

function findBestHorizontalSeamCut({
  canvasData,
  tileData,
  w,
  h,
  shift,
  sampleStep,
  edgeMargin
}) {
  const xStart = Math.max(0, -shift);
  const xEnd = Math.min(w, w - shift);
  if (xEnd - xStart <= edgeMargin * 2) {
    return Math.floor(w / 2);
  }

  // Per-column mismatch score.
  const colScore = new Float64Array(w);
  const colCount = new Uint32Array(w);
  for (let y = 0; y < h; y += sampleStep) {
    const rowBase = y * w;
    for (let x = xStart; x < xEnd; x += sampleStep) {
      const xi = x + shift;
      const i1 = ((rowBase + x) << 2);
      const i2 = ((rowBase + xi) << 2);
      colScore[x] += Math.abs(lumaAt(canvasData, i1) - lumaAt(tileData, i2));
      colCount[x] += 1;
    }
  }
  for (let x = xStart; x < xEnd; x++) {
    if (colCount[x] > 0) colScore[x] /= colCount[x];
    else colScore[x] = Number.POSITIVE_INFINITY;
  }

  // Windowed smooth score around each seam candidate.
  const window = Math.max(2, Math.floor(6 / sampleStep));
  let bestX = Math.floor((xStart + xEnd) / 2);
  let bestScore = Number.POSITIVE_INFINITY;
  const seamStart = xStart + edgeMargin;
  const seamEnd = xEnd - edgeMargin;
  for (let x = seamStart; x < seamEnd; x++) {
    let score = 0;
    let n = 0;
    for (let k = -window; k <= window; k++) {
      const xx = x + k;
      if (xx < xStart || xx >= xEnd) continue;
      score += colScore[xx];
      n += 1;
    }
    if (n === 0) continue;
    score /= n;
    if (score < bestScore) {
      bestScore = score;
      bestX = x;
    }
  }
  return bestX;
}

function computeHorizontalSeamAdjustment(session, params) {
  const { row, col, destX, destY, srcX, srcY, srcW, srcH, bitmap } = params;
  if (!(col > 0)) return null;
  const prev = session.lastTileByRow.get(row);
  if (!prev) return null;

  const prevRight = prev.destX + prev.drawW;
  const nominalOverlap = prevRight - destX;
  if (!(nominalOverlap >= PA_SEAM_MATCH_MIN_OVERLAP_PX)) return null;

  const overlapW = Math.min(Math.floor(nominalOverlap), PA_SEAM_MATCH_MAX_OVERLAP_PX, srcW, prev.drawW);
  if (!(overlapW >= PA_SEAM_MATCH_MIN_OVERLAP_PX)) return null;

  const yTop = Math.max(destY, prev.destY);
  const yBottom = Math.min(destY + srcH, prev.destY + prev.drawH);
  const sharedH = yBottom - yTop;
  if (!(sharedH >= PA_SEAM_MATCH_MIN_SHARED_HEIGHT)) return null;

  const canvasOverlapX = destX;
  const canvasOverlapY = yTop;
  const tileOverlapSrcX = srcX;
  const tileOverlapSrcY = srcY + (yTop - destY);

  // Read already-drawn overlap from stitch canvas.
  const ctx = session.ctx;
  const canvasImg = ctx.getImageData(canvasOverlapX, canvasOverlapY, overlapW, sharedH);
  const canvasData = canvasImg.data;

  // Read candidate overlap from incoming tile bitmap.
  const tmp = new OffscreenCanvas(overlapW, sharedH);
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(
    bitmap,
    tileOverlapSrcX, tileOverlapSrcY, overlapW, sharedH,
    0, 0, overlapW, sharedH
  );
  const tileImg = tctx.getImageData(0, 0, overlapW, sharedH);
  const tileData = tileImg.data;

  // 1) Best horizontal alignment shift.
  const maxShift = Math.min(PA_SEAM_MATCH_MAX_SHIFT_PX, Math.floor(overlapW / 4));
  let bestShift = 0;
  let bestSad = Number.POSITIVE_INFINITY;
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const sad = computeShiftSad(canvasData, tileData, overlapW, sharedH, shift, PA_SEAM_MATCH_SAMPLE_STEP);
    if (sad < bestSad) {
      bestSad = sad;
      bestShift = shift;
    }
  }

  // 2) Best seam cut column inside overlap (after shift alignment).
  const seamX = findBestHorizontalSeamCut({
    canvasData,
    tileData,
    w: overlapW,
    h: sharedH,
    shift: bestShift,
    sampleStep: PA_SEAM_MATCH_SAMPLE_STEP,
    edgeMargin: PA_SEAM_MATCH_EDGE_MARGIN_PX
  });

  return {
    bestShift,
    seamCutPx: seamX,
    overlapW,
    sharedH,
    bestSad
  };
}

async function drawStitchTile(session, msg) {
  const { canvasW, canvasH, scaleX, scaleY, ctx } = session;
  session.tilesReceived += 1;

  const docX = Number(msg.docX || 0);
  const docY = Number(msg.docY || 0);
  const row = Number(msg.row ?? 0);
  // Row 0: round aligns top. Row > 0: floor pulls tile up ≥1 device px vs round in typical
  // stepY*scale cases, closing hairline slits between rows (seam plan B).
  let destX = Math.round(docX * scaleX);
  let destY = row > 0 ? Math.floor(docY * scaleY) : Math.round(docY * scaleY);

  let blob;
  try {
    blob = dataURLToBlob(msg.dataURL);
  } catch (eDecode) {
    try {
      const res = await fetch(msg.dataURL);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      blob = await res.blob();
    } catch (eFetch) {
      throw new Error(`Tile decode: ${eDecode?.message || eDecode}; fetch: ${eFetch?.message || eFetch}`);
    }
  }
  if (!blob || blob.size === 0) throw new Error('Empty tile blob after decode');

  const bitmap = await createImageBitmap(blob);
  const stats = {
    row: msg.row,
    col: msg.col,
    bitmapW: bitmap.width,
    bitmapH: bitmap.height,
    destX,
    destY,
    drawW: 0,
    drawH: 0,
    drew: false,
    skip: null
  };
  try {
    // Source crop inside the raw screenshot bitmap (device pixels).
    // We crop in the background to avoid Firefox content-script canvas/toDataURL issues.
    let srcX = Number(msg.srcX ?? 0);
    let srcY = Number(msg.srcY ?? 0);
    let srcW = Number(msg.srcW ?? bitmap.width);
    let srcH = Number(msg.srcH ?? bitmap.height);

    if (!Number.isFinite(srcX)) srcX = 0;
    if (!Number.isFinite(srcY)) srcY = 0;
    if (!Number.isFinite(srcW) || srcW <= 0) srcW = bitmap.width;
    if (!Number.isFinite(srcH) || srcH <= 0) srcH = bitmap.height;

    // Clamp to decoded bitmap bounds before drawing.
    if (bitmap.width > 1) srcX = Math.max(0, Math.min(srcX, bitmap.width - 1));
    if (bitmap.height > 1) srcY = Math.max(0, Math.min(srcY, bitmap.height - 1));
    srcW = Math.max(1, Math.min(srcW, bitmap.width - srcX));
    srcH = Math.max(1, Math.min(srcH, bitmap.height - srcY));

    if (destX < 0) {
      srcX += -destX;
      srcW -= -destX;
      destX = 0;
    }
    if (destY < 0) {
      srcY += -destY;
      srcH -= -destY;
      destY = 0;
    }
    if (destX + srcW > canvasW) srcW = Math.max(0, canvasW - destX);
    if (destY + srcH > canvasH) srcH = Math.max(0, canvasH - destY);

    // Horizontal seam matching for non-first columns: align + choose seam cut
    // from overlap using grayscale SAD so spacing is driven by content, not
    // fixed overlap geometry.
    if ((Number(msg.col ?? 0) > 0) && srcW > 0 && srcH > 0) {
      const seam = computeHorizontalSeamAdjustment(session, {
        row: Number(msg.row ?? 0),
        col: Number(msg.col ?? 0),
        destX,
        destY,
        srcX,
        srcY,
        srcW,
        srcH,
        bitmap
      });
      if (seam) {
        const shiftedDestX = destX + seam.bestShift;
        const prev = session.lastTileByRow.get(Number(msg.row ?? 0));
        const prevRight = prev ? (prev.destX + prev.drawW) : shiftedDestX;
        const overlapAfterShift = Math.max(0, prevRight - shiftedDestX);
        const seamCut = Math.max(0, Math.min(seam.seamCutPx, overlapAfterShift, srcW));

        destX = shiftedDestX + seamCut;
        srcX += seamCut;
        srcW -= seamCut;

        stats.seam = {
          shift: seam.bestShift,
          cut: seamCut,
          overlapW: seam.overlapW,
          sharedH: seam.sharedH,
          sad: seam.bestSad
        };
      }
    }

    if (destX < 0) {
      srcX += -destX;
      srcW -= -destX;
      destX = 0;
    }
    if (destY < 0) {
      srcY += -destY;
      srcH -= -destY;
      destY = 0;
    }
    if (destX + srcW > canvasW) srcW = Math.max(0, canvasW - destX);
    if (destY + srcH > canvasH) srcH = Math.max(0, canvasH - destY);

    stats.destX = destX;
    stats.destY = destY;
    stats.drawW = srcW;
    stats.drawH = srcH;

    if (srcW <= 0 || srcH <= 0) {
      session.tilesSkippedClip += 1;
      stats.skip = 'zero_clip';
      diagLog('tile skipped (clip)', stats, { canvasW, canvasH });
      return stats;
    }

    ctx.drawImage(bitmap, srcX, srcY, srcW, srcH, destX, destY, srcW, srcH);
    session.tilesDrawn += 1;
    stats.drew = true;
    session.lastTileByRow.set(Number(msg.row ?? 0), {
      destX,
      destY,
      drawW: srcW,
      drawH: srcH
    });
    diagLog('tile drawn', stats);
    return stats;
  } finally {
    try { bitmap.close(); } catch { /* ignore */ }
  }
}

async function finalizeStitchSession(stitchRunId) {
  const session = stitchSessions.get(stitchRunId);
  if (!session) throw new Error('Invalid stitch session');

  const { canvas, canvasW, canvasH, scaleX, scaleY, excludeBox, filename } = session;
  let outCanvas = canvas;

  if (excludeBox) {
    const bandY = Math.round(Number(excludeBox.y || 0) * scaleY);
    const bandH = Math.max(0, Math.round(Number(excludeBox.h || 0) * scaleY));
    if (bandH > 0 && session.byRow.size > 0) {
      // `byRow` stores device-pixel destY for each row (already rounded
      // consistently with `drawStitchTile`), so we do not multiply by scaleY.
      const rowStarts = [...session.byRow.values()].map(y => Number(y)).sort((a, b) => a - b);
      const bands = rowStarts.map(y => ({
        y0: y + bandY,
        y1: Math.min(canvasH, y + bandY + bandH)
      }));
      outCanvas = applyMergedHorizontalBands(canvas, bands);
    }
  }

  const outBlob = await outCanvas.convertToBlob({ type: 'image/png' });
  diagLog('finalize', {
    outBlobBytes: outBlob?.size ?? 0,
    tilesReceived: session.tilesReceived,
    tilesDrawn: session.tilesDrawn,
    tilesSkippedClip: session.tilesSkippedClip
  });

  if (session.tilesDrawn === 0 && session.tilesReceived > 0) {
    const msg = `No pixels drawn from ${session.tilesReceived} tiles (all clipped off-canvas or bitmap decode failed). Canvas ${canvasW}x${canvasH}, skippedClip=${session.tilesSkippedClip}. Enable PA_CAPTURE_DIAG_LOG in content.js + background.js.`;
    console.error('[PA Capture] BLANK PNG — not downloading.', msg);
    stitchSessions.delete(stitchRunId);
    throw new Error(msg);
  }

  const blobUrl = URL.createObjectURL(outBlob);
  const downloadId = await browser.downloads.download({ url: blobUrl, filename, saveAs: false });
  pendingRevocations.set(downloadId, blobUrl);
  stitchSessions.delete(stitchRunId);
}

browser.tabs.onRemoved.addListener(tabId => {
  captureOwnerByTab.delete(tabId);
  tabClaimRunSeq.delete(tabId);
});

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get-capture-owner') {
    sendResponse(captureOwnerByTab.get(msg.tabId) ?? null);
    return false;
  }

  if (msg.type === 'clear-capture-owner') {
    if (msg.tabId != null) captureOwnerByTab.delete(msg.tabId);
    sendResponse({ ok: true });
    return false;
  }

  /** Content script: drop owner mapping when this frame releases capture (cancel / restart). */
  if (msg.type === 'release-capture-owner') {
    const tabId = sender?.tab?.id;
    const frameId = typeof sender?.frameId === 'number' ? sender.frameId : 0;
    const owner = tabId != null ? captureOwnerByTab.get(tabId) : undefined;
    if (owner && owner.frameId === frameId) {
      captureOwnerByTab.delete(tabId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'broadcast-activate') {
    const tabId = msg.tabId;
    const dwellMs = msg.dwellMs;
    const autoZoom = !!msg.autoZoom;
    (async () => {
      try {
        // Primary auto-zoom path: normalize browser tab zoom to 100%.
        // On desktop Firefox, visualViewport.scale can remain 1 even when
        // tab/page zoom is not 100%, so content-side detection alone may not work.
        if (autoZoom && typeof tabId === 'number') {
          try {
            const curZoom = await browser.tabs.getZoom(tabId);
            if (Number.isFinite(curZoom) && Math.abs(curZoom - 1) > 0.001) {
              await browser.tabs.setZoom(tabId, 1);
              diagLog('tab zoom reset to 100%', { tabId, from: curZoom, to: 1 });
            }
          } catch (zoomErr) {
            // Keep capture functional even if tab zoom APIs are unavailable
            // (content script still has CSS-zoom fallback).
            console.warn('[PA Capture] setZoom(100%) failed', zoomErr);
          }
        }

        const claimRunId = nextTabClaimRunId(tabId);
        const frames = await browser.webNavigation.getAllFrames({ tabId });
        for (const f of frames) {
          try {
            await browser.tabs.sendMessage(
              tabId,
              { type: 'activate', dwellMs, claimRunId, autoZoom },
              { frameId: f.frameId }
            );
          } catch { /* frame has no content script */ }
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'get-inspect-snapshot') {
    const tabId = msg.tabId;
    (async () => {
      const owner = captureOwnerByTab.get(tabId);
      if (!owner) {
        sendResponse({ ok: false, error: 'No owner frame yet — use Start Capture on this tab first.' });
        return;
      }
      try {
        const snap = await browser.tabs.sendMessage(tabId, { type: 'get-inspect-snapshot' }, { frameId: owner.frameId });
        sendResponse({ ok: true, snapshot: snap });
      } catch (e) {
        captureOwnerByTab.delete(tabId);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  /**
   * Main-frame layout + largest iframe box. Iframe content scripts often mis-read `window.top`
   * for scale; `executeScript` runs in the tab’s top document where metrics match `captureVisibleTab`.
   */
  if (msg.type === 'get-tab-capture-metrics') {
    const tabId = sender?.tab?.id;
    if (tabId == null) {
      sendResponse(null);
      return false;
    }
    (async () => {
      try {
        const [inj] = await browser.scripting.executeScript({
          target: { tabId },
          func: () => {
            const vv = window.visualViewport;
            const d = document.documentElement;
            const metrics = {
              vvW: Number(vv?.width || 0),
              vvH: Number(vv?.height || 0),
              iw: Number(window.innerWidth || 0),
              ih: Number(window.innerHeight || 0),
              cw: Number(d?.clientWidth || 0),
              ch: Number(d?.clientHeight || 0)
            };
            let bestIframe = null;
            for (const f of document.querySelectorAll('iframe')) {
              const r = f.getBoundingClientRect();
              const a = r.width * r.height;
              if (a < 4 || r.width < 8 || r.height < 8) continue;
              if (!bestIframe || a > bestIframe.a) {
                bestIframe = { left: r.left, top: r.top, width: r.width, height: r.height, a };
              }
            }
            return { metrics, bestIframe };
          }
        });
        sendResponse(inj?.result ?? null);
      } catch (e) {
        console.warn('[PA Capture] get-tab-capture-metrics failed', e);
        sendResponse(null);
      }
    })();
    return true;
  }

  if (msg.type === 'capture') {
    browser.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' })
      .then(dataURL => sendResponse({ dataURL }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'debug-crop-in-bg-download') {
    (async () => {
      try {
        const blob = msg.blob;
        const crop = msg.crop || {};
        const cropX = Math.max(0, Number(crop.x || 0));
        const cropY = Math.max(0, Number(crop.y || 0));
        const cropW = Math.max(1, Number(crop.w || 1));
        const cropH = Math.max(1, Number(crop.h || 1));

        if (!blob || blob.size === 0) throw new Error('Empty raw blob');

        const bitmap = await createImageBitmap(blob);
        // Clamp crop to bitmap bounds to avoid transparent/blank output.
        const x0 = Math.min(cropX, bitmap.width - 1);
        const y0 = Math.min(cropY, bitmap.height - 1);
        const w0 = Math.max(1, Math.min(cropW, bitmap.width - x0));
        const h0 = Math.max(1, Math.min(cropH, bitmap.height - y0));

        const out = new OffscreenCanvas(w0, h0);
        const ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = false;

        ctx.drawImage(
          bitmap,
          x0, y0, w0, h0,
          0, 0, w0, h0
        );

        const outBlob = await out.convertToBlob({ type: 'image/png' });
        if (!outBlob || outBlob.size === 0) throw new Error('Cropped blob empty');

        const blobUrl = URL.createObjectURL(outBlob);
        const filename = String(msg.filename || 'pa-capture-debug-cropped-inbg.png');
        const downloadId = await browser.downloads.download({ url: blobUrl, filename, saveAs: false });
        pendingRevocations.set(downloadId, blobUrl);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[PA Capture] debug crop-in-bg failed', e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'claim') {
    pruneCaptureClaims();
    const tabId = sender?.tab?.id;
    const runId = msg.runId;
    const nonce = msg.nonce;
    const canvasScore = Number(msg.canvasScore ?? 0);

    if (tabId == null || runId == null) {
      sendResponse({ claimed: false });
      return false;
    }

    if (!nonce) {
      sendResponse({ claimed: false });
      return false;
    }

    const key = `${tabId}:${runId}`;

    if (!captureClaims.has(key)) {
      captureClaims.set(key, {
        createdAt: Date.now(),
        candidates: [],
        timer: null
      });
    }

    const frameId = typeof sender?.frameId === 'number' ? sender.frameId : 0;
    const entry = captureClaims.get(key);
    entry.candidates.push({
      nonce,
      score: Number.isFinite(canvasScore) ? canvasScore : 0,
      frameId,
      sendResponse
    });

    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        const best = entry.candidates.reduce((acc, c) => {
          if (!acc) return c;
          if (c.score > acc.score) return c;
          // Same score: prefer a deeper frame (PA designer is usually in an iframe).
          if (c.score === acc.score && c.frameId > acc.frameId) return c;
          return acc;
        }, null);

        if (best) {
          captureOwnerByTab.set(tabId, { frameId: best.frameId ?? 0, runId });
        }

        for (const c of entry.candidates) {
          try {
            c.sendResponse({ claimed: c.nonce === best?.nonce });
          } catch { /* ignore */ }
        }
        captureClaims.delete(key);
      }, 150);
    }

    return true;
  }

  if (msg.type === 'download') {
    browser.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then(downloadId => {
        pendingRevocations.set(downloadId, msg.url);
      })
      .catch(err => console.error('[PA Capture] download failed', err));
    return false;
  }

  if (msg.type === 'download-blob') {
    const blob = msg.blob;
    if (!blob || blob.size === 0) {
      sendResponse({ ok: false, error: 'Empty or missing blob' });
      return true;
    }
    const blobUrl = URL.createObjectURL(blob);
    browser.downloads.download({ url: blobUrl, filename: msg.filename, saveAs: false })
      .then(downloadId => {
        pendingRevocations.set(downloadId, blobUrl);
        sendResponse({ ok: true });
      })
      .catch(err => {
        console.error('[PA Capture] download-blob failed', err);
        try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true;
  }

  if (msg.type === 'download-data-url') {
    (async () => {
      try {
        const blob = dataURLToBlob(msg.dataURL);
        const blobUrl = URL.createObjectURL(blob);
        const downloadId = await browser.downloads.download({ url: blobUrl, filename: msg.filename, saveAs: false });
        pendingRevocations.set(downloadId, blobUrl);
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[PA Capture] download-data-url failed', err);
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === 'stitch-begin') {
    try {
      pruneStitchSessions();
      const stitchRunId = msg.stitchRunId;
      if (!stitchRunId || typeof stitchRunId !== 'string') {
        sendResponse({ ok: false, error: 'Missing stitchRunId' });
        return true;
      }
      const regionW = Number(msg.regionW) || 1;
      const regionH = Number(msg.regionH) || 1;
      const scaleX = Number(msg.scaleX) || 1;
      const scaleY = Number(msg.scaleY) || 1;
      const canvasW = Math.max(1, Math.round(regionW * scaleX));
      const canvasH = Math.max(1, Math.round(regionH * scaleY));

      const canvas = new OffscreenCanvas(canvasW, canvasH);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = PA_FLOW_CANVAS_BG;
      ctx.fillRect(0, 0, canvasW, canvasH);

      stitchSessions.set(stitchRunId, {
        createdAt: Date.now(),
        canvas,
        ctx,
        canvasW,
        canvasH,
        scaleX,
        scaleY,
        excludeBox: msg.excludeBox || null,
        filename: String(msg.filename || 'pa-flow-capture.png'),
        byRow: new Map(),
        lastTileByRow: new Map(),
        tilesReceived: 0,
        tilesDrawn: 0,
        tilesSkippedClip: 0
      });
      diagLog('stitch-begin', { stitchRunId, canvasW, canvasH, scaleX, scaleY });
      sendResponse({ ok: true });
    } catch (e) {
      console.error('[PA Capture] stitch-begin failed', e);
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
    return true;
  }

  if (msg.type === 'stitch-tile') {
    (async () => {
      try {
        const session = stitchSessions.get(msg.stitchRunId);
        if (!session) {
          sendResponse({ ok: false, error: 'Invalid or expired stitch session' });
          return;
        }
        const stats = await drawStitchTile(session, msg);
        const row = Number(msg.row ?? 0);
        // Store the actual device-pixel y where this row's tiles were drawn,
        // so the header-band removal aligns with the draw rounding.
        if (!session.byRow.has(row)) {
          session.byRow.set(row, Number(stats?.destY ?? 0));
        }
        sendResponse({ ok: true, stats });
      } catch (e) {
        console.error('[PA Capture] stitch-tile failed', e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'stitch-finish') {
    (async () => {
      try {
        await finalizeStitchSession(msg.stitchRunId);
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[PA Capture] stitch-finish failed', e);
        if (msg.stitchRunId) stitchSessions.delete(msg.stitchRunId);
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'stitch-abort') {
    stitchSessions.delete(msg.stitchRunId);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

browser.downloads.onChanged.addListener(delta => {
  if (!delta.state) return;
  const terminal = delta.state.current === 'complete' || delta.state.current === 'interrupted';
  if (terminal && pendingRevocations.has(delta.id)) {
    const blobUrl = pendingRevocations.get(delta.id);
    pendingRevocations.delete(delta.id);
    try {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    } catch (e) {
      console.warn('[PA Capture] URL revoke failed', e);
    }
  }
});

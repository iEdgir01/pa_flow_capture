// PA Flow Capture — popup

const statusEl   = document.getElementById('status');
const dwellEl    = document.getElementById('dwell');
const dwellValue = document.getElementById('dwell-value');
const autoZoomEl = document.getElementById('auto-zoom');
const btnStart   = document.getElementById('btn-start');
const btnCancel  = document.getElementById('btn-cancel');

const STATUS_LABELS = {
  idle:        'Idle',
  'placing-a': 'Click top-left of flow…',
  'placing-b': 'Click bottom-right of flow…',
  ready:       'Region set — click Capture',
  capturing:   'Capturing…',
  done:        'Done!',
  error:       'Capture failed',
};

dwellEl.addEventListener('input', () => {
  dwellValue.textContent = dwellEl.value + ' ms';
});

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Routes to the frame that won `claim` (designer iframe), so the popup does not rely on the browser picking the top frame. */
async function sendToCaptureFrame(tabId, message) {
  let owner = null;
  try {
    owner = await browser.runtime.sendMessage({ type: 'get-capture-owner', tabId });
  } catch { /* ignore */ }
  if (owner && typeof owner.frameId === 'number') {
    try {
      return await browser.tabs.sendMessage(tabId, message, { frameId: owner.frameId });
    } catch {
      await browser.runtime.sendMessage({ type: 'clear-capture-owner', tabId }).catch(() => {});
    }
  }
  return browser.tabs.sendMessage(tabId, message);
}

async function refreshState() {
  try {
    const tab = await getActiveTab();
    if (!tab) return;
    const resp = await sendToCaptureFrame(tab.id, { type: 'get-state' });
    applyState(resp);
  } catch { /* content script not ready yet */ }
}

function applyState(resp) {
  if (!resp) return;
  const { mode, current, total } = resp;

  if (mode === 'capturing' && current != null) {
    statusEl.textContent = `Capturing tile ${current} / ${total}`;
  } else if (mode === 'error' && resp.error) {
    statusEl.textContent = `Error: ${resp.error}`;
  } else {
    statusEl.textContent = STATUS_LABELS[mode] || mode;
  }

  const active  = mode !== 'idle' && mode !== 'done' && mode !== 'error';
  const ready   = mode === 'ready';

  btnStart.disabled    = active && !ready;
  btnStart.textContent = ready ? 'Capture!' : 'Start Capture';
  btnCancel.style.display = active ? 'block' : 'none';
}

btnStart.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;

  const currentState = await sendToCaptureFrame(tab.id, { type: 'get-state' }).catch(() => null);

  if (currentState?.mode === 'ready') {
    await sendToCaptureFrame(tab.id, { type: 'start-capture' });
  } else {
    // Every injected frame must run activate so the iframe with the real canvas can win `claim`.
    await browser.runtime.sendMessage({
      type: 'broadcast-activate',
      tabId: tab.id,
      dwellMs: Number(dwellEl.value),
      autoZoom: !!autoZoomEl?.checked
    }).catch(() => {});
  }
  window.close();
});

btnCancel.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return;
  await sendToCaptureFrame(tab.id, { type: 'cancel' });
  await refreshState();
});

refreshState();


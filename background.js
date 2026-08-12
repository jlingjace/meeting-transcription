// Background service worker — orchestrates tab capture, routes messages between
// the offscreen document (local sherpa-onnx ASR) and the side-panel UI.

let isRecording = false;
let isStarting = false;      // start requested but offscreen hasn't confirmed yet
let sessionSaved = false;    // current transcript already auto-saved to disk
let recordingTabId = null;
let recordingStartedAt = 0;  // wall clock, to map refined offsets back to speaker events

// Who was talking when, reported by the Meet content script. Used to turn the
// 'remote' channel into a real name; absent on non-Meet pages.
let speakerEvents = [];      // { at, name }[]

const SPEAKER_LABELS = { me: '我', remote: '对方' };

// Resolve a display name for a channel at a point in wall-clock time.
function speakerLabel(channel, atMs) {
  if (channel === 'me') return SPEAKER_LABELS.me;
  if (channel !== 'remote') return null;
  const name = nameAt(atMs);
  return name || SPEAKER_LABELS.remote;
}

function nameAt(atMs) {
  if (!speakerEvents.length) return null;
  // last event at or before atMs (events are appended in order)
  let found = null;
  for (const ev of speakerEvents) {
    if (ev.at <= atMs) found = ev; else break;
  }
  // a name only applies for a short while after it was observed
  if (found && found.name && atMs - found.at < 8000) return found.name;
  return null;
}

// On install: open permission page so the user grants mic access once.
// Offscreen documents can't show prompts themselves, so we need a visible page
// to trigger the standard browser mic permission dialog. The grant persists
// for the chrome-extension:// origin and is then usable by offscreen.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
  }
});

// ─── Extension icon click → open panel + toggle recording ────────────────────
// tabCapture.getMediaStreamId needs activeTab, which the action click grants for
// the current tab — so we can capture ANY tab (meeting, video, webpage), not just
// Meet. The transcript UI lives in the browser side panel, independent of the page.

chrome.action.onClicked.addListener(async (tab) => {
  // open the side panel in this window (must run inside the user gesture)
  try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch (e) {}

  // isStarting counts as "on" — otherwise clicking during model load hits the
  // start path, which no-ops, and the user can't cancel.
  if (isRecording || isStarting) { await stopRecording(); return; }
  await startForTab(tab.id);
});

// Start capturing a specific tab's audio.
async function startForTab(tabId) {
  if (isRecording || isStarting) return;
  isStarting = true;
  try {
    // Never discard a previous session silently: save it first if it wasn't yet.
    if (storedLines.length && !sessionSaved) downloadTranscript({ auto: true });
    clearTranscript();
    sessionSaved = false;

    recordingTabId = tabId;
    const streamId = await acquireStreamId(tabId);
    await startRecording(streamId);
  } catch (e) {
    console.error('[Transcript] start failed:', e);
    isStarting = false;
    broadcastToUI({ type: 'recording-status', isRecording: false });
    broadcastToUI({ type: 'status-error', message: friendlyStartError(e) });
  }
}

function friendlyStartError(e) {
  const m = e?.message || String(e);
  if (/active stream/i.test(m)) return '该标签页已有音频捕获，请重新加载扩展后重试';
  if (/Cannot access|chrome:\/\/|extension/i.test(m)) return '无法转录该页面，请切换到普通网页（如会议或视频页）后重试';
  return `启动失败: ${m}`;
}

// Robustly get a capture stream id: any leftover offscreen from a prior session
// (e.g. after a service-worker restart) still holds the tab's audio stream, which
// makes getMediaStreamId throw "Cannot capture a tab with an active stream".
// Force-close offscreen, wait, then request; retry once with a longer wait.
async function acquireStreamId(tabId) {
  await closeOffscreen();
  await new Promise(r => setTimeout(r, 500));
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    if (!/active stream/i.test(e.message || '')) throw e;
    // stream still held — force-close again and wait longer, then retry once
    await closeOffscreen();
    await new Promise(r => setTimeout(r, 900));
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }
}

// ─── Offscreen document lifecycle ────────────────────────────────────────────

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')],
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio for local speech transcription',
  });
}

async function closeOffscreen() {
  // Close unconditionally — getContexts() can be stale, and a lingering offscreen
  // is exactly what holds the tab's audio stream. Swallow "no document" errors.
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // no offscreen document exists — fine
  }
}

// ─── Recording control ────────────────────────────────────────────────────────

async function startRecording(streamId) {
  if (isRecording) return;
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start-recording', streamId });
  } catch (e) {
    console.error('[Transcript] startRecording failed:', e);
    broadcastToUI({ type: 'status-error', message: `启动失败: ${e.message}` });
  }
}

async function stopRecording() {
  // Also handle the "start queued while the model loads" case, where
  // recording-started hasn't arrived yet but offscreen is live.
  if (!isRecording && !isStarting) return;
  isRecording = false;
  isStarting = false;
  chrome.storage.local.set({ isRecording: false });
  chrome.action.setBadgeText({ text: '' });
  broadcastToUI({ type: 'recording-status', isRecording: false });

  // Ask offscreen to flush the VAD tail + finish decoding before we save, so the
  // last sentence isn't dropped. Then give the results a tick to land in storage.
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-recording' }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));

  // Save the live transcript right away, so nothing is lost even if the user
  // closes the browser before the refined pass finishes.
  downloadTranscript({ auto: true, suffix: 'live' });

  // Offscreen is still exporting the audio and running the refined pass — it
  // signals 'session-finished' when done, and only then may we tear it down.
}

// Called when offscreen reports the refined pass + audio export are complete.
async function finishSession() {
  await new Promise(r => setTimeout(r, 300));
  await closeOffscreen().catch(() => {});
}

// Auto-stop (+ auto-download) when the user closes the captured tab
chrome.tabs.onRemoved.addListener((tabId) => {
  if (isRecording && tabId === recordingTabId) {
    stopRecording();
  }
});

// Build a .txt from stored transcript and trigger a download.
// auto:true skips the Save dialog (silent save to Downloads) and stays quiet
// when there is nothing to save.
function downloadTranscript({ auto = false, suffix = '', lines = null } = {}) {
  const text = (lines ?? storedLines).join('\n');
  if (!text.trim()) {
    if (!auto) broadcastToUI({ type: 'status-error', message: '还没有转录内容可下载' });
    return;
  }
  if (auto) sessionSaved = true;
  // MV3 service workers have no URL.createObjectURL — use a data URL instead
  const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
  const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const tag = suffix ? `_${suffix}` : '';
  chrome.downloads.download(
    { url, filename: `transcript_${ts}${tag}.txt`, saveAs: !auto },
    () => {
      if (chrome.runtime.lastError) {
        console.error('[Transcript] download failed:', chrome.runtime.lastError);
        if (!auto) broadcastToUI({ type: 'status-error', message: `下载失败: ${chrome.runtime.lastError.message}` });
      }
    },
  );
}

function clearTranscript() {
  storedLines = [];
  chrome.storage.local.set({ transcript: [] });
  broadcastToUI({ type: 'cleared' });
}

// ─── Transcript storage ───────────────────────────────────────────────────────

let storedLines = [];
chrome.storage.local.get('transcript', (data) => {
  storedLines = Array.isArray(data?.transcript) ? data.transcript : [];
});

function storeLines(lines) {
  storedLines.push(...lines);
  if (storedLines.length > 2000) storedLines = storedLines.slice(-1000);
  chrome.storage.local.set({ transcript: storedLines });
}

// Seconds from the start of the recording → MM:SS (refined transcript uses
// offsets rather than wall-clock, which is what you want when replaying audio)
function fmtOffset(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
  } catch { return ''; }
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

// UI lives in the side panel (an extension page). runtime.sendMessage reaches it
// (and the offscreen doc, which ignores non-targeted messages). Swallow the
// "no receiver" error when the panel isn't open.
function broadcastToUI(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Message routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Who is speaking, from the Meet content script ──
  if (msg.type === 'meet-speaker') {
    if (!isRecording) return;
    const last = speakerEvents[speakerEvents.length - 1];
    if (!last || last.name !== msg.name) speakerEvents.push({ at: msg.at, name: msg.name });
    if (speakerEvents.length > 5000) speakerEvents = speakerEvents.slice(-2500);
    return;
  }

  // ── From offscreen: transcription result ──
  if (msg.type === 'transcription-result') {
    const who = speakerLabel(msg.speaker, Date.now());
    const line = `[${fmtTime(msg.timestamp)}] ${who ? who + '：' : ''}${msg.text}`;
    storeLines([line]);
    broadcastToUI({
      type: 'transcript-line', text: msg.text, timestamp: msg.timestamp, speaker: who,
    });
    return;
  }

  if (msg.type === 'transcription-error') {
    broadcastToUI({ type: 'status-error', message: `转录错误: ${msg.error}` });
    return;
  }

  if (msg.type === 'offscreen-debug') {
    broadcastToUI({ type: 'debug-line', msg: msg.msg, data: msg.data });
    return;
  }

  // ── Session recording + refined pass ──
  if (msg.type === 'audio-ready') {
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    chrome.downloads.download(
      { url: msg.url, filename: `recording_${ts}.${msg.ext || 'webm'}`, saveAs: false },
      () => {
        if (chrome.runtime.lastError) {
          console.error('[Transcript] audio download failed:', chrome.runtime.lastError);
          broadcastToUI({ type: 'status-error', message: '录音保存失败，转录文本不受影响' });
        }
      },
    );
    return;
  }

  if (msg.type === 'refine-start') {
    broadcastToUI({ type: 'refine-status', done: 0, total: msg.total });
    return;
  }

  if (msg.type === 'refine-progress') {
    broadcastToUI({ type: 'refine-status', done: msg.done, total: msg.total });
    return;
  }

  if (msg.type === 'refine-result') {
    // Replace the fragment-level live text with the padded, re-decoded version.
    // Offsets are relative to the recording, so map them back to wall clock to
    // look up who was speaking.
    const decorated = (msg.lines || []).map(l => ({
      ...l,
      speaker: speakerLabel(l.speaker, recordingStartedAt + l.t * 1000),
    }));
    const lines = decorated.map(l => `[${fmtOffset(l.t)}] ${l.speaker ? l.speaker + '：' : ''}${l.text}`);
    if (lines.length) {
      storedLines = lines;
      chrome.storage.local.set({ transcript: storedLines });
      broadcastToUI({ type: 'refine-done', lines: decorated });
      downloadTranscript({ auto: true, suffix: 'refined', lines });
    } else {
      broadcastToUI({ type: 'refine-done', lines: [] });
    }
    return;
  }

  if (msg.type === 'session-finished') {
    finishSession();
    return;
  }

  // ── From offscreen: model download progress ──
  if (msg.type === 'model-status') {
    broadcastToUI({ type: 'model-status', status: msg.status, progress: msg.progress });
    return;
  }

  if (msg.type === 'recording-started') {
    isRecording = true;
    isStarting = false;
    recordingStartedAt = Date.now();
    speakerEvents = [];
    chrome.storage.local.set({ isRecording: true });
    chrome.action.setBadgeText({ text: '●' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    broadcastToUI({ type: 'recording-status', isRecording: true });
    return;
  }

  if (msg.type === 'recording-stopped') {
    isRecording = false;
    isStarting = false;
    chrome.storage.local.set({ isRecording: false });
    chrome.action.setBadgeText({ text: '' });
    broadcastToUI({ type: 'recording-status', isRecording: false });
    return;
  }

  // Side-panel "开始转录" button → capture the current active tab
  if (msg.type === 'ui-start-recording') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) startForTab(tab.id);
      else broadcastToUI({ type: 'status-error', message: '找不到活动标签页' });
    });
    return;
  }

  if (msg.type === 'stop-recording') {
    stopRecording();
    return;
  }

  // ── From content / popup ──
  if (msg.type === 'get-status') {
    sendResponse({ isRecording });
    return true;
  }

  if (msg.type === 'download') {
    downloadTranscript({ auto: false });
    return;
  }

  if (msg.type === 'clear') {
    clearTranscript();
    return;
  }
});

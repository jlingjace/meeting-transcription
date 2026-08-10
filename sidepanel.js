// Side-panel UI for Live Transcript. Runs as an extension page (works over ANY
// tab), talks to background via chrome.runtime messaging.

const transcript = []; // { timestamp, text }[]
let isRecording = false;
let hasStartedOnce = false;

const $ = (id) => document.getElementById(id);

// ─── Controls ───────────────────────────────────────────────────────────────

$('btn-record').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: isRecording ? 'stop-recording' : 'ui-start-recording' });
});
$('copy').addEventListener('click', copyAll);
$('clear').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'clear' }));
$('download').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'download' }));

// ─── Render ───────────────────────────────────────────────────────────────────

function renderList() {
  const list = $('list');
  if (transcript.length === 0) {
    const modelLoading = $('model-bar').style.display !== 'none';
    list.innerHTML = `<div class="empty">${
      isRecording
        ? (modelLoading ? '模型加载中，请稍候...<br>加载完成后自动开始转录'
                        : '正在转录中...<br>请确保标签页有人在说话')
        : '点击上方按钮，转录<b>当前标签页</b>的声音<br>（会议 / 视频 / 网页都可以）'
    }</div>`;
    return;
  }
  const shown = transcript.slice(-60);
  list.innerHTML = shown.map(it => `
    <div class="bubble">
      <div class="bubble-ts">${it.offset != null ? fmtOffset(it.offset) : fmtTime(it.timestamp)}</div>
      <div class="bubble-text">${escHtml(it.text)}</div>
    </div>`).join('');
  list.scrollTop = list.scrollHeight;
}

function updateStatus(recording) {
  isRecording = recording;
  if (recording) hasStartedOnce = true;

  const dot = $('dot'), txt = $('status-text'), btn = $('btn-record');
  if (recording) {
    dot.className = 'dot recording';
    txt.textContent = '● 转录中...';
    btn.className = 'recording';
    btn.textContent = '■ 停止转录';
  } else {
    dot.className = 'dot';
    txt.textContent = hasStartedOnce ? '已停止' : '就绪';
    btn.className = '';
    btn.textContent = '● 开始转录当前标签页';
  }
}

function updateModelStatus(status, progress) {
  const bar = $('model-bar'), label = $('model-label'), fill = $('model-fill');
  if (status === 'ready') { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  if (status === 'downloading') {
    const pct = progress ?? 0;
    label.textContent = `⏳ 加载语音模型 ${pct}%（本地 SenseVoice 中英，首次稍慢）`;
    fill.style.width = pct + '%';
  } else {
    label.textContent = '⏳ 加载语音模型中（本地 SenseVoice 中英多语）...';
    fill.style.width = '100%';
  }
}

// ─── Messages from background ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'transcript-line':
      transcript.push({ text: msg.text, timestamp: msg.timestamp });
      renderList();
      break;
    case 'recording-status':
      updateStatus(msg.isRecording);
      renderList();
      break;
    case 'model-status':
      updateModelStatus(msg.status, msg.progress);
      break;
    case 'debug-line':
      addDebugLine(msg.msg, msg.data);
      break;
    case 'status-error':
      showError(msg.message);
      break;
    case 'cleared':
      transcript.length = 0;
      renderList();
      break;
    case 'refine-status':
      showRefine(msg.done, msg.total);
      break;
    case 'refine-done':
      hideRefine();
      if (msg.lines?.length) {
        transcript.length = 0;
        for (const l of msg.lines) transcript.push({ offset: l.t, text: l.text });
        renderList();
      }
      break;
  }
});

// The refined pass runs after stopping; show progress so the wait is explained.
function showRefine(done, total) {
  const bar = $('model-bar'), label = $('model-label'), fill = $('model-fill');
  bar.style.display = 'block';
  const pct = total ? Math.round((done / total) * 100) : 0;
  label.textContent = `✨ 正在生成精修稿 ${done}/${total}（更大上下文，更准）`;
  fill.style.width = pct + '%';
}
function hideRefine() { $('model-bar').style.display = 'none'; }

// ─── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtOffset(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  } catch { return ''; }
}

const debugLines = [];
function addDebugLine(msg, data) {
  debugLines.push(`${new Date().toLocaleTimeString()} ${msg}${data ? ' › ' + data : ''}`);
  if (debugLines.length > 40) debugLines.shift();
  $('debug-content').textContent = debugLines.join('\n');
}

function showError(message) {
  const div = document.createElement('div');
  div.className = 'warn';
  div.textContent = '⚠ ' + message;
  $('list').prepend(div);
  setTimeout(() => div.remove(), 8000);
}

async function copyAll() {
  const data = await chrome.storage.local.get('transcript');
  const lines = Array.isArray(data?.transcript) ? data.transcript : [];
  if (!lines.length) return;
  try { await navigator.clipboard.writeText(lines.join('\n')); } catch {}
}

// ─── Init ──────────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: 'get-status' }, (res) => {
  if (res) updateStatus(res.isRecording);
});
chrome.storage.local.get('transcript', (data) => {
  if (Array.isArray(data?.transcript)) {
    for (const line of data.transcript) {
      const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\] (.+)$/);
      if (m) transcript.push({ timestamp: new Date().toISOString(), text: m[2] });
    }
    renderList();
  } else {
    renderList();
  }
});
renderList();

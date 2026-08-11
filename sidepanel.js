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
$('ai-copy').addEventListener('click', copyForAI);
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

// ─── Export for ChatGPT / Claude ───────────────────────────────────────────────
// The transcript comes from speech recognition, so it contains homophone errors
// and broken sentences. Every prompt tells the model to repair them from context
// and — importantly — to mark what it cannot recover instead of inventing text.

const PROMPTS = {
  minutes: `以下是一段会议录音的自动转录文本，由本地语音识别生成，可能包含同音错字、断句错误和口语化表达。

请你：
1. 先根据上下文推断并修正明显的识别错误，特别是人名、产品名、专业术语和数字
2. 然后输出会议纪要：
   - **一句话总结**
   - **讨论要点** —— 按主题归类，不要按时间顺序流水账
   - **决议事项** —— 已经拍板的结论
   - **行动项** —— 谁 / 做什么 / 何时前完成；没有明确负责人的标注「待认领」
   - **待确认** —— 有分歧或悬而未决的问题
3. 如果某处文本残缺到无法推断，直接标注 [听不清]，**不要编造内容**
4. 转录没有区分说话人，如果能从上下文判断是不同人在说，可以推测但要标注「（推测）」

转录文本（行首 [MM:SS] 是录音时间戳）：`,

  polish: `以下是语音识别生成的会议转录，可能有同音错字、缺少标点、句子被切断、口语重复。

请输出修正后的通顺文本，要求：
- 修正同音错字和明显的识别错误（结合上下文判断）
- 补齐标点，把被切断的句子合并完整
- 去掉「嗯」「那个」「就是」这类口头禅和无意义重复
- **保留原意、原有信息量和说话顺序**，不要概括、不要总结、不要增删观点
- 保留行首的 [MM:SS] 时间戳
- 无法判断的地方保持原样或标注 [听不清]，不要臆测

转录文本：`,

  raw: '',
};

async function copyForAI() {
  const data = await chrome.storage.local.get('transcript');
  const lines = Array.isArray(data?.transcript) ? data.transcript : [];
  if (!lines.length) {
    showError('还没有转录内容可导出');
    return;
  }

  const kind = $('ai-template').value;
  const body = lines.join('\n');
  const prompt = PROMPTS[kind];
  const text = prompt ? `${prompt}\n\n---\n${body}\n---` : body;

  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    showError('复制失败，请用「复制」按钮重试');
    return;
  }

  $('ai-hint').style.display = 'block';
  const btn = $('ai-copy');
  btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.textContent = '复制给 AI'; }, 2000);

  // Rough guard: very long meetings can overflow a single chat message.
  if (text.length > 60000) {
    showError(`转录较长（约 ${Math.round(text.length / 1000)}k 字符），若 AI 提示超长请分段粘贴`);
  }
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

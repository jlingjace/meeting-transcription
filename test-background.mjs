// Harness: runs the real background.js against stubbed chrome.* APIs and
// drives the start/stop/save state machine to check for regressions.
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('./background.js', import.meta.url), 'utf8');

function makeChrome(log) {
  const listeners = { message: [], clicked: [], removed: [], installed: [] };
  let store = {};
  return {
    listeners,
    getStore: () => store,
    api: {
      runtime: {
        lastError: null,
        onInstalled: { addListener: (f) => listeners.installed.push(f) },
        onMessage: { addListener: (f) => listeners.message.push(f) },
        getURL: (p) => 'chrome-extension://abc/' + p,
        getContexts: async () => [],
        sendMessage: async (msg) => {
          log.push({ sendMessage: msg });
          // emulate offscreen: nothing replies unless we want it to
          return undefined;
        },
      },
      action: {
        onClicked: { addListener: (f) => listeners.clicked.push(f) },
        setBadgeText: () => {},
        setBadgeBackgroundColor: () => {},
      },
      sidePanel: { open: async () => {} },
      tabCapture: { getMediaStreamId: async () => 'stream-123' },
      offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
      tabs: {
        onRemoved: { addListener: (f) => listeners.removed.push(f) },
        query: async () => [{ id: 42, windowId: 1 }],
        create: () => {},
        sendMessage: async () => {},
      },
      storage: {
        local: {
          get: (key, cb) => { const r = { [key]: store[key] }; if (cb) cb(r); return Promise.resolve(r); },
          set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); return Promise.resolve(); },
        },
      },
      downloads: {
        download: (opts, cb) => {
          log.push({ download: { filename: opts.filename, saveAs: opts.saveAs, body: decodeURIComponent(opts.url.replace(/^data:text\/plain;charset=utf-8,/, '')) } });
          if (cb) cb(1);
        },
      },
    },
  };
}

function boot() {
  const log = [];
  const { api, listeners } = makeChrome(log);
  const ctx = vm.createContext({ chrome: api, console, setTimeout, clearTimeout, Date, Blob: class {}, URL });
  vm.runInContext(SRC, ctx);
  // default to the first session; tests that need a specific one pass it explicitly
  const send = (msg) => { for (const f of listeners.message) f({ sessionId: 1, ...msg }, {}, () => {}); };
  return { log, listeners, send, ctx };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { console.log(`  ✗ ${name} ${extra}`); failures++; }
}

// ── Test 1: start → transcribe → stop  ⇒ auto-saved AND text kept on screen ──
{
  console.log('\nTest 1: 中途停止应自动保存且不清空');
  const { log, listeners, send } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });      // click icon = start
  send({ type: 'recording-started' });
  send({ type: 'transcription-result', text: '第一句话', timestamp: new Date().toISOString() });
  send({ type: 'transcription-result', text: '第二句话', timestamp: new Date().toISOString() });
  const markStop = log.length;                              // only look at events after stop
  await listeners.clicked[0]({ id: 42, windowId: 1 });      // click again = stop
  await sleep(900);

  const dl = log.filter(l => l.download);
  check('自动下载被触发', dl.length === 1, JSON.stringify(dl));
  check('保存内容包含两句', dl[0]?.download.body.includes('第一句话') && dl[0]?.download.body.includes('第二句话'), dl[0]?.download.body);
  check('自动保存不弹窗 (saveAs=false)', dl[0]?.download.saveAs === false);
  const clearedAfterStop = log.slice(markStop).filter(l => l.sendMessage?.type === 'cleared');
  check('停止后未清空面板', clearedAfterStop.length === 0, `cleared x${clearedAfterStop.length}`);
  check('告诉 offscreen 停止', log.some(l => l.sendMessage?.type === 'stop-recording'));
}

// ── Test 2: stop while model still loading (isStarting, no recording-started) ──
{
  console.log('\nTest 2: 模型加载中点停止也要生效');
  const { log, listeners } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });   // start (no recording-started yet)
  await listeners.clicked[0]({ id: 42, windowId: 1 });   // stop
  await sleep(900);
  check('仍然通知 offscreen 停止', log.some(l => l.sendMessage?.type === 'stop-recording'));
  check('UI 收到 stopped 状态', log.some(l => l.sendMessage?.type === 'recording-status' && l.sendMessage.isRecording === false));
}

// ── Test 3: stop then start again ⇒ saved once, then cleared for new session ──
{
  console.log('\nTest 3: 再次开始应清空且不重复保存');
  const { log, listeners, send } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ type: 'recording-started' });
  send({ type: 'transcription-result', text: '旧会议内容', timestamp: new Date().toISOString() });
  await listeners.clicked[0]({ id: 42, windowId: 1 });   // stop → saves
  await sleep(900);
  const afterStop = log.filter(l => l.download).length;

  await listeners.clicked[0]({ id: 42, windowId: 1 });   // start new session
  await sleep(200);
  const afterStart = log.filter(l => l.download).length;
  check('停止时保存了一次', afterStop === 1, `got ${afterStop}`);
  check('再次开始不重复保存', afterStart === 1, `got ${afterStart}`);
  check('新会话清空了旧内容', log.some(l => l.sendMessage?.type === 'cleared'));
}

// ── Test 4: tab closed while recording ⇒ auto save ──
{
  console.log('\nTest 4: 关闭标签页应自动保存');
  const { log, listeners, send } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ type: 'recording-started' });
  send({ type: 'transcription-result', text: '关闭前的内容', timestamp: new Date().toISOString() });
  listeners.removed[0](42);
  await sleep(900);
  const dl = log.filter(l => l.download);
  check('关闭标签触发保存', dl.length === 1);
  check('内容正确', dl[0]?.download.body.includes('关闭前的内容'));
}

// ── Test 5: manual download mid-session keeps working ──
{
  console.log('\nTest 5: 会议中手动下载');
  const { log, listeners, send } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ type: 'recording-started' });
  send({ type: 'transcription-result', text: '进行中的内容', timestamp: new Date().toISOString() });
  send({ type: 'download' });
  await sleep(100);
  const dl = log.filter(l => l.download);
  check('手动下载触发', dl.length === 1);
  check('手动下载弹保存框 (saveAs=true)', dl[0]?.download.saveAs === true);
}

// ── Test 6: empty transcript ⇒ no junk file on stop ──
{
  console.log('\nTest 6: 无内容时停止不应生成空文件');
  const { log, listeners, send } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ type: 'recording-started' });
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  await sleep(900);
  check('未生成空文件', log.filter(l => l.download).length === 0);
}

// ── Test 7: recording + refined pass replaces live text and saves both ──
{
  console.log('\nTest 7: 录音导出 + 精修稿');
  const { log, listeners, send } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ type: 'recording-started' });
  send({ type: 'transcription-result', text: '碎片 一', timestamp: new Date().toISOString() });
  send({ type: 'transcription-result', text: '碎片 二', timestamp: new Date().toISOString() });
  await listeners.clicked[0]({ id: 42, windowId: 1 });   // stop
  await sleep(500);

  const liveSaved = log.filter(l => l.download && l.download.filename.includes('_live'));
  check('先保存实时稿', liveSaved.length === 1, JSON.stringify(log.filter(l => l.download).map(l => l.download.filename)));

  // offscreen exports audio, then reports refined lines
  send({ type: 'audio-ready', url: 'blob:fake', ext: 'webm' });
  send({ type: 'refine-start', total: 2 });
  send({ type: 'refine-progress', done: 1, total: 2 });
  send({ type: 'refine-result', lines: [
    { t: 0,    text: '这是上下文更完整的第一段' },
    { t: 21.5, text: '这是第二段' },
  ]});
  await sleep(200);

  const audio = log.filter(l => l.download && l.download.filename.startsWith('recording_'));
  check('导出录音文件', audio.length === 1 && audio[0].download.saveAs === false);

  const refined = log.filter(l => l.download && l.download.filename.includes('_refined'));
  check('保存精修稿', refined.length === 1);
  check('精修稿用相对时间戳', refined[0]?.download.body.startsWith('[00:00] 这是上下文更完整的第一段'), refined[0]?.download.body.split('\n')[0]);
  check('第二段时间戳正确', refined[0]?.download.body.includes('[00:21] 这是第二段'));
  check('通知 UI 替换为精修稿', log.some(l => l.sendMessage?.type === 'refine-done'));

  // offscreen only now allows teardown
  const beforeFinish = log.length;
  send({ type: 'session-finished' });
  await sleep(500);
  check('收到 session-finished 才收尾', log.length >= beforeFinish);
}

// ── Test 8: offscreen must survive until the refined pass reports done ──
{
  console.log('\nTest 8: 精修期间不得提前关闭 offscreen');
  const { log, listeners, send, ctx } = boot();
  let closed = 0;
  ctx.chrome.offscreen.closeDocument = async () => { closed++; };
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ type: 'recording-started' });
  send({ type: 'transcription-result', text: '内容', timestamp: new Date().toISOString() });
  const closedBeforeStop = closed;
  await listeners.clicked[0]({ id: 42, windowId: 1 });   // stop
  await sleep(800);
  check('停止后未立刻关闭 offscreen', closed === closedBeforeStop, `closed=${closed}`);
  send({ type: 'session-finished' });
  await sleep(500);
  check('收到完成信号后关闭', closed > closedBeforeStop);
}

// ── Test 9: channel split gives speaker labels without any diarization ──
{
  console.log('\nTest 9: 我 / 对方 通道分离');
  const { log, listeners, send } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ type: 'recording-started' });
  send({ type: 'transcription-result', text: '你们那边进度如何', speaker: 'remote', timestamp: new Date().toISOString() });
  send({ type: 'transcription-result', text: '这周能做完',       speaker: 'me',     timestamp: new Date().toISOString() });
  await sleep(100);

  const lines = log.filter(l => l.sendMessage?.type === 'transcript-line');
  check('远端标注「对方」', lines[0]?.sendMessage.speaker === '对方', lines[0]?.sendMessage.speaker);
  check('本人标注「我」',   lines[1]?.sendMessage.speaker === '我',   lines[1]?.sendMessage.speaker);

  send({ type: 'download' });
  await sleep(50);
  const body = log.filter(l => l.download)[0]?.download.body || '';
  check('导出文本含说话人', body.includes('对方：你们那边进度如何') && body.includes('我：这周能做完'), body);
}

// ── Test 10: Meet speaker names beat the generic label ──
{
  console.log('\nTest 10: Meet 真实姓名');
  const { log, listeners, send } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ type: 'recording-started' });
  const t0 = Date.now();
  send({ type: 'meet-speaker', name: '李明', at: t0 });
  send({ type: 'transcription-result', text: '接口周三前联调完', speaker: 'remote', timestamp: new Date().toISOString() });
  await sleep(50);

  let lines = log.filter(l => l.sendMessage?.type === 'transcript-line');
  check('用真实姓名而非「对方」', lines[0]?.sendMessage.speaker === '李明', lines[0]?.sendMessage.speaker);

  // a stale name must not stick to speech minutes later
  send({ type: 'meet-speaker', name: null, at: t0 + 1 });
  send({ type: 'transcription-result', text: '好的', speaker: 'remote', timestamp: new Date().toISOString() });
  await sleep(50);
  lines = log.filter(l => l.sendMessage?.type === 'transcript-line');
  check('姓名消失后退回「对方」', lines[1]?.sendMessage.speaker === '对方', lines[1]?.sendMessage.speaker);
}

// ── Test 11: refined pass keeps speakers and interleaves channels by time ──
{
  console.log('\nTest 11: 精修稿保留说话人并按时间排序');
  const { log, listeners, send } = boot();
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ type: 'recording-started' });
  send({ type: 'transcription-result', text: 'x', speaker: 'remote', timestamp: new Date().toISOString() });
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  await sleep(500);

  send({ type: 'refine-result', lines: [
    { t: 0,  text: '你们那边进度如何', speaker: 'remote' },
    { t: 12, text: '这周能做完',       speaker: 'me' },
  ]});
  await sleep(200);

  const refined = log.filter(l => l.download && l.download.filename.includes('_refined'))[0];
  const out = refined?.download.body || '';
  check('第一行是对方', out.split('\n')[0] === '[00:00] 对方：你们那边进度如何', out.split('\n')[0]);
  check('第二行是我',   out.split('\n')[1] === '[00:12] 我：这周能做完', out.split('\n')[1]);
}

// ── Test 12: a previous session's refined pass must not pollute the new one ──
// This is the bug that produced one .txt containing both [MM:SS] refined lines
// from an earlier recording and [HH:MM:SS] live lines from the current one,
// with most of the current session's text overwritten.
{
  console.log('\nTest 12: 上一场的精修结果不得污染新一场');
  const { log, listeners, send } = boot();

  // session 1: record and stop, but its refined pass has NOT come back yet
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ sessionId: 1, type: 'recording-started' });
  send({ sessionId: 1, type: 'transcription-result', text: '第一场内容', speaker: 'remote', timestamp: new Date().toISOString() });
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  await sleep(500);

  // session 2 starts while session 1 is still refining
  await listeners.clicked[0]({ id: 42, windowId: 1 });
  send({ sessionId: 2, type: 'recording-started' });
  send({ sessionId: 2, type: 'transcription-result', text: '第二场内容', speaker: 'remote', timestamp: new Date().toISOString() });
  await sleep(100);

  // session 1's refined result arrives late
  send({ sessionId: 1, type: 'refine-result', lines: [{ t: 0, text: '第一场精修', speaker: 'remote' }] });
  await sleep(200);

  send({ sessionId: 2, type: 'download' });
  await sleep(100);
  const body = log.filter(l => l.download && l.download.saveAs === true).pop()?.download.body || '';
  check('新会话不含旧会话精修内容', !body.includes('第一场精修'), body);
  check('新会话内容完好', body.includes('第二场内容'), body);

  // and the current session's own refined result still applies
  send({ sessionId: 2, type: 'refine-result', lines: [{ t: 3, text: '第二场精修', speaker: 'me' }] });
  await sleep(200);
  const refined = log.filter(l => l.download && l.download.filename.includes('_refined')).pop();
  check('当前会话精修正常生效', refined?.download.body.includes('第二场精修'), refined?.download.body);
}

console.log(failures === 0 ? '\n=== ALL PASS ===' : `\n=== ${failures} FAILED ===`);
process.exit(failures ? 1 : 0);

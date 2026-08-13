// Offscreen document: tab+mic audio capture → Silero VAD segmentation →
// sherpa-onnx offline ASR (SenseVoice). Classic script (NOT an ES module):
// it defines the global `Module` that the emscripten glue picks up, plus our
// capture pipeline. Loaded BEFORE sherpa-onnx-wasm-main-vad-asr.js.
//
// Two outputs per session:
//   1. live transcript  — streaming VAD segments, shown while the meeting runs
//   2. refined pass     — after stopping, the retained PCM is re-segmented over
//                         the whole recording and re-decoded with padding.
//
// Why padding: the VAD trims tightly to detected speech and clips word onsets,
// which measurably corrupts the first characters (e.g. 开放时间 → 派饭时间).
// Restoring ~0.4 s on each side fixes it.
//
// Why NOT bigger context windows: merging adjacent speech into 10–20 s windows
// was measured to make things *worse*, not better — SenseVoice does per-utterance
// language identification, so mixed zh/en in one window degrades both.
//
// The refined pass reuses the PCM we already captured instead of decoding the
// recorded file, which avoids a decode step (and decodeAudioData quirks).

// Tab audio and the microphone are kept as SEPARATE channels rather than mixed:
// the split is itself perfect speaker attribution (remote participants vs you),
// with no diarization model needed. Only the archive file is mixed.

const EXPECTED_SR = 16000;
const REFINE_PAD_S = 0.4;               // restore speech onset/offset clipped by VAD
const MAX_RECORD_S = 2 * 3600;          // per channel; two channels now, so ~460 MB worst case
const ECHO_DEDUP_MS = 6000;             // window for dropping mic echo of remote speech

let wasmReady   = false;
let recognizer  = null;

let audioCtx    = null;
let tabStream   = null;
let micStream   = null;
let recordSR    = EXPECTED_SR;
let isActive    = false;

// One per audio source. 'remote' = other participants (tab), 'me' = microphone.
let channels    = [];

let pendingStreamId = null; // start requested before wasm finished loading
let pendingSession  = null;
let sessionId       = 0;    // stamped on every result so background can discard
                            // late output from a session the user already ended

// Session recording: a compact mixed opus/webm file handed to the user for
// playback. Per-channel PCM for the refined pass lives on each channel.
let mediaRecorder   = null;
let audioBlobParts  = [];

// Recently emitted remote text, used to drop microphone echo of it
let recentRemote    = [];   // { text, at }[]

function dbg(msg, data) {
  console.log('[sherpa offscreen]', msg, data ?? '');
  chrome.runtime.sendMessage({ type: 'offscreen-debug', msg, data: String(data ?? '') });
}

// ─── Emscripten Module (must exist before the glue script runs) ────────────────

var Module = {
  locateFile: function (path, scriptDirectory) {
    // .wasm and the .data package live in the sherpa/ subfolder
    return chrome.runtime.getURL('sherpa/' + path);
  },
  setStatus: function (status) {
    if (!status) return;
    const m = status.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
    if (m) {
      const pct = Math.round((Number(m[1]) / Number(m[2])) * 100);
      chrome.runtime.sendMessage({ type: 'model-status', status: 'downloading', progress: pct });
    } else {
      chrome.runtime.sendMessage({ type: 'model-status', status: 'loading' });
    }
  },
  onRuntimeInitialized: function () {
    onWasmReady();
  },
  print:    function () { console.log('[sherpa]', ...arguments); },
  printErr: function () { console.log('[sherpa:err]', ...arguments); },
};

// ─── Model init ────────────────────────────────────────────────────────────────

function fileExists(filename) {
  const len = Module.lengthBytesUTF8(filename) + 1;
  const buf = Module._malloc(len);
  Module.stringToUTF8(filename, buf, len);
  const exists = Module._SherpaOnnxFileExists(buf);
  Module._free(buf);
  return exists;
}

// Model-agnostic detection (same chain as the sherpa demo). If the .data package
// is later swapped for SenseVoice, this keeps working without code changes.
function initRecognizer() {
  const config = { modelConfig: { debug: 0, tokens: './tokens.txt' } };

  if (fileExists('sense-voice.onnx') == 1) {
    config.modelConfig.senseVoice = { model: './sense-voice.onnx', useInverseTextNormalization: 1 };
    dbg('model', 'SenseVoice');
  } else if (fileExists('zipformer-ctc.onnx') == 1) {
    config.modelConfig.zipformerCtc = { model: './zipformer-ctc.onnx' };
    dbg('model', 'Zipformer-CTC');
  } else if (fileExists('paraformer.onnx') == 1) {
    config.modelConfig.paraformer = { model: './paraformer.onnx' };
    dbg('model', 'Paraformer');
  } else if (fileExists('whisper-encoder.onnx') == 1) {
    config.modelConfig.whisper = { encoder: './whisper-encoder.onnx', decoder: './whisper-decoder.onnx' };
    dbg('model', 'Whisper');
  } else {
    dbg('model', 'NONE FOUND — check .data package');
  }

  recognizer = new OfflineRecognizer(config, Module);
}

async function onWasmReady() {
  // Swap the .data's Chinese-only zipformer for SenseVoice (zh+en+ja+ko+yue).
  // Injected into MEMFS at runtime so we reuse the prebuilt wasm as-is.
  try {
    await injectSenseVoice();
  } catch (e) {
    dbg('SenseVoice inject failed — falling back to bundled model', e.message);
  }
  initRecognizer();

  wasmReady = true;
  dbg('sherpa runtime ready');
  chrome.runtime.sendMessage({ type: 'model-status', status: 'ready' });

  if (pendingStreamId) {
    const id = pendingStreamId, session = pendingSession;
    pendingStreamId = null;
    pendingSession = null;
    beginCapture(id, session).catch(e => dbg('beginCapture error', e.message));
  }
}

async function injectSenseVoice() {
  chrome.runtime.sendMessage({ type: 'model-status', status: 'loading' });

  // Fetch first — only mutate the FS once we actually have the bytes, so a
  // failed fetch leaves the bundled zipformer intact as a fallback.
  const modelUrl  = chrome.runtime.getURL('sherpa/models/sensevoice.int8.onnx');
  const tokensUrl = chrome.runtime.getURL('sherpa/models/sensevoice-tokens.txt');
  const [model, tokens] = await Promise.all([
    fetch(modelUrl).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
    fetch(tokensUrl).then(r => r.arrayBuffer()).then(b => new Uint8Array(b)),
  ]);

  // free the unused zipformer to reclaim ~360MB RAM, then swap in SenseVoice
  try { Module.FS_unlink('zipformer-ctc.onnx'); } catch (e) {}
  try { Module.FS_unlink('tokens.txt'); } catch (e) {}
  Module.FS_createDataFile('/', 'tokens.txt', tokens, true, true, false);
  Module.FS_createDataFile('/', 'sense-voice.onnx', model, true, true, false);
  dbg('SenseVoice injected', model.length + ' bytes');
}

// ─── Audio capture ──────────────────────────────────────────────────────────────

async function beginCapture(streamId, session) {
  if (isActive) return;
  sessionId = session;

  // Tab audio (remote participants) — required
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  dbg('tab stream', tabStream.getAudioTracks().length + ' track(s)');

  audioCtx = new AudioContext(); // native rate; the worklet downsamples to 16k
  recordSR = audioCtx.sampleRate;
  dbg('AudioContext sr', recordSR);

  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL('capture-worklet.js'));

  const tabSource = audioCtx.createMediaStreamSource(tabStream);
  // Route tab audio to speakers so the user still hears the meeting
  tabSource.connect(audioCtx.destination);

  // Microphone (the user's own voice) — optional; requires the one-time grant.
  // Echo cancellation matters here: tab audio is playing through the speakers,
  // and without AEC the mic re-captures it and we transcribe remote speech twice.
  let micSource = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    micSource = audioCtx.createMediaStreamSource(micStream);
    dbg('mic stream', 'ok — 分离通道（我 / 对方）');
  } catch (e) {
    micStream = null;
    dbg('mic stream', 'unavailable — 仅转录对方 (' + e.message + ')');
  }

  channels = [makeChannel('remote', tabSource)];
  if (micSource) channels.push(makeChannel('me', micSource));

  // Separate tap for the archive file: mix the sources into one stream and let
  // MediaRecorder encode opus (~15-30 MB/h) instead of storing raw PCM.
  try {
    const mixDest = audioCtx.createMediaStreamDestination();
    tabSource.connect(mixDest);
    if (micSource) micSource.connect(mixDest);
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) || '';
    mediaRecorder = new MediaRecorder(mixDest.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 32000,
    });
    audioBlobParts = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) audioBlobParts.push(e.data); };
    mediaRecorder.start(5000); // flush every 5s so a crash loses at most that much
    dbg('audio recorder started', mimeType || 'default');
  } catch (e) {
    mediaRecorder = null;
    dbg('audio recorder unavailable', e.message);
  }

  recentRemote = [];
  isActive = true;
  chrome.runtime.sendMessage({ type: 'recording-started' });
  dbg('recording started');
}

// Each source gets its own VAD, buffer and retained PCM, so a segment's channel
// is the speaker attribution — no diarization model involved.
function makeChannel(name, source) {
  const ch = {
    name,
    source,
    vad: createVad(Module),
    circular: new CircularBuffer(30 * EXPECTED_SR, Module),
    pcm: [],
    samples: 0,
    capped: false,
    node: new AudioWorkletNode(audioCtx, 'capture'),
  };
  // Capture runs on the audio thread; chunks arrive already at 16 kHz.
  ch.node.port.onmessage = (e) => onAudio(ch, e.data);
  source.connect(ch.node);
  // must be connected for the graph to pull it; it writes no output, so silent
  ch.node.connect(audioCtx.destination);
  return ch;
}

function onAudio(ch, samples) {
  if (!isActive || !wasmReady) return;

  // Retain as Int16 (half the memory of Float32) for the post-meeting re-pass
  if (!ch.capped) {
    if (ch.samples + samples.length > MAX_RECORD_S * EXPECTED_SR) {
      ch.capped = true;
      dbg('recording cap reached', `${ch.name}: ${MAX_RECORD_S}s — 后续不再保留音频用于精修`);
    } else {
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = v * 32767;
      }
      ch.pcm.push(pcm);
      ch.samples += pcm.length;
    }
  }

  ch.circular.push(samples);
  const winSize = ch.vad.config.sileroVad.windowSize;

  while (ch.circular.size() > winSize) {
    const s = ch.circular.get(ch.circular.head(), winSize);
    ch.vad.acceptWaveform(s);
    ch.circular.pop(winSize);

    while (!ch.vad.isEmpty()) {
      const segment = ch.vad.front();
      ch.vad.pop();
      enqueueSegment(segment.samples, ch.name);
    }
  }
}

// Decoding is synchronous WASM and takes ~1-2 s. Queue it and yield between
// jobs so VAD/port messages keep flowing instead of piling up behind one decode.
const pendingSegments = [];
let draining = false;

function enqueueSegment(samples, speaker) {
  pendingSegments.push({ samples, speaker });
  drainSegments();
}

async function drainSegments() {
  if (draining) return;
  draining = true;
  while (pendingSegments.length) {
    const job = pendingSegments.shift();
    transcribeSegment(job.samples, job.speaker);
    await new Promise(r => setTimeout(r, 0));
  }
  draining = false;
}

function waitForQueue() {
  return new Promise((resolve) => {
    const check = () => (!draining && pendingSegments.length === 0)
      ? resolve() : setTimeout(check, 50);
    check();
  });
}

// Degraded audio makes the model stutter — it emits a character or a short token
// over and over ("你你你你你…", "5,5,5,5,"). Collapsing the runs keeps the real
// tail of the sentence, which dropping the whole line would throw away.
function cleanText(raw) {
  let s = (raw || '').trim();
  if (!s) return '';

  s = s.replace(/(.)\1{2,}/gu, '$1');              // 你你你你 → 你
  s = s.replace(/(.{2,4}?)(?:\1){2,}/gu, '$1');    // 5,5,5,5, / five five five → once
  s = s.replace(/\s{2,}/g, ' ').trim();

  // Nothing left but punctuation or a lone character: this was noise, not speech
  const letters = s.replace(/[\s\p{P}\p{S}]/gu, '');
  if (letters.length < 2) return '';

  // The user speaks Chinese and English; kana/hangul here means the model
  // mis-identified the language on non-speech audio
  if (/[぀-ヿ가-힯]/.test(s)) return '';

  return s;
}

// Even with AEC the mic can leak remote speech. Text-level dedup is safer than
// dropping audio: only skip a 'me' segment that repeats remote text verbatim.
function isEcho(text, speaker) {
  if (speaker !== 'me') return false;
  const now = Date.now();
  recentRemote = recentRemote.filter(r => now - r.at < ECHO_DEDUP_MS);
  return recentRemote.some(r => r.text === text);
}

// Decode one chunk of PCM. Returns '' on failure so callers can keep going.
function decodePcm(samples) {
  const stream = recognizer.createStream();
  try {
    stream.acceptWaveform(EXPECTED_SR, samples);
    recognizer.decode(stream);
    return (recognizer.getResult(stream).text || '').trim();
  } finally {
    stream.free();
  }
}

function transcribeSegment(samples, speaker) {
  const dur = samples.length / EXPECTED_SR;
  if (dur < 0.2) return; // ignore ultra-short blips

  try {
    const raw = decodePcm(samples);
    const text = cleanText(raw);
    dbg('segment', `[${speaker}] dur=${dur.toFixed(1)}s "${raw}"${text !== raw ? ` → "${text}"` : ''}`);
    if (!text) return;

    if (isEcho(text, speaker)) {
      dbg('echo dropped', text);
      return;
    }
    if (speaker === 'remote') recentRemote.push({ text, at: Date.now() });

    chrome.runtime.sendMessage({
      type: 'transcription-result',
      sessionId,
      text,
      speaker,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    dbg('decode error', err.message);
    chrome.runtime.sendMessage({ type: 'transcription-error', error: err.message });
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

// Stop accepting audio, flush the VAD tail (so a sentence cut off mid-word is
// still transcribed), export the recording, then run the refined pass.
async function finishAndCleanup() {
  isActive = false;
  for (const ch of channels) {
    try {
      if (ch.vad && wasmReady) {
        ch.vad.flush();
        while (!ch.vad.isEmpty()) {
          const segment = ch.vad.front();
          ch.vad.pop();
          enqueueSegment(segment.samples, ch.name);
        }
      }
    } catch (e) {
      dbg('flush error', `${ch.name}: ${e.message}`);
    }
  }

  await waitForQueue();      // let already-queued segments finish decoding
  await exportRecording();   // hand the audio file to background
  cleanup();                 // release mic/tab/audio nodes (PCM stays in memory)
  await runRefinedPass();    // re-decode with padding, per channel
  for (const ch of channels) { ch.pcm = []; ch.samples = 0; }
  channels = [];
  chrome.runtime.sendMessage({ type: 'session-finished' });
}

// Finalise the MediaRecorder and pass a blob URL to background for download.
// The URL belongs to this document, so background must finish the download
// before the offscreen document is torn down.
function exportRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') { resolve(); return; }
    mediaRecorder.onstop = () => {
      try {
        const blob = new Blob(audioBlobParts, { type: mediaRecorder.mimeType || 'audio/webm' });
        audioBlobParts = [];
        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          const ext = (mediaRecorder.mimeType || '').includes('webm') ? 'webm' : 'audio';
          dbg('recording exported', `${(blob.size / 1048576).toFixed(1)} MB`);
          chrome.runtime.sendMessage({ type: 'audio-ready', url, ext });
        }
      } catch (e) {
        dbg('export error', e.message);
      }
      mediaRecorder = null;
      resolve();
    };
    try { mediaRecorder.stop(); } catch (e) { mediaRecorder = null; resolve(); }
  });
}

// Re-segment the retained PCM over the whole recording and decode again with
// padding around each utterance. See the note at the top for why padding helps
// and why merging into larger windows does not.
async function runRefinedPass() {
  if (!wasmReady || !recognizer) return;

  // Plan every channel first so progress covers the whole job, not one channel
  const jobs = [];
  for (const ch of channels) {
    if (ch.samples === 0) continue;
    const pcm = new Float32Array(ch.samples);
    let off = 0;
    for (const chunk of ch.pcm) {
      for (let i = 0; i < chunk.length; i++) pcm[off + i] = chunk[i] / 32768;
      off += chunk.length;
    }
    for (const w of planWindows(ch, pcm)) jobs.push({ pcm, speaker: ch.name, ...w });
  }
  if (jobs.length === 0) return;

  dbg('refined pass', `${jobs.length} 段 / ${channels.length} 个通道（padding ${REFINE_PAD_S}s）`);
  chrome.runtime.sendMessage({ type: 'refine-start', total: jobs.length });

  const lines = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    try {
      const text = cleanText(decodePcm(j.pcm.subarray(j.start, j.end)));
      if (text) lines.push({ t: j.start / EXPECTED_SR, text, speaker: j.speaker });
    } catch (e) {
      dbg('refined decode error', e.message);
    }
    chrome.runtime.sendMessage({ type: 'refine-progress', done: i + 1, total: jobs.length });
    await new Promise(r => setTimeout(r, 0)); // yield so messages flush
  }

  // Channels were decoded one after another; interleave them back into real order
  lines.sort((a, b) => a.t - b.t);

  chrome.runtime.sendMessage({ type: 'refine-result', sessionId, lines });
  dbg('refined pass done', `${lines.length} 行`);
}

// Re-run VAD over a whole channel and pad each utterance so the VAD's tight
// boundaries don't clip word onsets.
function planWindows(ch, pcm) {
  const spans = [];
  const collect = () => {
    while (!ch.vad.isEmpty()) {
      const seg = ch.vad.front();
      ch.vad.pop();
      spans.push({ start: seg.start, end: seg.start + seg.samples.length });
    }
  };
  try {
    ch.vad.reset();
    const win = ch.vad.config.sileroVad.windowSize;
    for (let i = 0; i + win <= pcm.length; i += win) {
      ch.vad.acceptWaveform(pcm.subarray(i, i + win));
      collect();
    }
    ch.vad.flush();
    collect();
  } catch (e) {
    dbg('refined vad error', `${ch.name}: ${e.message}`);
    return [];
  }

  const pad = Math.round(REFINE_PAD_S * EXPECTED_SR);
  return spans.map(s => ({
    start: Math.max(0, s.start - pad),
    end: Math.min(pcm.length, s.end + pad),
  }));
}

function cleanup() {
  isActive = false;
  for (const ch of channels) {
    if (ch.node) { ch.node.port.onmessage = null; ch.node.disconnect(); ch.node = null; }
    if (ch.source) { try { ch.source.disconnect(); } catch (e) {} ch.source = null; }
    try { ch.circular.reset(); } catch (e) {}
  }
  if (tabStream) { tabStream.getTracks().forEach(t => t.stop()); tabStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (audioCtx)  { audioCtx.close(); audioCtx = null; }
  chrome.runtime.sendMessage({ type: 'recording-stopped' });
  dbg('recording stopped, resources released');
}

// ─── Messages from background ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'start-recording') {
    if (wasmReady) {
      beginCapture(message.streamId, message.sessionId)
        .then(() => sendResponse({ ok: true }))
        .catch(e => { dbg('start error', e.message); sendResponse({ ok: false, error: e.message }); });
    } else {
      pendingStreamId = message.streamId;
      pendingSession = message.sessionId;
      chrome.runtime.sendMessage({ type: 'model-status', status: 'loading' });
      dbg('start queued — waiting for model to finish loading');
      sendResponse({ ok: true, queued: true });
    }
    return true;
  }

  if (message.type === 'stop-recording') {
    pendingStreamId = null;
    finishAndCleanup();
    sendResponse({ ok: true });
    return true;
  }
});

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

const EXPECTED_SR = 16000;
const REFINE_PAD_S = 0.4;               // restore speech onset/offset clipped by VAD
const MAX_RECORD_S = 3 * 3600;          // cap retained PCM (~345 MB) as a backstop

let wasmReady   = false;
let vad         = null;
let recognizer  = null;
let circular    = null;

let audioCtx    = null;
let tabStream   = null;
let micStream   = null;
let tabSource   = null;
let micSource   = null;
let processor   = null;
let recordSR    = EXPECTED_SR;
let isActive    = false;

let pendingStreamId = null; // start requested before wasm finished loading

// Session recording: Int16 PCM kept for the refined pass, plus a compact
// opus/webm file handed to the user for playback.
let recordedPcm     = [];   // Int16Array[]
let recordedSamples = 0;
let recordCapped    = false;
let mediaRecorder   = null;
let audioBlobParts  = [];

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
  vad = createVad(Module);
  circular = new CircularBuffer(30 * EXPECTED_SR, Module);

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
    const id = pendingStreamId;
    pendingStreamId = null;
    beginCapture(id).catch(e => dbg('beginCapture error', e.message));
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

async function beginCapture(streamId) {
  if (isActive) return;

  // Tab audio (remote participants) — required
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  dbg('tab stream', tabStream.getAudioTracks().length + ' track(s)');

  audioCtx = new AudioContext(); // native rate (usually 48000); we downsample to 16k ourselves
  recordSR = audioCtx.sampleRate;
  dbg('AudioContext sr', recordSR);

  tabSource = audioCtx.createMediaStreamSource(tabStream);
  // Route tab audio to speakers so the user still hears the meeting
  tabSource.connect(audioCtx.destination);

  // Microphone (the user's own voice) — optional; requires the one-time grant
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    micSource = audioCtx.createMediaStreamSource(micStream);
    dbg('mic stream', 'ok (tab+mic mixed)');
  } catch (e) {
    micStream = null; micSource = null;
    dbg('mic stream', 'unavailable — tab only (' + e.message + ')');
  }

  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  // Both sources feed the processor input; connections sum → tab+mic mix for analysis
  tabSource.connect(processor);
  if (micSource) micSource.connect(processor);
  // processor must connect to destination to fire; it emits silence (we never
  // write its output buffer) so there is no echo of the mic
  processor.connect(audioCtx.destination);

  processor.onaudioprocess = onAudio;

  // Separate tap for the archive file: mix the same sources into a stream and
  // let MediaRecorder encode opus (~15-30 MB/h) instead of storing raw PCM.
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

  recordedPcm = [];
  recordedSamples = 0;
  recordCapped = false;

  isActive = true;
  chrome.runtime.sendMessage({ type: 'recording-started' });
  dbg('recording started');
}

function onAudio(e) {
  if (!isActive || !wasmReady) return;

  let samples = new Float32Array(e.inputBuffer.getChannelData(0));
  samples = downsample(samples, recordSR, EXPECTED_SR);

  // Retain as Int16 (half the memory of Float32) for the post-meeting re-pass
  if (!recordCapped) {
    if (recordedSamples + samples.length > MAX_RECORD_S * EXPECTED_SR) {
      recordCapped = true;
      dbg('recording cap reached', `${MAX_RECORD_S}s — 后续不再保留音频用于精修`);
    } else {
      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = v * 32767;
      }
      recordedPcm.push(pcm);
      recordedSamples += pcm.length;
    }
  }

  circular.push(samples);
  const winSize = vad.config.sileroVad.windowSize;

  while (circular.size() > winSize) {
    const s = circular.get(circular.head(), winSize);
    vad.acceptWaveform(s);
    circular.pop(winSize);

    while (!vad.isEmpty()) {
      const segment = vad.front();
      vad.pop();
      transcribeSegment(segment.samples);
    }
  }
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

function transcribeSegment(samples) {
  const dur = samples.length / EXPECTED_SR;
  if (dur < 0.2) return; // ignore ultra-short blips

  try {
    const text = decodePcm(samples);
    dbg('segment', `dur=${dur.toFixed(1)}s text="${text}"`);
    if (text) {
      chrome.runtime.sendMessage({
        type: 'transcription-result',
        text,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err) {
    dbg('decode error', err.message);
    chrome.runtime.sendMessage({ type: 'transcription-error', error: err.message });
  }
}

// Average-pooling downsampler (from the sherpa demo)
function downsample(buffer, fromRate, toRate) {
  if (toRate === fromRate) return buffer;
  const ratio = fromRate / toRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  let iOut = 0, iIn = 0;
  while (iOut < newLen) {
    const nextIn = Math.round((iOut + 1) * ratio);
    let acc = 0, cnt = 0;
    for (let i = iIn; i < nextIn && i < buffer.length; i++) { acc += buffer[i]; cnt++; }
    result[iOut] = cnt ? acc / cnt : 0;
    iOut++; iIn = nextIn;
  }
  return result;
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

// Stop accepting audio, flush the VAD tail (so a sentence cut off mid-word is
// still transcribed), export the recording, then run the refined pass.
async function finishAndCleanup() {
  isActive = false;
  try {
    if (vad && wasmReady) {
      vad.flush();
      while (!vad.isEmpty()) {
        const segment = vad.front();
        vad.pop();
        transcribeSegment(segment.samples);
      }
    }
  } catch (e) {
    dbg('flush error', e.message);
  }

  await exportRecording();   // hand the audio file to background
  cleanup();                 // release mic/tab/audio nodes (PCM stays in memory)
  await runRefinedPass();    // re-decode with wider context
  recordedPcm = [];          // only now is the PCM no longer needed
  recordedSamples = 0;
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
  if (!wasmReady || !recognizer || recordedSamples === 0) return;

  const pcm = new Float32Array(recordedSamples);
  let off = 0;
  for (const chunk of recordedPcm) {
    for (let i = 0; i < chunk.length; i++) pcm[off + i] = chunk[i] / 32768;
    off += chunk.length;
  }

  // Re-run VAD over the whole recording to get speech spans with offsets
  const spans = [];
  const collect = () => {
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      spans.push({ start: seg.start, end: seg.start + seg.samples.length });
    }
  };
  try {
    vad.reset();
    const win = vad.config.sileroVad.windowSize;
    for (let i = 0; i + win <= pcm.length; i += win) {
      vad.acceptWaveform(pcm.subarray(i, i + win));
      collect();
    }
    vad.flush();
    collect();
  } catch (e) {
    dbg('refined vad error', e.message);
    return;
  }
  if (spans.length === 0) return;

  // Pad each utterance so the VAD's tight boundaries don't clip word onsets
  const pad = Math.round(REFINE_PAD_S * EXPECTED_SR);
  const windows = spans.map(s => ({
    start: Math.max(0, s.start - pad),
    end: Math.min(pcm.length, s.end + pad),
  }));

  dbg('refined pass', `${windows.length} 段（padding ${REFINE_PAD_S}s）`);
  chrome.runtime.sendMessage({ type: 'refine-start', total: windows.length });

  const lines = [];
  for (let i = 0; i < windows.length; i++) {
    const { start, end } = windows[i];
    try {
      const text = decodePcm(pcm.subarray(start, end));
      if (text) lines.push({ t: start / EXPECTED_SR, text });
    } catch (e) {
      dbg('refined decode error', e.message);
    }
    chrome.runtime.sendMessage({ type: 'refine-progress', done: i + 1, total: windows.length });
    await new Promise(r => setTimeout(r, 0)); // yield so messages flush
  }

  chrome.runtime.sendMessage({ type: 'refine-result', lines });
  dbg('refined pass done', `${lines.length} 行`);
}

function cleanup() {
  isActive = false;
  if (processor) { processor.disconnect(); processor.onaudioprocess = null; processor = null; }
  if (tabSource) { tabSource.disconnect(); tabSource = null; }
  if (micSource) { micSource.disconnect(); micSource = null; }
  if (tabStream) { tabStream.getTracks().forEach(t => t.stop()); tabStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (audioCtx)  { audioCtx.close(); audioCtx = null; }
  if (vad) { try { vad.reset(); } catch (e) {} }
  if (circular) { try { circular.reset(); } catch (e) {} }
  chrome.runtime.sendMessage({ type: 'recording-stopped' });
  dbg('recording stopped, resources released');
}

// ─── Messages from background ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'start-recording') {
    if (wasmReady) {
      beginCapture(message.streamId)
        .then(() => sendResponse({ ok: true }))
        .catch(e => { dbg('start error', e.message); sendResponse({ ok: false, error: e.message }); });
    } else {
      pendingStreamId = message.streamId;
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

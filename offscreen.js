// Offscreen document: tab+mic audio capture → Silero VAD segmentation →
// sherpa-onnx offline ASR (zipformer-ctc). Classic script (NOT an ES module):
// it defines the global `Module` that the emscripten glue picks up, plus our
// capture pipeline. Loaded BEFORE sherpa-onnx-wasm-main-vad-asr.js.

const EXPECTED_SR = 16000;

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

  isActive = true;
  chrome.runtime.sendMessage({ type: 'recording-started' });
  dbg('recording started');
}

function onAudio(e) {
  if (!isActive || !wasmReady) return;

  let samples = new Float32Array(e.inputBuffer.getChannelData(0));
  samples = downsample(samples, recordSR, EXPECTED_SR);

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

function transcribeSegment(samples) {
  const dur = samples.length / EXPECTED_SR;
  if (dur < 0.2) return; // ignore ultra-short blips

  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform(EXPECTED_SR, samples);
    recognizer.decode(stream);
    const text = (recognizer.getResult(stream).text || '').trim();
    stream.free();

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

// Stop accepting audio, then flush the VAD so a sentence still in its buffer
// (i.e. the user stopped mid-utterance) is transcribed instead of dropped.
function finishAndCleanup() {
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
  cleanup();
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

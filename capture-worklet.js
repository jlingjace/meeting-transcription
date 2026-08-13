// Audio capture on the dedicated audio thread.
//
// This replaces ScriptProcessorNode, whose callback runs on the main thread —
// the same thread that runs SenseVoice inference. A decode takes ~1-2 s, so the
// capture callback could not run during it and audio was dropped, which is what
// produced chopped input and the repeated-character artifacts ("你你你你你…").
// An AudioWorklet keeps capturing regardless of how busy the main thread is;
// chunks simply queue on the port until the main thread drains them.
//
// Downsampling to 16 kHz happens here too, so we post 1/3 of the data and leave
// the main thread free for inference.

const TARGET_SR = 16000;
const OUT_CHUNK = 2048;          // ~128 ms at 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_SR;   // sampleRate is a worklet global
    this.inBuf = new Float32Array(0);
    this.needIn = Math.ceil(OUT_CHUNK * this.ratio);
  }

  process(inputs) {
    const ch0 = inputs[0] && inputs[0][0];
    if (ch0 && ch0.length) {
      const merged = new Float32Array(this.inBuf.length + ch0.length);
      merged.set(this.inBuf, 0);
      merged.set(ch0, this.inBuf.length);
      this.inBuf = merged;

      while (this.inBuf.length >= this.needIn) {
        const block = this.inBuf.subarray(0, this.needIn);
        this.port.postMessage(this.downsample(block), );
        this.inBuf = this.inBuf.slice(this.needIn);
      }
    }
    return true; // keep the node alive even while the input is silent
  }

  // average-pooling resampler; block boundaries are chosen so the error stays
  // sub-sample and is irrelevant for ASR
  downsample(buf) {
    if (this.ratio === 1) return new Float32Array(buf);
    const outLen = Math.round(buf.length / this.ratio);
    const out = new Float32Array(outLen);
    let iIn = 0;
    for (let iOut = 0; iOut < outLen; iOut++) {
      const nextIn = Math.round((iOut + 1) * this.ratio);
      let acc = 0, cnt = 0;
      for (let i = iIn; i < nextIn && i < buf.length; i++) { acc += buf[i]; cnt++; }
      out[iOut] = cnt ? acc / cnt : 0;
      iIn = nextIn;
    }
    return out;
  }
}

registerProcessor('capture', CaptureProcessor);

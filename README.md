# Live Transcript

Chrome 扩展：**把任意标签页的声音实时转成文字**，全部在本地完成。

不需要开启 Google Meet 字幕，不需要 API key，音频不上传任何服务器。

## 特性

- **任意标签页** — Google Meet、YouTube、网页版 Zoom / Teams、本地视频都可以
- **完全本地** — sherpa-onnx (WebAssembly) 跑 Silero VAD + SenseVoice，离线可用
- **中英混说** — SenseVoice 支持中 / 英 / 日 / 韩 / 粤，自带标点
- **不乱编** — VAD 只在检测到人声时才送去识别，CTC 模型不会像 Whisper 那样在静音处产生幻觉
- **保留录音** — 同时存一份 opus 音频（约 15–30 MB/小时），转录有疑问时可以回听
- **会后精修** — 停止后自动用完整录音重跑一遍，输出更准确的最终稿
- **自动保存** — 停止转录或关闭标签页时，自动导出 `.txt` 到下载目录
- **原生侧边栏** — 转录界面在 Chrome 侧边栏，独立于网页

## 安装

```bash
git clone https://github.com/jlingjace/meeting-transcription.git
cd meeting-transcription
./download-models.sh
```

模型文件约 600 MB，超过 GitHub 单文件 100 MB 限制，所以由脚本从 HuggingFace 拉取。

然后在 Chrome 中：

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本项目文件夹
4. 首次加载会弹出麦克风授权页，点一次「授权」即可（用于录你自己的声音；只想转录标签页声音可以跳过）

## 使用

1. 打开任意有声音的标签页
2. 点击工具栏的扩展图标 → 侧边栏打开并**开始转录当前标签页**
3. 再点一次图标（或侧边栏「停止转录」）→ 停止并自动导出 `.txt`

侧边栏底部可以随时**复制 / 清空 / 下载**。

## 能捕获什么

| 声音来源 | 是否支持 |
|---|---|
| 标签页里播放的声音（会议中其他人说话、视频、网页音频） | ✅ |
| 你自己的麦克风 | ✅（需授权） |
| 你分享/演示给会议的音频 | ❌ 出站音频本地不回放，抓不到 |
| 原生 App（Zoom 客户端、Spotify、系统声音） | ❌ macOS 限制，需 BlackHole 之类虚拟声卡 |

## 工作原理

```
                              ┌─→ Silero VAD ─→ SenseVoice ─→ 侧边栏（实时稿）
chrome.tabCapture ─┐          │   切出人声段      本地识别
                   ├─→ 混音 ──┤
麦克风 (可选) ──────┘          ├─→ 保留 PCM ──→ 停止后重跑（精修稿）
                              └─→ MediaRecorder → recording_*.webm
```

一次会议产出三个文件：`transcript_*_live.txt`（实时稿）、`transcript_*_refined.txt`
（精修稿）、`recording_*.webm`（录音）。

### 关于精修稿

精修不是简单地"再跑一遍"。实测发现 VAD 会把语音**开头切掉**，导致首字识别错误
（`开放时间` → `派饭时间`）。精修 pass 在每段人声前后各补 0.4 秒，修掉这类错误。

反直觉的一点：**把相邻语音合并成 10–20 秒的大窗口反而更差**。实测中英混说时，
合并会让两种语言互相干扰（`开放`→`开饭`、`code`→`good`），因为 SenseVoice 是按
整段做语言判定的。所以精修保持逐句解码，只加 padding。

- **background.js** — Service Worker：捕获标签音频、状态机、自动保存
- **offscreen.js** — 离屏文档：音频采集 + WASM 推理（Service Worker 不能用 WebAudio）
- **sidepanel.js / .html** — 侧边栏 UI
- **permission.html / .js** — 一次性麦克风授权页（离屏文档无法自行弹权限框）

SenseVoice 模型在运行时注入到 emscripten 的内存文件系统，替换掉预编译包里自带的中文 zipformer，
因此不需要安装 Emscripten 重新编译。

## 测试

```bash
node test-background.mjs
```

用桩替换 `chrome.*` API，驱动真实的 `background.js` 状态机，覆盖开始 / 停止 / 自动保存 /
关闭标签 / 手动下载 / 空转录等场景。

## 致谢

- [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — WebAssembly 语音识别运行时
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) — 多语言 ASR 模型
- [Silero VAD](https://github.com/snakers4/silero-vad) — 语音活动检测

## License

Apache-2.0（与 sherpa-onnx 一致）

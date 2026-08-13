# Live Transcript

Chrome 扩展：**把任意标签页的声音实时转成文字**，全部在本地完成。

不需要开启 Google Meet 字幕，不需要 API key，音频不上传任何服务器。

## 特性

- **任意标签页** — Google Meet、YouTube、网页版 Zoom / Teams、本地视频都可以
- **完全本地** — sherpa-onnx (WebAssembly) 跑 Silero VAD + SenseVoice，离线可用
- **中英混说** — SenseVoice 支持中 / 英 / 日 / 韩 / 粤，自带标点
- **不乱编** — VAD 只在检测到人声时才送去识别，CTC 模型不会像 Whisper 那样在静音处产生幻觉
- **区分说话人** — 标签页音频和麦克风分两路独立识别，天然区分「我」和「对方」；
  在 Google Meet 里还能标出**真实姓名**
- **保留录音** — 同时存一份 opus 音频（约 15–30 MB/小时），转录有疑问时可以回听
- **会后精修** — 停止后自动用完整录音重跑一遍，输出更准确的最终稿
- **一键交给 AI** — 生成带提示词的文本，粘进 ChatGPT / Claude 即可出会议纪要
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

### 交给 ChatGPT / Claude

侧边栏下方选好模板，点「复制给 AI」，粘贴到对话框即可：

| 模板 | 用途 |
|---|---|
| 会议纪要 + 行动项 | 输出一句话总结、讨论要点、决议、行动项（谁/做什么/何时）、待确认问题 |
| 修正错字 + 顺句子 | 只修语音识别错误、补标点、去口头禅，不概括不增删 |
| 仅转录原文 | 不加提示词，纯文本 |

提示词里明确要求模型**结合上下文修正同音错字**（人名、产品名、术语最容易错），
并且**无法判断的地方标注 [听不清]、不要编造** —— 语音识别一定会出错，让模型
猜比留白更危险。

## 能捕获什么

| 声音来源 | 是否支持 |
|---|---|
| 标签页里播放的声音（会议中其他人说话、视频、网页音频） | ✅ |
| 你自己的麦克风 | ✅（需授权） |
| 你分享/演示给会议的音频 | ❌ 出站音频本地不回放，抓不到 |
| 原生 App（Zoom 客户端、Spotify、系统声音） | ❌ macOS 限制，需 BlackHole 之类虚拟声卡 |

## 工作原理

```
chrome.tabCapture ─→ 通道「对方」─→ VAD ─→ SenseVoice ─┐
麦克风（可选）─────→ 通道「我」──→ VAD ─→ SenseVoice ─┼─→ 侧边栏（实时稿）
                                                       └─→ 保留 PCM → 精修稿
两路混音 ─────────→ MediaRecorder ─→ recording_*.webm
```

一次会议产出三个文件：`transcript_*_live.txt`（实时稿）、`transcript_*_refined.txt`
（精修稿）、`recording_*.webm`（录音）。

### 关于说话人识别

没有用声纹分离模型，而是利用了浏览器扩展的两个结构性优势：

1. **两路音频本来就是分开的** —— 标签页音频只包含远端参会者，麦克风只包含你。
   不混音、分别识别，「我」和「对方」的归属就是 100% 准确的，不存在聚类错误。
2. **Meet 页面上写着名字** —— 内容脚本读取当前发言者，转录直接标 `李明：`。
   纯音频方案（包括豆包）只能给出「说话人 1」，因为它不知道人叫什么。

代价与边界：
- 多个远端参会者之间**不做区分**，都归为一个人（或 Meet 提供的当前发言者姓名）
- Meet 的 DOM 会随版本变化，姓名识别可能失效，届时静默退回「对方」；
  侧边栏的调试日志会显示当前检测到的姓名，是排查的第一入口
- 麦克风开启了回声消除；万一仍有泄漏，会按文本比对丢弃重复的回声片段

### 关于采集线程（重要）

音频采集跑在 **AudioWorklet**（独立音频线程），不是 `ScriptProcessorNode`。

这不是为了赶时髦。`ScriptProcessorNode` 的回调在**主线程**，而 SenseVoice 推理是
**同步 WASM 调用、每段要跑 1~2 秒**。两者在同一线程时，每识别一句就阻塞采集一两秒，
音频被整块丢掉 —— 表现为模型重复吐字（`你你你你你…`）和大量噪声文本。
双通道之后问题翻倍。

现在采集在音频线程完成并顺带降采样到 16 kHz，推理走异步队列。
实测：主线程被阻塞 1.2 秒期间音频零丢失；重采样后 440 Hz 正弦仍测得 440.2 Hz、
波形连续无拼接断裂。

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

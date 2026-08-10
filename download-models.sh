#!/usr/bin/env bash
# Fetch the two model binaries that are too large for git (100 MB GitHub limit).
# Everything else in this extension is already in the repo.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p sherpa/models

WASM_SPACE="https://huggingface.co/spaces/k2-fsa/web-assembly-vad-asr-sherpa-onnx-zh-zipformer-ctc/resolve/main"
SENSEVOICE="https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main"

# path | url | expected bytes
FILES=(
  "sherpa/sherpa-onnx-wasm-main-vad-asr.data|$WASM_SPACE/sherpa-onnx-wasm-main-vad-asr.data|367731576"
  "sherpa/models/sensevoice.int8.onnx|$SENSEVOICE/model.int8.onnx|239233841"
)

for entry in "${FILES[@]}"; do
  IFS='|' read -r path url expected <<< "$entry"

  if [ -f "$path" ] && [ "$(wc -c < "$path")" -eq "$expected" ]; then
    echo "✓ $path already present"
    continue
  fi

  echo "⬇ downloading $path ($((expected / 1024 / 1024)) MB) ..."
  curl -fL --progress-bar "$url" -o "$path"

  actual=$(wc -c < "$path")
  if [ "$actual" -ne "$expected" ]; then
    echo "✗ $path is $actual bytes, expected $expected — download incomplete" >&2
    exit 1
  fi
  echo "✓ $path"
done

echo
echo "Models ready. Load the folder via chrome://extensions → Load unpacked."

# 真人 ASR 语料（G1-1）

本目录存放 Owner 浏览器采音后「存为语料」的 WAV 文件（**不入 git**）。

## 采集步骤

1. 设置面板 → 语音引擎选 **本地 SenseVoice**
2. 画布麦克风录音 → 识别成功后点 **存为语料**（💾）
3. 文件落盘为 `real-YYYYMMDDhhmmss.wav`
4. 运行 `npm run asr:cer` 验证 CER

## API

```bash
curl -X PUT "http://localhost:3001/api/asr/corpus/my-utt-01" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @recording.wav
```

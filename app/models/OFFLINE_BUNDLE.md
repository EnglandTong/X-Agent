# 模型包清单（分阶）

> **2026-09-07 Owner 澄清**：当前阶段 —— **语音（ASR）本地化**；**大脑继续用线上 LLM**。  
> 本机暂不跑 Qwen3-0.6B（体积大、运行吃力）。完整 ASR+0.6B≈640MB 仅作远期断网目标。  
> 权重 **不进 Git**；本文件是安装清单与合规说明。

## 当前阶段（推荐现在做）

| 组件 | 约占用 | 状态 |
|---|---|---|
| SenseVoice int8（sherpa-onnx） | **~229MB** | **当前要装**；热词 + CER |
| 云端 LLM（火山等） | 0（本机） | **大脑继续走线上** |
| Qwen3-0.6B | ~400MB | **暂缓**；设置里保留快捷项即可 |

## 远期：完整断网包（≈640MB）

机器吃得消、且要宣称「断网正式版」时再装 ASR + 0.6B。

## 目录约定

```
app/models/
  OFFLINE_BUNDLE.md          ← 本文件
  asr/
    hotwords.txt             ← npm run hotwords 生成（可进 Git）
    sensevoice/
      model.int8.onnx        ← ~229MB（不进 Git）
      tokens.txt
      LICENSE
  llm/
    qwen3-0.6b/              ← 远期；现阶可不装
      README.txt
```

## 获取步骤

### 1. ASR（当前优先）

从 [sherpa-onnx releases · asr-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) 下载：

`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`（或官方标注的 int8 包）

解压后将 `model.int8.onnx`、`tokens.txt`、随包 `LICENSE` 放入 `asr/sensevoice/`。

```powershell
$env:SHERPA_ASR_CMD="sherpa-onnx-offline ...你的模型参数..."
npm run asr:cer
npm run hotwords
```

### 2. LLM（当前：云端）

设置面板选 **LLM 大脑**，填火山（或其它 OpenAI 兼容）Key —— **不要为本机强拉 ollama 0.6B**。

### 3. 本地 0.6B（仅远期 / 可选评测）

```powershell
ollama pull qwen3:0.6b
# 设置面板「可选·暂缓」快捷项，或 LOCAL_LLM_* + npm run eval:compare
```

## 验收（当前阶段）

- [ ] SenseVoice 权重就位（~229MB）  
- [ ] `npm run hotwords` 成功  
- [ ] 云端 LLM「保存并测试」连通  
- [ ] （有 wav 后）`npm run asr:cer`  
- [ ] ~~本机必跑 0.6B~~ ← **现阶不做**

## 合规

- Apache-2.0 NOTICE（Qwen3、sherpa-onnx）——装到哪写到哪  
- SenseVoice 权重原 LICENSE  
- 不强制 UI「Built with」类署名（排除 GLM-Edge / MiniCPM）

## 明确不做（本阶段）

- 蒸馏专属模型  
- **强制本机跑本地大脑**  
- FunASR Python + ModelScope 联网校验作为离线 ASR 方案  

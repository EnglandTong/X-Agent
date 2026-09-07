# 小模型对比说明

运行 `npm run eval:compare` 生成 `results/compare-models.md`。最新结果以该文件为准。

## 当前产品分工（2026-09-07 澄清）

| 角色 | 选择 |
|---|---|
| 大脑 | **云端 LLM**（本机暂不跑 0.6B） |
| 语音 | **本地 ASR**（SenseVoice）目标 |
| 规则 | 无 Key / 失败时回落 |

设置面板优先级文案：`cloud_llm > rules（ASR 本地化；本地 LLM 暂缓）`。

## 可选：对比本地 0.6B（机器吃得消时）

```powershell
$env:LOCAL_LLM_BASE_URL="http://127.0.0.1:11434/v1"
$env:LOCAL_LLM_API_KEY="ollama"
$env:LOCAL_LLM_MODEL="qwen3:0.6b"
npm run eval:compare
```

现阶主路径评测：填云端 Key 跑 `npm run eval` 即可，不必 pull Ollama。

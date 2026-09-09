# 小模型对比说明

运行 `npm run eval:compare` 生成 `results/compare-models.md`。最新结果以该文件为准。

## 当前产品分工（2026-09-09）

| 角色 | 选择 |
|---|---|
| 大脑 | **云端 LLM**（D9：本地 0.6B **未达标**，不切默认） |
| 语音 | **本地 ASR**（SenseVoice）+ interpret 文本规整 |
| 规则 | 无 Key / 失败时回落 |

## 最近一次对比（2026-09-09 · Ollama `qwen3:0.6b` CPU）

| 引擎 | 模型 | 动词准确率 | 槽位命中率 | 错误数 |
|---|---|---|---|---|
| rules | （规则引擎） | **96.2%** | **95.3%** | 0 |
| local | qwen3:0.6b | **83.0%** | **89.0%** | 1 |

### D9 裁决

❌ 本地未达标（动词 83.0% < 规则 96.2%；槽位 89.0% < 规则×0.95=90.5%）→ **默认档保持云端**；本地仅作设置面板可选。

云端本轮 `SKIP_CLOUD=1`（环境无 Key）；以既有基线云端 **100%/100%** 为参照，本地更远低于云端。原始报告：`eval/results/compare-models.md`。

## 可选：对比本地 0.6B

```powershell
$env:LOCAL_LLM_BASE_URL="http://127.0.0.1:11434/v1"
$env:LOCAL_LLM_API_KEY="ollama"
$env:LOCAL_LLM_MODEL="qwen3:0.6b"
$env:SKIP_CLOUD="1"
npm run eval:compare
```

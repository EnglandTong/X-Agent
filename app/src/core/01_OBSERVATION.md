# 01 · Observation 与适配器标准（对外说明）

> **给谁看**：要对接新感官（耳/眼/…）或新模型（云端/本地/规则）的人。  
> **一句话**：核心只吃同一种输入；你只负责把「外面的世界」翻成这种输入。  
> **版本**：v1.0 · 2026-09-09 · 落点 `app/src/core/`（随主干搬仓）

---

## 〇、为什么要统一

最后落库的永远是**数据**（客户 ID、型号、数量、日期……）。  
Agent / 模型的工作不是「懂麦克风」或「懂火山 API」，而是：

```
自然语言原话  →  动词 + 原话槽位  →  消解成确定数据  →  确认  →  落库
```

键盘打出来、耳朵听出来、眼睛（远期）扫出来 —— **进核心之前必须变成同一种东西**。  
前期差异全在「怎么辨认 / 怎么适配」；核心路径不变。

---

## 一、两层分工（铁律）

```
┌──────────────────────────────────────────────────────────┐
│  外层 · 适配器（可换、可并行多份）                          │
│    感官适配器：mic / cam / …  →  Observation               │
│    模型适配器：云端 / 本地 / 规则 → { verb, slots }         │
└────────────────────────────┬─────────────────────────────┘
                             │ 只准这一条缝
┌────────────────────────────▼─────────────────────────────┐
│  内层 · 核心（统一、尽量不改）                              │
│    Observation.text → interpret → resolve → confirm → run │
│    能力用 x-agent manifest 声明（一份 Schema 三消费者）     │
└──────────────────────────────────────────────────────────┘
```

| 层 | 谁改 | 改了会怎样 |
|---|---|---|
| **外层适配器** | 对接硬件 / 供应商 / 新模型的人 | 核心与评测**不动** |
| **内层核心** | 主干维护者 | 所有适配器与应用一起回归 |

**禁止**：让核心 `import` 某个 ASR SDK、某个云厂商 SDK、某个相机驱动。  
**禁止**：第二套「给模型看的协议」—— 能力描述 100% 复用 x-agent（决策 D3）。

---

## 二、内层统一输入：Observation

类型定义：`observation.ts` 的 `Observation`。

```jsonc
{
  "modality": "audio",          // text | audio | image | …
  "source": "mic-01",           // 谁采的
  "at": "2026-09-09T08:00:00Z",
  "payload": "给张三来五十个A-100", // ★ 现阶段核心只吃这段自然语言
  "confidence": 0.87,
  "raw": "blob:asr-wavs-real/asr-01.wav", // 可选；核心不读内容
  "recognizer": "local-sensevoice"        // 哪只辨认器
}
```

### 现行消费规则（必须守）

1. **核心决策入口只消费自然语言字符串**（`observationText(o)`）。  
   audio / image 适配器的职责 = **先辨认成 text**，再交给核心。
2. 模型**只输出用户原话片段**（槽位），不输出 ID、不算日期、不转数字 —— 消解在 `resolve`。
3. 写操作必经确认卡；格子提交即冻结。

键盘输入是退化的 Observation：`textObservation("给张三来…")`（`recognizer: passthrough`）。

### 加一个感官 = 加什么

| 做 | 不做 |
|---|---|
| 实现一个 `SensoryAdapter`（`modality` + `recognize`） | 改 interpret / resolve / Run 六态 |
| 把辨认结果放进 `payload`（string） | 让核心去解 WAV / 图片二进制 |
| 在设置里可选该适配器（可选） | 新定第三套「视觉协议」 |

---

## 三、外层：两类适配器

### 3.1 感官适配器 `SensoryAdapter`

```
原始信号（字节 / SDK 事件）  →  recognize()  →  Observation
```

| 现状 | id 示例 | modality | 说明 |
|---|---|---|---|
| ✅ | `passthrough` | text | 画布输入框 |
| ✅ | `browser-webspeech` | audio | 浏览器耳（默认） |
| ✅ | `local-sensevoice` | audio | 本地耳（`POST /api/asr`） |
| 🔴 | （未做） | image | OCR；远期 VLM |

现行代码落点（实现在 `server/`，**契约**在 `core/`）：

- 耳：`server/asr.ts` + `ui/voiceRecorder.ts`
- 嘴（输出侧 Action，不是 Observation）：`server/speak.ts`

文本规整（`asrNormalize`）挂在 **interpret 入口**，不属于某只耳朵 —— 两只耳朵（以及键盘）都受益。

### 3.2 模型适配器 `ModelAdapter`

```
Observation | string  →  extract()  →  { verb, slots, confidence }
```

| 现状 | id / kind | 说明 |
|---|---|---|
| ✅ | `rules` | 无 Key / 失败回落 |
| ✅ | `openai` / `pi` | 云端 OpenAI 兼容 |
| ⚠️ | 本地 Ollama | 已对比未达标（D9），设置里可选 |

**模型适配器不许做的事**：消解实体 ID、算「下周三」、写库。  
那些是核心的 `resolve` / `verbs`。

---

## 四、对外对接检查清单

新人接一个「外面的东西」时，按顺序勾：

1. [ ] 辨认清楚：我是 **感官适配器** 还是 **模型适配器**？
2. [ ] 输出是否已是本标准的 `Observation` / `ModelAdapterResult`？
3. [ ] 核心路径（interpret → resolve → run）是否 **零改动** 就能跑通一条口吻？
4. [ ] 是否补了至少 3 条评测 / 冒烟？（感官 → CER 或真人语料；模型 → `eval`）
5. [ ] 是否更新了 `HANDOVER/05_TEST_LOG.md`？
6. [ ] `core/` 里是否出现了对 `server/` 的 import？（必须没有）

---

## 五、与现有档案的关系

| 文件 | 关系 |
|---|---|
| `00_MANIFEST.md` | 能力侧（x-agent）标准；本文件是**输入侧**标准 |
| `run.ts` | 一次任务生命周期；`received` 态的输入即 Observation |
| `HANDOVER/04_DECISIONS` #27 | 三层仓与感官枚举的决策原文 |
| `HANDOVER/02_ARCHITECTURE.md` | 五层实现架构；本标准是其上的协议切片 |

事实源仍是：工作树 + `HANDOVER/` + 本 `core/`。不另开 13/14 号平行档案。

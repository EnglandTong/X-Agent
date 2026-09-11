# 14 · 项目总纲与开发计划

> **用途**：Owner 与 AI 的**唯一路线图入口**——想法多时先回本文，再决定进哪个 Phase。  
> **范围**：全项目（主 `packages/core` + 支 `apps/agent-erp`）；业务细节仍以 `01`–`04`、`13` 为准。  
> **版本**：v1.0 · 2026-09-11 · 对应 `main` @ `b9e92df`（Phase 2 G0–G3 已合并）

---

## 一、一句话 + 一张图

**一句话**：用自然语言（语音 / OCR / 键盘）驱动业务动作；系统理解意图、填槽、接地；人在**确认卡**上点一下才落库；画布上每一格**提交即冻结**。

**两层结构**（2026-09-11 定稿，不要混）：

| 层 | 路径 | 角色 | 文档 |
|---|---|---|---|
| **主 · X-Agent** | `packages/core/` | 协议与类型：Observation、manifest、Run 生命周期 | `packages/core/*.md` |
| **支 · Agent_ERP** | `apps/agent-erp/` | 第一条垂直样机：销售订单 → 出货 PoC | `HANDOVER/` |

GitHub：**[EnglandTong/X-Agent](https://github.com/EnglandTong/X-Agent)**。ERP 不是终点，是验证「躯干能不能挂业务」的试验田。

```
你的输入（说 / 拍 / 打）
        ↓
  Observation（统一格式）
        ↓
 interpret → resolve → 确认卡（Formily 按 Schema 生成）
        ↓
 人确认 → 动词 run → SQLite 落库 → 画布多一格（永久冻结）
```

**与「生成式快速开发」的关系**：不是在 Figma 里画采购单页面，而是**声明字段清单（Schema）→ 用时自动生成表单**。已在 `order.create.json` 等文件实现；采购单 = 换一份 Schema + 换主数据，不是先画 UI。

---

## 二、核心设计信条（定死了，别反复争论）

| # | 信条 | 含义 |
|---|---|---|
| 1 | **动词驱动** | 能力是 `order.create`、`delivery.confirm`… 不是 `/api/orders` CRUD |
| 2 | **一份 Schema，多个消费者** | 同一份 JSON 同时喂：UI（Formily）、模型工具定义、评测 |
| 3 | **记录不可变** | 已确认单不能改；要改 = 变更单（新单号 + `originNo` 串联） |
| 4 | **模型只听写** | 模型只吐原话片段；ID、日期、数字全由 `resolve.ts` 确定性算 |
| 5 | **一次问完** | 缺字段批量问，不语音来回追问 |

**五条红线**（违反 = 做错）——详见 `00_START_HERE.md` §三：

1. 格子提交即冻结  
2. 已确认 / 已出货不能改，只能变更单  
3. 模型不输出 ID / 不算日期  
4. 一次问完缺失字段  
5. **范围外不做**：采购、财务、权限、多租户  

---

## 三、技术架构（五层）

```
L1  UI 画布      App.tsx · ConfirmCard · Formily（表单自动生成）
L2  Agent       interpret / llm / rules / resolve / 接地 A+B
L3  动词层      verbs/*.ts · registry（13 个动词）
L4  领域规则    信用、起订、底价、库存、出货剩余量
L5  数据层      Prisma + SQLite（Customer/Order/Delivery/Panel/Lexeme…）
```

**输入标准**（`packages/core/01_OBSERVATION.md`）：耳、眼、键盘都是 **Observation** → 后面 pipeline 完全相同。

**接地优先级**（Phase 2 定稿，见 `13_PHASE2_GROUNDING.md`）：

```
个人用语 A（active）
  → 企业别名 B（active，须人工批准）
  → 主数据 code 精确
  → fuzzy（分差 < 0.08 必问）
  → 数量 / 日期确定性解析
```

---

## 四、当前进度（Phase 0 + Phase 2 已完成）

> 活状态以 `00_START_HERE.md` §二 为准；本节是总纲视角的里程碑勾选。

### 4.1 业务能力（13 动词，销售线闭环）

| 域 | 动词 | 状态 |
|---|---|---|
| 订单 | query / create / confirm / cancel | ✅ |
| 出货 | create / confirm / query | ✅ |
| 库存 | query / reserve / release | ✅ |
| 客户 / 信用 | customer.query / credit.check | ✅ |
| 记忆 | lexicon.remember | ✅ |

加动词标准动作：写 `schema/*.json` + `verbs/*.ts` + 注册 → **前端零改**（见 `06_ROADMAP.md` 检查清单）。

### 4.2 感官与接地（Phase 2 · G0–G3）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **G0** | 企业别名 B、`EnterpriseAlias`、resolve、eval | ✅ PR #6 |
| **G1** | 出货口吻规则、ASR 规则档 94.7%、热词含别名 | ✅ PR #8 |
| **G2** | 微信截图 OCR、画布上传、`eval:ocr` 10/10 | ✅ PR #8 |
| **G3** | 会话上下文、「就按上一张图」、确认卡摘要 | ✅ PR #8 |

### 4.3 AI 骨干

| 部件 | 策略 | 说明 |
|---|---|---|
| **大脑** | 云端 LLM 默认 | 本地 0.6B 对比未达标 → 不切默认（`COMPARE_MODELS.md`） |
| **耳** | 浏览器 Web Speech + 本地 SenseVoice | 文本规整层已接 interpret |
| **眼** | 微信订单 OCR 单场景 | 建议别名进 B 为 `candidate`，不自动 `active` |
| **说** | TTS 已接画布 | 设置面板可关 |

### 4.4 评测基线（改代码必双跑）

```bash
npm run eval              # 主评测（utterances.jsonl）
npm run eval:asr          # 真口吻 ASR（规则档 verb 94.7%）
npm run eval:enterprise   # 企业别名 6/6
npm run eval:ocr          # OCR 10/10
npm run eval:context      # G3 上下文 3/3
npm run trial:owner10     # Owner 十条真链路
```

**已知缺口**（记入 Phase 1，不算翻车）：

- `trial:10`：信用句式「老王信用够不够…」规则未抽 customer  
- 浏览器真人采音、真人 CER 仍缺机器证据  
- `eval:asr` 仍有 2 条 verb 边界未命中（见 `eval:asr` 报告）

---

## 五、明确不做 vs 可以怎么做

| 不做（当前红线） | 可以怎么做（不越界） |
|---|---|
| 采购 / 财务 / 权限模块 | 只写 `purchase.create.json` **草案**验证「选题面 → 生成页」，不接真实业务表 |
| 向量 RAG / 开放域世界模型 | 用 A+B 接地 + 主数据 fuzzy |
| 自由排版 / 拖拽 UI | Schema + `x-index` 排顺序即可 |
| 通才生成整页 HTML | 结构化 Formily 实例，可控可评测 |
| 用 Git 分支硬拆框架与 ERP | 已在 monorepo：`packages/core` + `apps/agent-erp` |

---

## 六、Owner 想法的四抽屉（防漂移）

新想法先归类，**每周只开一个抽屉做 P0**：

| 抽屉 | 内容 | 现在状态 |
|---|---|---|
| **[躯干]** | `packages/core` 协议 | Phase 0 已抽出；Phase 4 验证第二垂直 |
| **[样机]** | `apps/agent-erp` 销售线 | Phase 2 完成；Phase 1 稳定验收 |
| **[生成式]** | Schema / 选题面 / 采购草案 | 信条 2 已验证；Phase 3 产品化 |
| **[产品化]** | 权限 / 多租户 / 商业化 | Phase 5，须 Phase 2 验证通过后才开 |

---

## 七、开发计划（Phase 0 → 5）

### Phase 0 · 基线 ✅ 已完成

- [x] 13 动词销售 → 出货闭环  
- [x] Schema 双消费 + 确认卡 + 不可变格子  
- [x] 云端 LLM + 规则回落  
- [x] 个人用语 A + 企业别名 B（G0）  
- [x] ASR / OCR / 上下文（G1–G3）  
- [x] Monorepo：`@x-agent/core` 抽出  

**出口标准**：`npm run typecheck && npm run build && eval 套件不劣化`。

---

### Phase 1 · 稳定与 Owner 验收 ← **当前阶段**

**目标**：让「能跑」变成「你敢每天用」。

| 优先级 | 任务 | 验收 |
|---|---|---|
| **P0** | Owner 真机：SenseVoice 采音 → 存语料 → 开单 → 确认 → 出货 | `trial:owner10` ≥ 9/10 |
| **P0** | 修 `trial:10` 信用句式规则 | `credit.check` 能抽「老王」 |
| **P1** | 双跑回归：`eval` + `eval:asr` + `eval:enterprise` | 不劣化基线 |
| **P1** | 档案与 main 一致 | `00` 状态表、`05` 验证记录 |
| **P2** | 真人录音 CER（非 SAPI 合成） | 一份 `asr-cer-real` 报告 |

**本阶段不做**：采购模块、新动词（除非修 bug）、UI 美化。

---

### Phase 2 · 范式验证

**目标**：回答——**「一句话 ERP」在真实小场景里是否比填表省时间？**

| 任务 | 说明 |
|---|---|
| Owner 固定场景跑 2 周 | 例如自己小贸易的下单 + 出货 |
| 错例库 | 每条：原话 / 期望 / 实际 / 归类 A/B/C/D |
| 记忆升格体感 | 「老张 = 张三」跨天是否自然 |
| OCR 真截图 20 张 | 脱敏后进 eval，不只靠合成 |

**出口标准**：Owner 书面结论——继续投入 / 调整方向 / 归档。

---

### Phase 3 · 生成式开发产品化

**目标**：从「手写 JSON Schema」到「选题面即生成能力」。

| 步骤 | 交付物 | 说明 |
|---|---|---|
| 3.1 字段选题器（最小） | 勾选字段 → 导出 `*.json` | 先配置器，不必 NL 生成 Schema |
| 3.2 模板库 | `order.create` / `delivery.create` 作模板 | 采购单 = 换字段名 + resolution |
| 3.3 NL→Schema（可选） | 「做采购单要供应商、行项目…」→ 草案 | 人审后再入库，防幻觉 |
| 3.4 文档一条线 | 《如何 30 分钟加一个新动词》 | 给未来的 Owner / AI |

**采购单在此阶段的定位**：`purchase.create.json` + 3～5 条 eval 口吻 + **不接 Prisma 采购表** —— 只验证「生成式页面」手感。

---

### Phase 4 · 躯干验证（X-Agent 不是 ERP 专用）

**目标**：换垂直，躯干不动。

| 选项 | 做法 |
|---|---|
| A | 第二个 `apps/agent-xxx/`（如简单工单 / 巡检） |
| B | 同一 ERP 加只读动词（不扩写操作） |
| C | 把 `core` 发布成独立 npm 包文档 |

**出口标准**：新应用复用 Observation + manifest + 确认卡模式，**不改** `packages/core` 协议。

---

### Phase 5 · 产品化决策（6～12 月节点）

仅在 Phase 2 验证**通过**后考虑：

- PostgreSQL / 多用户 / 权限  
- 断网完整包（ASR + 小模型 ~640MB）  
- 对外演示 / 第一个付费场景  
- 是否从 PoC 升级为产品  

**12 月决策**：继续 / 内部工具 / 归档（见 `06_ROADMAP.md` §四）。

---

## 八、治理：避免想法不连贯

### 8.1 新会话开场 prompt（Owner 可直接复制）

```
读 HANDOVER/00_START_HERE.md 与 HANDOVER/14_MASTER_PLAN.md。
再按 01 → 02 → 03 → 04 扫一遍。
用不超过 10 行回答：
1) 现在在哪个 Phase、P0 是什么
2) 五条红线
3) 你需要我提供什么
不要改代码，先确认理解。
```

### 8.2 新想法三道筛

| 问题 | 否 → 进 backlog，不当 P0 |
|---|---|
| 是否违反五条红线？ | |
| 是「新动词 / 加深规则 / 感官 / 治理」哪一种？ | |
| 验收口吻一句是什么？ | |

### 8.3 状态只改这些地方

| 改什么 | 写哪里 |
|---|---|
| 阶段 / P0 / 验收 | `00_START_HERE.md` §二、§四 |
| 新决策 | `04_DECISIONS.md` 加一行 |
| 路线图 Phase 调整 | **本文** §七 |
| 验证结果 | `05_TEST_LOG.md` |

**不要**新建平行 `PLAN_v2.md`；本文是唯一路线图长文。

---

## 九、相关档案索引

| 文件 | 何时读 |
|---|---|
| `00_START_HERE.md` | 每次接手；活状态快照 |
| `01_VISION.md` | 产品哲学 |
| `02_ARCHITECTURE.md` | 写代码前 |
| `03_VERBS.md` | 写动词前 |
| `04_DECISIONS.md` | 避免重蹈覆辙 |
| `06_ROADMAP.md` | 加动词检查清单 |
| `13_PHASE2_GROUNDING.md` | Phase 2 工单明细（已完成，作追溯） |
| `12_HANDOFF.md` | 派工单纪律 |
| **本文 `14_MASTER_PLAN.md`** | 想法多时、排期时、对齐 Phase 时 |

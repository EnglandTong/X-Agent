# 00 · 从这里开始（给接手的 AI）

> **范围**：本 `HANDOVER/` 只描述 **支 · Agent_ERP**（`apps/agent-erp/`）。  
> **主 · X-Agent** 框架见 [`packages/core/README.md`](../packages/core/README.md) —— 不要从本目录推断协议边界。

> 这份档案是**自包含**的。你不需要看任何历史聊天记录 —— 读完 `00 → 01 → 02 → 03 → 04`，
> 再扫 [`14_MASTER_PLAN.md`](./14_MASTER_PLAN.md) 对齐 Phase，你就能接着往下做。

**项目代号**：Agent_ERP（支）· 仓库名 **X-Agent**（主仓 monorepo）  
**应用路径**：`apps/agent-erp/`（原 `app/`）  
**档案版本**：v1.9 · 2026-09-11（**Phase 2 G0–G3 已合并** · 总纲 `14` 落档）  
**代码状态**：`main` @ **`b9e92df`**（PR #8 合并）—— **13 动词**；云端 LLM 已通；**企业别名 B（G0）**；**ASR 规则档 94.7%（G1）**；**微信 OCR 10/10（G2）**；**会话上下文 + 确认卡摘要（G3）**；记忆 v2；TTS + 双 ASR 引擎；本地 0.6B 未达标仍用云端默认。

**当前阶段**：**Phase 1 · 稳定与 Owner 验收**（见 `14_MASTER_PLAN.md` §七）。

### 事实源优先级（避免多份互相打架）

| 优先级 | 来源 | 用途 |
|---|---|---|
| **1（唯一活源）** | GitHub `EnglandTong/X-Agent` · `main` + 本 `HANDOVER/`（支）/ `packages/core/`（主） | 接手、改代码、改档案都只认这里 |
| 2 | `Agent_ERP.bundle` | **只作历史备份**（早期 5 次提交）；clone 后若与 `main` 冲突，以 `main` 为准 |
| 3 | `agt-erp-src.zip` | **只作网盘快照**；改完代码/档案后必须按 `07_OPS.md` 重打，否则视为过期 |

改状态、改决策、改验证结果 → **只改 `HANDOVER/` 并提交**；zip/bundle **不进 Git**（已 gitignore）。

---

## 一、30 秒理解这个项目

传统 ERP 是「人去适应表单」：先找到菜单、再填 20 个字段、错了再改。
这个项目的命题是反过来：**系统理解人话**。

用户在底部输入框说一句「给张三来 120 个 A-100，下周三要」→
系统判断意图（动词）、抽出原话里的信息（槽位）、消解成确定的数据（客户 ID / 日期 / 数字）、
在画布上「Print」出一格确认卡 → 人点一下确认 → 落库，格子**永远冻结**。

核心不是聊天机器人，是**用自然语言驱动的、不可变的业务记录系统**。

---

## 二、当前状态快照（2026-09-11 · `main` @ `b9e92df`）

| 项目 | 状态 | 说明 |
|---|---|---|
| **开发阶段** | 🟡 **Phase 1** | Phase 0 + Phase 2（G0–G3）已完成；详见 [`14_MASTER_PLAN.md`](./14_MASTER_PLAN.md) |
| 动词数量 | ✅ **13** | 订单→出货 12 个 + `lexicon.remember`（D10） |
| Agent 引擎 | ✅ **云端模型已通** | `doubao-seed-2.0-lite`；失败仍回落 rules；低置信只读诚实提示（D11） |
| 接地层 | ✅ **A + B** | 个人用语 `PersonalLexeme` + 企业别名 `EnterpriseAlias`（B 须人工 `active`）；见 `13_PHASE2_GROUNDING.md` |
| 前端画布 | ✅ 可用 | 不可变格子 + 修订/变更单 + 「记住这个说法」+ 语音 + **上传订单图（OCR）** + 上下文摘要 |
| 数据库 | ✅ SQLite | Customer / Order / Delivery / Panel / Lexeme / **EnterpriseAlias** |
| 派工单 T0–T6 | ✅ **全部完成** | 见 `12_HANDOFF.md` |
| Phase 2 G0 | ✅ **企业别名 B** | PR #6 · `eval:enterprise` **6/6** |
| Phase 2 G1 | ✅ **耳收尾** | 出货口吻规则 · `eval:asr` 规则档 verb **94.7%**（36/38）· 热词含 active 别名 |
| Phase 2 G2 | ✅ **眼 OCR** | 微信订单截图 · `POST /api/ocr` · `eval:ocr` **10/10** |
| Phase 2 G3 | ✅ **上下文** | `sessionContext` · 「就按上一张图」· `contextSummary` · `eval:context` **3/3** |
| 记忆 | ✅ **v2** | 候选→跨天升格 · 画布提示 · `GET /api/memory/cooccur` |
| TTS（说） | ✅ 已接画布 | `POST /api/speak` + 设置面板开关 |
| ASR（听） | ✅ 双引擎 + 规整 | 默认 `browser` Web Speech；可切本地 SenseVoice（`POST /api/asr`）；`asrNormalize` 在 interpret 入口；合成语音 CER **34.02%**（偏乐观） |
| 源码版本 | ✅ GitHub `main` | **`EnglandTong/X-Agent`** @ `b9e92df` |
| 密钥文件 | ✅ `.env.local` | 设置面板填 Key；不进 Git |
| 评测套件 | ✅ 六件套 | `eval` **46/53** · `eval:asr` 规则 verb **94.7%** · `eval:enterprise` **6/6** · `eval:ocr` **10/10** · `eval:context` **3/3** · `eval:lexicon` / `eval:compare` |
| 已验证项 | ✅ 见 `05_TEST_LOG.md` | Phase 2 各里程碑 + 历史 T0–T6 |
| **未验证 / 缺口** | ⚠️ | 浏览器真人采音全流程（见 `05` §二）· **真人录音 CER** · `trial:10` 信用句式 · `eval:asr` 2 条 verb 边界 · 并发 · PostgreSQL |

---

## 三、五条红线（违反就是做错）

| # | 红线 | 为什么 |
|---|---|---|
| 1 | **格子提交即冻结，永不原地修改** | 审计即界面。要改就新开一格 |
| 2 | **已确认/已出货的单子不能改，只能另开变更单** | 真实 ERP 语义。两单用 `originNo` / `supersededByNo` / `chainId` 双向串联 |
| 3 | **模型只输出用户原话片段，不输出 ID / 不算日期 / 不转数字** | 小模型算不准；确定性必须归代码 |
| 4 | **一次问完缺失字段，绝不逐个追问** | 语音场景，来回追问是体验杀手 |
| 5 | **范围外的一律不做**（采购、财务、权限、多租户） | Owner 明确要求严格范围，禁止顺手优化与 scope creep |

---

## 四、接手后第一步做什么（Phase 1 · 2026-09-11）

| P | 事项 | 验收标准 |
|---|---|---|
| **P0** | Owner 真机跑通十条口吻 | `npm run trial:owner10` ≥ **9/10**；开单→确认→出货闭环 |
| **P0** | 修 `trial:10` 信用句式 | 「老王信用够不够…」→ `credit.check` 能抽到 customer |
| **P1** | Owner 浏览器采音 + 存语料 | 设置切 SenseVoice → 麦克风 → 「存为语料」→ `eval/asr-wavs-real/` 有 wav；步骤见 `05_TEST_LOG.md` §二 |
| **P1** | 回归不劣化 | `npm run eval` + `eval:asr` + `eval:enterprise` + `eval:ocr` + `eval:context` |
| **P1** | Owner 体感：记忆升格 | 「记住：老张就是张三」→ 跨天再说 → 升格提示 |
| **P2** | 真人录音 CER | 非 SAPI 合成；报告进 `eval/results/` |
| **P2** | 阶段备份 | push + 重打网盘包，见 `07_OPS.md` |

> 完整路线图（Phase 2–5）：[`14_MASTER_PLAN.md`](./14_MASTER_PLAN.md) §七。

---

## 五、新会话的第一条 prompt（Owner 可直接复制）

```
读取 HANDOVER/00_START_HERE.md 与 HANDOVER/14_MASTER_PLAN.md，
然后按 01 → 02 → 03 → 04 顺序读完。
读完后用不超过 10 行回答：
1) 项目现在处于什么 Phase、P0 是什么
2) 五条红线
3) 你需要我提供什么（比如 API Key、评测样本）
不要动手改代码，先确认你理解对了。
```

---

## 六、档案目录

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| `00_START_HERE.md` | 本文件：状态 + 红线 + 下一步 | 每次接手先读 |
| **`14_MASTER_PLAN.md`** | **项目总纲与 Phase 0–5 开发计划** | **想法多时、排期时必读** |
| `01_VISION.md` | 产品哲学、命题、明确不做的事 | 第一次读 |
| `02_ARCHITECTURE.md` | 五层架构、x-agent 协议、数据模型 | 写代码前 |
| （框架）`packages/core/01_OBSERVATION.md` | **输入侧对外标准**：Observation + 感官/模型适配器 | 接新耳/眼/模型前 |
| `03_VERBS.md` | **13 个动词**规格、业务规则、状态机、变更单、API | 写动词前 |
| `04_DECISIONS.md` | 决策日志（含被否决方案与 Owner 纠正） | **必读**，避免重蹈覆辙 |
| `05_TEST_LOG.md` | 已验证 / 未验证 / 复现命令 | 改完代码要回归时 |
| `06_ROADMAP.md` | 12 动词全景、加动词检查清单、节点 | 排期时 |
| `07_OPS.md` | 启动、备份、Key 配置、故障排查 | 跑不起来时 |
| `08_FILE_TREE.md` | 每个文件的职责 | 找代码时 |
| `09_GLOSSARY.md` | 术语表 + Owner 协作偏好 | 沟通前 |
| `10_SESSION_LOG.md` | 历次讨论流水 | 想知道「为什么」时 |
| `11_PERSONAL_LEXICON.md` | 接地层 A + B 概要 | 做习惯学习 / 别称记忆时 |
| `13_PHASE2_GROUNDING.md` | Phase 2 工单明细（G0–G3，已完成） | 追溯感官/接地实现时 |
| `12_HANDOFF.md` | 派工单：T0–T6 / 红线 / 并行纪律 | 交给外部执行者时 |

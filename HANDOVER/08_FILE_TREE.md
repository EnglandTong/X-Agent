# 08 · 文件清单与职责

> 4581 行代码（不含 node_modules）。每个文件干什么，一张表说清。

---

## 一、Schema 层（唯一事实来源）

| 文件 | 行 | 职责 |
|---|---|---|
| `src/schema/order.create.json` | 163 | 建单 Schema：9 个字段，含 `originNo`（变更单） |
| `src/schema/order.query.json` | 79 | 查询 Schema：4 个字段，无必填 |
| `src/schema/order.confirm.json` | 28 | 确认 Schema：`orderNo` |
| `src/schema/order.cancel.json` | — | 取消 |
| `src/schema/delivery.create.json` | — | 出货草稿（可选 `qty` 部分出货） |
| `src/schema/delivery.confirm.json` | — | 确认出货 |
| `src/schema/delivery.query.json` | — | 查出货 |
| `src/schema/inventory.*.json` | — | 查询 / 预留 / 释放 |
| `src/schema/customer.query.json` | — | 客户查询 |
| `src/schema/credit.check.json` | — | 信用检查 |

**改字段 = 改这里**。UI 与模型同时生效，不用改前端代码。

---

## 一-b、`core/`（主干协议层 · T5 抽离 · 不得 import server/）

| 文件 | 职责 |
|---|---|
| `src/core/00_MANIFEST.md` | **协议一页纸**：三个消费者、字段表、消解优先级、加能力套路、铁律、独立仓触发条件 |
| `src/core/manifest.schema.json` | x-agent manifest 的结构声明（JSON Schema，可用于校验） |
| `src/core/run.ts` | **Run 六态**（received/interpreted/awaiting/executed/blocked/abandoned）+ 合法转移表，纯类型 |
| `src/core/registry.ts` | 能力注册表（**只登记，不含实现**），保证 core 搬得走 |

> 搬仓目的地：**With me 主仓**（#27 / D1）。搬的前提是守住「core 不 import server」——
> 验证：`grep -r "from '\.\./server" src/core/` 必须为空。

---

## 二、服务端

| 文件 | 行 | 职责 | 备注 |
|---|---|---|---|
| `server/index.ts` | 364 | Fastify 路由、启动、Schema 加载、enum 水合 | 路由清单见 `03_VERBS.md` |
| `server/compile.ts` | 229 | Formily Schema → Tool Schema 编译器 + 编译期校验 | 双消费的实现 |
| `server/agent.ts` | 595 | **核心编排**：意图 → 抽取 → 消解 → 推断 → 缺失判定 | 换模型只影响这里的第 2 步 |
| `server/llm.ts` | 303 | OpenAI 兼容客户端（火山/DeepSeek/Ollama 通用）+ 连通性诊断 | 含 JSON 模式降级 |
| `server/settings.ts` | — | 模型配置、`qwen3:0.6b` 预设、`enginePriority` | Key 不进 git |
| `server/resolve.ts` | 415 | 消解器：8 种 resolution 策略 | **确定性代码**，模型不参与；个人用语优先 |
| `server/lexicon.ts` | — | 个人用语表 CRUD / 匹配 / 提议 | 非向量库 |
| `server/remaining.ts` | — | 订单行剩余可出货量 | delivery.* 共用 |
| `server/panels.ts` | 229 | 格子落库、修订准备（查实时状态）、链路查询 | |
| `server/verbs/registry.ts` | 24 | 动词注册表 | |
| `server/verbs/types.ts` | 47 | 动词接口定义 | |
| `server/verbs/order.create.ts` | 232 | 建单 + 修订 + 变更三种模式 + 业务规则 | 最复杂的动词 |
| `server/verbs/order.query.ts` | 65 | 查询 | |
| `server/verbs/order.confirm.ts` | 50 | DRAFT → CONFIRMED | |
| `server/verbs/order.cancel.ts` | — | 取消 | |
| `server/verbs/delivery.*.ts` | — | 出货创建/confirm/query | 剩余量见 remaining.ts |
| `server/verbs/inventory.*.ts` | — | 库存 query/reserve/release | |
| `server/verbs/customer.query.ts` | — | 客户 | |
| `server/verbs/credit.check.ts` | — | 信用检查 | |

---

## 二-b、脚本与评测

| 文件 | 职责 |
|---|---|
| `scripts/eval-interpret.ts` | 主评测：`npm run eval` |
| `scripts/eval-lexicon.ts` | 用语表夹具：`npm run eval:lexicon` |
| `scripts/eval-compare-models.ts` | 云端 vs 本地对比：`npm run eval:compare` |
| `scripts/export-hotwords.ts` | ASR 热词导出：`npm run hotwords` → `models/asr/hotwords.txt` |
| `scripts/asr-cer.ts` | SenseVoice CER 脚手架：`npm run asr:cer`（缺权重则跳过真实推理） |
| `scripts/smoke-delivery-remaining.ts` | 部分出货 / 超量硬拦冒烟（断言 + 非 0 退出） |
| `scripts/smoke-multiline-reserve.ts` | 多行订单 + 标量 qty 硬错 + 预留同步释放：`npm run smoke:multiline` |
| `scripts/smoke-verbs.ts` | 12 动词冒烟 |
| `scripts/trial-10-utterances.ts` | API 真链路 10 条：`npm run trial:10` |
| `scripts/trial-owner-10.ts` | **T1 派工单 10 条真口吻**：`npm run trial:owner10`（`BASE_URL` 换端口 / `SESSION_ID` 换画布 / `RESET_PANELS=1` 才清画布；单条失败不中断，跑完出 DB 计数） |
| `scripts/eval-asr-utterances.ts` | **真口吻动词准确率**：`npm run eval:asr`（`BASE_URL=:3002` 跑规则档）。持续暴露「评测集口径 96% vs 真口吻 78%」的差距；T4 改消解后必须重跑 |
| `eval/utterances.jsonl` | 主评测样本 |
| `eval/utterances.lexicon.jsonl` | 用语夹具样本 |
| `eval/asr-utterances.jsonl` | ASR CER 参考转写样本 |
| `eval/BASELINE.md` | 准确率基线 |
| `eval/COMPARE_MODELS.md` | 对比说明（含 Qwen3-0.6B） |
| `eval/failures.jsonl` | 错例 |
| `eval/results/*` | 评测产物（compare-models / latest / summary） |
| `models/OFFLINE_BUNDLE.md` | 分阶清单：当前 ASR≈229MB；0.6B 远期 |
| `models/asr/hotwords.txt` | 热词（可进 Git；由 hotwords 脚本生成） |
| `models/asr/sensevoice/` | SenseVoice int8（**当前本地语音**；权重不进 Git） |
| `models/llm/qwen3-0.6b/` | 本地大脑说明（**现阶暂缓**） |

---

## 三、前端

| 文件 | 行 | 职责 |
|---|---|---|
| `ui/App.tsx` | 431 | 画布主体：顶部上下文、格子列表、底部输入框 |
| `ui/ConfirmCard.tsx` | 231 | 待确认格：Formily 渲染 + 推断值高亮 + 三种提交文案 |
| `ui/PanelCard.tsx` | 131 | 历史格：编号、状态、修订/确认按钮（按实时状态分流） |
| `ui/ResultView.tsx` | 178 | 结果展示：含 `originNo` / `supersededByNo` / `chainId` |
| `ui/SettingsModal.tsx` | — | **模型设置面板**：云端 LLM；本地 0.6B 标「可选·暂缓」 |
| `ui/formily.tsx` | 32 | Formily 与 antd 的桥接 |
| `ui/widgets.tsx` | 67 | 自定义控件（客户/产品/实体选择器） |
| `types.ts` | 66 | 前后端共享类型（避免前端拖进 Prisma） |
| `main.tsx` | 24 | 入口 |

---

## 四、数据与配置

| 文件 | 行 | 职责 |
|---|---|---|
| `prisma/schema.prisma` | — | 表含 Order/Delivery/PersonalLexeme 等；Order 含变更单三件套与 `PARTIALLY_SHIPPED` |
| `prisma/seed.ts` | 98 | 种子数据：4 客户 / 3 产品 / 4 订单 / 库存 |
| `.env.example` | — | 模板（**不含密钥**） |
| `.env.local` | — | 模型 Key（**gitignore，未进版本库**） |

---

## 五、遗留与参考文件

| 文件 | 状态 | 说明 |
|---|---|---|
| `SPEC.md`（仓库根） | 早期 | 原始规格，部分已被 `HANDOVER/` 取代；以本档案为准 |
| `schema/*.json`（仓库根） | 早期 | 原型产物，权威版本在 `app/src/schema/` |
| `prototype/index.html` | 早期 | 静态原型 |
| `tools/schema-to-tool.ts` | 早期 | 命令行编译器，已被 `compile.ts` 取代 |

---

## 六、Git 历史

### A. 当前活源（GitHub `main`）

以 `main` 上最新提交为准。本轮已落地：**12 动词**、评测集、Pi 风格循环、语音入口、Delivery 模型。

### B. 早期沙箱历史（仅存于 `Agent_ERP.bundle`，作考古）

| 提交 | 说明 |
|---|---|
| `f00e8d7` | W0：画布模式 + 不可变格子 + 变更单链（3 动词） |
| `98caa0e` | gitignore：排除 `.env` |
| `6d4761e` | W1：设置面板 + 模型接入层（含连通性诊断与失败回落） |
| `84db305` | chore：停止跟踪 `.env`，改用 `.env.example` |
| `ba74a22` | docs：导出完整交接档案 `HANDOVER/`（11 份） |

> 接手 AI：**不要**把上表 5 笔当成当前 `git log` 必须出现的提交；
> 核对现状用 `git log` + `00_START_HERE` 快照，考古才打开 bundle。

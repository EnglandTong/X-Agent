# 00 · 协议一页纸（x-agent）

> 这是 **X-Agent 主（框架）** 的协议包（`@x-agent/core`）。  
> **治理**：本目录与 `packages/core/*.md` 只描述主；**不**写 ERP 业务。支（`apps/agent-erp`）档案在 `HANDOVER/`。  
> 应用通过 workspace 依赖本包；守住下面那条铁律即可独立演进。
>
> **输入侧标准**见同目录 [`01_OBSERVATION.md`](./01_OBSERVATION.md)（Observation + 适配器）。  
> 本文件管**能力**（做什么）；01 管**输入**（怎么进来）。两份合起来才是完整对外契约。

## 一句话

**一份 manifest，三个消费者**：UI 表单（Formily 渲染确认卡）、LLM 工具定义（Tool Schema）、CLI/评测。
改字段只改一处，三处同时生效。

**输入一侧句话**：外面怎么采都行，进核心之前必须是 [`Observation`](./observation.ts)；Agent 只吃辨认后的自然语言。
## 三个消费者（同一份文件）

| 消费者 | 入口 | 拿到的形态 |
|---|---|---|
| UI | `GET /api/schema/:verb` | Formily Schema（含 `x-component`） |
| 模型 | `GET /api/tools/:verb` | 编译后的 Tool Schema（只留 `extract` / `resolution` 相关描述） |
| CLI / 评测 | `npm run eval` | 同一份 Schema 的必填与消解策略 |

编译器：`src/server/compile.ts`（含编译期校验：声明 `resolution:'enum'` 却没给 enum 列表 → 直接报错）。

## 字段（`x-agent` 段）

| 键 | 给谁 | 作用 |
|---|---|---|
| `extract` | 模型 + 编译器 | **槽位名**（= 工具参数名）。必填字段必须声明，否则编译报错 |
| `resolution` | 消解器 | 决定「原话片段 → 落库值」的算法（见 `manifest.schema.json` 的枚举） |
| `askIfMissing` | Agent | 缺失时是否反问 |
| `inferFrom` | Agent | 推断来源（依赖别的槽位，串行执行） |
| `confidenceDefault` | UI | 推断值的置信度（须低于用户明说的值） |
| `examples` | 模型 | few-shot 示例，进 prompt |
| `notes` | 人 | 设计意图，不参与编译 |

**命名双轨（最大的历史坑）**：字段名（`customerId`，UI 与落库用）≠ 槽位名（`customer`，模型与意图层用）。
执行层校验一律用**原始 Schema 的 `required`（字段名）** —— 用错就会全部返回 400。

## 消解优先级

```
个人用语表  >  主数据 code/型号精确  >  主数据模糊  >  模型抽取  >  规则兜底
```

- 个人用语表在 `resolve.ts` 的 switch **之前**命中（插入点 B）
- 主数据按 `code` / `model` **精确优先**，重名（分差 < 0.08）**必问**，绝不自动选中
- 数量抽取前先遮罩型号/单号数字，且量词必需（否则「李四来五十个」会抽出「四」）

## 加一个能力的固定套路

1. 写 `src/schema/<verb>.json`（含 `x-agent`）
2. 写 `src/server/verbs/<verb>.ts` + 注册 registry
3. 前端零改（表单按 Schema 渲染）
4. 补 3–5 条口吻进 `eval/utterances.jsonl`，跑 `npm run eval`
5. 更新 `HANDOVER/05_TEST_LOG.md`，必要时更新 `03_VERBS.md`

## 铁律（违反就搬不走）

1. **`core/` 不得 import `server/`**（尤其 `server/verbs/`）—— 单向依赖。
   验证：`grep -r "from '\.\./server" packages/core/src/` 必须为空。
2. **协议 100% 复用，禁止新定第三套**（决策 D3）。要扩展就加 `resolution` 值 / 加 `modality` 值，不改结构。
3. **`core/` 只放协议与类型** —— 一旦开始放实现，就变成第二个 server。

## 独立仓的触发条件（任一满足即搬，不再讨论）

| # | 信号 | 判定方式 |
|---|---|---|
| T1 | 出现 `core/` → `server/` 反向 import | `grep -r "from '\.\./server" packages/core/src/` 非空 |
| T2 | 第二个应用要接入 | S3 启动日 |
| T3 | `app/` 拖慢 core 迭代 | `tsc` / `npm install` > 30s |

搬的目的地：**X-Agent 主仓 `packages/core`**（决策 #27 / D1，2026-09-11 已落地）。

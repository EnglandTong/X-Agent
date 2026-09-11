# @x-agent/core

**X-Agent 主干（主）** — Agent 原生架构的协议与类型层。

本包**只描述框架**：如何让业务系统更适配 AI 操作（Schema 真源、统一输入、能力注册、Run 生命周期）。**不含**任何具体业务应用代码。

## 文档（读本目录，不读 HANDOVER）

| 文件 | 内容 |
|---|---|
| [00_MANIFEST.md](./00_MANIFEST.md) | `x-agent` 协议一页纸：三消费者、字段、铁律 |
| [01_OBSERVATION.md](./01_OBSERVATION.md) | 输入侧标准：Observation + 适配器 |
| [manifest.schema.json](./manifest.schema.json) | manifest 结构声明 |

## 代码

| 模块 | 职责 |
|---|---|
| `src/observation.ts` | 统一输入类型 + 适配器接口 |
| `src/run.ts` | Run 六态与合法转移 |
| `src/registry.ts` | 能力注册表（只登记，无实现） |
| `src/index.ts` | 对外 re-export |

## 铁律

1. **`packages/core` 不得 import `apps/` 或任何应用 `server/`**
2. 协议 100% 复用 `x-agent`，禁止新定第三套
3. 应用通过 workspace 依赖本包：`"@x-agent/core": "*"`

## 参考应用（支）

验证本框架的 ERP PoC 在 **`apps/agent-erp/`**，档案在仓库根 **`HANDOVER/`**（只描述支，不描述主框架）。

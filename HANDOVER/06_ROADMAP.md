# 06 · 路线图与待办

---

## 一、12 动词全景（销售订单 → 出货一条线）

| # | 动词 | 风险 | 状态 | 说明 |
|---|---|---|---|---|
| 1 | `order.query` | read | ✅ 已实现 | 按客户/状态/单号查询 |
| 2 | `order.create` | write | ✅ 已实现 | 含修订（草稿）与变更（另开新单）两种模式 |
| 3 | `order.confirm` | write | ✅ 已实现 | DRAFT → CONFIRMED |
| 4 | `order.cancel` | write | ✅ 已实现 | 取消原因必填；SHIPPED 拒绝 |
| 5 | `delivery.create` | write | ✅ 已实现 | 从 CONFIRMED 订单生成出货草稿 |
| 6 | `delivery.confirm` | write | ✅ 已实现 | 扣库存 + 订单 SHIPPED |
| 7 | `delivery.query` | read | ✅ 已实现 | 查出货记录 |
| 8 | `inventory.query` | read | ✅ 已实现 | 按产品/仓库 |
| 9 | `inventory.reserve` | write | ✅ 已实现 | Inventory.reserved |
| 10 | `inventory.release` | write | ✅ 已实现 | 释放预留 |
| 11 | `customer.query` | read | ✅ 已实现 | 客户与信用额度 |
| 12 | `credit.check` | read | ✅ 已实现 | 单笔信用检查 |
| — | `price.query` | read | 💡 备选 | 未做（计划明确不做） |

**加一个动词的标准动作**：
1. 写 `src/schema/<verb>.json`（含 `x-agent` 协议）
2. 写 `src/server/verbs/<verb>.ts`（handler）
3. 在 `registry.ts` 与 `index.ts` 的动词清单里注册
4. 前端零改动（表单按 Schema 渲染）

---

## 二、W1 待办（当前阶段）

| P | 事项 | 验收标准 | 依赖 |
|---|---|---|---|
| **P0** | Owner 在设置面板填 Key 并测试通过 | 返回 `连通 · <model> · <ms>ms` | Owner 提供 Key |
| **P0** | 建评测集（30-50 条样本话术 + 期望抽取） | ✅ `app/eval/utterances.jsonl`（50 条） | — |
| **P0** | 跑「模型 vs 规则」对比，出准确率表 | ✅ 规则基线已出；模型待 Key | Key |
| **P1** | 错例落库（原话 / 期望 / 实际 / 引擎） | ✅ `app/eval/failures.jsonl` | P0 |
| **P1** | 接入 Pi 风格 Agent 循环（禁用文件/shell 工具） | ✅ `piAgent.ts`（契约同 interpret） | — |
| **P1** | 补 `order.cancel` + `delivery.*` | ✅ | — |
| **P1** | 补 inventory / customer / credit | ✅ 满 12 动词 | — |
| **P2** | 语音输入 | ✅ Web Speech → interpret | — |
| **P2** | 阶段结束：提交 + push；重打 zip/bundle | 本轮收口 | Owner |
| **P3** | 换 PostgreSQL | 改 provider + url | — |

---

## 三、准确率评测怎么做（建议方法）

```
1. 造样本：30-50 条真实口吻话术（含别称、中文数字、相对时间、省略、重名）
2. 每条标注期望：{verb, slots}
3. 双跑：engine=llm（填 Key） 与 engine=rules（清空 Key 或切 rules）
4. 对比三个指标：
   - 动词准确率
   - 槽位抽取 F1（逐槽位）
   - 消解后落库值准确率（这一层两者共用，理论上一致）
5. 错例分类：
   A 模型漏抽（规则能抽到）→ 说明 prompt 或示例不够
   B 模型抽错（规则对的）  → 错例，进微调集
   C 两者都错             → 需要改消解器或 Schema
   D 模型对规则错         → 说明模型确实更泛化，值得加大权重
```

> **重要**：评测的价值不在于证明模型好，而在于知道**哪些场景必须保留规则兜底**。
> 本项目是「模型 + 规则互补」架构，不是二选一。

---

## 四、时间节点（Owner 自定的 3/6/9/12 节奏）

| 节点 | 目标（建议） |
|---|---|
| **第 3 月** | 12 动词跑通，模型接入稳定，准确率有基线数据 |
| **第 6 月** | 有真实业务数据跑起来（哪怕是自己的小场景） |
| **第 9 月** | 可对外演示 / 找到第一个付费或试用场景 |
| **第 12 月** | 决定：继续投入 / 转成内部工具 / 归档 |

---

## 五、已知风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| 沙箱不持久 | 云端代码可能丢失 | 每次阶段成果导 zip + bundle 到本地/网盘 |
| GitHub 推不上去 | 无异地版本库 | Owner 本地推；或用 Gitee / CNB 做镜像 |
| 模型成本 | 每条话术一次调用 | 优先小模型（mini/flash）；规则能覆盖的不调模型 |
| 范围蔓延 | Owner 的核心痛点 | 严格执行本档案的范围界定，新增动词需 Owner 确认 |
| API Key 只存在沙箱 | 沙箱重置后要重填 | 设置面板重填即可；别写进代码 |

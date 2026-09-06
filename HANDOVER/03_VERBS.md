# 03 · 动词规格与业务规则

---

## 一、已实现的 3 个动词

| 动词 | 风险 | 必填 | 说明 |
|---|---|---|---|
| `order.query` | read | 无 | 查询订单，按客户/状态/单号关键字过滤，默认 10 条 |
| `order.create` | write | `customerId` `productId` `qty` | 建单；**支持修订与变更两种模式** |
| `order.confirm` | write | `orderNo` | 草稿 → 已确认；非草稿拒绝 |

### `order.create` 字段全表

| 字段 | 槽位 | resolution | 必填 | 推断 |
|---|---|---|---|---|
| `customerId` | `customer` | `fuzzy_customer` | ✅ | — |
| `productId` | `product` | `fuzzy_product` | ✅ | — |
| `qty` | `quantity` | `number_normalize` | ✅ | — |
| `unitPrice` | `unit_price` | `lookup_price_list` | — | ✅ 客户历史成交价 → 牌价（置信度 0.6） |
| `deliveryDate` | `delivery_date` | `date_parse` | — | — |
| `warehouseId` | `warehouse` | `enum` | — | ✅ 客户最近订单 / 客户主数据 |
| `currency` | `currency` | `enum` | — | 默认 CNY |
| `remark` | `remark` | `passthrough` | — | 原话残片兜底 |
| `originNo` | `origin_no` | `order_lookup` | — | **变更单专用** |

### `order.confirm` 字段

| 字段 | 槽位 | 说明 |
|---|---|---|
| `orderNo` | `order_no` | 要确认的订单号 |

---

## 二、业务规则（L4）

| 规则 | 严重度 | 触发条件 | 结果 |
|---|---|---|---|
| `credit_limit` | **block** | 订单金额 + 已用额度 > 信用额度 | 拒绝建单 |
| `min_order_amount` | **block** | 金额低于起订额 | 拒绝建单 |
| `price_floor` | **confirm** | 单价低于产品底线价 | 放行但需人确认 |
| `inventory` | **warn** | 库存不足 | 放行但告警 |

> 已验证：四类规则都能触发（见 `05_TEST_LOG.md`）。

---

## 三、★ 变更单机制（本项目最容易做错的地方）

### 语义（Owner 两次纠正后定稿）

> 第一张单提交确认后**不能改**。再改就是**另一张新单**。
> 两张单靠**业务关键信息**双向串联，不是靠界面父子关系。

### 三种操作的严格区分

| 场景 | 原单状态 | 操作 | 数据变化 |
|---|---|---|---|
| 修订 | `DRAFT` | 原地更新 | 同一张单号，字段被覆盖；另起一格记录 |
| 变更 | `CONFIRMED` / `SHIPPED` | **另开新单** | 新单号；原单冻结；两单互指 |
| 确认 | `DRAFT` | `order.confirm` | DRAFT → CONFIRMED |

### 三个串联字段

```
原单 SO-2026-1007 (CONFIRMED, 冻结)
   │  supersededByNo = "SO-2026-1012"   ← 原单指向新单
   │  chainId        = "SO-2026-1007"   ← 链根（整链共享）
   ▼
新单 SO-2026-1012 (DRAFT)
      originNo = "SO-2026-1007"          ← 新单指回原单
      chainId  = "SO-2026-1007"          ← 同一条链
```

- `originNo`：新单 → 原单
- `supersededByNo`：原单 → 新单
- `chainId`：整条链的根单号，所有单共享 → **一查就能看全这条链经历过什么**

### 拒绝规则

- 若原单**已经有** `supersededByNo`（说明已被变更过），再对它发起变更 → **拒绝**，
  提示「请对最新的那张单操作」。避免一条链分叉。

### 实现位置

- `verbs/order.create.ts`：参数 `reviseOrderId`（草稿原地改）与 `originNo`（另开变更单）
- `panels.ts`：`prepareRevision()` **查数据库实时状态**决定「修订 or 变更」
  （⚠️ 早期版本读 Panel 快照，导致订单已确认却仍显示草稿 —— 已修复）
- 前端 `PanelCard` 按 `liveStatus` 显示不同按钮文案

---

## 四、格子（Panel）不可变规则

| 规则 | 说明 |
|---|---|
| 提交即冻结 | Panel 写入后不 UPDATE（除状态标记 SUPERSEDED） |
| 编号递增 | `seq` 从 1 起，永久编号，UI 上显示为 `#1 #2 #3` |
| 关联键 | `correlationId`：`ORD:{单号}` 或 `CUS:{客户ID}`，顶部显示「当前对象」 |
| 词典实体 | `entities`：`[{type,value,label}]`，记录这一格涉及哪些主数据 |
| 清空画布 | `DELETE /api/panels` **仅限 PoC**，正式版应改为「开新画布」 |

---

## 五、API 全量路由表

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 健康 + 当前 Agent 引擎 |
| GET | `/api/verbs` | 自省：能做什么（动词、参数、必填） |
| GET | `/api/schema/:verb` | Formily Schema（给 UI） |
| GET | `/api/tools/:verb` | Tool Schema（给模型，同一份 Schema 的另一消费） |
| GET | `/api/tools` | 全部工具定义 |
| GET | `/api/entities/:kind` | 实体选项（customer / product / warehouse） |
| POST | `/api/interpret` | **核心**：一句话 → 动词 + 槽位 + 消解结果 |
| POST | `/api/verbs/:name/run` | 执行动词，写 Panel |
| GET | `/api/panels` | 画布全部格子 |
| POST | `/api/panels/:id/revise` | 预填修订/变更（不写库） |
| GET | `/api/panels/:id/chain` | 按关联键取完整链路 |
| DELETE | `/api/panels` | 清空画布（PoC 专用） |
| GET | `/api/settings` | 模型配置（**Key 以掩码返回**） |
| PUT | `/api/settings` | 保存模型配置 → `.env.local`，立即生效 |
| POST | `/api/settings/test` | 连通性测试（返回服务端原始错误） |

> **注意**：这里没有 `/api/orders`。这是刻意的 —— 能力由动词表达，不由 REST 资源表达。

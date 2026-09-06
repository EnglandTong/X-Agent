# 03 · 动词规格与业务规则

---

## 一、已实现的 12 个动词

| 动词 | 风险 | 必填 | 说明 |
|---|---|---|---|
| `order.query` | read | 无 | 查询订单，按客户/状态/单号关键字过滤，默认 10 条 |
| `order.create` | write | `customerId` + (`items[]` **或** `productId`/`qty`) | 建单；**支持多行**；修订与变更两种模式 |
| `order.confirm` | write | `orderNo` | 草稿 → 已确认；非草稿拒绝；**占用信用额度** |
| `order.cancel` | write | `orderNo` `reason` | 取消；`SHIPPED` 拒绝；已占用则释放额度 |
| `delivery.create` | write | `orderNo` | 从 `CONFIRMED` / `PARTIALLY_SHIPPED` 生成出货草稿；可选 `qty`（**仅单行**）；多行传标量 `qty` → **硬错** |
| `delivery.confirm` | write | `deliveryNo` | 扣库存并**同步释放 reserved**；订单 → `PARTIALLY_SHIPPED` 或 `SHIPPED` |
| `delivery.query` | read | 无 | 查出货记录 |
| `inventory.query` | read | 无 | 按产品/仓库查库存 |
| `inventory.reserve` | write | `productId` `warehouseId` `qty` | 增加 `Inventory.reserved` |
| `inventory.release` | write | `productId` `warehouseId` `qty` | 释放预留 |
| `customer.query` | read | 无 | 客户与信用额度 |
| `credit.check` | read | `customerId` | 单笔信用检查（可读可选金额） |

### `order.create` 字段全表

| 字段 | 槽位 | resolution | 必填 | 推断 |
|---|---|---|---|---|
| `customerId` | `customer` | `fuzzy_customer` | ✅ | — |
| `productId` | `product` | `fuzzy_product` | 单行必填* | — |
| `qty` | `quantity` | `number_normalize` | 单行必填* | — |
| `items` | `items` | `order_line_items` | 多行优先 | — |
| `unitPrice` | `unit_price` | `lookup_price_list` | — | ✅ 客户历史成交价 → 牌价（置信度 0.6） |
| `deliveryDate` | `delivery_date` | `date_parse` | — | — |
| `warehouseId` | `warehouse` | `enum` | — | ✅ 客户最近订单 / 客户主数据 |
| `currency` | `currency` | `enum` | — | 默认 CNY |
| `remark` | `remark` | `passthrough` | — | 原话残片兜底 |
| `originNo` | `origin_no` | `order_lookup` | — | **变更单专用** |

\* 有非空 `items[]` 时，API / interpret 不再强求 `productId`/`qty`（表单单行字段仍可用于手工录入）。

### `order.confirm` 字段

| 字段 | 槽位 | 说明 |
|---|---|---|
| `orderNo` | `order_no` | 要确认的订单号 |

### `delivery.create` 要点

| 字段 | 说明 |
|---|---|
| `orderNo` | 已确认 / 部分出货订单 |
| `qty` | **可选**；**仅单行订单**作部分出货；**多行订单传标量 qty → 硬错**（禁止静默出全部剩余）；省略则按各行剩余量出货 |
| `warehouseId` / `remark` | 可选 |

### 预留与出货

| 规则 | 说明 |
|---|---|
| `inventory.reserve` | 增加 `Inventory.reserved`（PoC：**未**按 orderId 分账本） |
| `delivery.confirm` | 扣 `qty` 同时 `reserved -= min(reserved, 出货量)`，避免预留后再出货导致 available 凭空变少 |

---

## 二、业务规则（L4）

| 规则 | 严重度 | 触发条件 | 结果 |
|---|---|---|---|
| `credit_limit` | **block** | 订单金额 + 已用额度 > 信用额度 | 拒绝建单 |
| `min_order_amount` | **block** | 金额低于起订额 | 拒绝建单 |
| `price_floor` | **confirm** | 单价低于产品底线价 | 放行但需人确认 |
| `inventory` | **warn** | 库存不足 | 放行但告警 |
| `shipping_over` | **block** | 出货数量 > 订单行剩余可出 | 拒绝创建/confirm（硬拦） |
| `shipping_partial` | — | 确认出货后仍有剩余 | 订单 → `PARTIALLY_SHIPPED`；全部出完 → `SHIPPED` |

> 信用 / 起订 / 底价 / 库存：见 `05_TEST_LOG.md`。  
> 出货剩余量 / 超量硬拦：`scripts/smoke-delivery-remaining.ts` 已验。  
> **注意**：`creditUsed` 占用策略以 `04_DECISIONS.md` 为准（确认占用 / 草稿不占）；档案与代码若曾不一致，以代码+决策表收口后的实现为准。

---

## 三、★ 订单状态机（含部分出货）

合法状态：`DRAFT` | `CONFIRMED` | `PARTIALLY_SHIPPED` | `SHIPPED` | `CANCELLED` | `SUPERSEDED`

```
DRAFT ──confirm──▶ CONFIRMED ──部分出货确认──▶ PARTIALLY_SHIPPED ──剩余出完──▶ SHIPPED
  │                    │                              │
  │ cancel             │ cancel                       │ （一般不再 cancel；以 handler 为准）
  ▼                    ▼                              │
CANCELLED          CANCELLED                          │
                       │                              │
                       │ 变更（另开新单）                │
                       ▼                              │
                  SUPERSEDED ◀── 原单被变更冻结 ────────┘
```

| 转移 | 动词 / 条件 |
|---|---|
| `DRAFT` → `CONFIRMED` | `order.confirm` |
| `DRAFT` → `CANCELLED` | `order.cancel` |
| `CONFIRMED` → `CANCELLED` | `order.cancel`（`SHIPPED` 拒绝） |
| `CONFIRMED` / `PARTIALLY_SHIPPED` → 出货草稿 | `delivery.create`（不改订单状态） |
| 出货确认后仍有剩余 | `delivery.confirm` → `PARTIALLY_SHIPPED` |
| 出货确认后无剩余 | `delivery.confirm` → `SHIPPED` |
| `CONFIRMED` / `SHIPPED` → `SUPERSEDED` | `order.create` 变更模式（另开新单） |

剩余量计算：`remaining.ts` = 订单行 qty − 已确认出货单同产品 qty 之和。

---

## 四、★ 变更单机制（本项目最容易做错的地方）

### 语义（Owner 两次纠正后定稿）

> 第一张单提交确认后**不能改**。再改就是**另一张新单**。
> 两张单靠**业务关键信息**双向串联，不是靠界面父子关系。

### 三种操作的严格区分

| 场景 | 原单状态 | 操作 | 数据变化 |
|---|---|---|---|
| 修订 | `DRAFT` | 原地更新 | 同一张单号，字段被覆盖；另起一格记录 |
| 变更 | `CONFIRMED` / `SHIPPED` / `PARTIALLY_SHIPPED` | **另开新单** | 新单号；原单冻结；两单互指 |
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

## 五、格子（Panel）不可变规则

| 规则 | 说明 |
|---|---|
| 提交即冻结 | Panel 写入后不 UPDATE（除状态标记 SUPERSEDED） |
| 编号递增 | `seq` 从 1 起，永久编号，UI 上显示为 `#1 #2 #3` |
| 关联键 | `correlationId`：`ORD:{单号}` 或 `CUS:{客户ID}`，顶部显示「当前对象」 |
| 词典实体 | `entities`：`[{type,value,label}]`，记录这一格涉及哪些主数据 |
| 清空画布 | `DELETE /api/panels` **仅限 PoC**，正式版应改为「开新画布」 |

---

## 六、API 全量路由表

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
| GET | `/api/sessions` | 会话列表 |
| GET | `/api/settings` | 模型配置（**Key 以掩码返回**） |
| PUT | `/api/settings` | 保存模型配置 → `.env.local`，立即生效 |
| POST | `/api/settings/test` | 连通性测试（返回服务端原始错误） |
| GET | `/api/lexicon` | 个人用语表列表（`userId` / `status` 可选） |
| POST | `/api/lexicon` | upsert 一条用语（`phrase` + `kind` 必填） |
| POST | `/api/lexicon/:id/reject` | 标 `rejected`，停止再提议 |
| DELETE | `/api/lexicon/:id` | 软删 → `retired` |
| POST | `/api/lexicon/propose` | 根据确认结果生成「是否记住」提议（**不入库**） |

> **注意**：这里没有 `/api/orders`。这是刻意的 —— 能力由动词表达，不由 REST 资源表达。  
> 用语表契约详见 `11_PERSONAL_LEXICON.md`。

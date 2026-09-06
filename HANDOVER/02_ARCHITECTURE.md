# 02 · 架构与协议

---

## 一、五层结构

```
┌─────────────────────────────────────────────────────────────┐
│ L1  UI 画布层        React + antd + Formily                  │
│     App.tsx（画布/输入框）· PanelCard（历史格）               │
│     ConfirmCard（待确认格）· SettingsModal（模型设置）        │
└───────────────────────────┬─────────────────────────────────┘
                            │ POST /api/interpret
┌───────────────────────────▼─────────────────────────────────┐
│ L2  Agent 层         agent.ts + llm.ts                       │
│     ① 意图识别（动词）  ② 槽位抽取（模型 / 规则）             │
│     ③ 消解（resolve.ts）④ 推断（inferFrom）                  │
│     ★ 模型挂了 → 静默回落规则引擎，业务不停摆                 │
└───────────────────────────┬─────────────────────────────────┘
                            │ 确认后 POST /api/verbs/:name/run
┌───────────────────────────▼─────────────────────────────────┐
│ L3  动词层           verbs/*.ts + registry.ts                │
│     order.query / order.create / order.confirm               │
│     执行前必填校验 → 执行 → 业务规则检查                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ L4  领域规则层       信用额度 / 起订额 / 价格底线 / 库存      │
│     block（拦截）· confirm（提醒但可继续）· warn              │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│ L5  数据层           Prisma + SQLite（可切 PostgreSQL）       │
│     Customer Product Inventory Order OrderItem Panel         │
└─────────────────────────────────────────────────────────────┘
```

**关键约束**：依赖只能从上往下。L2 不认识 L5 的表结构（通过 Prisma 注入），
L3 不认识 HTTP。任何一层向上调用都是设计错误。

---

## 二、一次完整交互的时序

```
用户："给张三来120个A-100，下周三要"
  │
  ├─1─▶ POST /api/interpret
  │      ├ 加载主数据词典（客户/产品）→ 供实体链接
  │      ├ 意图识别：规则 detectVerb() 或 模型 llmExtract()
  │      │           模型失败 → 回落规则，返回 engine:'rules' + llm.error
  │      ├ 槽位抽取：模型输出 ∪ 规则输出（互补，模型覆盖规则）
  │      ├ 逐槽消解：resolve.ts（确定性）
  │      │   张三 → customerId（confidence 0.98）
  │      │   A-100 → productId
  │      │   120 → qty
  │      │   下周三 → 2026-09-09（基于 today）
  │      ├ 二次推断：hydrateInference（客户定了才能推断仓库/单价）
  │      └ 判定 ready / missing / ambiguous → 一次问完
  │
  ├─2─▶ UI 渲染 ConfirmCard（Formily 按 Schema 渲染 8 个字段）
  │      推断值必须高亮标注，不可静默落库
  │
  ├─3─▶ 人确认 → POST /api/verbs/order.create/run
  │      ├ 必填校验（用原始 Schema 的 required，字段名而非槽位名）
  │      ├ 业务规则：信用、起订额、价格底线、库存
  │      └ 落库 → recordPanel（写 Panel 表，不可变）
  │
  └─4─▶ 画布上多出一格，编号递增，永久冻结
```

---

## 三、x-agent 扩展协议（本项目的核心发明）

每份 Schema 的每个字段都可以挂一段 `x-agent`，它同时告诉 UI 和模型「这个字段怎么来」。

```jsonc
"customerId": {
  "type": "string",
  "title": "客户",
  "x-component": "CustomerSelect",      // 给 UI：用什么控件
  "x-validator": [{ "required": true }], // 给 UI：校验
  "x-agent": {
    "extract": "customer",               // 给模型：槽位名（= Tool 参数名）
    "resolution": "fuzzy_customer",      // 给代码：怎么把原话变成值
    "askIfMissing": true,                // 缺失时是否反问
    "inferFrom": "customer_last_order",  // 可推断来源
    "confidenceDefault": 0.8,
    "examples": ["张三", "给张总下单"],   // few-shot，直接喂模型
    "notes": "重名时必须弹候选，绝不自动选中"  // 给人看的备注
  }
}
```

| 键 | 消费者 | 作用 |
|---|---|---|
| `extract` | 模型 + 编译器 | 槽位名。**必填字段必须声明**，否则编译器报错 |
| `resolution` | 消解器 | 决定「原话片段 → 落库值」的算法 |
| `askIfMissing` | Agent | 是否反问（false 表示可用默认值/推断值） |
| `inferFrom` | Agent | 推断来源（依赖别的槽位，串行执行） |
| `confidenceDefault` | UI | 推断值的置信度（必须低于用户明说的值） |
| `examples` | 模型 | few-shot 示例，进 prompt |
| `notes` | 人 | 设计意图，不参与编译 |

### 消解策略一览

| resolution | 行为 | 失败时 |
|---|---|---|
| `fuzzy_customer` | 客户名/编码模糊匹配，重名返回候选 | 弹候选让人选，**绝不自动选中** |
| `fuzzy_product` | 型号/别称/中文数字变体匹配 | 同上 |
| `number_normalize` | 中文数字归一（一百二十 → 120） | 标缺失 |
| `date_parse` | 相对时间 → 绝对日期（下周三 → 2026-09-09） | 标缺失 |
| `enum` / `enum_alias` | 口语别名 → 枚举（已出货 → SHIPPED） | 标缺失 |
| `lookup_price_list` | 客户历史成交价 / 牌价 | 置信度降到 0.6 并提示复核 |
| `order_lookup` | 原单号（完整号或尾号片段）→ 订单 | 标缺失 |
| `passthrough` | 原样透传 | — |

> **编译期校验**：声明 `resolution:'enum'` 却没给 `enum` 列表 → 编译器直接报错。
> 这条是为了防止「配置错了但运行期才发现一切输入都非法」。

---

## 四、数据模型（Prisma / SQLite）

| 模型 | 关键字段 | 说明 |
|---|---|---|
| `Customer` | `code` `name` `level` `creditLimit` `creditUsed` `lastWarehouse` | 信用与默认仓 |
| `Product` | `model` `name` `price` `unit` | 牌价 |
| `Inventory` | `productId` `warehouse` `qty` | 唯一键 (productId, warehouse) |
| `Order` | `no` `status` **`originNo`** **`supersededByNo`** **`chainId`** `deliveryDate` `totalAmount` | 变更单三件套是业务关键字段 |
| `OrderItem` | `orderId` `productId` `qty` `unitPrice` `amount` | |
| `Panel` | `seq` `verb` `utterance` `slots` `args` `result` `correlationId` `entities` `supersedesId` | **画布格子 = 审计记录** |

### 两个易混淆的关联字段

| 字段 | 所在表 | 含义 |
|---|---|---|
| `supersedesId` | Panel | **格子级**：这一格替换了哪一格（界面修订链） |
| `originNo` / `supersededByNo` / `chainId` | Order | **业务级**：两张独立订单之间的串联（变更单链） |

前者是 UI 历史，后者是业务语义。**不要混用，不要只存一个。**

---

## 五、目录结构

```
agt-erp/
├── SPEC.md                      # 原始规格（早期版本，部分已被本档案取代）
├── HANDOVER/                    # ★ 本档案
├── schema/                      # 早期原型产物
├── prototype/index.html         # 早期静态原型
├── tools/schema-to-tool.ts      # 早期命令行编译器
└── app/
    ├── prisma/schema.prisma     # 数据模型
    ├── prisma/seed.ts           # 种子数据（4客户/3产品/4订单）
    └── src/
        ├── schema/*.json        # ★ Formily Schema（唯一事实来源）
        ├── server/
        │   ├── index.ts         # 路由
        │   ├── compile.ts       # Schema → Tool Schema 编译器
        │   ├── agent.ts         # 意图 + 抽取 + 消解编排
        │   ├── llm.ts           # OpenAI 兼容客户端（含连通性诊断）
        │   ├── settings.ts      # 模型配置读写（.env.local）
        │   ├── resolve.ts       # 消解器（确定性）
        │   ├── panels.ts        # 格子记录与修订准备
        │   └── verbs/           # 动词实现
        ├── ui/                  # 画布、卡片、设置面板
        └── types.ts             # 前后端共享类型
```

---

## 六、Agent 循环（Pi SDK）—— 已决策但未接入

**决策**：Agent 循环最终用 **Pi（pi.dev）SDK**，不用 DSH。
**约束**：**禁用 Pi 内置的 `read` / `write` / `edit` / `bash` 工具** ——
本系统的 Agent 只能调用**业务动词**，不能直接碰文件系统和 shell。

当前 Pi 尚未接入，Agent 编排逻辑直接写在 `agent.ts` 里（意图 → 抽取 → 消解 → 推断）。
接入 Pi 时，这一层的**输入输出契约不变**，只是把编排交给 Pi 的循环。

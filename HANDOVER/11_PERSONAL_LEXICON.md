# 11 · 个人用语表（Personal Lexicon）

> **状态**：设计已定 · **已实现核心**（Prisma + API + resolve/interpret 插入点 + 确认卡记住 + 确认后提议）  
> **范围**：字符串/精确优先匹配的小表；**不做**向量库、微调、静默全量学习  
> **输出面**：ERP 画布确认卡（即此前口误「LP 界面」）
> **评测**：`npm run eval:lexicon`（夹具，不污染主基线）

---

## 一、命题

系统级别称（`enum_alias` / 主数据模糊匹配）不够：每个人有自己的习惯说法。  
个人用语表把「这个人怎么说」记成可审计的映射，在 **小模型抽取之前 / 消解之中** 先归一，画布上仍须人确认才落库。

**优先级（命中时）：**

```
个人用语表  >  系统别称 / 主数据  >  模型抽取  >  规则兜底
```

---

## 二、数据 Schema（Prisma · 一代）

一代默认单用户：`userId = "owner"`（与 `Panel.actor` / `Order.createdBy` 对齐）。多用户以后再拆。

```prisma
/// 个人用语表 —— 习惯说法 → 动词或槽位目标（非向量库）
model PersonalLexeme {
  id        String   @id @default(cuid())
  userId    String   @default("owner")
  /// 归一化后用于匹配（去空格、全角半角、大小写）；写入时由代码生成
  phraseNorm String
  /// 用户看见的原始说法，如「给老王开单」「圆珠笔」
  phrase    String
  /// verb | slot
  kind      String
  /// kind=verb 时必填，如 order.create
  verb      String?
  /// kind=slot 时必填，如 customer / product / warehouse
  slot      String?
  /// 落库目标：客户/产品用主键 id；枚举用枚举值；动词映射可空
  targetId  String?
  /// 确认卡展示，如「张三 (C001)」
  targetLabel String?
  /// 写入时的原话片段快照（审计）
  targetRaw String?
  /// explicit（点「记住」）| confirmed（成功确认后提议并同意）
  source    String
  /// active | rejected | retired
  status    String   @default("active")
  hits      Int      @default(0)
  lastUsedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([userId, phraseNorm, kind, slot])
  @@index([userId, status])
  @@index([userId, kind, verb])
}
```

### 字段约定

| 字段 | 规则 |
|---|---|
| `phraseNorm` | 复用 `resolve.ts` 的 `norm()` 思路；匹配只比这一列 |
| `kind=verb` | 只改意图：命中则固定 `verb`，槽位仍走抽取+消解 |
| `kind=slot` | 只改某一槽：命中则直接给出 `value/label`，**跳过**该槽的 fuzzy 消解 |
| `status` | `rejected` 保留行以免反复提议；`retired` 人工停用 |
| 唯一键 | 同一用户同一说法同一 `(kind,slot)` 一条；更新用 upsert |

### 刻意不做

| 不做 | 原因 |
|---|---|
| embedding / 向量检索 | 用语量小；精确+轻模糊够用 |
| 静默学习每一次输入 | 口误会污染词表 |
| 写入全局主数据别名 | 个人习惯 ≠ 公司主数据 |
| 让模型维护词表 | 词表是确定性数据，由 API + 确认卡写入 |

---

## 三、匹配规则（确定性）

对输入 `utterance` 与各槽位 `raw`：

1. `norm(text)` 后查 `status=active` 且 `userId` 匹配的行。  
2. **精确** `phraseNorm === q` 优先；否则仅当 `len≥2` 且 `similarity≥0.95` 才算命中（与实体歧义策略一致：宁可不命中，不误绑）。  
3. 多条命中：`hits` 高、`lastUsedAt` 近者优先；仍歧义则 **不自动用**，走原 candidates。  
4. 命中后：`hits++`，`lastUsedAt=now()`（可异步）。

---

## 四、与 Agent / resolve 的插入点

现有链路（`agent.ts` → `resolve.ts` → 画布）：

```
utterance
  → detectVerb / pi|llm|rules extract
  → resolveSlot（逐槽）
  → ConfirmCard on 画布
  → POST /api/verbs/:name/run
```

### 插入点 A · 动词前（`interpret` 步骤 1 之前）

**文件**：`app/src/server/agent.ts` · `interpret()`  
**时机**：`detectVerb(utterance)` **之前**  
**行为**：

- 查 `kind=verb` 用语表；命中则 `verb = lexeme.verb`，`verbConfidence = 0.95`，`source` 记 `lexicon`。  
- 未命中：保持现有 `detectVerb` + 模型/规则。

不改模型 prompt；用语表是前置闸门。

### 插入点 B · 槽位消解内（`resolveSlot` / `fuzzyEntity` 入口）

**文件**：`app/src/server/resolve.ts`  
**时机**：`fuzzy_customer` / `fuzzy_product` / `enum_alias` 查库 **之前**  
**行为**：

- 用槽位 `raw` 查 `kind=slot` 且 `slot` 匹配的用语。  
- 命中且 `targetId` 仍存在于主数据：直接 `ok(targetId, targetLabel, 0.95, note:'个人用语')`。  
- `targetId` 已删/失效：当未命中，走原 fuzzy，并可标记 `retired` 候选清理。

`number_normalize` / `date_parse` **不走**用语表（仍归确定性解析）。

### 插入点 C · 画布确认卡（学习入口，唯一写入口之一）

**文件**：`app/src/ui/` 确认卡区域（随 Panel 渲染）  
**行为**：

1. **显式记住**：确认前/后按钮「记住这个说法」→ `POST /api/lexicon`（`source=explicit`）。  
2. **确认后提议**：`run` 成功且（用户改过预填 **或** 槽位曾歧义后选定）→ 画布新提示条「把『老王』记成张三？」→ 同意才写（`source=confirmed`）。  
3. Trace/格子元数据可带 `lexiconHits: [{phrase, kind, slot}]`，方便审计（可选，一代可先打在 `note`）。

**红线**：用语表写入 **不得** 绕过确认卡直接改订单；只改映射表。

### 插入点 D · API（薄 CRUD）

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/lexicon` | 列表（设置页 / 调试） |
| `POST` | `/api/lexicon` | upsert 一条 |
| `POST` | `/api/lexicon/:id/reject` | 标 `rejected`，停止提议 |
| `DELETE` | `/api/lexicon/:id` | 软删 → `retired`（一代可真删） |

实现文件建议：`app/src/server/lexicon.ts` + 在 `index.ts` 挂路由；`interpret` 的 `opts` 增加 `userId`（默认 `owner`）。

---

## 五、与现有模块边界

| 现有 | 关系 |
|---|---|
| `resolve` 系统 `enum_alias` | 全局；个人表优先于它 |
| 主数据 `Customer` / `Product` | 个人 `targetId` 必须指向真实行 |
| Panel `entities` | 仍记录消解后实体；可选标注来自 lexicon |
| 评测 `eval/` | 用语表默认空；另加「开启 lexicon 夹具」子集，避免污染基线 |

---

## 六、一代验收

1. 用户对「老王」点记住 → 客户张三；下次话术含「老王」→ 确认卡直接带出张三，且标明个人用语。  
2. 「开张单」记住 → `order.create`；下次无需靠规则猜动词。  
3. 未点同意的提议 **不入库**；`rejected` 后不再弹同一提议。  
4. 无向量依赖；SQLite 单表可备份可清空。

---

## 七、实现顺序（待排期，不阻塞云端评测）

| 步 | 内容 |
|---|---|
| 1 | Prisma model + migrate + `lexicon.ts` CRUD |
| 2 | 插入点 B（slot）+ 确认卡「记住」 |
| 3 | 插入点 A（verb） |
| 4 | 确认后提议 + reject |
| 5 | 设置页：列出 / 停用个人用语（可更后） |

> Owner 已认可方向（2026-09-06）。落地须另开任务；本文只定契约与插入点。

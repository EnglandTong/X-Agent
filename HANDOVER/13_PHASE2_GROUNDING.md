# 13 · Phase 2 接地层 + 感官（工单）

> **Owner 裁决（2026-09-11）**：**C** — 个人用语（A）+ 企业标准别名（B）**都要**；B 须人工审核后才 `active`。  
> **哲学**：插件主数据是真源；小模型只抽原话；耳/眼只是入口；**连边库**负责搜与连，不靠大模型「懂业务」。  
> **范围**：仍守销售订单→出货一条线；写操作必经确认卡。

---

## 一、两层连边库（A + B）

| 层 | 表 | 谁维护 | 例子 | 生效门槛 |
|---|---|---|---|---|
| **A · 个人用语** | `PersonalLexeme` + `LexemeEvidence` | 用户点「记住」/ 跨天升格 | 老张→张三；开张单→`order.create` | 候选→跨≥2天→`active`（#28 已有） |
| **B · 企业别名** | `EnterpriseAlias`（**已建**） | 财务/管理员导入或录入 | 张总→张三；B型→B-200；华东→华东仓 | **`candidate` → 人工批准 → `active`** |

**刻意不做**：开放域向量 RAG、物理「世界模型」、模型直接输出 ID。

---

## 二、消解优先级（定稿）

```
插入点 A：个人 verb 用语（A, active）
    ↓
模型/规则抽 verb + 原话槽位
    ↓
插入点 B：逐槽 resolveSlot
    1. 个人 slot 用语（A, active）
    2. 企业别名（B, active）     ← Phase 2 新增
    3. 主数据 code / model 精确
    4. 主数据 fuzzy（分差 < 0.08 必问）
    5. 数量/日期确定性解析
    ↓
确认卡（推断标黄）→ run
```

耳（ASR）、眼（OCR）只在最前面把信号变成 `Observation.text`，**之后与键盘完全相同**。

---

## 三、`EnterpriseAlias` Schema（草案）

```prisma
/// 企业级标准别名 —— 公司维护，须审核后生效（决策 #30）
model EnterpriseAlias {
  id         String    @id @default(cuid())
  /// customer | product | warehouse
  entityKind String
  /// 指向 Customer.id / Product.id / …
  entityId   String
  aliasNorm  String
  alias      String
  /// official | invoice | import | ocr_suggest
  source     String
  /// candidate | active | rejected | retired
  status     String    @default("candidate")
  approvedBy String?
  approvedAt DateTime?
  note       String?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  @@unique([entityKind, aliasNorm])
  @@index([entityKind, status])
  @@index([entityId])
}
```

### B 层写入来源

| 来源 | 初始 status | 说明 |
|---|---|---|
| 财务 CSV 导入 | `candidate` | 批量进候选，管理页批量批准 |
| 管理 API 手工录入 | `candidate` 或直 `active`（仅 admin） | 开票全称等权威数据可直 active |
| OCR 读单后「建议关联」 | `candidate` | **永不自动 active** |
| 个人用语升格 | **不进 B** | A 与 B 分表，避免个人习惯污染企业主数据 |

---

## 四、主数据快搜（检索层，非向量）

在 `fuzzy` 之前加轻量检索（SQLite 即可）：

| 实体 | 检索键 | 实现建议 |
|---|---|---|
| Customer | `name`, `code`, `EnterpriseAlias.aliasNorm` | FTS5 或前缀索引 |
| Product | `name`, `model`, `code`, 别名 | 同上 |
| 历史订单 | `customerId` + 近期 `productId` 共现 | 已有 `memory/cooccur`，可加权排序 |

「江山 + 铅笔」：先 retrieve Top-K 产品/客户，再 fuzzy；**缩小候选空间**，小模型不必「懂库存」。

---

## 五、感官 Phase 2 任务单

### 里程碑 G0 · 接地层 B（优先于 OCR 大规模）

| # | 任务 | 验收 |
|---|---|---|
| G0-1 | Prisma `EnterpriseAlias` + migrate | ✅ 表存在，seed 4 条 |
| G0-2 | `enterpriseAlias.ts` CRUD + `approve/reject` API | ✅ `/api/enterprise-aliases` |
| G0-3 | `resolve.ts` 插入点 B′（B 在 A 之后、code 之前） | ✅ 「张总」→张三 |
| G0-4 | 管理 UI 或 CSV 导入脚本（最小） | ✅ `import:enterprise-aliases` + API import |
| G0-5 | `eval/alias-enterprise.jsonl` 5～10 条 | ✅ `eval:enterprise` 6/6；主 eval 不劣化 |
| G0-6 | 更新 `11_PERSONAL_LEXICON.md` + `04_DECISIONS` #30 | ✅ |

### 里程碑 G1 · 耳收尾

| # | 任务 | 验收 |
|---|---|---|
| G1-1 | Owner 浏览器采音 + `asr-wavs-real` | ✅ 画布存语料 + `eval/asr-wavs-real/README.md` |
| G1-2 | 规则档出货口吻补强 | ✅ `eval:asr` 规则 **94.7%**（出货/仓库/混合类全过） |
| G1-3 | 热词含企业别名高频词 | ✅ `hotwords` 含 active 别名 |

### 里程碑 G2 · 眼（OCR 读单 · 单场景）

| # | 任务 | 验收 |
|---|---|---|
| G2-0 | **拍板第一场景** | ✅ 微信订单截图 |
| G2-1 | `POST /api/ocr` + `image` SensoryAdapter | ✅ `/api/ocr` + `/api/ocr/text` |
| G2-2 | 画布「上传订单」按钮 | ✅ 图片按钮 → 确认卡预填 |
| G2-3 | OCR 建议别名进 B 为 `candidate` | ✅ `ocr_suggest` + `smoke:ocr` |
| G2-4 | `eval/ocr-samples/` 10 张脱敏样张 | ✅ `eval:ocr` 10/10（旁车 `.ocr.txt`） |

### 里程碑 G3 · 上下文（业务「世界图景」，非世界模型）

| # | 任务 | 验收 |
|---|---|---|
| G3-1 | OCR/语音格 `correlationId` 挂当前客户 | ✅ `sessionContext` + 「就按上一张图」 |
| G3-2 | interpret 前注入只读摘要（信用/库存一行） | ✅ `contextSummary` + 确认卡展示 |

---

## 六、框架 vs 应用分工

| 归属 | 内容 |
|---|---|
| `packages/core` | Observation 契约；消解优先级文档；可选 `GroundingHit` 类型 |
| `apps/agent-erp` | `EnterpriseAlias` 表、resolve 实现、OCR API、eval |
| `HANDOVER/` | 本文件 + `11` + `05` 验证记录 |

---

## 七、红线（Phase 2 仍适用）

1. 模型只输出原话片段，不输出 ID  
2. B 层 **禁止** OCR/模型自动 `active`  
3. 写操作必经确认卡  
4. 不引入向量库 / 不扩采购财务权限模块  
5. 改 resolve 后双跑 `eval` + `eval:asr`

---

## 八、建议执行顺序

```
G0（企业别名 B）→ G1（耳）→ G2（OCR 单场景）→ G3（上下文）
```

**理由**：OCR/语音抽出的「中行」「铅笔」要先能接 B+A 接地，否则眼/耳越准，落库越危险。

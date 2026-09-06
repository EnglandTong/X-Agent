# 05 · 测试日志：验证过什么、没验证什么

> 改完代码要回归时看这里。每一条都有复现方法。

---

## 一、已验证 ✅

| # | 验证项 | 方法 | 结果 |
|---|---|---|---|
| 1 | Formily 8 字段全由 Schema 渲染 | 浏览器实测 | 零控制台错误，控件类型正确 |
| 2 | 客户消解 | 「给张三来…」 | 张三 → customerId，confidence 0.98 |
| 3 | 日期消解 | 「下周三」 | → 2026-09-09（基于 today 计算） |
| 4 | 中文数字归一 | 「一百二十」 | → 120 |
| 5 | 重名歧义 | 「给张来50个B-200」 | 弹出候选，不自动选中 |
| 6 | 业务规则 · 信用额度 | 建单超额 block；**确认占用 / 取消释放** | ✅ 回归：`order.confirm` → `creditUsed += totalAmount`；`order.cancel`（CONFIRMED）→ 释放；DRAFT 不占。复现：查客户 `creditUsed` → 建草稿（不变）→ 确认（增加）→ 取消（回落） |
| 7 | 业务规则 · 起订额 | 小额下单 | block |
| 8 | 业务规则 · 价格底线 | 低于底价 | confirm，放行但需确认 |
| 9 | 业务规则 · 库存 | 库存不足 | warn |
| 10 | 画布闭环 | 建单 → 确认 → 变更 | 原单冻结，新单生成，链正确 |
| 11 | 变更链追溯 | `/api/panels/:id/chain` | 返回完整链路 |
| 12 | 12 动词注册 | `/api/health`、`/api/verbs` | **12** 个动词，参数与必填正确 |
| 13 | 设置面板读写 | `GET/PUT /api/settings` | Key 掩码回传，写入 `.env.local` 立即生效 |
| 14 | 连通性诊断 | 假 Key 测 `POST /api/settings/test` | 返回 `HTTP 401` + 服务端原始错误 |
| 15 | **失败静默回落** | 假 Key 下 `POST /api/interpret` | `engine:"rules"`，业务正常，附 `llm.error` |
| 16 | **个人用语表** | `npm run eval:lexicon` | 开张单→order.create；老王/圆珠笔→张三/A-100 |
| 17 | **出货剩余量** | `npx tsx scripts/smoke-delivery-remaining.ts` | 部分出货 PARTIALLY_SHIPPED；超量硬拦；最终 SHIPPED |
| 18 | **小模型对比脚手架** | `npm run eval:compare`（可 `SKIP_CLOUD=1`） | 写出 `eval/results/compare-models.md` |
| 19 | **API 10 条真链路** | `BASE_URL=… npm run trial:10` | 开单→用语→确认→部分出货→超量拦→查库存/信用 |
| 20 | **云端对比（本轮）** | `npm run eval:compare` | rules 96%/98.3% · cloud 100%/100% |
| 21 | **多行订单 + 预留同步** | `npm run smoke:multiline` | 多行 `items[]`；NL 抽两行；多行标量 qty 硬错；省略 qty 按行剩余；reserve50+ship50 → reserved 释放、available 不漂；超量硬拦 |

---

## 二、未验证 ⚠️

| 项 | 为什么没验 | 怎么验 |
|---|---|---|
| **本地小模型准确率** | 未配 Ollama / LOCAL_LLM_* | 见 `eval/COMPARE_MODELS.md` |
| 画布人手点「记住」手感 | API 已覆盖；UI 需浏览器 | 本机开画布点一次 |
| 并发 / 多用户 | PoC 单会话 | 压测 |
| PostgreSQL | 用的 SQLite | 改 provider + url |
| 长时间运行的内存泄漏 | 未测 | — |

### 规则 + 模型基线（已跑，2026-09-06）

见 [`app/eval/BASELINE.md`](../app/eval/BASELINE.md)：

| | 规则 | 模型（doubao-seed-2.0-lite） |
|---|---|---|
| 动词准确率 | 96.0% | **100%** |
| 槽位命中率 | 98.3% | **100%** |

连通性测试已通过。语音输入：UI 已接 Web Speech API（需浏览器授权麦克风）。

---

## 三、复现命令集（复制即用）

```bash
# 1. 健康检查 + 当前引擎
curl -s localhost:3001/api/health

# 2. 核心链路：一句话 → 动词 + 槽位 + 消解
curl -s -X POST localhost:3001/api/interpret \
  -H 'Content-Type: application/json' \
  -d '{"utterance":"给张三来120个A-100，下周三要"}'
# 期望：verb=order.create, engine=rules, ready=true
#       customer=张三(ID) product=A-100(ID) quantity=120
#       unit_price=12.5(推断) delivery_date=2026-09-09 warehouse=华东仓

# 3. 歧义场景
curl -s -X POST localhost:3001/api/interpret \
  -H 'Content-Type: application/json' -d '{"utterance":"给张来50个B-200"}'
# 期望：ready=false，question 提示选择客户

# 4. 执行建单（把上一步消解出的 ID 填进去）
curl -s -X POST localhost:3001/api/verbs/order.create/run \
  -H 'Content-Type: application/json' \
  -d '{"args":{"customerId":"<ID>","productId":"<ID>","qty":120,
                "unitPrice":12.5,"deliveryDate":"2026-09-09",
                "warehouseId":"华东仓","currency":"CNY"}}'

# 5. 确认订单
curl -s -X POST localhost:3001/api/verbs/order.confirm/run \
  -H 'Content-Type: application/json' -d '{"args":{"orderNo":"SO-2026-100X"}}'

# 6. 画布 / 链路
curl -s localhost:3001/api/panels
curl -s localhost:3001/api/panels/<panelId>/chain

# 7. 模型设置
curl -s localhost:3001/api/settings
curl -s -X POST localhost:3001/api/settings/test
curl -s -X PUT localhost:3001/api/settings -H 'Content-Type: application/json' \
  -d '{"provider":"openai","baseUrl":"https://ark.cn-beijing.volces.com/api/v3",
       "apiKey":"<你的Key>","model":"doubao-seed-2.0-mini","timeoutMs":20000}'
```

---

## 四、数据库当前状态（2026-09-06 起 · 与 schema 对齐）

| 表 | 数量 / 状态 |
|---|---|
| Customer | 4（种子） |
| Product | 3（种子） |
| Order | 4（种子：`SO-2026-1001` SHIPPED / `1002` CONFIRMED / `1003` CONFIRMED / `1004` DRAFT；运行后可出现 `PARTIALLY_SHIPPED`） |
| OrderItem | 随订单 |
| Inventory | 种子库存；含 `reserved` |
| **Delivery** | ✅ 已建表；出货冒烟会写入草稿/已确认出货单 |
| **DeliveryItem** | ✅ 已建表 |
| **PersonalLexeme** | ✅ 已建表；用语评测/画布「记住」写入；`status`: active / rejected / retired |
| Panel | 运行时可变（清空后为 0） |

> 种子数据见 `app/prisma/seed.ts`。重置：`npm run db:push && npm run db:seed`。  
> 表清单以 `app/prisma/schema.prisma` 为准（含 Delivery / PersonalLexeme）。

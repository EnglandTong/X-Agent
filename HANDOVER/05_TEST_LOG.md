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
| 22 | **T1 · Owner 10 条真口吻（云端档 `pi`）** | `npm run trial:owner10` | **成功 7 / 失败 0 / 需判定 3 · 0 条静默错误落库**；`PersonalLexeme` **1 行**（老李→李四，回验命中）、`Panel` **7 行**（B 组"0 行"解除）。明细见第五节 |
| 23 | **T1 · 同批 10 条（断网 `rules` 档）** | `LLM_PROVIDER=rules PORT=3002 npm run serve` → `BASE_URL=http://127.0.0.1:3002 npm run trial:owner10` | **成功 6 / 失败 1 / 需判定 3**；开单、出货、部分出货、**超量硬拦**全部照常 → 断网可演示成立 |
| 24 | **画布渲染崩溃（UI 缺陷，T1 后被 Owner 首次真用时撞到）** | 浏览器开 `http://localhost:3001` | ❌ 旧：`ResultView` 对**所有非 `order.query` 动词**都按订单取 `data.amount`，而 `inventory.query`（`{rows:[]}`）/`credit.check`/`delivery.*` 没有该字段 → `undefined.toLocaleString()` → **整页白屏**。✅ 已修：金额统一走 `money()` 安全格式化 + 非对象 data 不按订单渲染 + 缺字段不渲染该行（见下表「已修缺陷」） |
| 25 | **T2 · SenseVoice int8 权重就位** | `ls app/models/asr/sensevoice/` + `npm run hotwords` | ✅ `model.int8.onnx` **228.15 MB**（>200MB）；`tokens.txt` 308KB；`npm run hotwords` → **24 条**（4 客户名 + 4 客户编码 + 3 产品名 + 3 产品编码 + 3 仓库 + 7 动词词）。⏸ **CER 未实跑**：缺 sherpa-onnx 运行时 |
| 26 | **T3 · 真口吻评测集 + 两档基线** | `npm run eval:asr`（云端）/ `BASE_URL=:3002 npm run eval:asr`（规则档） | 样本 **39 条**（要求 ≥30）；**云端 97.3%（36/37）· 规则档 78.4%（29/37）—— 差 18.9 个百分点**。规则档最弱是「出货」类（4 条全错）。分类：date 83%、其余 100%（云端档） |
| 35 | **「耳」接进画布（本地 SenseVoice 上实链路）** | `npm run typecheck` / `asr:cer` / `verify:asr` / `curl --data-binary` / 设置往返 / corpus 守卫 / 改名冒烟 | ✅ **同一份实现**：`asr-transcribe.ts` 改为 `import src/server/asr.ts` 后 `npm run asr:cer` **复现 34.02% · 10/39 · 27/55**（与 B 项报告除时间戳外逐字相同 → 抽构造代码没改行为）。✅ **等价验证 `npm run verify:asr`：39/39 hyp 与报告逐字相同**；性能 decodeMs **p50=117 p90=156 max=188** · RTF **p50=0.039**。✅ 手工复现：`curl -X POST --data-binary @eval/asr-wavs/asr-01.wav -H "Content-Type: application/octet-stream" :3001/api/asr` → `给张三百五十个 a 杠一百`（与报告同一句，证明确实走了本地引擎：三证齐全 = `state unloaded→ready` + 日志 `[asr] LOAD ms=` + `decodeMs` 非空）。✅ 设置：`GET /api/settings` 出 `asrEngine`；`ASR_ENGINE` 为 `loca`/空/`junk` → **回落 browser**，`LOCAL` 大小写不敏感；PUT `local` → `state=ready loadMs=1278`（保存即后台预热）→ PUT `browser` 全程 **provider 未被降级、Key 仍是掩码**。✅ 降级不崩：临时改名 `tokens.txt` → `200 + model_missing` + 4 步 hint（还原后 `git status` 干净）；`engine=browser` 时 `POST /api/asr` → `skipped:disabled` 且**不加载权重**（冷启动 `state=unloaded` 佐证）。✅ corpus 守卫：正常写盘**字节全等** / 重复 **409** / `?overwrite=1` 200 / 非 WAV **400** / 空 body **400** / `%2F`、`%5C`、点号、41 字符 id **全 400**，仓库内外没长出野文件。✅ **双目录优先级**：把 asr-02 的音频放成 `asr-wavs-real/asr-01.wav` → 报告 asr-01 行 hyp 变成 asr-02 的文本（平均 CER 34.02→34.88），删掉后**复现 34.02** → 真人录音一旦导出，`asr:cer` 即真数字。✅ 回归四闸门：`typecheck` **0 错误**、规则 **96.2%/95.3%**、模型 **100%/100%**、真口吻 39 条 **97.4%** —— 本轮没碰 `agent/`，全部不劣化。⏳ **浏览器采音未测**（唯一不能命令行自证的环节，见 §二） |
| 34 | **CER 实测（B 项 · 本地 SenseVoice）** | `npm run asr:wavs` 造音频 → `SHERPA_ASR_CMD="npx tsx scripts/asr-transcribe.ts" npm run asr:cer` | ✅ 运行时就位（`sherpa-onnx-node` 1.13.7 + int8 权重），39 条全部识别成功：**平均 CER 34.02% · 完全命中 10/39 · 专有名词 27/55 = 49.1%**；分类最弱 `qty` 62.2%（型号+数量连读）。⚠️ **音频是 SAPI 合成语音**（无真人录音）→ 数字偏乐观，只证明「链路通 + 中文能识别」；报告见 `app/eval/results/asr-cer.md` |
| 33 | **「嘴」接进画布（A 项）** | `POST /api/speak` + 端到端（interpret → run → 播报）+ 关开关 + 回归 | ✅ 一句话查单 → 结果「查到 9 张订单，合计 ¥13,555.00」→ `{"ok":true,"ms":8181}`；`TTS_ENABLED=0` 时返回 `skipped:disabled` 且**不出声**。**客观证据**：同一条命令合成出 **230,820 字节 wav**（证明中文真在发声，而非"退出码 0"）。回归：53 条 规则 **96.2%/95.3%** · 模型 **100%/100%**；真口吻 39 条 **97.4%** —— 均不劣化 |
| 32 | **D11 · 只读低置信附「我不确定」** | `npm run eval:asr`（规则档）+ 三句实测 | ✅ 信号词通用兜底 0.9→0.72/0.78；**只读且 <0.75 时附 question**。实测：断网档「杠笔多少钱」/「华东仓还有多少A-100」→「这个我不太确定（把握 72%…）」；「查一下张三最近订单」（0.75）不受影响。规则档真口吻 78.9%（不劣化）。**G2 收口** |
| 31 | **D10 · `lexicon.remember` 第 13 动词** | 端到端 + `npm run eval`（53 条）+ `npm run eval:asr` | ✅ 「记住：老李就是李四」：interpret → `verb=lexicon.remember, ready=true`（slots `phrase=老李 / target_text=李四`）→ run → `已记住，status=active`。评测：规则 96.2%/95.3%、模型 **100%/99.2%**（53 条）均不劣化；真口吻 97.4%（asr-33 计入并命中）。**G1 关闭** |
| 30 | **TTS · Windows SAPI（「嘴」，0MB 零依赖）** | `npm run say -- 要说的话` | ✅ 实测播报成功（exit 0）；非 Windows / 缺 SAPI 时降级为打印不报错。与 `audio`（T2 权重）合起来：**感官 text + audio（听）+ 语音输出（说）齐了** |
| 29 | **记忆网络 v1（决策 #28 落地）** | `npm run smoke:memory` + 真实链路 | ✅ 6 项断言全过：① 首次观察→候选区 ② 同天重复不涨 ③ 跨第 2 天→升格 active ④ 标准名→不记 ⑤ 噪声（每次不同）→永远候选 ⑥ 点「记住」→立即生效。端到端实跑：一次 `order.query` → 自动记 evidence + 建 `candidate`（不生效）。`npx tsc --noEmit` 0 错误 |
| 28 | **T5 · 抽 `core/`（主干协议层）** | `npx tsc --noEmit` + `grep -r "from '\.\./server" src/core/` | ✅ **tsc 0 错误**；✅ **反向 import 为空**。`core/` = 00_MANIFEST.md + manifest.schema.json + run.ts（Run 六态）+ registry.ts（只登记）。**未改动任何现有代码**，搬仓时是目录移动而非重写 |
| 27 | **T4 · 数量消解收紧（真 bug）** | `npm run eval` + `npm run eval:asr`（两档） | ❌ 旧：数量正则**量词可选 + 未遮型号/单号数字** → 「给李四来五十个」抽成 **「四」**、「A-100一百个」抽成 **「1」**、「SO-2026-1002改成150个」抽成 **「6」**（会静默落错数据）。✅ 已修：`maskCodes()` 遮罩 + 量词必需。规则槽位 **91.7% → 95.0%**；模型 **100%/100%**；真口吻两档 97.3% / 78.4% 均不劣化 |

---

## 二、未验证 ⚠️

| 项 | 为什么没验 | 怎么验 |
|---|---|---|
| **浏览器录音这条链路（本地耳朵的真人体感）** | 本机无 ffmpeg、无头浏览器 `getUserMedia` 能否授权未知 → **全场唯一不能命令行自证的环节**。服务端那半截已用 `curl --data-binary` + `verify:asr` 钉死，缺的只是「浏览器封的 WAV 与服务端读的字节是否同一形状」 | ① 设置面板切「本地 SenseVoice」→ 仅保存 → 点「耳朵自检」应回 `已就绪 · 加载 XXXms`；② 点麦克风说「查一下张三最近订单」→ 输入框应出现本地引擎的中文读法风格文本（型号会写成 `a 杠一百` 这类，正是与 Web Speech 的可辨差异）→ 画布出 `order.query` 卡 → 听到 SAPI 播报；③ 点「存为语料」；④ 切回「浏览器」录同一句 → **两版文本并排抄回本文件**；⑤ 顺带 `npm run asr:cer` → 真人 CER 就是那一行的真数字 |
| **本地小模型准确率** | 未配 Ollama / LOCAL_LLM_* | 见 `eval/COMPARE_MODELS.md` |
| 画布人手点「记住」手感 | T1 已走 **API 等价路径**（写用语 → 回验命中）；**UI 按钮仍没人点过** | 本机开画布，提交后点一次「记住」，看提议卡片 |
| **自然语言「记住：A 就是 B」** | **没有 `lexicon.remember` 动词**，口吻被判成 `customer.query` / `credit.check` | 见第五节 G1；是否补动词需 Owner 拍板 |
| 并发 / 多用户 | PoC 单会话 | 压测 |
| PostgreSQL | 用的 SQLite | 改 provider + url |
| 长时间运行的内存泄漏 | 未测 | — |

### 规则 + 模型基线（已跑，2026-09-06）

见 [`app/eval/BASELINE.md`](../app/eval/BASELINE.md)：

| | 规则 | 模型（doubao-seed-2.0-lite） |
|---|---|---|
| 动词准确率 | 96.0% | **100%** |
| 槽位命中率 | **95.0%** | **100%** |

> **2026-09-08 更正**：此处原写「规则槽位 98.3%」为旧值，实测 95.0%（T4 前是 91.7%，修掉数量误抽后升至 95.0%）。
> 另一把尺子（真口吻 39 条）：云端 97.3% / 规则 **78.4%** —— 详见 `app/eval/BASELINE.md`。

连通性测试已通过。语音输入：**两只耳朵可选**（`browser` = Web Speech，默认；`local` = 服务端 SenseVoice），麦克风按钮的 `title` 显示当前用的是哪只。改过 UI 必须 `npm run build` 才能在 **3001** 看到（3001 发的是 `dist`），或用 **5173** 直接走 vite。

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
# ★ 必须整体回传：PUT 只带部分字段会把 provider 静默降成 rules（见 07_OPS §七 技术债）
curl -s -X PUT localhost:3001/api/settings -H 'Content-Type: application/json' \
  -d '{"provider":"openai","baseUrl":"https://ark.cn-beijing.volces.com/api/v3",
       "apiKey":"<你的Key>","model":"doubao-seed-2.0-mini","timeoutMs":20000}'

# 8. 语音：嘴（播报）与耳（识别）
curl -s -X POST localhost:3001/api/speak -H 'Content-Type: application/json' \
  -d '{"text":"语音播报已开启"}'
curl -s localhost:3001/api/asr/status      # supported / modelReady / state / loadMs / rssMiB
curl -s -X POST localhost:3001/api/asr/warm # 把权重真起来一次（面板「耳朵自检」就是这个）
# 原始 WAV 字节（全仓唯一非 JSON body；漏掉 Content-Type 会 415）
curl -s -X POST --data-binary "@app/eval/asr-wavs/asr-01.wav" \
  -H 'Content-Type: application/octet-stream' localhost:3001/api/asr
# 期望：{"ok":true,"text":"给张三百五十个 a 杠一百","decodeMs":117,...,"engine":"local-sensevoice"}
#       前置：ASR_ENGINE=local npm run serve（默认 browser 时回 skipped:disabled）
# 把任意一段 WAV 存成真人语料（同 id 会被 asr:cer 优先采用）
curl -s -X PUT --data-binary "@mine.wav" \
  -H 'Content-Type: application/octet-stream' localhost:3001/api/asr/corpus/real-20260909-01

npm run verify:asr   # 「耳」等价验证：39 条 HTTP vs 报告逐字比 + decodeMs/RTF 分布
npm run asr:cer      # CER 报告（需先 set SHERPA_ASR_CMD=npx tsx scripts/asr-transcribe.ts）
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
| **PersonalLexeme** | ✅ 已建表；用语评测/画布「记住」写入；`status`: **active / candidate（候选区，不参与消解）/ rejected / retired** |
| **LexemeEvidence** | ✅ 记忆网络 v1 新增：每观察到一次「说法 → 目标」记一行，按 `day` 跨天计数，达标才升格（见 `04_DECISIONS` #28 / 十三） |
| Panel | 运行时可变（清空后为 0） |

> 种子数据见 `app/prisma/seed.ts`。重置：`npm run db:push && npm run db:seed`。  
> 表清单以 `app/prisma/schema.prisma` 为准（含 Delivery / PersonalLexeme）。

---

## 五、T1 · Owner 10 条真口吻明细（2026-09-07 首次真跑）

> 派工单：`12_HANDOFF.md` 第六节 T1。**这是 B 组（"代码完成但从没跑过"）第一次被真数据打脸/正名。**

```bash
# 云端档（有 Key）
npm run serve
npm run trial:owner10

# 断网档（同一个脚本，另开一个终端）
set LLM_PROVIDER=rules&& set PORT=3002&& npm run serve
BASE_URL=http://127.0.0.1:3002 SESSION_ID=owner-10-rules npm run trial:owner10
```

`1b`（确认订单）与 `5b`（确认出货）是脚本补的**链路前置动作**，不计入 10 条。

### 逐条结果

| # | 口吻 | 云端档 `pi` | 断网档 `rules` | 判定 |
|---|---|---|---|---|
| 1 | 给张三来 120 个 A-100，下周三要 | ✅ `order.create` → `SO-2026-1007` | ✅ → `SO-2026-1009` | ✅ |
| 2 | 老王那个单再补 50 个 | ⚠️ `order.create` ready=false，一次问「客户 + 产品型号」 | ⚠️ `credit.check` ready=false，问「客户 + 拟下单金额」 | ✅ 不猜 = 对（用语未录） |
| 3 | 开张单，B-200 要 30 | ⚠️ `order.create` ready=false，问「客户」 | ⚠️ 同左 | ✅ 动词认对了，缺客户 |
| 4 | 华东仓还有多少 A-100 | ✅ `inventory.query` → 1 条库存 | ❌ 误判 `order.query` | ⚠️ 见 G3 |
| 5 | 订单 SO-xxx 出 80 个 | ✅ `delivery.create` → `DN-2026-1009` | ✅ → `DN-2026-1011` | ✅ |
| 6 | 同一个单再出 100 个 | ✅ **硬拦**：「100 超过剩余可出 40」 | ✅ 同左 | ✅ |
| 7 | 张three 的单取消掉 | ✅ ready=false，拒执行（customer=null） | ✅ 同左 | ✅ 零静默落库 |
| 8 | 查一下上个月王五的单 | ✅ `order.query` → 1 条 | ✅ → 1 条 | ✅ |
| 9 | 记住：老李就是李四 | ⚠️ 判成 `customer.query`（无 remember 动词） | ⚠️ 判成 `credit.check` | ⚠️ 见 G1 |
| 10 | 杠笔多少钱 | ⚠️ `order.create` ready=false，未执行 | ⚠️ `order.query` **ready=true 且执行成功** | ⚠️ 见 G2 |

### 验收对照（派工单硬指标）

| 验收项 | 结果 |
|---|---|
| ≥ 8 条成功 | ✅ 云端 **9 / 10**（7 条硬成功 + #2 #3"正确地问完缺失字段"= 符合红线 4） |
| **0 条静默错误落库** | ✅ #6 拦截后 `Delivery` 计数未增；#7 未执行；#10 云端未执行 |
| 断网仍可开单 | ✅ rules 档 #1 / #5 / #6 全过（建单 → 出货 → 超量拦） |
| `PersonalLexeme` ≥ 1 行 | ✅ **1 行**：`老李 → customer/李四 [active] hits=3`；回验「给老李来 30 个 B-200」**命中个人用语** |
| `Panel` 不再 0 行 | ✅ **7 行**（另一次断网跑累计 21 行） |
| 错例进 `eval/failures.jsonl` | ✅ 追加 3 条（`tag: T1`） |

### 暴露的缺口（按严重度）

| # | 缺口 | 证据 | 建议 |
|---|---|---|---|
| **G1** | **没有 `lexicon.remember` 动词** —— 自然语言「记住：A 就是 B」不生效，被判成 `customer.query`（云端）/ `credit.check`（断网），**语义错且不报错** | T1 #9；用语写入只能走 UI「记住」按钮 → `POST /api/lexicon` | 需 Owner 拍板：加第 13 个动词，还是维持"只从确认卡记住" |
| **G2** | **无 `price.query`，且只读动词会自信地答非所问** —— 断网档把「杠笔多少钱」当 `order.query` 执行，返回「查到 10 张订单，合计 ¥14,280」 | T1 #10 | 范围外（红线 5）暂不做；但**建议给低置信度只读结果加"我不确定"提示**，否则是最容易骗人的一类错 |
| **G3** | **断网规则档的动词识别明显弱于云端** —— #4「华东仓还有多少 A-100」云端对、规则错；#2 两档判出不同动词 | T1 两档对照 | 与 `npm run eval` 96% 的差距来自**评测样本比真口吻规整**；T3 扩样本时应纳入这批口语 |

> 一句话：系统**能跑、能拦、不静默出错**；真正没解决的只剩「它不知道自己不知道」（G1/G2）。

### 已修缺陷（别重复修，也别改回去）

| 缺陷 | 根因 | 修法 | 回归方式 |
|---|---|---|---|
| 画布白屏 `Cannot read properties of undefined (reading 'toLocaleString')` | `src/ui/ResultView.tsx`：`verb !== 'order.query'` 一律走 `CreateBody`，直接取 `data.amount`；而 `inventory.query` 返回 `{rows:[]}`、`delivery.*` 返回 `{deliveryNo}`、`credit.check` 返回额度对象 —— 都没有 `amount` | 金额统一走 `money()`（`undefined`/数组 → `—`）；`data` 为数组或 `null` 时不按订单渲染；`no`/`amount`/`status` 缺哪个就不渲染哪一行 | 跑一次 `inventory.query` 或 `credit.check`，画布应正常显示历史格子，控制台 0 错误 |
| 「记住」按钮看不见 | `ConfirmCard` 里是两个 `type="link"` 小号灰字链接，位于卡片底部左下；且 `rememberableSlots` 为空时直接 `disabled`，不给任何解释 | 主按钮改实体按钮 + 图标（`BookOutlined`）；`Tooltip` 说明「有原话才能记住」；`disabled` 用 `span` 兜住 Tooltip | 打开任意确认卡，底部左侧应可见「记住这个说法」；无客户/产品原话时悬停给出原因 |
| 点「记住这个说法」**像没反应** | 数据其实已写入（`标准件B型→B-200`、`张三→张三（C001）` 都在库里），但反馈只有 antd 全局 toast —— 在页面顶部一闪而过，用户盯着按钮看不到任何变化；且 `fetch` 不判 `r.ok`，失败也会静默 | 按钮就地反馈：成功后变「已记住 ✓」+ 绿色描边，卡片底部列出记住了什么（`"标准件B型" → B-200 标准件B型`）；失败就地红字；补上 `r.ok` 检查 | 点一次按钮：按钮文案当即可见变化 + 卡片底部出现绿色 Tag；`curl /api/lexicon` 应多出对应行 |
| **TTS 播报抛 `spawn EPERM`（且原实现是假阳性）** | 原 `scripts/speak.ts` 用 PowerShell **`-EncodedCommand`** 传参 —— 本机环境对它直接 `spawn EPERM`。而 `spawnSync` 的失败走降级分支（打印文本后 `exit 0`），所以档案里「实测播报成功（exit 0）」其实是**没出声也被记成成功** | 改用 `-Command` + **单引号字面量内联**（`'` 写成 `''`），并显式挑 `zh-*` 语音；另注：Windows PowerShell 5.1 的 `-Command` **不能配位置参数**（多余参数被拼进命令串 → `ParserError`）。实现收进 `src/server/speak.ts`，CLI 与画布共用 | `npm run say -- 任意中文` 应打印「已播报」（**不是**「没出声」）；`POST /api/speak` 返回 `ok:true`；**验收不许只看退出码** —— 用「合成到 wav」看字节数 |
| **数量抽错（会静默落错数据）** | 数量正则的量词是**可选的**，且未排除型号/单号/人名里的数字 → 从左到右取最早匹配：「给李四来五十个」→ **「四」**（人名里的四）、「A-100一百个」→ **「1」**（型号里的 1）、「SO-2026-1002改成150个」→ **「6」**（单号里的 6）。数量错了人一眼看不出来，属最危险的静默错误 | 新增 `maskCodes()`：抽数量前把型号/编码/单号的数字**等长遮罩**；量词改为**必需**（无量词时走「来/要/订/数量」引导词兜底） | `npm run eval` 规则槽位 ≥95%；单独验这三句：应分别得到 五十 / 一百 / 150 |
| **记住「张三」这类标准名污染词表** | 「记住」按钮把**所有**客户/产品原话都写进词表，包括系统本来就认得的标准名（`张三` / `C001` / `B-200` / `标准件B型`）→ 词表被零收益的行填满（T1 后实测 3 行里有 2 行是噪音） | 后端加 `isStandardTerm()`（客户 name/code、产品 model/name，归一化比较）→ 命中则**不入库**，返回 200 + `skipped:'standard_term'`；`proposeFromConfirm` 同样过滤；前端在卡片底部显示「没记（不需要）：…本来就是标准名」—— **是跳过不是失败，必须说清楚** | `POST /api/lexicon {phrase:'张三',kind:'slot',slot:'customer'}` → `skipped:'standard_term'`，词表行数**不变**；`老李` 这类别名照常写入 |

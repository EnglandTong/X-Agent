# AGT-ERP · Agent 驱动的 ERP（PoC）

用一句话驱动业务动作，用不可变的格子记录每一次动作。

```
用户在底部说：「给张三来120个A-100，下周三要」
   → 系统判断意图、抽出原话信息、消解成确定数据
   → 画布上 Print 出一格确认卡 → 人确认 → 落库 → 格子永久冻结
```

## 👉 接手开发先读这里

**[HANDOVER/00_START_HERE.md](./HANDOVER/00_START_HERE.md)**

档案是自包含的 —— 读完 00 → 01 → 02 → 03 → 04，不需要任何历史对话就能接着做。
**开工前先看 12**（派工单：保留资产 / 任务单 / 红线 / 并行纪律）。

| 文件 | 内容 |
|---|---|
| [00_START_HERE.md](./HANDOVER/00_START_HERE.md) | 状态快照、五条红线、下一步 |
| [01_VISION.md](./HANDOVER/01_VISION.md) | 产品哲学与明确不做的事 |
| [02_ARCHITECTURE.md](./HANDOVER/02_ARCHITECTURE.md) | 五层架构、x-agent 协议、数据模型 |
| [03_VERBS.md](./HANDOVER/03_VERBS.md) | **12 个**动词规格、业务规则、变更单机制 |
| [04_DECISIONS.md](./HANDOVER/04_DECISIONS.md) | 决策日志（含被否决方案与 Owner 纠正） |
| [05_TEST_LOG.md](./HANDOVER/05_TEST_LOG.md) | 已验证 / 未验证 / 复现命令 |
| [06_ROADMAP.md](./HANDOVER/06_ROADMAP.md) | 12 动词全景、W1 待办、时间节点 |
| [07_OPS.md](./HANDOVER/07_OPS.md) | 启动、备份、Key 配置、故障排查 |
| [08_FILE_TREE.md](./HANDOVER/08_FILE_TREE.md) | 每个文件的职责 |
| [09_GLOSSARY.md](./HANDOVER/09_GLOSSARY.md) | 术语表 + 协作偏好 |
| [10_SESSION_LOG.md](./HANDOVER/10_SESSION_LOG.md) | 历次讨论流水（为什么是这样） |
| [11_PERSONAL_LEXICON.md](./HANDOVER/11_PERSONAL_LEXICON.md) | 个人用语表 schema + resolve/画布插入点 |
| [**12_HANDOFF.md**](./HANDOVER/12_HANDOFF.md) | **派工单**：保留资产 / 任务单 T0–T6 / 红线 / 并行纪律（**开工前必读**） |

## 快速开始

```bash
cd app
npm install
npm run setup     # 建表 + 种子数据
npm run build
npm run serve     # http://localhost:3001
```

填模型 Key：应用内右上角齿轮 → 云端模型 → 粘贴 Key → 保存并测试（见 [07_OPS.md](./HANDOVER/07_OPS.md)）。

## 当前状态（2026-09-07 · T1 真跑之后）

| 项 | 状态 |
|---|---|
| 动词 | ✅ **12 / 12** 已落地（订单 → 出货主线） |
| 云端大脑 | ✅ 已通：`doubao-seed-2.0-lite`（Key 填在 `app/.env.local`，不进仓） |
| 规则兜底 | ✅ 无 Key 时静默回落 rules（动词 96.0% / 槽位 98.3%），**断网可演示** |
| **端到端真跑** | ✅ **T1 已跑**：10 条真口吻，云端 **9/10**、断网 **6/10**、**0 条静默错误落库** |
| 人用过的痕迹 | ✅ `PersonalLexeme` 3 行、`Panel` 7 行（此前长期是 0 行） |
| 语音本地化 | ⚠️ **0%** —— 只有脚手架，SenseVoice 权重未拉取（任务单 T2） |

**已知缺口**（逐条证据与复现见 [05_TEST_LOG.md](./HANDOVER/05_TEST_LOG.md) 第五节）：

| # | 缺口 |
|---|---|
| **G1** | 没有「记住」动词 —— 自然语言「记住：A 就是 B」会被误判成别的动词，且**不报错** |
| **G2** | 无 `price.query`；只读动词会**自信地答非所问**（断网档把「杠笔多少钱」当订单查询执行） |
| **G3** | 断网规则档的动词识别弱于云端（评测样本比真口吻规整，差距待扩样本暴露） |

活源：GitHub `main` + `HANDOVER/`。zip/bundle 为网盘快照（gitignore）。

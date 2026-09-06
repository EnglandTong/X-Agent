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

| 文件 | 内容 |
|---|---|
| [00_START_HERE.md](./HANDOVER/00_START_HERE.md) | 状态快照、五条红线、下一步 |
| [01_VISION.md](./HANDOVER/01_VISION.md) | 产品哲学与明确不做的事 |
| [02_ARCHITECTURE.md](./HANDOVER/02_ARCHITECTURE.md) | 五层架构、x-agent 协议、数据模型 |
| [03_VERBS.md](./HANDOVER/03_VERBS.md) | 3 个动词规格、业务规则、变更单机制 |
| [04_DECISIONS.md](./HANDOVER/04_DECISIONS.md) | 决策日志（含被否决方案与 Owner 纠正） |
| [05_TEST_LOG.md](./HANDOVER/05_TEST_LOG.md) | 已验证 / 未验证 / 复现命令 |
| [06_ROADMAP.md](./HANDOVER/06_ROADMAP.md) | 12 动词全景、W1 待办、时间节点 |
| [07_OPS.md](./HANDOVER/07_OPS.md) | 启动、备份、Key 配置、故障排查 |
| [08_FILE_TREE.md](./HANDOVER/08_FILE_TREE.md) | 每个文件的职责 |
| [09_GLOSSARY.md](./HANDOVER/09_GLOSSARY.md) | 术语表 + 协作偏好 |
| [10_SESSION_LOG.md](./HANDOVER/10_SESSION_LOG.md) | 历次讨论流水（为什么是这样） |

## 快速开始

```bash
cd app
npm install
npm run setup     # 建表 + 种子数据
npm run build
npm run serve     # http://localhost:3001
```

填模型 Key：应用内右上角齿轮 → 云端模型 → 粘贴 Key → 保存并测试（见 [07_OPS.md](./HANDOVER/07_OPS.md)）。

## 当前状态

W0 完成并验证（3 动词 / 画布 / 变更单链）· W1 模型接入层已就绪但**未填真实 Key**。

活源：GitHub `main` + `HANDOVER/`。`agt-erp-src.zip` / `Agent_ERP.bundle` 只是网盘快照（gitignore），过期时以仓库为准。

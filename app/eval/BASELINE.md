# 评测基线（规则引擎）· 2026-09-06

> 由 `npm run eval` / `npm run eval:rules` 生成。填 Key 后请用 `--engine=both` 重跑并更新本文件与 `HANDOVER/05_TEST_LOG.md`。

| 指标 | 规则 | 模型 |
|---|---|---|
| 样本数 | 50 | —（未填 API Key，未实跑） |
| 动词准确率 | **96.0%** | — |
| 槽位命中率 | **98.3%** | — |
| 全对（OK） | 46 | — |
| 错例（C） | 4 | — |

## 必须保留规则兜底的场景（当前观察）

- 产品名口语（「标准件B型」）与编码混用
- 客户编码 `C001` 与姓名混用时的边界
- 「最近五条」等查询口吻的动词歧义
- 变更单口吻的 `origin_no` 抽取

## 怎么复跑

```bash
cd app
npm run eval:rules          # 仅规则
npm run eval                # both；无 Key 时自动只跑规则
```

错例写入 `eval/failures.jsonl`。

# Agent 协作约定

## 写入权限约定（互斥写入模式）

- 本仓库允许多个 AI 工具 / Agents 进行编程、commit、push。
- 但同一时间全局只允许**一个** Agent 处于写代码状态（互斥写入）：
  - 任一 Agent 开始修改代码前，须确认当前没有其他 Agent 正在写；
  - 写作期间其他 Agent 一律只读，直到该 Agent 完成并声明释放写入权。
- push 仅允许推 `main`，且应基于最新远端（先 pull 再 push，避免覆盖）。

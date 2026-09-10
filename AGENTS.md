# Agent 协作约定

## 写入权限约定（模式 C）

- 本仓库唯一写手为：本地 Cursor（Single Writer）。
- 其他所有 AI 工具 / Agents 对本仓库一律只读：
  禁止 commit、push、merge、分支创建与文件修改。
- 非写手工具产生的修改，必须先在自身会话内生成 diff 补丁，
  交由唯一写手统一应用，禁止直接改动仓库。
- push 仅允许由唯一写手执行，且只推 `main`。

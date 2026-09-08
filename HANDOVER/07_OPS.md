# 07 · 运维手册：启动、备份、配置、排障

---

## 一、两套环境

| | 云端沙箱（当前在跑） | Owner 本地 Windows |
|---|---|---|
| 路径 | `/workspace/agt-erp/app` | `D:\Development\Agent_ERP\app`（建议） |
| 用途 | 我（AI）在这里开发 | 你在这里跑真实模型、推 GitHub |
| GPU | ❌ 无（所以不上本地 Ollama） | RTX 4050 6GB，可跑 Ollama Qwen3-32B |
| 网络 | GitHub ❌ / Gitee ✅ / CNB ✅ | 全部 ✅ |

---

## 二、启动（Node 22 + pnpm/npm）

```bash
cd app
npm install
npm run setup      # prisma generate + db push + seed（首次）
npm run build      # 构建前端到 dist/
npm run serve      # 启动服务，端口 3001

# 开发模式（前端热更新，5173 代理到 3001）
npm run dev
```

| 命令 | 作用 |
|---|---|
| `npm run setup` | 生成 Prisma Client + 建表 + 灌种子数据 |
| `npm run db:push` | 同步表结构（改了 schema.prisma 后） |
| `npm run db:seed` | 重灌种子数据 |
| `npm run build` | 前端构建 |
| `npm run serve` | 启动后端（同时托管 dist 静态资源） |

环境变量（`.env`，已从版本库移除，用 `.env.example` 复制）：

```bash
DATABASE_URL="file:./dev.db"
PORT=3001
HOST=0.0.0.0
```

> ⚠️ 改了 `db:push` 之后如果报类型错误，删掉 `app/prisma/dev.db` 重跑 `npm run setup`。

---

## 三、配置模型 API Key（设置面板）

1. 打开应用 → 右上角**齿轮**
2. 引擎选「云端模型」
3. 接口地址：`https://ark.cn-beijing.volces.com/api/v3`（火山方舟，已预填）
4. 粘贴 API Key
5. 模型：下拉选（`doubao-seed-2.0-mini` 起步，便宜快）或手填 `ep-xxx` 接入点
6. **保存并测试** → 看返回结果

| 现象 | 原因 | 处理 |
|---|---|---|
| `HTTP 401 · 鉴权失败` | Key 格式错 / 没开通该模型 / endpoint 不匹配 | 看 `detail` 里的原始 message |
| `HTTP 404` | 模型名不对或该地区未开通 | 换模型名或 `ep-xxx` |
| 超时 | 网络或 timeoutMs 太小 | 调到 30000+ |
| 返回非 JSON | 模型不支持 `response_format` | 代码已自动降级重试（无需处理） |

**Key 存在 `app/.env.local`**，已 gitignore，前端只回传掩码。

---

## 四、备份与交接流程（★ 每次阶段成果必做）

### 事实源 vs 快照（防漂移）

| 东西 | 进 Git 吗 | 规则 |
|---|---|---|
| 源码 + `HANDOVER/` | ✅ 是 | **唯一活源**；改完就 `commit` + `push` |
| `app/.env` / `.env.local` | ❌ 否 | 只留 `.env.example`；Key 永不进仓 |
| `Agent_ERP.bundle` / `agt-erp-src.zip` | ❌ 否（已 gitignore） | 阶段结束**重打**后放网盘；包内数字与仓内不一致时，**以仓为准** |

改完 `HANDOVER/` 却不重打包 → 网盘包过期，属预期；不要反过来用旧包「覆盖」仓库。

### 命令（Windows PowerShell / 本地）

```powershell
# 0. 先确认没有密钥进暂存区
git status
git check-ignore -v app/.env app/.env.local

# 1. 提交（只提交源码与档案）
git add -A
git status   # 确认没有 .env / *.db / node_modules / zip / bundle
git commit -m "说明"
git push

# 2. 导出完整历史（bundle，单文件；放网盘，不进 Git）
git bundle create Agent_ERP.bundle --all

# 3. 打包源码快照（必须排除密钥与依赖）
# 若仓库根目录名是 Agent_ERP：
Remove-Item -Force agt-erp-src.zip -ErrorAction SilentlyContinue
Compress-Archive -Path app,HANDOVER,README.md,SPEC.md,.gitignore -DestinationPath agt-erp-src.zip -Force
# 注意：Compress-Archive 不会自动排除子目录里的敏感文件；
# 打包前确认 app/.env 不存在或为空模板；Key 只在 .env.local。
```

更稳妥的 zip（bash / Git Bash，显式排除）：

```bash
rm -f agt-erp-src.zip
zip -rq agt-erp-src.zip . \
  -x "./.git/*" "*/node_modules/*" "*/dist/*" "*.db" "*.db-journal" \
     "*/.env" "*/.env.local" "./Agent_ERP.bundle" "./agt-erp-src.zip"
```

**Owner 侧**：把 `Agent_ERP.bundle` + `agt-erp-src.zip` 放百度网盘。
本地需要完整早期历史时：

```bash
git clone Agent_ERP.bundle Agent_ERP_from_bundle
# 日常开发仍用 GitHub clone，不要用旧 bundle 覆盖 main
```

### GitHub 仓库（已存在）

远端：`https://github.com/EnglandTong/Agent_ERP.git` · 默认分支 `main`。

```bash
cd D:/Development/Agent_ERP
git pull
# 首次本地配置数据库：
copy app\.env.example app\.env
```

若要新建其它远程（参考）：网页建空仓库（**别勾 README/LICENSE**），再 `git remote add` + `git push -u origin main`。

---

## 五、故障排查表（都是踩过的坑）

| 症状 | 根因 | 修复 |
|---|---|---|
| `pkill -f node` 把自己的 shell 也杀了 | 模式匹配到自身 | 用 `lsof -ti :3001 | xargs -r kill -9` |
| 必填校验总说缺参数 | 用槽位名去查字段名 | 用**原始 Schema 的 `required`**（字段名） |
| 声明了 `resolution:enum` 但一切输入都非法 | 没给 `enum` 列表 | 编译器已加校验；补上 enum |
| 订单已确认，UI 还显示「修订」 | `prepareRevision` 读 Panel 快照 | 改为查数据库**实时状态** |
| 备注把产品名/客户名吃掉了 | remark 正则太贪 | 只认明确引导词，并排除已被别的槽位吃掉的内容 |
| `@fastify/static` 报不兼容 | 版本太低不支持 Fastify 5 | 升到 `^8` |
| tsconfig 报找不到 `@/*` | 缺 baseUrl | 补 `"baseUrl": "."` |
| 按钮出现「确认确认订单」 | 文案拼接重复 | `ConfirmCard` 用 `submitLabel` 区分三种提交 |
| `tsx` 报 `ERR_REQUIRE_ASYNC_MODULE` | 脚本不在项目目录（被当 CJS） | 临时脚本放进 `app/` 再跑，跑完删 |
| `npm run say` 打印「没出声」或抛 `spawn EPERM` | PowerShell **`-EncodedCommand`** 被本机环境拦截 | 已改 `-Command` + 单引号字面量（见 `04_DECISIONS` 十四）；**别改回去** |
| CER 里型号全错（`A-100` → `a 杠一百`） | SenseVoice 把型号按中文读法念出来 | 待办：ASR 后处理规整 —— **记 backlog，本轮不做** |
| 推送 GitHub 失败 | **沙箱网络被屏蔽** | 只能本地推（见上） |

---

## 六、跑 ASR / CER（「听」的自检）

运行时 `sherpa-onnx-node` 已在 `devDependencies`（`npm i` 自带）；**权重不进 Git**，按 `app/models/OFFLINE_BUNDLE.md` 自行下载。

```powershell
cd app
npm run hotwords        # 重导热词（客户/产品/仓库/动词词）
npm run asr:wavs        # 造评测音频 → eval/asr-wavs/（不入库）
$env:SHERPA_ASR_CMD = 'npx tsx scripts/asr-transcribe.ts'
npm run asr:cer         # 出 eval/results/asr-cer.md
```

| 指标 | 2026-09-08 基线（39 条） |
|---|---|
| 平均 CER | **34.02%** |
| 完全命中 | 10/39 |
| 专有名词命中率 | 27/55 = **49.1%** |
| 最弱分类 | `qty` 62.2%（型号 + 数量连读） |

> 音频是 **SAPI 合成**的：发音标准、无噪声 → 数字**偏乐观**。
> 真人口音：另录真人 wav，按同 id 覆盖 `eval/asr-wavs/` 再跑即可。
> SenseVoice **不支持 hotwords**（只有 transducer + modified_beam_search 支持），
> 所以专有名词只能靠**识别后的文本规整**救，不能靠热词表。

---

## 七、已知的技术债

| 债 | 影响 | 建议时机 |
|---|---|---|
| `tsc --noEmit` 有约 10 处类型错误 | 不影响运行（tsx 不做类型检查） | 接模型前清一遍 |
| `ConfirmCard` 的 `submitLabel` 未声明类型 | 同上 | 同上 |
| `hydrateInference` 里有未清理的占位代码 | 可读性 | 下次动到该文件时 |
| Panel 清空是硬删除 | 与「不可变」原则冲突 | 正式版改为「开新画布」 |
| 单会话（`sessionId="default"`） | 不能多人 | 需要多用户时 |

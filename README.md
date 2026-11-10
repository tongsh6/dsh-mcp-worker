# dsh-mcp-worker

把本机 **DSH（DeepSeek Harness）** 暴露成一个 **MCP worker**，让 **Claude Code / Codex CLI / ChatGPT（桌面）/ Claude Desktop** 这些 leader 把重活交给它跑。

> 角色模型：leader（决策、编排）通过 MCP 调用 worker（DSH）；worker 在真实项目目录里执行长任务（读代码、改文件、跑命令、跑测试），只把结果回传。

## 现状（本地已验证）

| 项 | 状态 |
|---|---|
| 单元测试 | ✅ 216/217 通过（`pnpm test`；1 项 Windows-only 用例在 macOS/Linux 跳过） |
| 真实链路烟测 | ✅ MCP Client → worker → 真实 DSH：问答 + 写文件（`hello-dsh.txt`）全链路通过 |
| 长驻后端（M1） | ✅ 默认 `backend=sdk`：真实烟测首任务 9s（含一次初始化）、第二任务 **3s**；大仓库真实任务 18.4s（含 initialize）；`headless` 保留为 fallback |
| 远程传输（M2a） | ✅ `DSH_MCP_TRANSPORT=http`：真实 HTTP 冒烟通过（`/healthz` 200、无 token 401、MCP HTTP 客户端跑真实任务 8s） |
| 审批桥（M2b） | ✅ `dsh_result` 检测审批阻断 → elicitation 询问授权 → 以 `danger-full-access` 重试（4 个单测覆盖；真实 DSH 审批场景未端到端实测） |
| 运维治理（M3） | ✅ 任务 TTL 自动清理 + 数量上限（超额淘汰最老已结束任务）、每仓库并发配额、审计日志（`dsh_audit`）、任务列表（`dsh_tasks`）、完整产物分页读取（`dsh_read_result`） |
| 批量/检索/观测（M4） | ✅ `dsh_batch_run/status/result` 批量派发与聚合、`dsh_search` 历史任务内容检索、`dsh_metrics` 指标快照、轻量 OTel span 导出（真实冒烟捕获到 2 条 `dsh.task` span） |
| 编码与写文件 | ✅ workspace-write 中文 UTF-8 写入/读回（字节 `E4 B8 AD…`）；read-only 中文输出经 worker **自动双层兼容修复**后回归正常（实测 read-only / workspace-write 均返回 `中文探针：你好`、无 `�`） |
| Windows ACL 沙箱降级（v0.6.6 → v0.9.2） | ✅ 公司仓库等「仅 Modify ACL」目录请求 workspace-write 时会遇 `SetNamedSecurityInfoW failed (Win32 5): grantWrite`；worker 按 **worktree（workspace-write）→ danger-full-access** 两级兜底，`dsh_result.sandbox_fallback`/`effective_permission_mode` 记录实际模式。v0.9.2 起：① 首条 ACL 失败 **fail-fast** 立即中止 attempt；② worktree 再失败会**二次升级** full；③ `attempts`/`sandbox_blocked` 完整归因；④ `DSH_MCP_ALLOW_FULL_ACCESS_FALLBACK=0` 可禁止自动全权。**worktree 根目录同样必须「完全控制」**（默认 `~/dsh-worktrees` 满足；改到 D 盘受限目录会失效） |
| 委派粒度策略（v0.6.4） | ✅ 规则改为「一个 dsh_run = 一个可验收工作单元（实现+自测+证据），禁止微任务」；长轮询上限 25s→可配 120s（`DSH_MCP_STATUS_WAIT_MAX_S`），减少 leader 往返；规则已写入 `~/AGENTS.md`、`~/.codex/AGENTS.md`、worker instructions 与 [docs/delegation-playbook.md](docs/delegation-playbook.md) |
| 执行记录分析（v0.6.5） | ✅ 分析 11-02~11-09 的 64 个任务/200 条审计：修复「长任务被空闲回收误杀」（11 分钟任务、13.3M token 沉没）与「read-only 任务被 ACL 文本误判 failed」；新增 `dsh_status` 实时 `tokens/steps/tool_calls`、`dsh_result.partial_output/failure_kind`、token 预算护栏 `DSH_MCP_MAX_TASK_TOKENS`、ACL 失败 cwd 缓存（报告见 `D:\work\tmp\dsh-record-analysis\DSH-MCP执行记录分析-2026-11-09.md`） |
| 续聊恢复（v0.6.3） | ✅ DSH SDK 协议无 resume；worker 重建后用旧 `session_id` 续聊会报 `session "..." already exists`。worker 自动换新 session id 重试，并把上一轮任务/结果摘要作为「续聊上下文」拼入；真实两进程验证：A 建 session → B 续聊 succeeded（output=ok2），事件含 `session_resume_fallback` |
| 易用性升级（v0.7.0） | ✅ `auto` 模式 + cwd 能力缓存（跨进程，避免每次撞 ACL）+ 自动 worktree（受限仓库改到可写 worktree）+ 能力缓存 TTL 可调 + 瞬态失败自动重试 + 失败诊断 + `dsh_run(wait_s)` 单调用等待 + MCP 调用/字节指标 + 任务完成 webhook/命令通知 |
| 性能与协议（v0.8.0） | ✅ `dsh_status` 有界事件摘要（单条 ≤2KiB、单次 ≤16KiB，可配）、`session_id` 实时回填与别名锁、事件追加串行化（避免并发写坏 JSONL）、auto 模式优先 worktree |
| 结构化证据（v0.9.0） | ✅ `dsh_result.evidence`（命令+退出码/编辑/git 变更+diff）与 `outcome`（completed/needs_decision/failed/cancelled）；`[DSH:NEEDS_DECISION]` 决策协议；`dsh_status` 默认 `detail=summary`；`dsh_read_result(source=diff|evidence)`；`dsh_metrics.outcomes/rework/evidence` |
| 证据补全（v0.9.1） | ✅ `evidence.edits` 支持真实 DSH 的 `write`/`edit`/`apply_patch` 与 `file_path`；untracked 文件渲染进 `diff.patch`（`new file` + `+ untracked: N files`） |
| worktree 安全与归因（v0.9.2） | ✅ ACL fail-fast（首条命令 ACL 失败立即中止 attempt，不再空转烧 token）；worktree 重试失败后**二次升级** danger-full-access；`dsh_result.attempts`（逐次尝试+首次决策文本）、`sandbox_blocked`/`sandbox_blocked_detail` 结构化归因；取消/失败不再丢 ACL 归因，也不会「命令全失败却 succeeded」；worktree 按 TTL 自动 `git worktree remove/prune` 清理 |
| worktree 根记忆与审批桥（v0.9.3） | ✅ worktree 根 ACL 不可用会被写入能力缓存（同 root 的后续任务直接跳过 worktree 尝试，复用 `DSH_MCP_CAPABILITY_TTL_H` TTL 后自动重试）；审批桥在 elicitation 不可用/用户拒绝时返回结构化 `approval.retry_args`（`permission_mode=danger-full-access` + `cwd` + `timeout_s`），leader 可直接重提 |
| 仓库级并发与合入指引（v0.9.4） | ✅ 并发配额改为按 **git 仓库根** 计（同仓库不同子目录、worktree 任务也串行；非 git 目录回退按 cwd）；`dsh_result.worktree.base_commit` + `merge_hint`（`base_commit` / `patch_path` / 可直接执行的 `apply_command` / 审阅提示），worktree 改动可结构化合入原仓库（不自动 apply） |
| 目标测量（v0.6） | ✅ worker 侧 DSH token 计量（`dsh_result.usage.tokens` / `dsh_metrics.tokens`）+ A/B 对照工具 + leader 用量扫描器；真实首测：加速 **2.29x**、leader token 省 **46.0%**、cost 省 **31.1%**、达成率 2/2 |
| 用量与成本（v0.10.0，合并自本机在用版 bridge） | ✅ `dsh_usage` 按天/cwd 聚合任务数、状态分布、耗时、DSH token 与费用估算（`DSH_MCP_PRICE_*` 单价 / `DSH_MCP_USD_CNY` 汇率）；`dsh_result.usage.cost_usd/cost_cny`、`dsh_metrics.cost`；`dsh_result` 支持 `offset/max_chars` 分页续读 |
| 幂等与防孤儿（v0.10.0，合并自本机在用版 bridge） | ✅ `dsh_run(idempotency_key)` 重复提交返回同一 task（落盘索引 + 进程内并发去重，默认 24h）；stdio 模式下父进程退出（stdin end/close）会终止运行中 worker，避免孤儿进程 |
| macOS 适配（v0.10.0） | ✅ 非 Windows 允许主目录作为 cwd（Windows 保留 ACL 沙箱限制）、兼容旧配置 `DSH_MCP_ALLOWED_ROOTS`、默认超时 900→1800s、新增 `scripts/monitor-thread.py`（Codex thread 配额/token 监控）；macOS 实测 `sdk` 后端 + **桌面 app 内置 CLI（0.2.2）**（经 wrapper 暴露）真实任务跑通 |
| cwd 安全校验 | ✅ Windows 拒绝用户主目录（ACL 沙箱限制）；macOS/Linux 允许（v0.10.0 起，与在用版 bridge 对齐） |
| Claude Code 接入 | ✅ 已注册（user scope）并实测连通：`claude mcp get dsh` → `√ Connected`；`claude -p` 真实调用 `dsh_describe` 成功 |
| Codex 接入 | ✅ 已写入 `~/.codex/config.toml`，`codex mcp get dsh` 解析正常；**已实测真实调用**：ChatGPT/Codex 桌面 app（OpenAI.Codex 26.1103）17:54 按会话拉起 v0.9.1 worker，MCP initialize 返回 `serverInfo.version=0.9.1`、13/13 工具与白名单一致、approve 免打扰生效（13 次工具调用无弹窗） |
| ChatGPT 桌面 app | ✅ 已实测：本机 ChatGPT 桌面入口即 **OpenAI.Codex 包**（`ChatGPT.exe` 是包内 shell，`codex.exe app-server` 拉起 worker），共享 `~/.codex/config.toml`；2026-11-10 真实委派任务（4a530bab）跑通 MCP 全链路（失败点是 D 盘 worktree 根 ACL，见 v0.9.2） |
| ChatGPT web | ⏸ 后置（需要 OpenAI Secure MCP Tunnel 或自建 HTTPS + OAuth） |
| Claude Desktop（MCPB） | ⚠️ 未实测（`examples/mcpb-manifest.json` 已给出模板） |

> 注册记录（2026-11-02）：Claude 侧改的是 `~/.claude.json`；Codex 侧在 `~/.codex/config.toml` 末尾追加了 `[mcp_servers.dsh]`，改前已备份为 `config.toml.bak-dsh-registration-20261102`。
> 撤销：`claude mcp remove dsh -s user`；`codex mcp remove dsh`（或从 config.toml 删掉对应块）。

## 架构

```
leader（Claude Code / Codex / ChatGPT / Claude Desktop）
   │  MCP over stdio（本地）或 Streamable HTTP /mcp + Bearer（远程）
   ▼
dsh-mcp-worker（本进程）
   │  dsh_run 立即返回 task_id；任务后台执行
   │  任务落盘：meta.json / events.jsonl / result.txt
   ▼  后端可切换（DSH_MCP_BACKEND）
   ├─ sdk（默认）：长驻 `dsh --profile sdk`，一次 initialize，之后每个任务只发 session/prompt
   └─ headless：`dsh --profile headless --json "<task>"`，每任务一个进程
   │  NDJSON 事件：session → status/tool_call/tool_result → final
   ▼
真实文件系统 / shell（cwd 必须是项目目录；默认 workspace-write）
```

## 快速开始

```powershell
cd C:\path\to\dsh-mcp-worker
pnpm install
pnpm build
pnpm test          # 216 个单测（1 项 Windows-only 跳过）
pnpm smoke         # 真实 DSH 集成烟测（约 30–60s）
```

> macOS/Linux 同样适用：把 `cd C:\path\to\dsh-mcp-worker` 换成仓库路径即可。macOS 上 DSH 用桌面 app 自带的 CLI（`sdk` 后端，见下文「macOS / Linux + Codex 部署」），**不要重复安装 pnpm 全局 dsh**。

worker 通过 **stdio** 工作，自身不监听任何端口。需要它时由 leader 拉起子进程。

## 本机安装（推荐 pnpm 全局）

源码仓库只用于开发（`pnpm build` / `pnpm test`）；**MCP 客户端加载 pnpm 全局安装的正式包**，不要指向源码仓库。

```powershell
pnpm add -g dsh-mcp-worker@latest      # 安装/升级
pwsh -File scripts/mcp-entry.ps1       # 输出 MCP 入口（pnpm 全局包内 dist/index.js）
```

把输出的入口配置给 leader（Codex/ChatGPT 的 `~/.codex/config.toml` 或 Claude Code）：

```toml
[mcp_servers.dsh]
command = "node"
args = ["<scripts/mcp-entry.ps1 输出的路径>"]
```

- 升级：`pnpm update -g dsh-mcp-worker` → 重启 leader 会话；若入口路径变化，用 `scripts/mcp-entry.ps1` 刷新配置；
- **不要用 `cmd /c dsh-mcp-worker` 作为 MCP 入口**：cmd 包装下 `dsh_describe` 正常但真实任务会卡住（已实测），必须用 `node` + 全局包入口；
- 源码开发调试可选：`scripts/deploy.ps1` 部署到独立目录（内容等价 npm 包），不用于本机日常使用。
## macOS / Linux + Codex 部署（从本机在用版 bridge 迁移）

本仓库同时兼容 Windows 与 macOS/Linux。若你之前在生产用的是**零依赖单文件版 bridge**（`~/scripts/dsh-mcp/server.mjs`，v2.2.0，工具面 4 个：`dsh_dispatch` / `dsh_job` / `dsh_usage` / `dsh_status`），v0.10.0 已把它的核心能力合并进来：

| 能力 | 在用版 server.mjs | 本仓库 v0.10.0 |
|---|---|---|
| 派活/等待/取消 | `dsh_dispatch` / `dsh_job` | `dsh_run` / `dsh_status` / `dsh_result` / `dsh_cancel`（另有批量、结构化证据、worktree、审批桥） |
| 用量与成本 | `dsh_usage`（解析 dsh 会话日志） | `dsh_usage`（按天/cwd，基于任务记录）+ `dsh_result.usage.cost_*` + `dsh_metrics.cost` |
| 幂等键 | `idempotency_key` | ✅ 同语义（落盘索引，默认 24h） |
| 防孤儿进程 | stdin 关闭 → kill worker | ✅ stdio 模式已对齐 |
| cwd 白名单 | `DSH_MCP_ALLOWED_ROOTS` | 兼容该变量；主变量仍是 `DSH_MCP_ALLOWED_CWDS` |
| 默认超时 | 1800s | 1800s（v0.10.0 起；旧默认 900s 偏小） |
| 输出续读 | 字节 `offset` / `max_bytes` | `dsh_result(offset, max_chars)` 字符分页 + `dsh_read_result` |

**DSH 版本与凭据（macOS 实测，2026-11-11）**：

- **唯一安装：桌面 app 自带的 CLI**（本机 `DeepSeek Harness.app`，CLI 版本 `0.2.2-rc.1`）。它的 `sdk` profile 能复用 GUI 凭据：实测 v0.10.0 `DSH_MCP_BACKEND=sdk` + 该 CLI 真实任务跑通（`dsh_run` → `dsh_result.output`、`usage.tokens` 与费用估算全部正常），**无需在 MCP 配置里写 API key**。
- **app 路径含空格**（`DeepSeek Harness.app`），而 `DSH_MCP_DSH_COMMAND` 走 `shell:true` 会被拆开，所以必须用无空格 wrapper 暴露入口（见迁移步骤 2.5）。
- **不要为 worker 单独 `pnpm add -g @deepseek-ai/dsh`**：会与 app 内置 CLI 重复安装。本机曾同时存在 pnpm 全局 `0.1.5-rc.2` 与 app 内置 `0.2.2-rc.1`，已移除前者；两者版本不一致还会导致事件格式/凭据行为差异。
- app 内置 CLI 的 `headless`（`--json`）在独立 CLI 进程下可能读不到 GUI credentials service（`MISSING_CREDENTIAL`），所以 macOS 上优先 `sdk` 后端。
- 结论：macOS 上 `DSH_MCP_BACKEND=sdk` + `DSH_MCP_DSH_COMMAND` 指向 wrapper（内部 exec app 内置 CLI）。

迁移步骤（保留在用版作为回滚）：

1. 备份 Codex 配置：`cp ~/.codex/config.toml ~/.codex/config.toml.bak-before-dsh-mcp-worker`
2. 构建本仓库：
   ```bash
   cd ~/workspace/code/github/dsh-mcp-worker
   pnpm install && pnpm build
   ```
2.5. 创建 app 内置 CLI 的无空格入口 wrapper（macOS；路径按本机替换）：
   ```bash
   printf '#!/bin/sh\nexec "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" "$@"\n' > ~/scripts/dsh-app-cli.sh
   chmod +x ~/scripts/dsh-app-cli.sh
   ~/scripts/dsh-app-cli.sh --version   # 应输出版本号（如 0.2.2-rc.1）
   ```
3. 把 `~/.codex/config.toml` 的 `[mcp_servers.dsh-worker]` 指到本仓库构建产物（或 pnpm 全局包入口），并补上 sdk 后端与白名单（路径按本机替换）：
   ```toml
   [mcp_servers.dsh-worker]
   command = "/Users/<you>/.nvm/versions/node/v24.19.0/bin/node"
   args = ["/Users/<you>/.../dsh-mcp-worker/dist/index.js"]
   cwd = "/Users/<you>"
   enabled = true
   startup_timeout_sec = 60
   tool_timeout_sec = 1800
   default_tools_approval_mode = "approve"

   [mcp_servers.dsh-worker.env]
   HOME = "/Users/<you>"
   DSH_HOME = "/Users/<you>/.dsh"
   DSH_MCP_BACKEND = "sdk"
   DSH_MCP_DSH_COMMAND = "/Users/<you>/scripts/dsh-app-cli.sh"
   DSH_MCP_DSH_PATCH = "off"
   DSH_MCP_ALLOWED_ROOTS = "/Users/<you>"
   DSH_MCP_MAX_CONCURRENT = "4"
   DSH_MCP_TIMEOUT_S = "1800"
   PATH = "/Users/<you>/.nvm/versions/node/v24.19.0/bin:/Users/<you>/Library/pnpm/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
   ```
4. 重启 Codex / ChatGPT 桌面 app（MCP 工具目录在握手时协商），先在会话里调用 `dsh_describe` / `dsh_usage` 验证，再跑一个真实任务。
   也可不挂载直接自检：
   ```bash
   printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    | DSH_MCP_BACKEND=headless node dist/index.js 2>/dev/null | tail -1 | head -c 400
   ```
5. 回滚：还原第 1 步的配置备份并重启 leader 即可。

> 两版可并存对比（用不同的 MCP server 名）；它们的任务目录互不冲突（在用版 `~/.dsh-mcp/jobs` vs 本仓库 `$DSH_HOME/mcp-tasks`）。

## 通过 npm 使用

包名：`dsh-mcp-worker`（只发布构建产物；本机仍需安装 DSH）。

```powershell
npm i -g dsh-mcp-worker      # 或直接用 npx
npx -y dsh-mcp-worker        # 由 MCP 客户端拉起（stdio）
```

MCP 客户端配置可用：

```json
{
  "mcpServers": {
    "dsh": { "command": "npx", "args": ["-y", "dsh-mcp-worker"] }
  }
}
```

注意：npm 包**不包含 DSH 本体**；worker 通过 `dsh`（PATH）、`DSH_MCP_DSH_DIR` 或 `DSH_MCP_DSH_CLI` 找到本机 DSH。

## 接入 leader

### 1) Claude Code（最省事）

```powershell
claude mcp add --scope user --transport stdio dsh -- node "C:\path\to\dsh-mcp-worker\dist\index.js"
claude mcp list
claude mcp get dsh
```

带环境变量时注意 `--env` 的位置（放在 server 名之前）：

```powershell
claude mcp add --scope user --transport stdio --env DSH_MCP_DEFAULT_CWD="D:\work\repo" dsh -- node "C:\path\to\dsh-mcp-worker\dist\index.js"
```

等价 `.mcp.json` 见 [examples/claude-mcp.json](examples/claude-mcp.json)。

**避免每次弹授权**：把 dsh 工具加入用户级 allowlist（`~/.claude/settings.json` 的 `permissions.allow`）：

```json
["mcp__dsh__dsh_run", "mcp__dsh__dsh_status", "mcp__dsh__dsh_result", "mcp__dsh__dsh_cancel", "mcp__dsh__dsh_describe",
 "mcp__dsh__dsh_tasks", "mcp__dsh__dsh_audit", "mcp__dsh__dsh_read_result", "mcp__dsh__dsh_batch_run",
 "mcp__dsh__dsh_batch_status", "mcp__dsh__dsh_batch_result", "mcp__dsh__dsh_search", "mcp__dsh__dsh_metrics",
 "mcp__dsh__dsh_usage"]
```

> 本机已写入（备份 `settings.json.bak-dsh-allow-20261102`）。安全边界仍由 worker 的 `permission_mode` / 审批桥承担。

### 2) Codex CLI / IDE

把下面加到 `~/.codex/config.toml`（完整示例见 [examples/codex-config.toml](examples/codex-config.toml)）：

```toml
[mcp_servers.dsh]
command = "node"
args = ["C:\\path\\to\\dsh-mcp-worker\\dist\\index.js"]
startup_timeout_sec = 30          # 默认 10；worker 自身启动很快，留余量
tool_timeout_sec = 300            # 默认 60；allow dsh_status 长轮询（wait_s≤120s）
enabled_tools = ["dsh_run", "dsh_status", "dsh_result", "dsh_cancel", "dsh_describe", "dsh_tasks", "dsh_audit", "dsh_read_result", "dsh_batch_run", "dsh_batch_status", "dsh_batch_result", "dsh_search", "dsh_metrics", "dsh_usage"]
# approve = 不再询问（auto 仍会按风险询问）；安全边界由 worker 的 permission_mode（默认 workspace-write）兜底
default_tools_approval_mode = "approve"

# 桌面端对 MCP 工具的审批可被 per-tool 覆盖（14 个工具都要写）
[mcp_servers.dsh.tools.dsh_run]
approval_mode = "approve"
# ……其余工具同理：dsh_status / dsh_result / dsh_cancel / dsh_describe / dsh_tasks / dsh_audit /
# dsh_read_result / dsh_batch_run / dsh_batch_status / dsh_batch_result / dsh_search / dsh_metrics / dsh_usage

[mcp_servers.dsh.env]
DSH_MCP_DEFAULT_CWD = "C:\\path\\to\\your\\project"
```

校验：`codex mcp get dsh`（本机已配置为 `default_tools_approval_mode: approve` + per-tool `approve`；改前备份 `config.toml.bak-dsh-approve-20261102`）。改完需**完全退出并重开** Codex/ChatGPT 桌面 app，配置在 app 启动时加载。

### 3) ChatGPT 桌面 app

调研显示 ChatGPT 桌面 app、Codex CLI、IDE 扩展**共享同一份** `~/.codex/config.toml`，所以按上面 Codex 的配置配好后重启桌面 app 即可使用（**未实测**，若无效请反馈）。

### 4) ChatGPT web（后置）

ChatGPT web 只接受**远程 MCP**（Streamable HTTP / SSE），不接受 stdio。两条路：

- **推荐**：OpenAI Secure MCP Tunnel（需要 Platform 组织 + `tunnel_id` + runtime API key）：
  ```bash
  tunnel-client init --sample sample_mcp_stdio_local --profile dsh-local \
    --tunnel-id tunnel_xxxxxxxx --mcp-command "node C:\\path\\to\\dsh-mcp-worker\\dist\\index.js"
  tunnel-client run --profile dsh-local
  ```
  然后在 ChatGPT → Plugins → `+` → Add custom MCP server → Connection 选 Tunnel → Create。
  注意 Tunnel 硬限制：**单请求 120s / 10 MiB / 600 rpm**，所以必须用本 worker 的异步任务模型（`run` 立即返回 + 轮询）。
- 或自建 HTTPS + OAuth 2.1（工作量大，暂未实现）。

### 5) Claude Desktop（本地 MCPB）

模板见 [examples/mcpb-manifest.json](examples/mcpb-manifest.json)。需要把 `dist/` 与 `node_modules` 一起打包进 MCPB 扩展，用 `mcpb pack` 生成 `.mcpb` 后拖入 Claude Desktop（**未实测**）。

## 工具面

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `dsh_run` | 提交任务，**立即**返回 `task_id` | `task`（必填）、`cwd`（必填，项目目录）、`session_id?`、`permission_mode?`、`timeout_s?`、`idempotency_key?` |
| `dsh_status` | 查状态 + 有界事件摘要；默认 `detail=summary` 只回状态/异常事件 + `last_text`，`detail=events` 回全部事件；终态带 `outcome` | `task_id`、`cursor?`、`wait_s?`、`detail?`（summary/events） |
| `dsh_result` | 取最终结果；验收优先看 `evidence`（命令退出码/变更文件/diff 摘要）与 `outcome`，`output` 是 DSH 叙述；传 `offset/max_chars` 可直接分页续读 | `task_id`、`offset?`、`max_chars?` |
| `dsh_cancel` | 取消任务（杀进程树） | `task_id` |
| `dsh_tasks` | 列出最近任务摘要（回顾/继续轮询） | `limit?`（1–100）、`status?` |
| `dsh_audit` | 读取审计事件（任务生命周期/审批决定） | `limit?`（1–200） |
| `dsh_read_result` | 分页读取落盘产物 | `task_id`、`source?`（result/events/diff/evidence）、`offset?`、`max_chars?` |
| `dsh_batch_run` | 批量并行派发（每项可带 cwd/session/权限） | `tasks[]`（1–`maxBatchTasks`） |
| `dsh_batch_status` | 批量聚合状态（整体状态 + 子任务 + 计数） | `batch_id`、`wait_s?` |
| `dsh_batch_result` | 批量聚合结果（输出/错误/耗时） | `batch_id`、`max_output_chars?` |
| `dsh_search` | 在历史任务的输出与工具结果里检索 | `query`、`limit?` |
| `dsh_metrics` | 计数/耗时分位/排队/后端/OTel 状态 + token 与估算费用汇总 | — |
| `dsh_usage` | 按时间窗口聚合用量与费用（任务数/状态/耗时/DSH token/估算费用，按 cwd 分布） | `days?`（1–90）、`cwd?` |
| `dsh_describe` | 返回入口/默认值/限制，供 leader 自适应 | — |

典型调用序列（leader 视角）：

```jsonc
// 1) 提交
{ "name": "dsh_run", "arguments": { "task": "修复 utils.ts 的空指针，并跑 pnpm test 验证", "cwd": "D:\\work\\repo" } }
// → { task_id, status: "queued", session_id, cwd, hint }

// 2) 轮询（每次最多等 25s；运行中会收到 notifications/progress）
{ "name": "dsh_status", "arguments": { "task_id": "...", "cursor": 0, "wait_s": 20 } }

// 3) 结束后取结果
{ "name": "dsh_result", "arguments": { "task_id": "..." } }
```

状态机：

```
queued ──▶ running ──▶ succeeded
   │           ├──▶ failed（超时/DSH 报错）
   │           ├──▶ cancelled
   └──▶ 不会出现：被取消的排队任务会直接 cancelled
```

多轮续聊：把首次 `dsh_run` 返回的 `session_id` 传给下一次 `dsh_run`；**同一 session 的任务串行执行**（DSH 侧单写者），不同 session 并行（受 `DSH_MCP_MAX_CONCURRENT` 限制）。

## 让 leader 主动委派（可选，推荐）

MCP 只把工具摆给 leader，**是否调用由 leader 模型自己决定**，协议层无法强制。想提高“自动委派”概率，三档手段（从弱到强）：

1. **工具描述/instructions**（已内置）：`dsh_run` 描述与 server `instructions` 写明「一个任务 = 一个可验收工作单元（实现+自测+证据）；禁止微任务；长轮询 60–120s」——**这是 ChatGPT web / Claude Desktop 等远程 leader 唯一可用的杠杆**。
2. **指令文件**（本地 leader 有效）：
   - Claude Code：`~/.claude/CLAUDE.md`（本机通过 `@~/AGENTS.md` 引用）；
   - Codex：`~/.codex/AGENTS.md`（全局）；或项目内 `AGENTS.md`（就近生效）。
   本机已写入「粗粒度委派」规则（`AGENTS.md.bak-dsh-coarse-20261102` 为改前备份）。
3. **Hook**（仅 Claude Code 等支持 hook 的 host）：UserPromptSubmit 每次注入提醒，最稳但配置成本最高。

> 注意：远程 leader（ChatGPT web / Claude Desktop）读不到本地指令文件，只能靠第 1 条 + 用户明说「用 dsh 跑」。

### 粒度怎么定（关键）

- 一个 `dsh_run` 覆盖「定位 → 实现 → 自测 → 证据」，典型：一个功能点 / 一个 bug / 一个测试修复批次 / 一次跨文件重构；
- 少于 3 次工具调用或 2 分钟内能做完的事，leader 自己做；不要拆成多个 dsh 任务；
- 只有独立可并行（用 `dsh_batch_run`）、需要决策、风险隔离时才拆分；
- 轮询用 `dsh_status(wait_s=60~120)`，不要在 DSH 执行期间重复劳动；
- 详细模板、反例/正例、验收动作、如何用 `scripts/leader-usage.mjs` 验证：[docs/delegation-playbook.md](docs/delegation-playbook.md)。

## 目标达成率测量（leader 提速 / 省 token）

目标前提：Codex/ChatGPT、Claude Code 作为 leader，通过本 worker 把重活交给 DSH。核对方式：**同任务 A/B 对照**（leader 自己做 vs 委派 DSH）。

```powershell
# A/B 对照（会真实消耗 leader 额度；只读分析类任务最安全）
pnpm measure:ab -- --cwd D:\work\repo --task "统计 src 下 ts 文件数量并列出最大的 3 个（只读分析）" --runs 3 --expect "src"

# 持续观察 leader 自己的会话用量（不跑基准）
pnpm measure:leader -- --since-hours 24
```

报告包含：加速比、leader token 节省率、cost 节省率、正确性守门、DSH token、`DSH token / 省下 leader token`，以及**目标达成率 x/2 或 x/3**。

- 口径/公式/协议/局限：[docs/measurement.md](docs/measurement.md)
- 真实首测（单样本，任务：统计 src 下 ts 文件并列出最大 3 个）：**加速 2.29x、leader token 省 46.0%、cost 省 31.1%、达成率 2/2**；报告样例在 `measure-runs/report-*.md`。
- leader token 来自 Claude Code `-p --output-format json` 的 `usage/cost`；Codex 用 `scripts/leader-usage.mjs` 从 rollout 聚合；ChatGPT web 无本地计量（见文档局限）。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_MCP_TRANSPORT` | `stdio` | MCP 传输：`stdio`（本地 leader）/ `http`（Streamable HTTP，远程 leader） |
| `DSH_MCP_HTTP_HOST` | `127.0.0.1` | HTTP 监听地址；`0.0.0.0` 时必须设 token |
| `DSH_MCP_HTTP_PORT` | `7391` | HTTP 端口（`0` = 随机） |
| `DSH_MCP_HTTP_TOKEN` | 无 | HTTP Bearer token；非回环地址必填 |
| `DSH_MCP_DSH_CLI` | 自动探测 | `@deepseek-ai/dsh/lib/bin.js` 的绝对路径（用 `node` 启动，最稳） |
| `DSH_MCP_DSH_COMMAND` | — | 完整命令（如 `dsh`），通过 shell 启动；优先级低于 `DSH_MCP_DSH_CLI` |
| `DSH_MCP_DSH_DIR` | — | DSH 安装目录（自动拼 `node_modules/@deepseek-ai/dsh/lib/bin.js`） |
| `DSH_MCP_PROFILE` | `headless` | `headless` 后端使用的 profile |
| `DSH_MCP_BACKEND` | `sdk` | 执行后端：`sdk`（长驻，默认）/ `headless`（每任务一进程） |
| `DSH_MCP_SDK_PROFILE` | `sdk` | 长驻后端使用的 DSH profile |
| `DSH_MCP_SDK_PROVIDER` | `deepseek-official` | SDK 后端 provider |
| `DSH_MCP_SDK_MODEL` | `deepseek-flash` | SDK 后端 model（进程级固定） |
| `DSH_MCP_SDK_REASONING_EFFORT` | 无 | 推理强度（可选，如 `max`） |
| `DSH_MCP_SDK_MAX_TOKENS` | 无 | 单次输出 token 上限（可选） |
| `DSH_MCP_SDK_IDLE_MIN` | `10` | 后端空闲多少分钟回收（1–240） |
| `DSH_MCP_SDK_INIT_TIMEOUT_S` | `300` | 后端 initialize 超时（秒）；失败自动重试 1 次，仍失败则自动降级 headless |
| `DSH_MCP_DEFAULT_CWD` | 无 | 省略 `cwd` 时使用；没设则用 worker 进程 cwd（stdio 启动时通常是 leader 的项目目录） |
| `DSH_MCP_ALLOWED_CWDS` | 无 | 分号分隔的允许目录白名单（设置后只能在这些目录下跑） |
| `DSH_MCP_ALLOWED_ROOTS` | 无 | **兼容旧版 bridge** 的允许目录写法（平台分隔符：POSIX `:`、Windows `;`）；`DSH_MCP_ALLOWED_CWDS` 优先 |
| `DSH_MCP_PERMISSION_MODE` | `auto` | 默认 `auto`（worker 按 cwd 能力自动适配）；也可显式 `read-only` / `workspace-write` / `danger-full-access` |
| `DSH_MCP_TIMEOUT_S` | `1800` | 单任务默认超时（秒）；旧默认 900s 实测偏小（v0.10.0 起改 1800） |
| `DSH_MCP_MAX_CONCURRENT` | `2` | 全局并发任务上限（1–8，另受同 session 串行约束） |
| `DSH_MCP_MAX_CONCURRENT_PER_CWD` | `1` | 同一 **git 仓库根**（含子目录/worktree 任务）的并发上限；非 git 目录回退按 cwd 计（防止单项目占满） |
| `DSH_MCP_TASK_TTL_MIN` | `1440` | 已结束任务保留分钟数，超时自动清理 |
| `DSH_MCP_TASK_MAX` | `500` | 任务数上限；超额先淘汰最老的已结束任务 |
| `DSH_MCP_CLEANUP_INTERVAL_MIN` | `10` | 自动清理间隔（分钟） |
| `DSH_MCP_AUDIT_DIR` | `$DSH_HOME/mcp-audit` | 审计日志目录（`audit.jsonl`） |
| `DSH_MCP_BATCH_DIR` | `$DSH_HOME/mcp-batches` | 批量任务元数据目录 |
| `DSH_MCP_BATCH_MAX` | `8` | 单次批量提交的最大任务数（1–32） |
| `DSH_MCP_OTEL_ENDPOINT` | 无 | OTLP/HTTP traces 端点（如 `http://127.0.0.1:4318/v1/traces`）；空 = 关闭 |
| `DSH_MCP_OTEL_SERVICE` | `dsh-mcp-worker` | OTel `service.name` |
| `DSH_MCP_DSH_PATCH` | `apply` | DSH 兼容补丁：`apply`（启动时自动检测+修复①pwsh 编码前缀 ②输出 GBK 兜底解码）/ `notify` / `off` |
| `DSH_MCP_ACL_FALLBACK` | `danger-full-access` | workspace-write ACL 失败后的目标模式：`danger-full-access`（第二级升级）/ `read-only` / `off`。执行顺序固定为「原目录 workspace-write → worktree workspace-write → 目标模式」，每级失败都会重新判定 |
| `DSH_MCP_ACL_FAIL_FAST` | `1` | 首条命令 ACL 失败即立即中止当前 attempt（不再等模型空转/长超时），进入降级决策 |
| `DSH_MCP_ALLOW_FULL_ACCESS_FALLBACK` | `1` | 是否允许自动升级 `danger-full-access`；**发布给他人使用建议设 `0`**（保持 fail-closed，由 leader 显式选择）；`read-only` 降级不受影响 |
| `DSH_MCP_STATUS_WAIT_MAX_S` | `120` | `dsh_status` 单次长轮询等待上限（秒，5–600）；调大可减少 leader 轮询次数 |
| `DSH_MCP_MAX_TASK_TOKENS` | `0` | **暂缓启用**：单任务 DSH token 预算，默认 `0`=不限制、不产生任何行为。实现已完成但按当前决定不开启；待积累 ≥20 条成功任务后，再按任务类型 p90×1.5 校准并启用（`totalTokens` 94–98% 是 cacheRead，若控成本需另按 input+output 折算） |
| `DSH_MCP_CAPABILITY_CACHE` | `1` | cwd 能力缓存（落盘，auto 模式据此选权限模式），跨 worker 进程；同时记录「worktree 根 ACL 不可用」，避免同 root 反复创建+失败 |
| `DSH_MCP_CAPABILITY_TTL_H` | `24` | cwd / worktree 根能力缓存 TTL（小时）；修好 ACL 后等 TTL 过期或删缓存文件即可重新尝试 worktree |
| `DSH_MCP_RETRY_TRANSIENT` | `1` | 后端崩溃/初始化失败时自动重试一次 |
| `DSH_MCP_AUTO_WORKTREE` | `1` | ACL 受限仓库自动创建可写 worktree（仅干净 git 仓库）。**worktree 根目录必须对当前用户完全控制**，否则 worktree 同样会 ACL 失败 |
| `DSH_MCP_WORKTREE_ROOT` | `~/dsh-worktrees` | 自动 worktree 根目录；不要指向 ACL 受限的盘/目录（如企业仓库所在的受限 D 盘），默认的用户主目录满足 |
| `DSH_MCP_WORKTREE_CLEANUP` | `1` | 终态任务过期后自动 `git worktree remove/prune`（不影响任务证据 `diff.patch`） |
| `DSH_MCP_WORKTREE_TTL_MIN` | `1440` | worktree 保留时长（分钟），超时由清理任务移除 |
| `DSH_MCP_NOTIFY_WEBHOOK` | 无 | 任务结束 POST 通知（JSON） |
| `DSH_MCP_NOTIFY_CMD` | 无 | 任务结束执行命令（`DSH_MCP_NOTIFY_JSON` 环境变量传事件） |
| `DSH_MCP_MAX_RESULT_CHARS` | `40000` | 结果超长时落盘阈值 |
| `DSH_MCP_IDEM_TTL_H` | `24` | 幂等键有效期（小时，0 = 永不过期）；`dsh_run(idempotency_key)` 重试去重 |
| `DSH_MCP_IDEM_DIR` | `$DSH_HOME/mcp-idem` | 幂等键索引落盘目录 |
| `DSH_MCP_PRICE_INPUT_PER_MTOK` | `0.28` | 费用估算：输入 token 单价（美元/百万 token） |
| `DSH_MCP_PRICE_CACHE_READ_PER_MTOK` | `0.028` | 费用估算：cacheRead 单价（美元/百万 token） |
| `DSH_MCP_PRICE_OUTPUT_PER_MTOK` | `0.42` | 费用估算：输出 token 单价（美元/百万 token） |
| `DSH_MCP_USD_CNY` | `6.65` | 费用估算展示用美元兑人民币汇率 |
| `DSH_MCP_MAX_STATUS_EVENTS` | `100` | 单次 `dsh_status` 最多返回多少条事件（仍受字节预算限制） |
| `DSH_MCP_MAX_STATUS_PAYLOAD_BYTES` | `16384` | 单次 `dsh_status` 结构化载荷（JSON）的 UTF-8 字节上限；超出时只返回能放下的摘要并标记 `events_truncated` |
| `DSH_MCP_EVIDENCE_GIT` | `1` | 是否采集 git 证据（status/diff 摘要 + diff.patch）；置 0 关闭 |
| `DSH_MCP_REPORT_PROTOCOL` | `1` | 是否向任务文本注入 `[DSH:NEEDS_DECISION]` 汇报协议页脚 |
| `DSH_MCP_STATUS_DETAIL` | `summary` | `dsh_status` 默认 detail；置 `events` 回退到旧行为 || `DSH_MCP_TASKS_DIR` | `$DSH_HOME/mcp-tasks` | 任务落盘根目录 |
| `DSH_HOME` | `~/.dsh` | DSH 状态目录（会透传给子进程） |

权限模式说明（DSH 侧行为）：
- `read-only`：只读任务；
- `workspace-write`（默认）：项目目录内可读写、可跑命令；越界/提权操作会被 DSH 审批 **fail-closed 拒绝**（headless 没有审批通道）；
- `danger-full-access`：全权，谨慎使用（只在明确信任的任务上开）。

## 任务落盘与恢复

```
$DSH_HOME/mcp-tasks/<task_id>/
  meta.json      状态、cwd、session、退出码、错误（含 usageTokens 与幂等键）
  events.jsonl   DSH --json 事件流（追加写）
  result.txt     输出超长时的完整结果
$DSH_HOME/mcp-idem/
  idem-<key-hash>.json   幂等键 → task_id 索引（默认保留 24h）
```

审计日志（append-only，独立于任务目录）：`$DSH_HOME/mcp-audit/audit.jsonl`，记录 `task_created` / `task_started` / `task_succeeded|failed|cancelled` / `approval_*`；可用 `dsh_audit` 查询。

worker 重启时，未完成的 `queued/running` 任务会被标记为 `failed`（`interrupted: worker restarted before the task finished`），不会假装成功。

## 安全模型

- **只走 stdio 或显式 HTTP**：默认 stdio 不监听端口；HTTP 模式必须 Bearer token（`0.0.0.0` 无 token 直接拒绝启动）。
- **cwd 校验**：拒绝用户主目录及其祖先目录（Windows ACL 沙箱会让 shell 工具不可用），可加 `DSH_MCP_ALLOWED_CWDS` 白名单。
- **默认 fail-closed**：无人值守没有审批通道（两种后端一致），需要审批的操作一律拒绝，不会静默放权。
- **取消即杀进程树**（Windows `taskkill /T /F`），避免僵尸 DSH。
- **输出有界**：超长结果落盘，避免撑爆 leader 上下文。

## 已知限制

1. **冷启动**：`sdk` 后端首次任务支付一次 initialize（本机实测 7–30s，随机器负载波动），之后每任务只付模型时间（实测 3s 级）；`headless` 后端每任务 4–11s（fallback）。initialize 超时默认 300s，失败自动重试 1 次；仍失败则**自动降级 headless** 重跑同一任务（避免 leader 直接看到一次失败）。
2. **sdk 后端没有 cancel 协议**：`dsh_cancel` 等价于杀掉该 cwd 的后端进程，下次任务自动重建（已实测）；同一 cwd + 权限模式共享一个后端。
3. **sdk 后端模型/权限是进程级**：模型由 `DSH_MCP_SDK_MODEL` 固定；不同 `permission_mode` 会走不同后端进程。
4. **session_id 复用**仅在同一个后端进程生命周期内可靠；进程被回收/杀掉后同 id 行为未验证。
5. `--json` 事件流对非 `final` 字段有 8 KiB / 32 KiB 截断，`final` 无损；完整轨迹看 `events.jsonl`。
6. 同一 `session_id` 只能串行；并发续聊需拆成不同 session。
7. Progress 通知依赖 leader 传 `progressToken`；不传时只是没有进度事件，不影响任务。
8. **HTTP 模式是无状态的**：每个请求独立创建 server/transport，不做 MCP 会话；进度通知只在单次请求的 SSE 流内有效。
9. **任务会被自动清理**：超过 `DSH_MCP_TASK_TTL_MIN` 的已结束任务（含落盘目录）会被删除，之后查询返回 `task_not_found`。
10. **授权弹窗由 leader 侧配置决定**：Codex/ChatGPT 的「不询问」值是 **`approve`**（`auto` 仍会按风险询问；`writes` 只对写工具询问；`prompt` 全问），建议 `default_tools_approval_mode = "approve"` + 每个工具的 `[mcp_servers.dsh.tools.<tool>] approval_mode = "approve"`，并**完全退出重开 app**；Claude Code 用 `permissions.allow`。桌面端另有已知 bug（openai/codex#40793、#20289：部分版本线程内仍每次询问、忽略 approval_mode），遇到底座 bug 只能点「始终允许」、升级 app 或改用 Claude Code/CLI。关闭逐次确认后安全边界由 worker 的 `permission_mode`（默认 workspace-write）与审批桥 fail-closed 兜底。
11. **initialize 偶发卡顿**：initialize 正常 7–30s；曾出现 >120s 超时（旧默认值）导致任务失败，现已改为 300s + 重试 + headless 降级，并在错误里带 stderr 证据。
12. **Windows ACL 沙箱要求目录为「完全控制」**：DSH 的 workspace-write 会给工作目录写能力 SID + Low 标签，要求调用方对目录拥有完全控制（含 WRITE_OWNER）；公司仓库常见继承 ACL 只有 Modify → `SetNamedSecurityInfoW failed (Win32 5)`。v0.9.2 起降级链为「原目录 workspace-write → worktree workspace-write → `DSH_MCP_ACL_FALLBACK`」：首条 ACL 失败即 **fail-fast** 中止，worktree 再失败会 **二次升级**；结果里 `attempts` / `sandbox_blocked(_detail)` / `sandbox_fallback` / `effective_permission_mode` 显式记录，绝不静默假成功。**worktree 根目录本身也必须完全控制**（2026-11-10 真实任务因 `D:\work\worktrees\dsh` 只有 Modify 而空转，已由 fail-fast + 二次升级修复）；可用 `DSH_MCP_ACL_FALLBACK=read-only|off` 收紧。
13. **自动升级的 full access 无沙箱**：任务在 `danger-full-access` 下可读写当前用户能访问的任意路径；这是为「调用简单」有意选择的 B 方案，请配合 `DSH_MCP_ALLOWED_CWDS` 限定目录、审计日志与 git 回滚使用；高敏感仓库建议用 `read-only` 或 `off`。
10. **审计日志无轮转**：`audit.jsonl` 持续追加，长期使用需自行归档/切割。
11. **ChatGPT 直连未打通**：需要 Secure MCP Tunnel（无配额未实测）或自建 HTTPS + OAuth 2.1（OAuth 未实现）；本地 HTTP + Bearer 给不了 ChatGPT。
12. **审批桥 v0 是粗粒度**：只做「检测审批阻断 → elicitation 询问 → 整任务以 danger-full-access 重试」，且真实 DSH 审批场景尚未端到端实测。
13. **批量/检索的边界**：批量元数据（`batch_id → task_ids`）落盘可跨重启，但子任务本身仍受 TTL 清理；`dsh_search` 只扫内存中保留的任务（被清理的历史任务搜不到）。
14. **OTel 是轻量实现**：不引 OTel SDK，只把**每个任务的 span** 以 OTLP/HTTP JSON 推送（best-effort，3s 超时）；指标是 `dsh_metrics` 拉取式快照，未做 OTLP metrics 推送。
15. **read-only 下的 pwsh 编码问题（已自动双层修复）**：DSH 的 `dsh-pwsh-local` 会给每条命令前缀 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`；read-only 的 Windows ACL 沙箱以 **ConstrainedLanguage** 启动 pwsh，构造 .NET 类型被拒 → 每次调用两条 `InvalidOperation: 无法创建类型…`。跳过该前缀后，无控制台 spawn 的 pwsh 又会按系统代码页（GBK）写 stdout/stderr，而 DSH 固定按 UTF-8 解码 → 中文输出/错误乱码。worker 启动时自动修两层：① 前缀改为仅非 ConstrainedLanguage 执行；② `dsh-subprocess-local` 的输出解码改为「UTF-8 严格解码失败 → GBK 兜底」（合法 UTF-8 输出不受影响）。均带备份、幂等；DSH 升级后下次启动自动重打。可用 `DSH_MCP_DSH_PATCH=notify|off` 关闭自动修复，手动脚本见 `scripts/patch-dsh-pwsh-encoding.ps1` 与 `scripts/patch-dsh-output-decoding.ps1`。
16. ChatGPT web / Claude Desktop 两条远程/打包路径尚未实测。
17. **续聊 session 不能跨后端恢复（已自动恢复）**：DSH SDK 协议只有 `initialize/session/prompt/shutdown`，没有 resume/restore；worker 重启或后端重建后用旧 session id 续聊会报 `session "..." already exists`。worker 自动换新 session id 重试一次，并把上一轮任务/结果摘要作为「续聊上下文」拼进新指令（事件 `session_resume_fallback` 可见；结果里的 `session_id` 是新 id）。同一后端存活时则正常续聊、不触发恢复。
18. **长任务空闲回收（v0.6.5 已修）**：此前 `sweep()` 只看 `lastUsedAt`，运行超过 10 分钟的任务会被回收杀掉（真实 11 分钟任务、13.3M token 沉没）；现在有 in-flight prompt 的后端不会被回收，任务结束刷新时间。
19. **read-only 的 ACL 误判（v0.6.5 已修）**：此前只要事件/最终文本里出现 `SetNamedSecurityInfoW` 就会被当作写沙箱失败，导致已产出完整报告的只读任务被标 failed；现在仅「非 read-only 模式 + tool_result.isError」才判定。
20. **token 预算默认关闭**：`DSH_MCP_MAX_TASK_TOKENS=0`；建议真实使用设 3M–8M，防止单个失控任务烧掉大量额度。超限任务会被取消并标 failed（不是用户取消），事件流有 `token_budget_exceeded`。
21. **自动 worktree 只对干净 git 仓库生效**：有未提交改动/非 git 仓库不会复制（直接进入 ACL 降级链的下一级）。worktree 默认按 `DSH_MCP_WORKTREE_TTL_MIN`（24h）自动 `git worktree remove/prune`；清理前如需合入，用 `dsh_result.worktree` 路径审查，`diff.patch` 证据不受清理影响。
22. **完成通知是外部通道**：MCP 协议无法主动唤醒空闲 leader；`DSH_MCP_NOTIFY_WEBHOOK`/`NOTIFY_CMD` 用于 webhook/桌面通知，未配置时不发通知。
23. **发布/外部用户建议**：设 `DSH_MCP_ALLOW_FULL_ACCESS_FALLBACK=0` 保持 fail-closed；确认 `DSH_MCP_WORKTREE_ROOT` 位于用户完全控制目录；ACL 失败时 `dsh_result.failure_kind=sandbox_acl` + `sandbox_blocked_detail` 会给出 icacls / 换 worktree root / 显式传 `permission_mode` 三种修法。
24. **worktree 改动不会自动合入（v0.9.4）**：`dsh_result.merge_hint` 给出 `base_commit` / `patch_path` / 可直接执行的 `apply_command` 与审阅提示；先 `dsh_read_result(source=diff)` 审阅（patch 可能含 `.dsh-*` 探针文件与二进制占位），确认后再执行 apply。并发配额自 v0.9.4 起按 **git 仓库根** 计（同仓库子目录任务串行，非 git 目录按 cwd）。

## 排错

| 现象 | 处理 |
|---|---|
| leader 里工具列表没有 dsh_* | 检查命令路径、`node` 版本（需 ≥20）；Claude Code 用 `claude mcp get dsh` 看状态与日志 |
| `DSH worker 错误 [invalid_cwd]` | 传具体项目目录；不要用 `C:\Users\<user>` 这类主目录 |
| `DSH worker 错误 [task_not_finished]` | 任务还没结束：先 `dsh_status` 轮询到终态，再 `dsh_result` |
| 任务 `failed` 且 error 提到 approval | 当前任务需要审批（如写工作区外）：换 `permission_mode=danger-full-access` 或把操作限定在 cwd 内 |
| Codex/ChatGPT 桌面端每次调用仍弹授权 | 确认 `config.toml` 中是 `default_tools_approval_mode = "approve"`（不是 `auto`）+ 13 个 per-tool `approve`，并**完全退出重开 app**；仍复现则是桌面端已知 bug（openai/codex#40793），可点「始终允许」、升级 app，或改用 Claude Code / `codex exec`（CLI 尊重配置） |
| `read-only` 任务中文输出乱码 / stderr 出现 `InvalidOperation: 无法创建类型…` | worker 启动时自动修复两层（前缀 + GBK 兜底解码）；若调成 `notify/off`，手动跑 `scripts/patch-dsh-pwsh-encoding.ps1` 和 `scripts/patch-dsh-output-decoding.ps1` |
| 任务报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)` | 该目录 ACL 只有 Modify（常见于公司仓库）：worker 默认自动升级 `danger-full-access` 重试，结果里 `sandbox_fallback`/`effective_permission_mode` 可见；不想用全权则设 `DSH_MCP_ACL_FALLBACK=read-only` 或 `off` |
| 续聊报 `session "..." already exists` | 正常降级路径：worker 自动换新 session id + 带上本地「续聊上下文」重试（事件 `session_resume_fallback`），无需手动处理；若任务需要严格原会话历史，请在同一 worker 进程/后端存活期内续聊 |
| 找不到 DSH 入口 | 设 `DSH_MCP_DSH_CLI=D:\dsh-harness\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| 想看真实参数/限制 | 调 `dsh_describe` |

## 开发

```
src/
  index.ts         stdio 入口（生产环境装配）
  server.ts        MCP 工具注册（14 个工具 + instructions）
  task-manager.ts  异步任务：排队/并发/session 串行/每仓库配额/TTL 清理/状态机/长轮询/恢复/审计
  dsh-runner.ts    headless 后端：spawn dsh、NDJSON 解析、超时、杀进程树、stderr 尾部
  sdk-backend.ts   sdk 后端：长驻进程、initialize、prompt、session.event 映射、取消=杀进程
  sdk-pool.ts      按 cwd + 权限模式缓存后端，空闲回收
  sdk-runner.ts    用长驻后端实现 TaskRunner
  fallback-runner.ts  sdk 启动失败时自动降级 headless（仅基础设施失败触发）
  sandbox-errors.ts  Windows ACL 沙箱失败识别（grantWrite Win32 5）与降级判定/提示
  jsonrpc-line.ts  换行 JSON-RPC 客户端（请求/通知/超时/关闭）
  http-server.ts   Streamable HTTP 传输（无状态、Bearer、/healthz）
  approval.ts      审批阻断检测（供 dsh_result 的审批桥使用）
  audit.ts         append-only 审计日志（JSONL）
  artifacts.ts     任务产物的安全分页读取（dsh_read_result）
  evidence.ts      从事件提取结构化证据：命令退出码/标记/编辑聚合（预算内）
  git-evidence.ts  git 基线/变更文件/diff.patch 采集（超时与失败不影响任务）
  report-protocol.ts 汇报协议页脚注入 + [DSH:NEEDS_DECISION] 检测  batch-manager.ts 批量任务（fan-out）：创建、聚合状态/结果、取消
  search.ts        历史任务内容检索（输出 + 工具结果）
  otel.ts          轻量 OTLP/HTTP span 导出（无 SDK 依赖）
  usage.ts         DSH token 用量提取/累加（headless step_end 与 sdk assistant/message）
  pricing.ts       DeepSeek 单价与费用估算（USD/CNY，v0.10.0 合并自在用版 bridge）
  usage-report.ts  用量/成本聚合（dsh_usage 工具，按天/按 cwd）
  idempotency.ts   幂等键落盘索引（dsh_run idempotency_key 去重）
  dsh-patch.ts     DSH 兼容补丁：启动时检测/修复 pwsh 编码前缀（apply/notify/off）
  ndjson.ts        NDJSON 解析（跨 chunk/CRLF/脏行）
  output.ts        输出落盘与摘要
  keyed-lock.ts    session 级串行锁
  config.ts        环境变量、DSH 入口探测、cwd 校验
  store.ts         meta.json / events.jsonl 落盘
test/              216 个单测 + 真实 DSH 烟测（`test/mcp-smoke.ts`、`test/http-smoke.ts`）
examples/          多端接入示例（Claude / Codex / MCPB / 远程接入）
scripts/           部署与运维：deploy.ps1（源码→运行目录）/ patch-dsh-pwsh-encoding / patch-dsh-output-decoding / measure-goals / leader-usage / monitor-thread.py（Codex thread 配额/token 监控，兼容两版任务落盘）
docs/              measurement.md（目标口径/公式/A/B 协议/局限）、delegation-playbook.md（委派粒度与任务模板）
```

```powershell
pnpm test          # 单元测试（假 DSH fixture，不耗模型 token）
pnpm smoke         # 真实 DSH 全链路（stdio，消耗少量 token）
pnpm smoke:http    # 真实 HTTP 传输冒烟（healthz / 401 / 真实任务）
pnpm measure:ab    # 目标达成率 A/B（leader 自己做 vs 委派 DSH；消耗 leader 额度）
pnpm measure:leader# 扫描 leader 会话用量（Claude transcripts + Codex rollouts）
pnpm build         # tsc 产物到 dist/
```

测试覆盖：NDJSON 解析/截断、输出落盘、session 锁、dsh 进程超时与取消、任务管理器（并发/每仓库配额/session 串行/长轮询/恢复/取消/TTL 清理/数量上限/审计）、JSON-RPC 客户端、SDK 长驻后端与池、HTTP 传输（鉴权/healthz）、审批桥、新增只读工具、DSH token 用量提取与累加、DSH 兼容补丁（编码前缀 + GBK 兜底解码；apply/notify/off/幂等/版本漂移）。v0.10.0 追加：费用估算（单价/汇率）、`dsh_usage` 聚合、幂等键（落盘命中/TTL/forget/prune）、`dsh_result` 分页、配置合并项（默认 1800s、`DSH_MCP_ALLOWED_ROOTS` 兼容、单价覆盖）。

## 发布到 npm（维护者）

采用 **npm Trusted Publishing（OIDC 绑定 GitHub Actions）**，CI 发布不需要 `NPM_TOKEN`。

1. **首次发布必须手动**（npm 上还不存在该包时无法配置 Trusted Publisher）：
   ```powershell
   npm login          # 浏览器/2FA
   pnpm build
   npm publish --access public
   ```
2. 在 npm 包页面 → Settings → Trusted Publishing → GitHub Actions：
   - Organization/user：`tongsh6`
   - Repository：`dsh-mcp-worker`
   - Workflow filename：`publish.yml`
   - 保存时按需输入 2FA。
3. 之后发布只需打 tag：
   ```powershell
   npm version patch --no-git-tag-version
   git add -A && git commit -m "chore(release): vX.Y.Z"
   git tag vX.Y.Z && git push --follow-tags
   ```
   Actions 会执行 `pnpm test` → `pnpm build` → `npm publish --access public --provenance`（OIDC，无 token）。
4. 也可在 Actions → publish → Run workflow 手动触发。

> 注意：npm Trusted Publisher 要求使用较新的 npm CLI（workflow 里用 Node 24），且 workflow 文件名必须与配置一致。

License：MIT（见 [LICENSE](LICENSE)）。
14. **退出码来自文本标记**：`[exit code: N]` / `[killed by signal]` / `[timed out]` / `[sandbox: ...]` 由 worker 从工具输出解析；DSH 若改格式，`exit_code` 会退化为 `null` 并保留 `markers` 原文，不会给错值。
15. **git 证据的 pre_existing 是文件级**：只能标记「任务开始前已脏」的文件，无法区分同一文件里任务前后各自的改动行。
16. **决策协议依赖 DSH 遵守标记**：`[DSH:NEEDS_DECISION]` 由模型按页脚输出；不遵守时退化为 `completed` + 叙述，不做启发式猜测；可用 `dsh_metrics.outcomes` 观察遵守率。
17. **`dsh_status` 默认 detail 变更（v0.9.0）**：默认不再回传 tool_call/tool_result/text 事件；需要旧行为时传 `detail=events` 或设 `DSH_MCP_STATUS_DETAIL=events`。
## 路线图

- **M1 ✅ 已完成（2026-11-02）**：长驻 `dsh --profile sdk` 后端（默认），一次 initialize 后每任务只发 prompt；保留 `headless` fallback。
- **M2 🟡 部分完成（2026-11-02）**：HTTP 传输（无状态 Streamable HTTP + Bearer + `/healthz`）与审批桥 v0 已实现并测试；ChatGPT 直连需 Secure MCP Tunnel（无配额）或 OAuth 2.1（未实现），见 [examples/remote-access.md](examples/remote-access.md)。
- **M3 ✅ 已完成（2026-11-02）**：任务 TTL 清理 + 数量上限、每 cwd 并发配额（v0.9.4 起按 git 仓库根）、审计日志（`dsh_audit`）、`dsh_tasks`、`dsh_read_result`。
- **M4 ✅ 已完成（2026-11-02）**：批量派发（fan-out）/ 历史任务检索 / 指标快照 / 轻量 OTel span 导出。
- **M5 ✅ 已完成（2026-11-02）**：目标达成率测量——worker 侧 DSH token 计量、A/B 对照工具、leader 用量扫描器、口径文档。
- **M6 ✅ 已完成（2026-11-11，v0.10.0）**：合并本机 Codex 在用版 bridge（`server.mjs` v2.2.0）的能力——`dsh_usage` 用量/成本、幂等键、stdin 防孤儿、macOS cwd 适配、`dsh_result` 分页续读、`scripts/monitor-thread.py`。

> 设计依据与市场调研见 `本机分析报告（未随仓库提供）`。



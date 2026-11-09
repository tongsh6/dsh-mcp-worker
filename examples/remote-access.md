# 远程接入：HTTP 模式 / ChatGPT

worker 默认走 stdio（本地 leader）。远程 leader 用 **Streamable HTTP** 模式：

## 1) 本机启动 HTTP 服务

```powershell
$env:DSH_MCP_TRANSPORT = "http"
$env:DSH_MCP_HTTP_HOST = "127.0.0.1"     # 只给本机；局域网用 0.0.0.0 且必须配 token
$env:DSH_MCP_HTTP_PORT = "7391"
$env:DSH_MCP_HTTP_TOKEN = "<至少 32 字节随机串>"
node "C:\path\to\pnpm-global\dsh-mcp-worker\dist\index.js"
```

启动后：
- MCP 端点：`http://127.0.0.1:7391/mcp`（Streamable HTTP，无状态模式）
- 健康检查：`http://127.0.0.1:7391/healthz`
- 鉴权：`Authorization: Bearer <DSH_MCP_HTTP_TOKEN>`

```powershell
# 冒烟
curl.exe http://127.0.0.1:7391/healthz
# 无 token 应返回 401
curl.exe -i -X POST http://127.0.0.1:7391/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 2) 本地/内网 MCP 客户端接入

Claude Code：

```powershell
claude mcp add --transport http --scope user dsh-remote http://127.0.0.1:7391/mcp --header "Authorization: Bearer <token>"
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.dsh-remote]
url = "http://127.0.0.1:7391/mcp"

[mcp_servers.dsh-remote.http_headers]
Authorization = "Bearer <token>"
```

## 3) ChatGPT 接入（两条路）

> 前置事实：ChatGPT **只接受远程 MCP**，且**不接受自定义 API key**——只认 OAuth 2.1 或“免鉴权”或 OpenAI 的 Secure MCP Tunnel。所以本地 HTTP + Bearer 不能直接给 ChatGPT 用。

### 路线 A：OpenAI Secure MCP Tunnel（推荐，无需公网/域名/OAuth）

前提：OpenAI Platform 组织 + `tunnel_id` + runtime API key（要在组织里创建 tunnel）。

```bash
# 用 tunnel-client 直接拉起本 worker 的 stdio 模式（注意：不是 http 模式）
tunnel-client init --sample sample_mcp_stdio_local --profile dsh-local \
  --tunnel-id tunnel_xxxxxxxx \
  --mcp-command "node C:\\path\\to\\pnpm-global\\dsh-mcp-worker\\dist\\index.js"

tunnel-client doctor --profile dsh-local --explain
tunnel-client run    --profile dsh-local
```

然后 ChatGPT → **Plugins** → `+` → **Add custom MCP server** → Connection 选 **Tunnel** → 选同一个 tunnel → Create。

硬限制（官方）：**单请求 120s / 10 MiB / 600 rpm**，排队时间也计入。因此必须用异步任务模型：`dsh_run` 立即返回，`dsh_status` 轮询，`dsh_result` 取结果。

### 路线 B：自建 HTTPS + OAuth 2.1（产品化，未实现 OAuth）

1. 用 cloudflared / ngrok / Tailscale Funnel 把 `http://127.0.0.1:7391` 暴露成稳定 HTTPS 域名；
2. 在 ChatGPT 里填 `https://<域名>/mcp`；
3. 鉴权选 **OAuth** 时，需要 worker 侧实现 OAuth 2.1 资源服务器（PRM 文档 + AS metadata + PKCE S256 + `resource` 参数 + `WWW-Authenticate` 挑战）。
   当前**未实现**，只能先选“No authentication”（仅个人自用 + 不可猜路径 + 隧道侧限流），或等后续 M2 收尾。

## 4) 安全清单

- 非回环地址（`0.0.0.0`）**必须**设置 `DSH_MCP_HTTP_TOKEN`，否则拒绝启动。
- 公网暴露时在隧道/反代侧再加一层访问控制与限流。
- 只暴露 `/mcp` 与 `/healthz`；HTTP 模式无状态，无 MCP 会话可被劫持。
- 任务执行仍受 `permission_mode` 约束（默认 workspace-write、审批 fail-closed）。

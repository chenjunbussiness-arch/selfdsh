# AWS Quick 接入自建 hub：决策记录（当前：不注册 aws-quick worker）

状态：**已决（否决注册）** · 决策时间 2026-11-23 23:00–23:10 (Asia/Taipei) · 本地工作站
相关任务：`t20261123144335-597`（D-quick-onboard）· 前置体检 `t20261123144017-593/C-quick`

## 一句话

本机装的 AWS Quick 桌面端（v1.2.4660）确实在跑、也确实能在本地执行 Python / ripgrep，
但**它的执行面只对 Quick 自己的云侧 agent 开放**：本地 outpost 除 `/health` 全 401，
outpost token 每次启动新生成、只经 stdio 交给 Electron 主进程、打包版不落盘，
官方 `quicksight-2018-04-01` 动作表里也没有"调用 agent / 发消息"的动作。
因此**没有任何方式让 dsh-agent/2.0 的 worker 把任务投进 Quick**，也就**不注册** `platform=aws-quick` 的 agent。

## 证据（可复跑）

| # | 事实 | 复现方式 |
|---|---|---|
| 1 | 进程在跑：`Amazon Quick` ×5、`quickwork-agent`、`quickwork-sandbox` ×4 | `probe-quick-exec-surface.ps1` A 段 |
| 2 | 仅回环监听：`127.0.0.1:8780`（outpost）、`127.0.0.1:8768`（sandbox），均属 `quickwork-agent` | 同上 B 段 |
| 3 | 8780 上只有 `/health` → 200；`/`、`/v1/health`、`/status`、`/docs`、`/openapi.json`、`/local/outpost-id`、`/tools`、`/tasks`、`/invoke-tool` 及 6 条 POST（含 `/v1/tasks`、`/v1/execute`、`/v1/prompt`、`/mcp`）**全部 401** | 同上 C 段 |
| 4 | 8768 sandbox 连 `/health` 都是 401 | 同上 C 段 |
| 5 | PATH 里没有 quick/quickwork/amazon-quick/aws-quick/quickwork-agent，无 App Paths，无本地任务提交 CLI | 同上 D 段 |
| 6 | 用户数据目录下没有 outpost token 文件 | 同上 E 段 |
| 7 | `app.asar` 里 `OUTPOST_TOKEN` 只在 `line.startsWith('OUTPOST_TOKEN:')`（stdio 管道）出现；`QUICKWORK_TOKEN_FILE` 那条被 `if (!app.isPackaged && process.env.QUICKWORK_TOKEN_FILE)` 守着 —— **打包版不走 token 文件** | 同上 F 段（rg 静态扫描） |
| 8 | Quick 的**执行是真的**：日志里云端 `tooluse_*` 触发 `run_python_outpost_local`(×6)、`ripgrep`(×2)、`run_python_outpost_local_with_write`(×2)，NookAuth `api/ws-rpc` 200 —— 但**触发方在云侧**，日志里没有任何"外部投任务"入口 | `%LOCALAPPDATA%\quickwork\logs\quickwork-2026-11-23-15.log` |
| 9 | 官方动作表里**没有** Invoke/SendMessage/Converse/Run/Chat 类动作；`CreateAgent` 只建配置（prompt/spaces/action connectors/lifecycle），不能"跑" | <https://docs.aws.amazon.com/quicksight/latest/APIReference/API_Operations.html>、`API_CreateAgent.html` |
| 10 | 唯一像"投任务"的是 `StartAutomationJob`（`POST /accounts/{AwsAccountId}/automation-groups/{g}/automations/{a}/jobs`，带 `InputPayload`，`DescribeAutomationJob` 取 `OutputPayload`）—— 但那是**云端 Quick Suite 的 automation**：要 AWS 账号 + IAM 凭据 + 付费版本 + 事先在控制台建好的 automation（动作表里没有 `CreateAutomation*`），而且不是本机这个桌面端 | `API_StartAutomationJob.html`、`API_DescribeAutomationJob.html` |

## 仓库里已有的两条设计，分别卡在哪

1. **`agent_client.py bridge --once`**（README L46："AWS Quick 用定时 bridge --once"）
   把 Quick 当**定时器**：到点跑一次同步，任务落进 exchange 目录，由本机 agent 执行。
   卡点：Quick 没有"运行命令"的对外入口（无 CLI、无本地任务提交路由），
   **连定时器都当不了**；就算人为触发，执行者仍是本机 agent —— 那是代持，不是 Quick。

2. **MCP 客户端路线**（README L354：给 Quick 加 hub 的 MCP server，`/mcp` + `/oauth/token`）
   这条路方向是对的，Quick 桌面端确实带 MCP 客户端能力（`app.asar` 里 `mcpServers` 26 处、
   能力页上有 `onToggleMcp/onRemoveMcp/onEditMcp/onRefreshMcp/onConfigureSecrets`、
   还有需要审批的 `enable_mcp_server` 工具；`quickwork-agent.exe` 有 `mcp_client`）。
   卡点：**线上 hub 没有这个网关** —— `/mcp` 与 `/oauth/token` 实测 GET/POST 全 404
   （线上是比 HEAD 旧的构建，见 A 报告 §0）。要开就得部署 HEAD 构建并重启 hub 容器，
   本任务明确禁止；另外 hub 是自签 CA，Quick 侧是否信任未验证。

## 代持是什么，为什么不算 Quick 成为 worker

- **谁执行**：`agent_client.py run` 只做心跳 + 长轮询，把任务写进 exchange `inbox/`；
  真正干活的是本机读 `inbox` 的那个 agent（DSH / Claude Code / 人）。Quick 进程全程不知情、不参与、也不回传结果。
- **为什么不算**：hub 看到的只是 `platform=aws-quick` 这个**标签**。任务板上会显示"Quick 在线、接活、完成"，
  而实际执行体在另一处 —— 这正是"假装注册成功"。本机已有诚实的 `worker-local`（`platform=dsh`，node `local`，online），
  再注册一个 `platform=aws-quick` 的 id，只是同一台机器换标签。
- **代价**：一旦有人按 `platform=aws-quick` 派活给"Quick"，排查时会去查 Quick 的日志/账号，
  而那里永远查不到这次任务 —— 证据链断裂。

## 什么条件下重开这件事（任一条满足即可重新评估）

1. **hub 侧先具备 MCP 网关**：部署含 `/mcp`、`/oauth/token` 的 HEAD 构建（需重启 hub 容器，人决定），
   且 Quick 能接受 hub 的自签证书；然后按 README L354 用 OAuth client credentials 加进去。
   最小验证点：`GET /mcp` 不再是 404。
2. **AWS 侧给出可编程入口**：官方 `quicksight` API 出现"调用 agent / 会话"的动作，
   或 outpost 支持第三方可读的 token 注入（`OUTPOST_TOKEN` 落盘/可注入）。
   最小验证点：本文件 §证据 #3 的矩阵里出现非 `/health` 的 200，或 #7 的 `isPackaged` 守卫消失。
3. 若只是想"让本机多一个执行端"：用已有的 `worker-local`，或按正常流程再注册一个 `platform=dsh|custom` 的 worker，
   不要挂 `aws-quick` 的名。

## 怎么复跑

```powershell
pwsh -NoProfile -File plugins/dsh-agent-hub/docs/archive/probe-quick-exec-surface.ps1
# 可选：落盘证据
pwsh -NoProfile -File plugins/dsh-agent-hub/docs/archive/probe-quick-exec-surface.ps1 -OutFile .dsh-artifacts\quick-probe.txt
```

退出码：`0` = 确认无可编程执行面（当前状态）；`2` = 有非 `/health` 路由免认证返回 2xx（需重新评估）；
`3` = Quick 没在跑。脚本只读：不登录、不启停 Quick、不碰 hub、不读不打印任何凭据、除 `-OutFile` 外不写文件。

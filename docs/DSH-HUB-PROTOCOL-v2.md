# dsh-hub 协议 v2（`dsh-agent/2.0`）

v1 是挂在 DSH web server 里的插件；v2 改成**独立服务 dsh-hub**：多个 DSH 控制方 + N 个 worker，任务带**工作区名**，每台机器按自己的 profile 映射找到本地路径。

## 1. 角色与部署

| 角色 | 例子 | 能做什么 | 令牌 |
|---|---|---|---|
| hub | 云服务器上的 `dsh-hub` 服务 | 存任务、路由、租约、重试、存产物 | — |
| 控制方（controller） | `dsh-cloud`、`dsh-local` | 派活、取消、重试、审批 worker、看全部状态、取产物 | 控制方令牌，**只能在 hub 机器上用 CLI 签发** |
| worker | `quick@mydesk`、`kiro@mydesk`、`claude@cloud` | 心跳、领自己的任务、报进度、交结果、下载自己任务的输入 | worker 令牌，申请后由控制方批准 |

- hub 是独立进程：`node services/dsh-hub/server.mjs`，Node ≥ 22，**无第三方依赖**，systemd 托管。
- **端口固定 7891**（环境变量 `DSH_HUB_PORT` 可改）。所有请求和推送都走这个端口。不用 7890：7890 是 MYDESK 本机 Clash/mihomo 的 HTTP 代理端口，MYDESK 发往 hub 的请求都经过它（第 8 节），两者不能混淆。
- 状态目录固定：`<DSH home>/agent-hub/`（`state.json`、`artifacts/`、`hub.json` 配置）。
- 传输：hub 自带 TLS（`hub.json` 里配 `tls.cert` / `tls.key`）+ IP 白名单（`allow: ["1.2.3.4/32", ...]`）。没配 TLS 时只允许监听 `127.0.0.1`（防止令牌明文过公网）。
- 注意：服务器上 mihomo 用的是 17890/17892，和 7891 不冲突。

## 2. 身份：query 带 id，header 带令牌

- 每个请求的 query 都带 `id=<注册名>`，例如 `GET /v1/poll?id=quick-mydesk`。用于路由和日志。
- 令牌放 header `X-DSH-Token`，**不放 query**（query 会进 nginx/代理/访问日志）。
- hub 校验：令牌必须属于 `id` 本人，否则 401。令牌格式 `dsha_<id>_<随机>`（worker）、`dshc_<id>_<随机>`（控制方）；只存 sha256。
- id 规则：`/^[a-z][a-z0-9-]{1,47}$/`，建议 `<agent>-<机器>`，如 `quick-mydesk`。

## 3. 工作区映射（profile）

任务里只写**工作区名**，不写路径。名字沿用 router-b 的分区名（`cordis.patch.yml` → `host-router.config.partitions[].name`）。

每台机器的 worker 用本机映射把名字翻译成路径，来源按优先级：
1. worker 配置 `workspaces.json` 的 `workspaces`（显式覆盖）；
2. 本机 DSH profile：`<profile 目录>/cordis.patch.yml` 里 router-b 的 `partitions`（`name` → `root`）。

```json
// workspaces.json（每台机器一份，放在 worker 自己的配置目录，不入库）
{
  "node": "mydesk",
  "profile": "C:/Users/<你>/.dsh/profiles/web",
  "workspaces": {
    "deepseek-harness": "E:/PythonProject/dsh-warroom"
  }
}
```

- worker 启动时算出 `{name: path}`，**只把名字**报给 hub（注册和心跳都带），路径不出本机。
- 领到任务后，worker 在本地 `task.json` 里补上 `workspace_path`（本机真实路径），供 agent 使用。
- 映射里不存在、或路径不存在的工作区，不报给 hub。

## 4. 路由

任务字段（v1 基础上新增）：
- `workspace`：工作区名（`code` 类型必填，其他可选）。
- `node`：可选，限定机器（`mydesk` / `cloud` …）。
- `ref`：可选，git 分支或 commit。worker 先切到这个版本再干活。
- `created_by`：由 hub 填，派活的控制方 id。

hub 派给某 worker 的条件**全部满足**：
1. `agent` 是这个 worker 的 id，或 `pool:<能力>` 且 worker 有这个能力；
2. 任务有 `workspace` 时，worker 当前上报的工作区里有它，并且批准时授予过它；
3. 任务有 `node` 时，和 worker 的 `node` 一致；
4. `depends_on` 都已 completed；不超过 worker 的 `max_concurrency`。

**控制方隔离**：取消、重试只能由 `created_by` 那个控制方做；查看对所有控制方开放。

## 5. 接口（全部在 7891 端口，前缀 `/v1`）

Content-Type 一律 `application/json`（下载产物除外）。错误统一 `{error:{code,message}}`。

### 5.1 worker
| 方法 路径 | 说明 |
|---|---|
| `POST /v1/enroll?id=` | 无令牌。body `{platform, mode, node, workspaces[], capabilities[], max_concurrency, description}` → `{request_id, poll_secret, status:"pending"}` |
| `POST /v1/enroll/status?id=` | 无令牌。body `{request_id, poll_secret}` → 状态；批准后**首次**返回 `token` |
| `POST /v1/heartbeat?id=` | body `{status, workspaces[], running?[task_id], client_version?}`，`workspaces` 超出批准范围的部分被截断 → `{ok, status, server_time, workspaces, ignored_workspaces, abort[], requeued[]}`（对账规则见第 9 节） |
| `GET /v1/poll?id=&max=1&wait=25` | 领任务；`wait` 秒内没有任务就长轮询等待（上限 55），有新任务立刻返回 |
| `POST /v1/event?id=` | `{task_id, progress, message}`，续租 |
| `POST /v1/result?id=` | `{task_id, status, summary, files[{name,base64}], error, needs_input}` |
| `GET /v1/artifact?id=&task_id=&name=[&from_task=]` | 下载本任务输入或上游产出 |
| `GET /v1/me?id=` | hub 眼里的自己：`status`、`last_seen`、`version`、授予的 `workspaces` / `capabilities`、`reported_workspaces`、`ignored_workspaces`、`running_tasks`、`offline_after_ms`、`client_ip` |
| `POST /v1/leave?id=` | 主动下线：标为 `left`，它持有的任务立即重排 → `{ok, status:"left", requeued[]}` |

### 5.2 控制方
| 方法 路径 | 说明 |
|---|---|
| `POST /v1/ctl/dispatch?id=` | 派任务（字段见第 4 节，另有 `require_online`）；返回任务对象，可能带 `warnings`（第 9 节） |
| `GET /v1/ctl/tasks?id=&status=&agent=&workspace=&limit=` | 任务列表 |
| `GET /v1/ctl/task?id=&task_id=` | 详情 + 历史 + 结果 |
| `GET /v1/ctl/output?id=&task_id=&name=` | 下载产出文件 |
| `POST /v1/ctl/cancel?id=`、`/v1/ctl/retry?id=` | 仅限创建者 |
| `GET /v1/ctl/agents?id=`、`/v1/ctl/requests?id=&status=` | worker 列表、申请列表 |
| `POST /v1/ctl/approve?id=` | `{request_id, capabilities?, workspaces?, max_concurrency?}`，只能收窄 |
| `POST /v1/ctl/reject?id=`、`/v1/ctl/revoke?id=`、`/v1/ctl/provision?id=` | 驳回、吊销、直接签发 worker |
| `GET /v1/ctl/overview?id=` | 总览（给面板用） |
| `GET /v1/health` | 无令牌（但受 IP 白名单限制），返回 `{ok, version, client_ip}`；`client_ip` 是 hub 实际看到的来源地址 |

### 5.3 CLI（只在 hub 机器上）
```
node server.mjs                                   # 启动
node server.mjs controller add dsh-cloud          # 签发控制方令牌（只显示一次）
node server.mjs controller list | revoke <id>
```

## 6. DSH 插件（控制方）

`plugins/dsh-agent-hub` 变成 hub 的**客户端**：
- 配置 `hubUrl`（如 `https://<服务器>:7891`）、`controllerId`、可选 `proxy`（MYDESK 上的 dsh-local 填 `http://127.0.0.1:7890`；和 hub 同机的 dsh-cloud 用 `https://127.0.0.1:7891` 直连（配 `caFile`，证书 SAN 含 127.0.0.1），不填）；令牌从环境变量 `DSH_HUB_TOKEN` 读，或写进 `<DSH home>/agent-hub/controller.env`（插件默认的 `envFile`，chmod 600）。**不能写进 `<DSH home>/.env`**：DSH 不允许那里出现任何 `DSH_` 开头的变量，会拒绝启动。
- 11 个工具不变，内部改成调 `/v1/ctl/*`；`task_dispatch` 多了 `workspace` / `node` / `ref` 参数。
- 面板接口 `/api/agent-hub/admin/*` 保持原路径和返回结构，由插件转发到 hub。

## 7. 代码类任务的交付

- 不同机器上的同名工作区是各自的 git checkout。任务带 `ref`，worker 先 `fetch` 并切到这个版本。
- 结果交回 `changes.patch`（`git diff` 格式，相对工作区根目录）+ `summary.md`；或者 worker 推一个分支，在 `result.summary` 里写分支名。
- 控制方负责应用补丁、测试、提交。worker 不提交到主分支。

## 8. 网络与代理

```
MYDESK ── worker（agent_client.py，DSH_HUB_PROXY=http://127.0.0.1:7890）──┐
       └─ dsh-local（插件 proxy: http://127.0.0.1:7890）─────────────────┤
                                                                          ▼
                                     Clash / mihomo 127.0.0.1:7890（HTTP 代理，CONNECT）
                                                                          │  固定代理节点（不是 DIRECT）
                                                                          ▼
                                           服务器 <server>:7891（dsh-hub，TLS + allow）
                                                                          ▲
服务器本机 ── dsh-cloud（hubUrl https://127.0.0.1:7891，直连，不配 proxy）──┘
```

- **服务器只接受外网流量**，所以 MYDESK → hub 必须经过 Clash 的**代理节点**出去，不能走 DIRECT。hub 看到的来源 IP 就是这个节点的**出口 IP**。
- **在 Clash 里给 hub 地址固定一个节点**：在 `rules` 里靠前的位置加一条，例如 `- IP-CIDR,<服务器IP>/32,<固定节点名>`（用域名访问时再加 `- DOMAIN,<hub 域名>,<固定节点名>`）。不要写 DIRECT，也不要让它落到会自动切换节点的策略组里。
- **hub 的 `allow` 白名单填这个节点的出口 IP**。不知道是哪个 IP 时，在 MYDESK 上运行 `python agent_client.py check`：成功时打印 `seen as: <client_ip>`；被白名单挡住时 403 的响应体里带 `client_ip`（只有调用方自己的地址，不泄露白名单内容），check 会提示「把 `<client_ip>` 加进服务器 hub.json 的 allow，或在 Clash 里给 hub 地址固定节点」。
- **节点会换怎么办**（二选一，写清取舍）：
  1. 把这个节点（或策略组）所有可能的出口 IP 都列进 `allow`：白名单仍然有效，但换机房 / 节点后要同步更新；
  2. `allow` 留空，只靠 **TLS + 令牌**：任何地址都能连到 hub（包括扫描器），能否调用仍取决于令牌（令牌只存 sha256、只在请求头里）。省事，但少了一层网络防护，hub 启动时会打一条 warning。
- 和 hub 同机的 dsh-cloud 直连 `https://127.0.0.1:7891`（hub 配了 TLS 就只提供 https，证书 SAN 要包含 127.0.0.1；回环地址不走代理；`allow` 里要有 `127.0.0.1/32`）。
- 代理只支持 `http://`（CONNECT 隧道），令牌只在隧道内的 TLS 里传输，代理看不到；代理 URL 里的用户名密码不会出现在日志和错误信息里。插件的 `proxy: env` 读取 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`，遵守 `NO_PROXY`（逗号分隔的主机名、后缀、`*`）。
- **长轮询**：`GET /v1/poll?wait=N` 最长挂 55 秒（客户端默认 25 秒，超时 = wait + 15 秒），代理的空闲超时必须大于 wait + 15 秒，否则会被提前断开（客户端会重试，但浪费一次往返）。
- MYDESK 上 7890 是代理，hub 在 7891；服务器上的 mihomo 用 17890/17892，三者互不冲突。

## 9. 注册与在线机制

```
 init ──► 填 worker/.env + profile.json ──► check（经代理到 hub，看到的 IP）
   │
   ▼
 register: POST /v1/enroll ──► 控制方 agent_requests / agent_approve（只能收窄）
           POST /v1/enroll/status（轮询，可断点续）──► 批准后第一次查询领到令牌 → DSH_AGENT_TOKEN_FILE
   │
   ▼
 run: heartbeat（每 DSH_HEARTBEAT_SECONDS，默认 30 s，带 running / client_version）
      + GET /v1/poll 长轮询（只有 worker 自己 poll 时才分配任务）
   │
   ├─ online ── 90 s 内没有 heartbeat / poll / event ──► offline ──► sweep 立即重排它持有的任务
   ├─ POST /v1/leave ──────────────────────────────────► left ────► 持有的任务立即重排
   └─ 控制方 agent_revoke ─────────────────────────────► revoked ─► 令牌失效，任务重排
   （offline / left 的 worker 再次 heartbeat 或 poll 就回到 online）
```

**状态**（`agents` 列表、`overview.agent_counts`、`/v1/me` 里的 `status`；`online` 布尔值保留）：

| 状态 | 含义 |
|---|---|
| `pending` | 已申请未批准（在 `requests` 列表里），或已批准但 worker 还没领走令牌 |
| `online` | 最近一次 heartbeat / poll / event / result 在 `offlineAfterMs`（默认 **90000** ms）以内 |
| `offline` | 超过 `offlineAfterMs` 没有动静（或领了令牌后从未出现） |
| `left` | 调用了 `POST /v1/leave`，之后还没有再出现 |
| `revoked` | 被控制方吊销 |

agents 列表和 overview 里每个 worker 还有 `last_seen`、`left_at`、`version`（心跳里的 `client_version`）。

**心跳对账**：心跳 body 带 `running: [task_id]`（worker 本地还持有的任务）时，hub 返回：

- `abort`：`running` 里 hub 认为已经不属于它的任务（已取消、已重排、已改派、不存在）。worker 收到后不再交付：inbox 里的移到 archive，working 里的写 `ABORTED.json` 通知 agent 停下；
- `requeued`：hub 记为它持有、但它没有上报的任务，立即重排（原因 `worker-lost`，计一次尝试）。刚租出不到 30 秒的任务不算（poll 的响应可能还在路上）；
- 不带 `running` 时不做对账（兼容旧客户端）。

**分配规则**：

1. 只在 worker 自己 poll 时分配（天然只给在线的 worker），路由条件见第 4 节；
2. dispatch 指定具体 agent：未注册 → 404 `agent-not-found`；已申请未批准 → 409 `agent-not-approved`；已吊销 → 409 `agent-revoked`；离线（含 left、未领令牌）→ 仍入队，返回 `warnings: ["agent-offline"]`；带 `require_online: true` 时离线直接 409 `agent-offline`，不入队；
3. dispatch 到 `pool:<能力>`：当前没有任何在线且满足能力 / workspace / node 条件的 worker → 仍入队，返回 `warnings: ["no-online-worker"]`；带 `require_online: true` 时 409 `no-online-worker`；
4. 持有任务的 worker 超过 `offlineAfterMs` 没有 heartbeat / poll / event，或主动 leave：sweep（每 `sweepIntervalMs`，默认 15 s）/ leave 当时立即重排它的任务，不等租约到期，记一次尝试；超过 `maxRetries` 的任务变 `dead`。

**超时默认值**：`offlineAfterMs` 90 s；心跳周期 30 s（客户端 `DSH_HEARTBEAT_SECONDS`，5..3600）；长轮询 `wait` 25 s（上限 55 s，客户端超时 wait + 15 s）；启动时心跳失败按 5 s → 10 → 20 → 40 → 60 s 退避重试；对账宽限 30 s；租约默认 3600 s（进度事件续租）。


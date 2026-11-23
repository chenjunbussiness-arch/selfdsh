# dsh-hub · 独立的 agent 调度服务（协议 `dsh-agent/2.0`）

dsh-hub 是 `docs/DSH-HUB-PROTOCOL-v2.md` 里的 **hub**：一个独立进程，给**多个 DSH 控制方**（`dsh-cloud`、`dsh-local` …）和 **N 个 worker**（`quick-mydesk`、`kiro-mydesk`、`claude-cloud` …）提供服务。它负责存任务、按**工作区名 / 机器 / 能力**路由、管租约和重试、存产物。

- 启动：`node services/dsh-hub/server.mjs`。需要 Node ≥ 22，**没有第三方依赖**，由 systemd 托管。
- 端口：**7891**（环境变量 `DSH_HUB_PORT` 可以改）。**不用 7890**：7890 是 MYDESK 本机 Clash/mihomo 的 HTTP 代理端口，MYDESK 发往 hub 的请求都要经过它（见第 2 节「网络与代理」），hub 用 7891 是为了不和代理端口混淆。服务器上 mihomo 的 17890/17892 也不冲突。
- 状态目录固定为 `<DSH home>/agent-hub/`，即 `$DSH_HOME/agent-hub`，没设 `DSH_HOME` 时是 `~/.dsh/agent-hub`。

```
<DSH home>/agent-hub/
├── hub.json           配置（唯一的配置文件，见第 3 节）
├── state.json         worker、任务、申请（原子写入，权限 0600）
├── controllers.json   控制方注册表：只存令牌的 sha256（CLI 写，服务只读，权限 0600）
└── artifacts/<task_id>/{inputs,outputs}/
```

## 1. 和 v1 插件的关系

| | v1：`plugins/dsh-agent-hub` | v2：`services/dsh-hub`（本目录） |
|---|---|---|
| 运行方式 | 挂在 DSH web server 里的插件 | 独立进程（systemd），端口 7891 |
| 调度方 | 一个 DSH（用模型工具） | 多个控制方，每个有自己的 `dshc_` 令牌 |
| 接口前缀 | `/api/agent-hub/v1/*`，请求头 `X-DSH-Agent-Token` | `/v1/*`，请求头 `X-DSH-Token`，query 里带 `?id=` |
| 领任务 | `POST /poll` | `GET /v1/poll?id=&max=&wait=`（长轮询） |
| 路由 | agent id / `pool:<能力>` | 再加上 `workspace`（工作区名）和 `node`（机器） |

- `lib/hub.js` 是从 v1 的 `packages/host-agent-hub/hub.js` 复制过来再扩展的，**v1 原文件没有改**。v1 的安全修复都保留了：`own()` 查找时不会走到原型链；每次修改状态都会在 mutation 内部重新检查调用方是否已被吊销（worker 和控制方都查）；所有输入先校验再写入（v2 进一步做到：结果文件名全部校验通过后才开始写文件）。
- 按协议第 6 节，`plugins/dsh-agent-hub` 现在是 hub 的**控制方客户端**（`hubUrl` + `controllerId` + `DSH_HUB_TOKEN`，可选 `proxy`），11 个工具内部调用 `/v1/ctl/*`，见该插件的 README。
- **不要让 v1 插件的 host-agent-hub 和 dsh-hub 用同一个 DSH home 同时运行**：两边都会写 `<DSH home>/agent-hub/state.json`。dsh-hub 能读 v1 的 `state.json`，会在内存里升级（worker 的 `workspaces` 和 `reportedWorkspaces` 补成 `[]`），下次保存时写成 2.0。v1 留下的任务 `created_by` 是 `"dsh"`，不属于任何控制方，所以**谁都不能取消或重试这些任务**（但可以查看）。
- worker 端是 `plugins/dsh-agent-hub/scripts/agent_client.py`（v2：`?id=` + `X-DSH-Token`、`GET /v1/poll` 长轮询，支持 `proxy`；`python agent_client.py check` 可以检查经代理到 hub 的连通性）。

## 2. 部署

```bash
# 0. 代码放在 /srv/dsh-warroom（按实际路径替换）；Node >= 22
node --version

# 1. 配置（JSON 里不能写注释，每个键的含义见第 3 节）
mkdir -p /root/.dsh/agent-hub && chmod 700 /root/.dsh/agent-hub
cp /srv/dsh-warroom/services/dsh-hub/hub.example.json /root/.dsh/agent-hub/hub.json
vi /root/.dsh/agent-hub/hub.json
chmod 600 /etc/dsh-hub/tls/privkey.pem        # 私钥只给 root 读，否则启动时会打 warning

# 2. 签发控制方令牌（只能在 hub 机器上用 CLI 做；令牌只显示这一次）
cd /srv/dsh-warroom/services/dsh-hub
DSH_HOME=/root/.dsh node server.mjs controller add dsh-cloud
DSH_HOME=/root/.dsh node server.mjs controller add dsh-local

# 3. systemd
sed 's#__DSH_WARROOM__#/srv/dsh-warroom#g' deploy/dsh-hub.service > /etc/systemd/system/dsh-hub.service
systemctl daemon-reload && systemctl enable --now dsh-hub
journalctl -u dsh-hub -f
#   dsh-hub 2.0.0 (dsh-agent/2.0) listening on https://0.0.0.0:7891; config ...; state ...; allow ...

# 4. 自检（health 也受 IP 白名单限制；用自签证书时加 -k）
curl -s https://127.0.0.1:7891/v1/health            # {"ok":true,"version":"2.0.0","client_ip":"127.0.0.1"}
# 从 MYDESK 经本机代理检查（-x 指定 Clash/mihomo 的 HTTP 代理）：
#   curl -s -x http://127.0.0.1:7890 https://<hub-host>:7891/v1/health
```

- `deploy/dsh-hub.service`：`User=root`，`Restart=on-failure`，`WorkingDirectory=__DSH_WARROOM__/services/dsh-hub`（占位符，部署时替换），`Environment=DSH_HOME=/root/.dsh`，`UMask=0077`。配置错误时进程以 **78** 退出，unit 里设了 `RestartPreventExitStatus=78`，所以不会反复重启。配置错误包括：hub.json 不合法、TLS 文件读不到、没配 TLS 却监听非 127.0.0.1。
- 端口：hub 默认 **7891**。MYDESK 上 7890 是 Clash/mihomo 的本机代理端口（客户端经它出去，不是 hub）；服务器上 mihomo 用的是 17890/17892，和 7891 都不冲突。防火墙 / 安全组放行的是 **7891**。
- **网络与代理**（详见协议 `docs/DSH-HUB-PROTOCOL-v2.md` 第 8 节）：MYDESK 上的 worker（`agent_client.py`，`DSH_HUB_PROXY=http://127.0.0.1:7890`）和 dsh-local（插件配置 `proxy: http://127.0.0.1:7890`）都经过本机 Clash/mihomo → 服务器 7891；和 hub 同机的 dsh-cloud 直连 `https://127.0.0.1:7891`（配 `caFile`；证书 SAN 要包含 127.0.0.1），不走代理。**服务器只接受外网流量**，所以 Clash 里 hub 地址必须固定走一个代理节点（在 `rules` 靠前加 `- IP-CIDR,<服务器IP>/32,<固定节点名>`，不要写 DIRECT），`allow` 填这个节点的出口 IP；节点会换的话，要么把所有可能的出口 IP 都列进去，要么 `allow` 留空、只靠 TLS + 令牌（少一层网络防护，启动时有 warning）。不知道出口 IP 时在 MYDESK 上跑 `python agent_client.py check`：`/v1/health` 和白名单 403 的响应里都带 `client_ip`。长轮询最长 55 秒（客户端默认 `wait=25`，超时 = wait + 15 秒），代理的空闲超时要大于 wait + 15 秒。
- **两种部署方式：**
  - **A. hub 自己做 TLS（推荐）**：`tls.cert` / `tls.key` 加上 `allow` 白名单，`host` 默认 `0.0.0.0`。
  - **B. 放在本机 nginx 后面**：不配 `tls`，`host` 只能是 `127.0.0.1`，同时设 `"trustProxy": true`。nginx 负责 TLS，并用 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` 传客户端地址。hub 取的是 X-Forwarded-For 的**最右边一段**，也就是 nginx 自己追加的那个地址。长轮询需要 `proxy_read_timeout 70s;`；要上传结果，需要 `client_max_body_size` ≥ `maxResultBytes`。

## 3. 配置：`<DSH home>/agent-hub/hub.json`

所有配置都集中在这一个文件里。文件不存在时全部使用默认值，此时监听 `127.0.0.1:7891`，不启用 TLS。示例见 `hub.example.json`。下表是每个键的说明：

| 键 | 类型 | 默认值 | 含义 | 示例 |
|---|---|---|---|---|
| `port` | 整数 1..65535 | `7891` | 监听端口。环境变量 `DSH_HUB_PORT` 优先于这里。不要用 7890（MYDESK 上的 Clash/mihomo 代理端口，容易混淆） | `7891` |
| `host` | 字符串 | 配了 `tls` 时 `"0.0.0.0"`，否则 `"127.0.0.1"` | 监听地址。**没配 `tls` 时只能是 `127.0.0.1`**，写别的值服务会拒绝启动（退出码 78），这是为了防止令牌明文经过公网。`localhost`、`::1` 也不允许 | `"0.0.0.0"` |
| `tls` | 对象 `{cert, key}` | 不启用 | **只写文件路径，不放证书或私钥内容**。`cert` 是 PEM 证书（含中间证书链），`key` 是 PEM 私钥。相对路径相对 `<DSH home>/agent-hub/` 解析。两个都要填。私钥**不能加口令**：hub 不读取任何口令 | `{"cert": "/etc/dsh-hub/tls/fullchain.pem", "key": "/etc/dsh-hub/tls/privkey.pem"}` |
| `allow` | 字符串数组 | `[]`（不限制） | IP 白名单，对**所有接口**生效（包括 `/v1/health`）。支持 IPv4 地址和 CIDR（`/0`..`/32`）、IPv6 **精确地址**（可以带 `/128`，不支持其他 IPv6 前缀）、`::ffff:a.b.c.d`（按 IPv4 处理）。客户端从 IPv4-mapped 地址（`::ffff:1.2.3.4`）连进来时按 IPv4 规则匹配。**回环地址不会被自动放行**，本机要访问就把 `127.0.0.1` / `::1` 写进来。配了 `tls` 但 `allow` 为空时，启动会打 warning | `["127.0.0.1/32", "::1", "203.0.113.7/32", "10.8.0.0/24"]` |
| `trustProxy` | 布尔 | `false` | `false`：客户端地址只看 `socket.remoteAddress`，忽略 X-Forwarded-For。`true`：使用 X-Forwarded-For 的**最右边一段**，只适合前面只有**一个**可信代理的情况（部署方式 B） | `false` |
| `maxRetries` | 整数 0..20 | `2` | 租约过期或可重试的失败之后最多重排几次，超过就标记 `dead`（默认最多尝试 3 次） | `2` |
| `offlineAfterMs` | 整数 ≥ 1000 | `90000` | 超过这么久没有心跳、poll 或进度事件，worker 变为 `offline`，sweep 立即重排它持有的任务（见第 6.1 节） | `90000` |
| `sweepIntervalMs` | 整数 1000..3600000 | `15000` | 清扫间隔：处理过期租约、上游失败、过期的申请 | `15000` |
| `maxResultBytes` | 整数 65536..1073741824 | `20971520`（20 MiB） | `POST /v1/result` 和 `POST /v1/ctl/dispatch`（输入文件是 inline 上传的）的请求体上限 | `20971520` |

其他请求体上限是固定的：`enroll`、`enroll/status`、`heartbeat` 16 KiB；`event` 和其他控制方 POST（cancel、retry、approve、reject、revoke、provision）64 KiB。

hub.json 里出现未知的键只打 warning，不报错（例如 v1 的 `dataDir` 会被忽略，状态目录是固定的）。类型或范围不对时，服务拒绝启动，退出码 78。

**环境变量**

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_HOME` | DSH home 目录。配置文件是 `$DSH_HOME/agent-hub/hub.json`，状态和产物也放在这个目录下。CLI 和服务用的是同一个目录 | `~/.dsh`（systemd unit 里设为 `/root/.dsh`） |
| `DSH_HUB_PORT` | 覆盖 `port`，必须是 1..65535 的整数 | 不设置 |

**TLS 私钥检查**：启动时会 `stat` 一次 `tls.key`。在 POSIX 系统上，如果私钥对组或其他用户可读写（`mode & 0o077 != 0`，例如 640、644），会打出 warning：`tls.key ... is accessible by group/others (mode 644); run: chmod 600 ...`。Windows 不检查。文件不存在或不是普通文件时，服务拒绝启动（退出码 78）。私钥内容只交给 Node 的 TLS 层使用，不会写日志，也不会出现在接口返回里。

## 4. CLI（只能在 hub 机器上使用）

```
node server.mjs                          # 启动
node server.mjs controller add <id>      # 签发控制方令牌 dshc_<id>_<随机>，只打印这一次
node server.mjs controller list          # 列出 id / active|revoked / 时间（不显示令牌）
node server.mjs controller revoke <id>   # 吊销，立即生效
```

- CLI 只读写 `controllers.json`，不碰 `state.json`，所以**服务运行时也可以执行**。服务每次处理控制方请求时都会重新读取 `controllers.json`，在 mutation 内部还会再读一次，所以 `add` 和 `revoke` 不需要重启就能生效。
- `add` 一个已经存在且未吊销的 id 会报错。要换令牌，先 `revoke` 再 `add`，旧令牌会立即失效。
- 拿到的令牌放到控制方那边（DSH 进程的环境变量 `DSH_HUB_TOKEN`，或控制方插件默认读取的 `<DSH home>/agent-hub/controller.env`，chmod 600），不要写进仓库。**不要写进 `<DSH home>/.env`**：DSH 不允许那里出现 `DSH_` 开头的变量，会拒绝启动。
- 退出码：0 成功，1 操作失败（id 不合法、已存在、不存在），2 用法错误。

## 5. 接口（前缀 `/v1`，端口 7891）

**每个请求的检查顺序**：

1. IP 白名单 → 不通过返回 403 `ip-not-allowed`，`error` 里带 `client_ip`（hub 看到的调用方地址，只有它自己的，不含白名单内容），方便把代理节点的出口 IP 加进 `allow`
2. 路径和方法 → 404 `not-found` 或 405 `method-not-allowed`
3. 除 `/v1/health` 外，query 必须带 `?id=`，而且只能出现一次 → 否则 400 `bad-query`；query 里出现 `token=` 也会被拒绝（400 `token-in-query`）
4. 请求头 `X-DSH-Token`：
   - 令牌无效 → 401 `unauthorized`
   - 令牌不属于 query 里的 `id` → 401 `unauthorized`
   - 角色不对 → 403 `forbidden`。worker 令牌（`dsha_`）调用 `/v1/ctl/*`，或控制方令牌（`dshc_`）调用 worker 接口，都属于这种情况
5. 读取请求体：必须是 `application/json`，否则 415；超过上限 413，并返回 `connection: close`；不是 JSON 对象 400。**鉴权通过之后才开始读请求体**。

**错误格式**：一律是 `{error:{code,message}}`。500 只返回 `{code:"internal", message:"internal error"}`，详细信息只写进日志。401 和 403 会记一条 warn 日志，内容是 id 和 IP，不包含令牌。

### 5.1 worker

| 方法 路径 | 请求 | 返回 |
|---|---|---|
| `POST /v1/enroll?id=` | 无令牌。`{platform, mode, node, workspaces[], capabilities[], max_concurrency, description}`；身份以 query 的 `id` 为准，body 里的 `agent_id` 和 `from` 会被忽略，来源 IP 由 hub 自己记录 | `{request_id, poll_secret, status:"pending"}` |
| `POST /v1/enroll/status?id=` | 无令牌。`{request_id, poll_secret}`；`id` 必须是申请人本人，否则返回 404（和查不到申请一样） | `{status}`；批准后**第一次**查询会返回 `token` |
| `POST /v1/heartbeat?id=` | `{status?: "idle"\|"busy", workspaces?: [], running?: [task_id], client_version?, pull_every_seconds?: 60..86400 \| null}` | `{ok, agent_id, status, server_time, workspaces, ignored_workspaces, abort, requeued, reclaimed, pull_every_seconds, offline_after_ms}`（对账见第 6.1 节） |
| `GET /v1/poll?id=&max=1&wait=25` | `max` 1..32；`wait` 单位秒（≥0，超过 55 按 55 算） | `{tasks:[{task_id, type, title, instruction, workspace, node, ref, created_by, inputs[{name,from_task}], output, priority, deadline, lease_until, attempt, …}]}` |
| `POST /v1/event?id=` | `{task_id, progress?, message?}`，同时续租 | `{ok, lease_until}` |
| `POST /v1/result?id=` | `{task_id, status: completed\|failed\|partial, summary, files[{name,base64,type?,description?}], error?{code,message,retryable}, needs_input?}` | `{ok, task_status}` |
| `GET /v1/artifact?id=&task_id=&name=[&from_task=]` | 只能下载本任务的输入，或 `depends_on` 里上游任务的产出 | 文件字节（`application/octet-stream`） |
| `GET /v1/me?id=` | 只读，不算“出现过” | `{agent_id, status, online, last_seen, left_at, version, node, workspaces, reported_workspaces, ignored_workspaces, capabilities, running_tasks, offline_after_ms, server_time, client_ip}` |
| `POST /v1/leave?id=` | `{reason?}` | `{ok, agent_id, status:"left", requeued, server_time}`；持有的任务立即重排 |

### 5.2 控制方

| 方法 路径 | 请求 | 返回 |
|---|---|---|
| `POST /v1/ctl/dispatch?id=` | v1 的全部字段，再加 `workspace`（`code` 类型必填）、`node`、`ref`、`capability`、`require_online`（布尔）；`created_by` 由 hub 填写 | 任务对象（含 `workspace/node/ref/created_by`）；目标不在线时多一个 `warnings: ["agent-offline"]` 或 `["no-online-worker"]` |
| `GET /v1/ctl/tasks?id=&status=&agent=&workspace=&limit=` | `limit` 1..200，默认 50 | `{generated_at, filter:{status,agent,workspace,limit}, tasks}` |
| `GET /v1/ctl/task?id=&task_id=` | | `{generated_at, task}`（task 含 instruction、inputs、history、result、context） |
| `GET /v1/ctl/output?id=&task_id=&name=` | 只能下载 `result.outputs` 里列出的文件 | 文件字节 |
| `POST /v1/ctl/cancel?id=` | `{task_id, reason?}`，**只有创建者能调用**，否则 403 `not-creator` | 任务对象 |
| `POST /v1/ctl/retry?id=` | `{task_id, agent?}`，**只有创建者能调用** | 任务对象 |
| `GET /v1/ctl/agents?id=` | | `{generated_at, online, agents[{agent_id, status, online, last_seen, left_at, version, node, workspaces, reported_workspaces, capabilities, …}]}` |
| `GET /v1/ctl/requests?id=&status=` | `pending`（默认）\|`approved`\|`rejected`\|`expired`\|`all` | `{generated_at, filter, requests}` |
| `POST /v1/ctl/approve?id=` | `{request_id, capabilities?, workspaces?, max_concurrency?}`，**只能收窄**，放宽会返回 400 `grant-widened` | `{request_id, status, agent}` |
| `POST /v1/ctl/reject?id=` | `{request_id, reason?}` | `{request_id, status}` |
| `POST /v1/ctl/revoke?id=` | `{agent_id}`，被吊销 worker 正在执行的任务会回到队列 | worker 对象 |
| `POST /v1/ctl/provision?id=` | `{agent_id, platform, mode, node, workspaces, capabilities, max_concurrency, description}` | `{agent, token, note}`，令牌只返回这一次 |
| `GET /v1/ctl/overview?id=` | | `{protocol, agents, agent_counts{pending,online,offline,left,revoked}, task_counts, pending_requests}` |
| `GET /v1/health` | 无令牌（但受 IP 白名单限制） | `{ok:true, version:"2.0.0", client_ip}`；`client_ip` 按 trustProxy 规则取（默认 socket 地址） |

列表和详情接口的外层结构（`generated_at`、`filter`）沿用 v1 面板接口 `/api/agent-hub/admin/*` 的格式，插件可以原样转发给面板。

## 6. 路由、工作区和心跳

一个任务派给某个 worker 时，以下条件**必须全部满足**（协议第 4 节）：

1. `agent` 是这个 worker 的 id，或者是 `pool:<能力>` 且这个 worker 有该能力；
2. 任务带了 `workspace` 时，这个工作区**在批准时授予过**（`workspaces`），并且 worker **当前也在上报**（`reported_workspaces`）；
3. 任务带了 `node` 时，必须和 worker 的 `node` 相同。没有 `node` 的 worker 永远领不到限定了 node 的任务；
4. `depends_on` 里的任务都已经 completed，并且这个 worker 正在执行的任务数没有达到 `max_concurrency`；
5. 任务带了 `capability` 时，worker 的能力里要有它（worker 一个能力都没声明时不限）；该能力写成 `name:N` 时，这个 worker 同一能力最多同时跑 N 个。

**一台机器干多种活**：能力写成 `name` 或 `name:N`（N 为 1..32），例如本地 DSH 声明 `["browser:1", "test", "code:2"]`：浏览器任务一次只跑一个，测试和写代码可以同时进行，总数仍受 `max_concurrency` 限制。任务的 `capability` 告诉 worker 用哪条线来跑；`pool:<能力>` 任务自动带上这个能力，派给具体 worker 时可以显式传 `capability`。worker 没有这个能力时 `dispatch` 返回 409 `unroutable`。审批只能调低某个能力的上限（`grant-widened`）。`agents` / `requests` 里多一个 `capability_limits`（例如 `{"browser": 1}`），任务对象和领到的任务里多一个 `capability`。

**心跳上报超出授予范围时：截断，而不是拒绝**（协议要求二选一，这里选的是截断）。worker 的工作区列表是从本机 profile 自动算出来的，经常比授予的多，如果整条心跳被拒，worker 会被误判成离线。所以 hub 只保留授予范围内的名字，多出来的名字在返回值的 `ignored_workspaces` 里列出，同时记一条 warn 日志。不传 `workspaces` 时上报集合保持不变；传 `[]` 表示当前没有可用的工作区。名字格式不合法（`/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/`，最多 64 个）返回 400 `bad-workspaces`。

**第一次心跳之前**：通过申请批准的 worker，把申请里上报的工作区与授予集合的交集当作已上报；`provision` 直接签发的 worker 上报集合为空，要等第一次心跳之后才能领带 workspace 的任务。

**派给具体 worker 时提前报错**：`agent` 是具体 worker id，但该 worker 没有被授予这个 `workspace`，或者 `node` 不一致时，`dispatch`（以及带 `agent` 参数的 `retry`）直接返回 409 `unroutable`，避免任务永远没人领。`pool:` 任务不做这个检查。

`ref` 必须是安全的 git 分支、tag 或 commit：`/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/`，不能以 `-` 开头（防止被当成命令行选项），不能包含 `..` 或 `//`，不能以 `/`、`.`、`.lock` 结尾。

### 6.1 在线状态、对账和重排

完整生命周期见协议第 9 节。hub 侧的实现要点：

- `status`：`pending`（已批准、令牌未领）/ `online`（最近一次 heartbeat、poll、event 或 result 在 `offlineAfterMs` 内，默认 90 s；声明了 `pull_every_seconds` 的定时 worker 再加上这个周期）/ `offline` / `left`（调用了 `/v1/leave`，之后没再出现）/ `revoked`。再次 heartbeat 或 poll 就回到 `online`。
- 心跳带 `running` 时对账：`running` 里不再属于它的任务列进 `abort`；hub 记为它持有、它却没报的任务立即重排（`worker-lost`，计一次尝试），租出不到 30 秒的除外（poll 的响应可能还在路上）。不带 `running` 不对账。
- 认领：任务因为持有者离线、租约过期或失联被重排后，只要还没有别人领走，原持有者在 `running` 里报它（列进 `reclaimed`，不叫停），或直接交进度 / 结果，任务就还给它，不算新的一次尝试。
- 角色：`worker`（默认）接任何任务，`tester` 只接测试类任务，`dispatcher`、`observer` 不接任务。注册和 provision 时可带 `role`，批准时只能收窄（`role-widened`）；派给不接这类任务的 worker，或整个 pool 没有一个能接，直接 400（`role-not-dispatchable` / `role-not-testable`）。
- sweep：持有任务的 worker 变成 `offline` / `left` 时立即重排（`worker-offline`），不等租约到期；租约到期的规则不变。
- dispatch：具体 agent 未注册 404 `agent-not-found`、已申请未批准 409 `agent-not-approved`、已吊销 409 `agent-revoked`；不在线照常入队但返回 `warnings: ["agent-offline"]`，`require_online: true` 时改为 409 `agent-offline`。`pool:` 任务没有任何在线且满足条件的 worker 时返回 `warnings: ["no-online-worker"]`（`require_online` 时 409）。分配仍然只发生在 worker 自己 poll 的时候。

## 7. 长轮询

`GET /v1/poll?...&wait=N`：有任务就立即返回；没有任务时最多等 N 秒（上限 55 秒）。以下事件会唤醒**能接这个任务的 worker** 上正在等待的请求（`EventEmitter`，事件名 `wake:<id>`）：派活、重试、重新排队（租约过期、可重试的失败、worker 被吊销）、取消正在执行的任务（空出并发位）、交结果（空出并发位，或者下游任务的依赖刚刚满足）、心跳让上报的工作区发生了变化、批准后第一次领取令牌。

- 客户端在等待期间断开连接：等待立刻结束，**不会领任务**，监听器也会被清理。如果任务已经领到、但响应来不及写出去连接就断了，这些任务会立即交还（`released`，不计入尝试次数）。
- 每个 worker 最多同时有 8 个等待中的长轮询，再多返回 429 `too-many-waiters`。
- 服务收到 SIGTERM 或 SIGINT 时，所有等待中的长轮询立即返回空结果，然后进程退出。

## 8. 安全要点

- 令牌只放在请求头 `X-DSH-Token`。query 里出现 `token` 会被拒绝，因为 query 会进入代理和访问日志。worker 令牌（`dsha_`）和控制方令牌（`dshc_`）都只保存 sha256，校验时用常量时间比较。控制方令牌只能在 hub 机器上用 CLI 签发，没有任何 HTTP 接口能创建控制方。
- query 的 `id` 必须是令牌的主人，否则返回 401；角色不对返回 403。
- **控制方隔离**：取消和重试只有 `created_by` 那个控制方能做；查看对所有控制方开放。审批、吊销、provision 没有做隔离，任何控制方都可以操作。
- 不配 TLS 时只能监听 127.0.0.1，否则拒绝启动。TLS 最低版本 1.2。
- 默认不信任 X-Forwarded-For。设置 `trustProxy: true` 后只取最右边一段。白名单不会自动放行回环地址。
- 只读取请求头 `content-length` 就能判断超限的请求，在读请求体之前就返回 413；请求体是边读边计数的，超过上限就停止缓存，剩余数据直接丢弃，然后关闭连接。
- 状态文件和 `controllers.json` 以 0600 权限原子写入；systemd 设置了 `UMask=0077`。
- hub 不读取任何口令或密钥库，只读取 `tls.key` 这个路径指向的私钥文件（见第 3 节的权限检查）。

## 9. 测试

```bash
cd services/dsh-hub
node --test tests/*.test.mjs
```

| 文件 | 内容 |
|---|---|
| `tests/hub.test.mjs` | v1 的 42 个 hub 用例移植到 v2 接口（控制方作为第一个参数传入） |
| `tests/hub-v2.test.mjs` | 控制方注册表、CLI 改动立即生效、mutation 内复查吊销、node 和 workspaces、只能收窄、心跳截断、四个路由条件、409 unroutable、创建者隔离、v1 state 升级、长轮询（被 dispatch、retry、重新排队、心跳、上游完成唤醒；超时；断开；交还；上限；close；等待期间被吊销） |
| `tests/http.test.mjs` | IP 和 CIDR、`::ffff:` 地址、X-Forwarded-For、URL 和 query 解析、路由表、监听地址检查；handler：health、id 与令牌不一致 401、worker 令牌调 `/ctl` 403、白名单、trustProxy、enroll、body 上限 413、415、400、完整流程、控制方隔离、管理接口、HTTP 长轮询及断开、500 不泄露细节；`e2e:` 开头的用例会启动真实的 node:http 服务 |
| `tests/config.test.mjs` | hub.json 默认值（端口 7891、offlineAfterMs 90000）和校验、`DSH_HUB_PORT`、没有 TLS 时拒绝非回环地址、TLS 路径、私钥权限检查、CLI |
| `tests/presence.test.mjs` | 状态 pending→offline→online→offline→left→online→revoked、`agent_counts`、`client_version` 校验、心跳 `running` 对账（`abort`、`worker-lost` 重排、30 秒宽限、不带 running 不对账）、leave 立即重排并唤醒别的 worker、offline 持有者被 sweep 重排（进度事件算在线）、dispatch 404/409/`warnings`/`require_online`（具体 agent 和 pool）、`me()`、HTTP `/v1/me`、`/v1/leave`、health 的 `client_ip`（含 trustProxy）、白名单 403 只回调用方自己的 `client_ip` |

开发机（Windows，不能运行 node）上的验证方式：把 `lib/*` 和测试改写成 CommonJS 后，在云端 JS 沙箱里执行。沙箱没有 `node:http`，所以除了唯一的 `e2e:` 用例，其余 112 个用例全部通过（含 `presence.test.mjs` 的 13 个）。另外做过变异测试，每一处都至少有一个用例失败：早先的 8 处（去掉"当前上报"条件、去掉创建者检查、去掉 id 与令牌一致的检查、去掉角色检查、X-Forwarded-For 取最左边一段、dispatch 不唤醒、心跳不截断、dispatch 内不复查控制方），以及这次的 6 处（去掉心跳对账、去掉 30 秒宽限、去掉 offline 重排、忽略 `require_online`、403 不带 `client_ip`、进度事件不算在线）。**在真实 Node 22 上执行 `node --test` 和 e2e 用例，需要在服务器上进行。**

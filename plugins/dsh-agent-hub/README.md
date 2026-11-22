# dsh-agent-hub · DSH 作为 dsh-hub 的控制方

协议：`dsh-agent/2.0`（接口契约见 [`docs/DSH-HUB-PROTOCOL-v2.md`](../../docs/DSH-HUB-PROTOCOL-v2.md)）。Node >= 22。

v1 时 hub 运行在 DSH web server 里；v2 把 hub 拆成**独立服务 dsh-hub**（`services/dsh-hub`，端口 7891，部署方法见 [`services/dsh-hub/README.md`](../../services/dsh-hub/README.md)）。这个插件现在只是 hub 的**控制方客户端**：

- 插件**不保存任何任务状态，也不运行租约清扫**。任务、租约、重试、产物都由 hub 负责。
- 插件把 11 个 DSH 专用工具转成对 hub `/v1/ctl/*` 的调用。
- 插件保留调度面板的只读接口 `/api/agent-hub/admin/*`（路径和返回字段与 v1 相同），数据从 hub 获取，再按原来的白名单整理后返回。
- worker（AWS Quick、Claude Code、Kiro……）**直接连接 hub**，不再经过 DSH。原来的 `/api/agent-hub/v1/*` worker 路由已经删除。

```
  DSH (dsh-cloud) ──┐  X-DSH-Token: dshc_…            ┌── quick-mydesk  (worker, dsha_…)
  DSH (dsh-local) ──┼──── https://<hub>:7891/v1/ctl/* │   (MYDESK: via proxy http://127.0.0.1:7890)
                    │                     dsh-hub ────┼── kiro-mydesk
  面板 ── DSH 登录 ── /api/agent-hub/admin/* ─┘          └── claude-cloud
```

## 1. 目录

```
plugins/dsh-agent-hub/
├── index.js / package.json / cordis.patch.yml / icon.svg / locale/
├── packages/host-agent-hub/
│   ├── index.js       挂载：读配置 → 注册 11 个工具 + 面板路由；配置缺失时只给 warning
│   ├── hub-client.js  /v1/ctl/* 客户端（node:https request + ca、?id=、X-DSH-Token、超时、错误映射、脱敏）
│   ├── proxy.js       HTTP 代理：CONNECT 隧道 + TLS（parseProxyUrl / shouldBypass / buildConnectRequest / openTunnel）
│   ├── env-file.js    .env 解析（不依赖第三方库）
│   ├── tools.js       11 个 DSH 专用工具
│   ├── bridge.js      /api/agent-hub/admin/*（requireLogin + 白名单整形 + 503 hub-unreachable）
│   ├── hub.js         v1 本地 hub，仅保留作参考；插件已不再加载（v2 实现在 services/dsh-hub）
│   └── tests/         node:test 测试（不依赖真实 hub，使用假的 request 和假的 fs）
├── packages/client-ui-agent-hub/   只读调度面板：嵌在 router-b 任务板里的「Agent」tab（router-b 没装时退回左侧栏一行 + 整页），见第 5.1 节
└── scripts/install.mjs / agent_client.py（worker 客户端）/ worker.env.example / profile.example.json
```

## 2. 安装

```bash
node plugins/dsh-agent-hub/scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run
node plugins/dsh-agent-hub/scripts/install.mjs --profile /root/.dsh/profiles/web
# 1) 在 hub 机器上为这个 DSH 签发控制方令牌（只显示一次）：
#      node services/dsh-hub/server.mjs controller add dsh-cloud
# 2) 把令牌放进 DSH 服务的环境变量，或者写进 <DSH home>/.env（见第 3.2 节）
# 3) 确认 cordis.patch.yml 里的 hubUrl / controllerId 正确，然后由运维决定何时重启。日志里应该能看到：
#      agent-hub: controller token from environment variable DSH_HUB_TOKEN   （或 from /root/.dsh/.env (DSH_HUB_TOKEN)）
#      agent-hub: mounted /api/agent-hub/admin/* (login, read-only, forwarded to the hub)
#      agent-hub: 11 control tools registered (agent_*, task_*); controller of https://127.0.0.1:7891 as dsh-cloud
#      （MYDESK 上的 dsh-local：controller of https://hub.example:7891 as dsh-local via proxy http://127.0.0.1:7890）
```

配置或令牌缺失时，插件**照常加载**，日志中会给出 warning；此时每个工具调用和面板请求都会返回明确的错误码（`hub-not-configured` / `hub-token-missing`），不会导致 DSH 启动失败。

## 3. 配置与令牌

### 3.1 配置项（`cordis.patch.yml` → `host-agent-hub.config`）

| 键 | 含义 | 默认值 |
|---|---|---|
| `hubUrl` | hub 的基础地址。远程 hub 用 `https://<hub-host>:7891`；只有 `127.0.0.1` / `localhost` / `[::1]` 才允许用 `http://`（没有配置 TLS 的 hub 只监听回环地址）。地址里不能带用户名密码、query 或 fragment；可以带路径前缀（`https://proxy/hub` 会请求 `/hub/v1/ctl/...`）。 | 无（必填）；样例里写的是 `https://127.0.0.1:7891`，适用于 hub 和 DSH 在同一台机器（dsh-cloud）。hub 配了 TLS 后只提供 https，所以同机也要用 https 并配 `caFile`（证书 SAN 要包含 127.0.0.1）；只有 hub 不配 TLS、只监听回环时才用 `http://` |
| `controllerId` | 这个 DSH 在 hub 上的控制方 id，需匹配 `/^[a-z][a-z0-9-]{1,47}$/`，例如 `dsh-cloud`、`dsh-local`。每个请求都会带上 `?id=<controllerId>`。 | 无（必填） |
| `caFile` | hub 证书（自签）或其 CA 的 PEM 文件。配置后它是验证 hub 证书的**唯一**信任根；不配置时使用系统 CA。只对 `https://` 生效。 | 不设置 |
| `timeoutMs` | 单次请求 hub 的超时时间，取值为 1000..120000 的整数。配置非法时给出 warning 并使用默认值。 | `15000` |
| `tokenEnv` | 存放控制方令牌的**变量名**，进程环境变量和 `.env` 文件都按这个名字查找。 | `DSH_HUB_TOKEN` |
| `envFile` | 进程环境里没有令牌时读取的 `.env` 文件。 | `<DSH home>/.env`，其中 DSH home = `$DSH_HOME`，未设置时为 `~/.dsh` |
| `proxy` | 怎样连到 `https://` hub。`http://host:port`：总是经过这个 HTTP 代理（可带 `user:pass@`，转成 `Proxy-Authorization: Basic`，凭据不进日志和错误信息；只支持 http:// 代理，不支持 SOCKS）。`env`：读 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`（每次调用重新读），`NO_PROXY` / `no_proxy` 命中 hub 主机时直连（逗号分隔：主机名、`.后缀`、`*.后缀`、`host:port`、`*`；不支持 CIDR）。`http://` 回环 hub 永远直连（配了 proxy 只给 warning）。代理连不上、CONNECT 非 200、隧道里 TLS 失败、超时都返回 503 `hub-unreachable`，message 说明是哪一步。示例：MYDESK 上的 dsh-local 填 `http://127.0.0.1:7890`（Clash/mihomo）；和 hub 同机的 dsh-cloud 不填。 | 不设置 = 直连 |

v1 的配置项（`dataDir`、`publicUrl`、`offlineAfterMs`、`sweepIntervalMs`、`maxRetries`、`maxPendingRequests`、`maxResultBytes`）会被忽略，并给出一条 warning。这些设置现在属于 hub 自己的 `<DSH home>/agent-hub/hub.json`。

**为什么不用 fetch**：Node 原生 `fetch` 不能为单个请求指定 CA，只能通过 `NODE_EXTRA_CA_CERTS` 影响整个进程。因此 `hub-client.js` 使用 `node:https` / `node:http` 的 `request()`，并传入 `ca`（来自 `caFile`）和 `timeout`。`caFile` 在第一次请求时读取并缓存；读取失败时返回 `503 hub-ca-unreadable`，下次请求会重新尝试读取。

**代理**：`https.request` 不读 `HTTPS_PROXY`，所以配置了 `proxy` 时由 `proxy.js` 自己建隧道：先用 `node:http` 向代理发 `CONNECT <hub>:<port> HTTP/1.1`，收到 200 后在返回的 socket 上做 `node:tls` 握手（`servername` = hub 主机名，IP 地址不发 SNI 但仍校验证书里的 IP；`ca` = `caFile`），再把这条 TLS 连接通过 `createConnection` 交给 `https.request`。每个请求一条隧道，令牌只在隧道内的 TLS 里，代理看不到。

### 3.2 控制方令牌

令牌格式为 `dshc_<controllerId>_<随机>`，**只能在 hub 机器上用 CLI 签发**（`node server.mjs controller add <id>`，只显示一次）。

**查找顺序**（每次调用都会重新查找，所以轮换令牌后不需要重启）：

1. 进程环境变量 `<tokenEnv>`（默认 `DSH_HUB_TOKEN`），值不为空就使用它；
2. 否则读取 `envFile`（默认 `<DSH home>/.env`）里 `<tokenEnv>=…` 这一行。

两处都找不到时返回 `hub-token-missing`。找到的令牌如果不是 `dshc_<controllerId>_` 开头（例如属于别的控制方，或者是 worker 令牌），插件会直接返回 `hub-token-mismatch`，**不会发出请求**。

`.env` 格式（解析器在 `env-file.js`，不依赖第三方库）：

```dotenv
# dsh-hub controller token for this DSH
DSH_HUB_TOKEN=dshc_dsh-cloud_xxxxxxxxxxxxxxxx
# 下面几种写法同样有效：
export DSH_HUB_TOKEN="dshc_dsh-cloud_xxxxxxxxxxxxxxxx"
DSH_HUB_TOKEN='dshc_dsh-cloud_xxxxxxxxxxxxxxxx'   # 行尾注释
```

- 每行一个 `KEY=值`。空行和 `#` 开头的行会被忽略。`export ` 前缀会被忽略。值两边的单引号或双引号是可选的，引号内的内容按字面取值。不加引号时，值后面的 ` #` 开始注释。格式不对的行会被跳过。同一个键出现多次时，以最后一次为准。支持 BOM 和 CRLF。
- 文件不存在时**静默跳过**。
- **权限**：这个文件里存的是密钥，请执行 `chmod 600 <envFile>`（只有属主可以读写）。在 POSIX 系统上，如果文件对组或其他用户可读（`mode & 044`），插件仍然会使用它，但会打印**一次** warning。在 Windows 上不检查权限位，请把文件放在用户目录下（默认 ACL 只允许本人访问）。

**令牌不会出现在任何输出里**：

- 令牌只通过请求头 `X-DSH-Token` 发送，**不会放进 URL**（hub 也会拒绝 query 里的 token）。
- 日志只记录令牌的**来源**（来自环境变量还是来自哪个文件），从不记录令牌的值；请求日志只包含方法、路径、状态码和耗时。
- 所有错误信息都会经过 `redact()` 处理：配置的令牌值，以及任何形如 `dshc_…` / `dsha_…` 的字符串，都会被替换为 `***`。即使 hub 在错误信息里回显了令牌，也不会外泄。
- 工具输出在返回前会经过 `scrub()`，确保控制方令牌不会出现在结果里。`agent_provision` 返回的**worker** 令牌是有意只显示一次的，不受这项处理影响。
- 面板接口的返回经过白名单整形，自由文本里的令牌形状字符串都会被遮蔽。

## 4. 工具（只有 DSH 模型能调用）

工具名称与 v1 完全一致，每个工具对应一次 `/v1/ctl/*` 调用：

| 工具 | hub 接口 | 说明 |
|---|---|---|
| `task_dispatch` | `POST /v1/ctl/dispatch` | **新增** `require_online`：目标不在线时 409 拒绝而不是入队；默认入队，hub 返回的 `warnings`（`agent-offline` / `no-online-worker`）原样带回给 DSH。参数与 v1 相同，并**新增** `workspace`（工作区**名**，不是路径；`type: "code"` 时必填，插件会在本地先检查）、`node`（限定在哪台机器执行）、`ref`（git 分支或 commit）。`created_by` 由 hub 填写。 |
| `task_list` | `GET /v1/ctl/tasks?status=&agent=&workspace=&limit=` | **新增** `workspace` 筛选 |
| `task_get` | `GET /v1/ctl/task` (+ `GET /v1/ctl/output`) | 传入 `output_name` 时，同时读取产出文件的前 60000 个字符 |
| `task_cancel` / `task_retry` | `POST /v1/ctl/cancel` / `retry` | 只有创建这个任务的控制方才能操作（由 hub 检查，否则返回 403 `not-creator`） |
| `agent_list` | `GET /v1/ctl/agents` | 每个 worker 带 `status`（pending / online / offline / left / revoked）、`last_seen`、`version` |
| `agent_requests` | `GET /v1/ctl/requests?status=` | 默认 `pending` |
| `agent_approve` | `POST /v1/ctl/approve` | **新增** `workspaces` 参数。只能收窄 `capabilities` / `workspaces` / `max_concurrency`，不能扩大 |
| `agent_reject` | `POST /v1/ctl/reject` | |
| `agent_revoke` | `POST /v1/ctl/revoke` | |
| `agent_provision` | `POST /v1/ctl/provision` | 直接签发 worker。额外支持 `node` 和 `workspaces` 参数（契约里没有写明这部分，见第 7 节）。返回的 `endpoint` 是 `<hubUrl>/v1`，worker 直接连接 hub |

出错时工具抛出 `HubError`，消息格式为 `[code] 说明`，例如 `[hub-token-missing] DSH_HUB_TOKEN is not set (neither in the environment nor in /root/.dsh/.env): …`。hub 返回的错误（`404 task-not-found`、`403 not-creator`、`400 bad-task` 等）会保留原来的状态码和 code。

## 5. 调度面板

`packages/client-ui-agent-hub` 是 DSH Web 客户端里的**只读**调度面板，现在作为 router-b 任务板的「Agent」tab 嵌入（见第 5.1 节）。插件提供的接口如下：

| 路径（GET，需要 DSH 登录） | 转发到 | 返回（字段与 v1 相同，见 `src/client/contract.ts`） |
|---|---|---|
| `/api/agent-hub/admin/overview` | `/v1/ctl/overview` | `{protocol, agents, task_counts, pending_requests}` |
| `/api/agent-hub/admin/agents` | `/v1/ctl/agents` | `{generated_at, online, agents:[…]}` |
| `/api/agent-hub/admin/tasks?status=&agent=&limit=` | `/v1/ctl/tasks` | `{generated_at, filter, tasks:[…]}` |
| `/api/agent-hub/admin/task?task_id=` | `/v1/ctl/task` | `{generated_at, task:{…}}` |
| `/api/agent-hub/admin/requests?status=` | `/v1/ctl/requests` | `{generated_at, filter, requests:[…]}` |

- 登录校验（`requireLogin`）在请求 hub **之前**完成：未登录返回 401，无权限返回 403，登录服务不可用返回 503。
- query 参数先在本地校验，非法时返回 400 `bad-query`，不会请求 hub。非 GET 请求返回 405。
- hub 的返回会重新按 v1 的白名单投影（`adminAgent` / `adminTaskRow` / `adminTaskDetail` / `adminRequest` / `adminOverview`）。`context` 只返回键名；产出文件只返回文件名、大小、类型和描述，不返回路径和内容。agent 行新增 `status`（pending / online / offline / left / revoked）和 `version`（客户端版本），原有字段不变；agent 行还会带 `left_at`（主动下线时间），overview 带 `agent_counts`（各状态的 agent 数，只保留 5 种状态的非负整数）；`contract.ts` 里它们是可选字段，旧版 hub 没有这两个字段时面板退回 `last_seen` 和自己统计 agent 列表；v2 新增的 `node` / `workspaces` / `workspace` / `ref` / `created_by` 目前**不会**出现在面板接口里，因为 `contract.ts` 还没有定义这些字段。

错误码：

| 情况 | 状态码 | `error.code` |
|---|---|---|
| hub 连不上：连接被拒、DNS 失败、TLS 验证失败、超时 | 503 | `hub-unreachable` |
| 本地配置问题 | 503 | `hub-not-configured` / `hub-token-missing` / `hub-token-mismatch` / `hub-ca-unreadable` |
| hub 拒绝控制方令牌（hub 返回 401 或 403） | 502 | `hub-unauthorized`（**不使用 401**：面板会把 401 理解成“需要重新登录 DSH”） |
| hub 返回 5xx，或返回内容不是合法 JSON | 502 | `hub-error` / `hub-bad-response` |
| hub 返回其他 4xx | 原状态码 | hub 的 code（例如 404 `task-not-found`） |

面板对 503 和 502 会显示“宿主插件不可用（错误信息）”，错误信息里能看到上表中的原因。

### 5.1 面板放在哪里：任务板的「Agent」tab（router-b 没装时才用左侧栏）

面板主要入口是 **router-b 右侧任务板（工作板）的分段 tab**，和「现在 / 已结束 / 工作区」并列，标题「Agent」（英文 “Agents”）。
两个插件各自打包、不能互相 import，所以通过一个挂在 `globalThis.__dshRouterBoardTabs__` 上的注册表（`v: 1`）对接：
`src/client/board-tabs.ts` 在两个插件里**逐字节相同**，谁先加载谁创建，另一方复用。

- 注册：`id: 'agent-hub'`、`order: 100`、`label` = locale `board.tab`、`Component` = `AgentHubPage` 的嵌入模式。
- 徽标 = **待审批的加入申请数**（为 0 时不显示）。选它而不是离线 agent 数：申请是这页上唯一需要人去处理的东西（在 DSH 对话里 `agent_approve` / `agent_reject`）；离线常常是正常状态（机器休眠、按需启动的 runner），一直挂着数字反而让人忽略它。tab 没打开时每 30 秒读一次 `overview`（只在有任务板、浏览器标签页可见时）；tab 打开时由页面自己的 10 秒刷新顺带更新。**警示点**：没有待审批申请、但有离线或已下线的 agent 还占着任务时，tab 上显示一个小圆点（任务板的 `.dshrc-tab-flag`，和「现在」tab 的等待点同一样式），悬停和读屏文字是「n 个离线 agent 还占着 m 个任务（掉线后会自动重排）」。有待审批时只显示数字，不显示圆点，避免两个信号叠在一起。hub 会自己把这些任务按 `worker-offline` 重排，所以圆点只是提醒，不需要操作。实现上用的是 board-tabs v1 新增的可选字段 `flag`；旧版任务板不认识它，只会不显示圆点。
- 在线状态（协议第 9 节，整页和嵌入模式都一样）：agent 的状态点和文字按 `status` 显示 5 种状态，tone 为 在线 = ok、待接入（pending）= warn、离线 = idle、已下线（left）= idle、已吊销 = bad；旧版 bridge 没有 `status` 字段时按 `revoked` / `online` 推断（已吊销 / 在线 / 离线）。第二行显示客户端版本（有才显示）和「最后心跳 n 秒前」，离线或已下线时显示「离线 n 分钟」（已下线优先按 `left_at` 计算，没有就用 `last_seen`），忙 / 闲只在在线时显示。列表顺序是 在线 → 待接入 → 离线 → 已下线 → 已吊销，同一状态内保持 hub 返回的顺序；Agent 分组标题旁会弱化显示离线数（离线 + 已下线，大于 0 时才显示）。统计格「在线 agent」显示 在线/总数，悬停时列出各状态的数量（有 `agent_counts` 就用它，否则统计 agent 列表）。任务详情的历史记录里，凡是 event 或 message 里带有 `worker-lost` / `worker-offline` / `agent-offline` 的条目都会用 warn 色标出，并附一句说明。
- 嵌入模式：无大标题和页面留白，一行工具条（更新时间 / 自动刷新 / 刷新）；三个统计格一行；七个任务状态是一行可横向滚动的胶囊（点一下即筛选）；Agent / 加入申请 / 任务是三个可折叠分组（两行式列表代替表格，折叠状态记在 sessionStorage）；任务详情在列表里该行下方展开。自动刷新周期不变，tab 不在屏幕上（切到别的 tab、右侧栏收起、浏览器标签页隐藏）时暂停，回到屏幕立刻补刷一次。
- **左侧栏入口只作兜底**：插件启动 3 秒后注册表里仍没有任务板声明自己（`hasConsumer()` 为假，即 router-b 没装或没加载），才注册 `sidebar.panellist` 那一行，点开是原来的整页（`main` 面板 `agent-hub/page` 一直保留）。之后任务板一出现，这一行就撤掉；任务板消失 3 秒后再加回来。
- 只装 agent-hub、不装 router-b：行为和以前一样（左侧栏一行 + 整页），只是晚 3 秒出现。

## 6. 测试

```bash
cd plugins/dsh-agent-hub
node --test packages/host-agent-hub/tests/*.test.mjs
```

| 文件 | 内容 |
|---|---|
| `hub-client.test.mjs` | URL 和路径前缀、`?id=` 必须是第一个 query 参数、`X-DSH-Token` 头、令牌不进 URL、POST 的 body 和 content-type、`health` 不带令牌、`timeout` / `ca` 选项、`caFile` 缓存与读取失败后重试、hub 返回结构的兼容、错误映射（hub 4xx/5xx、ECONNREFUSED、TLS、socket 超时、整体超时、`request()` 直接抛异常）、缺令牌 / 令牌不匹配 / 未配置时不发请求、令牌不进日志和错误信息；令牌优先级（环境变量 > .env）、`DSH_HOME` 与 `~/.dsh` 的默认值、`tokenEnv` 改名、轮换令牌无需重启、.env 权限 warning 只出现一次且不含令牌值 |
| `proxy.test.mjs` | `parseProxyUrl`（只收 http://、默认端口 80、凭据转 Basic、显示脱敏）、`buildConnectRequest`（`CONNECT host:port HTTP/1.1`、Host、Proxy-Authorization 只在有凭据时）、`buildTlsOptions`（IP 不发 SNI）、`shouldBypass`（`*`、主机名、后缀、端口）、`proxySetting` / `resolveProxy`（off、URL、env 的顺序与 NO_PROXY、http 回环永远直连）；用假的 `node:http` / `node:tls` 跑 `openTunnel`：成功、代理连不上、CONNECT 403 / 502、407（以 response 形式）、TLS 证书失败、两段超时，消息里都没有代理凭据；hub 客户端经隧道发请求（`createConnection`、令牌不出现在 CONNECT 里、日志脱敏）、隧道失败映射为 503 `hub-unreachable`、env 模式每次重读 |
| `env-file.test.mjs` | `.env` 解析（注释、export、单双引号、行尾注释、CRLF、BOM、格式错误的行、同名键以最后一次为准、`__proto__`），文件不存在静默跳过，640/604/644/666 给出 warning、600/700 不给，Windows 不检查，目录或不可读文件给出 warning 且不泄露内容 |
| `tools.test.mjs` | 11 个工具名、schema（不接受未知参数）、新增参数、并发安全标记、每个工具对应的 hub 调用、`code` 类型必须带 workspace、错误格式为 `[code]`、令牌不进工具输出 |
| `bridge.test.mjs` | 只剩 5 个 admin 路由、各接口的白名单整形与令牌遮蔽、query 校验、405、503 `hub-unreachable`、本地配置错误时返回 503、401/403 映射为 502 `hub-unauthorized`、500 不返回细节、`requireLogin` |
| `index.test.mjs` | 注册 11 个工具和 5 个路由、没有 `/v1` 路由、warning（缺配置、缺令牌、不安全的 http、v1 配置项、非法超时）、hub 不可用（`127.0.0.1:1`）时返回 503、从真实 .env 文件读取令牌、dispose 后全部注销 |

测试不会访问真实 hub，也不会读取真实的 `~/.dsh/.env`：`hub-client` 注入假的 `request` 和假的 `fs`；`index.test.mjs` 的 `envFile` 指向一个不存在的路径，或者指向测试中创建的临时文件。

## 7. 已知限制 / 待办

- 契约第 5.2 节没有写明 `cancel` / `retry` / `reject` / `revoke` / `provision` 的请求体，以及各个接口的返回结构。本插件采用的字段是 `{task_id, reason}`、`{task_id, agent}`、`{request_id, reason}`、`{agent_id}`，`provision` 使用与 enroll 相同的字段并加上 `agent_id`。这些已经和 `services/dsh-hub/lib/http.js` 的实现核对过，两边一致；列表接口同时兼容 `{tasks:[…]}` 和直接返回数组两种形式。
- 契约第 6 节提到“或存进 dsh-secrets”，这一项还没有实现。目前支持的来源是环境变量和 `.env` 文件。
- 代理：真实 Clash/mihomo 的 CONNECT 行为（端口限制、空闲超时）没有在开发机上实测，测试用的是假的 `node:http` / `node:tls`。

## 8. 在新设备上接入 worker

worker 目录固定是 `<DSH home>/worker/`（DSH home = `$DSH_HOME` 或 `~/.dsh`），里面放 `.env`、`profile.json` 和令牌文件。完整的配置项和优先级（命令行 > 进程环境变量 > `worker/.env` > `profile.json` > 默认值）见 `python agent_client.py --help`，状态机见协议第 9 节。

1. **生成模板**：`python plugins/dsh-agent-hub/scripts/agent_client.py init`（已存在的文件不会覆盖），会打印下一步。
2. **填 `.env` 和 `profile.json`**（样例 `scripts/worker.env.example`、`scripts/profile.example.json`）：

   ```dotenv
   # C:/Users/<you>/.dsh/worker/.env（MYDESK）
   DSH_HUB_URL=https://<server>:7891
   DSH_HUB_PROXY=http://127.0.0.1:7890     # 本机 Clash/mihomo；off = 直连；env = 系统 / 环境变量代理
   DSH_HUB_CAFILE=                          # 自签证书时填 CA 路径
   DSH_AGENT_ID=quick-mydesk
   DSH_NODE=mydesk
   DSH_PLATFORM=aws-quick
   DSH_CAPABILITIES=code,document
   DSH_MAX_CONCURRENCY=1
   DSH_AGENT_TOKEN_FILE=agent.token         # 相对 worker 目录；register 成功后自动写入（600）
   DSH_EXCHANGE=E:/dsh-exchange
   DSH_HEARTBEAT_SECONDS=30
   ```

   ```json
   { "node": "mydesk", "dshProfile": "C:/Users/<you>/.dsh/profiles/web", "workspaces": { "deepseek-harness": "E:/PythonProject/dsh-warroom" } }
   ```

   然后 `python agent_client.py check`：确认经代理能到 hub，并记下 `seen as:` 后面的出口 IP（它要在服务器 `hub.json` 的 `allow` 里；Clash 里 hub 地址要固定走一个代理节点，见协议第 8 节）。旧的 `workspaces.json` 仍然能用（`profile.json` 不存在时读它，并提示迁移）。
3. **注册并上线**：`python agent_client.py register` → 在 DSH 对话里 `agent_requests` 看到申请、`agent_approve`（可以收窄 workspaces / capabilities / max_concurrency）→ register 自动领到令牌并写入 `agent.token` → `python agent_client.py run` 常驻（心跳 + 长轮询）。之后 `status` 查看 hub 眼里的自己，`leave` 主动下线（持有的任务立即重排）。只能定时运行的 agent（AWS Quick）用 `bridge --once`。

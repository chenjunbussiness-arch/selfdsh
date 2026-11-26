# dsh-agent-hub · Agent 调度中心（DSH 作为 dsh-hub 的控制方）

## 这是什么

让 DSH 给外部 agent（AWS Quick、Claude Code、Kiro……）**派任务、看进度、收结果**。任务本身由服务器上独立运行的 **dsh-hub**（`services/dsh-hub`，端口 7891）保存和调度；这个插件只是 DSH 这一端的**控制方客户端**，每台跑 agent 的机器上再跑一个 worker 客户端 `scripts/agent_client.py`。

协议：`dsh-agent/2.0`（接口契约见 [`docs/DSH-HUB-PROTOCOL-v2.md`](../../docs/DSH-HUB-PROTOCOL-v2.md)）。Node >= 22。

v1 时 hub 运行在 DSH web server 里；v2 把 hub 拆成**独立服务 dsh-hub**（`services/dsh-hub`，端口 7891，部署方法见 [`services/dsh-hub/README.md`](../../services/dsh-hub/README.md)）。这个插件现在只是 hub 的**控制方客户端**：

- 插件**不保存任何任务状态，也不运行租约清扫**。任务、租约、重试、产物都由 hub 负责。
- 插件把 14 个 DSH 专用工具转成对 hub `/v1/ctl/*` 的调用。
- 插件保留调度面板的只读接口 `/api/agent-hub/admin/*`（路径和返回字段与 v1 相同），数据从 hub 获取，再按原来的白名单整理后返回。
- worker（AWS Quick、Claude Code、Kiro……）**直接连接 hub**，不再经过 DSH。原来的 `/api/agent-hub/v1/*` worker 路由已经删除。

```
  DSH (dsh-cloud) ──┐  X-DSH-Token: dshc_…            ┌── quick-mydesk  (worker, dsha_…)
  DSH (dsh-local) ──┼──── https://<hub>:7891/v1/ctl/* │   (MYDESK: via proxy http://127.0.0.1:7890)
                    │                     dsh-hub ────┼── kiro-mydesk
  面板 ── DSH 登录 ── /api/agent-hub/admin/* ─┘          └── claude-cloud
```

## 装好后在哪里看到

- **任务板（router-b 右侧工作板）第一个 tab 是「调度台」**：云端 hub 上的全部任务（包括各台 DSH 本机派的任务）按 排队 / 已领取 / 进行中 / 等你回复 / 已结束 分组；agent 按 DSH profile 分组，DSH 自己的 worker 并列显示；DSH 兜底做的任务单独一栏并写明原因；任务详情里有时间线和完整会话记录。没装 router-b 时改为**左侧栏一行「Agent 调度」**，点开是整页。
- **本机任务自动上云**（见第 5.2 节）：这台 DSH 的路由器跑的每个任务都会登记到 hub，进度、会话记录、结果随时上传；断网时攒着，连上后补发。别的 agent 和 DSH 做的任务，进度会以【进度提醒】发到本机作战室。
- **DSH 模型多 14 个工具**（只有 DSH 能调用）：`task_dispatch` / `task_list` / `task_get` / `task_cancel` / `task_retry`，`agent_list` / `agent_requests` / `agent_approve` / `agent_reject` / `agent_revoke` / `agent_provision`，以及兜底用的 `fallback_list` / `fallback_take` / `fallback_submit`。
- **DSH 启动日志**：`agent-hub: config hubUrl=https://<server>:7891 (C:\Users\<你>\.dsh\agent-hub\controller.env (DSH_HUB_URL)), controllerId=…`（每项后面括号里是它的来源） 和 `agent-hub: controller token from …`（只写来源，不写令牌）。

## 快速上手（6 步）

以 MYDESK 上的 DSH（控制方 `dsh-local`）连服务器 `<server>` 上的 hub 为例：

1. **服务器上 hub 要先跑起来**：按 [`services/dsh-hub/README.md`](../../services/dsh-hub/README.md) 部署。在 MYDESK 上验证：
   `curl -k https://<server>:7891/v1/health`（直连；不通再试 `curl -k -x http://127.0.0.1:7890 …` 走本机 Clash，7891 才是 hub）。
2. **在服务器上签发控制方令牌**（只显示一次，马上复制）：
   `node services/dsh-hub/server.mjs controller add dsh-local`　→　`dshc_dsh-local_…`
3. **装插件**：`node plugins/dsh-agent-hub/scripts/install.mjs --profile <DSH profile 目录> --dry-run`，确认后去掉 `--dry-run` 再跑一次，然后重启 DSH 一次。
4. **写配置**：把插件根目录的 [`controller.env.example`](controller.env.example) 复制成 `<DSH home>/agent-hub/controller.env`（MYDESK：`C:\Users\<你>\.dsh\agent-hub\controller.env`），**只需要填 `DSH_HUB_TOKEN`**，地址和控制方 id 已经按 MYDESK 填好，默认直连（`DSH_HUB_PROXY=off`）。改这个文件不用重启 DSH。
   ⚠ 不要写进 `<DSH home>/.env`：那里出现 `DSH_` 开头的变量 DSH 会拒绝启动。
5. **验证**：DSH 对话里让模型调 `agent_list`，或者打开任务板「调度台」tab，能看到统计就通了。报错看下面「常见问题」。
6. **接入 worker**（每台跑 agent 的机器做一次，详见第 8 节）：
   ```bash
   python plugins/dsh-agent-hub/scripts/agent_client.py init       # 写 <DSH home>/worker/.env、profile.json，并建好交换目录 E:/dsh-exchange
   python plugins/dsh-agent-hub/scripts/agent_client.py check      # 能否连到 hub（默认直连），hub 看到的 IP
   python plugins/dsh-agent-hub/scripts/agent_client.py register   # 申请加入，然后在 DSH 里 agent_requests → agent_approve
   python plugins/dsh-agent-hub/scripts/agent_client.py run        # 常驻：心跳 + 收任务（AWS Quick 用定时 bridge --once）
   ```
   **交换目录一开始是空的，这是正常的**：要等 register 被批准、run 在跑、DSH 用 `task_dispatch` 派了任务，`inbox/` 里才会出现任务。

## 必须配置

一共涉及 3 个文件，**都不入库**（里面有令牌或本机路径）：

| 文件 | 在哪台机器 | 键 | 必填 | 含义 | 示例（MYDESK） | 不配 / 默认 |
|---|---|---|---|---|---|---|
| `<DSH home>/agent-hub/controller.env`（模板 `controller.env.example`） | 跑 DSH 的机器 | `DSH_HUB_URL` | ✅ | hub 地址；裸 IP 自动补成 `https://IP:7891` | `https://<server>:7891` | 工具和面板报 `hub-not-configured` |
| 同上 | | `DSH_HUB_CONTROLLER_ID` | ✅ | 本 DSH 的控制方 id，和第 2 步 `controller add` 的一致 | `dsh-local`（服务器同机 DSH 用 `dsh-cloud`） | `hub-not-configured` |
| 同上 | | `DSH_HUB_TOKEN` | ✅ | 控制方令牌 `dshc_<id>_…` | 第 2 步得到的令牌 | `hub-token-missing` |
| 同上 | | `DSH_HUB_PROXY` | 可选 | 怎么连 hub：`off` 直连 / `env` 用环境变量 / `http://host:port` 代理 | `off`；直连不通时 `http://127.0.0.1:7890` | 直连 |
| 同上 | | `DSH_HUB_CAFILE` | 自签证书时必填 | hub 证书或 CA 的 PEM 路径 | 留空（正规证书） | 系统 CA；自签却不填 → `hub-unreachable`（TLS） |
| `<DSH home>/worker/.env`（模板 `scripts/worker.env.example`，`init` 生成） | 每台 worker 机器 | `DSH_HUB_URL` | ✅ | 同上 | `https://<server>:7891` | `check` / `register` / `run` 报错 |
| 同上 | | `DSH_AGENT_ID` | ✅ | worker 名，`^[a-z][a-z0-9-]{1,47}$` | `quick-mydesk` | `register` 报错 |
| 同上 | | `DSH_HUB_PROXY` | 可选 | 同上 | `off`（模板默认） | `env`（读 HTTPS_PROXY / 系统代理） |
| 同上 | | `DSH_EXCHANGE` | 建议 | 交换目录 | `E:/dsh-exchange` | worker 目录下的 `exchange/` |
| 同上 | | `DSH_PLATFORM` / `DSH_CAPABILITIES` / `DSH_NODE` | 建议 | 平台、能力（给 `pool:<capability>` 和任务的 `capability` 用；`name:N` 表示这类活最多同时跑 N 个）、机器名 | `aws-quick` / `code,document`（本地 DSH：`browser:1,test,code`） / `mydesk` | `custom` / 无 / 主机名 |
| 同上 | | `DSH_ROLE` | 可选 | 申请的角色：`worker` 接任何活 / `coder` 只改代码（不跑测试、不执行命令、不碰 git，AWS Quick 用这个）/ `tester` 只接测试类 / `dispatcher` 只派活不接活 / `observer` 只读；批准时只能收窄，心跳里也能自己收窄（如 `worker` → `coder`） | `worker` | `worker` |
| 同上 | | `DSH_PULL_EVERY_SECONDS` | 定时运行时必填 | 不常驻、靠 cron / 计划任务跑 `bridge --once` 的 worker 多久来一次（60～86400 秒）。hub 等「90 秒 + 这个周期」没来才判离线，免得干活途中任务被收回 | `900` | 空 = 常驻（`run`），90 秒没来就算离线 |
| `<DSH home>/worker/profile.json`（模板 `scripts/profile.example.json`） | 每台 worker 机器 | `workspaces` | 派 `code` 任务时必填 | 工作区名 → 本机路径（名字和 router-b 一致） | `{"deepseek-harness": "E:/PythonProject/dsh-warroom"}` | 没映射的工作区任务直接失败 `WORKSPACE_MISSING` |
| 同上 | 同上 | `capabilities` / `maxConcurrency` / `role` / `pullEverySeconds` / `platform` / `agentId` | 可选 | 这台机器的 worker 是什么、能干哪些活。每台机器的 profile 各写各的，工作区位置也各不相同；`.env` 或环境变量里写了同名的 `DSH_*` 时以它们为准 | `{"browser": 1, "test": 2, "code": 2}`，完整样例 `scripts/profile.local-dsh.example.json` | 不写就用 `.env` / 默认值 |

- `<DSH home>` = 环境变量 `DSH_HOME`，没设就是 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`）。
- 优先级：controller 端 `cordis.patch.yml` 显式写的 > 进程环境变量 > `controller.env` > 默认；worker 端 命令行 > 进程环境变量 > `worker/.env` > `profile.json` > 默认。
- hub 自己的配置（端口、TLS 证书、IP 白名单 `allow`）在服务器的 `<DSH home>/agent-hub/hub.json`，见 [`services/dsh-hub/README.md`](../../services/dsh-hub/README.md)。worker `check` 打印的出口 IP 要在 `allow` 里。

## 可选配置

只在 profile 层 `cordis.patch.yml` 的 `host-agent-hub.config` 里设置，一般不用动：

| 键 | 默认 | 含义 |
|---|---|---|
| `timeoutMs` | `15000` | 单次请求 hub 的超时，1000..120000 |
| `tokenEnv` | `DSH_HUB_TOKEN` | 令牌的变量名 |
| `envFile` | `<DSH home>/agent-hub/controller.env` | 换配置文件位置；**绝不能**指向 `<DSH home>/.env` |
| `hubUrl` / `controllerId` / `proxy` / `caFile` | 不写 | 写了就覆盖 `controller.env` 里对应的项（日志会提醒）；bundle 自带的配置故意不写 |
| `dshProfile` | DSH 启动时的 profile 名 | 这台 DSH 在 hub 上的名字：本机任务的 id（`local_<profile>_<编号>`）、执行者（`dsh-self/<profile>/<工作区>`）和调度台分组都用它 |
| `sync` | 开 | 本机任务上云和【进度提醒】。`false` 全关；也可以写对象 `{ mirror, notices, intervalMs, stepEveryMs, backfillHours, waitSeconds, stallMinutes, stallCheckMs, watchAll }`，默认 `true / true / 10000 / 30000 / 12 / 20 / 20 / 120000 / false`。`watchAll`：收整个 hub 的事件（观察用），默认只收本机发布的任务。`stallMinutes`：本机发布的云端任务多久没有新进展（进度、阶段或会话上传都算）就在作战室提醒一次「没有动静」，`0` 关掉 |

worker 端其余可选项（`DSH_MAX_CONCURRENCY`、`DSH_HEARTBEAT_SECONDS`、`DSH_AGENT_TOKEN_FILE`、`profile.json` 的 `dshProfile`）见 `python agent_client.py --help` 和第 8 节。

### 选 worker、档位和 agent（runtime / effort）

每个 worker 注册时会声明 `runtime`：它支持哪些档位（fast / balanced / smart）、哪些思考强度、每种任务类型的默认强度，以及这个平台上能点名的 agent。DSH 里 `agent_requests`（审批时）和 `agent_list` 都能看到。派任务时用 `effort` 指定：

```
task_dispatch: agent = quick-mydesk, type = code, workspace = deepseek-harness,
               effort = { mode: "smart", thinking: "medium", agent: "quick" }
```

| `mode` | 适合 | `thinking` |
|---|---|---|
| `fast` | 简单查询、小文档、定时接单 | 不能设（fast 没有思考） |
| `balanced` | 大多数文档、调研、一般代码 | `off` / `low` / `medium` / `high` |
| `smart` | 复杂编程、难的推理 | 同上 |

- 不写 `effort`：用 worker 自己的默认值（AWS Quick：`code` 用 smart + medium，`review` 用 smart + low，其他用 balanced + low）。
- worker 不支持的组合直接返回 409 `unsupported-effort`，并说明它支持什么；派给 `pool:<能力>` 时只交给支持的 worker。
- `effort.agent` 用来指定平台上的具体 agent，名字必须在 worker 的 `runtime.agents` 里。以后接入更多平台（Claude Code、Kiro……），各自声明自己的 agents，DSH 就能统一按 agent 和档位分配。
- worker 端在 `profile.json` 里写 `runtime` 覆盖内置值，例如 `"runtime": {"modes": ["fast", "balanced", "smart"], "agents": [{"name": "quick", "description": "默认"}]}`；写 `null` 表示不声明。改完下一次心跳就会同步到 hub，不需要重新注册。
- 详细规则见协议第 10 节。**需要新版 hub**（`docker compose up -d --build hub`）；旧版 hub 会忽略 runtime，effort 只通过 `context.effort` 带给 worker，不做检查。

### 容器里的 worker 读取本机 profile（`DSH_PATH_MAP`）

注册时上报的工作区来自 worker 的 `profile.json`（显式的 `workspaces` + `dshProfile` 里 router-b 的分区）。worker 跑在 Docker 里时，这些路径是 Windows 路径，容器里不存在，会被当成“不存在”丢掉。设置 `DSH_PATH_MAP` 把宿主路径前缀换成容器里的挂载点，就能直接用宿主那份 profile：

```yaml
DSH_PATH_MAP: E:/PythonProject=/host/e/PythonProject;${USERPROFILE}/.dsh/profiles/desktop=/host/dsh-profile
```

多条用 `;` 分隔，最长前缀优先，盘符不分大小写，`\` 和 `/` 等价。`task.json` 里 `workspace_path` 是容器里的路径，`workspace_host_path` 是宿主上的原路径（AWS Quick 用它读写）。示例见 `services/dsh-hub/deploy/docker/docker-compose.yml` 的 `worker-quick`。注意：注册时 hub 只批准了申请里的工作区，之后 profile 里新增的工作区会在 `status` 里显示为 ignored，要重新申请（`agent_revoke` 后容器会自动重新 `register`）。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `hub-not-configured` | `controller.env` 不在 `<DSH home>/agent-hub/` 下，或 `DSH_HUB_URL` / `DSH_HUB_CONTROLLER_ID` 没填。日志 `agent-hub: config …` 会写出每项来自哪里 |
| `hub-token-missing` / `hub-token-mismatch` | 没填 `DSH_HUB_TOKEN`，或令牌不是 `dshc_<controllerId>_` 开头（拿了别的控制方或 worker 的令牌） |
| `hub-unreachable` | hub 没运行 / 自签证书没配 `DSH_HUB_CAFILE` / 直连不通（改 `DSH_HUB_PROXY=http://127.0.0.1:7890` 试试）/ 配了代理但代理没开。message 写明是哪一步失败 |
| `hub-unauthorized` | hub 不认这个控制方令牌（填错、控制方被删、令牌已轮换）：在服务器上为这个控制方重新签发令牌，更新 `controller.env` 里的 `DSH_HUB_TOKEN`（不用重启） |
| DSH 启动失败，提示 `.env sets "DSH_…"` | 把 `DSH_` 开头的行从 `<DSH home>/.env` 挪到 `<DSH home>/agent-hub/controller.env` |
| 交换目录（如 `E:\dsh-exchange`）是空的 / 不存在 | 正常。目录由 `agent_client.py init` / `run` 创建；任务要等 register 被批准、`run` 在跑、DSH 派了任务才会出现。`python agent_client.py status` 看 hub 眼里的本机状态 |

---

# 参考

## 1. 目录

```
plugins/dsh-agent-hub/
├── index.js / package.json / cordis.patch.yml / icon.svg / locale/
├── packages/host-agent-hub/
│   ├── index.js       挂载：读配置 → 注册 14 个工具 + 面板路由；配置缺失时只给 warning
│   ├── hub-client.js  /v1/ctl/* 客户端（node:https request + ca、?id=、X-DSH-Token、超时、错误映射、脱敏）
│   ├── proxy.js       HTTP 代理：CONNECT 隧道 + TLS（parseProxyUrl / shouldBypass / buildConnectRequest / openTunnel）
│   ├── env-file.js    .env 解析（不依赖第三方库）
│   ├── tools.js       14 个 DSH 专用工具
│   ├── bridge.js      /api/agent-hub/admin/*（requireLogin + 白名单整形 + 503 hub-unreachable）
│   ├── hub.js         v1 本地 hub，仅保留作参考；插件已不再加载（v2 实现在 services/dsh-hub）
│   └── tests/         node:test 测试（不依赖真实 hub，使用假的 request 和假的 fs）
├── packages/client-ui-agent-hub/   只读调度面板：嵌在 router-b 任务板里的「调度台」tab（router-b 没装时退回左侧栏一行 + 整页），见第 5.1 节
└── scripts/install.mjs / agent_client.py（worker 客户端）/ worker.env.example / profile.example.json
```

## 2. 安装

```bash
node plugins/dsh-agent-hub/scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run
node plugins/dsh-agent-hub/scripts/install.mjs --profile /root/.dsh/profiles/web
# 1) 在 hub 机器上为这个 DSH 签发控制方令牌（只显示一次）：
#      node services/dsh-hub/server.mjs controller add dsh-cloud
# 2) 把令牌放进 DSH 服务的环境变量，或者写进 <DSH home>/agent-hub/controller.env（chmod 600，见第 3.2 节）
#    ⚠ 不要写进 <DSH home>/.env：DSH 不允许那里出现 DSH_ 开头的变量，会拒绝启动
# 3) hubUrl / controllerId / proxy / caFile 也写在 controller.env（DSH_HUB_URL 等，见上面「必须配置」），cordis.patch.yml 里不用写。
#    第一次装插件要重启 DSH 一次（由运维决定何时）；之后改 controller.env 不用重启。日志里应该能看到：
#      agent-hub: controller token from environment variable DSH_HUB_TOKEN   （或 from /root/.dsh/agent-hub/controller.env (DSH_HUB_TOKEN)）
#      agent-hub: mounted /api/agent-hub/admin/* (login, read-only, forwarded to the hub)
#      agent-hub: 14 control tools registered (agent_*, task_*, fallback_*); controller of https://127.0.0.1:7891 as dsh-cloud
#      （MYDESK 上的 dsh-local：controller of https://<server>:7891 as dsh-local via proxy http://127.0.0.1:7890）
```

配置或令牌缺失时，插件**照常加载**，日志中会给出 warning；此时每个工具调用和面板请求都会返回明确的错误码（`hub-not-configured` / `hub-token-missing`），不会导致 DSH 启动失败。

## 3. 配置与令牌

### 3.1 配置项细节（`controller.env` 或 `cordis.patch.yml` → `host-agent-hub.config`）

`hubUrl` / `controllerId` / `caFile` / `proxy` 平时写在 `<DSH home>/agent-hub/controller.env`，键名分别是 `DSH_HUB_URL` / `DSH_HUB_CONTROLLER_ID` / `DSH_HUB_CAFILE` / `DSH_HUB_PROXY`。每一项单独决定来源：`cordis.patch.yml` 里显式写的 > DSH 进程环境变量 > `controller.env` > 默认值；被 `cordis.patch.yml` 盖掉时日志会提醒。`timeoutMs` / `tokenEnv` / `envFile` 只能在 `cordis.patch.yml` 里设置。

| 键 | 含义 | 默认值 |
|---|---|---|
| `hubUrl` | hub 的基础地址。远程 hub 用 `https://<hub-host>:7891`；只有 `127.0.0.1` / `localhost` / `[::1]` 才允许用 `http://`（没有配置 TLS 的 hub 只监听回环地址）。地址里不能带用户名密码、query 或 fragment；可以带路径前缀（`https://proxy/hub` 会请求 `/hub/v1/ctl/...`）。 | 无（必填）。MYDESK：`https://<server>:7891`（裸写 `<server>` 会自动补全）；hub 和 DSH 在同一台机器（dsh-cloud）时用 `https://127.0.0.1:7891`。hub 配了 TLS 后只提供 https，所以同机也要用 https 并配 `caFile`（证书 SAN 要包含 127.0.0.1）；只有 hub 不配 TLS、只监听回环时才用 `http://` |
| `controllerId` | 这个 DSH 在 hub 上的控制方 id，需匹配 `/^[a-z][a-z0-9-]{1,47}$/`，例如 `dsh-cloud`、`dsh-local`。每个请求都会带上 `?id=<controllerId>`。 | 无（必填） |
| `caFile` | hub 证书（自签）或其 CA 的 PEM 文件。配置后它是验证 hub 证书的**唯一**信任根；不配置时使用系统 CA。只对 `https://` 生效。 | 不设置 |
| `timeoutMs` | 单次请求 hub 的超时时间，取值为 1000..120000 的整数。配置非法时给出 warning 并使用默认值。 | `15000` |
| `tokenEnv` | 存放控制方令牌的**变量名**，进程环境变量和 `.env` 文件都按这个名字查找。 | `DSH_HUB_TOKEN` |
| `envFile` | 进程环境里没有令牌时读取的 `.env` 格式文件。**不能是 `<DSH home>/.env`**：那是 DSH 自己的凭据文件，里面出现任何 `DSH_` 开头的变量 DSH 都会拒绝启动；`envFile` 指向它且 `tokenEnv` 以 `DSH_` 开头时插件不读它，只给 warning（`tokenEnv` 换成别的名字时可以读，但也有一条较弱的 warning）。 | `<DSH home>/agent-hub/controller.env`，其中 DSH home = `$DSH_HOME`，未设置时为 `~/.dsh` |
| `proxy` | 怎样连到 `https://` hub。`http://host:port`：总是经过这个 HTTP 代理（可带 `user:pass@`，转成 `Proxy-Authorization: Basic`，凭据不进日志和错误信息；只支持 http:// 代理，不支持 SOCKS）。`env`：读 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`（每次调用重新读），`NO_PROXY` / `no_proxy` 命中 hub 主机时直连（逗号分隔：主机名、`.后缀`、`*.后缀`、`host:port`、`*`；不支持 CIDR）。`http://` 回环 hub 永远直连（配了 proxy 只给 warning）。代理连不上、CONNECT 非 200、隧道里 TLS 失败、超时都返回 503 `hub-unreachable`，message 说明是哪一步。示例：MYDESK 上的 dsh-local 填 `http://127.0.0.1:7890`（Clash/mihomo）；和 hub 同机的 dsh-cloud 不填。 | 不设置 = 直连 |

v1 的配置项（`dataDir`、`publicUrl`、`offlineAfterMs`、`sweepIntervalMs`、`maxRetries`、`maxPendingRequests`、`maxResultBytes`）会被忽略，并给出一条 warning。这些设置现在属于 hub 自己的 `<DSH home>/agent-hub/hub.json`。

**为什么不用 fetch**：Node 原生 `fetch` 不能为单个请求指定 CA，只能通过 `NODE_EXTRA_CA_CERTS` 影响整个进程。因此 `hub-client.js` 使用 `node:https` / `node:http` 的 `request()`，并传入 `ca`（来自 `caFile`）和 `timeout`。`caFile` 在第一次请求时读取并缓存；读取失败时返回 `503 hub-ca-unreadable`，下次请求会重新尝试读取。

**代理**：`https.request` 不读 `HTTPS_PROXY`，所以配置了 `proxy` 时由 `proxy.js` 自己建隧道：先用 `node:http` 向代理发 `CONNECT <hub>:<port> HTTP/1.1`，收到 200 后在返回的 socket 上做 `node:tls` 握手（`servername` = hub 主机名，IP 地址不发 SNI 但仍校验证书里的 IP；`ca` = `caFile`），再把这条 TLS 连接通过 `createConnection` 交给 `https.request`。每个请求一条隧道，令牌只在隧道内的 TLS 里，代理看不到。

### 3.2 控制方令牌

令牌格式为 `dshc_<controllerId>_<随机>`，**只能在 hub 机器上用 CLI 签发**（`node server.mjs controller add <id>`，只显示一次）。

**查找顺序**（每次调用都会重新查找，所以轮换令牌后不需要重启）：

1. 进程环境变量 `<tokenEnv>`（默认 `DSH_HUB_TOKEN`），值不为空就使用它；
2. 否则读取 `envFile`（默认 `<DSH home>/agent-hub/controller.env`）里 `<tokenEnv>=…` 这一行。

> ⚠ **不要把 `DSH_HUB_TOKEN` 写进 `<DSH home>/.env`。** DSH 本体把这个文件当作自己的凭据文件，并且禁止里面出现任何 `DSH_` 开头的变量，启动时会报 `... sets "DSH_HUB_TOKEN", which only the launching environment may set ...` 并退出。已经写进去的：把那一行挪到 `<DSH home>/agent-hub/controller.env`，再从 `<DSH home>/.env` 删掉。插件的保护：`envFile` 解析后等于 `<DSH home>/.env`（规范化、不区分大小写、`\` 与 `/` 等价）且 `tokenEnv` 以 `DSH_` 开头时，不读这个文件，并在启动日志里给出迁移提示。

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
- **权限**：这个文件里存的是密钥，POSIX 上请执行 `install -d -m 700 <DSH home>/agent-hub && install -m 600 /dev/null <DSH home>/agent-hub/controller.env`，或者 `chmod 600 <envFile>`（只有属主可以读写）。在 POSIX 系统上，如果文件对组或其他用户可读（`mode & 044`），插件仍然会使用它，但会打印**一次** warning。在 Windows 上不检查权限位，请把文件放在用户目录下（默认 ACL 只允许本人访问）。

**令牌不会出现在任何输出里**：

- 令牌只通过请求头 `X-DSH-Token` 发送，**不会放进 URL**（hub 也会拒绝 query 里的 token）。
- 日志只记录令牌的**来源**（来自环境变量还是来自哪个文件），从不记录令牌的值；请求日志只包含方法、路径、状态码和耗时。
- 所有错误信息都会经过 `redact()` 处理：配置的令牌值，以及任何形如 `dshc_…` / `dsha_…` 的字符串，都会被替换为 `***`。即使 hub 在错误信息里回显了令牌，也不会外泄。
- 工具输出在返回前会经过 `scrub()`，确保控制方令牌不会出现在结果里。`agent_provision` 返回的**worker** 令牌是有意只显示一次的，不受这项处理影响。
- 面板接口的返回经过白名单整形，自由文本里的令牌形状字符串都会被遮蔽。

## 4. 工具（只有 DSH 模型能调用）

v1 的 11 个工具名称不变，另加 3 个兜底工具。每个工具对应一次 `/v1/ctl/*` 调用：

| 工具 | hub 接口 | 说明 |
|---|---|---|
| `task_dispatch` | `POST /v1/ctl/dispatch` | **新增** `require_online`：目标不在线时 409 拒绝而不是入队；默认入队，hub 返回的 `warnings`（`agent-offline` / `no-online-worker`）原样带回给 DSH。参数与 v1 相同，并**新增** `workspace`（工作区**名**，不是路径；`type: "code"` 时必填，插件会在本地先检查）、`node`（限定在哪台机器执行）、`ref`（git 分支或 commit）、`capability`（走 worker 的哪条能力线）。`created_by` 由 hub 填写。 |
| `task_list` | `GET /v1/ctl/tasks?status=&agent=&workspace=&limit=` | **新增** `workspace` 筛选 |
| `task_get` | `GET /v1/ctl/task` (+ `GET /v1/ctl/output`) | 传入 `output_name` 时，同时读取产出文件的前 60000 个字符 |
| `task_cancel` / `task_retry` | `POST /v1/ctl/cancel` / `retry` | 只有创建这个任务的控制方才能操作（由 hub 检查，否则返回 403 `not-creator`） |
| `agent_list` | `GET /v1/ctl/agents` | 每个 worker 带 `status`（pending / online / offline / left / revoked）、`last_seen`、`version` |
| `agent_requests` | `GET /v1/ctl/requests?status=` | 默认 `pending` |
| `agent_approve` | `POST /v1/ctl/approve` | **新增** `workspaces` 参数。只能收窄 `capabilities` / `workspaces` / `max_concurrency`，不能扩大 |
| `agent_reject` | `POST /v1/ctl/reject` | |
| `agent_revoke` | `POST /v1/ctl/revoke` | |
| `agent_provision` | `POST /v1/ctl/provision` | 直接签发 worker。额外支持 `node` 和 `workspaces` 参数（契约里没有写明这部分，见第 7 节）。返回的 `endpoint` 是 `<hubUrl>/v1`，worker 直接连接 hub |
| `fallback_list` | `GET /v1/ctl/fallback` | 没有合适的 worker 按时领走、等 DSH 自己做的任务。传本机的工作区名可以跳过做不了的代码任务 |
| `fallback_take` | `POST /v1/ctl/fallback/take` | 接手一个（指定 `task_id`，或最急的一个），文本输入直接带回（共 60000 字符以内）。DSH 用自己的工具做完后调 `fallback_submit`。只试一次 |
| `fallback_submit` | `POST /v1/ctl/fallback/result` | 交兜底任务的结果：`completed` 或 `failed`、摘要、可选文本文件 |
| `task_answer` | `POST /v1/ctl/answer` | 把用户的回答交给提问的 worker（`task_id` + 用户原话）。交回去问的任务回到队列，优先给原来的 worker，领任务时带上以前的问答；边做边问的任务回答在它下一次进度 / 心跳时送到。不用重派。旧版 hub 没有这个接口时返回提示，改用 `task_dispatch` 的 `replaces` |
| `task_timeline` | `GET /v1/ctl/timeline` | 一条任务的全生命周期：阶段、每一步谁做的、各阶段耗时（排队 / 运行 / 等人回答）、超时、送达作战室和收起的时间、问答；已归档的也能查 |
| `task_metrics` | `GET /v1/ctl/metrics` | 最近 `hours` 小时（默认 168）按执行者的指标：数量、完成 / 失败 / 未结束、失败率、问人比例、兜底次数、超时数、排队和运行时长 p50 / p90 |

`task_dispatch` 还可以带 `due_minutes`（1..43200）和 `on_overdue`（`notify` 只提醒，`reassign` 收回重排），覆盖 hub.json 的 `due`（协议第 12 节）。

出错时工具抛出 `HubError`，消息格式为 `[code] 说明`，例如 `[hub-token-missing] DSH_HUB_TOKEN is not set (neither in the environment nor in /root/.dsh/agent-hub/controller.env): …`。hub 返回的错误（`404 task-not-found`、`403 not-creator`、`400 bad-task` 等）会保留原来的状态码和 code。

## 5. 调度面板

`packages/client-ui-agent-hub` 是 DSH Web 客户端里的调度面板（除了回答 worker 的提问、收起和取消，其余只读），现在作为 router-b 任务板的「调度台」tab 嵌入（见第 5.1 节）。插件提供的接口如下：

| 路径（GET，需要 DSH 登录） | 转发到 | 返回（字段与 v1 相同，见 `src/client/contract.ts`） |
|---|---|---|
| `/api/agent-hub/admin/overview` | `/v1/ctl/overview` | `{protocol, agents, task_counts, pending_requests}` |
| `/api/agent-hub/admin/agents` | `/v1/ctl/agents` | `{generated_at, online, agents:[…]}` |
| `/api/agent-hub/admin/tasks?status=&agent=&limit=&history=&profile=&origin=` | `/v1/ctl/tasks` | `{generated_at, filter, tasks:[…]}`；`history` = `hide`（默认，不含已进历史的）/ `include` / `only` |
| `/api/agent-hub/admin/task?task_id=` | `/v1/ctl/task` | `{generated_at, task:{…}}` |
| `/api/agent-hub/admin/requests?status=` | `/v1/ctl/requests` | `{generated_at, filter, requests:[…]}` |
| `/api/agent-hub/admin/session?task_id=&after=&limit=` | `/v1/ctl/session/read` | `{task_id, total, next, full, entries:[{index, at, role, name?, text, by}]}`，`limit` 1..500，默认 200 |
| `/api/agent-hub/admin/ack`（POST，JSON，≤4KB） | `/v1/ctl/ack` | 把一个已结束的任务收起（进历史），调度台的「收起」按钮用它 |
| `/api/agent-hub/admin/cancel`（POST，JSON，≤4KB） | `/v1/ctl/cancel` | 取消一个还开着的任务（只有创建它的 DSH 能取消），「等你回复」里还在等回答的任务用它 |
| `/api/agent-hub/admin/answer`（POST，JSON，≤4KB，回答 1..4000 字） | `/v1/ctl/answer` | 回答 worker 的提问，任务详情里的回答框用它 |
| `/api/agent-hub/admin/timeline?task_id=` | `/v1/ctl/timeline` | 阶段、各阶段耗时、事件（带 `by`、`phase`）、问答；任务详情的「生命周期」块用它 |
| `/api/agent-hub/admin/metrics?hours=` | `/v1/ctl/metrics` | 按执行者的指标，「指标」一栏用它（24 小时 / 7 天 / 30 天） |

- 登录校验（`requireLogin`）在请求 hub **之前**完成：未登录返回 401，无权限返回 403，登录服务不可用返回 503。
- query 参数先在本地校验，非法时返回 400 `bad-query`，不会请求 hub。除 `ack`、`cancel`、`answer` 外非 GET 请求返回 405；这三个要求 `Content-Type: application/json`（否则 415）。
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

### 5.1 面板放在哪里：任务板的「调度台」tab（router-b 没装时才用左侧栏）

面板主要入口是 **router-b 右侧任务板（工作板）的第一个分段 tab**，标题「调度台」（英文 “Dispatch”），默认选中；router-b 自己的「现在」改叫「本机」，「已结束」收进调度台。
两个插件各自打包、不能互相 import，所以通过一个挂在 `globalThis.__dshRouterBoardTabs__` 上的注册表（`v: 1`）对接：
`src/client/board-tabs.ts` 在两个插件里**逐字节相同**，谁先加载谁创建，另一方复用。

- 注册：`id: 'agent-hub'`、`order: -100`（负数 = 画在内置 tab 前面并默认选中）、`label` = locale `board.tab`、`Component` = `AgentHubPage` 的嵌入模式。
- 徽标 = **待审批的加入申请数**（为 0 时不显示）。选它而不是离线 agent 数：申请是这页上唯一需要人去处理的东西（在 DSH 对话里 `agent_approve` / `agent_reject`）；离线常常是正常状态（机器休眠、按需启动的 runner），一直挂着数字反而让人忽略它。tab 没打开时每 30 秒读一次 `overview`（只在有任务板、浏览器标签页可见时）；tab 打开时由页面自己的 10 秒刷新顺带更新。**警示点**：没有待审批申请、但有离线或已下线的 agent 还占着任务时，tab 上显示一个小圆点（任务板的 `.dshrc-tab-flag`，和「现在」tab 的等待点同一样式），悬停和读屏文字是「n 个离线 agent 还占着 m 个任务（掉线后会自动重排）」。有待审批时只显示数字，不显示圆点，避免两个信号叠在一起。hub 会自己把这些任务按 `worker-offline` 重排，所以圆点只是提醒，不需要操作。实现上用的是 board-tabs v1 新增的可选字段 `flag`；旧版任务板不认识它，只会不显示圆点。
- 在线状态（协议第 9 节，整页和嵌入模式都一样）：agent 的状态点和文字按 `status` 显示 5 种状态，tone 为 在线 = ok、待接入（pending）= warn、离线 = idle、已下线（left）= idle、已吊销 = bad；旧版 bridge 没有 `status` 字段时按 `revoked` / `online` 推断（已吊销 / 在线 / 离线）。第二行显示客户端版本（有才显示）和「最后心跳 n 秒前」，离线或已下线时显示「离线 n 分钟」（已下线优先按 `left_at` 计算，没有就用 `last_seen`），忙 / 闲只在在线时显示。列表顺序是 在线 → 待接入 → 离线 → 已下线 → 已吊销，同一状态内保持 hub 返回的顺序；Agent 分组标题旁会弱化显示离线数（离线 + 已下线，大于 0 时才显示）。统计格「在线 agent」显示 在线/总数，悬停时列出各状态的数量（有 `agent_counts` 就用它，否则统计 agent 列表）。任务详情的历史记录里，凡是 event 或 message 里带有 `worker-lost` / `worker-offline` / `agent-offline` 的条目都会用 warn 色标出，并附一句说明。
- 嵌入模式（调度台）：三个统计格（在办 / 在线 agent / 待批申请）；任务按五条泳道分组，工具条可按 agent 筛选、打开「历史」；Agent 按 DSH profile 分组，DSH 自己的 worker 并列，休眠的 agent 收在一个开关后面；「兜底」一栏只在有 DSH 兜底任务时出现，写明是「没人在线」还是「没人及时领」；加入申请只在有申请时出现；任务详情在列表里该行下方展开，含来源、profile、阶段、时间线和会话记录（每页 200 条）。分组折叠状态记在 sessionStorage。
- 「等你回复」里每一行都能清掉：已结束的点「收起」（进历史），还开着的点「取消任务」（再确认一次，worker 会停下）。等人回答的任务在详情里有回答框，回答直接回到提问的 worker（和作战室里的 `task_answer` 一样）。作战室用 `task_dispatch` 的 `replaces` 带着回答重派时（旧版 hub），原任务自动收起。
- 任务详情的「生命周期」块：当前阶段、排队 / 已领 / 运行 / 等你回答 / 总共各多久、截止时间和是否超时、什么时候送到作战室、谁收起的、以前的问答。旧版 hub 没有 `timeline` 时不显示。
- 「指标」一栏（默认折起）：按执行者列出数量、完成 / 失败 / 未结束、失败率（≥20% 标红）、问人比例、兜底、超时、排队和运行的 p50 / p90，最后一行是合计。
- 过期数据默认不显示（hub 的规则）：完成 12 小时、失败 2 天后进历史，agent 3 天没心跳算休眠，7 天后归档；旧配置启动时自动迁移，原文件留 `.bak`。自动刷新周期不变，tab 不在屏幕上（切到别的 tab、右侧栏收起、浏览器标签页隐藏）时暂停，回到屏幕立刻补刷一次。
- **左侧栏入口只作兜底**：插件启动 3 秒后注册表里仍没有任务板声明自己（`hasConsumer()` 为假，即 router-b 没装或没加载），才注册 `sidebar.panellist` 那一行，点开是原来的整页（`main` 面板 `agent-hub/page` 一直保留）。之后任务板一出现，这一行就撤掉；任务板消失 3 秒后再加回来。
- 只装 agent-hub、不装 router-b：行为和以前一样（左侧栏一行 + 整页），只是晚 3 秒出现。

### 5.2 本机任务上云（`sync.js`）

hub 是唯一的任务账本，本机 DSH 只是其中一个执行者：

1. **上传**：路由器（dsh-router-b）每个任务登记成 hub 上「由本机自己做」的任务（`run_here`，来源 `local`），id 固定为 `local_<profile>_<编号>`，重启不会重复登记。阶段、当前一步、worker 会话记录（提示、回答、工具调用，已脱敏）和最终结果都会上传。本机任务不会因为一段时间没进度被判失败，只标「安静」。
2. **信箱**：本机只收自己的信。派活时任务记下发布方（本机的控制方 id 和 profile，字段 `reply_to`），事件流用 `/v1/ctl/events?inbox=mine&profile=<profile>` 长轮询，hub 只给发布方这台 DSH 发它的任务的事件；别的 DSH 发布的任务、本机替别人兜底的任务（取消除外）都不会出现在本机作战室。一轮执行结束（完成 / 失败 / 提问）时，把完整结果（总结或问题或原因、产出文件、第几次执行）作为一条【进度提醒】发给作战室，同一个任务的同一次执行只发一次；`task_get` 能看全文。没人接的任务（没人在线或没人及时领）退回发布方一次：「没人接，需要你决定：自己做、改派还是取消」；`fallback_list` / `fallback_take` 也只列、只接本机发布的任务。想看整个 hub 的观察用 DSH 可以设 `sync.watchAll: true`（默认关）。旧版 hub 不认 `inbox` 参数时，插件在本地按同样规则过滤。
3. **提问优先**：worker 交回问题（`needs_input`，hub 上状态 `waiting_input`）读作「需要回答」而不是「失败」，提醒里带「（回答：task_answer id）」；回答后作战室收到「已回答，回到原 worker」；超时的任务提醒「超时」（改派时说从谁手里收回）。结果或问题显示到作战室后，插件告诉 hub 已送达（时间线里能看到）；本机发布的云端任务超过 `stallMinutes` 没有新进展，提醒一次「没有动静」。这几类条目作战室会直接问你（路由器规则 8），不会被后面的进度冲掉。
4. **清理**：本机任务在路由器看板上不见了（看板重置、换了 profile）而 hub 上还开着，10 分钟后在 hub 上取消，不再一直挂着。
5. **离线**：已被 hub 接受的进度记在 `<DSH home>/agent-hub/sync-<profile>.json`；没发出去的下次连上时补发（最新阶段、未上传的会话条目、结果），DSH 重启也不丢。

## 6. 测试

```bash
cd plugins/dsh-agent-hub
node --test packages/host-agent-hub/tests/*.test.mjs
```

| 文件 | 内容 |
|---|---|
| `hub-client.test.mjs` | URL 和路径前缀、`?id=` 必须是第一个 query 参数、`X-DSH-Token` 头、令牌不进 URL、POST 的 body 和 content-type、`health` 不带令牌、`timeout` / `ca` 选项、`caFile` 缓存与读取失败后重试、hub 返回结构的兼容、错误映射（hub 4xx/5xx、ECONNREFUSED、TLS、socket 超时、整体超时、`request()` 直接抛异常）、缺令牌 / 令牌不匹配 / 未配置时不发请求、令牌不进日志和错误信息；令牌优先级（环境变量 > envFile）、`DSH_HOME` 与 `~/.dsh` 的默认值（`agent-hub/controller.env`）、`<DSH home>/.env` 保护（`DSH_*` 不读、Windows 路径大小写与反斜杠、非 `DSH_` 变量名只给弱 warning）、`tokenEnv` 改名、轮换令牌无需重启、.env 权限 warning 只出现一次且不含令牌值 |
| `proxy.test.mjs` | `parseProxyUrl`（只收 http://、默认端口 80、凭据转 Basic、显示脱敏）、`buildConnectRequest`（`CONNECT host:port HTTP/1.1`、Host、Proxy-Authorization 只在有凭据时）、`buildTlsOptions`（IP 不发 SNI）、`shouldBypass`（`*`、主机名、后缀、端口）、`proxySetting` / `resolveProxy`（off、URL、env 的顺序与 NO_PROXY、http 回环永远直连）；用假的 `node:http` / `node:tls` 跑 `openTunnel`：成功、代理连不上、CONNECT 403 / 502、407（以 response 形式）、TLS 证书失败、两段超时，消息里都没有代理凭据；hub 客户端经隧道发请求（`createConnection`、令牌不出现在 CONNECT 里、日志脱敏）、隧道失败映射为 503 `hub-unreachable`、env 模式每次重读 |
| `env-file.test.mjs` | `.env` 解析（注释、export、单双引号、行尾注释、CRLF、BOM、格式错误的行、同名键以最后一次为准、`__proto__`），文件不存在静默跳过，640/604/644/666 给出 warning、600/700 不给，Windows 不检查，目录或不可读文件给出 warning 且不泄露内容 |
| `tools.test.mjs` | 14 个工具名、schema（不接受未知参数）、新增参数、并发安全标记、每个工具对应的 hub 调用、`code` 类型必须带 workspace、错误格式为 `[code]`、令牌不进工具输出、兜底工具（输入转文本、文件转 base64） |
| `bridge.test.mjs` | 只剩 5 个 admin 路由、各接口的白名单整形与令牌遮蔽、query 校验、405、503 `hub-unreachable`、本地配置错误时返回 503、401/403 映射为 502 `hub-unauthorized`、500 不返回细节、`requireLogin` |
| `index.test.mjs` | 注册 14 个工具和 5 个路由、没有 `/v1` 路由、warning（缺配置、缺令牌、不安全的 http、v1 配置项、非法超时）、hub 不可用（`127.0.0.1:1`）时返回 503、从真实 .env 文件读取令牌、`envFile` 指向真实的 `<DSH home>/.env` 时不读取并给出迁移 warning、dispose 后全部注销 |

测试不会访问真实 hub，也不会读取真实的 `~/.dsh/agent-hub/controller.env` 或 `~/.dsh/.env`：`hub-client` 注入假的 `request` 和假的 `fs`；`index.test.mjs` 的 `envFile` 指向一个不存在的路径，或者指向测试中创建的临时文件。

## 7. 已知限制 / 待办

- 契约第 5.2 节没有写明 `cancel` / `retry` / `reject` / `revoke` / `provision` 的请求体，以及各个接口的返回结构。本插件采用的字段是 `{task_id, reason}`、`{task_id, agent}`、`{request_id, reason}`、`{agent_id}`，`provision` 使用与 enroll 相同的字段并加上 `agent_id`。这些已经和 `services/dsh-hub/lib/http.js` 的实现核对过，两边一致；列表接口同时兼容 `{tasks:[…]}` 和直接返回数组两种形式。
- 契约第 6 节提到“或存进 dsh-secrets”，这一项还没有实现。目前支持的来源是环境变量和 `.env` 文件。
- 代理：真实 Clash/mihomo 的 CONNECT 行为（端口限制、空闲超时）没有在开发机上实测，测试用的是假的 `node:http` / `node:tls`。

## 8. 在新设备上接入 worker

worker 目录固定是 `<DSH home>/worker/`（DSH home = `$DSH_HOME` 或 `~/.dsh`），里面放 `.env`、`profile.json` 和令牌文件。完整的配置项和优先级（命令行 > 进程环境变量 > `worker/.env` > `profile.json` > 默认值）见 `python agent_client.py --help`，状态机见协议第 9 节。

1. **生成模板**：`python plugins/dsh-agent-hub/scripts/agent_client.py init`（已存在的文件不会覆盖），同时按 `DSH_EXCHANGE` 建好交换目录（`inbox` / `working` / `outbox` / `failed` / `archive` + `README.md`；`--exchange <目录>` 换位置，`--no-exchange` 不建），会打印下一步。
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
3. **注册并上线**：`python agent_client.py register` → 在 DSH 对话里 `agent_requests` 看到申请、`agent_approve`（可以收窄 workspaces / capabilities / max_concurrency）→ register 自动领到令牌并写入 `agent.token` → `python agent_client.py run` 常驻（心跳 + 长轮询）。之后 `status` 查看 hub 眼里的自己，`leave` 主动下线（持有的任务立即重排）。只能定时运行的 agent（AWS Quick）用 `bridge --once`，并在 `worker/.env` 里填 `DSH_PULL_EVERY_SECONDS`（和定时周期一致）。被判离线后它带着结果回来，hub 会把任务还给它、照收结果，不会再叫它停。

   **一台机器干多种活**：在 `profile.json` 里写这台机器的能力和并发，例如本地 DSH 同时跑浏览器、测试和写代码（样例 `scripts/profile.local-dsh.example.json`）：

   ```json
   { "node": "mydesk", "agentId": "dsh-mydesk", "platform": "dsh",
     "workspaces": { "deepseek-harness": "E:/PythonProject/dsh-warroom" },
     "capabilities": { "browser": 1, "test": 2, "code": 2 }, "maxConcurrency": 4 }
   ```

   `browser: 1` 表示浏览器任务一次只跑一个。每台机器各写各的 `profile.json`，工作区路径也写在这里，不入库。

   **AWS Quick 这类只能当 MCP 客户端的 agent**：不用跑 `agent_client.py`。先用 `agent_provision`（或注册后 `agent_approve`）拿到 `dsha_` 令牌，然后在 Quick 里加一个 MCP 服务器：地址 `https://<hub-host>:7891/mcp`，认证选 OAuth client credentials，令牌地址 `https://<hub-host>:7891/oauth/token`，`client_id` 填 agent id，`client_secret` 填令牌。Quick 按计划定时调 `next_task`，做完调 `submit_result`。细节见 `services/dsh-hub/README.md` 第 5.4 节。

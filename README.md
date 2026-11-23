# dsh-warroom · DSH 作战室定制

一套装在 DeepSeek Harness（DSH）上的插件和配套服务。装好后，DSH 的 Web 界面里会多出这些东西：作战室任务板、Token 用量、模型出口代理、VPN、加密密钥库，以及一个「Agent 调度」页。在这个页面上，DSH 可以把任务派给外部 agent（AWS Quick、Kiro、Claude Code、Docker 里的 worker……）去做。

- 基线：DSH `0.2.2-rc.5`，Node >= 24.9（DSH 本身的要求），profile `web`。
- 这**不是 DSH 的 fork**，也不含 DSH 源码。DSH 安装包一行都不改，插件通过 profile 挂进去。
- 仓库里**没有任何密钥、令牌或证书**，这些都由你在自己的机器上生成或录入。
- 文档总目录见 **[docs/INDEX.md](docs/INDEX.md)**。

---

## 1. 仓库里有什么

```
dsh-warroom/
├── plugins/                 6 个 DSH 插件（每个插件 = bundle + host 包 + client 包）
│   ├── dsh-router-b/        分区路由 + 作战室三栏界面
│   ├── dsh-token-stats/     Token 用量统计
│   ├── dsh-egress/          模型出口代理
│   ├── dsh-vpn/             openfortivpn 管理
│   ├── dsh-secrets/         本地加密密钥库 + 只读密钥看板
│   └── dsh-agent-hub/       DSH 作为 dsh-hub 的控制方 + Agent 调度页 + worker 客户端 agent_client.py
├── services/
│   └── dsh-hub/             独立的任务调度服务（端口 7891），deploy/ 里有 systemd unit；
│                            deploy/docker/ 可以在本机用 Docker 把 hub + worker 整条链路跑通
├── profile/                 DSH web profile 覆盖层（脱敏副本，部署时复制到 /root/.dsh/profiles/web）
├── docs/                    部署、协议、UI 规范、迁移审计文档；nginx/ 是脱敏的站点模板
├── vendor/exa-mcp-server/   第三方 Exa stdio MCP（MIT，随仓库分发，不用再 npm 安装）
├── scripts/                 服务器上的浏览器截图工具（DSH 运行不需要）
├── .deps/                   构建 client 用的公共依赖清单（esbuild / typescript / @types/react）
├── README.md / MANIFEST.md / CLONE.md
└── .gitignore
```

### 6 个插件一览

| 插件 | 做什么 | 必须配置什么 | 详细说明 |
|---|---|---|---|
| **dsh-router-b** | 按文件分区把需求路由给 worker；Web 里显示作战室任务板、分区负载和 worker 进度 | 把 `plugins/dsh-router-b/cordis.patch.yml` 里各分区的 `root` 改成本机真实存在的目录；安装时要加 `--disable-brand` | [plugins/dsh-router-b/README.md](plugins/dsh-router-b/README.md) |
| **dsh-token-stats** | 侧边栏显示今天的 Token 总量和按模型的拆分，可展开看 7 / 30 天 | 无需配置 | [plugins/dsh-token-stats/README.md](plugins/dsh-token-stats/README.md) |
| **dsh-egress** | 给每个模型端点选择出口（http / https / socks5 / 直连）。出口不通时请求直接失败，不会悄悄改成直连 | 无需配置（默认全部直连，需要时在面板里添加出口） | [plugins/dsh-egress/README.md](plugins/dsh-egress/README.md) |
| **dsh-vpn** | 管理 openfortivpn 配置、连接和断开，带看门狗，可以看连接日志 | 机器上要装 `openfortivpn`；VPN 账号在面板里录入；`localProbePort` 要和 DSH 端口一致 | [plugins/dsh-vpn/README.md](plugins/dsh-vpn/README.md) |
| **dsh-secrets** | 本地加密密钥库：agent 能存、能用，但读不回明文；另有一个只读的密钥看板 | 在 `<DSH home>/secrets.env` 里写主口令 `DSH_SECRETS_PASSPHRASE` | [plugins/dsh-secrets/README.md](plugins/dsh-secrets/README.md) |
| **dsh-agent-hub** | 让 DSH 作为 dsh-hub 的控制方，给外部 agent 派任务；任务板里多一个「Agent」页签 | 在 `<DSH home>/agent-hub/controller.env` 里写 hub 地址、控制方 id 和令牌（见第 3 节） | [plugins/dsh-agent-hub/README.md](plugins/dsh-agent-hub/README.md) |

`<DSH home>` = 环境变量 `DSH_HOME` 的值；没设置时是 `~/.dsh`，即服务器上的 `/root/.dsh`、Windows 上的 `C:\Users\<你>\.dsh`。

**services/dsh-hub** 不是 DSH 插件，而是一个独立进程（Node >= 22，没有第三方依赖）。它负责保存任务、按工作区 / 机器 / 能力路由、管理租约和重试、保存产物。部署说明见 [services/dsh-hub/README.md](services/dsh-hub/README.md)，本机 Docker 联调见 [services/dsh-hub/deploy/docker/README.md](services/dsh-hub/deploy/docker/README.md)。

---

## 2. 架构

```
   本地 DSH（MYDESK，控制方 dsh-local）                     云端 DSH（服务器，控制方 dsh-cloud）
   插件 dsh-agent-hub                                       插件 dsh-agent-hub
        │  经本机代理 http://127.0.0.1:7890（Clash）             │  同机直连 https://127.0.0.1:7891
        │  → 固定代理节点 → 外网                                 │  （不走代理）
        ▼                                                        ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  dsh-hub   服务器 <server>:7891（独立进程，dsh-agent/2.0）       │
   │  保存任务、路由、租约、重试、产物；配置在 <DSH home>/agent-hub/hub.json │
   └──────────────────────────────────────────────────────────────────────┘
        ▲                         ▲                          ▲
        │ worker 主动连接 hub，只领取自己的任务、回传结果                      │
   quick-mydesk               kiro-mydesk                docker-worker …
   （AWS Quick，MYDESK）       （Kiro，MYDESK）            （Docker 容器）
   MYDESK 上的 worker 同样经 127.0.0.1:7890 出网
```

- **控制方**（DSH）用 `dshc_` 令牌调用 hub 的 `/v1/ctl/*`，负责派任务、审批 worker、查看结果。插件本身不保存任务状态。
- **worker** 用 `dsha_` 令牌直接连 hub，不经过 DSH。
- **服务器只接受外网流量**，所以 MYDESK 上的所有请求（dsh-local、worker）都要经 `http://127.0.0.1:7890` 走一个**固定**的代理节点出去。Clash 里给 `<server>/32` 指定固定节点，不能写 DIRECT。
- 协议细节见 [docs/DSH-HUB-PROTOCOL-v2.md](docs/DSH-HUB-PROTOCOL-v2.md)。

---

## 3. 从零开始

### 3.1 clone

```bash
git clone https://<server>:8444/dev/dsh-warroom.git
cd dsh-warroom
```

Gitea 在 8444 端口，开启了 mTLS，需要客户端证书和 Gitea 账号。证书怎么拿、Windows 上怎么配，见 **[CLONE.md](CLONE.md)**。证书已经重签过，按 CLONE.md 正常配置即可，**不要关闭证书校验**。

### 3.2 装插件（按顺序跑 install.mjs）

```bash
export P=/root/.dsh/profiles/web            # 你的 profile 目录
for s in dsh-router-b dsh-egress dsh-vpn dsh-token-stats dsh-secrets dsh-agent-hub; do
  node plugins/$s/scripts/install.mjs --profile "$P" --dry-run   # 先看会做什么
done
node plugins/dsh-router-b/scripts/install.mjs    --profile "$P" --disable-brand
node plugins/dsh-egress/scripts/install.mjs      --profile "$P"
node plugins/dsh-vpn/scripts/install.mjs         --profile "$P"
node plugins/dsh-token-stats/scripts/install.mjs --profile "$P"
node plugins/dsh-secrets/scripts/install.mjs     --profile "$P"
node plugins/dsh-agent-hub/scripts/install.mjs   --profile "$P"
```

- 顺序就是 profile 里 bundles 的加载顺序：**router → egress → vpn → token-stats → secrets → agent-hub**。
- `install.mjs` 会把 profile 的 `package.json` 里每个插件的 `link:` **改写成你本机的 checkout 路径**，并建好 `node_modules` 软链。装完应该有 18 条依赖（6 个插件 × bundle / host / client）、8 个 bundles（2 个官方 + 6 个插件）。仓库里的 `profile/package.json` 写的是服务器上的 `/srv/...` 路径，只用作对照，**不要直接复制**。
- 脚本可以重复执行。**不要**在 profile 目录或仓库根目录跑 `pnpm install`，它会重写整棵依赖树。
- 覆盖层的其余三个文件需要复制过去：`cp profile/cordis.patch.yml profile/cordis.yml profile/pnpm-workspace.yaml "$P/"`，复制后把里面的 `/srv/...` 路径改成你本机的路径。

### 3.3 构建 client（浏览器端）

仓库里已经带有构建好的 `lib/client.js`，只改配置时不需要重新构建。改过 client 源码，或者安装时提示 `lib/client.js` 缺失，再执行下面的命令：

```bash
(cd .deps && pnpm install)                          # 一次性：装 esbuild / typescript
export DSH_CLIENT_MODULES="$(pwd)/.deps/node_modules"
for s in dsh-router-b dsh-egress dsh-vpn dsh-token-stats dsh-secrets; do node plugins/$s/scripts/build.mjs; done
node plugins/dsh-agent-hub/packages/client-ui-agent-hub/scripts/build-client.mjs
```

### 3.4 配置：每台机器要准备的文件

> ⚠ **任何 `DSH_` 开头的变量都不能写进 `<DSH home>/.env`。** 那是 DSH 自己的凭据文件，里面只要出现一个 `DSH_` 变量，DSH 就会拒绝启动（报 `only the launching environment may set ...`）。插件的配置一律放在下表这些单独的文件里。

| 文件 | 放在哪台机器 | 写什么 | 不配会怎样 |
|---|---|---|---|
| `<DSH home>/agent-hub/controller.env`（chmod 600） | 每台跑 DSH、要派任务的机器 | `DSH_HUB_URL`、`DSH_HUB_CONTROLLER_ID`、`DSH_HUB_TOKEN`，按需加 `DSH_HUB_PROXY`、`DSH_HUB_CAFILE` | 插件照常加载，但「Agent」页和 `agent_*` / `task_*` 工具会返回 `hub-not-configured` / `hub-token-missing` |
| `<DSH home>/secrets.env`（chmod 600） | 每台跑 DSH 的机器 | `DSH_SECRETS_PASSPHRASE=<你自己生成的长口令>` | 密钥库打不开，`secret_*` 工具不可用 |
| `<DSH home>/worker/.env` + `<DSH home>/worker/profile.json` | 每台跑 worker 的机器（MYDESK、Docker……） | hub 地址、代理、worker 名、平台、能力，以及工作区名到本地路径的映射；模板见 `plugins/dsh-agent-hub/scripts/worker.env.example`、`profile.example.json` | `agent_client.py` 连不上 hub，或领到任务后找不到工作区 |
| `<DSH home>/agent-hub/hub.json` | 只有跑 dsh-hub 的服务器 | 端口、TLS 证书、IP 白名单等；模板见 `services/dsh-hub/hub.example.json` | 全部使用默认值：只监听 `127.0.0.1:7891`、不启用 TLS，外网连不进来 |

`controller.env` 示例（两台控制方的写法不同）：

```dotenv
# 服务器上的云端 DSH（和 hub 在同一台机器）
DSH_HUB_URL=https://127.0.0.1:7891
DSH_HUB_CONTROLLER_ID=dsh-cloud
DSH_HUB_PROXY=off
DSH_HUB_CAFILE=/root/.dsh/agent-hub/hub-ca.pem
DSH_HUB_TOKEN=dshc_dsh-cloud_xxxxxxxx

# MYDESK 上的本地 DSH（默认直连；直连不通时 DSH_HUB_PROXY=http://127.0.0.1:7890）
DSH_HUB_URL=https://<server>:7891
DSH_HUB_CONTROLLER_ID=dsh-local
DSH_HUB_PROXY=off
DSH_HUB_CAFILE=C:/Users/<你>/.dsh/agent-hub/hub-ca.pem
DSH_HUB_TOKEN=dshc_dsh-local_xxxxxxxx
```

控制方令牌只能在 hub 机器上签发，签发时只显示一次：`node services/dsh-hub/server.mjs controller add dsh-cloud`。worker 的令牌由 `python plugins/dsh-agent-hub/scripts/agent_client.py register` 写进 `<DSH home>/worker/agent.token`。

### 3.5 重启

改了 profile 或插件的 host 代码后，需要重启 DSH，例如服务器上执行 `systemctl restart dsh-web`。只改了 client 时刷新浏览器即可。hub 机器改了 `hub.json` 后执行 `systemctl restart dsh-hub`。

### 3.6 验证

```bash
dsh --profile web --dump-config | grep -n '^# == dsh-'    # 应看到 6 个插件段
curl -s https://127.0.0.1:7891/v1/health                  # hub 机器：{"ok":true,...}（自签证书加 --cacert）
python plugins/dsh-agent-hub/scripts/agent_client.py check  # worker 机器：经代理连通 hub
```

在 DSH 日志里应能看到 `agent-hub: 11 control tools registered ...` 和 `dsh-secrets: ... 10 tools registered`。打开 Web 界面后，应能看到作战室、Token、Egress、VPN、密钥看板，以及任务板上的「Agent」页签。

更完整的服务器部署流程（nginx、systemd、证书）见 [docs/README-MIGRATE.md](docs/README-MIGRATE.md)。给云端 DSH 用的 hub 部署提示词见 [docs/DEPLOY-HUB-PROMPT.md](docs/DEPLOY-HUB-PROMPT.md)。

---

## 4. 常见问题

- **DSH 启动报 `... sets "DSH_...", which only the launching environment may set`**：`<DSH home>/.env` 里有 `DSH_` 变量。把那一行挪到对应插件的文件（`agent-hub/controller.env`、`secrets.env`、`worker/.env`），然后从 `.env` 里删掉。
- **「Agent」页显示 `hub-unreachable`**：服务器上检查 `systemctl status dsh-hub` 和 `hub.json` 的 `allow`；MYDESK 默认直连，直连不通时在 `controller.env` 里设 `DSH_HUB_PROXY=http://127.0.0.1:7890` 走 Clash（要确认 Clash 在运行）。
- **交换目录（如 `E:\dsh-exchange`）是空的或不存在**：正常。目录由 `python plugins/dsh-agent-hub/scripts/agent_client.py init`（或第一次 `run`）创建，里面会放一份 `README.md`。任务要等 `register` 被批准、`run` 在跑、DSH 用 `task_dispatch` 派了任务，才会出现在 `inbox/`。用 `agent_client.py status` 看 hub 眼里的本机状态。
- **注册 router 时报 `single slot ... already has a registration`**：router 安装时漏了 `--disable-brand`，重新跑一遍 router 的 install.mjs。
- **装完插件后，插件管理里看不到某个插件**：检查 profile 的 `package.json` 里 `dsh.profile.bundles` 是否有这个插件，再跑一遍对应插件的 `install.mjs`。

## 5. 安全边界

- 仓库**不含**任何密钥、令牌、口令、证书，也不含 `secrets.vault`、`agent.token`、`*.env`（`*.env.example` 示例文件除外）、`node_modules/`，以及 `~/.dsh` 下的运行态数据。这些都已列在 `.gitignore` 里。
- 新机器上的主口令、令牌、证书都要**重新生成**，不要从旧机器复制。需要迁移密钥库里的条目时，用 `secret_export` / `secret_import`，见 `plugins/dsh-secrets/docs/USAGE.md`。
- `profile/` 是脱敏副本，里面的 `/srv/...` 路径只是服务器上的原始路径，换机器时要改。

## 6. 已知限制

1. `profile/` 和 `plugins/dsh-router-b/cordis.patch.yml` 里有服务器的绝对路径（分区根、Exa MCP 路径）。逐条替换的清单见 [MANIFEST.md](MANIFEST.md) 第 6 节。
2. 改 router 的 host 时要先用 `plugins/dsh-router-b/scripts/safe-build-host.sh` 生成 `lib.next/`，再由人工执行 `safe-restart.sh` 换入。**不要直接改运行中的 `lib/`**。
3. Gitea（8444）强制 mTLS，需要管理员线下提供客户端证书，见 [CLONE.md](CLONE.md)。
4. 不要让 v1 版本的 agent-hub 插件和 dsh-hub 使用同一个 DSH home 同时运行，两者都会写 `<DSH home>/agent-hub/state.json`。

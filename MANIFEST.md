# MANIFEST.md · dsh-warroom 发布清单（2026-11-23 更新；上一个发布 tag 为 v2026.11.21）

这次推的是**一套跑在 DeepSeek Harness（DSH）上的「作战室」定制**：6 个自研插件
（分区路由 / Token 统计 / 出口代理 / VPN / 加密保险库 / Agent 调度）+ 独立调度服务 `services/dsh-hub` +
一份 `web` profile 覆盖层 +
迁移文档 + 脱敏的 nginx / systemd 模板 + 随仓库分发的 Exa stdio MCP（`vendor/`）+
浏览器截图工具（`scripts/browser*`）。仓库**不含**任何密钥、口令、证书、`sessions/`、
`vault`、`node_modules/` 与 DSH 本体。

- 上一个发布 tag：`v2026.11.21`（当时 398 个文件）；本文件的数字按 **2026-11-23 的 `main` 工作树**重新统计
- 当前规模：**552 个文件 / 约 9.80 MB**（不含 `.git`，并按 `.gitignore` 排除 `node_modules/`、`lib.next/`、
  `*.bak-*`、`.ui-backup/`、`__pycache__/` 等；做法是按根目录与各子目录的 `.gitignore` 规则遍历工作树计数。发布后可用 `git ls-files | wc -l` 复核）
- 与 v2026.11.21 相比新增：`plugins/dsh-agent-hub/`、`services/dsh-hub/`（含 `deploy/docker/` 本地联调）、
  `plugins/dsh-secrets/packages/client-ui-secrets/`（只读密钥看板）、`.deps/`（构建依赖清单）、
  `docs/INDEX.md`、`docs/UI-STYLE.md`、`docs/DSH-HUB-PROTOCOL-v2.md`、`docs/DEPLOY-HUB-PROMPT.md`
- 运行基线：DSH `0.2.2-rc.5`、Node >= 24.9（DSH 0.2.2-rc.5 本身的要求）、profile `web`
- 仓库：`https://8.134.170.38:8444/dev/dsh-warroom.git`（私有，mTLS；见 `CLONE.md`）

> 本文件里的路径都以**仓库根目录**为起点。仓库用 `plugins/<插件名>/` 布局；下载包 zip 可能
> 按插件平铺（`dsh-router-b/`…），对照表见 1.2。

---

## 1. 顶层目录表

### 1.1 目录 → 用途 → 关键入口

| 目录 / 文件 | 用途 | 关键入口文件 | 文件数 |
|---|---|---|---|
| `README.md` | 仓库总览、6 个插件一览、「从零开始」、架构图 | `README.md` | 1 |
| `.gitignore` | 排除 `node_modules/`、构建中间态、`*.bak-*`、`.ui-backup/`、密钥/证书/`*.env`/令牌、`.dsh-artifacts/`；放行 `*.env.example` 与 `vendor/exa-mcp-server/dist/` | — | 1 |
| `plugins/dsh-router-b/` | 分区路由 + 作战室三栏界面 | `index.js`、`cordis.patch.yml`、`packages/host-router/lib/index.js`、`packages/client-ui-router/lib/client.js` | 197 |
| `plugins/dsh-token-stats/` | 侧栏 Token 用量统计 | `index.js`、`packages/host-token-stats/index.js`、`packages/client-ui-token-stats/lib/client.js` | 26 |
| `plugins/dsh-egress/` | 模型端点出口代理面板（fail-closed） | `index.js`、`packages/host-egress/lib/index.js`、`packages/client-ui-egress/lib/client.js` | 83 |
| `plugins/dsh-vpn/` | openfortivpn 管理 + 看门狗 + VPN 页面 | `index.js`、`packages/host-vpn/lib/index.js`、`packages/client-ui-vpn/lib/client.js` | 80 |
| `plugins/dsh-secrets/` | 本地加密保险库 + 只读密钥看板（client-ui-secrets 15 个文件） | `index.js`、`cordis.patch.yml`、`packages/host-secrets/vault.js`、`packages/client-ui-secrets/lib/client.js` | 48 |
| `plugins/dsh-agent-hub/` | **新增**：DSH 作为 dsh-hub 控制方（host 15、client 16）+ worker 客户端 `scripts/agent_client.py` | `index.js`、`packages/host-agent-hub/index.js`、`packages/client-ui-agent-hub/lib/client.js`、`scripts/agent_client.py` | 44 |
| `services/dsh-hub/` | **新增**：独立调度服务（端口 7891，`dsh-agent/2.0`）；`deploy/docker/` 本地联调 9 个文件 | `server.mjs`、`lib/hub.js`、`hub.example.json`、`deploy/dsh-hub.service` | 24 |
| `profile/` | `web` profile 覆盖层（脱敏副本，路径仍需改） | `package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml` | 4 |
| `docs/` | 文档总目录、部署、协议、UI 规范、迁移审计、nginx 模板（`nginx/` 5 个，含在本行内） | `INDEX.md`、`README-MIGRATE.md`、`DSH-HUB-PROTOCOL-v2.md`、`DEPLOY-HUB-PROMPT.md`、`UI-STYLE.md`、`W1`–`W6` | 18 |
| `vendor/exa-mcp-server/` | 第三方 Exa stdio MCP（**已入仓**，MIT，3.5.1） | `dist/stdio.cjs`、`package.json`、`LICENSE`、`mcp.json` | 19 |
| `scripts/` | 本机浏览器截图 / Chromium lane 工具（非 DSH 运行必需） | `browser`（bash 包装）、`browser.py`（Playwright/CDP） | 2 |
| `.deps/` | **新增**：构建 client 用的公共依赖清单（esbuild、typescript、@types/react）；`node_modules/` 不入库 | `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 3 |
| `CLONE.md` / `MANIFEST.md` | 在 Windows / WSL 上 clone；本清单（根目录） | 本文件 | 2 |

合计：1 + 1 + 197 + 26 + 83 + 80 + 48 + 44 + 24 + 4 + 18 + 19 + 2 + 3 + 2 = **552**
（括号里的子目录文件数已含在所在行内，不重复计。统计时间 2026-11-23。）

各插件目录内部结构一致：

```text
plugins/<插件名>/
├── index.js              # bundle 入口（package.json main）
├── cordis.patch.yml      # bundle 挂载层：插入 host / client 两个插件
├── package.json          # name / main / dsh.bundle.patch / files 白名单
├── icon.svg              # 侧栏/详情页图标
├── locale/{en,zh}.json   # 插件管理里显示的标题 / 描述 / 详细说明（meta.title / description / detail）
├── packages/
│   ├── host-<x>/         # 宿主侧（Node），多数有 src/ + lib/ 构建产物
│   └── client-ui-<x>/    # 浏览器侧（TSX），lib/client.js 是构建产物
├── scripts/              # install.mjs、build.mjs、（router 另有 safe-build/safe-restart）
├── README.md             # 插件说明（第一次安装看这个）
└── docs/                 # 该插件的详细文档（router/egress/vpn/secrets 有）
```

### 1.2 仓库布局 ↔ 下载包平铺布局

| 仓库内路径 | 下载包 zip 里可能是 | 说明 |
|---|---|---|
| `plugins/dsh-router-b/` | `dsh-router-b/` 或 `router-b/` | 文件名不变，前缀可能不同 |
| `plugins/dsh-token-stats/` | `dsh-token-stats/` 或 `token-stats/` | 同上 |
| `plugins/dsh-egress/` | `dsh-egress/` 或 `egress/` | 同上 |
| `plugins/dsh-vpn/` | `dsh-vpn/` 或 `vpn/` | 同上 |
| `plugins/dsh-secrets/` | `dsh-secrets/` | v2026.11.21 新增 |
| `plugins/dsh-agent-hub/` | `dsh-agent-hub/` | 2026-11-23 新增 |
| `services/dsh-hub/` | `services/dsh-hub/` | 2026-11-23 新增；独立服务，不挂进 profile |
| `vendor/exa-mcp-server/` | `vendor/exa-mcp-server/` | v2026.11.21 新增；必须保留 `dist/stdio.cjs` |
| `scripts/` | `scripts/` | v2026.11.21 新增；`browser` + `browser.py` 成对保留 |
| `profile/`、`docs/` | 同名 | 不变 |

无论解压成哪种前缀，**目录的 basename 必须改回 `dsh-router-b`、`dsh-token-stats`、
`dsh-egress`、`dsh-vpn`、`dsh-secrets`、`dsh-agent-hub`**，因为 `profile/package.json` 的 `link:` 和
`node_modules/` 软链都按这六个名字找包。本文后续命令统一用：

```bash
export R="$(pwd)/plugins"     # 仓库根目录下执行；平铺包则改成 export R="$(pwd)"
```

---

## 2. 插件全覆盖对照表

数据来源：服务器上真实生效的 `/root/.dsh/profiles/web/package.json`（当时 14 条 `dependencies`、
7 条 `bundles`；2026-11-23 仓库副本已扩到 18 条 / 8 条，见下表新增行），与仓库 `profile/package.json` 逐条核对。

### 2.1 18 个 `link:` 包

| 包名 | 类型 | 是否入仓 | 仓库内路径 | 入口 / main |
|---|---|---|---|---|
| `dsh-router-b` | 自研 bundle | 是 | `plugins/dsh-router-b` | `index.js` |
| `dsh-host-router` | 自研 host | 是 | `plugins/dsh-router-b/packages/host-router` | `lib/index.js` |
| `dsh-client-ui-router` | 自研 client | 是 | `plugins/dsh-router-b/packages/client-ui-router` | `lib/index.js`，`./client → lib/client.js` |
| `dsh-egress` | 自研 bundle | 是 | `plugins/dsh-egress` | `index.js` |
| `dsh-host-egress` | 自研 host | 是 | `plugins/dsh-egress/packages/host-egress` | `lib/index.js` |
| `dsh-client-ui-egress` | 自研 client | 是 | `plugins/dsh-egress/packages/client-ui-egress` | `lib/index.js`，`./client → lib/client.js` |
| `dsh-vpn` | 自研 bundle | 是 | `plugins/dsh-vpn` | `index.js` |
| `dsh-host-vpn` | 自研 host | 是 | `plugins/dsh-vpn/packages/host-vpn` | `lib/index.js` |
| `dsh-client-ui-vpn` | 自研 client | 是 | `plugins/dsh-vpn/packages/client-ui-vpn` | `lib/index.js`，`./client → lib/client.js` |
| `dsh-token-stats` | 自研 bundle | 是 | `plugins/dsh-token-stats` | `index.js` |
| `dsh-host-token-stats` | 自研 host | 是 | `plugins/dsh-token-stats/packages/host-token-stats` | `index.js`（纯 JS，无 lib） |
| `dsh-client-ui-token-stats` | 自研 client | 是 | `plugins/dsh-token-stats/packages/client-ui-token-stats` | `lib/index.js`，`./client → lib/client.js` |
| `dsh-secrets` | 自研 bundle（新增） | 是 | `plugins/dsh-secrets` | `index.js` |
| `dsh-host-secrets` | 自研 host（新增） | 是 | `plugins/dsh-secrets/packages/host-secrets` | `index.js`（纯 JS，无 lib） |
| `dsh-client-ui-secrets` | 自研 client（2026-11-23 新增） | 是 | `plugins/dsh-secrets/packages/client-ui-secrets` | `lib/index.js`，`./client → lib/client.js` |
| `dsh-agent-hub` | 自研 bundle（2026-11-23 新增） | 是 | `plugins/dsh-agent-hub` | `index.js` |
| `dsh-host-agent-hub` | 自研 host（2026-11-23 新增） | 是 | `plugins/dsh-agent-hub/packages/host-agent-hub` | `index.js`（纯 JS，无 lib） |
| `dsh-client-ui-agent-hub` | 自研 client（2026-11-23 新增） | 是 | `plugins/dsh-agent-hub/packages/client-ui-agent-hub` | `lib/index.js`，`./client → lib/client.js` |

### 2.2 `dsh.profile.bundles` 顺序（8 项，顺序即加载顺序）

| # | bundle | 来源 | 作用 |
|---|---|---|---|
| 1 | `@deepseek-ai/dsh-base` | 官方，版本 `0.2.2-rc.5` | DSH 基础能力 |
| 2 | `@deepseek-ai/dsh-web-app` | 官方，版本 `0.2.2-rc.5` | Web GUI 外壳 |
| 3 | `dsh-router-b` | 自研 | 分区路由 + 作战室界面 |
| 4 | `dsh-egress` | 自研 | 出口代理面板 |
| 5 | `dsh-vpn` | 自研 | VPN 面板 |
| 6 | `dsh-token-stats` | 自研 | Token 用量面板 |
| 7 | `dsh-secrets` | 自研（新增） | 加密保险库 + 只读密钥看板 |
| 8 | `dsh-agent-hub` | 自研（2026-11-23 新增） | dsh-hub 控制方 + Agent 调度页 |

官方包**不入仓**：由 `dsh` 安装包（`@deepseek-ai/dsh@0.2.2-rc.5`）自带，profile 只写 bundle 名。
client 侧还会在运行期注入官方 `@deepseek-ai/dsh-client-locale`、`dsh-client-ui-layout`、
`dsh-client-ui-sidebar`、`dsh-client-ui-sidebar-right`，同样不入仓、不用手装。

### 2.3 第三方 vendor：`exa-mcp-server`（已入仓，不是外部依赖）

| 项 | 值 |
|---|---|
| 包 / 版本 | `exa-mcp-server` `3.5.1` |
| 来源 | npm 包；上游 `github.com/exa-labs/exa-mcp-server` |
| 许可 | MIT，仓库内附 `vendor/exa-mcp-server/LICENSE` |
| 仓库路径 | `vendor/exa-mcp-server/`，**19 个文件 / 1,844,374 B（约 1.84 MB）** |
| 关键文件 | `dist/stdio.cjs`（stdio MCP 入口）、`package.json`、`mcp.json`、`plugin.json`、`skills/` |
| 用途 | Exa 搜索的 **stdio** MCP（`profile/cordis.patch.yml` 里的 `exa-stdio`） |
| 是否要用户安装 | **不用**。已随 tag / 下载包分发；解包后直接用 `node vendor/exa-mcp-server/dist/stdio.cjs` |
| 需要的配置 | 改 `profile/cordis.patch.yml:258` 的绝对路径为 `<CHECKOUT>/vendor/exa-mcp-server/dist/stdio.cjs`；填 `EXA_API_KEY` 后把 `enabled: false` 改成 `true` |
| 重建方式（可选） | `npm pack exa-mcp-server@3.5.1`，把 tarball 里的 `package/` 解到 `vendor/exa-mcp-server/`；保证 `dist/stdio.cjs` 在 |

> `.gitignore` 对 `vendor/exa-mcp-server/dist/` 做了例外（其余 `dist/` 仍排除），所以这个
> 上游预打包入口能入库。`node_modules/` 仍不入库，这个包也不需要。
>
> 不用它也能跑：`exa-stdio` 默认 `enabled: false`；远程 `exa`（streamable-http，
> `https://mcp.exa.ai/mcp`）是匿名可用、不需要 key 的另一条。

---

## 3. 各插件的用途、构建与加载方式

### 3.0 先记住三条规则

1. **6 个 bundle 全部是 profile `link:` 源码直挂**，DSH 启动时直接读仓库目录；**不要**在仓根或
   profile 目录跑 `pnpm install`（会重写整棵依赖树，源机曾把一个包删空）。
2. `lib/` 是**已构建好的运行产物，随仓库入库**。`main` / `exports` 直接指向 `lib/`，
   **运行期不会编译 `src/`**。只改配置/文档不用构建。
3. **不要手写运行中的 host `lib/`**：DSH 启动时加载它，运行中改写可能把插件卸载。
   router 的 host 改动走 `scripts/safe-build-host.sh`（只写 `lib.next/`），再由人工执行
   `scripts/safe-restart.sh` 换入。

### 3.1 `dsh-router-b`（分区路由 + 作战室）

| 项 | 内容 |
|---|---|
| 职责 | 把工作按文件分区路由给 worker；Web GUI 里提供任务板 / 分区负载 / worker 进度（三栏界面） |
| host 包 | `packages/host-router`，`main = lib/index.js`；`src/` 为 TypeScript 源码，`lib/` 为 `tsc -b` 产物 |
| client 包 | `packages/client-ui-router`，`main = lib/index.js`，`exports["./client"] = lib/client.js`（esbuild 产物，浏览器加载） |
| 入口 | bundle `index.js` → `cordis.patch.yml` 插入 `host-router` 与 `client-ui-router` |
| 构建（全量） | `cd "$R/dsh-router-b" && node scripts/build.mjs`（client 声明 → client bundle → host tsc → 测试） |
| 只构建 host（安全） | `bash "$R/dsh-router-b/scripts/safe-build-host.sh"` → 只写 `packages/host-router/lib.next/`；然后**人工**跑 `scripts/safe-restart.sh` |
| 依赖 | 若要构建 client：`cd packages/client-ui-router && npm ci`（devDeps 有 esbuild / react / typescript） |
| 改完要不要重启 | host 改动：**要**（`safe-restart.sh`）；client `lib/client.js` 改动：浏览器刷新即可（HMR 只在 `pnpm run dev:web` 时自动，通常刷新页面足够） |
| 关键文档 | `docs/HANDOFF.md`、`docs/UPGRADE.md`、`docs/INTEGRATION.md`、`docs/API-0.2.2-rc.3.md` |
| 部署件 | `deploy/nginx-dsh-web.conf`（8443 入口模板）、`deploy/E0-install-gate.sh`、`deploy/dsh-web-gate.mjs`、`deploy/cordis.patch.server.yml` |

### 3.2 `dsh-token-stats`（Token 用量）

| 项 | 内容 |
|---|---|
| 职责 | 只读 `$DSH_HOME/sessions`，在侧栏汇总当天/7 天/30 天 Token 用量，按模型拆分 |
| host 包 | `packages/host-token-stats`，`main = index.js`；**纯 JS，无 src、无 lib、无构建**（`index.js` / `scanner.js` / `bridge.js`） |
| client 包 | `packages/client-ui-token-stats`，`main = lib/index.js`，`./client → lib/client.js` |
| 构建 | 只在改 client 源码时需要：`node "$R/dsh-token-stats/scripts/build.mjs"`；构建依赖可复用 router 的 `node_modules`（或设 `DSH_CLIENT_MODULES`） |
| 改完要不要重启 | host 改动：要；client 改动：刷新页面 |
| 数据源 | `~/.dsh/sessions/<projectSlug>/<sessionId>/session.v4.jsonl.zstd`；无会话时显示空态，不报错 |

### 3.3 `dsh-egress`（出口代理）

| 项 | 内容 |
|---|---|
| 职责 | 给每个模型端点选出口（http / https / socks5 / direct），fail-closed；提供 `/api/egress/*` 与只读 `egress_status` 工具 |
| host 包 | `packages/host-egress`，`main = lib/index.js`；`src/` TypeScript，`lib/` 构建产物 |
| client 包 | `packages/client-ui-egress`，`main = lib/index.js`，`./client → lib/client.js` |
| 构建 | `node "$R/dsh-egress/scripts/build.mjs"`（含 host tsc + client bundle + 测试） |
| 改完要不要重启 | host 改动：要；client 改动：刷新页面 |
| 状态目录 | `<DSH_HOME>/egress/`（`config.json` 0600）；**不在仓库**，新机首次启动为空出口列表，所有端点默认 `direct` |

### 3.4 `dsh-vpn`（VPN 面板）

| 项 | 内容 |
|---|---|
| 职责 | 管理 openfortivpn 配置、连接/断开、看门狗、本机探活，读连接日志；提供 `/api/vpn/*` 与 `vpn_status` 工具 |
| host 包 | `packages/host-vpn`，`main = lib/index.js`；`src/` TypeScript，`lib/` 构建产物 |
| client 包 | `packages/client-ui-vpn`，`main = lib/index.js`，`./client → lib/client.js` |
| 构建 | `node "$R/dsh-vpn/scripts/build.mjs"` |
| 改完要不要重启 | host 改动：要；client 改动：刷新页面 |
| 系统依赖 | `openfortivpn` 必须在 PATH；`localProbePort` 默认 42443，改 DSH 端口时要同步（见 6 节） |
| 状态目录 | `<DSH_HOME>/vpn/`（`profiles.json`、`secrets/`、`run-*.conf`）；**不在仓库**，VPN 账号口令由使用者自己录 |

### 3.5 `dsh-secrets`（本地加密保险库）——单独写全

**定位**：代理可以**写入和使用**密钥，但**永远读不回来**。没有 `secret_get`，也没有任何代码路径
返回值。实现是 AES-256-GCM + scrypt，vault 文件 `0600`，父目录 `0700`。

#### 目录与文件

| 路径 | 作用 |
|---|---|
| `plugins/dsh-secrets/package.json` | `name=dsh-secrets`、`main=index.js`、`dsh.bundle.patch=./cordis.patch.yml`；`dependencies` 里 `dsh-host-secrets: file:./packages/host-secrets` |
| `plugins/dsh-secrets/index.js` | bundle 入口（很小，只做挂载） |
| `plugins/dsh-secrets/cordis.patch.yml` | 插入 `host-secrets` 插件；`keySource: passphrase-env`、`passphraseEnv: DSH_SECRETS_PASSPHRASE`、`redactToolOutput: true`；其余键全部可选（`vaultPath`、`keyfilePath`、`scryptN`、`execAllowedCommands`、`httpAllowedHosts`…） |
| `plugins/dsh-secrets/DESIGN.md` | 威胁模型、为什么复用 DSH 既有模式、vault 文件格式、脱敏设计、为什么不做 `secret_get` |
| `plugins/dsh-secrets/docs/USAGE.md` | 完整使用手册：安装、口令、10 个工具、导出/导入、systemd EnvironmentFile、故障排查 |
| `plugins/dsh-secrets/docs/READINESS.md` | 上线前检查单与已知限制 |
| `plugins/dsh-secrets/packages/host-secrets/index.js` | 注册 10 个工具、启动日志打印 `10 tools registered` |
| `plugins/dsh-secrets/packages/host-secrets/vault.js` | 加密/解密、scrypt KDF、原子写、锁、`assertPrivate()`（拒绝 group/other 可读） |
| `plugins/dsh-secrets/packages/host-secrets/config.js` | 配置校验与默认值；`dshHome()` 决定 vault/key 默认路径 |
| `plugins/dsh-secrets/packages/host-secrets/tools.js` | 10 个工具的实现 |
| `plugins/dsh-secrets/packages/host-secrets/placeholders.js` | `${secret:NAME}` 占位符展开（`secret_http` / `secret_exec` 用） |
| `plugins/dsh-secrets/packages/host-secrets/redact.js` | 工具输出里已知密钥值的最长优先替换脱敏 |
| `plugins/dsh-secrets/packages/host-secrets/tests/*.test.mjs` | 5 个测试文件（vault / tools / redact / integration / helpers） |
| `plugins/dsh-secrets/scripts/install.mjs` | 唯一的安装器：写 `dependencies` 三条 link（bundle / host / client）、保证 `bundles` 有 `dsh-secrets`、建三个软链；`--dry-run` / `--uninstall` / `--profile` |
| `plugins/dsh-secrets/scripts/ingest-file.mjs` | 批量把文件写进 vault（**不经过会话**，值不进日志） |
| `plugins/dsh-secrets/scripts/ingest-file.selftest.mjs` | ingest 的自测；不碰真实 vault |
| `plugins/dsh-secrets/scripts/scan-keys.mjs` | 只读扫描“哪里有密钥文件”并生成清单，**不读 vault、不输出值** |

#### 10 个工具

`secret_set`、`secret_describe`、`secret_list`、`secret_check`、`secret_rename`、
`secret_delete`、`secret_exec`、`secret_http`、`secret_export`、`secret_import`。

#### 构建与加载

- host 侧**没有 `lib/`、没有构建步骤**（纯 JS，profile `link:` 直挂）；只读密钥看板 `packages/client-ui-secrets`
  的 `lib/client.js` 是构建产物，改了 client 源码后跑 `node scripts/build.mjs`。
- 安装：`node "$R/dsh-secrets/scripts/install.mjs" --profile "$HOME/.dsh/profiles/web"`。
- 改完 host 代码 / `cordis.patch.yml`：**必须重启** DSH（不是 HMR）。
- 自测：`cd "$R/dsh-secrets" && node --test packages/host-secrets/tests/*.test.mjs`。

#### vault / key / passphrase：本地生成，绝不随仓库分发

| 东西 | 默认位置 | 说明 |
|---|---|---|
| vault | `<DSH_HOME>/secrets.vault`（默认 `~/.dsh/secrets.vault`） | AES-256-GCM，`0600`；**第一次写入时自动创建**，没有“初始化命令” |
| keyfile | `<DSH_HOME>/secrets.key` | 仅 `keySource: keyfile` 时用；32 字节随机，`0600` |
| passphrase | 环境变量 `DSH_SECRETS_PASSPHRASE` | 推荐路线；只存在于 systemd 进程环境，不落盘（`/etc/dsh-secrets.env` 是 600 的 EnvironmentFile） |

**这三样都不在仓库里，也不能从旧机复制过来当“迁移”。** 正确做法：

1. 新机**重新生成** passphrase（或 keyfile），不要复用旧机的；
2. 新机**新建空 vault**（第一次 `secret_set` 自动建）；
3. 需要搬条目时，用 `secret_export`（旧机，指定一个**导出专用**强口令）→ 把导出的加密文件
   拷到新机 → `secret_import`（新机，用导出时的口令）→ 删掉中间文件；
   注意导入口令与**新机主口令是两回事**；
4. 旧机的 `secrets.vault` / `secrets.key` 本身不要拷、不要提交、不要进备份包。

`secret_export` 生成的是**另一个口令加密的独立文件**，不是 vault 本身；即使它泄露，没有导出
口令也打不开。仍然要按密钥文件对待。

### 3.6 `scripts/`、`docs/`、`profile/`、`vendor/`、nginx 模板

| 位置 | 内容 | 用法 |
|---|---|---|
| `plugins/*/scripts/` | 每个插件自己的 `install.mjs`；router 另有 `build.mjs`、`safe-build-host.sh`、`safe-restart.sh`；secrets 另有 `ingest-file*.mjs`、`scan-keys.mjs` | 插件的安装脚本都在这里，没有统一的 `./scripts/install.sh` |
| `scripts/browser` | bash 包装器：调用 `/opt/shot/venv/bin/python` 的 `browser.py`，驱动常驻 Chromium（CDP `127.0.0.1:9222`）和隔离 lane | `scripts/browser --help`；**非 DSH 运行必需**，装到别的机器要改 shebang / venv / 路径 |
| `scripts/browser.py` | Playwright + CDP 的浏览器操作/截图工具；lane 用 Xvfb + x11vnc + noVNC，状态在 `/srv/browser/lanes`、`/srv/browser/identities` | 配合 `scripts/browser` 用；不参与 DSH 插件加载 |
| `docs/README-MIGRATE.md` | 最完整的安装手册（系统依赖、Node/pnpm、profile、软链、dump-config、systemd/nginx） | 先读它，再按本文件第 8 节做 |
| `docs/MANIFEST.md` | W1 生成的“发布内容 / 来源 / 路径映射”清单（与根目录本文件不同） | 查某个包从哪来、进没进仓库、排除了什么 |
| `docs/CLONE-ON-WORKSTATION.md` | 在自家电脑 clone 的旧版说明（**里面的 IP 是旧的**，以 `CLONE.md` 为准） | 仅作背景 |
| `docs/W1`–`W6` | 运行时配置、系统依赖、插件机制、仓库内容、数据源路径、合成手册（审计报告） | 查细节 / 排错 |
| `docs/nginx/` | 4 个站点模板：`dsh-web.conf`(8443)、`gitea.conf`(8444 mTLS)、`browser-novnc.conf`(8445)、`couple-fit.conf`(8450) | 复制到 `/etc/nginx/sites-available/`，替换 `__...__` 占位符后再 `nginx -t` |
| `docs/INDEX.md` | 所有文档的目录（先读 / 部署 / 协议与设计 / 迁移审计历史） | 找文档先看它 |
| `docs/DSH-HUB-PROTOCOL-v2.md` | dsh-hub 协议 `dsh-agent/2.0`：角色、令牌、接口、工作区路由、网络与代理 | 改 hub / 控制方 / worker 前必读 |
| `docs/DEPLOY-HUB-PROMPT.md` | 交给服务器上云端 DSH 的部署提示词（两轮，以重启 dsh-web 为界） | 整段复制给云端 DSH |
| `docs/UI-STYLE.md` | 所有 client-ui 插件共用的 UI 规范 | 改界面前看 |
| `.deps/` | 构建 client 的公共依赖清单 | `cd .deps && pnpm install`，再 `export DSH_CLIENT_MODULES=$(pwd)/node_modules` |
| `vendor/exa-mcp-server/` | 第三方 Exa stdio MCP 3.5.1（MIT，19 文件，含 `dist/stdio.cjs`） | 已入库，**不需要再 npm 安装**；只在 `profile/cordis.patch.yml` 里改路径、按需启用 |
| `profile/package.json` | 18 条 `link:` + 8 个 bundles（源机绝对路径） | **不要直接复制**；按 8.3 用 `install.mjs` 重建 |
| `profile/cordis.patch.yml` | 唯一真正生效的覆盖层：品牌、provider/模型、分区 root、Exa MCP、主题等 | 复制到 `~/.dsh/profiles/web/` 后按 6 节改路径 |
| `profile/cordis.yml` | 内容就是 `[]`（纯注释占位） | 原样复制 |
| `profile/pnpm-workspace.yaml` | `packages: [.]`、`nodeLinker: hoisted`、`autoInstallPeers: false` | 原样复制；**不要**因此去跑 `pnpm install` |

### 3.7 `dsh-agent-hub`（dsh-hub 控制方 + Agent 调度页，2026-11-23 新增）

| 项 | 内容 |
|---|---|
| 职责 | 让 DSH 作为 dsh-hub 的控制方：11 个工具（`agent_*` / `task_*`）调用 hub 的 `/v1/ctl/*`；面板只读接口 `/api/agent-hub/admin/*`；插件本身不存任务状态 |
| host 包 | `packages/host-agent-hub`，`main = index.js`（纯 JS，无 lib；`hub.js` 是 v1 参考实现，已不加载） |
| client 包 | `packages/client-ui-agent-hub`，`./client → lib/client.js`；嵌在 router-b 任务板里的「Agent」页签 |
| 构建 | 只在改 client 源码时：`node packages/client-ui-agent-hub/scripts/build-client.mjs` |
| 安装 | `node "$R/dsh-agent-hub/scripts/install.mjs" --profile "$P"`（写 3 条 link、加 bundle、建 3 个软链） |
| 必须配置 | `<DSH home>/agent-hub/controller.env`：`DSH_HUB_URL`、`DSH_HUB_CONTROLLER_ID`、`DSH_HUB_TOKEN`，按需 `DSH_HUB_PROXY`、`DSH_HUB_CAFILE`。**不能写进 `<DSH home>/.env`** |
| worker 端 | `scripts/agent_client.py`（Python 3，无第三方依赖）；配置 `<DSH home>/worker/.env` + `profile.json`，模板 `scripts/worker.env.example`、`profile.example.json` |
| 说明 | `plugins/dsh-agent-hub/README.md` |

### 3.8 `services/dsh-hub`（独立调度服务，2026-11-23 新增）

| 项 | 内容 |
|---|---|
| 职责 | 存任务、按工作区 / 机器 / 能力路由、租约与重试、产物；给多个控制方和 N 个 worker 服务 |
| 启动 | `node services/dsh-hub/server.mjs`（Node >= 22，无第三方依赖）；systemd unit 模板 `deploy/dsh-hub.service` |
| 端口 | 7891（服务器 `8.134.170.38:7891`；7890 是 MYDESK 本机 Clash 代理端口，不要混用） |
| 配置 / 状态 | `<DSH home>/agent-hub/hub.json`（模板 `hub.example.json`）、`state.json`、`controllers.json`、`artifacts/`；**都不入库** |
| 令牌 | 只能在 hub 机器上签发：`node server.mjs controller add <id>`（只显示一次） |
| 本地联调 | `deploy/docker/`：`docker compose up -d --build hub`；生成的 CA 在 `deploy/docker/out/`（已被 `.gitignore` 排除） |
| 测试 | `node --test services/dsh-hub/tests/*.test.mjs` |
| 说明 | `services/dsh-hub/README.md`、`deploy/docker/README.md`、`docs/DSH-HUB-PROTOCOL-v2.md` |

---

## 4. 构建 / 加载方式速查

| 插件 | 加载方式 | 运行产物 | 改 client 后 | 改 host 后 | 需要重启？ |
|---|---|---|---|---|---|
| `dsh-router-b` | profile `link:` 直挂 | `host-router/lib/*.js`、`client-ui-router/lib/client.js` | `node scripts/build.mjs`（或只 `npm run build` 该子包） | `safe-build-host.sh` → 人工 `safe-restart.sh` | host：是；client：刷新 |
| `dsh-token-stats` | 同上 | `client-ui-token-stats/lib/client.js`；host 是纯 JS | `node scripts/build.mjs` | 直接改 JS（无 lib） | host：是；client：刷新 |
| `dsh-egress` | 同上 | `host-egress/lib/*.js`、`client-ui-egress/lib/client.js` | `node scripts/build.mjs` | `node scripts/build.mjs` 后重启 | 是（host 改动） |
| `dsh-vpn` | 同上 | `host-vpn/lib/*.js`、`client-ui-vpn/lib/client.js` | `node scripts/build.mjs` | 同上 | 是（host 改动） |
| `dsh-secrets` | 同上 | host 无 lib（纯 JS）；`client-ui-secrets/lib/client.js` | `node scripts/build.mjs` | 直接改 JS | host：是；client：刷新 |
| `dsh-agent-hub` | 同上 | host 无 lib（纯 JS）；`client-ui-agent-hub/lib/client.js` | `node packages/client-ui-agent-hub/scripts/build-client.mjs` | 直接改 JS | host：是；client：刷新 |
| `services/dsh-hub` | 独立进程（systemd） | `server.mjs` + `lib/*.js`（纯 JS） | — | 直接改 JS | `systemctl restart dsh-hub` |

补充：

- `safe-build-host.sh` 只存在于 router，且只构建 **host** 到 `lib.next/`；其它 host 包没有
  `lib.next` 机制，生产机上改 host 要在维护窗口构建 + 重启，**不要**直接覆盖运行中的 `lib/`。
- client bundle 的自动 HMR 只在开发模式（`pnpm run dev:web`）下生效；生产环境改完
  `lib/client.js` 后刷新浏览器即可，不需要重启 DSH。
- 所有 `install.mjs` 都是**幂等**的，重复跑只打印 `already installed`；每次改 `package.json`
  前会留 `package.json.bak-install-<时间戳>`。

---

## 5. 哪些是本机特有、不能直接复制

| 本机对象 | 位置 | 仓库里有什么 | 新机怎么办 |
|---|---|---|---|
| systemd unit | `/etc/systemd/system/dsh-web.service`、`dsh-web-gate.service` 及 `dsh-web.service.d/10-secrets.conf` | **没有** unit 文件；只有 `deploy/E0-install-gate.sh` 会生成 gate unit 和 8443 站点 | 按 8.7 自己写（模板见下） |
| systemd drop-in | `/etc/systemd/system/dsh-web.service.d/10-secrets.conf`（`EnvironmentFile=/etc/dsh-secrets.env`） | 没有 | `systemctl edit dsh-web.service` 写入 |
| Gitea 站点（mTLS） | `/etc/nginx/sites-available/gitea` + `/etc/nginx/tls/{gitea.crt,gitea.key,client-ca.crt}` | `docs/nginx/gitea.conf` **脱敏模板**；证书/私钥/客户端 CA **完全不在仓库** | 模板替换占位符；证书由管理员线下给 |
| DSH Web 站点 | `/etc/nginx/sites-available/dsh-web` + `/etc/nginx/tls/dsh.crt` 与 `dsh.key` + `/etc/nginx/.dsh-auth` | `docs/nginx/dsh-web.conf`、`plugins/dsh-router-b/deploy/nginx-dsh-web.conf` | 模板替换；TLS 证书可自签/ACME；basic auth 用 `htpasswd` 重建 |
| profile 绝对路径 | `/root/.dsh/profiles/web/package.json` 的 18 条 `link:` 与 `node_modules/` 18 条软链 | `profile/package.json` 是**源机路径的副本** | 按 8.3 重跑 `install.mjs`，不要复制 |
| profile 覆盖层里的路径 | `/root/.dsh/profiles/web/cordis.patch.yml` | `profile/cordis.patch.yml` 已脱敏，但仍含 `/srv/...` 的 Exa 路径 | 按 6 节逐条改 |
| 加密保险库 | `/root/.dsh/secrets.vault`、`/root/.dsh/secrets.key`、`/etc/dsh-secrets.env` | **没有，也不应该有** | 新机重新生成（见 3.5 与 8.4） |
| 运行态 | `/root/.dsh/sessions/`、`router/board.json`、`tiers.json`、`egress/config.json`、`vpn/profiles.json`、`vpn/secrets/` | 没有 | 新机自动生成空态；要历史数据单独迁移 |
| 机器 IP / 证书 | `8.134.170.38`（证书里仍是旧 CN/SAN）、`/etc/nginx/tls/*` | 模板里用 `__SERVER_NAME__` 等占位符；`deploy/nginx-dsh-web.conf` 里还是 `8.134.170.38` | 改成你的域名/IP，并重签/自签证书 |
| 工作区路径 | `/srv/workspace`、`/srv/workspace/deepseek-harness`、`/srv/dsh-*` | `profile/package.json`、`plugins/dsh-router-b/cordis.patch.yml`、`safe-build-host.sh`、`tsconfig.json`、secrets 脚本里都有 | 按 6 节替换 |
| Exa stdio 的路径 | `/srv/workspace/deepseek-harness/vendor/exa-mcp-server` | **已入仓** `vendor/exa-mcp-server/`（19 文件、MIT、3.5.1），含 `dist/stdio.cjs` 与 `LICENSE` | **不用重装**；只把 `profile/cordis.patch.yml:258` 改指到 `<CHECKOUT>/vendor/...`，需要更新时按 2.3 重建 |
| 浏览器截图工具 | `/opt/shot/venv/bin/python`、`/srv/browser/lanes`、`/srv/browser/identities`、CDP `127.0.0.1:9222` | `scripts/browser`、`scripts/browser.py` 已入仓 | 仅当你要用这套工具才改 shebang / venv / 根目录；**DSH 运行不需要它们** |
| dsh-hub 配置 / 状态 / 令牌 | `/root/.dsh/agent-hub/{hub.json,state.json,controllers.json,controller.env}`、TLS 私钥；各 worker 机器的 `<DSH home>/worker/{.env,profile.json,agent.token}` | 只有模板：`services/dsh-hub/hub.example.json`、`plugins/dsh-agent-hub/scripts/worker.env.example`、`profile.example.json` | 新机重新生成；令牌在 hub 上重新签发 |
| DSH 本体 | `@deepseek-ai/dsh@0.2.2-rc.5` | 不含 | 按 8.1 安装 |

systemd 最小模板（放 `/etc/systemd/system/dsh-web.service`，按需改）：

```ini
[Unit]
Description=DeepSeek Harness Web UI (127.0.0.1:42443)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=PNPM_HOME=/usr/local/pnpm-global
Environment=PATH=/usr/local/pnpm-global/bin:/usr/local/bin:/usr/bin:/bin
ExecStartPre=/usr/local/bin/dsh-fix-zod
ExecStart=/usr/local/pnpm-global/bin/dsh --profile web --no-open --host 127.0.0.1 --port 42443 --trusted-host __SERVER_NAME__:8443
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/dsh-web.log
StandardError=append:/var/log/dsh-web.log

[Install]
WantedBy=multi-user.target
```

说明：`dsh-fix-zod` 是源机自建的小脚本，**不是 DSH 官方件**；新机没有就删掉 `ExecStartPre`。
`--trusted-host` 必须与 nginx 的 `server_name` 一致。

---

## 6. 路径映射表（本机绝对路径 → 你的机器）

原则：**能重跑 `install.mjs` 生成的就不要手改**；其余按行号替换。行号以 tag 文件为准，
改版后行号可能平移，用 `grep -n` 复核。

| # | 文件:行 | 仓库中的值（本机） | 用户机器上应改成 |
|---|---|---|---|
| 1 | `profile/package.json:5-22` | `"link:/srv/dsh-router-b"` 等 18 条 | 不手改；用 8.3 的 `install.mjs` 逐插件重写为指向 `<CHECKOUT>/plugins/<包>` |
| 2 | `plugins/dsh-router-b/cordis.patch.yml:40` | `root: /srv/workspace/rca-ab-test` | `root: <WS>/rca-ab-test`（目录必须存在，或删掉该分区） |
| 3 | `plugins/dsh-router-b/cordis.patch.yml:68` | `root: "/srv/workspace/google tend"` | `root: "<WS>/google tend"`（**保留双引号**，路径有空格） |
| 4 | `plugins/dsh-router-b/cordis.patch.yml:90` | `root: /srv/workspace/deepseek-harness` | `root: <CHECKOUT>`（你的代码树根） |
| 5 | `profile/cordis.patch.yml:258` | `/srv/workspace/deepseek-harness/vendor/exa-mcp-server/dist/stdio.cjs`（vendor **已在仓库内**） | `<CHECKOUT>/vendor/exa-mcp-server/dist/stdio.cjs`；不用 Exa 就删掉 `exa-stdio` 整段 |
| 6 | `plugins/dsh-router-b/scripts/safe-build-host.sh:7` | `TSC="${DSH_TSC:-/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc}"` | `TSC="${DSH_TSC:-<你的 typescript>/bin/tsc}"`，或每次 `export DSH_TSC=...` |
| 7 | `plugins/dsh-router-b/packages/host-router/tsconfig.json:17` | `typeRoots` 指向 `/usr/local/pnpm-global/store/.../@types`（带 store hash） | `<你的 node_modules>/@types`（例：`/opt/dsh-tsc/node_modules/@types`） |
| 8 | `plugins/dsh-router-b/scripts/safe-restart.sh:10` | `BOARD=/root/.dsh/router/board.json` | `BOARD="${DSH_HOME:-$HOME/.dsh}/router/board.json"` |
| 9 | `plugins/dsh-vpn/cordis.patch.yml:28` | `localProbePort: 42443` | 改成你的 DSH 端口（与 unit `--port`、gate `GATE_UPSTREAM_PORT` 一致） |
| 10 | `plugins/dsh-router-b/deploy/nginx-dsh-web.conf:8` | `server_name 8.134.170.38;` | `server_name <你的域名或IP>;` |
| 11 | `plugins/dsh-router-b/deploy/nginx-dsh-web.conf:10-11` | `/etc/nginx/tls/dsh.crt` / `dsh.key` | 你的证书/私钥路径 |
| 12 | `plugins/dsh-router-b/deploy/E0-install-gate.sh:12,40,50-51,75` | 写 `/etc/systemd/system/dsh-web-gate.service`、`/etc/nginx/sites-available/dsh-web`、`/etc/nginx/tls/dsh.*`、`/etc/nginx/.dsh-auth` | 按你的路径改；或不用这个脚本，手工照 `docs/nginx/dsh-web.conf` 建 |
| 13 | `plugins/dsh-secrets/scripts/scan-keys.mjs:51` | `const DEFAULT_ROOT = '/srv/workspace'` | 改成你的工作区根（`--root` 也可覆盖，见 `--help`） |
| 14 | `plugins/dsh-secrets/scripts/ingest-file.mjs:66` | `const DEFAULT_KEYS_DIR = '/srv/workspace/keys'` | 改成你的待导入目录 |
| 15 | 不在仓库：systemd unit | `--trusted-host 8.134.170.38:8443`、`User=root`、`/var/log/dsh-web.log`、`/usr/local/pnpm-global/...` | 你的 host、运行用户、日志、dsh 路径；见第 5 节模板 |
| 16 | 不在仓库：Gitea 8444 | `/etc/nginx/tls/{gitea.crt,gitea.key,client-ca.crt}`、`ssl_verify_client on` | 由管理员线下提供；`docs/nginx/gitea.conf` 只给结构 |
| 17 | 不在仓库：`/etc/dsh-secrets.env` | 600 权限，内容只有 `DSH_SECRETS_PASSPHRASE=<新口令>` | 新机自己生成，见 8.4 |
| 18 | `docs/nginx/*.conf` | `__SERVER_NAME__`、`__TLS_CERT__`、`__TLS_KEY__`、`__CLIENT_CA__`、`__HTPASSWD_FILE__`、`__SITE_ROOT__` | 见 7 节占位符表 |
| 19 | `scripts/browser:11` | `exec /opt/shot/venv/bin/python /srv/workspace/bin/browser.py "$@"` | 你的 python 解释器 + `browser.py` 路径（仅当你要用截图工具） |
| 20 | `scripts/browser.py:1` | shebang `#!/opt/shot/venv/bin/python` | 你的 python 解释器 |
| 21 | `scripts/browser.py:33,42,46,52` | `LANE_ROOT=/srv/browser/lanes`、Chromium 路径、`DEFAULT_PROFILE=/srv/browser/profile`、`IDENTITY_ROOT=/srv/browser/identities` | 你的浏览器 lane / profile / identity 根目录，或用对应环境变量覆盖 |

`<WS>` = 你的工作区根（源机是 `/srv/workspace`）；`<CHECKOUT>` = 本仓库 checkout 根。

---

## 7. 占位符说明（`__REPLACE_ME__` 与命名占位符）

仓库里的模板**不携带任何真实主机名、口令、证书或绝对路径**，统一写成占位符。含义都一样：
**看到就替换成你机器上的真实值，别原样保留。**

| 占位符 | 含义 | 典型位置 | 替换成 |
|---|---|---|---|
| `__REPLACE_ME__` | 通用“此处必须替换”标记（历史模板/其它包的写法） | 任何配置模板 | 按上下文替换；不要保留 |
| `__SERVER_NAME__` | 对外访问的域名或 IP（nginx `server_name`，须与 DSH `--trusted-host` 一致） | `docs/nginx/*.conf` | 例：`dsh.example.com` 或 `203.0.113.10` |
| `__TLS_CERT__` / `__TLS_KEY__` | 站点证书 / 私钥的绝对路径 | `docs/nginx/*.conf` | 例：`/etc/nginx/tls/dsh.crt` / `dsh.key` |
| `__CLIENT_CA__` | Gitea mTLS 的客户端 CA 证书路径（`ssl_client_certificate`） | `docs/nginx/gitea.conf` | 例：`/etc/nginx/tls/client-ca.crt` |
| `__HTPASSWD_FILE__` | basic-auth 口令文件路径 | `docs/nginx/dsh-web.conf` | 例：`/etc/nginx/.dsh-auth`（`htpasswd -c` 生成） |
| `__SITE_ROOT__` | 静态站点根目录 | `docs/nginx/couple-fit.conf` | 你的页面目录 |
| `<user>` / `<server>` | SSH 账号 / 服务器地址 | `CLONE.md` | 例：`root` / `8.134.170.38` |
| `<CHECKOUT>` / `<WS>` / `<TSC>` | 代码树根 / 工作区根 / TypeScript 路径 | 本文件 | 你的真实路径 |
| `${credential:NAME}` / `${secret:NAME}` | **运行期**引用，不是占位符 | `profile/cordis.patch.yml`、工具调用 | 不要替换；在 `.credentials.yaml` / vault 里录值 |

注意：

- `profile/package.json` 和 `profile/cordis.patch.yml` 是**脱敏副本，但仍保留了源机 `/srv/...`
  绝对路径**（脱敏只去掉了密钥/口令，没有改路径）。第 6 节是逐条替换清单。
- `docs/nginx/README.md` 明确写了：这些 `.conf` **不是可直接 `nginx -t` 的文件**，替换完
  占位符再放进 `sites-available/`。

---

## 8. 从零复刻要手工做的几步

以下命令以 Ubuntu 22.04 / root 为例；`$R`、`$P` 先设好：

```bash
export R="$(pwd)/plugins"                 # 仓库根目录下执行
export P="$HOME/.dsh/profiles/web"        # 源机是 /root/.dsh/profiles/web
export WS="$(dirname "$(pwd)")"           # 你的工作区根；仅作示例
```

### 8.1 装系统依赖与 DSH

```bash
apt-get update
apt-get install -y nginx apache2-utils python3 curl openssl xz-utils git

# Node >= 24.9（DSH 0.2.2-rc.5 要求；示例用官方二进制；也可用 nvm / NodeSource）
cd /tmp
curl -fLO https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz
tar -xJf node-v24.22.3-linux-x64.tar.xz -C /usr/local --strip-components=1
node -v                                  # 期望 v24.x

npm i -g pnpm@11.28.13
pnpm -v

export PNPM_HOME=/usr/local/pnpm-global
export PATH="$PNPM_HOME/bin:$PATH"
pnpm add -g @deepseek-ai/dsh@0.2.2-rc.5
ln -sf "$PNPM_HOME/bin/dsh" /usr/local/bin/dsh
dsh --version                            # 期望 0.2.2-rc.5

# 可选：VPN 面板需要
apt-get install -y openfortivpn
command -v openfortivpn
```

如果 rc 版被 npm 的“最小发布时长”策略拒绝，按 `docs/W2-system-deps.md` 的说明处理；
DSH 版本必须是 `0.2.2-rc.5`，不要混用其它版本。

### 8.2 拿代码并切 tag

```bash
mkdir -p "$HOME/src" && cd "$HOME/src"
git clone https://ops1e5d1a@8.134.170.38:8444/dev/dsh-warroom.git
cd dsh-warroom
git checkout v2026.11.21
export R="$(pwd)/plugins"
```

证书 / mTLS / Windows / WSL 的细节全在 `CLONE.md`。若用 zip，解压后把目录名改回 1.2 的
六个名字，并令 `R` 指向包含它们的目录。

### 8.3 建 profile 并注册 6 个 bundle

```bash
export P="$HOME/.dsh/profiles/web"
mkdir -p "$P/node_modules" && chmod 700 "$HOME/.dsh"

# 覆盖层：只复制 3 个文件；package.json 按下面生成
cp profile/cordis.patch.yml profile/cordis.yml profile/pnpm-workspace.yaml "$P/"
chmod 600 "$P/cordis.patch.yml"

cat > "$P/package.json" <<'EOF'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
EOF

# 先全部 dry-run 看动作
for s in dsh-router-b dsh-egress dsh-vpn dsh-token-stats dsh-secrets dsh-agent-hub; do
  node "$R/$s/scripts/install.mjs" --profile "$P" --dry-run
done

# 按顺序真跑（顺序 = bundles 顺序）
node "$R/dsh-router-b/scripts/install.mjs"    --profile "$P" --disable-brand
node "$R/dsh-egress/scripts/install.mjs"      --profile "$P"
node "$R/dsh-vpn/scripts/install.mjs"         --profile "$P"
node "$R/dsh-token-stats/scripts/install.mjs" --profile "$P"
node "$R/dsh-secrets/scripts/install.mjs"     --profile "$P"
node "$R/dsh-agent-hub/scripts/install.mjs"   --profile "$P"
```

校验（期望 18 条依赖、8 个 bundles、18 条软链）：

```bash
node -e "const p=require('$P/package.json'); console.log(Object.keys(p.dependencies).length); console.log(p.dsh.profile.bundles.join(','))"
ls -la "$P/node_modules" | grep -c -- '->'
grep -n -A2 'ui-brand-official' "$P/cordis.patch.yml"   # 期望 disabled: true
```

- **不要**复制仓库里的 `profile/package.json`（其中是源机绝对路径）。
- **不要**在 `$P` 或仓根跑 `pnpm install`。
- agent-hub 的 hub 地址、控制方 id、令牌写在 `<DSH home>/agent-hub/controller.env`（见根目录 `README.md` 3.4）；
  **任何 `DSH_` 开头的变量都不能写进 `<DSH home>/.env`**，否则 DSH 拒绝启动。
- `--disable-brand` 必须加：否则官方品牌占着 `sidebar.brand.mark` 单座，router 的 client
  注册会报 `single slot ... already has a registration`。

### 8.4 生成 dsh-secrets 的口令 / vault（必须新生成）

> 2026-11-22 起推荐把口令写在 `<DSH home>/secrets.env`（chmod 600，对应 `profile/cordis.patch.yml` 里
> `host-secrets.envFile: /root/.dsh/secrets.env`），改完不用重启；下面的 systemd EnvironmentFile 写法仍然可用。

```bash
# 1) 生成新口令，写入 600 的 EnvironmentFile（不打印到终端）
install -m 600 /dev/null /etc/dsh-secrets.env
PASS=$(openssl rand -base64 32)
printf 'DSH_SECRETS_PASSPHRASE=%s\n' "$PASS" >> /etc/dsh-secrets.env
unset PASS
chmod 600 /etc/dsh-secrets.env
ls -l /etc/dsh-secrets.env

# 2) 让 systemd 进程能读到它：等 8.7 建好 dsh-web.service 后，
#    再写它的 drop-in（内容在 8.7），或先手建同路径文件：
#    /etc/systemd/system/dsh-web.service.d/10-secrets.conf
#    [Service]
#    EnvironmentFile=/etc/dsh-secrets.env

systemctl daemon-reload
# 3) 首次 secret_set 时才会创建 ~/.dsh/secrets.vault（0600）；重启见 8.7
```

- 口令至少 20 个随机字符；用密码管理器保存。**丢了就打不开 vault**。
- `secrets.vault` / `secrets.key` / `/etc/dsh-secrets.env` **绝不入仓、绝不从旧机复制**。
- 需要搬旧数据：旧机 `secret_export`（另设导出专用口令）→ 新机 `secret_import`，见 3.5。
- 想用 keyfile：`head -c 32 /dev/urandom > "$HOME/.dsh/secrets.key" && chmod 600 ...`，
  并在 `cordis.patch.yml` 把 `keySource` 改成 `keyfile`。

### 8.5 证书 / 口令：哪些必须人工提供

| 必须人工提供的东西 | 从哪来 | 能否从仓库或旧机复制 |
|---|---|---|
| Gitea 登录口令（用户名 `ops1e5d1a`） | 服务器 `/root/.gitea-admin.cred`，管理员**线下**给 | 否 |
| `client.p12` + p12 口令 + `gitea.crt` | 管理员线下给；源目录 `/srv/workspace/.dsh-artifacts/gitea-mtls/` | 否（凭据） |
| Gitea mTLS 的客户端 CA 私钥 | 只在服务器 `/etc/nginx/tls/` | **绝不**分发 |
| 8443 的 TLS 证书/私钥 | 自签或 ACME | 可重新生成 |
| `DSH_SECRETS_PASSPHRASE` | 自己生成（8.4） | 否，必须新设 |
| LLM API key（`DEEPSEEK_API_KEY`、`KIRO_API_KEY` 等） | 使用者自己申请 | 否 |
| `EXA_API_KEY` | 使用者自己申请（可选） | 否 |
| openfortivpn 的 VPN 账号/口令 | 使用者自己 | 否 |
| nginx basic-auth 口令文件 | `htpasswd -c /etc/nginx/.dsh-auth <用户名>` 现场生成 | 否 |

8443 自签示例（换掉 `__SERVER_NAME__` / IP）：

```bash
mkdir -p /etc/nginx/tls && chmod 700 /etc/nginx/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 \
  -keyout /etc/nginx/tls/dsh.key -out /etc/nginx/tls/dsh.crt \
  -subj "/CN=<你的域名或IP>" \
  -addext "subjectAltName=IP:<你的公网IP>,DNS:<你的域名>"   # 只保留实际用得到的项
chmod 600 /etc/nginx/tls/dsh.key
openssl x509 -in /etc/nginx/tls/dsh.crt -noout -subject -dates -ext subjectAltName
```

> 8444 的 Gitea 证书：当前包里 `gitea.crt` 的 SAN 只有旧 IP `8.163.126.253` 和 `127.0.0.1`，
> **不含 `8.134.170.38`**。要么管理员重签把新 IP 加进 SAN，要么客户端临时 `-c http.sslVerify=false`
> 单次 clone。详见 `CLONE.md` 2.5。

### 8.6 nginx（8443 DSH Web / 8444 Gitea / 可选 8445 / 8450）

```bash
# 以 8443 为例；模板里的占位符全部替换后再落盘
cp docs/nginx/dsh-web.conf /etc/nginx/sites-available/dsh-web
$EDITOR /etc/nginx/sites-available/dsh-web     # 改 __SERVER_NAME__ / __TLS_* / __HTPASSWD_FILE__
ln -sfn /etc/nginx/sites-available/dsh-web /etc/nginx/sites-enabled/dsh-web

# Gitea 8444（mTLS）：证书/客户端 CA 由管理员提供
cp docs/nginx/gitea.conf /etc/nginx/sites-available/gitea
$EDITOR /etc/nginx/sites-available/gitea       # 改 __SERVER_NAME__ / __TLS_* / __CLIENT_CA__
ln -sfn /etc/nginx/sites-available/gitea /etc/nginx/sites-enabled/gitea

# basic auth 文件（DSH 入口）
htpasswd -c /etc/nginx/.dsh-auth <用户名>
chmod 600 /etc/nginx/.dsh-auth

nginx -t && systemctl reload nginx
```

阿里云安全组按实际站点放行：**8443**（DSH Web）、**8444**（Gitea）、可选 8445 / 8450。
8444 的 nginx 必须是 `ssl_verify_client on`；否则 mTLS 不成立。

### 8.7 systemd

```bash
# dsh-web.service：用第 5 节的模板，改 --trusted-host、User、日志、dsh 路径
$EDITOR /etc/systemd/system/dsh-web.service

# secrets 的 EnvironmentFile（8.4 已生成）
mkdir -p /etc/systemd/system/dsh-web.service.d
cat > /etc/systemd/system/dsh-web.service.d/10-secrets.conf <<'EOF'
[Service]
EnvironmentFile=/etc/dsh-secrets.env
EOF
chmod 600 /etc/dsh-secrets.env

# 稳定入口 gate（可选；不用就删掉，nginx 直接反代 42443）
# 可直接跑 deploy/E0-install-gate.sh，或按 dsh-web-gate.mjs 自己写 unit
systemctl daemon-reload
systemctl enable --now dsh-web.service
systemctl is-active dsh-web.service nginx
```

若启用了 gate：`systemctl enable --now dsh-web-gate.service`，并把 nginx 的
`proxy_pass` 指向 `127.0.0.1:42444`。

### 8.8 启动后验证

```bash
# 1) 8 个 bundle 都合成进来（6 个自研应各占一段）
dsh --profile web --dump-config | grep -n '^# == dsh-'
# 期望看到 dsh-router-b / dsh-egress / dsh-vpn / dsh-token-stats / dsh-secrets / dsh-agent-hub

# 2) 服务与端口
systemctl is-active dsh-web.service nginx
ss -ltnp | grep -E ':(8443|42443|42444) '

# 3) 入口链（按是否启用 gate 调整）
curl -k -s -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8443/   # 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:42444/     # 302（有 gate）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:42443/     # 401

# 4) secrets 是否加载
grep 'dsh-secrets:' /var/log/dsh-web.log | tail -1
# 期望：dsh-secrets: vault <DSH_HOME>/secrets.vault (keySource passphrase-env), 10 tools registered

# 5) 插件 API（token 从日志取）
T=$(grep -o 'token=[A-Za-z0-9_-]*' /var/log/dsh-web.log | tail -1 | cut -d= -f2)
J=$(mktemp)
curl -s -o /dev/null -c "$J" -b "$J" -L "http://127.0.0.1:42443/?token=$T"
for u in /api/router/board /api/router/tiers /api/token-stats/summary; do
  printf '%s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' -b "$J" "http://127.0.0.1:42443$u"
done
rm -f "$J"

# 6) 日志无致命错误
tail -n 100 /var/log/dsh-web.log | grep -iE 'error|cannot|single slot' || echo 'no errors'
```

GUI 里应能看到：Router、Egress、VPN、Token、密钥看板，以及任务板上的「Agent」页签（插件管理器里 6 个 bundle
共 12 个子插件都 enabled：6 个插件各 host + client）。浏览器入口是 `https://<你的域名或IP>:8443/`。

### 8.9 收尾

```bash
# 确认没有把密钥带进仓库
cd "$(git rev-parse --show-toplevel)"
git status --short                      # 期望为空（或只有你自己的配置改动）
git ls-files | grep -E '\.(pem|key|p12|pfx|jks)$' \
  && echo '发现凭据文件，停止发布' || echo 'clean: 无证书/私钥文件入库'

# 权限
chmod 600 /etc/dsh-secrets.env /etc/nginx/tls/*.key
chmod 700 ~/.dsh
```

---

## 9. 不含什么 / 安全边界

- **不含任何密钥 / 口令 / token / 证书 / 私钥**：仓库里的凭据一律是占位符或“由管理员线下提供”
  的说明；`.env*`、`*.token`、`*.pem`、`*.key`、`credentials*`（源码 `credentials.ts` 除外）
  都在 `.gitignore` 里。
- **不含 `secrets.vault` / `secrets.key` / `/etc/dsh-secrets.env`**：这三样是本地生成物。
- **不含 `node_modules/`**：profile 的 18 条软链由 `install.mjs` 重建；client 构建依赖用
  `npm ci` 重装。
- **不含 `~/.dsh` 运行态**：`sessions/`、`board.json`、`tiers.json`、egress / vpn 凭据都不在仓库。
- **不含 DSH 安装包本体**，也不含 `node_modules/`、`lib.next/`、`lib.prev/`、`*.bak-*`、`.dsh-artifacts/`。
- **包含（且只包含）这些第三方/工具件**：`vendor/exa-mcp-server/`（19 文件、MIT、3.5.1，含
  `LICENSE` 与 `dist/stdio.cjs`）和 `scripts/browser`、`scripts/browser.py`（本机浏览器工具）。
  它们不含 `node_modules`，也不含 `/srv/browser` 的 lane/profile 运行态。
- **不含真实 IP/域名证书**：`docs/nginx/*.conf` 是脱敏模板；`deploy/nginx-dsh-web.conf` 里的
  `8.134.170.38` 只是源机值，换机要改。

---

## 10. 发布前自检（维护者用）

```bash
cd "$(git rev-parse --show-toplevel)"

# 1) 关键文件都在
test -f plugins/dsh-secrets/packages/host-secrets/vault.js && echo vault-OK
test -f plugins/dsh-router-b/packages/host-router/lib/index.js && echo host-router-OK
test -f plugins/dsh-router-b/packages/client-ui-router/lib/client.js && echo router-client-OK
test -f docs/nginx/gitea.conf && echo nginx-OK
test -f docs/MANIFEST.md && echo docs-manifest-OK
test -f vendor/exa-mcp-server/dist/stdio.cjs && echo exa-vendor-OK
test -x scripts/browser && echo browser-OK

# 2) 文件数（v2026.11.21 为 398；2026-11-23 工作树为 552，以要发布的 tag 实际为准）
git ls-files | wc -l
git rev-parse v2026.11.21^{commit}       # 与 HEAD 相同

# 3) 没有把凭据文件误入库（只查文件名，避免把检查模式本身写进文档造成自匹配）
git ls-files | grep -E '(^|/)(secrets\.(vault|key)|client\.p12|client-p12-password\.txt|\.credentials\.yaml|\.env)$' \
  && echo 'FOUND: 请删除' || echo 'clean: 无凭据文件入库'
git ls-files | grep -E '\.(pem|key|p12|pfx|jks)$' \
  && echo 'FOUND: 请删除' || echo 'clean: 无证书/私钥文件入库'
```

---

## 11. 最短路径（给赶时间的人）

```bash
# 1) clone + 切 tag（证书见 CLONE.md）
git clone https://ops1e5d1a@8.134.170.38:8444/dev/dsh-warroom.git && cd dsh-warroom
git checkout v2026.11.21
export R="$(pwd)/plugins" P="$HOME/.dsh/profiles/web"

# 2) profile 三件套 + 空 package.json（8.3 的 heredoc）
# 3) 按顺序 install
for s in dsh-router-b dsh-egress dsh-vpn dsh-token-stats dsh-secrets dsh-agent-hub; do
  node "$R/$s/scripts/install.mjs" --profile "$P"
done
# 4) 生成 passphrase / 证书 / nginx / systemd（8.4–8.7）
# 5) 重启 + 8.8 验证
```

`vendor/exa-mcp-server/` 已随仓库提供，**不需要**再 `npm install`；只有在你要更新它时才按 2.3 重建。

装不起来时优先看：`docs/README-MIGRATE.md`（最全）、`docs/W6-MIGRATION-MANUAL.md`（合成手册）、
`plugins/dsh-secrets/docs/USAGE.md`（保险库）、本文件第 6 节的路径映射。

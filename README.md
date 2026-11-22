# dsh-warroom · DSH 作战室定制

一套跑在 DeepSeek Harness（DSH）上的「作战室」定制：
三栏 Web GUI 里的分区路由 / 任务面板、Token 用量统计、出口代理面板、VPN 面板、加密凭据保险库，
以及把它们装进 DSH `web` profile 的配置和迁移文档。

基线：DSH `0.2.2-rc.5`、Node >= 24.9（DSH 0.2.2-rc.5 本身的要求）、profile `web`。仓库规模 396 个文件、约 8.2 MB（不含 `.git`）。

---

## 1. 这是什么

五个 DSH 插件 + 一份 profile 覆盖层，装好后在 DSH Web GUI / 工具层多出五块能力：

| 面板 | 你能看到什么 |
|---|---|
| **Router（作战室）** | 把任务按文件分区路由给 worker；三栏界面里看任务板、分区负载和 worker 进度 |
| **Token 统计** | 侧栏显示当天总用量与按模型拆分，可展开 7 / 30 天每日用量 |
| **Egress** | 给每个模型端点选择出口（http / https / socks5 / direct），fail-closed，避免直连泄露 |
| **VPN** | 管理 openfortivpn 配置、连接 / 断开、看门狗与本机探活，读连接日志 |
| **Secrets** | 本地加密保险库：agent 能存能用（env 注入 / HTTP 占位符），但读不回明文 |

## 2. 和官方 DSH 的关系

**这是 profile 层与插件层的定制，不是 DSH 的 fork，也不含 DSH 源码。** DSH 安装包本体一行不改：

- 插件通过 `~/.dsh/profiles/web/package.json` 挂载：`dsh.profile.bundles` 决定加载顺序，
  `dependencies` 里的 `link:` 指向插件目录（14 条：5 个 bundle × 自身 + host + client，secrets 无 client 包）。
  仓库里这份文件写的是源机的 `/srv/...` 绝对路径，目标机由 `install.mjs` 重写成自己的 checkout 路径。
- 行为微调写在 `~/.dsh/profiles/web/cordis.patch.yml`（补丁层，在官方 bundle 之后应用），
  包括品牌替换、模型 provider、分区根、Exa MCP 等。
- 因此 DSH 升级与插件解耦：升级 DSH 后按需重跑各插件的 `scripts/install.mjs`、重建 client bundle 即可；
  反过来，本仓库也可以脱离这台机器，按 `docs/README-MIGRATE.md` 装到别的 DSH 上。

## 3. 目录结构

```
dsh-warroom/
├── plugins/
│   ├── dsh-router-b/      分区路由：host-router（路由/任务板 host）+ client-ui-router（作战室三栏界面）、scripts/install.mjs、build.mjs、safe-build-host.sh、safe-restart.sh
│   ├── dsh-token-stats/   Token 用量：host-token-stats 只读聚合 $DSH_HOME/sessions，client-ui-token-stats 侧栏面板
│   ├── dsh-egress/        出口代理：host-egress 管理端点出口，client-ui-egress 出口面板
│   ├── dsh-vpn/           VPN：host-vpn 管 openfortivpn 与看门狗，client-ui-vpn VPN 页面
│   └── dsh-secrets/       加密凭据保险库：host-secrets + DESIGN.md / docs/USAGE.md / scripts；不含任何生成的 vault、密钥或口令文件
├── profile/               web profile 覆盖层：package.json、cordis.patch.yml（脱敏副本）、cordis.yml、pnpm-workspace.yaml
├── docs/                  迁移与审计文档（W1–W6、README-MIGRATE.md、CLONE-ON-WORKSTATION.md）
│   └── nginx/             四个 nginx 站点脱敏模板：dsh-web / browser-novnc / gitea / couple-fit
├── README.md              本文件
├── scripts/               浏览器 lane 运维工具：browser（入口）、browser.py（CDP/Playwright + Xvfb/x11vnc/noVNC）
├── vendor/
│   └── exa-mcp-server/    第三方 exa-mcp-server@3.5.1 tarball 解包（MIT，含 LICENSE），离线跑 Exa stdio MCP
└── .gitignore             排除 node_modules、构建中间态、密钥、证书、vault、产物
```

五个插件的一句话职责：

- **dsh-router-b**：把工作按文件分区路由给 worker，并在 Web GUI 里提供任务板 / 分区视图。
- **dsh-token-stats**：只读 `~/.dsh/sessions`，在侧栏汇总 Token 用量并按模型拆分。
- **dsh-egress**：为每个模型端点选择出口代理，配置错误时 fail-closed。
- **dsh-vpn**：管理 openfortivpn 连接、分流路由与看门狗，并提供 VPN 管理页。
- **dsh-secrets**：本地加密保险库，给 agent 提供只写不读的凭据存取（`secrets_*` 工具）；vault 文件与口令都在
  `$DSH_HOME` 下运行时生成，**不入库**。

每个插件下 `packages/` 是 host / client 两个子包，`lib/` 是 profile 直接加载的运行产物（**随仓库入库**，
不要手动改；host 侧改动请用 `plugins/dsh-router-b/scripts/safe-build-host.sh` 生成 `lib.next/`，
再由人工执行 `safe-restart.sh` 换入）。

## 4. 怎么装（最短路径）

先决条件：

- Node >= 24.9（DSH 0.2.2-rc.5 要求；插件自己的 `engines.node` 写的是 >= 22）与 pnpm（装依赖 / 构建用），构建时另需 TypeScript；
- 目标机已装好 DSH（基线 `0.2.2-rc.5`），`dsh` 在 PATH 里；
- `~/.dsh/profiles/web/` 可写（源机以 root 运行，`DSH_HOME=/root/.dsh`）；
- 若要 VPN 面板：装 `openfortivpn`；要 Exa stdio MCP：仓库已带 `vendor/exa-mcp-server`（见第 7 节），改一下路径即可；
- dsh-secrets 无额外系统依赖，首次使用会在 `$DSH_HOME` 下生成 vault 与口令。

安装顺序（细节、参数、预期输出全在 `docs/README-MIGRATE.md`）：

1. `### 2.5 install.mjs：调用顺序与参数` —— 按 **router → egress → vpn → token-stats → secrets** 的顺序注册 bundle；
2. `### 2.6 profile 注册与 14 条软链校验` —— 放覆盖层、生成 `package.json`、校验 14 条软链；
3. `### 2.7 5 段 --dump-config 验证` —— `dsh --profile web --dump-config` 应出现 5 段；
4. `### 2.8 启动与自检` —— 起服务，核对入口链与各插件 API。

> `plugins/**` 与 `profile/**` 里的绝对路径是源机路径，换机要按手册第 3 节（P0 清单）逐条改。

## 5. 从本机 clone 怎么开始

仓库托管在本机 Gitea（私有仓 `dev/dsh-warroom`，地址 `https://8.134.170.38:8444/dev/dsh-warroom.git`）。
证书是自签的，git 默认会拒绝，需要跳过一次校验或先导入 CA；认证用 Gitea 用户名 + token。

```bash
# 二选一：一次性跳过校验（仅本次）
GIT_SSL_NO_VERIFY=true git clone https://8.134.170.38:8444/dev/dsh-warroom.git

# 或导入自签证书后正常 clone（推荐，见 CLONE 文档第 2 节）
git clone https://8.134.170.38:8444/dev/dsh-warroom.git
```

完整清单（前提、证书、凭据、更新、故障排查）见 **[docs/CLONE-ON-WORKSTATION.md](docs/CLONE-ON-WORKSTATION.md)**。

## 6. 不含什么 / 安全边界

- **不含任何密钥 / token / 明文口令**：文档里的凭据一律是占位符（`<你的Gitea用户名>`、`<<替换>>` 等），
  首次部署要自己填；`.env*`、`*.token`、`*.pem`、`*.key`、`credentials*`（源码 `credentials.ts` 除外）都在 `.gitignore` 里。
- **不含 `node_modules/`**：profile 的 14 条软链由 `install.mjs` 重建，client 依赖用 `npm ci` 重装。
- **不含 secrets 的运行态**：vault 文件、vault key、passphrase、`*.p12` / `*.pem` / `*.key` 一律在 `.gitignore` 里，
  仓库只带 `dsh-secrets` 的源码与文档。
- **不含 `~/.dsh` 运行态**：会话 `sessions/`、`board.json`、`tiers.json`、插件管理器日志、VPN / Egress 凭据都不在仓库里。
  新机首次启动会自动生成空任务板；Token 面板在无会话时显示空态，不报错。
- **不含 DSH 安装包本体**，也不含构建中间态（`lib.prev/`、`lib.next/`、`*.bak-*`）与 `.dsh-artifacts/`。
  `vendor/exa-mcp-server` 是 MIT 许可的第三方 npm 包解包，为离线运行 Exa stdio MCP 随仓库带入（见 `docs/MANIFEST.md`）。

## 7. 已知限制

1. **`vendor/exa-mcp-server` 已纳入仓库**（`exa-mcp-server@3.5.1`，MIT，19 文件 / 约 1.9 MB，含 `LICENSE`）。
   它只是 tarball 解包，不含 `node_modules`；`dist/stdio.cjs` 是上游预打包产物。用之前把
   `profile/cordis.patch.yml` 里 `exa-stdio.args` 的绝对路径改成本仓库的 `vendor/exa-mcp-server/dist/stdio.cjs`。
2. **profile 与 patch 里有源机绝对路径**：`profile/package.json` 的 `link:`、`cordis.patch.yml` 的分区根与 MCP 路径。
   不要直接沿用，按 `docs/README-MIGRATE.md` 2.5 / 2.6 重跑 `install.mjs` 并改分区根。
3. **自签证书 + 非标准端口**：Gitea 在 `8444`（nginx → 127.0.0.1:3000），`8444` 还强制 **mTLS**（客户端证书）。
   证书是迁移前地址签发的，SAN 只有那个旧 IP 与 `127.0.0.1`，**不含 `8.134.170.38`**，有效期至 2036-11-17；
   所以 clone 必须 `GIT_SSL_NO_VERIFY` / `-c http.sslVerify=false`，或换成带新地址 SAN 的证书后再导入 CA。
   同时阿里云安全组要放行 TCP `8444`。详见 `docs/nginx/README.md`。
4. **插件 host 侧构建依赖本机工具链**：`safe-build-host.sh` 里的 `tsc` 路径、host-router 的 `typeRoots` 指向源机 pnpm store，
   换机需按手册 P0-3 / P0-4 修改；运行已入库的 `lib/` 不受影响。
5. **host-router 的 `src/` 比 `lib/` 新**：源机 2026-11-20 18:35 改过 `bridge.ts` / `index.ts` / `snapshot.ts`，
   对应的新构建在 `lib.next/`（按约定不入库，源机也还没换入）。仓库里的 `lib/` 是 12:16 的上一次已验证构建，
   **换机或继续开发前必须重跑 `scripts/safe-build-host.sh` 生成 `lib.next/`，再由人工 `safe-restart.sh` 换入**。
6. **`profile/cordis.patch.yml` 是脱敏副本**：源文件本来就没有字面 API key；唯一出现过的凭据占位值已换成
   `__REPLACE_ME__`。provider 的 key 请在新机凭据库 / `.env` 里重新录入。

## 相关文档

- [docs/README-MIGRATE.md](docs/README-MIGRATE.md) —— 迁移安装说明（先读这个）
- [docs/CLONE-ON-WORKSTATION.md](docs/CLONE-ON-WORKSTATION.md) —— 在自家电脑上 clone / 更新
- [docs/MANIFEST.md](docs/MANIFEST.md) —— 依赖/来源对照、入口与构建方式、硬编码路径映射、排除清单
- [docs/nginx/README.md](docs/nginx/README.md) —— 四个 nginx 站点脱敏模板与 mTLS/证书注意事项
- `docs/W1-runtime-config.md` … `docs/W6-MIGRATION-MANUAL.md` —— 运行时、系统依赖、插件机制、仓库内容、数据源与硬编码路径、合成手册

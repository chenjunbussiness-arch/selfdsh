# W3 环境依赖与插件加载机制（移植手册章节）

采集时间：2026-11-20 15:17 (Asia/Shanghai)，主机即当前「作战室」机器。全部为只读命令。

## 1. PATH 与命令解析

```
$ echo $PATH | tr ':' '\n'
1 /usr/local/pnpm-global/bin
2 /usr/local/go/bin
3 /usr/local/bin
4 /usr/bin
5 /bin
```
**PATH 不含 /srv/workspace/bin。** systemd 单元 `/etc/systemd/system/dsh-web.service` 里写死的 `Environment=PATH=` 与此完全一致，同样不含它。

### gate：同名两个不同脚本
```
$ type -a gate
gate is /usr/local/bin/gate
-rwxr-xr-x 1 root root 10221 Nov 20 13:42 /srv/workspace/bin/gate
-rwxr-xr-x 1 root root 12976 Nov 19 23:08 /usr/local/bin/gate
```
两者都是普通 bash 脚本，不是符号链接（readlink -f 返回自身）。
- `/usr/local/bin/gate`（PATH 实际命中）：头注释「gate — 受控的代码流转命令（本地 ↔ 云服务器 ↔ 内网 gitea）」，子命令 status/diff/add/commit/push [cloud|gitee]/pull/sync/log/doctor/guard。
- `/srv/workspace/bin/gate`（不在 PATH，需写全路径）：头注释「gate（云端版）—— 阿里云 ECS 中转机上的裸仓库管理工具」，管理 `/srv/git/<name>.git`，子命令 doctor/list/create/status/check/pull/push-gitea。

`/srv/workspace/bin/` 下另有 `gitea-sync.sh`、`screenshot`；`/usr/local/bin/screenshot -> /srv/workspace/bin/screenshot` 是唯一从 PATH 指过去的链接。

### node / pnpm / npm / corepack
```
$ which -a node pnpm npm dsh corepack
/usr/local/bin/node
/usr/local/bin/pnpm
/usr/local/bin/npm
/usr/local/pnpm-global/bin/dsh
/usr/local/bin/dsh
/usr/local/bin/corepack
$ node -v ; pnpm -v ; npm -v ; corepack --version
v24.22.3
11.28.13
11.19.1
0.36.0
$ readlink -f $(which node)   -> /usr/local/bin/node   (真实二进制)
$ readlink -f $(which pnpm)   -> /usr/local/lib/node_modules/pnpm/bin/pnpm.mjs
```
- node：官方二进制 tarball 解到 `/usr/local`（npm/corepack/npx 都是 `../lib/node_modules/...` 相对链接），不是 nvm/volta/fnm，也不是发行版包。
- pnpm：用 npm 全局装在 `/usr/local/lib/node_modules/pnpm`（同时提供 pn/pnpx/pnx）。没走 corepack。
- `packageManager` 字段：在 dsh-router-b、dsh-token-stats、dsh-egress、dsh-vpn 和 profile 的 package.json 里都没有（grep 无结果）。
- 环境变量：`PNPM_HOME=/usr/local/pnpm-global`；DSH 进程内另有 `DSH_INSTALL_DIR`、`NODE_PATH`（由 dsh 运行时注入，不需手设）。

## 2. DSH 本体安装方式

```
$ npm ls -g --depth=0
npm error Class extends value undefined is not a constructor or null      # npm 全局列表本身报错，未深究
$ pnpm ls -g --depth 0
/usr/local/pnpm-global/global/v11 (PRIVATE)
└── @deepseek-ai/dsh@0.2.2-rc.5
$ pnpm root -g      -> /usr/local/pnpm-global/global/v11
$ pnpm store path   -> /usr/local/pnpm-global/store/v11
```
即 **`pnpm add -g @deepseek-ai/dsh@0.2.2-rc.5`** 安装（pnpm 11 的「隔离全局包」布局），不是 link。

链接链：
```
/usr/local/bin/dsh -> /usr/local/pnpm-global/bin/dsh            (shim, 5164 B)
shim exec: node .../global/v11/49f97750.../node_modules/@deepseek-ai/dsh/lib/bin.js
/usr/local/pnpm-global/global/v11/49f9775095df...8439 -> de53-1a1ef707e95-e44c623e54241b85
.../de53-1a1ef707e95-e44c623e54241b85/package.json = {"dependencies":{"@deepseek-ai/dsh":"0.2.2-rc.5"}}
.../de53-.../node_modules/@deepseek-ai/dsh -> ../../../../../store/v11/links/@deepseek-ai/dsh/0.2.2-rc.5/fd28c786.../node_modules/@deepseek-ai/dsh
```
**DSH 安装根**：`/usr/local/pnpm-global/store/v11/links/@deepseek-ai/dsh/0.2.2-rc.5/fd28c78643194a27b8a3f82fdd1fba4bac6653382abc30c106fd75466776ab8a/node_modules/@deepseek-ai/dsh`
- package.json：`name @deepseek-ai/dsh`，`version 0.2.2-rc.5`，`bin {dsh: lib/bin.js}`，`scripts {}`；依赖全部钉 `0.2.2-rc.5`（`@deepseek-ai/cordis ~4.1.0`、`dsh-app-boot`、`dsh-base` …）。
- 目录含 `lib/`（构建产物）与 `src/*.ts`（随包发布的源码），无 gitHead、无 scripts，**未见本地 dev 构建痕迹**；它是 registry 发布的 rc 版本。
- `/usr/local/pnpm-global/global/v11/pnpm-workspace.yaml` 里的 `minimumReleaseAgeExclude` 列出全部 `@deepseek-ai/*@0.2.2-rc.5`，说明安装时绕过了 pnpm 的「最小发布时长」限制。新机安装 rc 版也可能需要同样的设置（未实测）。
- 系统提示中的 `dsh-harness-dev-context/0.2.2-rc.5/...` 只是 store 里的一个依赖包，不是 DSH 根。
- **安装后的手工修补**：`/usr/local/bin/dsh-fix-zod`（systemd `ExecStartPre`）在 `@deepseek-ai/dsh-web` 的 store 目录 node_modules 里补一个 `zod` 符号链接（注释：“Re-link zod into dsh-web's resolution chain after a pnpm reinstall”）。这一步在包管理之外，换机必须一起带走。

## 3. 插件注册机制（重点）

### 候选机制逐项排除
| 候选 | 实测 | 结论 |
|---|---|---|
| (a) `/root/.dsh/plugins/` | `ls: cannot access '/root/.dsh/plugins': No such file or directory` | 不存在，排除 |
| (b) DSH 安装目录 node_modules 链到 dsh-router-b | DSH 根的 `node_modules/@deepseek-ai/` 只有指向 store 的相对链接；DSH 全局 package.json 只依赖 `@deepseek-ai/dsh` | 排除 |
| (c) profile 的 cordis.patch.yml | `/root/.dsh/profiles/web/cordis.patch.yml` 中没有 host-router/client-ui-router 的 insert；只有 `ui-brand-official disabled: true`（第 40-42 行，install.mjs `--disable-brand` 写的）和其他配置。`/root/.dsh/cordis.patch.yml`（home 级）不存在 | 不负责注册，只负责去掉官方品牌 |
| (d) bundle 包 | **是**：`dsh-router-b`、`dsh-token-stats` 本身就是 bundle（package.json 有 `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`） | 机制之一 |
| (e) link:/file: | **是**：profile package.json 用 `link:`，node_modules 里是目录符号链接 | 机制之一 |
| pnpm 全局 link | `pnpm ls -g` 只有 @deepseek-ai/dsh | 排除 |

### 确切机制（实际生效的三件事，缺一不可）
**① profile `package.json` 登记依赖 + bundles 列表**：`/root/.dsh/profiles/web/package.json`
```
 5    "dsh-router-b": "link:/srv/dsh-router-b",
 6    "dsh-host-router": "link:/srv/dsh-router-b/packages/host-router",
 7    "dsh-client-ui-router": "link:/srv/dsh-router-b/packages/client-ui-router",
14    "dsh-token-stats": "link:/srv/workspace/deepseek-harness/dsh-token-stats",
15    "dsh-host-token-stats": "link:/srv/workspace/deepseek-harness/dsh-token-stats/packages/host-token-stats",
16    "dsh-client-ui-token-stats": "link:/srv/workspace/deepseek-harness/dsh-token-stats/packages/client-ui-token-stats"
20      "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
23        "dsh-router-b", "dsh-egress", "dsh-vpn", "dsh-token-stats" ]
```
（同文件还有 dsh-egress / dsh-vpn 共 6 条 link，属于其它插件仓。）

**② profile `node_modules` 里的目录符号链接**（`ls -la /root/.dsh/profiles/web/node_modules`）：
```
dsh-router-b              -> /srv/dsh-router-b
dsh-host-router           -> /srv/dsh-router-b/packages/host-router
dsh-client-ui-router      -> /srv/dsh-router-b/packages/client-ui-router
dsh-token-stats           -> /srv/workspace/deepseek-harness/dsh-token-stats
dsh-host-token-stats      -> /srv/workspace/deepseek-harness/dsh-token-stats/packages/host-token-stats
dsh-client-ui-token-stats -> /srv/workspace/deepseek-harness/dsh-token-stats/packages/client-ui-token-stats
```
**③ 中间跳板链接 `/srv/dsh-router-b`**（profile 不直接指向工作区）：
```
/srv/dsh-router-b -> /srv/workspace/deepseek-harness/dsh-router-b   (Nov 19 17:33)
/srv/dsh-egress   -> /srv/workspace/deepseek-harness/dsh-egress
/srv/dsh-vpn      -> /srv/workspace/deepseek-harness/dsh-vpn
```
dsh-token-stats 没有跳板，直接指向 `/srv/workspace/deepseek-harness/dsh-token-stats`。

**④ bundle 自带的 patch 把行挂进树**：`/srv/workspace/deepseek-harness/dsh-router-b/cordis.patch.yml`
- 第 29-31 行 `- insert: - id: host-router  name: dsh-host-router  config: {manager: true, maxWorkers: 0, partitions: [...]}`
- 第 105-106 行 `- id: client-ui-router  name: dsh-client-ui-router`
- `/srv/workspace/deepseek-harness/dsh-token-stats/cordis.patch.yml` 第 19-20 行 `host-token-stats / dsh-host-token-stats`，第 24-25 行 `client-ui-token-stats / dsh-client-ui-token-stats`。

注意：partitions 配置（分区 root 都是 `/srv/workspace/...` 的绝对路径）写在插件仓的 bundle patch 里，路径不同的新机器必须改这一份。

一句话：**DSH 读取 `/root/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 拿到 bundle 名（`dsh-router-b`、`dsh-token-stats`），通过 profile 的 `node_modules/<名>` 符号链接（经 `/srv/dsh-router-b` 跳板）找到插件仓，读插件仓 `cordis.patch.yml` 的 insert 行，再按包名 `dsh-host-router`/`dsh-client-ui-router` 从同一个 profile node_modules 解析到 `packages/*/package.json` 的 `main`/`exports`。**

### 加载器源码位置
- `@deepseek-ai/dsh-app-boot/src/profile.ts`（store 路径 `/usr/local/pnpm-global/store/v11/links/@deepseek-ai/dsh-app-boot/0.2.2-rc.5/1eebd989.../node_modules/@deepseek-ai/dsh-app-boot/src/profile.ts`）
  - `:629-637` `packageDirFromAnchor`：对 anchor 调用 `createRequire(anchor).resolve.paths(name)`，返回第一个存在 `<path>/<name>/package.json` 的目录（标准 Node node_modules 向上查找）。
  - `:651-662` `resolveBundleDir`：先用 DSH 安装 anchor 找，再用 `<profileDir>/package.json` 找；都找不到就抛错 “cannot resolve profile bundle … run 'dsh plugin --profile web install'”。
  - `:689-695` 遍历 `dsh.profile.bundles`，读每个 bundle 的 `dsh.bundle`，没有就抛 “declares no dsh.bundle”。
- `@deepseek-ai/dsh-app-boot/src/profile-resolution/resolver.ts:214-230` `computeProfileLayer`：插件行的包名解析层是 profile 目录及 `<profileParent>/node_modules`。
- `@deepseek-ai/dsh/src/profile-boot.ts:212-238` `composeProfile`：层顺序为 bundle 层（按 bundles 顺序）→ profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` → telemetry。
- 兼容性预检 `dsh-app-boot/src/plugin-compatibility.ts:55-74`（插件仓 patch 注释引用）：只检查 `@deepseek-ai/dsh*` 的 peer，不满足就静默停用该行。本仓插件不声明这类 peer。
- 不存在“扫描 plugins 目录”的机制，只有基于 bundles 列表加 Node 模块解析的方式。

### 谁写下这些链接
`/srv/workspace/deepseek-harness/dsh-router-b/scripts/install.mjs`（`npm run install:profile`）：头注释写明 1) profile package.json 写 `link:` 依赖，2) 把 bundle 加入 `dsh.profile.bundles`，3) 用 `symlinkSync(target, linkPath, 'dir')` 建 node_modules 链接，4) `--disable-brand` 往 profile patch 写 `ui-brand-official disabled: true`。脚本**故意不跑 pnpm install**。`link:` 的路径取自脚本自身位置（`BUNDLE`）；当前写的是 `/srv/dsh-router-b`，说明当时是从 `/srv/dsh-router-b` 跳板路径运行的。dsh-token-stats 有同名 `scripts/install.mjs`。
备份 `package.json.bak-install-*`（5 份，Nov 19 11:47 至 Nov 20 00:02）记录了逐次安装。
`/root/.dsh/profiles/web/pnpm-lock.yaml`（Nov 19 01:06）只含 router 的 `file:` 旧条目，已与 package.json 不一致。**新机器上不要在 profile 里跑 `pnpm install`。**

### 源码直挂还是 lib/ 产物
| 包 | 入口 | 形态 | 改源码后怎样生效 |
|---|---|---|---|
| dsh-router-b（bundle 根） | `index.js`（空 apply）+ `cordis.patch.yml` | 源文件直用 | 改 patch 后重启 DSH |
| dsh-host-router | `main: lib/index.js` | **TS 编译产物 lib/**；src/ 不直接加载 | `scripts/safe-build-host.sh` 产出 `lib.next/`，再由人跑 `scripts/safe-restart.sh`（停 dsh-web.service → lib.next 换入 lib → 启动） |
| dsh-client-ui-router | `main: lib/index.js`，`./client: lib/client.js` | esbuild 打包产物 | `node scripts/build-client.mjs` 重建 `lib/client.js`；浏览器刷新即可（是否需重启未实测） |
| dsh-host-token-stats | `main: index.js` | 纯 ESM 源码直挂，无 lib | 改完重启 DSH |
| dsh-client-ui-token-stats | `lib/index.js`、`lib/client.js` | 产物 | `node scripts/build.mjs`（token-stats 仓） |

lib/ 等产物已存在于工作区，复制整个目录过去就能直接运行，不一定需要先构建。

## 4. 全局工具链与构建期依赖
- 全局 npm 包（`/usr/local/lib/node_modules`）：只有 corepack、npm、pnpm。`which tsc esbuild vite playwright` 全部无结果，**没有全局 typescript/esbuild/vite/playwright**。
- 构建时用到的工具位置（**都在仓库之外或不在 git 里**）：
  - safe-build-host.sh 第 7 行：`TSC=${DSH_TSC:-/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc}`，即借用另一个项目里的 TypeScript 5.9.3。新机必须有该路径，或设置 `DSH_TSC`。
  - build.mjs 的候选 tsc：`$DSH_TSC` → `packages/client-ui-router/node_modules/typescript` → 仓根 node_modules → `../deepseek-harness-latest/node_modules/typescript`（最后这个目录不存在）。
  - `packages/client-ui-router/node_modules/` 已存在（esbuild 0.24.0、typescript、@deepseek-ai/*、csstype 等，Nov 19 装）。`.gitignore` 不存在，`dsh-router-b` 也不是 git 仓库，所以随仓迁移时是否带上 node_modules 取决于拷贝方式。
  - 截图工具依赖 `~/.cache/ms-playwright`（chromium-1255、chromium_headless_shell-1255、ffmpeg-1013）。
- pnpm store：`/usr/local/pnpm-global/store/v11`。
- `.npmrc`：`/root/.npmrc`、工作区、dsh-router-b、profile 内均不存在；`/root/.config/pnpm` 不存在。
- registry：`npm config get registry` 和 `pnpm config get registry` 均为 `https://registry.npmjs.org/`（默认）。**没有内网源**，新机只要能访问 npmjs 就能装 DSH。DSH 运行时插件管理器另会读 npm 文件 CDN（dsh-plugin-manager/src/index.ts:87），与本插件无关。
- 环境中无 `npm_config_*` 或 proxy 变量。

## 5. 结论表
| 依赖项 | 绝对路径 | 当前值/方式 | 换机必须重做 | 复刻命令 |
|---|---|---|---|---|
| Node | /usr/local/bin/node | v24.22.3 官方 tarball | 是 | 解 node-v24.22.3-linux-x64.tar.xz 到 /usr/local |
| pnpm | /usr/local/lib/node_modules/pnpm | 11.28.13，npm -g | 是 | `npm i -g pnpm@11.28.13` |
| PNPM_HOME | /usr/local/pnpm-global | env + systemd | 是 | `export PNPM_HOME=/usr/local/pnpm-global`，PATH 前置 `$PNPM_HOME/bin` |
| DSH | 见 §2 安装根 | `pnpm add -g @deepseek-ai/dsh@0.2.2-rc.5` | 是 | 同左（rc 版可能需要 minimumReleaseAge 豁免，未实测） |
| /usr/local/bin/dsh | → /usr/local/pnpm-global/bin/dsh | 手工链接 | 是 | `ln -s /usr/local/pnpm-global/bin/dsh /usr/local/bin/dsh` |
| zod 补丁 | /usr/local/bin/dsh-fix-zod | systemd ExecStartPre | 是 | 拷脚本，`chmod +x` |
| systemd 单元 | /etc/systemd/system/dsh-web.service | 127.0.0.1:42443，--trusted-host 192.0.2.10:8443 | 是 | 拷文件后 `systemctl daemon-reload && systemctl enable --now dsh-web` |
| 辅助脚本 | /usr/local/bin/gate、dsh-web-gate.mjs、dsh-web-url、screenshot 链接 | 手工放置 | 是 | 逐个拷贝；`ln -s /srv/workspace/bin/screenshot /usr/local/bin/screenshot` |
| 跳板链接 | /srv/dsh-router-b、/srv/dsh-egress、/srv/dsh-vpn | → /srv/workspace/deepseek-harness/* | 是 | 见下 |
| profile 依赖与 bundles | /root/.dsh/profiles/web/package.json | link: + bundles 列表 | 是（或整份拷过去） | 跑 install.mjs |
| profile node_modules 链接 | /root/.dsh/profiles/web/node_modules/* | 12 个目录链接 | 是 | 跑 install.mjs |
| 品牌停用 | profile cordis.patch.yml:40-42 | ui-brand-official disabled | 是 | `install.mjs --disable-brand` 或拷贝 patch |
| 分区 root 路径 | dsh-router-b/cordis.patch.yml:38-104 | /srv/workspace/... 绝对路径 | 路径变了才需要 | 编辑该文件 |
| TypeScript（host 构建） | /srv/workspace/google tend/lumen-companion-harness/node_modules/typescript | 5.9.3 | 需要构建时 | 设 `DSH_TSC=<tsc路径>` |
| playwright 浏览器 | /root/.cache/ms-playwright | chromium-1255 | 需要截图时 | 用对应版本的 `npx playwright install chromium` |
| registry | — | 默认 npmjs，无 .npmrc | 否 | — |

## 插件注册机制复刻步骤（命令级）
以下命令假设新机路径与旧机相同（`/srv/workspace/deepseek-harness/...`，profile 名 web）。
```bash
# 0. 前置：Node 24 + pnpm 11 + DSH
npm i -g pnpm@11.28.13
export PNPM_HOME=/usr/local/pnpm-global PATH=/usr/local/pnpm-global/bin:$PATH
pnpm add -g @deepseek-ai/dsh@0.2.2-rc.5
ln -sf /usr/local/pnpm-global/bin/dsh /usr/local/bin/dsh
# 首次启动一次以生成 /root/.dsh/profiles/web（package.json 与 cordis.yml），然后停掉

# 1. 跳板链接（保持 profile 里的 link:/srv/dsh-router-b 写法有效）
ln -s /srv/workspace/deepseek-harness/dsh-router-b /srv/dsh-router-b
ln -s /srv/workspace/deepseek-harness/dsh-egress   /srv/dsh-egress
ln -s /srv/workspace/deepseek-harness/dsh-vpn      /srv/dsh-vpn

# 2. 用仓库自带脚本注册（不跑 pnpm；可先加 --dry-run 预览）
node /srv/dsh-router-b/scripts/install.mjs --profile /root/.dsh/profiles/web --disable-brand
node /srv/workspace/deepseek-harness/dsh-token-stats/scripts/install.mjs --profile /root/.dsh/profiles/web
#   （dsh-egress / dsh-vpn 也各自运行其 install 脚本，不在 W3 范围，未核查）

# 2'. 不用脚本时的等价手工步骤
P=/root/.dsh/profiles/web/node_modules; mkdir -p $P
ln -s /srv/dsh-router-b                          $P/dsh-router-b
ln -s /srv/dsh-router-b/packages/host-router      $P/dsh-host-router
ln -s /srv/dsh-router-b/packages/client-ui-router $P/dsh-client-ui-router
T=/srv/workspace/deepseek-harness/dsh-token-stats
ln -s $T                                  $P/dsh-token-stats
ln -s $T/packages/host-token-stats        $P/dsh-host-token-stats
ln -s $T/packages/client-ui-token-stats   $P/dsh-client-ui-token-stats
#   然后让 /root/.dsh/profiles/web/package.json 与 §3① 一致：dependencies 写 6 条 link:，
#   dsh.profile.bundles 追加 "dsh-router-b"、"dsh-token-stats"；
#   在 profile 的 cordis.patch.yml 末尾加：
#   - id: ui-brand-official
#     name: "@deepseek-ai/dsh-client-ui-brand-official"
#     disabled: true

# 3. 验证（只读）
readlink -f /root/.dsh/profiles/web/node_modules/dsh-host-router   # 应为 .../dsh-router-b/packages/host-router
ls /srv/dsh-router-b/packages/host-router/lib/index.js /srv/dsh-router-b/packages/client-ui-router/lib/client.js
/usr/local/bin/dsh-fix-zod
```
最省事的做法：整份拷贝 `/root/.dsh/profiles/web/{package.json,cordis.patch.yml,cordis.yml}`，再按第 1 步和第 2' 步重建链接。符号链接用 tar/rsync 拷贝时要保留链接（`rsync -a`）。不要拷 node_modules 内容的实体，也**不要**在 profile 里跑 `pnpm install`（install.mjs 注释说它曾在本机原地损坏过一个包）。

## 未确认项
- `npm ls -g` 报错（`Class extends value undefined`）的原因未查，不影响 pnpm 全局布局的结论。
- 新机安装 rc 版时是否必须配置 `minimumReleaseAgeExclude`：未实测。
- client-ui-router 重建 `lib/client.js` 后只刷新浏览器还是必须重启 DSH：未实测。
- dsh-egress / dsh-vpn 的 install 脚本内容未核查（不在 W3 范围）。

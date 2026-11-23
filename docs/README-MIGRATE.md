# 作战室迁移安装说明（README-MIGRATE）

> **2026-11-23 提示**：本文只覆盖前 5 个插件。第 6 个插件 dsh-agent-hub 的安装顺序和 `<DSH home>/agent-hub/controller.env` 配置见根目录 [README.md](../README.md) 第 3 节和 `plugins/dsh-agent-hub/README.md`；独立服务 dsh-hub 的部署见 `services/dsh-hub/README.md`。任何 `DSH_` 开头的变量都不能写进 `<DSH home>/.env`；dsh-secrets 的口令推荐写在 `<DSH home>/secrets.env`。全部文档目录见 [INDEX.md](INDEX.md)。

适用：DSH 0.2.2-rc.5 + 五个插件仓 `dsh-router-b`、`dsh-egress`、`dsh-vpn`、`dsh-token-stats`、`dsh-secrets`，profile `web`。

依据：`W6-MIGRATION-MANUAL.md`（主），W1–W5（辅），以及 2026-11-20 在源机只读核对的源码：
`dsh-router-b/scripts/install.mjs`、`safe-build-host.sh`、`safe-restart.sh`、`build.mjs`、各仓 `package.json` / `cordis.patch.yml`、`/root/.dsh/profiles/web/*`、`dsh --profile web --dump-config` 的实际输出。

记号：`<<替换>>` 表示必须按新机器改的值；**待现场确认** 表示源机上没有实测证据。

默认假设：新机器仍用 root、`DSH_HOME=/root/.dsh`、项目根 `/srv/workspace/deepseek-harness`、DSH 端口 42443。照这个假设走，需要改的地方最少。

---

## 0. 2026-11-21 增量（以本节为准）

本节记录仓库最近一次刷新（2026-11-21，任务 t20261121121422-376）相对下面历史正文的变化，**冲突时以本节为准**。

1. **仓库布局是 `plugins/`**：五个插件在 `plugins/dsh-router-b`、`plugins/dsh-egress`、`plugins/dsh-vpn`、
   `plugins/dsh-token-stats`、`plugins/dsh-secrets`。下文 §1 里的 `dsh-warroom/router-b/`、`token-stats/` 等
   是 2026-11-20 旧压缩包的目录名，对应关系是 `router-b→plugins/dsh-router-b`、`token-stats→plugins/dsh-token-stats`、
   `egress→plugins/dsh-egress`、`vpn→plugins/dsh-vpn`；`profile/` 与 `docs/` 位置不变。
2. **新增第 5 个插件 `dsh-secrets`**（本地加密保险库）。安装顺序变成
   **router → egress → vpn → token-stats → secrets**，profile 的 `link:` 从 12 条变 **14 条**，
   `--dump-config` 应从 4 段变 **5 段**。仓库只带源码 + `DESIGN.md` + `docs/USAGE.md` + `scripts/`；
   vault 文件、vault key、passphrase 都在目标机 `$DSH_HOME` 下首次使用时生成，**不在仓库里**。
3. **nginx 站点模板**在 `docs/nginx/`（`dsh-web`、`browser-novnc`、`gitea`、`couple-fit`），已脱敏为
   `__SERVER_NAME__` / `__TLS_CERT__` / `__TLS_KEY__` / `__CLIENT_CA__` / `__HTPASSWD_FILE__` / `__SITE_ROOT__`。
   8444 的 Gitea 是 mTLS，且现有证书 SAN **不含新地址 `8.134.170.38`**，详见 `docs/nginx/README.md`。
4. **全仓旧地址已替换**：迁移前的 `8.163` 段服务器地址统一改成 `8.134.170.38`
   （文档、模板、gate 脚本共 12 个文件 / 57 处；替换后全仓 `grep` 旧地址 0 处）。
   证书文件本身不在仓库里，替换只影响文字与配置副本。
5. **host-router 的 `src/` 比 `lib/` 新**：`bridge.ts` / `index.ts` / `snapshot.ts` 在 2026-11-20 18:35 改过，
   新构建在源机 `lib.next/`（按约定不入库）。所以仓库里的 `lib/` 是上一次已验证构建；在新机跑起来之后，
   要重跑 `plugins/dsh-router-b/scripts/safe-build-host.sh` 生成 `lib.next/`，再由人工 `safe-restart.sh` 换入。
6. `profile/cordis.patch.yml` 是脱敏副本：源文件无字面 API key；凭据占位值已换 `__REPLACE_ME__`；
   provider key 请在目标机凭据库 / `/root/.dsh/.env` 重新录入。`profile/package.json` 已同步到当前 14 条 `link:`。

---

## 目录

1. 包内目录结构
2. 安装步骤
   - 2.1 系统前置依赖
   - 2.2 Node / pnpm / DSH 版本
   - 2.3 放代码与依赖安装（file: / link: 注意事项）
   - 2.4 构建
   - 2.5 install.mjs：调用顺序与参数
   - 2.6 profile 注册与 14 条软链校验
   - 2.7 5 段 `--dump-config` 验证
   - 2.8 启动与自检
3. 必须人工改的路径（P0 五类）
4. 哪些文件不能带
5. 常见故障与回滚
6. 仍需现场确认的点

---

## 1. 包内目录结构

```
dsh-warroom/
├── router-b/          dsh-router-b 插件仓：分区路由 host-router + 作战室界面 client-ui-router，含 scripts/install.mjs、build.mjs、safe-build-host.sh、safe-restart.sh
├── token-stats/       dsh-token-stats 插件仓：侧栏 Token 用量面板（host 只读 $DSH_HOME/sessions）
├── egress/            dsh-egress 插件仓：模型端点出口代理管理（Egress 面板）
├── vpn/               dsh-vpn 插件仓：openfortivpn 管理与看门狗（VPN 面板）
├── profile/           /root/.dsh/profiles/web 的覆盖层：cordis.patch.yml、cordis.yml、pnpm-workspace.yaml（package.json 和 node_modules 不带，由 install.mjs 重建）
├── docs-manual/       W1–W6 迁移审计报告与 router-b/docs（HANDOFF、UPGRADE、INTEGRATION 等），仅供查阅
└── README-MIGRATE.md  本文件
```

包内目录名（`router-b` 等）和新机上的目录名不同。解包后要放回原名：`dsh-router-b`、`dsh-token-stats`、`dsh-egress`、`dsh-vpn`。打包工具最终用的目录名以包为准，**待现场确认**。

---

## 2. 安装步骤

所有命令以 root 执行。先设变量：

```bash
PKG=/root/dsh-warroom                       # <<替换>> 解包位置
WS=/srv/workspace                           # <<替换>> 新机工作区根，能保持不变最好
R=$WS/deepseek-harness                      # 插件仓所在目录
P=/root/.dsh/profiles/web                   # profile 目录
```

### 2.1 系统前置依赖

| 项 | 要求 | 出处 |
|---|---|---|
| OS | Ubuntu 22.04 x86_64 + systemd（源机 22.04.5） | W2 |
| 用户 | root（`dsh-web.service` 写的是 `User=root`） | W2 §4.4 |
| 包 | `nginx`、`apache2-utils`、`python3`、`curl`、`openssl`、`xz-utils` | W2、W4；`safe-restart.sh` 用到 python3 和 curl |
| VPN | 用 dsh-vpn 就要装 `openfortivpn`，并能在 PATH 里找到 | W6 §1.1 |
| 网络 | 能访问 registry.npmjs.org | W3 §4 |
| 安全组 | 入方向放行 8443/tcp | W2 §2.1 |

```bash
apt-get update && apt-get install -y nginx apache2-utils python3 curl openssl xz-utils
command -v python3 curl openssl nginx    # 预期 4 行路径
```

### 2.2 Node / pnpm / DSH 版本

```bash
cd /tmp && curl -fLO https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz
tar -xJf node-v24.22.3-linux-x64.tar.xz -C /usr/local --strip-components=1
node -v                       # 预期 v24.22.3（插件 engines 要求 >=22）

npm i -g pnpm@11.28.13
pnpm -v                       # 预期 11.28.13

export PNPM_HOME=/usr/local/pnpm-global PATH=/usr/local/pnpm-global/bin:$PATH
mkdir -p "$PNPM_HOME"
pnpm add -g @deepseek-ai/dsh@0.2.2-rc.5
ln -sf /usr/local/pnpm-global/bin/dsh /usr/local/bin/dsh
dsh --version                 # 预期 0.2.2-rc.5
pnpm store path               # 预期 /usr/local/pnpm-global/store/v11（dsh-fix-zod 依赖此路径）
```

如果 rc 版因为「最小发布时长」被拒，参照源机 `/usr/local/pnpm-global/global/v11/pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`。是否必需：**待现场确认**。

### 2.3 放代码与依赖安装（file: / link: 注意事项）

```bash
mkdir -p "$R"
cp -a "$PKG/router-b"    "$R/dsh-router-b"
cp -a "$PKG/token-stats" "$R/dsh-token-stats"
cp -a "$PKG/egress"      "$R/dsh-egress"
cp -a "$PKG/vpn"         "$R/dsh-vpn"
ls "$R"                       # 预期 dsh-egress dsh-router-b dsh-token-stats dsh-vpn

# 兼容跳板（可选；egress/vpn 的 docs 引用 /srv/dsh-*；重跑 install.mjs 后不再必需，见 W6 C3）
ln -sfn "$R/dsh-router-b" /srv/dsh-router-b
ln -sfn "$R/dsh-egress"   /srv/dsh-egress
ln -sfn "$R/dsh-vpn"      /srv/dsh-vpn
```

依赖规则（源码核对）：

- 四个仓根 `package.json` 的 dependencies 都是 `file:./packages/...`，例如 `dsh-router-b/package.json:33-34`。这是相对路径，换目录不受影响。根目录不是 pnpm workspace。
- **不要**在仓根或 profile 目录跑 `pnpm install`。`install.mjs:19` 的注释和 `docs/UPGRADE.md:47,143` 都写了：profile 级 `pnpm install` 会重写整棵树，源机上曾因此把一个包删空。DSH 只要 `link:` 依赖加上软链就能加载。
- 唯一需要装 npm 依赖的是 `dsh-router-b/packages/client-ui-router`，它带 `package-lock.json`，devDependencies 里有 esbuild、react 等。只有要构建时才装：

```bash
cd "$R/dsh-router-b/packages/client-ui-router" && npm ci
```

- `dsh-token-stats/packages/client-ui-token-stats/node_modules` 在源机上是软链，指向 `.../dsh-router-b/packages/client-ui-router/node_modules`。包里不带这条软链，需要构建 token-stats 时再建：

```bash
ln -sfn "$R/dsh-router-b/packages/client-ui-router/node_modules" \
        "$R/dsh-token-stats/packages/client-ui-token-stats/node_modules"
```

  也可以不建，改用 `export DSH_CLIENT_MODULES=$R/dsh-router-b/packages/client-ui-router/node_modules`，见 `dsh-token-stats/scripts/build.mjs:42`。

### 2.4 构建

各仓的 `lib/` 跟着代码一起复制过来，**首次安装不需要构建**，DSH 启动时直接加载 `lib/`（W3 §3）。只有改了源码才构建。先完成第 3 节 P0-3、P0-4（tsc 和 typeRoots）。

```bash
# 独立 TypeScript（替代源机借用别的项目的 tsc，见 P0-3）
mkdir -p /opt/dsh-tsc && cd /opt/dsh-tsc && npm init -y >/dev/null && npm i typescript@5.9.3 @types/node@26.6.6
export DSH_TSC=/opt/dsh-tsc/node_modules/typescript/bin/tsc
node "$DSH_TSC" --version     # 预期 Version 5.9.3（host 需要 >=5.7）

# host-router：只写 lib.next/，不碰运行中的 lib/
bash "$R/dsh-router-b/scripts/safe-build-host.sh"
# 预期最后输出：
#   safe-build: import ok
#   safe-build: lib.next ready; run safe-restart.sh to switch to it

# client 浏览器 bundle（可以直接重建）
cd "$R/dsh-router-b/packages/client-ui-router" && node scripts/build-client.mjs

# 全量构建（client 声明 → client bundle → host tsc → 测试）
cd "$R/dsh-router-b" && node scripts/build.mjs
node "$R/dsh-token-stats/scripts/build.mjs"
```

`lib.next/` 由人工执行 `safe-restart.sh` 换入（2.8 节）。DSH 运行时不要直接改 `lib/`。

### 2.5 install.mjs：调用顺序与参数

参数来自各脚本的 argv 解析（源码行号如下）：

| 脚本 | 支持的参数 | 源码 |
|---|---|---|
| `dsh-router-b/scripts/install.mjs` | `--profile <dir>`（必填）、`--dry-run`、`--disable-brand`、`-h/--help` | `:54-74`，usage：`--profile <dir> [--disable-brand] [--dry-run]` |
| `dsh-egress/scripts/install.mjs` | `--profile <dir>`、`--dry-run`、`-h` | `:47-53` |
| `dsh-vpn/scripts/install.mjs` | `--profile <dir>`、`--dry-run`、`--uninstall`、`-h` | `:37-49` |
| `dsh-token-stats/scripts/install.mjs` | `--profile <dir>`、`--dry-run`、`--uninstall`、`-h` | `:39-51` |

各参数作用：

- `--profile <dir>`：profile 目录，目录下必须已有 `package.json`，且其中有 `dsh.profile.bundles` 数组，否则脚本 exit 2（router `install.mjs:96-99,123-126`）。支持 `~` 展开。
- `--dry-run`：只打印 `would change N thing(s)`，不写任何文件。
- `--disable-brand`（确切拼写，两个连字符，只有 router-b 支持）：往 profile 的 `cordis.patch.yml` 追加三行 `- id: ui-brand-official` / `name: "@deepseek-ai/dsh-client-ui-brand-official"` / `disabled: true`。已有这一行时不重复写（`install.mjs:193-210`）。
  **何时必须加**：profile 的 `cordis.patch.yml` 里还没有这行时必须加。新建 profile、丢了覆盖层、或者覆盖层不是从旧机带来的，都属于这种情况。原因是 `sidebar.brand.mark`/`sidebar.brand.name` 是 single 座位，官方品牌占着时 client-ui-router 注册会抛 `single slot ... already has a registration`（`docs/UPGRADE.md:45`）。带了旧覆盖层时加上也无害，因为脚本是幂等的。
- `--uninstall`：仅 vpn / token-stats 支持，迁移时不用。
- 脚本不跑包管理器。每次改动留一份 `package.json.bak-install-<毫秒时间戳>`。分区 root 不存在时只打 warning，不会失败（`install.mjs:213-242`）。

每个脚本都把自己的名字 `push` 到 bundles 末尾（router `:139`、egress `:116`、vpn `:97`、token-stats `:99`），所以**执行顺序就是最终的 bundles 顺序**，必须是 router → egress → vpn → token-stats → secrets。

### 2.6 profile 注册与 14 条软链校验

```bash
mkdir -p "$P" && chmod 700 /root/.dsh

# 1) 覆盖层（从包里带来）
cp "$PKG/profile/cordis.patch.yml" "$PKG/profile/cordis.yml" "$PKG/profile/pnpm-workspace.yaml" "$P/"
chmod 600 "$P/cordis.patch.yml"
cat "$P/pnpm-workspace.yaml"      # 预期 packages: [.] / nodeLinker: hoisted / autoInstallPeers: false

# 2) 只含两层官方 bundle 的 package.json
cat > "$P/package.json" <<'EOF'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
EOF
mkdir -p "$P/node_modules"     # 待现场确认：install.mjs 是否自动建此目录，源码未见 mkdir，先手建更稳

# 3) 预览，再按顺序注册
for s in dsh-router-b dsh-egress dsh-vpn dsh-token-stats; do node "$R/$s/scripts/install.mjs" --profile "$P" --dry-run; done
node "$R/dsh-router-b/scripts/install.mjs"    --profile "$P" --disable-brand
node "$R/dsh-egress/scripts/install.mjs"      --profile "$P"
node "$R/dsh-vpn/scripts/install.mjs"         --profile "$P"
node "$R/dsh-token-stats/scripts/install.mjs" --profile "$P"
```

总体校验：

```bash
node -e "const p=require('$P/package.json');console.log(Object.keys(p.dependencies).length, p.dsh.profile.bundles.join(','))"
# 预期：12 @deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app,dsh-router-b,dsh-egress,dsh-vpn,dsh-token-stats
ls -la "$P/node_modules" | grep -c -- '->'        # 预期 12
grep -n -A2 'ui-brand-official' "$P/cordis.patch.yml"   # 预期有一行 disabled: true
```

14 条软链逐条校验（5 个 bundle × 自身 + host + client，secrets 无 client 包）。每行预期输出 `OK <名字>`；输出 `BAD` 说明链接缺失或指向不对：

```bash
chk(){ test -L "$P/node_modules/$1" && [ "$(readlink -f "$P/node_modules/$1")" = "$(readlink -f "$2")" ] && echo "OK $1" || echo "BAD $1"; }
chk dsh-router-b              "$R/dsh-router-b"
chk dsh-host-router           "$R/dsh-router-b/packages/host-router"
chk dsh-client-ui-router      "$R/dsh-router-b/packages/client-ui-router"
chk dsh-egress                "$R/dsh-egress"
chk dsh-host-egress           "$R/dsh-egress/packages/host-egress"
chk dsh-client-ui-egress      "$R/dsh-egress/packages/client-ui-egress"
chk dsh-vpn                   "$R/dsh-vpn"
chk dsh-host-vpn              "$R/dsh-vpn/packages/host-vpn"
chk dsh-client-ui-vpn         "$R/dsh-vpn/packages/client-ui-vpn"
chk dsh-token-stats           "$R/dsh-token-stats"
chk dsh-host-token-stats      "$R/dsh-token-stats/packages/host-token-stats"
chk dsh-client-ui-token-stats "$R/dsh-token-stats/packages/client-ui-token-stats"
```

某条 BAD 时，先重跑对应仓的 install.mjs。不能跑脚本时手工补链（以第一条为例，其余同理）：

```bash
ln -sfn "$R/dsh-router-b" "$P/node_modules/dsh-router-b"
```

手工补链后还要确认 `package.json` 的 dependencies 里有对应的 `"link:<同一路径>"`。

### 2.7 5 段 `--dump-config` 验证

`dsh --profile web --dump-config` 会打印合成后的插件树，每一层有 `# == <来源>` 注释。源机实测，本项目的 4 个 bundle 各占一段：

```bash
dsh --profile web --dump-config | grep -n '^# == dsh-'
# 预期 4 行，顺序固定：
#   # == dsh-router-b
#   # == dsh-egress
#   # == dsh-vpn
#   # == dsh-token-stats
```

| 段 | 验证什么 | 命令 | 期望看到 |
|---|---|---|---|
| `dsh-router-b` | 路由 host + 作战室界面已挂上；manager 配置和分区 root 已按新机修改 | `dsh --profile web --dump-config \| sed -n '/^# == dsh-router-b/,/^# == dsh-egress/p' \| grep -E 'id: \|manager:\|maxWorkers:\|root:'` | `id: host-router`、`manager: true`、`maxWorkers: 0`、3 个 `root:`（都是新机上存在的路径）、`id: client-ui-router` |
| `dsh-egress` | 出口管理插件已挂上 | `... \| sed -n '/^# == dsh-egress/,/^# == dsh-vpn/p' \| grep 'id: '` | `id: host-egress`、`id: client-ui-egress` |
| `dsh-vpn` | VPN 插件已挂上；看门狗探测端口与 DSH 端口一致 | `... \| sed -n '/^# == dsh-vpn/,/^# == dsh-token-stats/p' \| grep -E 'id: \|localProbePort'` | `id: host-vpn`、`localProbePort: 42443`（改了端口就是新端口）、`id: client-ui-vpn` |
| `dsh-token-stats` | 用量面板已挂上 | `... \| sed -n '/^# == dsh-token-stats/,$p' \| grep -E 'id: (host\|client-ui)-token-stats'` | `id: host-token-stats`、`id: client-ui-token-stats` |

另外确认品牌已禁用：

```bash
dsh --profile web --dump-config | grep -n -A2 'id: ui-brand-official'   # 预期下一两行有 disabled: true
```

少了某一段，说明对应 bundle 没注册上：检查 bundles 数组和软链（2.6 节）。

### 2.8 启动与自检

systemd unit、gate、nginx 的完整配置见 W6 §7。新机必须改 unit 的 `--trusted-host <<新host>>:8443` 和 nginx 的 `server_name <<新host>>;`。

```bash
touch /var/log/dsh-web.log
systemctl daemon-reload
systemctl enable --now dsh-web.service dsh-web-gate.service
systemctl is-active dsh-web.service dsh-web-gate.service nginx   # 预期 active ×3
ss -ltnp | grep -E ':(8443|42443|42444) '                        # 42443/42444 只监听 127.0.0.1

# 入口链：预期依次是 401 / 302 / 401（W2 §2.1）
curl -k -s -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8443/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:42444/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:42443/

# 插件 API：与 safe-restart.sh:49-51 的取 token 方式相同，预期都是 200
T=$(grep -o 'token=[A-Za-z0-9_-]*' /var/log/dsh-web.log | tail -1 | cut -d= -f2)
J=$(mktemp); curl -s -o /dev/null -c "$J" -b "$J" -L "http://127.0.0.1:42443/?token=$T"
for u in /api/router/board /api/router/tiers /api/token-stats/summary; do
  printf '%s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' -b "$J" "http://127.0.0.1:42443$u"; done
rm -f "$J"

tail -n 50 /var/log/dsh-web.log | grep -iE 'error|cannot|single slot' || echo "no errors"
```

以后换入新构建的 host，**由人工**执行：

```bash
bash "$R/dsh-router-b/scripts/safe-restart.sh"     # 或 --now；预期 safe-restart: router up
```

GUI 人工核对：打开 `https://<<新host>>:8443`，通过 basic auth 后应直接进入界面。侧栏是作战室品牌；Router、Egress、VPN、Token 四个面板都在；插件管理器里 8 个子插件都是 enabled。

---

## 3. 必须人工改的路径（P0 五类）

依据：W5「P0 必改」5 条，W6 §5、§11 的行号经 2026-11-20 源码 `grep -n` 复核。路径保持 `/srv/workspace/deepseek-harness` 不变时，第 2 类可以不改，但目录必须存在。

| # | 文件绝对路径:行号 | 旧值 → 新值 | 错过会怎样 |
|---|---|---|---|
| P0-1 profile 挂载 | `/root/.dsh/profiles/web/package.json:5-16`（12 条 `link:`）+ `/root/.dsh/profiles/web/node_modules/` 的 12 个软链 | `link:/srv/dsh-router-b…`、`/srv/dsh-egress…`、`/srv/dsh-vpn…`、`/srv/workspace/deepseek-harness/dsh-token-stats…` → 不手改，按 2.5 节重跑 4 个 install.mjs，生成指向 `<<$R>>/dsh-*` 真实路径的链接 | Router、Egress、VPN、Token 面板全部消失，日志报 `cannot resolve profile bundle` |
| P0-2 分区 root | `/srv/workspace/deepseek-harness/dsh-router-b/cordis.patch.yml:40`、`:68`、`:90` | `/srv/workspace/rca-ab-test` → `<<$WS>>/rca-ab-test`；`"/srv/workspace/google tend"` → `"<<$WS>>/google tend"`（**保留双引号**，路径有空格）；`/srv/workspace/deepseek-harness` → `<<$WS>>/deepseek-harness` | 按文件路由失败，worker 的 cwd 不存在。install.mjs 只打 warning，不会拦住 |
| P0-3 tsc 路径 | `/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-build-host.sh:7` | `TSC="${DSH_TSC:-/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc}"` → `TSC="${DSH_TSC:-/opt/dsh-tsc/node_modules/typescript/bin/tsc}"`（或每次 `export DSH_TSC=…`） | 构建 host 时报 `Cannot find module …/typescript/bin/tsc`。运行不受影响，但改不了代码 |
| P0-4 typeRoots | `/srv/workspace/deepseek-harness/dsh-router-b/packages/host-router/tsconfig.json:17` | `"typeRoots": ["/usr/local/pnpm-global/store/v11/links/@types/node/26.6.6/2ddc00d8…/node_modules/@types"]` → `"typeRoots": ["/opt/dsh-tsc/node_modules/@types"]` | 新机 store hash 必然不同，构建报 `TS2688: Cannot find type definition file for 'node'`（W4 推演，**待现场确认**） |
| P0-5 状态目录与端口（条件触发） | `/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-restart.sh:10`（`grep -n '^BOARD='` 实测）；联动 `/srv/workspace/deepseek-harness/dsh-vpn/cordis.patch.yml:28` | `BOARD=/root/.dsh/router/board.json` → `BOARD="${DSH_HOME:-$HOME/.dsh}/router/board.json"`；改了 DSH 端口时 `localProbePort: 42443` → `<<新端口>>`，同时改 unit `--port`、gate `GATE_UPSTREAM_PORT`、safe-restart.sh 里的 `127.0.0.1:42443` | 不以 root 运行或改了 DSH_HOME 时，safe-restart.sh 在 python 读 board 时中止；端口不一致时 VPN 看门狗误判本机服务不可达 |

说明：四个仓根目录都没有 README（`ls README*` 无结果）；可参考 `dsh-router-b/docs/UPGRADE.md`、`dsh-egress/docs/EGRESS.md`、`dsh-vpn/docs/VPN.md`、`dsh-router-b/packages/client-ui-router/README.md`。

可复制的修改命令（先备份）：

```bash
RB=$R/dsh-router-b
cp -a $RB/cordis.patch.yml $RB/cordis.patch.yml.pre-migrate
sed -i -e "40s#root: .*#root: $WS/rca-ab-test#" \
       -e "68s#root: .*#root: \"$WS/google tend\"#" \
       -e "90s#root: .*#root: $WS/deepseek-harness#" $RB/cordis.patch.yml
grep -n 'root:' $RB/cordis.patch.yml
mkdir -p "$WS/rca-ab-test" "$WS/google tend"

sed -i '7s#.*#TSC="${DSH_TSC:-/opt/dsh-tsc/node_modules/typescript/bin/tsc}"#' $RB/scripts/safe-build-host.sh
sed -i '17s#"typeRoots": \[[^]]*\]#"typeRoots": ["/opt/dsh-tsc/node_modules/@types"]#' $RB/packages/host-router/tsconfig.json
sed -i '10s#.*#BOARD="${DSH_HOME:-$HOME/.dsh}/router/board.json"#' $RB/scripts/safe-restart.sh
sed -n 7p $RB/scripts/safe-build-host.sh; sed -n 17p $RB/packages/host-router/tsconfig.json; sed -n 10p $RB/scripts/safe-restart.sh
```

修改后的生效方式：改 `cordis.patch.yml` 只需重启 DSH；改脚本和 tsconfig 只影响下一次构建。

另外两项 P1（不会导致起不来）：`host-router/src/config.ts:739,744` 写进 worker 提示词的 `/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-build-host.sh` 和 `/srv/workspace/bin/screenshot`，路径变了才需要改，改完要构建；`/root/.dsh/storages/workspace.json` 和 `schedule.json` 里的路径，在 GUI 里修改。

---

## 4. 哪些文件不能带

| 不带的内容 | 原因 |
|---|---|
| 密钥类：`/root/.dsh/.credentials.yaml`、`/root/.dsh/.env`、任何 `*token*`、`credentials*`、`*.key`、`*.pem`、`/root/.dsh/vpn/secrets/`、`/root/.dsh/egress/config.json`（含代理口令） | 明文密钥离开源机就有泄露风险。新机在 Web UI 设置、Egress 面板、VPN 面板里重新录入（W1 D、W6 §10） |
| `dsh-router-b/deploy/` 整个目录 | `deploy/ACCESS.md:15`、`deploy/41-verify-public.sh:3` 有明文口令（W4 §2.8）。只单独带 nginx 配置、gate 脚本这几个需要的文件 |
| `sessions/`（放进状态包，不放进代码包） | 23 MB 会话历史，内容可能含敏感对话。要保留历史就单独加密传输，不要混进本代码包；不带的话 Token 面板显示空态，不报错（W5） |
| `/root/.dsh/router/board.json`（及 `snapshot.json`、`seams.json`、`*.tmp-*`） | 运行中一直在写，热拷会拿到半截 JSON。缺失时会自动生成空板。真要带就停服后单独拷，并和 sessions、anchor.json 一起带 |
| 所有 `node_modules` 及其软链（profile 的 12 个、`client-ui-token-stats/node_modules`） | 软链指向源机绝对路径，到新机就是悬空链；profile 链接由 install.mjs 重建，client 依赖用 `npm ci` 重装 |
| `/root/.dsh/profiles/web/.plugin-manager/`（logs） | 插件管理器日志，属于本机运行记录，新机没用 |
| `pnpm-lock.yaml`（profile 下的） | 旧锁，和当前 `package.json` 对不上（W3）；本方案也不跑 `pnpm install`。注意：`client-ui-router/package-lock.json` **要带**，`npm ci` 需要它 |
| `lib.prev/`、`lib.next/`、`lib.failed/`、`lib.bak-*`、`src.bak-*` | safe-build/safe-restart 的中间态和回滚副本（host-router 下源机有 7 个 `lib.bak-*` 和 1 个 `lib.prev`）。带过去会让新机的 safe-restart 误把旧版本当回滚目标或直接换入 |
| `*.bak-*`、`*.bak-install-*`、`cordis.patch.yml.bak-*`、`dsh-router-b/_backup/` | 历史备份。内容可能是旧路径或旧配置，误用会回退修改 |
| `.dsh-artifacts/` 中间产物（源机约 28 MB） | 任务过程产出的截图和报告，不是运行依赖。只把 W1–W6 放进 `docs-manual/` |
| `*.tsbuildinfo` | tsc 增量缓存，记录源机绝对路径，可能让新机构建出错 |
| `scripts/rotate-anchor-and-drill.sh` | 一次性演练脚本（W4、W5 P2） |

打包后自查：

```bash
tar -tzf <<包.tgz>> | grep -E 'node_modules|\.env$|credentials|\.key$|\.pem$|board\.json|lib\.(prev|next|failed)|\.bak-|pnpm-lock|\.plugin-manager|tsbuildinfo' || echo "clean"
```

---

## 5. 常见故障与回滚

1. **面板全没了，日志 `cannot resolve profile bundle`**：软链悬空或 bundles 缺项。先跑 2.6 节的 `chk`，再重跑对应 install.mjs。回滚：`ls -t $P/package.json.bak-install-*`，把最新一份拷回 `package.json`。
2. **`single slot … already has a registration`**：品牌行没禁用。执行 `node $R/dsh-router-b/scripts/install.mjs --profile $P --disable-brand` 后重启 DSH。
3. **dsh-web.service 起不来，ExecStartPre 报 `dsh-web not found` / `no zod in store`**：store 路径不是 `/usr/local/pnpm-global/store/v11`。修正 `/usr/local/bin/dsh-fix-zod` 里的路径；确认不需要时删掉 unit 的 `ExecStartPre` 行（W2 §1.6）。
4. **能过 basic auth 但 DSH 拒绝请求**：`--trusted-host` 和 nginx `server_name` 不一致，两处改成同一个 `<<新host>>:8443`。全站 500 时检查 `/etc/nginx/.dsh-auth` 是否 `root:www-data 640`。
5. **safe-build-host.sh 报找不到 tsc 或 TS2688**：P0-3、P0-4 没改，或 `/opt/dsh-tsc` 没装。这一步只写 `lib.next/`，失败不影响运行中的服务，`rm -rf …/host-router/lib.next` 即可。
6. **safe-restart.sh 输出 `router did not come up`**：脚本已自动把坏版本移到 `lib.failed/`，把 `lib.prev/` 换回 `lib/` 并重启（`safe-restart.sh:56-59`）。查 `tail -n 100 /var/log/dsh-web.log` 定位原因。
7. **启动后 install.mjs 打 `partition roots … do not exist`**：P0-2 没改或目录没建，执行 `mkdir -p` 或改 root 后重启。
8. **整体回滚某一步配置**：`cordis.patch.yml.pre-migrate` 拷回；profile 的 `package.json` 从 `.bak-install-*` 恢复；然后重启 DSH（由人工执行 `systemctl restart dsh-web.service` 或 safe-restart.sh）。

---

## 6. 仍需现场确认的点

1. 打包后的目录名（`router-b` 还是 `dsh-router-b`）以及 `profile/`、`docs-manual/` 里实际放了哪些文件，以打包任务的结果为准。
2. install.mjs 在 `$P/node_modules` 不存在时会不会自动创建：源码 `:151-189` 直接调用 `symlinkSync`，没有看到 mkdir，所以本文先手动 `mkdir -p`。
3. 新机上是否还需要 `dsh-fix-zod`，rc 版是否需要 `minimumReleaseAgeExclude`（W2、W3 都标为待验证）。
4. W4 推演的构建报错（TS2688、build.mjs exit 2）都没有实际跑过；新机第一次构建时要留意输出。
5. kiro-relay(7993)、gemini-gateway(4000) 两个中继的部署方法，以及 commandcode 上游是否放行新机 IP，W1/W2 都标为未确认。

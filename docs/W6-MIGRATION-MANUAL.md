# 作战室移植手册（W6 合成版）

> 对象：DSH（DeepSeek Harness）0.2.2-rc.5 + 插件仓 `dsh-router-b`、`dsh-egress`、`dsh-vpn`、`dsh-token-stats`，GUI 链路 `浏览器 → nginx :8443（TLS + basic auth）→ gate 127.0.0.1:42444 → DSH 127.0.0.1:42443`。
> 来源：W1（运行时配置）、W2（系统侧）、W3（环境与插件注册）、W4（仓内非包内容）、W5（数据源与硬编码路径）五份实测报告，路径都在 本目录（`docs/`）。
> W6 只做合成。为裁决冲突补跑过几条只读命令，结果标为「W6 复核」。全程没有修改任何被审计的文件。
> 记号：【W1】…【W5】表示事实出处；**待验证** 表示只有单方证据、没有实测；**未确认** 表示所有报告都没有证据。

---

## 目录

0. 报告间冲突与裁决
1. 阶段 0：前置条件与人工准备
2. 阶段 1：安装 DSH 本体
3. 阶段 2：放代码
4. 阶段 3：注册插件（bundle 机制）
5. 阶段 4：改硬编码路径
6. 阶段 5：构建
7. 阶段 6：系统侧（systemd / gate / nginx / TLS / 安全组 / logrotate）
8. 阶段 7：数据迁移（/root/.dsh）
9. 阶段 8：验收清单
10. 必须人工做、无法脚本化的事项
11. 换机必炸清单（按 P0 排序）
12. 待验证 / 未确认汇总

---

## 0. 报告间冲突与裁决

| # | 冲突点 | 各方说法 | 采信 | 理由 |
|---|---|---|---|---|
| C1 | profile 覆盖层里 `ui-brand-official disabled: true` 所在行号 | W3：`cordis.patch.yml` 第 40-42 行；W1：`:159-161` | **W1** | W6 复核：`grep -n ui-brand-official /root/.dsh/profiles/web/cordis.patch.yml` 的输出是 `159:`、`160:`、`161: disabled: true` |
| C2 | profile `node_modules` 里的软链数量 | W5 §C P0-1 写的是「9 个软链」；W1、W3 写的是 12 个 | **12 个**（W1/W3） | W6 复核：`ls -la /root/.dsh/profiles/web/node_modules \| grep -c -- '->'` 输出 `12`。4 个 bundle 加 8 个子包，正好 12 个 |
| C3 | `install.mjs` 写进 profile 的 `link:` 是什么路径 | W3：当时是从 `/srv/dsh-router-b` 跳板运行的，所以写成 `/srv/...`；W4：`BUNDLE` 由 `import.meta.url` 推导，「它写的是真实路径」 | **W4** | W6 复核：`node /srv/dsh-router-b/scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run` 输出 `would change 1 thing(s) … package.json: dependencies + bundles`。即使从跳板路径运行，脚本也要改写 `link:`，说明它会写成解析后的真实路径 `/srv/workspace/deepseek-harness/dsh-router-b`（Node 默认对主模块做 realpath）。现在 profile 里的 `/srv/...` 写法来源**未确认**，可能是手工改的。结论：只要在新机器上重跑 install.mjs，`/srv/dsh-*` 跳板就不再是必需品 |
| C4 | `profile` 是否负责注册插件 | 题面怀疑「profile 有插件条目」；W1、W3 一致认为不是：注册靠 `package.json` 的 `dsh.profile.bundles`、node_modules 链接和 bundle 自己的 `cordis.patch.yml` insert 行 | **W1/W3**（两份一致） | W1 用 `dsh --dump-config` 的层注释和 `plugin_manager` 里的 `patchId` 实测过；W3 引了加载器源码 `dsh-app-boot/src/profile.ts:651-695`。profile 的 `cordis.patch.yml` 只改宿主内置行，不插入本项目插件 |
| C5 | `/root/.dsh/storages/workspace.json` 有几个工作区 | W1：3 条；W5：3 条以上，还说「另有一个 deepseek-harness 工作区」 | **W1（3 条）** | W6 复核：解析 JSON 得到 3 条：`/srv/workspace/rca-ab-test`、`/srv/workspace`、`/srv/workspace/google tend`。没有单独的 deepseek-harness 工作区 |
| C6 | `storages/session_projcache/` 能不能丢 | W1：缓存，「删掉会重建」，不要带；W5：能不能删**未确认**，建议跟 sessions 一起搬 | **按 W5 带上**；「删掉会重建」标为**待验证** | W1 没有给出重建的证据。这个目录只有 2.5 MB，带上的成本可以忽略 |
| C7 | `/root/.dsh/.env` 里两个 key 由谁使用 | W2：给 kiro-relay / gemini-gateway 用；W1：给 DSH 凭据层用，作为 provider `apiKeyEnv` 的 fallback | **W1** | W1 有源码证据 `dsh-credentials-local/lib/index.js:13-20`，还查过 `/proc/432879/environ`，里面没有这两个变量。两个中继自己的 key 在 `/etc/llm/kiro.key`、`/etc/llm/gemini.env`【W2 §4.5】。两边的 key 必须配成一对 |
| C8 | `dsh-fix-zod` 是可选还是必需 | W2 骨架注释写「可选」；W3 写「必须带走」 | **只要 unit 里保留 `ExecStartPre`，就必须带上**；zod 链接本身有没有必要：**待验证** | ExecStartPre 指向的文件不存在时 unit 起不来。新机器上是否还会出现 `Cannot find module 'zod'`，W2 §7 标的是未确认 |
| C9 | 分区 root 算不算「换机必炸」 | W3：路径变了才需要改；W5：换机必炸 | **两者都对**：新机器上这 3 个目录不存在才会炸 | install.mjs 只给 warning，不会失败（W4 引 `install.mjs:235-242`），所以不会自动拦住 |
| C10 | `client-ui-router/node_modules` 要不要带 | W3：复制整个目录过去就能直接跑；W4：不带，新机器上 `npm ci` | **不带，新机器上 `npm ci`** | 运行时只读 `lib/`，不依赖它（W3 的说法成立）。但 token-stats 的 `scripts/build.mjs:41-46` 会去兄弟目录 `dsh-router-b/packages/client-ui-router/node_modules` 找 esbuild（W6 复核），所以只要还要构建，就得把它装回来 |
| C11 | 42443 是直连还是经过 nginx | W1、W2 一致：42443 只监听 127.0.0.1，对外只有 nginx 8443 → 42444 → 42443 | 无冲突 | W2 有 `ss -ltnp` 和 `nginx -T` 实测。safe-restart.sh 直接访问 `127.0.0.1:42443` 只是本机回环自检【W4】 |

只有单方证据、没有实测的结论，统一放在 §12。

---

## 1. 阶段 0：前置条件与人工准备

### 1.1 目标机要求

| 项 | 要求 | 出处 |
|---|---|---|
| OS | 源机是 Ubuntu 22.04.5 LTS，x86_64，systemd。建议新机用同版本 | W2 |
| 用户 | **root**。`dsh-web.service` 里写的是 `User=root`，状态目录 `/root/.dsh` 权限 700 | W2 §4.4 |
| Node | v24.22.3，官方 tarball 解到 `/usr/local`，不用 apt/nvm | W2 §1.7、W3 §1 |
| pnpm | 11.28.13，`npm i -g` 安装，不用 corepack | W3 §1 |
| `PNPM_HOME` | `/usr/local/pnpm-global`（unit 和 `dsh-fix-zod` 都写死了这个路径和 `store/v11`） | W2、W3 |
| 网络 | 能访问 `registry.npmjs.org`。源机没有内网源，也没有 `.npmrc` | W3 §4 |
| 其它包 | `nginx`（源机 1.18.0）、`apache2-utils`（用 htpasswd 时）、`python3`、`curl`（safe-restart.sh 要用）、`openssl` | W2、W4 |
| VPN 插件 | 要用 dsh-vpn 就得有 `openfortivpn`（源机是 `/usr/local/bin/openfortivpn`；插件默认按命令名 `openfortivpn` 在 PATH 里找，见 `dsh-vpn/packages/host-vpn/lib/index.js:55`） | W6 复核 |
| 内存 | 源机 2 核 3.5G，`subagent.maxActiveSubagents: 64` 是按这台机器定的 | W1 A.3 |
| 云安全组 | 入方向放行 `8443/tcp`（还有 22）。OS 层没有防火墙 | W2 §2.1 |

### 1.2 必须人工准备的东西（详见 §10）

- 新机的公网 IP 或域名，用于 `--trusted-host` 和 nginx `server_name`。
- 模型 key：`DEEPSEEK_API_KEY`、`KIRO_API_KEY`、`GEMINI_GATEWAY_KEY`。
- nginx basic auth 账号口令，或者直接沿用旧的 `/etc/nginx/.dsh-auth`。
- kiro-relay(7993) 和 gemini-gateway(4000) 的部署材料。
- 要用 VPN 访问内网 git 时，准备 VPN 账号。

### 1.3 旧机打包（先在旧机执行）

```bash
# 旧机：停写后再打包状态（board.json 运行中一直在写【W1 E】）
systemctl stop dsh-web-gate.service dsh-web.service

# A. 代码：排除备份、node_modules、一次性脚本和含明文口令的 deploy/
cd /srv/workspace/deepseek-harness
tar --exclude='*/node_modules' --exclude='*.bak-*' --exclude='*/lib.bak-*' --exclude='*/src.bak-*' \
    --exclude='*/lib.prev' --exclude='dsh-router-b/_backup' --exclude='dsh-router-b/deploy' \
    --exclude='.dsh-artifacts' \
    -czf /root/xfer-code.tgz dsh-router-b dsh-egress dsh-vpn dsh-token-stats
# 只带 deploy 里有用的 3 个件（W4 §2.7）
tar -czf /root/xfer-deploy-min.tgz -C dsh-router-b/deploy nginx-dsh-web.conf dsh-web-gate.mjs E0-install-gate.sh cordis.patch.server.yml

# B. 系统侧件
tar -czf /root/xfer-sys.tgz /usr/local/bin/dsh-fix-zod /usr/local/bin/dsh-web-gate.mjs /usr/local/bin/dsh-web-url \
    /etc/systemd/system/dsh-web.service /etc/systemd/system/dsh-web-gate.service \
    /etc/nginx/sites-available/dsh-web /etc/nginx/tls/dsh.crt /etc/nginx/tls/dsh.key /etc/nginx/.dsh-auth \
    /srv/workspace/bin/screenshot /srv/workspace/bin/gate /srv/workspace/bin/gitea-sync.sh /usr/local/bin/gate

# C. 状态（详见 §8 的取舍）
tar -czf /root/xfer-dsh.tgz -C /root/.dsh \
    profiles/web/package.json profiles/web/cordis.patch.yml profiles/web/cordis.yml profiles/web/pnpm-workspace.yaml \
    sessions storages/session_projcache storages/schedule.json storages/workspace.json \
    router/tiers.json router/board.json router/anchor.json

systemctl start dsh-web.service dsh-web-gate.service
```

预期：生成 4 个 tgz。`xfer-code.tgz` 里不含 `node_modules`，不含 `deploy/`。
校验：`tar -tzf /root/xfer-code.tgz | grep -c node_modules` 应输出 0。

> 注意：`dsh-router-b/deploy/ACCESS.md:15` 和 `deploy/41-verify-public.sh:3` 里有**明文口令**【W4 §2.8】，所以完整的 deploy/ 不要外传。`.credentials.yaml`、`.env`、`vpn/secrets/`、`egress/config.json` 都含密钥，**不打包**，到新机重新录入【W1 D】。

---

## 2. 阶段 1：安装 DSH 本体

```bash
# 1) Node 24.22.3（官方 tarball → /usr/local）【W3 §5】
cd /tmp && curl -fLO https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz
tar -xJf node-v24.22.3-linux-x64.tar.xz -C /usr/local --strip-components=1
node -v                      # 预期 v24.22.3

# 2) pnpm 11.28.13（npm 全局）
npm i -g pnpm@11.28.13
pnpm -v                      # 预期 11.28.13

# 3) DSH 0.2.2-rc.5（pnpm 全局隔离布局）
export PNPM_HOME=/usr/local/pnpm-global PATH=/usr/local/pnpm-global/bin:$PATH
mkdir -p "$PNPM_HOME"
pnpm add -g @deepseek-ai/dsh@0.2.2-rc.5
#   如果因为 rc 版「最小发布时长」被拒：源机 /usr/local/pnpm-global/global/v11/pnpm-workspace.yaml
#   用 minimumReleaseAgeExclude 列出了全部 @deepseek-ai/*@0.2.2-rc.5（W3 §2，待验证是否必需）

# 4) 可执行链接
ln -sf /usr/local/pnpm-global/bin/dsh /usr/local/bin/dsh
dsh --version                # 预期 0.2.2-rc.5
pnpm ls -g --depth 0         # 预期只有 @deepseek-ai/dsh@0.2.2-rc.5
pnpm store path              # 预期 /usr/local/pnpm-global/store/v11（dsh-fix-zod 依赖这个路径）

# 5) 包管理之外的补丁脚本
tar -xzf /root/xfer-sys.tgz -C /      # 还原 dsh-fix-zod、dsh-web-gate.mjs、unit、nginx 件等（阶段 6 再逐个调整）
chmod 0755 /usr/local/bin/dsh-fix-zod /usr/local/bin/dsh-web-gate.mjs
/usr/local/bin/dsh-fix-zod   # 预期输出 "linked …/zod -> …" 或 "zod already linked"
```

失败处理：`dsh-fix-zod` 输出 `dsh-web not found` 或 `no zod in store`，说明 store 路径不是 `store/v11`。这时改脚本里的两处 `find` 路径；如果确认不需要这一步，就删掉 unit 里的 `ExecStartPre` 行【W2 §1.6】。

---

## 3. 阶段 2：放代码

### 3.1 路径决策：**保持 `/srv/workspace/deepseek-harness`**

理由：W5 列出的 P0 路径里，`cordis.patch.yml` 的分区 root、`config.ts` 的提示词、`safe-restart.sh`、`storages/workspace.json`、sessions 的 slug 都以 `/srv/workspace/...` 为前提。路径不变，阶段 4 只需要处理 tsc 和 typeRoots 两处。只有新机器确实不能用 `/srv/workspace` 时才改路径，并且要做完阶段 4 的全部条目。

```bash
mkdir -p /srv/workspace/deepseek-harness
tar -xzf /root/xfer-code.tgz -C /srv/workspace/deepseek-harness
ls /srv/workspace/deepseek-harness
# 预期：dsh-egress  dsh-router-b  dsh-token-stats  dsh-vpn

# 运行产物要在（复制过来即可运行，不必先构建【W3 §3】）
ls /srv/workspace/deepseek-harness/dsh-router-b/packages/host-router/lib/index.js \
   /srv/workspace/deepseek-harness/dsh-router-b/packages/client-ui-router/lib/client.js \
   /srv/workspace/deepseek-harness/dsh-egress/packages/{host,client-ui}-egress/lib/index.js \
   /srv/workspace/deepseek-harness/dsh-vpn/packages/{host,client-ui}-vpn/lib/index.js \
   /srv/workspace/deepseek-harness/dsh-token-stats/packages/host-token-stats/index.js \
   /srv/workspace/deepseek-harness/dsh-token-stats/packages/client-ui-token-stats/lib/index.js
```

### 3.2 `/srv/dsh-*` 跳板软链

按 C3 的裁决，重跑 install.mjs 后 profile 会写入真实路径，跳板已经不是必需。建上它们只是为了兼容：egress/vpn 的 docs 里引用了 `/srv/dsh-*`【W5 B1】，而且你也可能选择直接沿用旧的 profile `package.json`。

```bash
ln -sfn /srv/workspace/deepseek-harness/dsh-router-b /srv/dsh-router-b
ln -sfn /srv/workspace/deepseek-harness/dsh-egress   /srv/dsh-egress
ln -sfn /srv/workspace/deepseek-harness/dsh-vpn      /srv/dsh-vpn
ls -ld /srv/dsh-*            # 预期 3 条 -> /srv/workspace/deepseek-harness/dsh-*
```

dsh-token-stats 在源机上没有跳板，profile 直接指向 `/srv/workspace/deepseek-harness/dsh-token-stats`【W3 §3】。

### 3.3 packages 间 `file:` 依赖要注意

- 根 `dsh-router-b/package.json:33-34` 写的是 `file:./packages/host-router`、`file:./packages/client-ui-router`。这是相对路径，换目录也不受影响。根目录**不是** pnpm workspace【W4 §2.1】。
- **不要**在 bundle 根目录或 profile 目录里跑 `pnpm install`：install.mjs 的注释说，这样做曾把本机的包原地损坏【W1 D、W3 §3】。profile 的 `pnpm-lock.yaml` 也是旧锁，跟 `package.json` 对不上【W3】。
- `host-router` 没有任何 dependencies，也没有 `node_modules`。各插件子包的 `dependencies` 都是空的（W6 复核）。

### 3.4 不必带的目录

`dsh-router-b/deploy/`（89 个文件，含明文口令）、`dsh-router-b/_backup/`、所有 `*.bak-*`、`lib.bak-*`、`src.bak-*`、`lib.prev`、`scripts/rotate-anchor-and-drill.sh`、各个 `node_modules`、`*.tsbuildinfo`、`.dsh-artifacts/`（28M）【W4 §7、W5 P2】。

---

## 4. 阶段 3：注册插件（bundle 机制）

### 4.1 机制（来自 W1 A.2 和 W3 §3，两份一致）

1. `/root/.dsh/profiles/web/package.json`：`dependencies` 里 12 条 `link:`，加上 `dsh.profile.bundles` 的顺序：`@deepseek-ai/dsh-base` → `@deepseek-ai/dsh-web-app` → `dsh-router-b` → `dsh-egress` → `dsh-vpn` → `dsh-token-stats`。
2. `/root/.dsh/profiles/web/node_modules/<名>`：12 个目录软链。
3. 每个 bundle 的 `package.json` 里 `dsh.bundle.patch` 指向它自己的 `cordis.patch.yml`，文件中的 `insert:` 行把插件挂进树：
   - `dsh-router-b/cordis.patch.yml:29-106`：`host-router`（`:30-31`）、`client-ui-router`（`:105-106`）
   - `dsh-egress/cordis.patch.yml:25-33`：`host-egress` / `client-ui-egress`
   - `dsh-vpn/cordis.patch.yml:23-33`：`host-vpn` / `client-ui-vpn`
   - `dsh-token-stats/cordis.patch.yml:18-25`：`host-token-stats` / `client-ui-token-stats`
4. profile 的 `cordis.patch.yml` 只是覆盖层（provider、权限、品牌禁用等），**不插入**本项目插件【W1 A.3】。
5. 组合顺序：bundle 层（按 bundles 顺序）→ profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`（`dsh/src/profile-boot.ts:212-238`【W3】）。

### 4.2 照着敲

```bash
P=/root/.dsh/profiles/web
mkdir -p "$P" && chmod 700 /root/.dsh

# 1) 先放 profile 覆盖层和基础文件（从旧机带来；cordis.yml 的内容就是 []，pnpm-workspace.yaml 是 hoisted 配置）
tar -xzf /root/xfer-dsh.tgz -C /root/.dsh profiles/web/cordis.patch.yml profiles/web/cordis.yml profiles/web/pnpm-workspace.yaml
chmod 600 "$P/cordis.patch.yml"
cat "$P/pnpm-workspace.yaml"   # 预期 packages: [.] / nodeLinker: hoisted / autoInstallPeers: false

# 2) 写一个只含两层官方 bundle 的 package.json，让 4 个 install.mjs 按顺序往后追加
cat > "$P/package.json" <<'EOF'
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
EOF

# 3) 按顺序注册（router → egress → vpn → token-stats；每个脚本都是 push 到 bundles 末尾，所以执行顺序就是最终顺序，见各 install.mjs 的 bundles.push 行）
R=/srv/workspace/deepseek-harness
for s in dsh-router-b dsh-egress dsh-vpn dsh-token-stats; do node "$R/$s/scripts/install.mjs" --profile "$P" --dry-run; done   # 先预览
node $R/dsh-router-b/scripts/install.mjs    --profile "$P" --disable-brand
node $R/dsh-egress/scripts/install.mjs      --profile "$P"
node $R/dsh-vpn/scripts/install.mjs         --profile "$P"
node $R/dsh-token-stats/scripts/install.mjs --profile "$P"
```

参数说明（W6 复核了各脚本的 argv 解析）：

- `--profile <dir>`：四个脚本都需要；`--dry-run`：四个都支持。
- `--disable-brand`：**只有 dsh-router-b 支持**。它往 profile 的 `cordis.patch.yml` 追加 `ui-brand-official disabled: true`；文件里已有这一行时不会重复写。
- `--uninstall`：只有 dsh-vpn 和 dsh-token-stats 支持。
- 脚本不运行包管理器。每次改动会留一份 `package.json.bak-install-<ts>`。如果分区 root 在磁盘上不存在，脚本只打 warning【W4 §2.4】。

校验：

```bash
node -e "const p=require('/root/.dsh/profiles/web/package.json');console.log(Object.keys(p.dependencies).length, p.dsh.profile.bundles.join(','))"
# 预期：12 @deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app,dsh-router-b,dsh-egress,dsh-vpn,dsh-token-stats
ls -la /root/.dsh/profiles/web/node_modules | grep -c -- '->'      # 预期 12
readlink -f /root/.dsh/profiles/web/node_modules/dsh-host-router   # 预期 /srv/workspace/deepseek-harness/dsh-router-b/packages/host-router
grep -n -A2 'ui-brand-official' /root/.dsh/profiles/web/cordis.patch.yml   # 预期有 disabled: true
dsh --profile web --dump-config | grep -n '^# == dsh-'              # 预期 4 段：dsh-router-b / dsh-egress / dsh-vpn / dsh-token-stats
```

不用脚本时的等价手工步骤：拷贝旧机的 `package.json`（12 条 `link:` 原文见 W1 A.1），保留 §3.2 的跳板，再用 `ln -s` 建 12 个链接（W3「2'」段有命令原文）。**不推荐这么做**，因为它依赖跳板，路径一变就失效。

---

## 5. 阶段 4：改硬编码路径

先设两个变量。路径保持不变时 `NEW_WS=/srv/workspace`，下面多数命令就是空操作。

```bash
OLD_WS=/srv/workspace
NEW_WS=/srv/workspace          # ← 新机项目根，按实际改
RB=$NEW_WS/deepseek-harness/dsh-router-b
```

### 5.1 P0-1 分区 root（`dsh-router-b/cordis.patch.yml:40,68,90`）【W1、W4、W5】

原文：`:40 root: /srv/workspace/rca-ab-test`、`:68 root: "/srv/workspace/google tend"`、`:90 root: /srv/workspace/deepseek-harness`。

```bash
cp -a $RB/cordis.patch.yml $RB/cordis.patch.yml.pre-migrate
sed -i \
  -e "40s#root: .*#root: $NEW_WS/rca-ab-test#" \
  -e "68s#root: .*#root: \"$NEW_WS/google tend\"#" \
  -e "90s#root: .*#root: $NEW_WS/deepseek-harness#" \
  $RB/cordis.patch.yml
grep -n 'root:' $RB/cordis.patch.yml     # google tend 必须保留双引号（含空格）
mkdir -p "$NEW_WS/rca-ab-test" "$NEW_WS/google tend"   # 分区目录必须存在；项目代码另行迁入（§10）
```

改完需要重启 DSH，不需要构建（bundle 补丁是源文件直用【W3 §3】）。

### 5.2 P0-2 `safe-build-host.sh:7` 的 tsc【W4 §2.5、W5】

原文：`TSC="${DSH_TSC:-/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc}"`。这个默认值指向另一个项目里的 TypeScript 5.9.3。

做法：装一份独立的 TypeScript 5.9.3 和 @types/node，再把默认值指过去。源机的 @types/node 是 26.6.6【W4】。这一步只在新机器上做，不改源机。

```bash
mkdir -p /opt/dsh-tsc && cd /opt/dsh-tsc && npm init -y >/dev/null && npm i typescript@5.9.3 @types/node@26.6.6
node /opt/dsh-tsc/node_modules/typescript/bin/tsc --version     # 预期 Version 5.9.3（host 要求 >=5.7）
sed -i '7s#.*#TSC="${DSH_TSC:-/opt/dsh-tsc/node_modules/typescript/bin/tsc}"#' $RB/scripts/safe-build-host.sh
sed -n 7p $RB/scripts/safe-build-host.sh
```

不想改脚本的话，每次构建前 `export DSH_TSC=/opt/dsh-tsc/node_modules/typescript/bin/tsc` 也可以。

### 5.3 P0-3 `packages/host-router/tsconfig.json:17` typeRoots【W4 §2.6、W5】

原文：`"typeRoots": ["/usr/local/pnpm-global/store/v11/links/@types/node/26.6.6/2ddc00d884325301077848a310be9f0546dfcebcb72a14c584b55c0b48092c9e/node_modules/@types"]`。新机器的 store hash 一定不同，tsc 会报 TS2688。

```bash
sed -i '17s#"typeRoots": \[[^]]*\]#"typeRoots": ["/opt/dsh-tsc/node_modules/@types"]#' $RB/packages/host-router/tsconfig.json
sed -n 15,18p $RB/packages/host-router/tsconfig.json
```

### 5.4 P0（条件触发）`safe-restart.sh:10` 的 board 路径【W4、W5】

原文 `BOARD=/root/.dsh/router/board.json`。只有不以 root 运行或改了 `DSH_HOME` 时才会出问题。

```bash
sed -i '10s#.*#BOARD="${DSH_HOME:-$HOME/.dsh}/router/board.json"#' $RB/scripts/safe-restart.sh
```

同一个脚本里还写死了 `/var/log/dsh-web.log`（`:29`）、`http://127.0.0.1:42443`（`:30-31`）和服务名 `dsh-web.service`。保持阶段 6 的原名和原端口，就不需要改。

### 5.5 P0（条件触发）端口联动：`dsh-vpn/cordis.patch.yml:28` 的 `localProbePort: 42443`【W1】

只有 DSH 端口改掉时才需要改。端口是一组联动的值，要一起改：unit 的 `--port`、gate 的 `GATE_UPSTREAM_PORT`、`safe-restart.sh:30-31`，还有这一行：

```bash
NEW_PORT=42443
sed -i "28s#localProbePort: .*#localProbePort: $NEW_PORT#" $NEW_WS/deepseek-harness/dsh-vpn/cordis.patch.yml
```

### 5.6 P1（建议）

| 位置 | 原文 | 改法 | 出处 |
|---|---|---|---|
| `dsh-router-b/packages/host-router/src/config.ts:739`（`lib/config.js:511`） | `/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-build-host.sh` | 路径变了才需要改：`sed -i "s#$OLD_WS/deepseek-harness#$NEW_WS/deepseek-harness#" $RB/packages/host-router/src/config.ts`，然后按阶段 5 构建并重启 | W5 |
| `config.ts:744` | `/srv/workspace/bin/screenshot` | 在新机部署同名工具（§7.6），或者按上面的方法替换 | W5 |
| `dsh-router-b/scripts/build.mjs:27` | `SIBLING_TS` → `deepseek-harness-latest/...`（这个目录在源机上就不存在） | 不改也行。用 `DSH_TSC` 指向 5.9.3 时，build.mjs 会挑版本最高的那个 | W4 |
| `packages/host-router/tsconfig.check.json:11` | `../../../deepseek-harness-latest/node_modules/@types` | 在源机上已经失效，不用它就不必改 | W4 |
| `/root/.dsh/storages/workspace.json` | 3 个 `/srv/workspace...` 路径 | 路径变了就在 GUI 里重新添加工作区，不要手改 JSON | W1、W5 |
| `/root/.dsh/storages/schedule.json` | 4 条定时任务的 prompt 里有路径 | 在 GUI 里编辑 | W1、W5 |

---

## 6. 阶段 5：构建

### 6.1 要不要构建

- 代码原样复制、`lib/` 也都在时，**不需要构建**。DSH 启动时直接加载各包的 `lib/`（token-stats 的 host 半是源码 `index.js`）【W3 §3】。新机首次启动属于正常启动，不需要 safe-restart 的 lib 换入流程。
- 改了 bundle 的 `cordis.patch.yml` 或 profile 覆盖层：**只需要重启**。
- 改了 `host-router/src/*.ts`（例如 §5.6 的 config.ts）：**必须构建**。流程是 `safe-build-host.sh` 生成 `lib.next/`，再**由人**执行 `safe-restart.sh` 换入【W4 §2.5】。
- 改了 client 源码：重建 `lib/client.js`。只刷新浏览器是否就够，还是必须重启：**待验证**（W3 未实测）。

### 6.2 命令

```bash
RB=/srv/workspace/deepseek-harness/dsh-router-b
export DSH_TSC=/opt/dsh-tsc/node_modules/typescript/bin/tsc    # 没装 TS 时，先按 §5.2 装 /opt/dsh-tsc

# client 构建工具（tsc 5.6.3 + esbuild 0.24.0；有 package-lock.json）
cd $RB/packages/client-ui-router && npm ci

# host：只生成 lib.next/，不碰正在运行的 lib/
bash $RB/scripts/safe-build-host.sh
# 预期最后两行：safe-build: import ok … safe-build: lib.next ready; run safe-restart.sh to switch to it

# 人工执行（会 stop/start dsh-web.service，失败时自动回滚到 lib.prev）
bash $RB/scripts/safe-restart.sh          # 或 --now
# 预期：safe-restart: router up

# client 浏览器 bundle（可以安全重建）
cd $RB/packages/client-ui-router && node scripts/build-client.mjs

# 全量（client 声明 → client bundle → host tsc -b → host 测试）；DSH_TSC 必须指向 >=5.7 的版本，否则 exit 2【W4】
cd $RB && node scripts/build.mjs

# token-stats：按 $DSH_CLIENT_MODULES → 自身 client node_modules → dsh-vpn/packages/client-ui-vpn/node_modules → dsh-router-b/packages/client-ui-router/node_modules 顺序找 esbuild（W6 复核 build.mjs:41-46）
node /srv/workspace/deepseek-harness/dsh-token-stats/scripts/build.mjs
```

---

## 7. 阶段 6：系统侧

### 7.1 `dsh-web.service`【W2 §1.5/5.1】

从旧机还原后，**只改 `--trusted-host`**，改成新机浏览器地址栏里的 `host:port`，并且必须和 nginx `server_name` 一致。

```bash
NEW_HOST=<新公网IP或域名>
sed -i "s#--trusted-host [^ ]*#--trusted-host $NEW_HOST:8443#" /etc/systemd/system/dsh-web.service
grep -E 'ExecStart|User|Environment|StandardOutput' /etc/systemd/system/dsh-web.service
```

要点：`User=root`；`Environment=PNPM_HOME=/usr/local/pnpm-global`；`Environment=PATH=/usr/local/pnpm-global/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin`；`ExecStartPre=/usr/local/bin/dsh-fix-zod`；`ExecStart=/usr/local/pnpm-global/bin/dsh --profile web --no-open --host 127.0.0.1 --port 42443 --trusted-host <host>:8443`；`Restart=on-failure`、`RestartSec=5`；stdout 和 stderr 都写 `append:/var/log/dsh-web.log`；没有 drop-in。

### 7.2 `dsh-web-gate.service` + `/usr/local/bin/dsh-web-gate.mjs`【W2 §1.3/5.2】

这个 unit 不能省。DSH 每次重启都会换 launch token，gate 从 `/var/log/dsh-web.log` 的尾部读出新 token，替浏览器补上。脚本只用 node 内置模块，零依赖，直接复制就行。环境变量：`GATE_PORT=42444`、`GATE_UPSTREAM_HOST=127.0.0.1`、`GATE_UPSTREAM_PORT=42443`、`GATE_TOKEN_LOG=/var/log/dsh-web.log`；`Restart=always/3`。

```bash
touch /var/log/dsh-web.log
systemctl daemon-reload
systemctl enable --now dsh-web.service dsh-web-gate.service
systemctl is-active dsh-web.service dsh-web-gate.service      # 预期 active active
ss -ltnp | grep -E '4244[34]'                                  # 预期两行，都只监听 127.0.0.1
```

### 7.3 nginx 站点 + TLS + basic auth【W2 §3、§5.3】

```bash
apt-get install -y nginx apache2-utils
sed -i "s#server_name .*;#server_name $NEW_HOST;#" /etc/nginx/sites-available/dsh-web
ln -sfn /etc/nginx/sites-available/dsh-web /etc/nginx/sites-enabled/dsh-web
rm -f /etc/nginx/sites-enabled/default        # 源机只启用了 dsh-web（W2 §3.1）

# 证书：可以复用旧的自签证书；IP 或域名变了就重签（W2 §5.3）
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout /etc/nginx/tls/dsh.key -out /etc/nginx/tls/dsh.crt -subj "/CN=$NEW_HOST"
chmod 600 /etc/nginx/tls/dsh.key; chmod 644 /etc/nginx/tls/dsh.crt

# basic auth：沿用旧文件，或者重建（htpasswd -c /etc/nginx/.dsh-auth <用户名>）
chown root:www-data /etc/nginx/.dsh-auth && chmod 640 /etc/nginx/.dsh-auth   # 权限不对，全站 500

/usr/sbin/nginx -t && systemctl reload nginx
```

站点要点：`listen 8443 ssl`；`location /` 用 `auth_basic`，`proxy_pass http://127.0.0.1:42444`（是 gate，**不是** 42443）；`proxy_http_version 1.1`，带 Upgrade/Connection 头；`proxy_buffering off`；`proxy_read_timeout 3600s`；`client_max_body_size 512m`；`error_page 497 =301 https://…`；另有两个子路径 `/llm/kiro/` → 7993 和 `/llm/gemini/` → 4000，不迁这两个中继就删掉这两个 location。

### 7.4 端口与安全组

| 端口 | 绑定 | 用途 | 对外 |
|---|---|---|---|
| 8443 | 0.0.0.0 | nginx，唯一的对外入口 | **云安全组放行 8443/tcp**（人工操作） |
| 42444 | 127.0.0.1 | gate | 否 |
| 42443 | 127.0.0.1 | DSH | 否 |
| 7993 / 4000 | 127.0.0.1 | kiro-relay / gemini-gateway（litellm） | 否 |
| 17890 / 17892 / 19092 | 127.0.0.1 | mihomo-egress（非必需） | 否 |

出处：W2 §2。源机 OS 层没有防火墙（ufw、firewalld 都没装，iptables 没有规则），新机保持这个状态即可。

### 7.5 logrotate（源机缺这一条，建议补）【W2 §4.3/5.4】

```bash
cat > /etc/logrotate.d/dsh-web <<'EOF'
/var/log/dsh-web.log {
    daily
    rotate 7
    missingok
    notifempty
    copytruncate
    compress
}
EOF
logrotate -d /etc/logrotate.d/dsh-web
```

必须用 `copytruncate`：systemd 的 `append:` 一直持有文件 fd。gate 只读日志尾部 64KB，截断后要等 DSH 下次启动写出新 token 才能恢复，日常使用不受影响（这一点是推断，**待验证**）。

### 7.6 辅助工具

`/srv/workspace/bin/screenshot`（121 B 的包装脚本，依赖 `~/.cache/ms-playwright` 里的 chromium-1255）。需要时建链接：`ln -s /srv/workspace/bin/screenshot /usr/local/bin/screenshot`，再装同版本 playwright 浏览器【W3 §4】。两个 `gate` 是同名但不同的脚本：`/usr/local/bin/gate` 在 PATH 上，`/srv/workspace/bin/gate` 是云端版，不在 PATH 上【W3 §1】。

---

## 8. 阶段 7：数据迁移（/root/.dsh）

| 路径 | 结论 | 出处 |
|---|---|---|
| `profiles/web/{cordis.patch.yml,cordis.yml,pnpm-workspace.yaml}` | **带**（阶段 3 已放好） | W1 |
| `profiles/web/package.json`、`node_modules/` | **不带**，由 install.mjs 重新生成 | W1、W3、W5 |
| `profiles/web/*.bak-*`、`.plugin-manager/`、`pnpm-lock.yaml`、`profiles/web.bak-*`、`profiles/headless/` | 不带（headless 与 web 服务无关） | W1 |
| `sessions/`（23M，164 个会话） | 要保留历史和 Token 面板的数据就**带** | W1、W5 |
| `storages/session_projcache/`（2.5M） | **带**（见 C6） | W5 |
| `storages/schedule.json` | 可选（与会话 id 绑定）；带上后在 GUI 里检查 prompt 里的路径 | W1 |
| `storages/workspace.json` | 路径不变就带，路径变了就在 GUI 里重新添加 | W1、W5 |
| `router/tiers.json` | **带**（不带会按新机的模型列表重新计算三档） | W1 C |
| `router/board.json` | 可选（停服后再拷）；缺失时会自动生成空板 | W1 C |
| `router/anchor.json` | 可选，**必须和 sessions 一起带** | W1 C |
| `router/snapshot.json`、`seams.json`、`board.json.tmp-*`、`*.prev-*`、`*.bak-*` | 不带 | W1 C、W5 |
| `egress/config.json` | 不带，在 Egress 面板重新添加（含代理口令）。源机实际生效的是 `bindings api.commandcode.ai → direct`、`defaultExit direct` | W1 B |
| `vpn/profiles.json`、`vpn/secrets/`、`vpn/run-*.conf` | 不带，在 VPN 面板重新添加 | W1 B |
| `.credentials.yaml`、`.env` | **不拷，重新录入**（§10） | W1 |
| `.anonymous-user-id`、`attachments/`（14M）、`cache/` | 不带 | W1 |

```bash
systemctl stop dsh-web-gate.service dsh-web.service
tar -xzf /root/xfer-dsh.tgz -C /root/.dsh sessions storages router
chmod 700 /root/.dsh /root/.dsh/sessions /root/.dsh/storages
ls /root/.dsh/router      # 预期只有 tiers.json board.json anchor.json
systemctl start dsh-web.service dsh-web-gate.service
```

board.json 里的旧路径：只有路径改了才有影响，而且只影响历史记录。启动时 `reconcile()` 会把旧的 running/dispatched 行改成 `interrupted` 或 `queued`（`src/board.ts:365-383`）。旧任务能否 resume 取决于 sessions 和 cwd 是否还存在【W1 C、W5 B3】。`partitions` 里 `front`、`agent` 两个是旧配置残留，会一直留在历史里【W1】。

---

## 9. 阶段 8：验收清单

```bash
# 1) 服务和端口
systemctl is-active dsh-web.service dsh-web-gate.service nginx
ss -ltnp | grep -E ':(8443|42443|42444) '

# 2) 入口链（预期依次是 401 / 302 / 401）【W2 §2.1】
curl -k -s -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8443/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:42444/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:42443/
curl -k -s -o /dev/null -w '%{http_code}\n' -u '<用户>:<口令>' https://127.0.0.1:8443/   # 预期 302 或 200

# 3) 插件组合
dsh --profile web --dump-config | grep -n '^# == dsh-'                  # 4 段
dsh --profile web --dump-config | grep -n -A3 'id: host-router'         # manager: true / maxWorkers: 0
cat /root/.dsh/router/seams.json                                          # "ok": true，tools/subagents 都为 true

# 4) API（用 safe-restart.sh 的同款方法取 token 和 cookie）
T=$(grep -o 'token=[A-Za-z0-9_-]*' /var/log/dsh-web.log | tail -1 | cut -d= -f2)
J=$(mktemp); curl -s -o /dev/null -c "$J" -b "$J" -L "http://127.0.0.1:42443/?token=$T"
for u in /api/router/board /api/router/tiers /api/token-stats/summary; do
  printf '%s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' -b "$J" "http://127.0.0.1:42443$u"; done   # 都应为 200
curl -s -b "$J" http://127.0.0.1:42443/api/token-stats/summary | head -c 400      # 带了 sessions 时 sessionFiles 应约为 164
rm -f "$J"

# 5) 日志
tail -n 50 /var/log/dsh-web.log | grep -iE 'error|cannot|single slot' || echo "no errors"
```

GUI 人工核对（浏览器打开 `https://<新host>:8443`）：

- [ ] 通过 basic auth 后直接进入界面，不需要 token。重启一次 DSH 之后，旧书签仍能打开（说明 gate 生效）。
- [ ] 侧栏品牌显示的是作战室，不是官方品牌（`ui-brand-official` 已禁用）。
- [ ] Router 面板列出 3 个分区，任务板有行（带了 board.json 时）；档位面板显示三档：easy/medium = commandecode `deepseek/deepseek-v4.1-flash`，hard = kiro `kiro/claude-opus-5.5`【W1 C】。
- [ ] Egress、VPN、Token 三个面板都存在。Token 面板有数字（带了 sessions 时）；没带 sessions 时显示空态「暂无用量数据」，这不算失败【W5 A4】。
- [ ] 插件管理器里 host-router、client-ui-router、host-egress、client-ui-egress、host-vpn、client-ui-vpn、host-token-stats、client-ui-token-stats 都是 enabled、active【W1 A.2】。
- [ ] 新建一个会话，commandecode、kiro、gemini 三个 provider 都能完成一次对话。

---

## 10. 必须人工做、无法脚本化的事项

| 事项 | 要做什么 | 出处 |
|---|---|---|
| 模型 provider key | 字段名：`DEEPSEEK_API_KEY`（commandecode 的 `apiKeyEnv`，旧机存在 `.credentials.yaml` 的 `refs` 下，在 Web UI 设置里重新录入）；`KIRO_API_KEY`、`GEMINI_GATEWAY_KEY`（写进 `/root/.dsh/.env`，权限 600，`install -m 600 /dev/null /root/.dsh/.env` 后手工填写）。浏览器会话 grant 会自动重新生成 | W1 B.1/B.2 |
| commandcode 上游是否接受新机 IP | `https://api.commandcode.ai/provider/v1` 对新机 IP 是否开放：**未确认**。需要上线后实际发请求验证，或联系上游 | W1 E |
| kiro-relay(7993) | `/etc/systemd/system/kiro-relay.service`、`/opt/llm/kiro-relay/kiro_relay.py`、`/etc/llm/kiro.key`、`/etc/llm/kiro-relay.env`。解释器是 uv 装的 `/root/.local/share/uv/python/cpython-3.12.16-linux-x86_64-gnu/bin/python3.12`，启动参数里有 `--proxy ${KIRO_RELAY_PROXY}`。部署和依赖安装方法：**未确认**（不在任何报告范围内） | W2 §4.5 |
| gemini-gateway(4000) | `/etc/systemd/system/gemini-gateway.service`、`/opt/llm/gemini-gateway/{venv,config.yaml}`、`/etc/llm/gemini.env`，用 litellm。venv 怎么重建：**未确认** | W2 §4.5 |
| key 配对 | DSH 侧的 `KIRO_API_KEY`、`GEMINI_GATEWAY_KEY` 必须和中继侧的 `/etc/llm/*` 一致（见 C7）。中继是否校验 key：**未确认** | W1 E、W2 |
| VPN / 内网 git | 在 VPN 面板重新添加 `git` profile（type password）并输入密码；确认 `openfortivpn` 已安装。`rca-ab-test` 与公司 gitea 同步依赖 VPN 和 deploy key（`deploy/GITEA-SYNC.md`、`/srv/workspace/bin/gitea-sync.sh`） | W1、W4、W6 复核 |
| 出口代理 | 需要代理时，在 Egress 面板重新添加出口；源机的 `sg-mihomo` 对应 `/usr/local/bin/mihomo-egress` 和 `/etc/mihomo-egress/config.yaml`（mihomo-egress.service）。源机实际用的是 direct | W1、W2、W6 复核 |
| 云安全组 | 新云控制台入方向放行 `8443/tcp`。公网 IP 是 EIP 还是 NAT：**未确认** | W2 §2.1/§7 |
| nginx 证书 | 自签证书可以复用或重签；换成正式证书需要域名，属于人工决策 | W2 |
| basic auth 账号 | 沿用旧的 `/etc/nginx/.dsh-auth`，或者用 htpasswd 新建。旧口令在 `deploy/ACCESS.md` 里是明文，建议换掉 | W2、W4 |
| 信任主机 / 域名 | 定下新的 `host:8443`，同时改 unit 的 `--trusted-host` 和 nginx 的 `server_name` | W2 §4.1 |
| 分区目录 | 三个分区目录 `rca-ab-test`、`google tend`（**含空格**）、`deepseek-harness` 在新机上是否沿用这三个名字，要人工决定；`rca-ab-test` 和 `google tend` 的项目代码需要另外迁入 | W1、W5 |
| 子代理上限 | 按新机内存重新确定 `subagent.maxActiveSubagents`（源机 64，2 核 3.5G） | W1 A.3 |
| DSH 账号 | 源机启用了 `llm-deepseek-account` 插件，账号登录状态是否需要重新登录：**未确认** | W1 B.2 |

---

## 11. 换机必炸清单（按 P0 排序）

P0 表示不处理就起不来，或者核心功能消失。共 **12 条**，其中第 10–12 条只在特定条件下触发。

| # | 症状（一句话） | 位置 / 路径原文 | 修法 | 出处 |
|---|---|---|---|---|
| 1 | Router、Egress、VPN、Token 面板全部消失，日志报 `cannot resolve profile bundle` | `/root/.dsh/profiles/web/package.json:5-16` 的 `link:/srv/dsh-router-b`、`/srv/dsh-egress`、`/srv/dsh-vpn`、`/srv/workspace/deepseek-harness/dsh-token-stats`，以及 `profiles/web/node_modules` 的 12 个软链 | §4.2：按顺序重跑 4 个 install.mjs；兼容旧写法就建 `/srv/dsh-*` 跳板 | W1、W3、W5 |
| 2 | `client-ui-router` 注册报 `single slot ... already has a registration`，作战室品牌和面板起不来 | profile `cordis.patch.yml:159-161` 的 `ui-brand-official disabled: true` 丢失 | 运行 `install.mjs --disable-brand`，或者带上旧的覆盖层 | W1 A.3 |
| 3 | dsh-web.service 起不来，ExecStartPre 返回 exit 1（`dsh-web not found` 或 `no zod in store`） | `/usr/local/bin/dsh-fix-zod` 写死了 `/usr/local/pnpm-global/store/v11/links/@deepseek-ai/dsh-web` 和 `/usr/local/pnpm-global/store/v11/links/@/zod` | 保持 `PNPM_HOME=/usr/local/pnpm-global` 和 pnpm 11；store 路径不同就改脚本，或删掉 ExecStartPre | W2 §1.6 |
| 4 | 浏览器能过 basic auth，但 DSH 拒绝请求（Host 校验） | unit 里的 `--trusted-host 192.0.2.10:8443`，nginx 里的 `server_name 192.0.2.10;` | §7.1、§7.3 一起改成新的 host | W2 §4.1/5.1 |
| 5 | 外网完全打不开 8443 | 云安全组 | 控制台放行 `8443/tcp` | W2 §2.1 |
| 6 | 全站 500 | `/etc/nginx/.dsh-auth` 权限不是 `root:www-data 640` | 执行 `chown root:www-data` 和 `chmod 640` | W2 §3.2 |
| 7 | 每次重启 DSH 后书签失效，要求输入 token | 没装 `dsh-web-gate.service` 或 `/usr/local/bin/dsh-web-gate.mjs`，或者 nginx 直接反代到 42443 | §7.2；nginx 的 `proxy_pass` 指向 `http://127.0.0.1:42444` | W2 §1.3 |
| 8 | 分区按文件路由失败，worker 的 cwd 不存在 | `dsh-router-b/cordis.patch.yml:40` `/srv/workspace/rca-ab-test`、`:68` `"/srv/workspace/google tend"`、`:90` `/srv/workspace/deepseek-harness` | §5.1：sed 替换并 mkdir；`google tend` 保留引号 | W1、W4、W5 |
| 9 | 模型调用失败：commandecode 没有 key，kiro/gemini 两个 provider 没有 key 或连不上，hard 档（kiro opus）的任务全失败 | `.credentials.yaml` 的 `DEEPSEEK_API_KEY`，`/root/.dsh/.env` 的 `KIRO_API_KEY`、`GEMINI_GATEWAY_KEY`，`http://127.0.0.1:7993/v1`，`http://127.0.0.1:4000/v1` | §10：重新录入 key，部署两个中继 | W1、W2 |
| 10 | 需要构建 host-router 时 `Cannot find module '/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc'` | `dsh-router-b/scripts/safe-build-host.sh:7` | §5.2：装 `/opt/dsh-tsc`（typescript 5.9.3），改默认值或设 `DSH_TSC` | W4、W5 |
| 11 | 构建报 `TS2688: Cannot find type definition file for 'node'` | `dsh-router-b/packages/host-router/tsconfig.json:17` 的 `/usr/local/pnpm-global/store/v11/links/@types/node/26.6.6/2ddc00d884325301077848a310be9f0546dfcebcb72a14c584b55c0b48092c9e/node_modules/@types` | §5.3：改成 `/opt/dsh-tsc/node_modules/@types` | W4、W5 |
| 12 | 不以 root 运行或改了 `DSH_HOME` 时 safe-restart.sh 中止；DSH 改了端口后 VPN 看门狗误判 | `dsh-router-b/scripts/safe-restart.sh:10` 的 `/root/.dsh/router/board.json`；`dsh-vpn/cordis.patch.yml:28` 的 `localProbePort: 42443` | §5.4、§5.5 | W1、W4、W5 |

P1（不会导致起不来，但行为不对）：`host-router/src/config.ts:739` 写进 worker 提示词的 `/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-build-host.sh`；`config.ts:744` 的 `/srv/workspace/bin/screenshot`；`storages/workspace.json` 的 `/srv/workspace/rca-ab-test`、`/srv/workspace`、`/srv/workspace/google tend`；`schedule.json` prompt 里的路径；没带 `tiers.json` 时三档模型会被重新计算；`/var/log/dsh-web.log` 没有 logrotate【W1、W2、W5】。

---

## 12. 待验证 / 未确认汇总

1. 新机安装 rc 版是否必须配置 `minimumReleaseAgeExclude`：**待验证**【W3】。
2. 新机上是否还需要 `dsh-fix-zod` 补的 zod 链接：**待验证**【W2】。
3. `session_projcache` 删掉后能否重建：**待验证**（C6）。
4. client `lib/client.js` 重建后，只刷新浏览器是否就够：**待验证**【W3】。
5. 旧机 profile `link:` 为什么写成 `/srv/...`：**未确认**（C3；手工改写只是推测）。
6. commandcode 上游是否接受新机 IP：**未确认**【W1】。
7. kiro-relay 和 gemini-gateway 怎么部署，是否校验 key：**未确认**【W1、W2】。
8. 公网 IP 是 EIP 还是 NAT，安全组现状如何：**未确认**【W2】。
9. 旧会话的 slug 和新路径对不上时，DSH 会话列表能否挂上：**未确认**【W5】；Token 面板不受影响。
10. `workspace.json` 里的路径失效时具体有什么症状：**未确认**【W5】。
11. `dsh-web-gate.mjs` 依赖 DSH 日志格式，DSH 升级后是否会失效：**未确认**【W2】。
12. logrotate 的 `copytruncate` 和 gate 读 token 之间是否有交互问题：**待验证**（W6 推断）。
13. 账号类 provider `llm-deepseek-account` 是否需要重新登录：**未确认**。
14. W4 推演的构建失败信息（TS5023、TS2688、build.mjs 退出码 2）都没有实际运行过：**待验证**【W4 §8】。

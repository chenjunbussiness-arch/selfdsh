# MANIFEST — 发布内容 / 来源 / 路径映射

生成时间：2026-11-21（任务 t20261121121422-376）。本文件回答四件事：

1. `profile/package.json` 里的每个依赖从哪来、进没进仓库；
2. 每个包的入口文件、构建方式、改完要不要重启；
3. 插件源码/配置里硬编码的本机绝对路径，换机时改成什么；
4. 哪些东西被排除、排除的证据。

仓库根：`/srv/workspace/dsh-warroom`，分支 `main`。数据来源：`/root/.dsh/profiles/web/package.json`、
`readlink -f`、各包 `package.json`、`find`/`grep` 实测。**本文件不含任何密钥、口令或证书内容。**

---

## 1. profile `dependencies` 逐项对照（14 条）

源：`/root/.dsh/profiles/web/package.json`（2026-11-21 02:05，`dsh-secrets` 已加入）。
"真实来源"列是 `readlink -f /srv/dsh-*` + 直接路径实测的结果，四个仓都在
`/srv/workspace/deepseek-harness/` 下，`/srv/dsh-{router-b,egress,vpn}` 只是指向它们的软链。

| # | 包名 | 类型 | 进仓库 | 仓库内路径 | 真实来源路径 |
|---|---|---|---|---|---|
| 1 | `dsh-router-b` | 自研 bundle | 是 | `plugins/dsh-router-b/` | `/srv/dsh-router-b` → `/srv/workspace/deepseek-harness/dsh-router-b` |
| 2 | `dsh-host-router` | 自研 host 子包 | 是 | `plugins/dsh-router-b/packages/host-router/` | 同上 `/packages/host-router` |
| 3 | `dsh-client-ui-router` | 自研 client 子包 | 是 | `plugins/dsh-router-b/packages/client-ui-router/` | 同上 `/packages/client-ui-router` |
| 4 | `dsh-egress` | 自研 bundle | 是 | `plugins/dsh-egress/` | `/srv/dsh-egress` → `/srv/workspace/deepseek-harness/dsh-egress` |
| 5 | `dsh-host-egress` | 自研 host 子包 | 是 | `plugins/dsh-egress/packages/host-egress/` | 同上 `/packages/host-egress` |
| 6 | `dsh-client-ui-egress` | 自研 client 子包 | 是 | `plugins/dsh-egress/packages/client-ui-egress/` | 同上 `/packages/client-ui-egress` |
| 7 | `dsh-vpn` | 自研 bundle | 是 | `plugins/dsh-vpn/` | `/srv/dsh-vpn` → `/srv/workspace/deepseek-harness/dsh-vpn` |
| 8 | `dsh-host-vpn` | 自研 host 子包 | 是 | `plugins/dsh-vpn/packages/host-vpn/` | 同上 `/packages/host-vpn` |
| 9 | `dsh-client-ui-vpn` | 自研 client 子包 | 是 | `plugins/dsh-vpn/packages/client-ui-vpn/` | 同上 `/packages/client-ui-vpn` |
| 10 | `dsh-token-stats` | 自研 bundle（独立顶层目录，不在 router-b 下） | 是 | `plugins/dsh-token-stats/` | `/srv/workspace/deepseek-harness/dsh-token-stats` |
| 11 | `dsh-host-token-stats` | 自研 host 子包 | 是 | `plugins/dsh-token-stats/packages/host-token-stats/` | 同上 `/packages/host-token-stats` |
| 12 | `dsh-client-ui-token-stats` | 自研 client 子包 | 是 | `plugins/dsh-token-stats/packages/client-ui-token-stats/` | 同上 `/packages/client-ui-token-stats` |
| 13 | `dsh-secrets` | 自研 bundle（2026-11-21 新增） | 是 | `plugins/dsh-secrets/` | `/srv/workspace/deepseek-harness/dsh-secrets` |
| 14 | `dsh-host-secrets` | 自研 host 子包 | 是 | `plugins/dsh-secrets/packages/host-secrets/` | 同上 `/packages/host-secrets` |

**结论：14 条依赖全部是自研包，全部成套入仓（源码 + 构建产物 `lib/`），一条不漏，且没有 `node_modules`。**
`/root/.dsh/profiles/web/node_modules/` 下这 14 个名字都是软链，逐条 `ls -l` 核对过目标与上表一致。

## 2. bundle 加载顺序（`dsh.profile.bundles`，7 项）

| # | 名称 | 类型 | 进仓库 | 说明 / 版本 |
|---|---|---|---|---|
| 1 | `@deepseek-ai/dsh-base` | 官方 npm 包 | 否 | `0.2.2-rc.5`（pnpm store：`/usr/local/pnpm-global/store/v11/links/@deepseek-ai/dsh-base/0.2.2-rc.5`） |
| 2 | `@deepseek-ai/dsh-web-app` | 官方 npm 包 | 否 | `0.2.2-rc.5`（同上 `dsh-web-app/0.2.2-rc.5`） |
| 3 | `dsh-router-b` | 自研 | 是 | `plugins/dsh-router-b/` |
| 4 | `dsh-egress` | 自研 | 是 | `plugins/dsh-egress/` |
| 5 | `dsh-vpn` | 自研 | 是 | `plugins/dsh-vpn/` |
| 6 | `dsh-token-stats` | 自研 | 是 | `plugins/dsh-token-stats/` |
| 7 | `dsh-secrets` | 自研 | 是 | `plugins/dsh-secrets/`（本轮新增，必须在 token-stats 之后） |

DSH 本体版本：`dsh --version` → `0.2.2-rc.5`（`/usr/local/pnpm-global/bin/dsh`）。

## 3. 入口、构建与生效方式

| 包 | 入口（`main` / `exports`） | 源码 | 构建 | 生效方式 |
|---|---|---|---|---|
| `dsh-router-b` | `index.js`（bundle 壳，只有 `cordis.patch.yml` 指针） | `index.js`、`cordis.patch.yml` | 无 | 重启 DSH |
| `dsh-host-router` | `lib/index.js` + `lib/index.d.ts` | `src/*.ts` | `safe-build-host.sh`（写 `lib.next/`）或 `node scripts/build.mjs`（完整构建，写 `lib/`） | **必须** `safe-restart.sh` 重启后换入 |
| `dsh-client-ui-router` | `./client` → `lib/client.js`；`main` → `lib/index.js` | `src/client/*.tsx` | `node packages/client-ui-router/scripts/build-client.mjs`（或 `scripts/build.mjs`，esbuild） | 重建后刷新浏览器；host 侧无需重启 |
| `dsh-host-egress` | `lib/index.js` | `src/*.ts` | `node scripts/build.mjs`（tsc） | 重启 DSH |
| `dsh-client-ui-egress` | `./client` → `lib/client.js` | `src/client/*.tsx` | `scripts/build.mjs` / `build-client.mjs` | 刷新浏览器 |
| `dsh-host-vpn` | `lib/index.js` | `src/*.ts` | `node scripts/build.mjs` | 重启 DSH |
| `dsh-client-ui-vpn` | `./client` → `lib/client.js` | `src/client/*.tsx` | `scripts/build.mjs` / `build-client.mjs` | 刷新浏览器 |
| `dsh-host-token-stats` | `index.js`、`./scanner`、`./bridge`（纯 ESM JS） | 同 `index.js`（无 src、无构建） | `node --check` 语法检查（`scripts/build.mjs`） | 重启 DSH |
| `dsh-client-ui-token-stats` | `./client` → `lib/client.js` | `src/client/*.tsx` | `node scripts/build.mjs`（esbuild） | 刷新浏览器 |
| `dsh-host-secrets` | `index.js`，另有 `./vault` `./redact` `./placeholders`（纯 ESM JS） | 同 `index.js`（无构建、无 client 包） | 无（`node --test` 直接跑测试） | 注册 bundle 后重启 DSH |
| `dsh-secrets` | `index.js`（bundle 壳）+ `cordis.patch.yml`（insert `host-secrets`） | 同左 | 无 | `node scripts/install.mjs --profile <P>` 后重启 |

顶层 `scripts/`（`browser`、`browser.py`）不在上面任何插件包里，也不在 `/srv/workspace/deepseek-harness` 源码树里：
它们来自 `/srv/workspace/bin/`，是浏览器 lane 的运维工具（CDP + Playwright + Xvfb/x11vnc/websockify/noVNC 每任务隔离），
**不是插件运行依赖**。依赖 `/opt/shot/venv`（Python + Playwright）与本机 Chromium；换机要改下面的路径与 shebang。

要点：

- **profile 是源码直挂**：`link:` 指向 checkout，host 侧真正被 require 的是 `lib/`（`main=lib/index.js`），
  所以 `lib/` 必须入库（本仓库按惯例带 `lib/`，不带 `node_modules`）。
- **client 包**是 `./client` → `lib/client.js`，由 esbuild 打进 DSH 的模块装载器信封，
  必须由 `build-client.mjs` / `build.mjs` 生成，不能手写。
- **host 侧**在运行机上只能用 `safe-build-host.sh`（写 `lib.next/`，不碰 `lib/`），
  再由人工 `safe-restart.sh` 在停机时换入；直接改 `lib/` 会让运行中的插件被卸载。
- `dsh-secrets` 的运行时文件（`$DSH_HOME/secrets.vault`、`secrets.key`、passphrase）由插件首次使用时生成，
  **不在仓库里**（见第 6 节）。

## 4. 硬编码本机路径映射表（换机要改）

`grep -rn '/srv/workspace/deepseek-harness|/root/\.dsh|/srv/dsh-'` 在**代码与配置**（`.ts/.js/.mjs/.json/.yml/.sh`）
里的全部命中如下。文档（`docs/*.md`、各插件 `docs/`）里的路径是说明性文字，按同一规则改即可，不逐条列。

| 文件:行 | 原值 | 新机应改成 |
|---|---|---|
| `plugins/dsh-router-b/cordis.patch.yml:90` | `root: /srv/workspace/deepseek-harness` | 新机 checkout 根（分区 root），如 `<WORKSPACE>/deepseek-harness` |
| `plugins/dsh-router-b/packages/host-router/src/config.ts:739` | 提示词里的 `/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-build-host.sh` | `<REPO>/plugins/dsh-router-b/scripts/safe-build-host.sh`（改 src 后重新构建） |
| `plugins/dsh-router-b/packages/host-router/lib/config.js:511` | 同上（`src` 的编译产物） | 随 `src` 重建自动更新，不要手改 `lib/` |
| `plugins/dsh-router-b/scripts/safe-build-host.sh:7` | `TSC="${DSH_TSC:-/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc}"` | 新机 TypeScript 的 `tsc` 绝对路径；或用 `DSH_TSC` 覆盖 |
| `plugins/dsh-router-b/packages/host-router/tsconfig.json:17` | `typeRoots: ["/usr/local/pnpm-global/store/v11/links/@types/node/26.6.6/<hash>/node_modules/@types"]` | 新机 `@types/node` 所在目录（装 `@types/node` 后指向它） |
| `plugins/dsh-router-b/scripts/safe-restart.sh:10` | `BOARD=/root/.dsh/router/board.json` | `BOARD="${DSH_HOME:-$HOME/.dsh}/router/board.json"` |
| `plugins/dsh-token-stats/packages/host-token-stats/scanner.js:6` | 注释里的 `/root/.dsh/sessions/...` | 只是注释；运行时已按 `DSH_HOME` 解析，可不改 |
| `plugins/dsh-secrets/scripts/install.mjs:18-19` | 用法示例 `/root/.dsh/profiles/web` | `<DSH_HOME>/profiles/<profile>` |
| `plugins/dsh-vpn/scripts/install.mjs:16-17` | 同上 | 同上 |
| `plugins/dsh-token-stats/scripts/install.mjs:18-19` | 同上 | 同上 |
| `plugins/dsh-secrets/scripts/ingest-file.selftest.mjs:26` | `REAL_VAULT = '/root/.dsh/secrets.vault'` | **保留**：测试用它断言"真实 vault 未被改动"，只读比较 |
| `plugins/dsh-router-b/packages/host-router/tests/tier.test.mjs:15` | 样例 prompt 里的 `/srv/workspace/deepseek-harness/dsh-vpn` | 纯字符串样例，不影响运行，可留 |
| `plugins/dsh-vpn/packages/host-vpn/tests/vpn.test.mjs:441` | fixture 返回值 `/root/.dsh/vpn/run-1.conf` | 纯 mock 字符串，可留 |
| `profile/package.json:5-18` | 14 条 `link:/srv/...`（`/srv/dsh-router-b`、`/srv/dsh-egress`、`/srv/dsh-vpn`、`/srv/workspace/deepseek-harness/dsh-token-stats`、`.../dsh-secrets`） | 不手改：在新机对每个 bundle 跑 `scripts/install.mjs --profile <P>`，会重写成 `<REPO>/plugins/dsh-*` |
| `profile/cordis.patch.yml:249,258` | `/srv/workspace/deepseek-harness/vendor/exa-mcp-server{/dist/stdio.cjs}` | `<REPO>/vendor/exa-mcp-server/dist/stdio.cjs` |
| `scripts/browser:11` | `exec /opt/shot/venv/bin/python /srv/workspace/bin/browser.py "$@"` | `exec <VENV>/bin/python <REPO>/scripts/browser.py "$@"` |
| `scripts/browser.py:1` | shebang `#!/opt/shot/venv/bin/python` | 新机 venv 的 python（或用 `#!/usr/bin/env python3` + 已装 playwright） |
| `scripts/browser.py:33` | `LANE_ROOT = "/srv/browser/lanes"` | 新机 lane 根目录（需可写） |
| `scripts/browser.py:34` | `LANES_LOCK = "/run/browser-lanes.lock"` | 新机可写的锁目录（默认 `/run` 即可，需 root 或调整） |
| `scripts/browser.py:42` | `"/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"` | 新机 Playwright Chromium 路径 |

补充：`plugins/dsh-router-b/docs/REQUIREMENTS-v2.md:147,215` 与 `docs/` 下的历史审计文档（W1–W6）里也有源机路径，
它们描述的是 2026-11-20 的源机状态，按 `docs/README-MIGRATE.md` §0 的口径理解即可。

## 5. 第三方 / vendor

| 目录 | 包 | 版本 | 许可 | 文件数 / 体积 | 进仓库 | 说明 |
|---|---|---|---|---|---|---|
| `vendor/exa-mcp-server/` | `exa-mcp-server` | `3.5.1` | MIT（含 `LICENSE`） | 19 / 1.9 MB | **是** | npm tarball 解包，不是本仓库源码；`dist/stdio.cjs` 是上游预打包产物（1.79 MB）。不含 `node_modules`，其依赖（`@modelcontextprotocol/sdk`、`exa-js`、`zod` 等）由目标机自行安装或由 DSH 提供。profile 的 `exa-stdio` server 直接 `node` 跑它，改路径即可离线使用。 |

## 6. 排除清单与证据（2026-11-21 实测）

| 排除项 | 原因 | 证据 |
|---|---|---|
| 所有 `node_modules/` | 60 MB+，且是源机绝对路径的软链，换机必坏 | 源树 `find -name node_modules -type d` 只有 1 个：`dsh-router-b/packages/client-ui-router/node_modules`；仓库 `find . -name node_modules` → **0** |
| `*.bak-*`、`lib.bak-*`、`src.bak-*`、`lib.prev/`、`lib.next/`、`lib.failed/`、`_backup/` | 历史备份与构建中间态，误用会回退 | 仓库 `find` 上述模式 → **0** |
| `preview/`、`preview/dist/`、`dist/`（各 client 包） | 预览站产物，不是 profile 加载物 | 仓库内 `dist/` 仅 `vendor/exa-mcp-server/dist/`（第三方预打包，见上） |
| `*.tsbuildinfo` | tsc 增量缓存，记录源机绝对路径 | 仓库 `find -name '*.tsbuildinfo'` → **0** |
| `dsh-router-b/deploy/` 的其余 85 个文件 | 一次性排障脚本，且 `deploy/ACCESS.md`、`deploy/41-verify-public.sh` 历史上有明文口令 | 仓库只保留 4 个：`nginx-dsh-web.conf`、`dsh-web-gate.mjs`、`E0-install-gate.sh`（口令行已是 `__REDACTED_SET_ON_NEW_MACHINE__` 占位）、`cordis.patch.server.yml` |
| `dsh-router-b/scripts/rotate-anchor-and-drill.sh` | 一次性演练脚本 | 未入仓 |
| `dsh-router-b/_backup/` | 旧备份 | 未入仓 |
| `.dsh-artifacts/` | 任务证据与截图（含敏感内容），不是运行依赖 | 未入仓；`git ls-files` 中无 `.dsh-artifacts` |
| `keys/`、`*.pem`、`*.key`、`*.p12`、`*.jks`、`.env*`、`secrets.vault`、`*passphrase*`、`vault/` | 密钥/证书/保险库运行态 | `.gitignore` 排除；仓库 `find` 这些模式 → **0**；`dsh-secrets` 运行时不会生成到仓库内 |
| `dsh-egress/packages/host-egress/tests/fixtures/test-{cert,key}.pem` | **硬门禁要求仓内不得有 `*.pem`/`*.key`**。这两份是 `CN=localhost` 的自签测试证书（2026-11-19 生成，非真实凭据），被 `tests/helpers.mjs:18-19` 读取 | 未入仓。副作用：在新机直接跑 `dsh-egress` 的 host 测试会因缺文件失败，需要时用 `openssl req -x509 -newkey rsa:2048 -nodes -keyout test-key.pem -out test-cert.pem -days 36500 -subj /CN=localhost` 重新生成（生成物仍不要提交） |
| `vendor/exa-mcp-server/node_modules`（若存在） | 依赖目录 | 源树里本来就没有 |
| profile 的 `pnpm-lock.yaml`、`.plugin-manager/`、`sessions/`、`board.json`、`tiers.json` | 本机运行态 / 过期锁 | 未入仓 |

## 7. 规模

- 仓库文件总数（不含 `.git`）：**396**
- `du -sh --exclude=.git`：约 **8.2 MB**（其中 `vendor/exa-mcp-server` 1.9 MB）
- 插件目录文件数：`dsh-router-b` 155、`dsh-token-stats` 25、`dsh-egress` 77、`dsh-vpn` 76、`dsh-secrets` 22、
  `vendor` 19；`scripts` 2（`browser`、`browser.py`）；`profile` 4；`docs` 14（含 `nginx/` 5）。

## 8. 提交前敏感扫描门禁（2026-11-21 实测）

扫描对象：**暂存区**（`git add` 之后），命令在 `/srv/workspace/dsh-warroom` 执行。

```bash
# 1) 通用密钥模式
git grep --cached -n -I -E '<server-password>|<REDACTED-legacy-credential>|admin:|sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|LTAI[0-9A-Za-z]{12,}|-----BEGIN [A-Z ]+-----|xox[bp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}'
# 2) 文件名/关键字
git grep --cached -n -I -E '\.p12|\.jks|secrets\.vault|DSH_SECRETS_PASSPHRASE'
# 3) 文件类型门禁
git ls-files | grep -Ei '\.(pem|key|p12|jks|pfx)$|(^|/)\.env($|\.)|secrets\.vault$'
# 4) Gitea 真实口令（口令从 /root/.gitea-admin.cred 读入临时 0600 文件，用 -f 传入，不写进命令行/仓库）
PW="$(sed -n 's/^password=//p' /root/.gitea-admin.cred)"; printf '%s\n' "$PW" > /tmp/.pat; git grep --cached -I -F -f /tmp/.pat; rm -f /tmp/.pat
# 5) 旧地址
git grep --cached -I '8\.163\.126\.253'
```

结果：

| 检查 | 命中 | 处理 |
|---|---|---|
| Gitea 真实口令（24 字符） | **0** | 无需处理 |
| 旧地址（`8.163` 段，见 git 历史的原始值） | **0** | 已在副本中全部替换 |
| `sk-` / `ghp_` / `AKIA` / `LTAI` / `xox` / `AIza` | 4 行，全部是 `vendor/.../stdio.cjs` 里的 `mbms-msk-response`、`task-augmented` 片段 | 误报（`sk-` 出现在 `msk-`/`task-` 中间），保留 |
| `admin:` | 2 行，`deploy/E0-install-gate.sh` 的 `admin:__REDACTED_SET_ON_NEW_MACHINE__` | 占位符，非真实口令，保留 |
| `-----BEGIN ...-----` | 9 行，全部在 `dsh-secrets/scripts/ingest-file.selftest.mjs`，正文是 `FAKE-*` 合成串 | 自测用假证书，保留 |
| `.p12` / `.jks` / `secrets.vault` / `DSH_SECRETS_PASSPHRASE` | 文档、配置、代码里的**文件名与默认变量名**说明（含 `client.p12`、`<DSH_HOME>/secrets.vault`） | 只是名字，不含任何证书/vault 内容，保留 |
| `*.pem` / `*.key` / `*.p12` / `*.jks` / `.env` / `secrets.vault` **文件** | **0 个** | 通过 |
| `node_modules/`、`.dsh-artifacts/`、`keys/`、`vault/` 路径 | **0 个** | 通过 |

结论：**真实口令/密钥/证书内容 0 命中，仓内无证书/密钥/环境/vault 文件，门禁通过。**

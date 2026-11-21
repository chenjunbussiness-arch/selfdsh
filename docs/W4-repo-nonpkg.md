# 作战室移植审计 · W4：插件仓库内、但不在插件包里的内容

> 审计对象：`/srv/workspace/deepseek-harness/dsh-router-b`
> 审计方式：**严格只读**。未改任何脚本，未执行 `safe-build-host.sh` / `tsc` / `vite` / `pnpm build`，未重启 DSH。
> 允许的写操作只有本文件。时间：2026-11-20 15:2x（Asia/Shanghai）。
> `packages/host-router/lib/`、`packages/client-ui-router/lib/` 属于插件包产物，不列为本报告主体；`node_modules` 全部排除。

---

## 0. 一句话结论

`packages/` 之外真正影响"换机能不能起来"的东西只有 **4 处**：`scripts/safe-build-host.sh:7` 的写死 tsc 路径（**外部项目目录，含空格，今天存在**）、
`packages/host-router/tsconfig.json:17` 的写死 `typeRoots`（pnpm store 里带 hash 的绝对路径）、
`scripts/build.mjs:27` 的"兄弟目录" `deepseek-harness-latest`（**不存在**）、以及根 `cordis.patch.yml:40/68/90` 的三个分机绝对分区根。
其余（`deploy/` 89 个一次性排障脚本、`docs/` 7 篇、`*.bak-*` 19 处）都是历史记录，**可以全部不带**，但 `deploy/ACCESS.md` 含明文口令，带出去之前必须脱敏。
仓库**没有 .git**（`git status` → `fatal: not a git repository`），也没有 `pnpm-workspace.yaml` / `.npmrc` / `.gitignore` / 根 `tsconfig.json` / 根 `README.md`。

---

## 1. 目录结构（`find -maxdepth 2`，排除 `node_modules`；`lib*` 单列）

```
/srv/workspace/deepseek-harness/dsh-router-b/
├── package.json                                1031B  bundle 清单（scripts / file: 依赖 / dsh.bundle.patch）
├── cordis.patch.yml                            4620B  挂载两行 + 三个分区根（绝对路径）
├── cordis.patch.yml.bak-20261119-174507        2697B  手工备份
├── cordis.patch.yml.bak-20261119-191250        3072B  手工备份
├── cordis.patch.yml.bak-20261119-204000        4619B  手工备份
├── index.js                                     949B  空 host 半边（bundle 本体）
├── icon.svg                                     735B  插件管理器图标
├── locale/
│   ├── en.json                                          meta.title/description/detail
│   └── zh.json
├── packages/                                   72M    ← 插件包本体（另案，本报告不展开）
│   ├── host-router/            (src, tests, docs, lib, lib.prev, lib.bak-*×7, tsconfig*.json)
│   └── client-ui-router/       (src, src.bak-*×2, preview, scripts, docs, lib, lib.bak-*, node_modules, package-lock.json)
├── scripts/                                    40K    ← 本节重点
│   ├── build.mjs                                114 行
│   ├── install.mjs                              249 行
│   ├── safe-build-host.sh                        20 行
│   ├── safe-restart.sh                           40 行
│   └── rotate-anchor-and-drill.sh                85 行
├── deploy/                                    5.4M    ← 89 个文件（77 .sh / 2 .py / 1 .mjs / 1 .ps1 / 3 .png / 1 .yml / 2 .md / shots/）
│   └── shots/                                          7 张截图
├── docs/                                      164K    7 篇 .md（无代码）
└── _backup/                                   128K    client-src-20261119-1412/（12 个 .tsx/.ts 旧版）
```

`packages/` 之外**没有**：`README.md`、`tsconfig*.json`、`.gitignore`、`.npmrc`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`LICENSE`、`node_modules/`、`.git/`。

`packages/` 之外的非源码资产：`icon.svg`、`locale/*.json`（2 个）、`deploy/`（含 3 张 png + `shots/` 7 张 png）、`_backup/`、`cordis.patch.yml.bak-*`（3 个）。

---

## 2. packages/ 之外逐项说明

### 2.1 根清单 `package.json`

| 项 | 值 | 证据 |
|---|---|---|
| name / version | `dsh-router-b` / `0.1.0`，`private: true` | `package.json:2-4` |
| type / main | `module` / `index.js` | `package.json:7,9` |
| scripts | `build` → `node scripts/build.mjs`；`install:profile` → `node scripts/install.mjs` | `package.json:28-31` |
| dependencies | `dsh-host-router: "file:./packages/host-router"`、`dsh-client-ui-router: "file:./packages/client-ui-router"` | `package.json:33-34` |
| devDependencies | **无** | 全文 |
| packageManager | **无**（不锁 pnpm 版本） | 全文 |
| engines | `node >=22` | `package.json:26-28` |
| files | `index.js, cordis.patch.yml, icon.svg, locale, docs, packages` | `package.json:16-24` |
| dsh.bundle.patch | `./cordis.patch.yml` | `package.json:37-41` |

要点：依赖写法是 **`file:`（相对路径），不是 `workspace:*`**。没有 `pnpm-workspace.yaml`，所以根目录**不是** pnpm workspace；根 `pnpm install` 只会把两个子包按 `file:` 硬链/拷进来，不会装 typescript/esbuild。子包自己的 `devDependencies`（typescript 5.6.3、esbuild 0.24.0）只存在于 `packages/client-ui-router/node_modules`（当前`已存在`），`host-router` **没有** `node_modules`。

### 2.2 根 `cordis.patch.yml`（属 bundle，非 package）

- `:29` `- insert:` 起，`:30-31` `id: host-router` / `name: dsh-host-router`，`:33-37` `manager: true, maxWorkers: 0, autoVerify: false`；`:105-106` `id: client-ui-router` / `name: dsh-client-ui-router`。
- **三个分区根写死本机绝对路径**：`:40 /srv/workspace/rca-ab-test`、`:68 "/srv/workspace/google tend"`（带引号、含空格）、`:90 /srv/workspace/deepseek-harness`。
- 注释 `:9-11` 明确依赖 "profile installs with pnpm's hoisted linker"；`:13-18` 说明为什么不声明 `@deepseek-ai` peer。
- 三个 `.bak-*` 与现行文件的差异仅 `maxWorkers 8→0`、`autoVerify true→false`（`diff` 实测），无功能分叉。

### 2.3 `index.js` / `locale/` / `icon.svg`

| 文件 | 作用 | 关键点 |
|---|---|---|
| `index.js` | bundle 的 host 入口，`export const name/inject=[]/apply(){}`（`:16-26`） | 故意空实现，只为满足 manifest 的 `.` export |
| `locale/zh.json` | 插件管理器展示的中文名/描述 + `detail: "docs/DETAIL.zh.md"`（`:5`） | **相对引用 docs 文件**；英文版 `locale/en.json:5` → `docs/DETAIL.md` |
| `icon.svg` | 插件图标，`package.json:8` 的 `icon` 指向它 | 纯静态 |

`locale/*.json` 是本仓库里唯一"按文件名引用 docs"的地方（见 §3），也就是说 `docs/DETAIL.md` / `docs/DETAIL.zh.md` 是**运行时会被插件管理器点开**的文档，不能随便删。

### 2.4 `scripts/` 五个文件（逐个）

#### (1) `scripts/build.mjs` — 一条命令构建全部产物（114 行）

| 维度 | 事实 | 证据 |
|---|---|---|
| 用途 | 依次：client 声明文件 → client 浏览器 bundle → host `tsc -b` → host 测试 | `:102,105,108,112` |
| 被谁调用 | 根 `package.json:29` 的 `build`；`docs/UPGRADE.md:60`、`docs/REQUIREMENTS-v2.md:270` 写成命令 |  |
| 硬编码绝对路径 | **有**，`:27` `SIBLING_TS = dirname(ROOT)/deepseek-harness-latest/node_modules/typescript/bin/tsc` | 实测 `/srv/workspace/deepseek-harness-latest` **不存在** |
| 编译器选择 | `:38-43` 候选顺序：`$DSH_TSC` → `packages/client-ui-router/node_modules/typescript/bin/tsc` → `<repo>/node_modules/typescript/bin/tsc`（不存在）→ `SIBLING_TS`（不存在）；`:86-98` 取版本最高者，host 需 ≥5.7 | 当前 `DSH_TSC` 未设置 |
| 网络 | **不需要**（只 spawn 本地 tsc / node / esbuild） |  |
| 失败行为 | 找不到 tsc → exit 2 并打印 "No TypeScript compiler found."（`:74-81`）；host 版本 <5.7 → exit 2 打印 "The host half needs TypeScript >= 5.7 … Set DSH_TSC"（`:90-97`） |  |

> **实测推断（未执行构建，仅按 existsSync 结果推演）**：当前唯一候选是 client 自带的 **typescript 5.6.3**，root 无 `node_modules`、`SIBLING_TS` 不存在、`DSH_TSC` 未设置 ⇒ `npm run build` / `node scripts/build.mjs` **会在 host 版本门（`:90`）以 exit 2 失败**，信息形如
> `The host half needs TypeScript >= 5.7 (it emits `.ts`-specifier imports).` / `Found: .../client-ui-router/node_modules/typescript/bin/tsc (5.6)` / `Set DSH_TSC to a 5.7+ tsc entry point.`
> 这是"换机后第一步就卡住"的地方之一，修法见 §6 步骤 2。

#### (2) `scripts/install.mjs` — 幂等装入任意 profile（249 行）

| 维度 | 事实 | 证据 |
|---|---|---|
| 用途 | 写 profile `package.json` 三条 `link:` 依赖 + 注册 `dsh.profile.bundles` + 建三个 `node_modules` 目录链接（+ 可选停用官方品牌行） | `:122-124,126-149,153-189,193-211` |
| 被谁调用 | 根 `package.json:30` `install:profile`；`docs/UPGRADE.md:36,61`、`docs/HANDOFF.md:74-79` |  |
| 关键设计 | 从 `:135-138` **主动把两个子包从 bundles 数组里删掉**（子包不是 bundle） | 与 `docs/UPGRADE.md:139-141` 的坑对应 |
| 硬编码绝对路径 | **无**（`BUNDLE` 由 `import.meta.url` 推导，`:38`） |  |
| 网络 | **不需要**；`docs/UPGRADE.md:47` 明确"故意不跑包管理器" |  |
| 副作用 | 每次改文件留 `*.bak-install-<ts>`（`:109`）；`:219-224` 会读 bundle patch 里的 `root:` 并与磁盘比对，缺目录只 warn 不失败（`:235-242`） |  |

#### (3) `scripts/safe-build-host.sh` — 只构建 host 到 `lib.next/`（20 行，专项核实见 §2.5）

#### (4) `scripts/safe-restart.sh` — 停机换 `lib`、起服务、失败回滚（40 行）

| 维度 | 事实 | 证据 |
|---|---|---|
| 用途 | 等运行中任务收敛（默认 `WAIT_MIN=10`）→ `systemctl stop dsh-web.service` → `lib.next` 顶替 `lib`（旧的存 `lib.prev`）→ start → 轮询 `/api/router/board` 打 200 → 不通则回滚 | `:10-19,20,21-24,25,27-34,36-39` |
| 硬编码绝对路径 | `/root/.dsh/router/board.json`（`:10`）、`/var/log/dsh-web.log`（`:29`）、`http://127.0.0.1:42443`（`:30-31`）、服务名 `dsh-web.service`（`:20,25,38`） |  |
| 被谁调用 | `scripts/rotate-anchor-and-drill.sh:28,49`；对 agent 的硬规则文本里也点名（`packages/host-router/src/config.ts:740` 生成的提示词） |  |
| 网络 | 只打 **loopback**（127.0.0.1），不出网 |  |
| 环境前提 | 需要 `systemctl`、`python3`、`curl`、`/var/log/dsh-web.log`（实测存在，15782B）、`/root/.dsh/router/board.json`（实测存在，1.1MB） |  |

#### (5) `scripts/rotate-anchor-and-drill.sh` — 一次性演练剧本（85 行）

- 用途：删/备份 `anchor.json` → 重启 → 发一条"只读演练"需求 → 中途再重启验续作 → 通过后一次性发 5 条真实任务。头注释 `:1-4` 说明要 `systemd-run` 跑。
- **硬编码绝对路径最多**：`:6 R=/srv/workspace/deepseek-harness/dsh-router-b`、`:7 OUT=/srv/workspace/deepseek-harness/.dsh-artifacts/p0-20261120`、`:8 /root/.dsh/router/board.json`、`:9 /tmp/resume-drill.log`、`:15,63 /var/log/dsh-web.log`、`:16,21 http://127.0.0.1:42443`、`:27 /root/.dsh/router/anchor.json`，且 `:74-82` 的 5 条任务正文里还写死了 `/srv/workspace/...`、`/root/.dsh/router/tiers.json`、`/srv/workspace/google tend/...`。
- 被谁调用：**没有调用点**（一次性脚本）。`grep` 全仓仅自身内部 `safe-restart.sh` 调用。
- 网络：loopback only。
- **结论：换机不必带走**（带走了也只会把旧任务重发一遍）。

### 2.5 `scripts/safe-build-host.sh` 专项核实

完整关键行（`cat -n` 原文）：

```
 5  set -euo pipefail
 6  H="$(cd "$(dirname "$0")/../packages/host-router" && pwd)"
 7  TSC="${DSH_TSC:-/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc}"
 8  rm -rf "$H/lib.next"
 9  node "$TSC" -p "$H/tsconfig.json"
10  # Must be ESM: the package is "type": "module". A CommonJS build fails at import.
11  if head -c 200 "$H/lib.next/index.js" | grep -q '"use strict"'; then
12    echo "safe-build: lib.next/index.js is CommonJS, refusing" >&2; exit 1
13  fi
14  node --input-type=module -e "const m = await import('$H/lib.next/index.js'); if (typeof m.apply !== 'function') throw new Error('no apply export'); console.log('safe-build: import ok')"
16  T=$(mktemp -d); ln -s "$H/lib.next" "$T/lib"; cp "$H/package.json" "$T/"; mkdir "$T/tests"
17  cp "$H/tests/resume.test.mjs" "$H/tests/tier.test.mjs" "$T/tests/"
18  ( cd "$T" && node --test tests/resume.test.mjs tests/tier.test.mjs )
19  rm -rf "$T"
20  echo "safe-build: lib.next ready; run safe-restart.sh to switch to it"
```

核实结果：

1. **tsc 路径原文（第 7 行，注意目录名里是一个空格）**：
   `/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc`
   `ls -la` 实测 **存在**：`-rwxr-xr-x 3 root root 45 Nov 20 00:19`，内容 45 字节，就是官方 shim：
   ```
   #!/usr/bin/env node
   require('../lib/tsc.js')
   ```
   `node <该路径> --version` 未被本审计执行（属"跑 tsc"），但其同目录 `typescript/package.json` 的 `"version"` 是 **5.9.3**（`:5`），满足 host 要求的 ≥5.7。
   > 注意：`node "$TSC"` 之所以能跑，是因为 `typescript/package.json` 没有 `"type": "module"`，shim 里的 `require` 是 CJS；如果换成某个 ESM 化的 tsc 入口，这行会报 `require is not defined`。
2. **tsconfig 选择**：固定 `-p "$H/tsconfig.json"`（第 9 行），即 `packages/host-router/tsconfig.json`，其中 `outDir: "lib.next"`（`tsconfig.json:15`）、`rewriteRelativeImportExtensions: true`（`:10`）、`types: ["node"]` + **写死 `typeRoots`**（`:17`，见下）。不是 `tsconfig.check.json`，也不带 `-b`（`build.mjs:108` 才用 `-b`）。
3. **输出目录**：`packages/host-router/lib.next/`（先 `rm -rf`，第 8 行）；**绝不碰运行中的 `lib/`**，只有 `safe-restart.sh:22` 在 DSH 停止后才 `mv`。
4. **失败处理**：`set -euo pipefail`（第 5 行）⇒ 第 9 行 tsc 非零即整体退出；随后两道自检——CJS 产物拒绝（`:11-13`）、`import` 后必须导出 `apply` 函数（`:14`）；最后把 `resume.test.mjs`、`tier.test.mjs` 拷到临时目录对 `lib.next` 跑（`:16-18`），任一失败即中止。
5. **是否含网络**：无。
6. **被谁调用**：`grep` 全仓只有**提示词文本**引用它，没有脚本调用它：`packages/host-router/src/config.ts:739`（以及编译产物 `lib/config.js:511`、`lib.prev/config.js:511`）。也就是说它是"给 agent 看的命令"，不是流水线的一环。
7. **新机器上怎么失败（预测，未实跑）**：
   - 该外部路径不存在时，第 9 行 `node` 直接抛（实测同形态错误的原文，用一个不存在的路径复现）：
     ```
     node:internal/modules/cjs/loader:1568
       throw err;
       ^
     Error: Cannot find module '/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc'
         at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)
     ```
     退出码 1，`set -e` 立即中止；此时 `lib.next/` 已在第 8 行被删掉（**旧产物丢失**），但 `lib/` 完好，线上不受影响。
   - 若有人用 `DSH_TSC` 指到 **5.6.x**（例如本仓 client 自带那份），会先在 tsconfig 解析阶段炸，预测报 `error TS5023: Unknown compiler option 'rewriteRelativeImportExtensions'.`（该选项 5.7 才引入；`build.mjs:90` 就是为拦这个才做版本门，而 `safe-build-host.sh` **没有**版本门）。
   - 若 tsc 版本够但 `typeRoots` 指向的 pnpm store 路径不存在（见 §2.6），预测报 `error TS2688: Cannot find type definition file for 'node'.`

### 2.6 子包的 tsconfig 里也有两处环境写死（不在 packages 包"内容"里，但决定能不能构建）

| 文件:行 | 原文 | 现状 | 换机影响 |
|---|---|---|---|
| `packages/host-router/tsconfig.json:17` | `"typeRoots": ["/usr/local/pnpm-global/store/v11/links/@types/node/26.6.6/2ddc00d884325301077848a310be9f0546dfcebcb72a14c584b55c0b48092c9e/node_modules/@types"]` | 实测**存在**（该目录下只有 `node`） | pnpm store 路径 + 内容 hash，新机必然对不上；tsc 会报 TS2688 |
| `packages/host-router/tsconfig.check.json:11` | `"typeRoots": ["../../../deepseek-harness-latest/node_modules/@types"]` | 实测 `/srv/workspace/deepseek-harness-latest` **不存在** | 该 check 配置在本机已是死的；只有 `typecheck:check` 类用法会踩到 |
| `packages/client-ui-router/package.json:43` | `"build": "node node_modules/typescript/bin/tsc -p tsconfig.build.json && node scripts/build-client.mjs && node scripts/build-host.mjs"` | `packages/client-ui-router/node_modules/typescript` 实测存在（**5.6.3**），`esbuild` 0.24.0 也在 | 依赖"子包内 `pnpm install`"，新机不装就没有 tsc/esbuild |

### 2.7 `deploy/`（89 个文件，5.4M）

性质：**这台机器的建站/排障流水账**，按编号分段，绝大多数是"探针"（读 dsh 包源码、翻 session、试凭据），不是可复用部署件。逐类说明（括号内为实测文件数）：

| 段 | 文件 | 作用 | 硬编码本机路径 | 网络 |
|---|---|---|---|---|
| `01`–`03` | `01-node.sh`、`02-dsh.sh`、`03-dsh-pnpm.sh` | 装 Node 24 / 装 `dsh` CLI（默认 0.2.2-rc.5）/ 用 pnpm 绕开坏掉的全局 npm | 无（装到 `/usr/local`） | **需要**（下 tarball、`pnpm add -g`） |
| `10`–`13` | 探针/基础层/python/前端 | 给 `rca-ab-test` 装 swap、apt、Go、Python 3.12、`npm ci` 前端 | `10-probe-project.sh:4 R=/srv/workspace/rca-ab-test`、`12/13` 各 1 处 | **需要**（apt/npm registry） |
| `20`–`31` | 12 个 | `dsh web` 启动探针、找前端真身、pnpm hoist 修复、`zod` 裸 import 修复、装 systemd 服务、npm 重装 | 大量 `/usr/local/pnpm-global/store/v11/links/...` 带 hash（`26/27/30/31` 等） | 部分需要 |
| `40`–`41` | nginx 发布 + 验收 | 把 dsh web 挂到 `:8443` TLS+Basic；`41-verify-public.sh:3` **明文口令** `<已脱敏，见源机 deploy/41-verify-public.sh>` | IP、证书路径 | loopback + 自测 |
| `50`–`51` | 注册 workspace | 写 `$DSH_HOME/storages/workspace.json`（v2），让 UI 工作区选择器非空 | `50-register-workspace.py` 3 处 `/srv/workspace/...` | 无 |
| `60`–`66` | 7 个 | LLM provider / 凭据 / pi-ai schema 探针 | `/root/.dsh/.credentials.yaml`、store 路径 | 部分（探 provider 时会打远端） |
| `70`–`73` | 4 个 | 会话存储结构、zstd 压缩、headless 测试 | `/root/.dsh/sessions`、`/root/.dsh/storages/...` | 无 |
| `80`–`83` | 4 个 | 解包 `google tend` 上传包、清凭据文本、验工作区 | `82-scrub-secrets.sh:5 T="/srv/workspace/google tend"`、`80/81/83` 各 1-2 处 | 无 |
| `90`–`99` | 10 个 | 读官方 `dsh-client-ui-sidebar-right` 等包源码，核 slot / service / tab 定义、profile 解析路径、client 入口 | 全是 `/usr/local/pnpm-global/store/v11/links/@deepseek-ai/<pkg>/<ver>/<sha>/node_modules/...` | 无 |
| `A0`–`A2` | 3 个 | 取当前 token、打 boot payload、dump board | `A0/A1/A2` 调 `dsh-web-url`（实测在 `/usr/local/bin/dsh-web-url`），打 `127.0.0.1:42443` | loopback |
| `B0`–`B8` | 9 个 | agent API / 建 agent / slot 注入 / tabinfo / sessionQuery / task detail / board dump / 默认模型 | 同上 store 绝对路径 | 无 |
| `C0`–`C9` | 10 个 | 凭据形状、auth 来源、pi-ai 鉴权、找 key、headless 鉴权、credentials 实现 | `/root/.dsh`、store | 少量 |
| `D0`–`D8` | 9 个 | `D0-set-key.py` 改服务器 key、解析检查、抛错点、profile 凭据、可用性、token 闸门 | `/root/.dsh`、store | 少量 |
| `E0`–`E1` | 2 个 | 装固定入口门禁（`dsh-web-gate` systemd）+ 端到端验收 | `/usr/local/bin`、`/etc/systemd/system`、nginx | loopback |
| 非脚本 | `ACCESS.md`、`GITEA-SYNC.md`、`cordis.patch.server.yml`、`nginx-dsh-web.conf`、`dsh-web-gate.mjs`(179 行)、`kiro-sync-creds.ps1`、`fixed-key-working-*.png`、`panel-*.png`、`shots/`(7 png) | 访问说明 / gitea 同步说明 / 服务器 profile patch / nginx 站点 / 门禁实现 / Windows 端推凭据 / 截图证据 | ACCESS.md 4 处、GITEA-SYNC.md 11 处 | 见 §2.8 |

> 判断：`deploy/` **没有任何可执行入边**——`grep -rn 'deploy/'` 在整个仓库（排除 `node_modules`/`lib`）只命中 **1 处文档提及**：`docs/UPGRADE.md:149` 提到 `deploy/dsh-web-gate.mjs`（讲 WebSocket upgrade 的坑）；`deploy/` 内部也互不调用（唯一命中是 `02-dsh.sh:3` 的 `Usage: 02-dsh.sh` 自述）。所以它是纯历史，**换机不必带走**；唯一值得带走的是 `nginx-dsh-web.conf` + `dsh-web-gate.mjs` + `E0-install-gate.sh`（如果你还要那套"固定地址+固定密码"的入口），以及 `cordis.patch.server.yml`（服务器 profile 的 compat 开关）。

### 2.8 文档类（全部 14 篇 `*.md`）

| 文件 | 行数 | 一句话作用 | 含可执行步骤/命令 | 含本机绝对路径 | 被谁引用（仓库内） |
|---|---|---|---|---|---|
| `docs/UPGRADE.md` | 151 | **最接近移植手册**：换机/换 DSH 版本的步骤、7 个外部接口点、seams 自检、回滚、9 条坑 | **是**（`:33-38,59-63,125-131` 三段 bash） | 是（`:142` `/srv/dsh-router-b/...`） | 无文件名引用；内容被 §1/§6 采纳 |
| `docs/HANDOFF.md` | 163 | 交接备忘：这是什么、代码在哪、已装状态、重装顺序、验证、已知限制 | 是（`:71-79` 有命令块） | 是（多处 profile 路径） | 无 |
| `docs/INTEGRATION.md` | 347 | host×client 接线的全部决定：seam、HTTP 契约、状态/字段映射、改动清单、验证结果 | 部分（`:276-` "只写不执行"的安装命令） | 是（`C:\Users\13558\...` 证据路径） | 无 |
| `docs/REQUIREMENTS-v2.md` | 276 | 需求 v2 口述→规格 + 已实施项 + 部署记录（含硬链接坑） | 部分（`:227-228` 构建命令） | 是（`:147-152,172,215`） | 无 |
| `docs/API-0.2.2-rc.3.md` | 1241 | rc.3 插件 API 事实核定（每条带 asar 证据行号），写代码时的参考 | 否（纯事实表） | 是（`C:\...\app.asar\...`） | 无 |
| `docs/DETAIL.md` / `docs/DETAIL.zh.md` | 48 / 40 | 插件管理器"详情"页正文（英/中） | 否 | 否 | **是**：`locale/en.json:5`、`locale/zh.json:5` |
| `deploy/ACCESS.md` | 124 | 服务器访问说明：固定地址/账号口令、模型与 key 位置、TLS、端口、改密、服务清单、别动的东西、已知问题 | **是**（大量 bash/ssh） | 是（4 处 `/srv/...`、`/root/.dsh/...`、`/var/log/...`、`C:\Users\...pem`） | 无 |
| `deploy/GITEA-SYNC.md` | 64 | `rca-ab-test` 与公司 gitea 的同步说明（VPN 前提、deploy key、`gitea-sync.sh` 四个子命令） | **是**（`:42-47` 四条命令） | 是（11 处） | 无 |
| `packages/host-router/README.md` | 220 | host 包说明/装法/接口 | 是 | 部分 | 内部引用 `docs/HOST-CONTRACT.md:125` |
| `packages/client-ui-router/README.md` | 146 | client 包说明/构建五条命令/35 条断言 | 是（`:73-77`） | 否 | — |
| `packages/host-router/docs/HOST-CONTRACT.md` | 202 | host → UI 的只读契约（Channel A/B） | 否 | 否 | 被 `README.md:125,196` 引用 |
| `packages/client-ui-router/docs/CONTRACT.md` | 371 | client 期望 host 提供什么（字段级） | 否 | 否 | 被 `src/bridge.ts:87` 注释引用 |
| `packages/client-ui-router/docs/NATIVE-ENTRYPOINTS.md` | 153 | rc.3 原生入口（上传/下载/API key）落点，说明不要重造 | 否 | 是（`C:\...`） | 被 `src/client/*.tsx` 多处注释引用 |

> 安全提醒：`deploy/ACCESS.md:15`（`密码 <REDACTED>`）、`deploy/41-verify-public.sh:3`（同一口令明文）、`deploy/ACCESS.md:87,94`（`C:\Users\13558\.ssh\ali-zzl-harness.pem`）属于**凭据/身份信息**。`deploy/82-scrub-secrets.sh` 说明作者知道这件事但只清了 `google tend` 那边。搬机器/进 git 之前必须删或脱敏。

### 2.9 `_backup/`、`*.bak-*`、`lib.prev` 等

- `_backup/client-src-20261119-1412/`：12 个 `.tsx/.ts`（`RouterPanel.tsx`、`ProjectRail.tsx`、`Brand.tsx` …），是 client 源码 2026-11-19 14:12 的快照，**不被任何东西引用**（`grep` 仅自身）。
- 19 处 `*.bak-*` / `lib.bak-*` / `src.bak-*`：`packages/host-router/lib.bak-*` 7 份（164K–500K 各一份）、`lib.prev`（468K）、`client-ui-router/src.bak-*` 2 份（820K/876K）、`lib.bak-20261119-191250`（328K）、根 `cordis.patch.yml.bak-*` 3 份。
- 合计占 `packages/` 72M 里约 **6.3M**（其余是 `client-ui-router/node_modules` 与 `lib`）。
- 这些是**没有版本管理的直接证据**：每改一次就 `cp -a` 一份带时间戳的目录。
- **建议**：全部不带（或只带 `lib.prev` 一份作为回滚备份）。

---

## 3. 引用关系（仓库内文件之间，`file:line`）

### 3.1 谁调用 `scripts/*`

| 调用点 | 被调用 | 形态 |
|---|---|---|
| `package.json:29` | `scripts/build.mjs` | `"build": "node scripts/build.mjs"` |
| `package.json:30` | `scripts/install.mjs` | `"install:profile": "node scripts/install.mjs"` |
| `scripts/rotate-anchor-and-drill.sh:28` | `scripts/safe-restart.sh --now` | `"$R/scripts/safe-restart.sh" --now` |
| `scripts/rotate-anchor-and-drill.sh:49` | `scripts/safe-restart.sh --now` | 同上（演练中途再重启） |
| `packages/host-router/src/config.ts:739-740` | `scripts/safe-build-host.sh`、`scripts/safe-restart.sh` | **仅提示词文本**，非执行调用；同文出现在 `packages/host-router/lib/config.js:511`、`lib.prev/config.js:511` |
| `docs/UPGRADE.md:36,60,61,141` | `install.mjs` / `build.mjs` | 文档命令 |
| `docs/REQUIREMENTS-v2.md:248,269,270` | `build.mjs` / `install.mjs` | 文档命令 |
| `docs/HANDOFF.md:74-79` | 手工 junction/link 步骤（等价 install.mjs） | 文档命令 |
| `packages/client-ui-router/package.json:43-45` | 子包内 `scripts/build-client.mjs`、`build-host.mjs`、`verify-load.mjs`、`build-preview.mjs`、`serve-preview.mjs` | 子包 scripts 串联 |
| `scripts/build.mjs:105` | 子包 `scripts/build-client.mjs` | `run('client bundle', …, ['scripts/build-client.mjs'], CLIENT)` |

- `scripts/safe-build-host.sh` **没有任何脚本调用点**（只有 `config.ts:739` 的提示词）。
- `deploy/` 下 89 个文件**没有可执行入边**：全仓仅 `docs/UPGRADE.md:149` 提到其中 `dsh-web-gate.mjs`；`deploy/` 内部无互相调用。

### 3.2 package.json scripts 是否串联

- 根：`build` → `scripts/build.mjs`；`install:profile` → `scripts/install.mjs`。**两个 script 互不调用**，也没有 `prebuild`/`postbuild`。
- `build.mjs` 内部再串联：`:102` client 声明 → `:105` client bundle → `:108` host `tsc -b` → `:112` host 测试（**顺序敏感**，任一步非零即 `process.exit`，`:64-71`）。
- 子包 `client-ui-router:43` 是**另一条**串联链（tsc → build-client → build-host），与根 `build` 的 client 部分**重复**：根 `build.mjs` 只调 `build-client.mjs`（`:105`），不调子包的 `build` script，所以 client 的 `lib/index.js` 只能靠子包 `pnpm build` 或 `node scripts/build-host.mjs` 单独产出。

### 3.3 文档/路径引用

| 引用点 | 被引用 |
|---|---|
| `locale/en.json:5` | `docs/DETAIL.md` |
| `locale/zh.json:5` | `docs/DETAIL.zh.md` |
| `packages/host-router/README.md:125,196` | `docs/HOST-CONTRACT.md` |
| `packages/host-router/src/bridge.ts:87`（及 6 份 `src.bak-*` 同位置） | `docs/CONTRACT.md` |
| `packages/client-ui-router/src/client/*.tsx`（`ProjectRail.tsx:11`、`RouterPanel.tsx:13`、`index.ts:16`、`source.ts:15`、`contract.ts:6`、`native-todos.ts:16`） | `docs/NATIVE-ENTRYPOINTS.md` / `docs/CONTRACT.md`（均为注释） |
| `packages/host-router/src/config.ts:739` | `/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-build-host.sh`（绝对路径写进提示词） |
| `deploy/*` 中的路径 | `/srv/workspace/bin/gitea-sync.sh`（实测存在）、`/usr/local/bin/dsh-web-url`（实测存在）、`/srv/workspace/bin/screenshot`（实测存在，121B 包装脚本） |

### 3.4 "部署文档里写的路径"是否被代码引用

- **没有**。`deploy/ACCESS.md`、`deploy/GITEA-SYNC.md` 里写的 `/srv/workspace/bin/*`、`/usr/local/bin/dsh-web-gate.mjs`、`/etc/nginx/*` 全部是**环境侧文件**，没有任何仓库内代码 import/exec 它们（只有 `deploy/E0-install-gate.sh` 会 `install` 那份 `dsh-web-gate.mjs`）。
- 反向：`deploy/` 里也没有引用仓库内 `scripts/`。

---

## 4. 版本 / 状态

### 4.1 版本管理

- `ls -la` 根目录**无 `.git`**；`ls -d /srv/workspace/.git /srv/workspace/deepseek-harness/.git /srv/.git` 全部 `No such file or directory`；`git -C .../dsh-router-b status` → `fatal: not a git repository (or any of the parent directories)`。
- 没有任何 tag/commit/CI 文件（无 `.github/`、无 `*.yml` 流水线）。
- 无版本管理的直接迹象：
  - 19 处 `*.bak-<时间戳>` / `lib.bak-*` / `src.bak-*`；
  - `packages/host-router/src/*.bak-20261119-174507`、`index.ts.bak-firstedit-20261119-174944`；
  - 根 `cordis.patch.yml.bak-*` 3 份（差异只有 `maxWorkers`/`autoVerify`）；
  - `deploy/` 里 90 个按编号堆积的探针脚本。
- 仓库总大小 **19M**（`du -sh --exclude=node_modules`），其中 `packages/` 72M（含 `node_modules` 与 `lib.bak-*`）。

### 4.2 `packages/*/package.json` 的 name/version 与相互依赖

| 包 | name | version | private | 依赖声明 | 证据 |
|---|---|---|---|---|---|
| 根 | `dsh-router-b` | `0.1.0` | true | `file:./packages/host-router`、`file:./packages/client-ui-router` | `package.json:2-4,33-34` |
| host | `dsh-host-router` | `0.1.0` | true | **无 dependencies / 无 peerDependencies**（只用宿主注入的 `ctx` 服务） | `packages/host-router/package.json:2-3`，全文无依赖段 |
| client | `dsh-client-ui-router` | `0.1.0` | true | `peerDependencies`: `@deepseek-ai/cordis >=4.0.0`、`react >=18.2.0`；`devDependencies`: `@types/react ^18.3.12`、`@types/react-dom ^18.3.1`、`esbuild ^0.24.0`、`react ^18.3.1`、`react-dom ^18.3.1`、`typescript ^5.6.3` | `packages/client-ui-router/package.json:31-34,49-56` |

- 三个包之间**没有** `workspace:*`，也**没有** `link:` 写在自己的 package.json 里——`link:` 只出现在**运行中的 profile**（环境侧）：
  ```
  /root/.dsh/profiles/web/package.json:
    "dsh-router-b": "link:/srv/dsh-router-b",
    "dsh-host-router": "link:/srv/dsh-router-b/packages/host-router",
    "dsh-client-ui-router": "link:/srv/dsh-router-b/packages/client-ui-router"
    dsh.profile.bundles = [..., "dsh-router-b", "dsh-egress", "dsh-vpn", "dsh-token-stats"]
  ```
- **关键发现**：profile 里写的是 **`/srv/dsh-router-b`**，不是 `/srv/workspace/deepseek-harness/dsh-router-b`。实测 `/srv/dsh-router-b` 是**符号链接**：`/srv/dsh-router-b -> /srv/workspace/deepseek-harness/dsh-router-b`（`readlink -f` 确认；`stat -c %i` 两路径同 inode `1618178`）。
  ⇒ 换机后**要么重建这个 `/srv/dsh-router-b` 符号链接，要么用 `install.mjs` 重写三条 `link:`**（它写的是真实路径）。这是"看起来装好了但其实指向旧路径"的最隐蔽一处。
- profile 的 `dsh.profile.bundles` 里还有 `dsh-egress`、`dsh-vpn`、`dsh-token-stats`（**不在本仓**，分别在 `/srv/workspace/deepseek-harness/dsh-egress`、`dsh-vpn`、`dsh-token-stats`），移植时要一并处理（本次不在 W4 范围）。

### 4.3 工具链现状（只读核实）

| 项 | 实测值 |
|---|---|
| node | `v24.22.3`（`/usr/local/bin/node`） |
| pnpm / npm | `/usr/local/bin/pnpm`、`/usr/local/bin/npm` 均在 |
| `DSH_TSC` | 未设置 |
| 外部 tsc | `/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc` **存在**，typescript **5.9.3** |
| client 内 tsc | `packages/client-ui-router/node_modules/typescript` **存在**，**5.6.3** |
| esbuild | `packages/client-ui-router/node_modules/esbuild` **存在**，**0.24.0** |
| root `node_modules` | **不存在** |
| `SIBLING_TS` | `/srv/workspace/deepseek-harness-latest` **不存在** |
| `@types/node` | 写死路径存在（26.6.6） |

---

## 5. 结论表：packages/ 之外，换机怎么办

| 文件/目录（绝对路径） | 作用 | 仓库内 / 环境侧 | 换机必须带走 | 需要改什么 |
|---|---|---|---|---|
| `/srv/workspace/deepseek-harness/dsh-router-b/package.json` | bundle 清单、file: 依赖、build/install 两个 script | 仓库内 | **是** | 可选：加 `devDependencies.typescript ^5.9` 或 `packageManager`；把 `build` 依赖的编译器说清 |
| `.../cordis.patch.yml` | 挂两行 + 三个分区根 + maxWorkers/autoVerify | 仓库内 | **是** | **必改** `:40,68,90` 三个 `root:`（64 上 `google tend` 带空格要保留引号） |
| `.../index.js` | 空 host 半边 | 仓库内 | 是 | 无 |
| `.../icon.svg`、`.../locale/{en,zh}.json` | 插件管理器展示 + 详情页指向 docs | 仓库内 | 是 | 无（但需连同 `docs/DETAIL*.md`） |
| `.../scripts/build.mjs` | 一条命令构建全部 | 仓库内 | **是**（若要重建产物） | **必改** `:27` `SIBLING_TS`（指向不存在的 `deepseek-harness-latest`）；建议改成"子包内 tsc 或 DSH_TSC" |
| `.../scripts/install.mjs` | 幂等装入 profile | 仓库内 | **是** | 无（路径自解析，最干净的一个） |
| `.../scripts/safe-build-host.sh` | 只构建 host → `lib.next/` | 仓库内 | **是** | **必改** `:7` 写死的外部 tsc 路径 → 改为 `$H/../client-ui-router/node_modules/typescript/bin/tsc`（5.6，不够）或 `DSH_TSC` / `npx -y typescript@5.9 tsc`；并加 `tsc --version` ≥5.7 的检查 |
| `.../scripts/safe-restart.sh` | 停机换 lib + 起服务 + 回滚 | 仓库内 | **是** | 环境相关：`/var/log/dsh-web.log`、服务名 `dsh-web.service`、端口 `42443`、`/root/.dsh/router/board.json`（若目标机不同需改） |
| `.../scripts/rotate-anchor-and-drill.sh` | 一次性演练剧本 | 仓库内 | **否** | 不必带（带则要改 `:6-9` 与 `:74-82` 全部绝对路径） |
| `.../deploy/`（89 文件，5.4M） | 建站/排障历史 | 仓库内（产物是环境侧） | **否**（建议另存归档） | 若带走：`ACCESS.md`/`41-verify-public.sh:3` 的明文口令必须删；`80/81/82/83` 的 `/srv/workspace` 路径要改 |
| `.../docs/UPGRADE.md` | 迁移手册本体 | 仓库内 | **是** | 按本报告补 §2.5/§2.6 两处写死路径 |
| `.../docs/HANDOFF.md`、`INTEGRATION.md`、`REQUIREMENTS-v2.md`、`API-0.2.2-rc.3.md` | 交接/接线/需求/API 事实 | 仓库内 | 建议带（`API-*.md` 1241 行是 rc.3 证据，换版本会过期） | 无（只读参考） |
| `.../docs/DETAIL.md`、`DETAIL.zh.md` | 插件详情页正文 | 仓库内 | **是** | 无（`locale/*.json:5` 引用） |
| `.../cordis.patch.yml.bak-*`（3 个）、`_backup/`、`packages/*/lib.bak-*`、`src.bak-*`、`lib.prev` | 手工备份（无 VCS 的替代品） | 仓库内 | **否** | 建议全部剔除，改用 git |
| `packages/host-router/tsconfig.json:17` | host 编译的 `@types/node` 根 | 仓库内（值指向环境） | 是（文件） | **必改** `typeRoots` → 删掉该字段，靠 `packages/host-router/node_modules/@types/node` 或 `pnpm add -D @types/node` |
| `packages/host-router/tsconfig.check.json:11` | 另一套 check 配置 | 仓库内 | 否 | **必改/删**（`../../../deepseek-harness-latest` 本机就不存在） |
| `packages/client-ui-router/package.json:43` | 子包 build 串 | 仓库内 | 是 | 依赖子包内 `pnpm install`（tsc 5.6.3 + esbuild 0.24.0）；新机必须先装 |
| `packages/client-ui-router/node_modules/`（53M） | 构建工具（tsc/esbuild/react types） | 仓库内但属构建工具 | 否（UPGRADE.md:26 明确不带） | 新机 `cd packages/client-ui-router && pnpm install`（或 `npm ci`，有 `package-lock.json`） |
| `/root/.dsh/profiles/web/package.json` + `node_modules/{dsh-router-b,dsh-host-router,dsh-client-ui-router}` | 运行期挂载（`link:` 到 `/srv/dsh-router-b`） | **环境侧** | 否（每机重生成） | **必改**：跑 `install.mjs`，或重建 `/srv/dsh-router-b` 符号链接 |
| `/etc/systemd/system/dsh-web.service`、`dsh-web-gate.service`、`/etc/nginx/`、`/usr/local/bin/dsh-web-url`、`/srv/workspace/bin/{gate,gitea-sync.sh,screenshot}` | 服务/入口/工具 | **环境侧** | 否 | 按 `deploy/` 的 `E0/E1/40` 重建（可选） |
| `/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc` | host 构建用的编译器 | **环境侧（另一个项目！）** | 否 | **这是跨项目硬依赖**：或让目标机装一份 typescript ≥5.7，或改脚本 |
| `/srv/workspace/deepseek-harness-latest/node_modules/@types` + `.../typescript/bin/tsc` | `build.mjs` / `tsconfig.check.json` 的"兄弟目录" | **环境侧（不存在）** | 否 | 删掉这两处引用 |

---

## 6. 构建步骤复刻顺序（命令级，**本审计未执行**）

> 前提：新机已装 node ≥22（本机 v24.22.3）与 pnpm；仓库已拷贝到 `<REPO>`（本机为 `/srv/workspace/deepseek-harness/dsh-router-b`）。

```bash
# 0) 先修两处写死路径（否则下面 3、4 必失败）
#    a. packages/host-router/tsconfig.json:17 删掉 "typeRoots" 整行
#    b. scripts/build.mjs:27 删掉 SIBLING_TS（或改指向真实存在的 tsc）
#    c. scripts/safe-build-host.sh:7 的 TSC 默认值改成目标机真实入口，例如
#       TSC="${DSH_TSC:-$H/../client-ui-router/node_modules/typescript/bin/tsc}"
#       —— 但该份是 5.6.3，host 需要 ≥5.7，所以实际要装 5.9：

# 1) client 包的构建工具（tsc 5.6.3 + esbuild 0.24.0 + react types）
cd <REPO>/packages/client-ui-router
pnpm install            # 或：npm ci   （仓内有 package-lock.json，19KB）

# 2) host 需要的 TS ≥5.7 + @types/node（当前 host 包没有 node_modules）
cd <REPO>/packages/host-router
pnpm add -D typescript@^5.9 @types/node   # 或用目标机已装的：export DSH_TSC=/path/to/tsc

# 3) 一条命令全量构建（会顺手跑 host 的两组测试）
cd <REPO>
node scripts/build.mjs        # 等价于 npm run build
#    内部顺序：tsc -p tsconfig.build.json（client 声明）
#            → node scripts/build-client.mjs（lib/client.js）
#            → <tsc ≥5.7> -b（host，outDir=lib.next）
#            → node --test tests/bridge.test.mjs tests/router.test.mjs

# 4) 只重建 host、且不碰运行中的 lib/（DSH 运行期的正确姿势）
cd <REPO>
DSH_TSC=/path/to/typescript-5.9/bin/tsc bash scripts/safe-build-host.sh
#    产出 packages/host-router/lib.next/；自检 CJS + import + resume/tier 测试
#    此时**必须**由人执行 scripts/safe-restart.sh —— agent 不许重启 DSH

# 5) 装进 profile（幂等；不跑包管理器）
node scripts/install.mjs --profile /root/.dsh/profiles/web --disable-brand --dry-run
node scripts/install.mjs --profile /root/.dsh/profiles/web --disable-brand

# 6) 人执行重启（会等任务收敛 → stop → lib.next 顶替 lib → start → 轮询 /api/router/board）
bash scripts/safe-restart.sh            # 或 --now

# 7) 验收
cat /root/.dsh/router/seams.json        # ok: true，required 两项为 true
curl -s -o /dev/null -w '%{http_code}\n' -b <cookie> http://127.0.0.1:42443/api/router/board   # 200
```

顺序上的三个"必须"：
1. **client 的 tsc/esbuild 先于根 build**（根 `build.mjs:102,105` 直接 `cd CLIENT` 调 `tsc` 和 `build-client.mjs`）。
2. **host 的 tsc ≥5.7 先于 `tsc -b`**（`host-router/tsconfig.json:10` 的 `rewriteRelativeImportExtensions`）。
3. **`lib.next` 先于重启**（`safe-restart.sh:21` 只在 `lib.next` 存在时才换；否则它只做 stop/start，等于白重启）。

---

## 7. 换机必须带走 / 必须改（摘要清单）

**必须带走（8 项）**
1. `package.json`（根）
2. `cordis.patch.yml`（分区根要改）
3. `index.js`、`icon.svg`、`locale/en.json`、`locale/zh.json`
4. `scripts/build.mjs`、`scripts/install.mjs`、`scripts/safe-build-host.sh`、`scripts/safe-restart.sh`
5. `packages/host-router/{src,tests,package.json,tsconfig.json,README.md,docs/}`
6. `packages/client-ui-router/{src,package.json,tsconfig.json,tsconfig.build.json,scripts/,README.md,docs/,preview/}`
7. `docs/DETAIL.md`、`docs/DETAIL.zh.md`（`locale` 指向它们）
8. `docs/UPGRADE.md`（迁移手册本体，建议按本报告打补丁）

**可以不带**
`deploy/`（89 文件，5.4M，无可执行入边、仅 `docs/UPGRADE.md:149` 提及一处，且含明文口令）、`_backup/`、全部 `*.bak-*` / `lib.bak-*` / `src.bak-*` / `lib.prev`、`scripts/rotate-anchor-and-drill.sh`、`packages/*/node_modules`、`packages/client-ui-router/{lib,lib.bak-*}`（构建可再生）、`*.tsbuildinfo`。

**必须改（5 处写死 / 3 处缺失）**
| # | 位置 | 现值 | 改成 |
|---|---|---|---|
| 1 | `scripts/safe-build-host.sh:7` | `/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc` | 目标机真实 tsc（≥5.7）或 `DSH_TSC`；建议加版本检查 |
| 2 | `scripts/build.mjs:27` | `<repo>/../deepseek-harness-latest/node_modules/typescript/bin/tsc` | 删掉；候选里补 `packages/host-router/node_modules/typescript/bin/tsc` |
| 3 | `packages/host-router/tsconfig.json:17` | `/usr/local/pnpm-global/store/v11/links/@types/node/26.6.6/<sha>/node_modules/@types` | 删掉 `typeRoots`，改用包内 `@types/node` |
| 4 | `packages/host-router/tsconfig.check.json:11` | `../../../deepseek-harness-latest/node_modules/@types` | 删掉或改为包内路径 |
| 5 | `cordis.patch.yml:40,68,90` | `/srv/workspace/{rca-ab-test,google tend,deepseek-harness}` | 目标机分区根（`google tend` 保留引号） |
| 6 | profile `package.json` + `node_modules/*` 三条 `link:` | `link:/srv/dsh-router-b/...` | 重跑 `install.mjs`，或重建 `/srv/dsh-router-b` 符号链接 |
| 7 | `deploy/ACCESS.md:15`、`deploy/41-verify-public.sh:3` | 明文口令 | 删除/脱敏（若带走 deploy） |
| 8 | 仓库根 | 无 `.git`、无 `.gitignore` | 初始化 git + 写 `.gitignore`（排除 `node_modules`、`lib*`、`*.bak*`、`.dsh-artifacts`） |

---

## 8. 未确认 / 未实测

- **未执行** `scripts/build.mjs`、`safe-build-host.sh`、任何 `tsc`/`pnpm build`（任务要求只读）。§2.5 的失败信息、§4.2 的"根 build 会 exit 2"都是**按代码 + `existsSync` 结果推演**，未实跑验证。
- 未执行 `node <外部tsc> --version`；5.9.3 来自同目录 `typescript/package.json:5`，推测 `node bin/tsc` 与 `tsc --version` 一致。
- 未核对 `packages/client-ui-router/preview/dist/` 的内容（构建产物，未在本次范围）。
- 未验证目标机（新机器）的具体发行版/包管理器行为；`engines.node >=22` 只是声明。
- `deploy/` 中标注"需要网络"的项（`01/02/03/10/11/12/13`、部分 `6x`）依据脚本内的 `apt`/`pnpm add`/`npm ci`/`curl` 判断，未逐条确认目标 URL 可达性。

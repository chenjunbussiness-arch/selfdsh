# W5：Token 统计数据源 + 硬编码绝对路径清单（作战室移植手册）

审计时间 2026-11-20 15:2x（UTC+8），全程只读。DSH 0.2.2-rc.5，Web GUI http://127.0.0.1:42443。

## A. Token 用量面板的数据源

### A1 源码位置与读取规则
插件不在 `dsh-router-b/packages` 里，而是独立 bundle：`/srv/workspace/deepseek-harness/dsh-token-stats`
（`find dsh-router-b/packages -maxdepth 2 -iname '*token*'` 无结果；`ls packages` 只有 client-ui-router、host-router）。

| 项 | 事实 | 证据 |
|---|---|---|
| 根目录拼接 | `home = $DSH_HOME ?? join(homedir(), '.dsh')`；`root = config.sessionsDir ?? join(home,'sessions')` | `dsh-token-stats/packages/host-token-stats/index.js:29-30` |
| 当前实际值 | `DSH_HOME=/root/.dsh`，接口返回 `source.sessionsDir = "/root/.dsh/sessions"` | `curl /api/token-stats/summary` |
| profile 是否覆盖 sessionsDir | 否（`grep -rn sessionsDir /root/.dsh/profiles` 无结果） | |
| 文件 | `<root>/<projectSlug>/<sessionId>/session.v4.jsonl.zstd`，只认这一个文件名，两层目录 | `scanner.js:48, 235-265` |
| 格式 | zstd 压缩的 JSONL，`zlib.zstdDecompressSync` 解压后按 `\n` 切行 | `scanner.js:113-116` |
| 参与统计的事件 | `request/context`（`data.model`）、`request/header`（`data.header.config.model`）决定"后续调用的模型"；`assistant/message` 的 `data.usage` 计数 | `scanner.js:118-136` |
| 统计字段 | `usage.inputTokens`（未命中缓存输入）、`usage.outputTokens`、`usage.cacheReadTokens`、`usage.cacheWriteTokens`；**不用** `totalTokens` | `scanner.js:141-145` |
| 口径 | `billed = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`，billed≤0 的事件丢弃 | `scanner.js:145-146` |
| 分天 | 按事件 `time`（epoch ms）+ 固定 UTC+8 取日期，写死 Asia/Shanghai，与机器时区无关 | `scanner.js:42, 80-82` |
| 缓存 | 仅进程内存 `Map<path,{mtimeMs,size,aggregate}>`，按 mtime/size 增量重解析；**不写任何磁盘缓存** | `scanner.js:21-26, 180, 277-303`；`bridge.js` 只有 GET |
| projcache | `~/.dsh/storages/session_projcache/sessions/*.json` 是 DSH 自己的投影缓存，插件**不读不写**（注释说明它没有"按天×按模型"维度） | `scanner.js:12-17` |
| HTTP | `GET /api/token-stats/summary[?force=1]`；前端每 20 s 轮询 | `bridge.js:15-18`；`TokenStats.tsx:70` |

projcache 现状：`/root/.dsh/storages/session_projcache/sessions` 164 个文件，2.5 MB，每个文件顶层键 `version, record`。它能不能删、删后 DSH 会不会重建：**未确认**（属于 DSH 本体，不归这个插件管）。建议跟 sessions 一起搬，不要删。

### A2 数据目录现状（只统计，未读内容）
命令：`du -sh`、`find -printf '%T+ %s'` 等。

- `/root/.dsh/sessions`：总共 23 MB，`drwx------ root`
- 项目目录 6 个：`--srv-workspace-deepseek-harness--`、`--srv-workspace-rca-ab-test--`、`--srv-workspace-rca-ab-test-rca-openjiuwen-agent--`、`--srv-workspace-rca-ab-test-rca-front--`、`--srv-workspace-google~0020tend--`、`--srv-workspace--`
- session 目录 164 个，`session.v4.jsonl.zstd` 164 个（共 21,538,669 字节），另有 164 个 `lock` 文件
- 日志 mtime：最早 2026-11-19 01:32:13，最晚 2026-11-20 15:17:57
- 接口给出的事实：`sessionFiles 164, failed 0, usageEvents 3638, firstUsageAt 2026-11-19T02:17:05+08:00, lastUsageAt 2026-11-20T15:18:36+08:00`，累计 billed 251,509,825（未命中缓存输入 87,901,758 / 输出 1,816,963 / 缓存读 161,791,104 / 缓存写 0），共 2 天、2 个模型：`deepseek/deepseek-v4.1-flash`、`kiro/claude-opus-5.5`。一次热刷新约 31 ms（复用 161 个，重解析 3 个）。

### A3 真实样本核对（随机抽 1 个，只打印字段名和 usage）
样本：`/root/.dsh/sessions/--srv-workspace-rca-ab-test--/29a43478-…/session.v4.jsonl.zstd`，共 42 行。
- 事件顶层键：`type, seq, time, data, surfaceOp`
- `assistant/message` 的 data 键：`turn, step, message, usage, stream`
- usage 示例：`{"inputTokens":1870,"outputTokens":199,"totalTokens":12437,"cacheReadTokens":10368}`
  → billed = 1870+199+10368 = 12437，正好等于 `totalTokens`，说明口径与 provider 总数一致（这个样本没有 cacheWriteTokens）。
- `request/context` 的 `data.model = deepseek/deepseek-v4.1-flash`：同一文件里后续 usage 都归到这个模型。
- 和机器相关的内容：42 行里有 12 行含 `/srv/workspace`（例如 `working-directory/change.data.cwd`），没有行含 `/root/`。scanner 不读这些字段。

### A4 换机行为
- **不搬 sessions**：`readdir` 返回 ENOENT 时得到空列表，不报错（`scanner.js:238-242`）。目录为空时结果也一样。接口仍然返回 200，totals 全是 0。前端只在 `totals.billed > 0` 时显示数据（`TokenStats.tsx:258`），否则显示空态："暂无用量数据 / 运行一次会话后，这里会显示真实 token 消耗（按模型、按天）"（`TokenStats.tsx:333-335`，`locales.ts:38-39`）。面板显示的是空态，不是 0 也不是报错。只有接口不可达时才显示"读不到用量统计"（`TokenStats.tsx:322-326`）。其它 readdir 错误（例如权限）会被 `document()` 捕获，仍然渲染全 0 的文档（`scanner.js:225-230`）。
- **搬了 sessions**：统计会直接正确。聚合只依赖 `time`、`model` 和 usage 四个字段。项目目录名（slug）和记录里的 cwd 只用来遍历，不参与计数，所以路径不同也不会算错。新机器上 `$DSH_HOME/sessions` 下的新会话会被自动加进统计。按天分组固定用 UTC+8，新机器的时区不影响结果。
- 注意：旧会话的项目 slug（如 `--srv-workspace-…--`）如果和新机器的项目路径对不上，DSH 自己的会话列表/工作区是否还能挂上这些旧会话，**未确认**（这是 DSH 本体行为）。Token 面板不受影响。

## B. 硬编码绝对路径清单

扫描命令（排除 node_modules/.git）：
`grep -rnIE '/srv/workspace|/root/\.dsh|/srv/git|/usr/local|/home/|[A-Za-z]:\\\\' <dir>`

| 仓库 | 命中行数（全部） | 去掉 deploy/、*.bak*、lib.prev 后 |
|---|---|---|
| dsh-router-b | 209 | 23 |
| dsh-token-stats | 3 | 3 |
| dsh-egress | 21 | 21（全部在 docs/*.md） |
| dsh-vpn | 12 | 12（docs/VPN.md 11 行，tests 1 行） |

`/srv/git`、`/home/` 在源码中零命中。盘符路径只有 `docs/INTEGRATION.md:281`（`E:\PythonProject\dsh-router-b`）和 `tests/smart-route.test.mjs:3`（win32 测试夹具 `C:\w\`）。
产物：live `packages/host-router/lib/config.js` 有 1 行命中（25,380 字节，是 src/config.ts 提示词文本的编译结果）；`lib.prev`、`lib.bak-*`、`src.bak-*` 都是备份。

### B1 dsh-router-b / dsh-token-stats 有效命中（非备份）

| 绝对路径 | 位置 | 用途 | 替代建议 | 换机 |
|---|---|---|---|---|
| `/srv/workspace/rca-ab-test` | dsh-router-b/cordis.patch.yml:40 | 分区 rca-ab-test 的 root | 每台机器写自己的 profile 覆盖（`/root/.dsh/profiles/web/cordis.patch.yml`），或者在安装时用模板生成 | **换机必炸**：分区 root 不存在，按文件路由和 worker cwd 全部失败 |
| `/srv/workspace/google tend` | cordis.patch.yml:68 | 分区 google-tend 的 root | 同上 | **换机必炸**（同上） |
| `/srv/workspace/deepseek-harness` | cordis.patch.yml:90 | 分区 deepseek-harness 的 root | 同上 | **换机必炸**（同上） |
| `/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc` | scripts/safe-build-host.sh:7 | 默认 tsc，可用 `DSH_TSC` 覆盖 | 改为仓内 devDependency `typescript` 或 `npx tsc` | **换机必炸**：新机器没有这个项目时 host-router 无法构建（跨项目依赖） |
| `/usr/local/pnpm-global/store/v11/links/@types/node/26.6.6/<hash>/node_modules/@types` | packages/host-router/tsconfig.json:17 | typeRoots | 装 `@types/node` 为 devDependency，删掉 typeRoots | **换机必炸**：store 里的 hash 不同，tsc 找不到 node 类型 |
| `/root/.dsh/router/board.json` | scripts/safe-restart.sh:10 | 等待活动任务清零 | `${DSH_HOME:-$HOME/.dsh}/router/board.json` | 非 root 用户或改了 DSH_HOME 时必炸：python 打开文件失败，重启脚本中止 |
| `/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-build-host.sh` | packages/host-router/src/config.ts:739（lib/config.js:511） | 写进 worker 提示词的构建命令 | 运行时用插件自身路径（`import.meta.url`）或分区 root 拼接 | 不会起不来，但 worker 会拿到错误的命令 |
| `/srv/workspace/bin/screenshot` | src/config.ts:744 | 写进 worker 提示词的截图工具 | 改成配置项或者 PATH 里的命令名 | 同上；新机器还要另外部署这个工具 |
| `/srv/workspace/deepseek-harness`、`/.dsh-artifacts/p0-20261120`、`/root/.dsh/router/{board,anchor}.json` | scripts/rotate-anchor-and-drill.sh:6-8,27,74-82 | 一次性演练脚本 | 用脚本相对路径和 DSH_HOME | 失效，但只是一次性脚本 |
| `/srv/workspace/deepseek-harness/dsh-vpn` | packages/host-router/tests/tier.test.mjs:15 | 测试用例里的文本 | 不需要改 | 不影响 |
| `/root/.dsh/sessions/...` | dsh-token-stats/packages/host-token-stats/scanner.js:6 | 只在注释里 | 不需要改（代码已用 DSH_HOME） | 不影响 |
| `/root/.dsh/profiles/web` | dsh-token-stats/scripts/install.mjs:18-19 | 用法注释，`--profile` 是参数 | 不需要改 | 不影响 |

deploy/*.sh（大约 180 行）是早期一次性运维脚本，不在运行链路上，主要命中：
- `/usr/local/pnpm-global` 及 store hash：B1、B8、26、30 等
- `/root/.dsh/.credentials.yaml`：60、64、C0、D1、D7（只读字段名）
- systemd 单元：30-dsh-service.sh:37-40，`ExecStart=/usr/local/pnpm-global/bin/dsh --profile web ... --port 42443`
- 项目路径：10、12、13、50、80-83
- docs：ACCESS.md、GITEA-SYNC.md、REQUIREMENTS-v2.md:147,152

这些全部归 P2。如果新机器要照着重新部署，deploy 脚本需要逐个改 PNPM_HOME 和 store hash。

dsh-egress/dsh-vpn 的命中都在 docs 里（`/root/.dsh/profiles/web`、`/srv/dsh-*`、`/usr/local/bin/mihomo-egress` 等）。代码用的是 `$DSH_HOME/egress`、`$DSH_HOME/vpn`（见 VPN.md:106）。

### B2 系统层符号链接（仓库外，审计时发现）
`/srv/dsh-router-b`、`/srv/dsh-egress`、`/srv/dsh-vpn` 是软链，分别指向 `/srv/workspace/deepseek-harness/dsh-{router-b,egress,vpn}`（`ls -ld /srv/dsh-*`）。新机器上必须重建这些软链，或者改掉 profile 里的 link 路径。

### B3 /root/.dsh 配置类文件命中
扫描时排除了 sessions、projcache、attachments、cache、`.credentials*`、`*.bak*`。

| 文件:行 | 路径原文 | 层级 | 换机 |
|---|---|---|---|
| profiles/web/package.json:5-13 | `link:/srv/dsh-router-b`、`/srv/dsh-egress`、`/srv/dsh-vpn` 及其 `/packages/*`（9 条） | **profile 覆盖层**（插件挂载） | **换机必炸**：软链缺失时插件加载失败，路由、出口、VPN 面板全部消失 |
| profiles/web/package.json:14-16 | `link:/srv/workspace/deepseek-harness/dsh-token-stats[/packages/host-token-stats, client-ui-token-stats]` | profile 覆盖层 | **换机必炸**：Token 面板直接消失（插件没装上），不会显示空态 |
| profiles/web/node_modules/* | 9 个软链，目标同上（绝对路径） | profile 覆盖层 | **换机必炸**：需要重新执行 install.mjs 或重建软链 |
| profiles/web/pnpm-lock.yaml:12-23 | `file:/srv/dsh-router-b`、`../../../../srv/dsh-router-b/...`（13 行，是旧锁） | profile 覆盖层 | 重新 install 时会重新生成 |
| storages/workspace.json:19,28,42 | `/srv/workspace/rca-ab-test`、`/srv/workspace`、`/srv/workspace/google tend` | DSH 工作区注册表（另有一个 deepseek-harness 工作区，因为路径以 `/srv/workspace` 开头，按行计数时未单列） | 路径不存在时左侧工作区失效，具体症状**未确认**；可在 GUI 里重新添加 |
| storages/schedule.json | 6 处命中，都在定时任务的 prompt 文本里 | DSH 定时任务 | 提示词指向的路径失效 |
| router/board.json | 1157 处 `/srv/workspace…` | **router 状态文件**（任务历史、files、cwd） | 只是历史数据；搬过去不会导致起不来，旧任务的 resume 会失效 |
| router/snapshot.json（135 处）、board.json.tmp-*（3 个残留 tmp 文件，104/148/199 处） | 同上 | router 状态 | 同上；tmp 文件可以不搬 |
| router/anchor.json、seams.json、tiers.json | 0 处 | router 状态 | anchor 里存的是 sessionId，不搬 sessions 时作战室会话需要重建（create-or-resume，`bridge.ts:704-711`） |
| profiles/web/cordis.patch.yml、cordis.yml、pnpm-workspace.yaml | 0 处 | profile 覆盖层 | 不影响（分区 root 来自 bundle 自带的 `dsh-router-b/cordis.patch.yml`） |
| egress/config.json、vpn/profiles.json、profiles/headless/* | 0 处 | 其它插件数据 | 不影响 |

router 状态目录的计算方式：`$DSH_HOME ?? ~/.dsh` 下的 `router`（`host-router/src/index.ts:283-284`）。这里没有硬编码。

### B4 按层级分类
- **项目目录级**（新机器大概率不同，例如 `/home/xx/...`）：`/srv/workspace/deepseek-harness`、`/srv/workspace/rca-ab-test`、`/srv/workspace/google tend`、`/srv/workspace/bin/screenshot`、`/srv/dsh-*` 软链，以及 profile 里 `link:/srv/workspace/deepseek-harness/dsh-token-stats`
- **用户配置级**（`/root/.dsh` 可能同名但内容不同，非 root 用户时是 `~/.dsh`）：`/root/.dsh/router/board.json`（safe-restart.sh:10）、`/root/.dsh/profiles/web/*`、`storages/workspace.json`。插件代码本身都走 `DSH_HOME`
- **跨项目依赖**：`/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc`（safe-build-host.sh:7）
- **系统安装级**：`/usr/local/pnpm-global/store/v11/links/@types/node/26.6.6/<hash>`（tsconfig.json:17），以及 deploy 里的 `/usr/local/pnpm-global/bin/dsh`

## C. 结论

### Token 面板换机可用性
- 插件自己没有路径硬编码。只要 profile 里能挂上 `dsh-token-stats`，它就从 `$DSH_HOME/sessions` 读数据（默认 `~/.dsh/sessions`）。
- **必须搬的**：要保留历史用量，就把 `/root/.dsh/sessions`（23 MB，164 个会话）整目录拷到新机器的 `$DSH_HOME/sessions`。建议一起拷 `storages/session_projcache`（2.5 MB，DSH 本体用），保留目录结构即可。
- **搬了会不会错**：不会。计数只用 `time`、`model`、usage 四个字段，记录里的 cwd 和 slug 不参与计数。按天分组固定 UTC+8。
- **不搬**：面板显示空态"暂无用量数据"，不报错。新会话产生后会自动开始计数。
- **真正的风险在挂载**：profile `package.json:14-16` 的 `link:/srv/workspace/deepseek-harness/dsh-token-stats...` 路径不对时，面板直接消失。
- **最省事的做法**：新机器上把仓库放到同样的 `/srv/workspace/deepseek-harness`（或者建同名软链），然后拷 `/root/.dsh/sessions` 和 `storages/session_projcache`。如果路径不同，就用 `node dsh-token-stats/scripts/install.mjs --profile <新 profile>` 重新挂载。

### 绝对路径改造优先级
**P0 必改（不改就起不来）**
1. `/root/.dsh/profiles/web/package.json:5-16` 的 12 条 `link:` 绝对路径，加上 `profiles/web/node_modules` 的 9 个软链，加上系统软链 `/srv/dsh-router-b`、`/srv/dsh-egress`、`/srv/dsh-vpn`。改法：在新机器上对每个 bundle 重新执行 `scripts/install.mjs --profile <profile>`，按新路径生成。
2. `dsh-router-b/cordis.patch.yml:40,68,90` 的分区 root：`/srv/workspace/rca-ab-test`、`"/srv/workspace/google tend"`、`/srv/workspace/deepseek-harness`。改法：把分区移到每台机器自己的 profile `cordis.patch.yml` 覆盖层，bundle 里只留示例。
3. `dsh-router-b/scripts/safe-build-host.sh:7` 的 `/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc`。改法：给 host-router 加 devDependency `typescript`，默认用 `node_modules/.bin/tsc`。
4. `dsh-router-b/packages/host-router/tsconfig.json:17` 的 typeRoots `/usr/local/pnpm-global/store/v11/links/@types/node/26.6.6/<hash>/node_modules/@types`。改法：加 devDependency `@types/node`，删掉 typeRoots。
5. `dsh-router-b/scripts/safe-restart.sh:10` 的 `BOARD=/root/.dsh/router/board.json`。改法：`BOARD="${DSH_HOME:-$HOME/.dsh}/router/board.json"`。只要新机器还是 root 且没改 DSH_HOME，这一条不会坏。

**P1 建议改**
- `host-router/src/config.ts:739,744` 写进 worker 提示词的 `/srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-build-host.sh` 和 `/srv/workspace/bin/screenshot`。改法：改成配置项，或用插件目录在运行时拼接（改完要用 safe-build-host 构建，并由人工 safe-restart）。
- `/root/.dsh/storages/workspace.json` 里的 3 个以上工作区路径。改法：在新机器 GUI 里重新添加工作区，不要手改 JSON。
- `storages/schedule.json` 里 prompt 中的路径。改法：在 GUI 里编辑这些定时任务。

**P2 可忽略**
- `dsh-router-b/deploy/*`（大约 180 行，一次性运维脚本）、`scripts/rotate-anchor-and-drill.sh`（一次性演练脚本）
- 各仓库 docs/*.md，以及 `*.bak*`、`lib.prev`、`src.bak-*` 备份
- 测试夹具（`tier.test.mjs:15`、`smart-route.test.mjs:3`、`vpn.test.mjs:441`）
- `scanner.js:6` 和 `install.mjs:18-19` 的注释
- `router/board.json` 和 `snapshot.json` 里的历史路径（只是历史；router/*.tmp-* 可以不搬）

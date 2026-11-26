# dsh-router-b：分区路由 · 作战室 · 任务板

## 这是什么

把“要做的事”按**工作区**（代码里叫 partition / 分区）自动分派给 worker：你在「作战室」对话里像聊天一样说需求，路由器判断它属于哪个工作区，在该工作区的目录下开一个 worker 会话去做。

右侧的「任务板」实时显示每个任务的进度，并且严格区分 **worker 自己说做完了（待验收 `reported`）** 和 **真正验收通过（`verified`）**——只有验收命令通过或人点了「通过验收」才算完成。

## 装好后在哪里看到

- **左侧栏一行「打开作战室对话」**（英文 “Open war-room chat”）：打开作战室会话。每次打开页面也会自动落到作战室。
- **左侧栏底部「模型档位」卡片**：设置初级 / 中级 / 高级任务各用哪个模型、推理强度，以及「自动按难度选择」开关。保存后下一次派工生效。
- **会话标题栏右侧的「任务板」按钮** → 右侧栏打开「任务板」标签页：
  - 分段：**现在 / 排队 / 排程 / 已结束 / 工作区**；「工作区」里能看每个工作区的根目录、文件树、配置问题、未完成任务和长期备忘。
  - 左侧小栏：项目列表和 API Key 状态（默认检查 `DEEPSEEK_API_KEY`、`EXA_API_KEY` 是否已配置，只显示有没有，不显示值）。
  - 可以对待验收任务「通过 / 退回」、启用 / 停用工作区、改派、挂起 / 继续、取消。
  - **扩展标签页**：其他插件可以往任务板里加标签页（见下文「任务板扩展标签页」），例如装了 dsh-agent-hub 后会多一个「Agent」标签。
- **对模型开放的工具**（作战室和 worker 用）：

  | 类别 | 工具 |
  |---|---|
  | 派工与查看 | `route_task`、`partition_list`、`task_board`、`task_progress`、`task_wait` |
  | 会话 | `session_list`、`session_read`、`task_resume` |
  | 任务控制 | `task_control`（取消等）、`task_suspend`、`task_reassign` |
  | 工作区备忘 | `partition_memory` |
  | 代码托管 | `git_publish`、`pr_status`、`pr_merge`（合并一定要人在面板上批准） |
  | 服务器 / 浏览器 | `ops_run`（危险命令会先问人）、`browser_capture`（无头浏览器截图） |

## 必须配置

### 工作区列表 `partitions`（至少一个）

**放在哪**：推荐写在 profile 的 `<profile>/cordis.patch.yml`（例如 `~/.dsh/profiles/web/cordis.patch.yml`），按 id `host-router` 覆盖；也可以直接改本插件根目录的 `cordis.patch.yml`（但更新插件时容易被覆盖）。

> ⚠ 本插件自带的 `cordis.patch.yml` 里是作者服务器上的三个工作区（`rca-ab-test`、`google-tend`、`deepseek-harness`），`root` 都是 `/srv/workspace/...` 这种**服务器本机路径**。换一台机器必须改成那台机器上真实存在的绝对路径。

**示例**（Windows 机器 MYDESK）：

```yaml
- id: host-router
  name: dsh-host-router
  config:                      # 整段 config 会替换掉插件自带的那段，不做合并，下面几项要一起写上
    manager: true
    maxWorkers: 0
    autoVerify: false
    partitions:
      - name: deepseek-harness           # 工作区名：唯一，也是 dsh-agent-hub 用的工作区名
        root: E:/PythonProject/dsh-warroom   # 必须是本机绝对路径，也是 worker 的工作目录
        description: DSH 插件源码（router-b、egress、vpn、secrets、token-stats、agent-hub）
        keywords: [dsh, harness, router, egress, vpn, 插件]
        exclude: ['**/node_modules/**']
        workers: 0                        # 该工作区并发 worker 上限，0 = 不限
        # verify: ['node scripts/build.mjs']   # 验收命令；不写就只能停在「待验收」等人裁决
```

**不配 / 配错的后果**：

- 一个工作区都没有：插件启动失败，报 `at least one partition is required`。
- `root` 不是绝对路径（例如在 Linux 上写了 `E:/...`）：插件启动失败，报 `partition "<名字>" needs an absolute root`。
- `root` 是绝对路径但本机不存在（直接沿用了作者的 `/srv/workspace/...`）：插件能启动，但派到这个工作区的 worker 工作目录不存在，按文件路由也会失败。
- 名字重复：报 `duplicate partition name "<名字>"`。

**和 dsh-agent-hub 是同一套名字**：dsh-agent-hub 的 `task_dispatch` 里的 `workspace`、`agent_approve` / `agent_provision` 的 `workspaces`、以及远端 worker 配置里 `workspaces` 的键，填的都是这里的**工作区名**（例如 `deepseek-harness`），不是路径。名字要两边一致；路径各台机器各写各的（服务器上写服务器的路径，worker 机器上在它自己的配置里写本机路径）。

## 可选配置

### 路由器整体（`host-router` 的 `config` 下）

| 键 | 默认值 | 含义 |
|---|---|---|
| `boardDir` | `<DSH home>/router` | 任务板数据目录。**不要写 `boardDir: null`**，会启动失败；不想改就别写这一项 |
| `defaultPartition` | 无 | 需求哪个工作区都判断不出来时落到哪里；不配则直接报错让你点名 |
| `maxWorkers` | `8`（插件自带配置写的是 `0`） | 所有工作区合计的同时运行 worker 上限，`0` = 不限 |
| `manager` | `true` | 每个工作区是否有一个常驻 manager 先拆解任务 |
| `autoVerify` | `true`（插件自带配置写的是 `false`） | worker 汇报后是否自动跑验收命令 |
| `verifyTimeoutMs` | `600000` | 单条验收命令超时 |
| `maxRetries` | `1` | 预留项，当前代码没有使用（不会自动重试） |
| `contextLimitTokens` | `262144` | 会话已用上下文超过这个数就不再往里追加任务，`0` = 不检查 |
| `defaultPreset` | `standard` | 作战室和未指定 preset 的工作区使用的 agent preset |
| `provider` / `maxDepth` | `spawn` / `2` | subagent 后端 / 委派递归深度上限 |
| `autoRouteMinScore` | `4` | 关键字打分达到多少就不再问模型分类器 |
| `classifierTimeoutMs` | `20000` | 模型分类器超时 |
| `resumeDelayMs` | `8000` | 重启后多久恢复被中断的任务 |
| `credentialRefs` | DeepSeek（`DEEPSEEK_API_KEY`）、Exa（`EXA_API_KEY`） | 左侧小栏里显示“是否已配置”的凭据名单 |
| `progressNotices` / `progressNoticeDelayMs` | `true` / `3000` | 任务挂起、继续、前置失败时往作战室发【进度提醒】。manager / worker 用 `task_control block` 停下来问人时也会发（「需要你决定」）；这类提问不受 60 秒间隔限制，也不会被后面的进度合并掉，作战室会直接问你 |
| `stallNoticeMinutes` | `20` | 在跑的 worker 日志多少分钟没有新动静，就在作战室提醒一次「没有动静」并问你怎么办；`0` 关掉 |
| `anchorCompactTokens` | `300000` | 作战室上下文超过这么多 token 时，等它这一轮说完、空闲下来就自动压缩一次（和 `/compact` 一样）；`0` 关掉。DSH 自带的自动压缩配置在 agent 预设里，网页模式下 profile 改不到，大窗口模型要到约 55 万才触发。**不管谁触发的压缩**，压完都会补发一条【作战室状态】：本机看板上没结束的任务，以及还在等你回答的问题（只记 DSH 这次启动以来的，最多 48 小时） |
| `screenshotCommand` | `/srv/workspace/bin/screenshot` | `browser_capture` 用的截图命令（换机器要改） |
| `hostScripts` | 无 | `build`（构建宿主代码、不动在跑的那份）/ `restart`（安全重启，人来跑）。配了才写进 worker 提示，不配就不提 |
| `quick` | 开启（目录 = 用户主目录，并发 2） | 「快任务」：不属于任何工作区的小活；写 `false` 关闭 |

### 每个工作区（`partitions` 里的每一项）

| 键 | 默认值 | 含义 |
|---|---|---|
| `name` | 必填 | 工作区名，唯一 |
| `root` | 必填 | 本机绝对路径，worker 的工作目录 |
| `include` / `exclude` | `['**']` / 无 | 相对 `root` 的 glob，决定哪些文件属于这个工作区 |
| `description` | 无 | 一两句话，给模型分类器判断归属用 |
| `keywords` | 无 | 文本里出现这些词就倾向派到这里 |
| `workers` | `2` | 该工作区并发 worker 上限，`0` = 不限 |
| `verify` | 无 | 验收命令列表，在 `root` 下执行；没有就只能到「待验收」 |
| `brief` | 无 | 每个 worker 都会收到的常驻说明 |
| `preset` | 跟随 `defaultPreset` | 该工作区使用的 agent preset |
| `network` | 无 | `intranet` / `internet` / `offline`，告诉 worker 网络条件 |
| `git` | 无 | `branch`、`rule`，以及 `scm`（`provider`、`repo`、`baseUrl`、`tokenEnv` 等）——配了 `scm` 才能用 `git_publish` / `pr_*` |
| `outlets` | `git` / `ops` / `browser` 都是 `allow` | 每类对外操作 `off` / `confirm` / `allow`（危险命令和合并始终要人批准） |
| `manager` | 跟随全局 `manager` | 覆盖该工作区是否有 manager |

用 `git.scm` 时，代码托管的 token 默认从进程环境变量 `GITHUB_TOKEN` / `GITEA_TOKEN` 读取（可用 `tokenEnv` 改名）。请放进启动 DSH 的进程环境；不要起 `DSH_` 开头的名字写进 `<DSH home>/.env`（DSH 会拒绝启动）。

### 数据存在哪

`<DSH home>/router/`（`<DSH home>` = `DSH_HOME`，没设时是 `~/.dsh`）：`board.json`（任务板）、`anchor.json`（作战室会话）、`tiers.json`（模型档位）、`seams.json`（启动自检）、`snapshot.json`、`memory/`（工作区备忘）、审批与审计记录。

## 任务板扩展标签页（board-tabs）

任务板留了一个给其他插件用的扩展点：别的插件在页面全局对象 `globalThis.__dshRouterBoardTabs__` 上注册一个标签页（id、顺序、标题、组件，可选角标和提醒点），任务板就把它画在内置分段后面；任务板启动时会声明自己是“消费者”，没装 router-b 时，生产方可以退回到自己的侧栏行。dsh-agent-hub 的「Agent」标签就是这么接进来的。实现在 `packages/client-ui-router/src/client/board-tabs.ts`，该文件在 dsh-agent-hub 里有一份**逐字节相同**的副本，要改两边一起改。

## 安装与更新

```bash
# 1. 构建（宿主侧 TypeScript 编译 + 浏览器侧 lib/client.js）
node scripts/build.mjs        # 宿主编译需要 TypeScript ≥ 5.7，可用 DSH_TSC 指定 tsc

# 2. 装进 profile（幂等；先 --dry-run）
node scripts/install.mjs --profile ~/.dsh/profiles/web --dry-run
node scripts/install.mjs --profile ~/.dsh/profiles/web
#   加 --disable-brand：停用官方品牌插件，让本插件接管左上角的标志和名称

# 3. 重启拥有这个 profile 的 DSH 进程
```

安装脚本只在 profile 的 `package.json` 写三条 `link:` 依赖、把 `dsh-router-b` 加进 `dsh.profile.bundles`、在 `node_modules` 下建目录链接；**不跑包管理器**，也没有卸载参数（卸载见 [docs/UPGRADE.md](docs/UPGRADE.md)「回滚」）。服务器上可用 `scripts/safe-build-host.sh`（构建到 `lib.next/`）+ `scripts/safe-restart.sh`（等在飞任务结束后安全重启、失败自动回滚）。想让 worker 知道这两个脚本，把它们的路径写进 `hostScripts.build` / `hostScripts.restart`。

装完检查：`<DSH home>/router/seams.json` 里 `ok: true`；左侧栏有「打开作战室对话」；任务板显示的是真实工作区而不是「示例数据」。

## 常见问题

- **任务板显示「示例数据」**：浏览器连不上宿主侧（`/api/router/*`）。确认插件已装好并重启；经反向代理访问时，代理必须转发 WebSocket upgrade，否则页面能打开但一直“重新连接中”、工作区和会话全是空的。
- **插件页报 `partition "xxx" needs an absolute root`**：要么 `root` 写错，要么把子包 `dsh-host-router` / `dsh-client-ui-router` 误写进了 `dsh.profile.bundles`（它们是库，不是 bundle）。删掉这两项（重跑 `install.mjs` 会自动清理）。
- **worker 提示里的规则**：验收命令只由路由器在 worker 结束后跑一次，worker 不自己再跑；worker 只跑和改动相关的测试，不先探测环境；manager 默认一个 worker，三步以上或跨区域才拆。
- **任务一直停在「待验收」**：这个工作区没配 `verify`，或 `autoVerify: false`（插件自带配置就是 `false`）。在任务板上人工「通过 / 退回」，或给工作区配验收命令并打开 `autoVerify`。
- **派工报“两个工作区同分，请点名”**：路由器不猜，直接在需求里写工作区名，或补充 `keywords` / `description`。
- **改了 `cordis.patch.yml` 不生效**：配置只在启动时读，改完要重启 DSH。
- **不要在 profile 里跑 `pnpm install`**：会重写整棵依赖树，曾经把正在用的包删空。
- **`browser_capture` 失败**：`screenshotCommand` 默认是作者服务器上的 `/srv/workspace/bin/screenshot`，换机器要改。

## 更多文档

- [docs/DETAIL.zh.md](docs/DETAIL.zh.md) / [docs/DETAIL.md](docs/DETAIL.md)：功能简介（中 / 英）。
- [docs/UPGRADE.md](docs/UPGRADE.md)：换机器、DSH 升级后怎么办、回滚、已知陷阱。
- [docs/HANDOFF.md](docs/HANDOFF.md)：交接说明与历次改动记录。
- [docs/INTEGRATION.md](docs/INTEGRATION.md)：两个半边之间的接口契约、状态映射、端点清单。
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/REQUIREMENTS-v2.md](docs/REQUIREMENTS-v2.md)、[docs/ROADMAP.md](docs/ROADMAP.md)。
- [packages/host-router/README.md](packages/host-router/README.md)：宿主侧（分区配置、路由规则、状态机）。
- [packages/client-ui-router/README.md](packages/client-ui-router/README.md)：界面侧（挂载方式、扩展标签页）。
- 仓库根目录 `docs/README-MIGRATE.md` 第 3 节：迁移时必须改的路径。

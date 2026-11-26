# 架构说明（第二期：出口 + 作战台 + 日夜主题）

这份文档写给以后的自己：**每个模块是干什么的、怎么做的、依赖了 DSH 的哪些接口**，以及 DSH 升级时按什么顺序核对。安装与回滚见 [UPGRADE.md](./UPGRADE.md)，需求与分期见 [ROADMAP.md](./ROADMAP.md)。

一句话：整个功能都在 `plugins/dsh-router-b` 里，**没有改 DSH 本体一行代码**。宿主半边只用 DSH 公开的 `tools`、`subagents`、`sessionQuery`、`webServer` 等挂载点；浏览器半边只用 client slot。其余全部是本仓库自己的代码。

---

## 一、整体链路

```
你（面板 / 作战室对话）
   │  发需求
   ▼
routing（route_task）──► manager（每个工作区一个，默认最强模型）
                            │  编排、读本区记忆与 session
                            ▼
                        worker（subagent，cwd = 分区根）
                            │  干活时用到的“出口”
                            ▼
      ┌──────────── outlets（出口层，宿主侧统一把关）────────────┐
      │ git_publish  推分支、开/更新 PR      → 默认放行，可撤回    │
      │ pr_status    读 PR 与检查结果        → 只读                │
      │ pr_merge     合并 PR                 → 永远要你确认        │
      │ ops_run      服务器命令，按风险分级  → 危险命令要你确认    │
      │ browser_capture 无头截图 / 取正文    → 域名白名单          │
      └──────────────────────┬────────────────────────────────────┘
                             │ 需要确认的动作 → approvals.json（确认队列）
                             │ 所有动作       → audit/YYYY-MM.jsonl（审计）
                             ▼
             HTTP 桥 /api/router/*  ──►  面板（看板 + 等你确认 + 实时输出 + 改派 + 批量）
```

---

## 二、宿主侧模块（`packages/host-router/src`）

| 文件 | 干什么 | 关键点 |
|---|---|---|
| `index.ts` | 插件入口：注册全部工具、派发 worker、挂 HTTP 路由、启动自检 | 只在这里碰 DSH 挂载点；其他模块都是纯函数或接口注入 |
| `config.ts` | 读并校验分区配置 | 新增 `git.scm`、`outlets`、`screenshotCommand`，写错启动即报错并指出哪个分区 |
| `scm.ts` | **代码托管适配器**：GitHub 与 Gitea 同一接口 | 只有 6 个操作：默认分支、找 PR、开 PR、改 PR、读检查、合并。换 Gitea 只改配置 `provider: gitea` + `baseUrl` |
| `outlets.ts` | **出口层**：命令分级、策略判断、确认队列、审计、git/截图执行 | 见第三节 |
| `live.ts` | 把 worker 的 session 日志切成“一条命令一段”的实时输出 | 出错的段（工具报错，或输出像失败）标红；仍在跑的命令标 `running` |
| `memory.ts` | 分区记忆：近期工作、session 摘要（第一期） | `live.ts` 复用它的参数预览与文本提取 |
| `bridge.ts` | HTTP 桥：`/api/router/*` 全部路由 | 只做参数校验与转发，业务都在 `index.ts` 的处理函数里 |
| `board.ts` / `snapshot.ts` | 看板文件与对外的看板快照 | 任务行新增 `pr`、`reassignedTo/From`、`provider/model` |
| `dispatch.ts` | 启动 / 续写 / 取消 worker | 改派复用它，没有新的 DSH 调用 |

### 新增工具（模型可调用）

| 工具 | 作用 |
|---|---|
| `git_publish` | 在本分区的工作分支提交指定文件、推送、开或更新 PR；拒绝推默认分支；文件路径必须在分区根内 |
| `pr_status` | 读 PR 状态与检查（GitHub check-runs + commit status；Gitea 走 commit status） |
| `pr_merge` | 申请合并：**只生成确认卡**；你同意时再核对一次 PR 头提交没变才合，变了就作废 |
| `ops_run` | 跑服务器命令：`read` 直接跑，`change` 按策略，`danger` 永远要确认 |
| `browser_capture` | 无头截图或取正文，存到 `.dsh-artifacts/<任务>/shot-*.png`；只允许 http(s)，受域名白名单约束 |
| `task_reassign` | 改派 / 换模型（面板也能做，见第四节） |

### 新增 HTTP 路由

| 路由 | 说明 |
|---|---|
| `GET /api/router/approvals` | 待确认与最近处理过的卡片 |
| `POST /api/router/approvals` `{id, decision: approve\|reject, note?}` | 同意只执行这一次；拒绝时备注会转告执行者 |
| `GET /api/router/audit?limit=` | 最新审计记录 |
| `GET /api/router/live?taskId=&after=` | 某任务 `after` 之后的输出段（增量拉取） |
| `POST /api/router/reassign` `{taskId, partition?, model?, keepProgress?, note?}` | 改派 / 换模型 |
| `POST /api/router/batch` `{taskIds(1..200), action, value?}` | 批量：`cancel` / `cancel_tree` / `retry` / `suspend` / `resume` / `reassign` |
| `GET /api/router/tiers` | 现在也返回可选模型列表（换模型下拉用） |

**所有 `/api/router/*` 都要求登录**（2026-11-22 实测后补）。DSH 自己的登录检查挂在 `/api` 这个前缀上，而插件注册的 `/api/router/...` 前缀更长，web server 会优先匹配插件路由，于是登录检查根本不会执行：不登录也能读看板、点「同意」。现在每条桥路由外面包了一层 `requireLogin`（`index.ts`），调用 DSH `connection` 服务的 `requestRejection(req)`：没登录 401，没有登录服务 503。egress、vpn、token-stats 三个插件的桥同样处理（各自的 `src/login.ts` / `bridge.js`）。

---

## 三、出口层怎么把关（`outlets.ts`）

1. **策略**：每个分区 `outlets: { git, ops, browser }` 各取 `off`（拒绝）/ `confirm`（每次问你）/ `allow`（放行），默认都是 `allow`。另有：
   - `danger: [正则…]` 本分区额外的危险命令；
   - `browserAllow: ["example.com", "*.example.com"]` 浏览器能开的域名，空表示不限。
2. **两条不受策略影响的底线**：合并 PR 永远要确认；危险命令永远要确认。没有“以后都同意”。
3. **命令分级**（`classifyCommand`）：管道和 `;`、`&&` 拆开逐段看；每段都是已知只读命令才算 `read`；命中危险模式算 `danger`；其他算 `change`。危险模式锚定在“命令位置”，所以 `docker run --rm` 不会因为带 `rm` 被误判。
4. **确认队列**：`<boardDir>/approvals.json`。卡片写清：做什么、对什么（分支 / PR 链接 / 命令 / 网址）、为什么、能不能撤回。24 小时没人处理自动过期。同意后执行结果写回卡片并通知执行者。
5. **审计**：`<boardDir>/audit/YYYY-MM.jsonl`，每条动作记“申请 → 同意/拒绝 → 执行结果”。
6. **令牌**：只从环境变量（默认 `GITHUB_TOKEN` / `GITEA_TOKEN`，可用 `git.scm.tokenEnv` 改名）在调用时读取，不落盘、不进日志；托管方返回的报错里像令牌的字符串会被抹掉。

配置示例（分区片段，域名均为占位）：

```jsonc
{
  "name": "site",
  "root": "/srv/site",
  "git": {
    "branch": "dsh/work",
    "scm": { "provider": "github", "repo": "owner/site" }
    // 换 Gitea： { "provider": "gitea", "repo": "owner/site", "baseUrl": "https://git.example.com" }
  },
  "outlets": {
    "git": "allow",
    "ops": "confirm",
    "browser": "allow",
    "danger": ["\\bcertbot\\s+delete\\b"],
    "browserAllow": ["example.com", "*.example.com"]
  }
}
```

---

## 四、作战台三项扩展

### 改派 / 换模型
- 入口：任务行「改派」、实时输出面板里的「改派 / 换模型」、批量里的「改派到…」、工具 `task_reassign`。
- **接着做**：把原任务已完成的清单、最近输出、失败原因一起交给新执行者；**从头来**：只带原始需求。
- 旧行标“已改派 →”，新行标“← 改派自”，点一下就搜到对方；依赖旧任务的下游改为依赖新任务；manager 收到通知。
- 一个任务只能改派一次（再改派请对新任务操作）；工作区和模型都没变时拒绝。

### 实时输出
- 宿主按 session 日志切段：一条命令一段、执行者的话一段、回合结束一段。面板每 2 秒增量拉取（按 `seq` 合并），后台标签页不拉。
- 出错段红色，可一键「只看出错」；自动跟随到底部，你往上翻就暂停跟随并显示「回到最新」。
- 面板里直接「停止」（点两次）、「改派」、「换模型」。

### 批量
- 看板头部「批量」按钮进入。按 **状态 / 工作区 / 失败原因** 筛选；失败原因自动归类（去掉路径、数字、哈希后相同的算一类），最多的几类直接显示成可点的条。
- 勾选后选动作，**二次确认**列出将要处理的任务；执行后给出 成功 N / 失败 N 以及每个失败的原因，失败的保持勾选方便重试。

---

## 五、浏览器侧模块（`packages/client-ui-router/src/client`）

| 文件 | 干什么 |
|---|---|
| `contract.ts` | 宿主与面板之间的数据形状（新增审批、审计、实时输出、模型、改派、批量） |
| `source.ts` | 数据源：HTTP 实现所有新接口；方法都是可选的，宿主没有某接口时面板自动隐藏对应按钮 |
| `controller.ts` | 面板状态与动作；`canApprove / canReadLive / canReassign / canBatch` 决定显示什么 |
| `mock.ts` | 示例数据（预览与测试用，域名都是 `example`） |
| `Desk.tsx` | 作战台组件：等你确认、实时输出、改派对话框、批量条，以及它们的样式 |
| `CompactBoard.tsx` | 右栏看板：把上面这些接到行上（PR 徽标、改派链接、输出/改派按钮、批量勾选） |
| `WorkspacePage.tsx` | 工作区页面，同一套主题 |
| `theme.tsx` | 日夜主题：跟随系统 / 白天 / 黑夜，手动选择存 `localStorage['dshr.theme']` |
| `styles.ts` | 设计变量：`UI_THEME.light/dark` 两套颜色 + 间距、圆角、字体栈、动效 |

### 视觉规范（简洁风格）
- 大量留白、系统字体栈（`system-ui, -apple-system, "PingFang SC", …`），不打包任何字体文件、图标或商标素材。
- 中性色 + 一个强调色（白天 `#0071e3`，黑夜 `#2997ff`）；圆角卡片、细分隔线、柔和阴影、0.2 秒过渡。
- 分段标签是胶囊形，选中为反色胶囊；搜索框、按钮都是胶囊。
- 所有颜色只通过 `--c-*` / `--st-*` 变量取值，`.dshrc[data-theme="dark"]` 一处切换，看板、工作区、确认卡、输出、批量共用。
- 有鼠标的设备上，行内按钮悬停才出现，标题不被挤；触屏一直显示。
- 尊重“减少动态效果”系统设置。

### 主题如何决定
`跟随系统` 时：DSH 外壳给 `body` 加了 `data-ds-dark-theme` 就用黑夜，否则看系统 `prefers-color-scheme`；两者变化都会实时跟上。手动选白天/黑夜后以你的选择为准。

---

## 六、依赖的 DSH 接口（升级核对清单）

**只有这些是外部依赖**，其余都是本插件自己的代码。DSH 升级后按顺序核对，每一项都写了“坏了是什么样、怎么验”。

| # | 接口 | 用在哪 | 坏了的现象 | 怎么验 |
|---|---|---|---|---|
| 1 | `ctx.tools.register` | `index.ts` 所有工具（含本期 6 个） | 模型看不到 `git_publish` 等 | 新会话问“你有哪些路由工具” |
| 2 | `ctx.subagents.startActivation / sendMessage / cancel` | `dispatch.ts`；改派、批量重试复用 | 派发、改派、重试失败 | 面板改派一条任务看新行是否进入运行 |
| 3 | `ctx.get('sessionQuery').readSession` | `snapshot.ts`、`memory.ts`、**`live.ts`（实时输出）** | 清单、记忆、实时输出为空 | 打开一条运行中任务的「输出」 |
| 4 | `ctx.inject(['webServer'])` + `register(route)` | `bridge.ts` 全部 `/api/router/*` | 面板退回“示例数据”，确认卡不出现 | `GET /api/router/approvals` 返回 JSON |
| 5 | `ctx.on('agent/created')` | 作战室锚点 | 作战室对话不认领 | 看 `seams.json` |
| 6 | client：`ctx.slots`、`layout.selectPanel`、`sidebar.panellist`、`ctx.locale.register` | `client/index.ts` | 面板或文案不出现 | 打开页面看右栏与左栏 |
| 7 | 外壳暗色标记 `body[data-ds-dark-theme]` | `theme.tsx`（只在“跟随系统”时读） | 跟随系统时不随外壳切换（手动选择不受影响） | 切外壳主题看面板是否跟着变 |
| 8 | 可选：`sandboxPolicy.registerWritableRoot`、`credentials`、`agents` | 派发与 API Key 面板 | 有就用，没有不影响主流程 | `seams.json` 中对应项 |

出口层本身**不依赖** DSH：git 走本机 `git` 命令（推送用机器自己的 git 凭据），PR 走托管方 REST，命令走 `sh -c`，截图走配置的外部命令。所以 DSH 升级不会影响它们；换机器时要确认的是 `git`、令牌环境变量和截图命令在。

### 升级步骤
1. `node scripts/build.mjs`（构建 + 宿主测试）；
2. 客户端：`node --test packages/client-ui-router/tests/desk.test.mjs`；
3. 宿主：`node --test packages/host-router/tests/outlets.test.mjs`；
4. 重启后看 `<DSH home>/router/seams.json` 的 `ok: true`；
5. 按上表 1→8 逐项点一遍。

---

## 七、测试

| 位置 | 内容 |
|---|---|
| `host-router/tests/outlets.test.mjs`（22 项） | 命令分级、域名白名单、GitHub/Gitea 适配器与令牌清洗、确认队列过期、实时输出切段；用临时 git 仓库 + 假 GitHub 跑通 推送→开 PR→更新、合并确认（头提交变化作废）、拒绝、各策略模式、截图、改派（接着做 / 从头来 / 换模型）、批量、实时输出分页；改派过的行不能再重试/继续；桥路由要求登录；快任务走快模型、不占工作区名额、可关闭 |
| `client-ui-router/tests/desk.test.mjs`（9 项） | 失败原因归类、输出合并、主题解析与两套色板、中英文案齐全、审批/输出/改派/批量走真实控制器、首屏渲染（主题、批量入口、PR 与改派链接、行内按钮） |
| 无头浏览器实点（预览页） | 白天与黑夜各一遍：确认卡、两步同意、输出面板（出错段计数）、改派对话框开关、批量全选→确认→结果、主题切换并记住；页面零报错 |

预览：`cd packages/client-ui-router && node scripts/build-preview.mjs && node scripts/serve-preview.mjs`，打开 `http://localhost:4788/?theme=light` 或 `?theme=dark`。

---

## 八、已知边界（如实）

- `ops_run` 是“受管的命令出口”，不是沙箱：worker 本身仍有 shell 工具。要强制只走出口，需要在 DSH 侧收掉 worker 的 shell（属于 DSH 配置，不在插件范围）。
- 每个需求一个独立 worktree 还没做（第三期），同一分区的并行任务共用一个工作分支。
- `git push` 用机器上已有的 git 凭据；令牌只用于 PR 的 API。
- 截图需要服务器上有无头浏览器命令（默认 `/srv/workspace/bin/screenshot`，可配置）。
- 截图命令仓库里不带：`browser_capture` 调的是外部脚本（`<命令> <url> <out.png> [--full]`），新机器要自己放一个，或在配置里用 `screenshotCommand` 指过去。
- `host-router/tests/router.test.mjs`、`bridge.test.mjs` 等老测试写死了 Windows 路径（`E:/work/...`），在 Linux 上本来就有一批跑不过；本期没有新增失败（逐项对比过）。

---

## 九、快任务

不属于任何工作区的小活（改电脑配置、跑 git 命令、装工具、查端口/进程/磁盘）不必走「路由 → manager → worker」整条链，也不该占工作区的名额。

- **内置分区 `quick`**（面板显示「快任务」）：默认开启，根目录默认是家目录。配置在路由插件的 `quick` 键：`quick: false` 关掉；`quick: { root, workers, description, outlets }` 改根目录、并发（默认 2）、描述、出口策略。用户自己声明了叫 `quick` 的分区时，以用户的为准。
- **路由规则**：作战室规则 2e 告诉路由：工作区外的小活发一条 `route_task`，`partition: quick`；纯问答仍按规则 1 直接回答。路由发出去立刻回「已派出」，结果回来再转告。
- **怎么跑**：没有 manager，直接一个 worker；强制用「初级」档（快模型），除非调用方显式指定档位。worker 的说明书是精简版（`config.ts` 的 `quickBrief`）：不写 todo、不建分支、不改工作区项目代码、危险命令一律走 `ops_run`（会生成确认卡）、答复两到五行。
- **名额**：快任务有自己的 `workers` 名额，不计入全局 `maxWorkers`，所以工作区里长任务排满时，快任务照样马上开始。
- **面板**：看板和工作区页单独一组「快任务」；它没有自己的文件（根目录是家目录，面板不浏览），启动自检也不报「include 为空」「嵌套」。

---

## 十、真机实测记录（DSH 0.2.2-rc.5，2026-11-22）

在一台干净的 Linux 上从 npm 装 `@deepseek-ai/dsh@0.2.2-rc.5`，用安装脚本装上本仓库全部插件，接一个本地「假模型」（OpenAI 兼容接口，按脚本扮演路由 / manager / worker），跑真实的 DSH 进程和真实的 subagent。

**跑通的**：路由 → manager → worker 整条链；worker 在分区目录里真的执行命令并把结果交回；危险命令变成确认卡、点同意只执行一次、再点返回「已处理」；无头截图存到 `.dsh-artifacts/`；实时输出分段；改派（接着做）；批量；档位；快任务（约 0.2 秒回「已派出」，worker 用快模型在家目录执行）；面板白天 / 黑夜两套主题。截图在项目文件 `router-preview/real-dsh-0.2.2-rc5/`。

**发现并已修**：

1. DSH 0.2.2-rc.5 要求 **Node ≥ 24.9**（文档原来写 ≥ 22）。
2. `host-router/lib/` 停在最早的提交，第一、二期的宿主功能实际上没被加载；已重新编译入库。
3. 安装脚本在全新 profile 上崩溃（`node_modules` 目录不存在）；五个插件的 `install.mjs` 都已先建目录。
4. 全新 profile 的 `cordis.patch.yml` 内容是 `[]`，`--disable-brand` 在后面追加列表项会让 YAML 失效、DSH 起不来；已处理。缺根目录提示也漏掉了带引号的路径；已修。
5. **插件 HTTP 接口不登录就能调用**（见第二节末尾）；四个插件都已加登录检查，实测未登录一律 401。
6. DSH 会在派给 worker 的说明后面直接接一句收尾语，没有换行，命令和那句话粘在一起被执行；已在说明末尾补空行。
7. 改派过的任务还能被「重试 / 继续」，同一件事会做两遍；现在会拒绝并提示去操作新的那一行。
8. manager 中途结束一轮又被叫醒时，DSH 会给作战室发「子任务已结束」通知，路由容易误报完成；作战室规则 9 要求先查 `task_board` 再汇报。

**环境注意（不是插件的问题）**：DSH 给 agent 的 shell 去掉名字里带 `KEY` / `TOKEN` / `SECRET` / `PASSWORD` 的环境变量。如果启动 DSH 的进程设置了 `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_n`，`KEY_n` 会被去掉而 `COUNT` 留着，worker 里所有 git 命令都会报 `missing config key GIT_CONFIG_KEY_0`。启动 DSH 前别设这组变量（改用 `git config --global`）。

**没有 API key 测不了的**：真实模型的判断质量（路由分区、manager 拆任务、档位分类器）；对真实 GitHub / Gitea 推分支、开 PR、合并（需要令牌）；Egress / VPN 的真实出口和隧道。


---

## 十一、任务板标签：进行中 / 已结束 / 工作区（2026-11-22）

原来任务板有四个标签：进行中、接下来、排程任务、已结束，工作区是左侧栏的单独一页。用户反馈「接下来」和「排程任务」从没用上，查下来：

- **排程任务：根本没有来源。** 路由没有定时调度，宿主从不给任务设 `scheduledFor`（`bridge.ts` 的注释写明了 `scheduled` 没有生产者）。这个标签里实际放的是「已失效分区」（分区被删掉后留下的未完成任务），名字和内容对不上。
- **接下来：能用，但几乎碰不到。** 里面只有 `queued` 状态的任务。任务只在两种情况下排队：分区或全局 worker 名额满了，或在等前置任务（`depends_on` / `stage`）。按迁移文档的配置（`maxWorkers: 0`、分区 `workers: 0`，即不限名额），第一种永远不会发生；第二种只在 manager 分阶段派活时出现，而且通常几秒就开始了。

改法：

- 标签只剩 **进行中 / 已结束 / 工作区**。排队的任务并进「进行中」，组名「排队 · 等前置或名额」；已失效分区并进「已结束」。
- **工作区**挪进任务板第三个标签（`WorkspacePage` 的 `embedded` 形态：没有页头、单列滚动、文件树限高），左侧栏不再有「工作区」一行。独立页面组件还在，只是不再注册入口。
- 宿主不动：桥接口返回的 `buckets.scheduled` 仍恒为 0，保留只为兼容。

---

## 十二、云端信道真机实测（DSH 0.2.2-rc.5，2026-11-24）

在真 DSH 上跑 web profile（假模型），旁边起一个 dsh-hub，`controller.env` 指向它；用脚本扮演三个外部 agent（两个带 profile，一个不带）。

**跑通的**：

- 本机派的任务（路由 → 分区 worker）实时上云：`local_<profile>_<rowId>`，阶段、会话记录（含工具输出）、结果都在 hub 上，状态和路由的验收结论一致。
- 调度台和 hub 看到的是同一份账：本机任务挂在「DSH 分区」这一组里，外部 agent 按 profile 分组。
- 外部 agent 的开始、每一步、要你回答、完成、失败都变成作战室里的【进度提醒】，失败带原因；自己这台 DSH 的任务不再被当成「另一台 DSH」重复提醒。
- 断网补传：hub 停着时派的本机任务做完后，hub 一起来就补传上去（会话 11 条、结果齐全）。
- 过期：完成 12 小时后、失败 2 天后进「历史」（默认不显示，`history=include / only` 能看到）；3 天没心跳的 agent 算休眠，收在「已停用」里；7 天以上的任务压缩进 `archive/`，不会被同步再传回来。
- 没有在线 worker 的任务 DSH 立刻自己接（兜底列表写明原因）。
- 调度台亮色 / 暗色截图在项目文件 `router-preview/dispatch-desk/`（离线渲染，字体和个别按钮宽度与浏览器略有出入）。

**发现并已修**：

1. `hostRouter` 服务没挂上：`ctx.set` 对没声明过的名字直接抛错，同步插件拿不到路由，什么都没上云。改用 `ctx.provide`。
2. DSH 0.2.2 的工具结果在 `data.message` 里，原来读的是外层，上云的工具输出全是空的；会话压缩时重放的旧结果也会重复上传，现在跳过。
3. hub 推送里的 `origin` 是字符串，原来按对象判断，自己的任务被当成别人的又提醒一遍。
4. 失败提醒没有原因：hub 的失败事件现在带上错误信息。
5. 调度台：agent 正在做的活显示任务标题（原来是编号）；本机任务详情不再标「兜底」；时间线里 hub 的英文句子改成中文。

**没测的**：真实模型的判断；多台 DSH 同时连一个 hub 的长时间运行；Windows 上的路径（见 PR 里的检查清单）。

## 十三、信箱真机实测（DSH 0.2.2-rc.5，2026-11-26）

同一个控制方下两台 DSH：`web`（真实 DSH，带作战室和假模型）和 `cloud`（脚本模拟）。各自派活给同一个 worker，再各派一条没人能接的 `pool:media`。

- `web` 的作战室只收到自己发布的任务：「更新首页文案」完成（带总结和产出 `copy.md`）、「转码视频」没人接需要你决定、「补一个单测」退回队列后第 2 次完成。`cloud` 发布的「清理旧日志」「压缩图片」一条都没进来。
- 完成提醒里是完整总结，不再是一句截断的话；同一个任务的同一次执行只提醒一次。
- `web` 去接 `cloud` 的兜底任务被拒（403 `not-publisher`）；两边的 `fallback_list` 只列自己的新任务（老任务没有 `reply_to`，两边都能看到）。
- 「补一个单测」租约过期重排后，旧那次的结果被拒（409 `stale-attempt`），新那次的结果被采用。Python 客户端带 `attempt` 交结果，同样对的收、错的拒。

**顺手修**：总结以句号结尾时后面紧跟「；产出」读着别扭，现在去掉那个句号。

**没测的**：真实模型拿到「没人接，需要你决定」后会不会去 `fallback_take`；真的两台机器各跑一个 DSH。

## 十四、作战室自动压缩（DSH 0.2.2-rc.5，2026-11-26）

**为什么插件自己压。** DSH 的自动压缩（`dsh-compaction-basic`）在 `min(窗口×thresholdRatio, 窗口−maxTokens−65536)` 触发。DeepSeek v4.1 flash 窗口 100 万、输出上限 38.4 万，算下来约 55 万才压。网页模式下压缩挂在 agent 预设（`preset-standard` 的 `compaction` 组）里，profile 里加的宿主行不生效（真机验证：一次都没触发）；要改只能整段重写预设的插件清单，以后升级容易冲突。

**怎么做。** 路由插件监听作战室会话的事件：`assistant/message` 记下这次请求的上下文大小（`inputTokens + cacheReadTokens + cacheWriteTokens`，和 DSH 的 token-meter 同一个算法），`turn/end` 时若超过 `anchorCompactTokens`（默认 300000），就等作战室空闲后调用它自己预设里的压缩服务 `compactNow`（与 `/compact` 同一个调用）。正在干活时 DSH 会拒绝（busy），插件稍后再试；压缩失败则 10 分钟内不再试，免得每轮都去叫一次总结模型。

**压完补什么。** 不管是谁触发的压缩（插件、DSH 自己、`/compact`），`compaction/end` 之后插件往作战室塞一条【作战室状态】（不唤醒、不多占一轮）：本机看板上没结束的任务，以及 【进度提醒】里问过用户、还没被「完成 / 已取消」关掉的问题（同一件事只留最新一问，48 小时后过期，只记本次启动以来的）。还没被读走的旧状态消息会被替换，不会堆起来。

**真机实测**（门槛临时设成 20000，假模型按真实格式报 usage）：

| 轮次 | 作战室上下文（token） | 发生了什么 |
|---|---|---|
| 31 | 28449 | 超过门槛，这一轮结束后插件压缩（`compaction/start → summary → end`，`turn: null` 即空闲时手动压） |
| 32 | 18352 | 下一次请求带上【作战室状态】：看板上等你决定的 t…-004 |
| 35 | 20506 | 又塞了两段长文字，再次超过 → 再压 |
| 36 | 20366 | 第二段长文字跟着进来，仍超过 → 第三次压 |
| 37 | 18429 | 这次的【作战室状态】多了一条云端 worker 问的「字段名定了吗：v1 还是 v2？」 |

压到门槛以下后不再重复触发；没超过的轮次不压。

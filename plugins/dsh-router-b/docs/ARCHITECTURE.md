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
| `host-router/tests/outlets.test.mjs`（19 项） | 命令分级、域名白名单、GitHub/Gitea 适配器与令牌清洗、确认队列过期、实时输出切段；用临时 git 仓库 + 假 GitHub 跑通 推送→开 PR→更新、合并确认（头提交变化作废）、拒绝、各策略模式、截图、改派（接着做 / 从头来 / 换模型）、批量、实时输出分页 |
| `client-ui-router/tests/desk.test.mjs`（9 项） | 失败原因归类、输出合并、主题解析与两套色板、中英文案齐全、审批/输出/改派/批量走真实控制器、首屏渲染（主题、批量入口、PR 与改派链接、行内按钮） |
| 无头浏览器实点（预览页） | 白天与黑夜各一遍：确认卡、两步同意、输出面板（出错段计数）、改派对话框开关、批量全选→确认→结果、主题切换并记住；页面零报错 |

预览：`cd packages/client-ui-router && node scripts/build-preview.mjs && node scripts/serve-preview.mjs`，打开 `http://localhost:4788/?theme=light` 或 `?theme=dark`。

---

## 八、已知边界（如实）

- `ops_run` 是“受管的命令出口”，不是沙箱：worker 本身仍有 shell 工具。要强制只走出口，需要在 DSH 侧收掉 worker 的 shell（属于 DSH 配置，不在插件范围）。
- 每个需求一个独立 worktree 还没做（第三期），同一分区的并行任务共用一个工作分支。
- `git push` 用机器上已有的 git 凭据；令牌只用于 PR 的 API。
- 截图需要服务器上有无头浏览器命令（默认 `/srv/workspace/bin/screenshot`，可配置）。

# 宿主侧接口契约（host ↔ client-ui-router）

本文是 **client-ui-router 期望 `packages/host-router` 提供什么** 的唯一定义。
UI 侧的类型真源是 `src/client/contract.ts`；本文解释每个字段为什么存在、什么是可选的、
以及不满足时 UI 会怎样退化。

> 版本基线：运行中的 DSH **0.2.2-rc.3**。所有「官方已提供」的结论都来自
> `resources/app.asar/dsh/node_modules/@deepseek-ai/*` 里的 rc.3 源码，行号见文末「证据」。

---

## 0. 一句话

宿主只需提供一个 **只读快照** + 三个写操作（发布需求 / 验收 / 退回）；
worker 的「工作清单」**不需要宿主发明协议**——那是 `todo/write` 投影，客户端自己读。

```
ctx.remote.router.board()        → BoardSnapshot        读
ctx.remote.router.publish(...)   → PublishResult        写：投递需求
ctx.remote.router.verify(...)    → void                 写：通过/退回
ctx.remote.$on('router/changed') → 变更通知              推送
```

三栏改版后新增的能力**全部可选**，老宿主不改也能跑（缺字段 = 「宿主没报告」，UI 会这么说，
而不是猜一个值）：

```
BoardSnapshot.partitions[].enabled   → 左栏项目行的 启用/停用 开关状态
BoardSnapshot.tasks[].scheduledFor   → 排程组（否则 queued 一律算「待派」）
BoardSnapshot.credentials[]          → 左栏 API Key 区块的状态行
router.setPartitionEnabled / createPartition（可选 Remote）
```

---

## 1. 为什么是这个形状

| 约束 | 落地方式 |
|---|---|
| 用户「只发需求」，不选分区 | `publish()` 只收文本数组；分区由宿主判定，`PublishResult.routed[].partitionId` 回报给 UI |
| **`reported` 与 `verified` 不能合并** | 任务状态是 5 态枚举，`reported` 是 worker 自报、`verified` 是验收通过，是两个不同的值，UI 上是两条不同的泳道 |
| 空闲 worker 要能看出「已释放」 | worker 的 `presence` 是 4 态，`released` 与 `online` 分开渲染（虚线胶囊 + “已释放 · 不占用机器”） |
| 「干到哪一步」 | 任务的 `todos` 直接对齐 rc.3 的 `TodoItem[]`；能读投影时 UI 优先用投影（见 §5） |
| 宿主可能还没写完 | 宿主 Remote 缺席时 UI 用内置示例数据并**在头部标注 `示例数据`**，不会假装成真的 |

---

## 2. 读：`board()`

```ts
board(): Promise<RemoteResult<BoardSnapshot>>
```

`RemoteResult` 是 rc.3 既有形状（所有 Remote 通用）：
`{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`。

`BoardSnapshot`（见 `src/client/contract.ts`）：

```ts
{
  fetchedAt: string,          // ISO 8601，面板头部显示「更新于 HH:MM:SS」
  partitions: PartitionView[],
  tasks: TaskView[],
  demands: DemandView[],
  staleSince?: string,        // 宿主自认数据陈旧时填；UI 显示红色「宿主读不到」徽标
  credentials?: CredentialView[], // 可选：左栏 API Key 区块的状态行（见 §2.4）
}
```

### 2.1 `PartitionView[]` — 分区花名册

```ts
{
  id: string,                 // 稳定 id，任务用 partitionId 引用它
  name: string,               // 显示名，如 "rca-ab-test"
  repo?: string,              // 工作目录，用于行标题（悬停可见，长路径截断）
  enabled?: boolean,          // 可选：省略 = 未报告（按启用渲染）；false 渲染为灰行 + 「已停用」
  manager: {
    id: string,
    name: string,             // 一般就是 "manager"
    presence: WorkerPresence,
    dispatched: number,       // 本快照窗口内已派发数
    awaitingVerification: number, // 等它验收的数量（>0 时左栏行上出现琥珀色数字徽标）
  },
  workers: WorkerView[],
}
```

`WorkerView`：

```ts
{
  id: string,                 // 任务用 workerId 引用它
  name: string,               // "worker-1"
  presence: 'online' | 'busy' | 'offline' | 'released',
  sessionId?: string,         // 该 worker 的 Harness Session；用于「打开会话」和读它的 todo 投影
  activity?: string,          // "go build" —— 显示在 worker 胶囊里
  elapsedSeconds?: number,
}
```

**`presence` 的语义请严格遵守**，UI 直接按它渲染，不做二次推断：

| 值 | 含义 | UI 表现 |
|---|---|---|
| `online` | 空闲、可派发 | 绿点 + 「空闲」 |
| `busy` | 正在执行任务 | 蓝点（带光晕）+ 当前 `activity` |
| `offline` | 已知但不可达，任务不会推进 | 灰点 + 半透明 |
| `released` | 干完了、容量已归还 | 虚线胶囊、空心点 + 「已释放」，`title` 提示「不占用机器」 |

> 硬性要求 #2 靠这个字段满足：**不要**把空闲 worker 报成 `online` 就完事，
> 那会让人以为机器还被占着。`released` 是独立语义。

### 2.2 `TaskView[]` — 任务

```ts
{
  id: string,                 // 稳定 id，验收动作的句柄
  title: string,              // 一行需求摘要
  partitionId: string,
  workerId?: string,
  state: 'queued' | 'running' | 'reported' | 'verified' | 'rejected',
  todos: TodoItem[],          // 见 §5（能读投影时会被投影覆盖）
  updatedAt: string,          // 排序依据：同泳道内按它倒序
  requestedAt?: string,
  reportedAt?: string,        // state === 'reported' 时填
  verifiedAt?: string,        // state === 'verified' 时填
  attempt?: number,           // 从 1 开始；被退回后 +1
  rejectionReason?: string,   // state === 'rejected' 时填，红底显示
  workerSessionId?: string,   // 有则在卡片上出现「打开 worker 会话」，也是读 todo 投影的键
  artifacts?: { name: string, address: string, bytes?: number }[],
  scheduledFor?: string,      // 可选：排程开始时间；queued + 有它就进「排程」组，否则进「待派」
}
```

**状态机（宿主负责推进，UI 只渲染）**

```
queued ──派发──▶ running ──worker 自报──▶ reported ──验收通过──▶ verified
                    ▲                        │
                    └────────验收不通过──────┴──▶ rejected（回待派泳道，attempt+1）
```

三条不可协商的规则：

1. **`reported` 不是完成。** worker 说做完了只能进 `reported`；只有验收动作能进 `verified`。
   依据：arXiv:2611.04100 的 16 次真实委派里 3 次把失败记成了 done。
2. **`rejected` 回到「待派」那一侧**（`Up next` tab 的「退回重做」组），卡片保留
   `rejectionReason` 与 `attempt`，否则退回的任务会在看板上消失。
3. **不要由宿主自动把 `reported` 直接改成 `verified`**（比如「没报错就算过」）。
   若确实验收是自动化的，请在 `verify()` 语义里体现，而不是跳过 `reported` 这个中间态。

### 2.3 `DemandView[]` — 需求流水

```ts
{
  id: string,
  text: string,               // 用户原文
  publishedAt: string,
  partitionId?: string,       // 还没路由时省略（UI 可显示「待定分区」）
  routingReason?: string,     // 为什么落到这个分区（做可解释性，不做也合法）
  taskIds: string[],          // 这条需求产出的任务
}
```

### 2.4 `CredentialView[]` — 左栏 API Key 区块（可选）

左栏底部的 `⚙ API Key` 只显示**有没有、从哪来、能不能写**，从不显示值——
这与 rc.3 凭据服务自身的语义一致（`credentials.describe` 没有回读路径）。

```ts
{
  ref: string,                // 必填，须匹配 ^[A-Za-z_][A-Za-z0-9_]*$，如 "DEEPSEEK_API_KEY"
  label?: string,             // 显示用 provider 名（只进 title，不占行宽）
  configured: boolean,        // 已有值 = true
  source?: 'file' | 'env' | 'unset' | 'unknown',
  writable?: boolean,         // false = 这一行就算宿主能写也不给输入框
}
```

两块实现分工：

| 谁 | 做什么 |
|---|---|
| 宿主 `BoardSnapshot.credentials` | 报告「本部署关心哪几个 ref、现在什么状态」 |
| 客户端 `ctx.remote.credentials.describe(refs)` | 有这条 Remote 时，**以它为准**覆盖状态（更实时） |
| 客户端 `ctx.remote.credentials.set(ref, value)` | 用户点某一行 → 输入 → 保存，等同 Models 设置页的写 |

宿主没报告 `credentials` → 区块显示「宿主未报告凭据」；宿主没提供 `remote.credentials` →
行只读，并提示「在 设置 · 模型 里配置」。两种情况都不会出现一个按了没反应的表单。

---

## 3. 写：`publish()` / `verify()`

```ts
publish(request: { demands: readonly string[] }): Promise<RemoteResult<PublishResult>>
// PublishResult = { accepted: number, routed: { text, partitionId?, reason? }[] }

verify(request: {
  taskId: string,
  verdict: 'verified' | 'rejected',
  note?: string,              // 退回原因，原样显示在卡片红条里
}): Promise<RemoteResult<void>>
```

- `demands` 已经按行拆好、去空白、去空行；宿主不必再解析换行。
- `publish` 允许**部分成功**：`accepted` < 提交数，未路由的条目在 `routed` 里没有 `partitionId`。
- 两个写操作完成后，UI 会立刻重新 `board()` 一次（不等推送），所以宿主不必为一次写入补发事件。

### 3.1 左栏的两个写操作（可选）

`src/client/contract.ts` 里的 `HostActions` 是客户端**能力探测**的形状：每个成员存在就渲染成
可用的控件，不存在就渲染成「未接宿主」并在按下时说明，不会假装成功。

```ts
setPartitionEnabled(partitionId: string, enabled: boolean): Promise<void>
createPartition(name: string): Promise<void>            // 目前只有 UI 入口，宿主可先不实现
```

两种接法，客户端按顺序探测：

1. **Remote**：`ctx.remote.router.setPartitionEnabled({ partitionId, enabled })` /
   `createPartition({ name })`（可选方法，见 `src/shims/dsh-client.d.ts`）；
2. **HTTP 桥**：`createHttpActions()`（`src/client/source.ts`，integrator 提供）
   → `POST /api/router/partition` `{ id, enabled }`。

两条都没有时，左栏开关仍显示（形状在），按下会提示「宿主未提供这个操作，未提交」。
「新建分区」目前是同类状态：入口在，写操作等宿主契约。

---

## 4. 推送：`router/changed`

```ts
ctx.remote.$on('router/changed', payload)  // payload 内容随意，UI 只当作「该重读了」
```

宿主**不需要**把快照推过来——推「变了」这一个信号即可，UI 会自己 `board()`。
并发读取会被合并（同一时刻最多一个在飞），所以频繁推送不会打爆宿主。

---

## 5. 「工作清单 / 干到哪一步」——原生能力，不需要宿主造协议

这是 rc.3 已经有的东西，**请不要在 host-router 里重新发明一份 todo 存储**：

- 工具 `todo_write` 写 Session 事件 **`todo/write`**，payload `{ todos: TodoItem[] }`（整表替换）；
  `TodoItem = { content, status: 'pending'|'in_progress'|'completed' }`。
- 官方投影 key = **`todos`**，`wire.view` 已声明，Host 算好、Client 直接读：

  ```js
  // 面板里（scope: 'session' 的 slot）：
  const todos = props.useProjection('todos')          // 当前 session 的
  // 或者遍历所有 worker：
  const list = ctx.sessions.list.getSnapshot().projectionsBySession
  const todos = list[workerSessionId]?.values?.todos   // 需要时先 await ctx.sessions.refreshProjections(id)
  ```

  本插件 `src/client/native-todos.ts` 走的就是第二条：任务带 `workerSessionId` 时，
  UI 优先读该 Session 的投影，读不到才回落任务自带的 `todos`。

- **坑（决定了 `todos` 字段为什么仍然保留）**：该投影在 `turn/start` 会被清成 `null`。
  也就是说它只描述**当前 turn**。一个已经 `reported`/`verified` 的任务，下一轮开始后投影就是 `null`。

所以两边分工是：

| 场景 | 数据来源 | 谁负责 |
|---|---|---|
| 正在跑的任务（当前 turn） | `todos` 投影（原生） | Client，零宿主代码 |
| 已完成 / 已退回任务的历史清单 | Session 日志里的 `todo/write` 事件（末位胜） | **宿主**，填进 `TaskView.todos` |
| 两者都没有 | 卡片显示「worker 还没写工作清单」 | UI |

⇒ **`TaskView.todos` 是可选的历史兜底**，不是必须一直填的字段。能填就填（尤其
`reported`/`verified`/`rejected` 的任务），填不了 UI 也不会空白。

---

## 6. 退化行为（宿主缺席 / 报错时会发生什么）

| 情况 | UI 行为 |
|---|---|
| 没装 host-router（没有 `ctx.remote.router`，桥也不通） | 用内置示例数据，头部显示 **`示例数据`** 徽标（可悬停看解释） |
| `board()` 抛错 / 返回 `ok:false` | 保留上一次快照，头部出现错误条与「重试」，不白屏 |
| 载荷不符合 `BoardSnapshot` | 视为读取失败（上一条），不 try 硬渲染 |
| `staleSince` 有值 | 头部红色「宿主读不到」徽标 |
| 缺 `credentials` | API Key 区块显示「宿主未报告凭据」 |
| 缺 `enabled` | 项目行按启用渲染；开关按下时按 `HostActions` 探测结果决定是否提交 |
| 缺 `scheduledFor` | 该任务按 `queued` 落进「待派」，不进「排程」 |
| 未知的额外字段 | 忽略（契约只增不改） |
| 必填字段缺失（`id`/`title`/`state`） | 任务行可能渲染成残缺项；**这是宿主 bug**，UI 不做兜底猜测 |

---

## 7. 示例载荷

```json
{
  "fetchedAt": "2026-11-18T14:55:11.000Z",
  "partitions": [
    {
      "id": "rca-ab-test",
      "name": "rca-ab-test",
      "repo": "E:/PythonProject/rca-ab-test",
      "manager": { "id": "mgr-rca", "name": "manager", "presence": "online", "dispatched": 3, "awaitingVerification": 1 },
      "workers": [
        { "id": "w-1", "name": "worker-1", "presence": "busy", "sessionId": "ses_rca1", "activity": "go build", "elapsedSeconds": 318 },
        { "id": "w-2", "name": "worker-2", "presence": "released", "sessionId": "ses_rca2" }
      ]
    }
  ],
  "tasks": [
    {
      "id": "task-001",
      "title": "把 go build 的失败用例收敛掉",
      "partitionId": "rca-ab-test",
      "workerId": "w-1",
      "state": "running",
      "todos": [
        { "content": "读 build 报错", "status": "completed" },
        { "content": "跑 go build ./...", "status": "in_progress" }
      ],
      "updatedAt": "2026-11-18T14:53:00.000Z",
      "workerSessionId": "ses_rca1"
    },
    {
      "id": "task-003",
      "title": "补 registry.json 的 12 个工具描述",
      "partitionId": "rca-ab-test",
      "workerId": "w-2",
      "state": "reported",
      "todos": [],
      "reportedAt": "2026-11-18T14:49:00.000Z",
      "updatedAt": "2026-11-18T14:49:00.000Z",
      "workerSessionId": "ses_rca2"
    }
  ],
  "demands": [
    { "id": "dmd-001", "text": "把 go build 的失败用例收敛掉", "publishedAt": "2026-11-18T14:17:00.000Z", "partitionId": "rca-ab-test", "routingReason": "命中分区关键词 go", "taskIds": ["task-001"] }
  ]
}
```

---

## 8. 接口对不上的话改哪里

- 宿主 Remote 命名不是 `router`：改 `src/client/index.ts` 里 `ctx.remote?.router` 一行 + `src/client/source.ts` 的 `RouterRemoteLike`。
- 宿主不用 Remote 而用别的通道（本地 store、HTTP、文件轮询）：实现 `BoardSource`
  （`src/client/source.ts`，四个方法：`read/publish/verify/subscribe`），在 `index.ts` 里换掉
  `resolveSource(hostSource)` 的参数即可。**视图层不需要任何改动**。
- 只想先看 UI：不装宿主就行，面板会以 `示例数据` 跑起来。

---

## 9. 证据（rc.3 asar，路径相对 `resources/app.asar/dsh/node_modules/@deepseek-ai/`）

| 结论 | 证据 |
|---|---|
| 右侧栏两阶段注册、`sidebar.right.pane.tab` 是 keyed slot | `dsh-client-ui-sidebar-right/src/client/contract/slots.ts:52-78`；样板 `.../src/client/index.ts:290-308` |
| `openTab(kind, options)` | `dsh-client-ui-sidebar-right/src/client/service.ts:250` |
| `todo/write` 事件与 `TodoItem` | `dsh-tool-todo/src/types.ts:23-35` |
| `todos` 投影（`wire.view`，`turn/start` 清空） | `dsh-tool-todo/src/index.ts:118-135` |
| 客户端 `useProjection('todos')` 官方用法 | `dsh-client-ui-conversation/src/client/skeleton/TodoPanel.tsx:102-119` |
| 跨 Session 读投影 | `dsh-client-ui-subagent/src/client/index.ts:65-77`（`projectionsBySession` + `refreshProjections`） |
| 子 Session 枚举（`subagentCatalog`） | `dsh-subagent/src/catalog.ts:130-140`；读法 `dsh-client-ui-subagent/src/client/index.ts:55-81` |
| 左栏**没有**可注册的内容座位（`sidebar` 是 single 且已被占用） | `dsh-client-ui-layout/src/client/index.ts:59-70`（slot 声明 + 「registering here replaces the navigation column outright」）；`dsh-client-ui-sidebar/src/client/index.ts:88-108`（8 个 child slot，`workspaces`/`settings` 已各有占用者） |
| `ctx.layout` 只控制主面板选择与左右栏几何 | `dsh-client-ui-layout/src/client/service.ts:28-54`（`ILayout` 全部成员：`panelInfo` / `selectPanel` / `beginNavigation` / `toggleSidebar` / `openRightbar` / `closeRightbar`） |
| 左侧栏可加东西的座位只有导航行 | `dsh-client-ui-sidebar/src/client/contract/slots.ts:43-49,71-75`（`sidebar.panellist` / `sidebar.panellist.actions` / `sidebar.footer.action` 均为 list，且条目 id = 主面板 key） |
| 凭据只读语义（无回读路径） | `dsh-api-settings-controller/src/credentials.ts:45-52,83-119` |
| 不能 require 官方 client 包 / 不能塞 `document.body` | `dsh-agent-preset/skills/dsh-doc/references/practices.md:35-36` |

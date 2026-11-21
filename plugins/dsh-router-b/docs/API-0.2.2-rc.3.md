# DSH 0.2.2-rc.3 插件开发 API 契约（事实核定版）

> 读者：`host-router`（宿主侧插件）与 `client-ui-router`（Web UI 插件）两个 agent。
> 本文只写**核定过的事实**，每条带证据位置。凡未核出的一律标 `未核定`，不要按猜测写代码。
> 生成方式：只读（read 工具直读 asar 内源码 + 官方 dsh-doc 文档），未修改任何 profile / 源码 / 应用状态。

## 0. 版本与证据坐标

| 事实 | 值 | 证据 |
|---|---|---|
| 运行版 CLI 包 | `@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.3`，依赖 `@deepseek-ai/dsh@0.2.2-rc.3` | `…\app.asar\dsh\package.json:4,13` |
| 安装目录 | `C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh` | `$env:DSH_INSTALL_DIR` |
| 当前 profile | `desktop`，`DSH_PROFILE_DIR=C:\Users\<你>\.dsh\profiles\desktop` | 环境变量 |
| profile 已装 bundles | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dshmarket`、`dsh-computer-use-win` | `C:\Users\<你>\.dsh\profiles\desktop\package.json:13-18` |
| 打包内容 | 338 个 `@deepseek-ai/*` 包，**且每个包带 `src/*.ts` 原始源码**（连同 `lib/index.js` 打包产物） | 目录枚举 |

下文的证据前缀简写：

- `PKG(x)` = `…\app.asar\dsh\node_modules\@deepseek-ai\x`（`…` 指上表安装目录）
- `DOC(x)` = `…\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills\dsh-doc\references\x`
- `CHK(x)` = `E:\PythonProject\deepseek-harness-latest\…`（**0.2.2-rc.5 源码 checkout，仅交叉参考**）

**读源码优先读 `src/*.ts`，不要读 `lib/index.js`**：`src` 是同一份逻辑的未压缩 TypeScript，注释即契约；`lib/index.js` 是 tsdown 产物，行号会漂。

`read` 工具能直接读 asar 内路径；`Test-Path` / `Get-ChildItem` / `find` / grep 工具都看不进 asar。需要列目录或全文搜索时，用 `ELECTRON_RUN_AS_NODE=1` + `$env:DSH_NODE_EXECUTABLE`（Electron 本体）当 node 跑一段 `node:fs` 脚本。

### 0.1 rc.3（运行版）vs rc.5（checkout）已核实的差异

| # | 主题 | rc.3（**按这个写**） | rc.5 | 证据 |
|---|---|---|---|---|
| 1 | 沙箱 `workspaceRoot` 来源 | `session.header.cwd`，**不读** workingDirectory | `ctx.get('workingDirectory')?.get(session) ?? session.header.cwd` | rc.3 `PKG(dsh-sandbox-policy)\src\index.ts:223-230`；rc.5 `CHK(packages/sandbox/sandbox-policy/src/index.ts:230-232)` |
| 2 | ⇒ `cd` 是否移动写边界 | **不移动** | 移动 | 同上 |
| 3 | storage 后端 | 只有 `dsh-storage-json`（无 sqlite 包） | 有 `packages/storage/storage-sqlite` | rc.3 asar 包表；`CHK(tsconfig.host.json:446)` |
| 4 | 源码形态 | 无 checkout，但 asar 内每包自带 `src/*.ts` | 完整 monorepo | 目录枚举 |
| 5 | 是否有 `router` 包 | 无 | 有 `packages/router/` 目录 | `CHK(packages/router)` |
| 6 | 新包接入点 | 无源码树可接，走 bundle 安装 | `packages/*/*` + `tsconfig.host.json` references | H30 |

未核实的潜在漂移（不要假设）：`dsh-client-ui-slots` 等 client 包在 rc.5 是否也仍不进运行时产物；rc.5 的 `TeamService` Remote 面；rc.5 的 subagent cwd 语义是否另有变化。**任何 rc.5 文档/checkout 结论在用之前都要在 rc.3 的 `src/*.ts` 里复核一次。**

---

# 第一部分：UI 与数据（I / J / K / L，最高优先级）

## I. 布局与右侧面板

### 33. `ctx.layout` 完整 API 与 AppFrame 的 slot 名

`ctx.layout` 是 client 侧服务，类型 `ILayout`，由 `dsh-client-ui-layout` 提供。
证据：`PKG(dsh-client-ui-layout)\src\client\index.ts:36-41`（Context 声明 `layout: ILayout`）、`:188-191`（`ctx.reflect.provide('layout', layout)`）。

`ILayout` 全部成员（`PKG(dsh-client-ui-layout)\src\client\service.ts:28-54`）：

```ts
export interface ILayout {
  readonly panelInfo: HostObservable<PanelInfo>   // PanelInfo = { activePanelId: MainPanelId | null }
  selectPanel(panelId: MainPanelId | null): void  // null = 回到 Conversation；未注册的 id 抛错
  beginNavigation(): AbortSignal
  toggleSidebar(): void
  openRightbar(track: boolean, fullscreen: boolean): void  // 只上报展示状态，不改"展开"状态
  closeRightbar(): void
}
```

**关键：`ctx.layout` 没有 panel 的"增删/查询"API。** 它只能选主面板、开关左栏、上报右栏几何。新增面板 = 向 slot 注册，不是调 layout。

AppFrame 自身注册进内置 `root` slot，并**在同一次 `slots.register` 里声明**子 slot（声明 = 独占渲染权），因此这 6 个名字是硬契约（`PKG(dsh-client-ui-layout)\src\client\index.ts:192-205`）：

| slot | kind | scope | 现状 |
|---|---|---|---|
| `sidebar` | single | root | 已被 `dsh-client-ui-sidebar` 占据（注册进去=整列替换） |
| `main` | **keyed** | root | 主面板，key 即侧栏条目 id；保留 key `conversation` |
| `rightbar` | single | root | **已被 `dsh-client-ui-sidebar-right` 占据** |
| `shell.bottom` | single | root | 三栏下方通栏 |
| `shell.overlay` | list | root | 全帧悬浮层，**推荐的"加东西"位置**（新增 id 不替换任何东西） |
| `shell.leading` | single | root | 左上窗控位（被 ui-sidebar 占据） |

`rightbar` 的 owner props（`index.ts:140-151`）：`{ width: number; viewportWidth: number; canShow: boolean }`。
`sidebar` 的 owner props（`:130-138`）：`{ collapsed: boolean; width: number; drawer: boolean }`。

**怎么挂到右侧栏（重要结论）**：不要注册 `rightbar`。`rightbar` 是 single slot 且已被 `dsh-client-ui-sidebar-right` 占据（`PKG(dsh-client-ui-sidebar-right)\src\client\index.ts:233-241` 注册 `rightbar` 并声明子 slot `rightbar.session`），抢占它会把整个右侧面板（文件树、终端、浏览器、文档预览全部）替换掉。
正确做法是**给右侧栏加一个 tab 类型**，见第 34 条。

右侧栏显示/隐藏由占据者自己通过 `ctx.layout.openRightbar/closeRightbar` 上报（`service.ts:44-53` 注释 + `sidebar-right\src\client\index.ts:221-223`）。

### 34. 给右侧栏注册一个面板（tab 类型）的完整写法

右侧栏是**两阶段注册**：

- **阶段一**：`ctx.sidebarRightTabs.register(definition)` 注册"这是什么类型"（静态）。
  服务：`sidebarRightTabs: SidebarRightTabRegistry`，证据 `PKG(dsh-client-ui-sidebar-right)\src\client\index.ts:91-100`（Context 声明）、`:182`（`ctx.reflect.provide('sidebarRightTabs', tabs)`）。
- **阶段二**：向 keyed slot `sidebar.right.pane.tab` 注册 **body**，key = 阶段一的 `definition.id`；可选向 `sidebar.right.pane.tab.title` 注册标题。
  证据：`PKG(dsh-client-ui-sidebar-right)\src\client\contract\slots.ts:52-78`（"A tab type registers here under its definition's `id`"）、参考实现 `index.ts:290-308`。

阶段一 `SidebarRightTabDefinition`（`PKG(dsh-client-ui-sidebar-right)\src\client\tab-registry.ts:94-139`）：

```ts
interface SidebarRightTabDefinition {
  id: string            // 全局唯一实现身份，同时是 body/title 注册的 key（包名是自然取值）
  kind: string          // 类型判别符 = 打开时 openTab 用的名字
  multiple?: boolean    // 每次按 kind 打开产生独立内容；省略则每 pane 每 kind 只一页
  keepMounted?: boolean // 隐藏/切 session/停靠时是否保活；默认 false
  patterns?: readonly string[]  // 资源地址 glob；页面型（openTab 打开）可省略
  priority?: 'extension' | 'builtin' | 'fallback'  // 默认 'extension'（外部类型最高优先级）
  canOpen?: (address: string) => boolean
  title: (address: string) => string   // 打开瞬间写进 layout 记录的 chip 文本
  guide?: readonly SidebarRightGuideEntry[]  // 出现在 guide 页的入口卡片；省略就不出现
}
```

`register()` 的约束（同文件 `:253-281`）：`id` 重复抛错；同一 `kind` 同 band 重复注册抛错；`extension` 可覆盖 `builtin`，`fallback` 不能与任何共存。返回 disposer，必须挂进 `ctx.effect`。

阶段二 body 的 props（`contract/slots.ts:59-64,184-220`）：

```ts
// SlotMap
'sidebar.right.pane.tab': { kind: 'keyed'; scope: 'session'; hookContext: TabHookContext; inject: SidebarRightTabInjected }
// 标准 session props（sessionId / useSession / useProjection …）由框架注入
// 额外注入：hooks: { tabInfo: SlotHookFactory<'sidebar.right.pane.tab', UseSidebarRightTabInfo> }
```

`SidebarRightTabInfo`（`contract/slots.ts:185-209`）含
`sidebar.{expanded,fullscreen}`、`panel.{id,isFloating}`、
`tab.{ …TabRecord, refreshShortcut?, visible, navigation:{address,params,revision}, signal: AbortSignal, actions: SidebarRightTabActions }`。
`tab.actions`（`:156-182`）提供 `bindCommands`、`openResource`、`openTab`、`close`。

最小骨架（**把官方 guide 类型的写法照搬**，`sidebar-right\src\client\index.ts:290-308` 是唯一已知可行的样板）：

```js
// client.js —— 直接写在 loader 工厂里，不需要编译
window.__ModuleLoader__.load({
  id: '@local/task-board',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ID = '@local/task-board/tasks'

    function TasksBody(props) {
      const tab = props.useTabInfo  // 见下方说明：tabInfo hook 由 inject 提供，键名以框架为准
      return h('div', null, 'task board')
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        // 阶段一：类型定义
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: 'taskboard',
          priority: 'extension',
          title: () => 'Tasks',
          guide: [{ id: 'tasks', order: 100, title: () => 'Task board' }],
        }), 'task-board: tab type')

        // 阶段二：body（key = definition.id）
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
        }, TasksBody))
      },
    }
  },
})
```

注意/限制（**必须记住**）：

1. `props.useTabInfo` 这个 prop 名**未核定**。注入面声明是 `inject: { hooks: { tabInfo: … } }`，按 `PKG(dsh-client-ui-renderer)` 的通用规则"每个 `hooks` 源变成 `use<Name>` 选择器 hook"（`PKG(dsh-client-ui-renderer)\src\client\scoped-slots.tsx:581-582` 注释），应为 `useTabInfo`；但 `PropsRuntime`/`InjectFace` 的权威类型在 `@deepseek-ai/dsh-client-ui-slots`，该包**不在 asar 里**（见第 27 条），无法逐字核对。落地时先用 `props` 打印一次 key 再写死。
2. `guide` 里 `order` 是必填 `number`（`tab-registry.ts:62-68`）。
3. 打开这个面板：`ctx.sidebarRight.openTab('taskboard', { preferNewPane: true })`（`service.ts:250`；`ISidebarRight` 全量见 `service.ts:216-298`：`openResource/openTab/close/hide/active/isExpanded/toggleExpanded/focus/split/float/dock`）。
4. **session 绑定**：该 slot 是 `scope: 'session'`，框架会按当前 session 给每个 session 独立 store/instance。所以"任务面板跟某个 session 绑定"= 面板读当前 session；想钉死某个具体 session，用 `tabInfo.navigation.params` 或自己的持久化记录。
5. 页面型 tab 的地址由包记录，`openTab` 不需要资源地址；资源型（`patterns`）走 `openResource('dsh-resource://…')`。

### 35. 新增 Conversation View（像 stats 那样）

**有官方位置**：`conversation.view` 是 `list` slot，scope 为 `session`，owner props 为 `ConvViewOwnerProps`。
证据：`PKG(dsh-client-ui-conversation)\src\client\contract\slots.ts:285`（`'conversation.view': { kind: 'list'; scope: 'session'; owner: ConvViewOwnerProps }`）、`:467`（`export type ConvViewProps = PropsRuntime<'conversation.view'>`）。

参考实现 `dsh-experimental-client-ui-stats`（`PKG(dsh-experimental-client-ui-stats)\src\client\index.ts:75-126`）：

```js
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'stats',                 // view 身份
  order: 40,                   // 与其它 view 的排序
  locale: NS,
  label: () => t('view.stats'),// 标签（thunk，跟随语言）
  inject: (sessionId) => ({ hooks: { stats: source }, cancel, loadOlder, loadImage }),
}, StatsView))
```

conversation 侧全部 slot（同文件，按行号）：`conversation.user.text.node:221`、`main.conversation:229`、`conversation.session:231`、`conversation.header:237`、`conversation.session.header:239`、`.lineage:248`、`.actions:254`、`.utilities:260`、`conversation.header.leading:266`、`.corner:277`、`.views.actions:283`、`conversation.view:285`、`conversation.composer:290`（chain）、`conversation.hero.*:292-300`、`conversation.input.dock:305`（list）、`conversation.input.overlay:310`、`conversation.composer.dock:315`、`conversation.input.left:320`、`conversation.input.right:325`、`conversation.input.activity:331`、`conversation.composer.bar:336`、`conversation.input.attachments:341`、`conversation.input.plan:350`、`conversation.input.permission:355`、`conversation.input.model:362`。

**两种方式的取舍（给 client-ui-router 的判断）**：

| | 右侧 tab（第 34 条） | 新 Conversation View（本条） |
|---|---|---|
| 现有产品语义 | 右侧栏是"同一 session 的侧边工具"（文件树/终端/浏览器/文档） | 主区 top-tab 切换，和 Chat/Trajectory/Stats 同级 |
| 与"左边聊天、右边任务面板"目标 | ✅ 天然符合 | ❌ 会顶掉聊天可见性（切 tab） |
| 代码量 | 阶段一 + 阶段二，两个注册 | 一个注册 + inject 面 |
| 自动获得的能力 | 右侧栏的 dock/float/分屏/展开收起、tab 菜单、guide | view 的 label/顺序，session 级 store |

**结论：用户已定稿"左聊天右任务面板"，用第 34 条的右侧 tab；不要用 conversation.view。**

## J. 「工作清单 / 干到哪一步」的数据源

### 36. `todo_write` 的事件与 payload

- 工具名：`todo_write`，参数 `todos: Array<{content: string; status: 'pending'|'in_progress'|'completed'}>`（整表替换）。
  证据：`PKG(dsh-tool-todo)\src\index.ts:136-212`。
- 事件：`todo/write`，payload `{ todos: TodoItem[] }`，由 `exec.agent.session.append('todo/write', { todos })` 写入（`:200`）。
  事件类型声明：`PKG(dsh-tool-todo)\src\types.ts:30-35`。
- `TodoItem`：`{ content: string; status: 'pending' | 'in_progress' | 'completed' }`，**没有 id、priority、activeForm**（`types.ts:23-28`）。
- 校验：content 去空白后不能为空、不能重复；`allowParallelInProgress` 为 false 时最多一个 `in_progress`（`index.ts:80-100`）。配置项 `allowParallelInProgress` 是 **required**（`:41-43`），所以宿主行必须显式给值。

### 37. 现成的 `todos` projection

**有，已经注册好了**，由 `dsh-tool-todo` 自己在 `apply` 里注册，key = `todos`：

```ts
ctx.sessionProjections.register<'todos', TodoItem[] | null>({
  key: 'todos',
  stateSchema: todosProjectionSchema,
  init: () => null,
  apply: (state, event) => {
    if (event.type === 'todo/write') return event.data.todos
    if (event.type === 'turn/start') return null      // ← 关键
    return state
  },
  wire: { viewSchema: todosProjectionSchema, view: state => state, summary: false },
  stateVersion: 2,
})
```
证据：`PKG(dsh-tool-todo)\src\index.ts:118-135`；类型声明 `types.ts:37-47`。

**⚠️ 最大的坑**：`apply` 在 `turn/start` 把 todos 清成 `null`。所以 projection 只在"当前 turn 内"有效；turn 结束后（下一个 turn 开始）读到的就是 null。
- 想显示"这个任务现在干到哪" → projection 够用。
- 想显示"这个任务历史上做完了哪些清单" → **必须读 session 日志里的历史 `todo/write` 事件**（每次写入都是整表快照，末位胜），或自己投影一个"历史"key。

`dsh-session-projection` 的注册/读取 API（`PKG(dsh-session-projection)\src\index.ts`，43k，接口在 `types.ts`）：

- `ctx.sessionProjections.register(definition)` → 返回 `ProjectionHandle`；`handle.stateOf(session)` 同步读当前态。
- `ProjectionDefinition` 必备字段：`key`、`stateSchema`（zod）、`init(header)`、`apply(state, event)`（纯函数，忽略的事件返回**同一个引用**）、`stateVersion`；可选 `wire: { viewSchema, view, summary }`。
- `wire.view` 是"给 Client 的值"——声明了它，值会以已算好的形式送到浏览器（`DOC(practices.md:38)`："When the Client needs a value derived from a session, declare `wire.view` on the Host projection."）。

### 38. 客户端怎么读某个 session 的 todo

**首选：slot props 里的 `useProjection('<key>')`。**

官方现成实现就是 `TodoDock`（`PKG(dsh-client-ui-conversation)\src\client\skeleton\TodoPanel.tsx:102-119`）：

```tsx
export type TodoDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'conversation'>

export function TodoDock({ useProjection, t }: TodoDockProps) {
  const todos = useProjection('todos')          // 类型来自 @deepseek-ai/dsh-tool-todo/client 的 declare merge
  return <TodoPanel todos={todos ?? []} t={t} />
}

export const todoDockEntry = {
  name: 'conversation-todo-dock',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () =>
      ctx.slots.register({ name: 'conversation.input.dock', id: 'todo', order: 0, locale: NS }, TodoDock))
  },
}
```

要点：
- `useProjection` 是**标准 prop**，不需要自己连 Host，不需要 import 任何 Remote。
- 键是 Host 投影的 key（这里是 `'todos'`），值是该 session 的 `wire.view` 结果。
- 同一模式可用于 `contextPressure`、`inbox`、`plan`、`goal`、`imageLimits`、`subagentCatalog` 等（见 `InputBar.tsx:52,73-117`、`ContextMeter.tsx:51-58`）。
- 读**另一个** session（不是当前 slot 的 session）的投影：`ctx.sessions.list.getSnapshot().projectionsBySession[sessionId]`（`PKG(dsh-client-ui-subagent)\src\client\index.ts:65-77`），必要时先 `await ctx.sessions.refreshProjections(sessionId)`（`:66`）。
- **子 session 的 todo 是子 session 自己的**（`todo_write` 写 `exec.agent.session`，`tool-todo\src\index.ts:193-200`）。要显示某个 worker 的清单，得拿到那个 child sessionId 再读它的投影。

### 39. 客户端枚举"父 session 下的所有子 session"

**现成 projection：`subagentCatalog`。**
证据：`PKG(dsh-subagent)\src\catalog.ts:130-140`（`key: 'subagentCatalog'`，`wire: { viewSchema, view: subagentCatalogEntries }`）、`projection-types.ts:95`（`subagentCatalog: SubagentCatalogEntry[]`）、`index.ts:216-223`（注册 + `catalogOf`）。

客户端读法（官方 `dsh-client-ui-subagent` 就是这么做，`PKG(dsh-client-ui-subagent)\src\client\index.ts:55-81`）：

```ts
await ctx.sessions.refreshProjections(parentSessionId)
const parent = ctx.sessions.list.getSnapshot().projectionsBySession[parentSessionId]
if (parent?.state !== 'ready') return
for (const entry of parent.values.subagentCatalog ?? []) {
  if (entry.mode === 'external') continue
  await ctx.sessions.refreshProjections(entry.id)   // 逐个子 session 取投影
}
```

- 条目含 `id`（= 子 SessionId）、`mode`（`continuable` / `one-shot` / `external` / `unknown`）等，定义见 `PKG(dsh-subagent)\src\catalog.ts`（`SubagentCatalogEntry`，`projection-types.ts` 附近）。
- 打开子会话：`ctx.uiWorkspace.openSession(address)`；并在右侧栏开一个 subagent chat tab：`ctx.sidebarRight.openResource(subagentChatAddress(address), { kind: 'subagentchat', preferNewPane: true })`（`:56-63`）。
- **`dsh-client-ui-subagent` 确实是现成的"subagent 目录 + 导航 + 只读 composer"**，但它把入口放在 `conversation.session.header.lineage` / `.header.actions`（`:86-107`），没有暴露"外部插件查询 catalog"的公共 hook —— 外部插件应**自己读 `subagentCatalog` 投影**，不要 hack 它的组件。
- 另有 Host 侧 `list_children` 工具（`PKG(dsh-subagent)\src\list-children.ts:49-52`，读同一个 projection）——这正是本会话 `list_agents` 的来源。

## K. 上传 / 下载

### 40. 上传链路（`dsh-client-file-upload` + `dsh-client-ui-attachment`）

Host 服务：`ctx.fileUploads`（`FileUploads extends TypertRemoteService`），
证据：`PKG(dsh-client-file-upload)\src\index.ts:19-24,57-90`。

两条通道：

1. **Remote（小文件/精确字节）**：`@Remote('upload') upload(agent, request:{data:base64, name?}, signal) → { receiptId, file }`（`index.ts:112-120`）。
2. **HTTP 流式（浏览器大文件）**：`POST /api/session/uploadFileBinary`（`src/protocol.ts:2`；浏览器相对形式 `api/session/uploadFileBinary`，`spec.ts` 同文件 `:7`）。挂在 `ctx.connection.fetch.register({ path, methods:['POST'], requestBody:'streaming', fetch })`（`index.ts:79-87`）。

Host 侧还提供（非 Remote，供 Host 代码调用）：
`uploadStream({sessionId, data, signal?, name?})`、`uploadImageStream({sessionId, data, mediaType, signal?, name?})`（`index.ts:127-186`）、`resolve(agent, receiptId)`、`bindPrompt(...)`、`retirePrompt(...)`。

客户端面（浏览器可调）：`FileUploadService.upload(sessionId, Blob|Uint8Array|ReadableStream, name?, signal?, onProgress?)` / `uploadImage(...)`，返回 `RemoteResult<FileUploadValue|ImageUploadValue>`（`src/client/contract.ts:16-53`）。

存储位置：内容寻址，落在 `$DSH_HOME/attachments/v1`（`PKG(dsh-attachment-local)\src\index.ts:167-180`，`this.root = join(dshHome, 'attachments', 'v1')`；文件路径 `files/<sha[0:2]>/<sha>/<name>`，`file-store.ts:70-82`）。

限制与坑：
- **子会话不接受上传**：`assertOrdinaryAgent` 对 `session.header.origin === 'subagent'` 抛 `subagent/attachment-invalid`（`index.ts:283-291`）。
- 图片有字节上限，取 `min(maxImageBytes, maxMessageImageBytes)`（`:171-173`）。
- 上传只是"暂存 receipt"，**必须被某条 prompt 引用后才 retire**（`bindPrompt` + `observeSessionEvent`，`:293-306`）。
- `dsh-client-ui-attachment` 负责 UI（拖放、附件轨、消息图片），**不是数据通道**；它引用的就是上面的 receipt/attachment ref。

### 41. 产物下载（`present` + `dsh-client-ui-deliverables`）

Host 工具 `present`（`PKG(dsh-tool-present)\src\index.ts:38-109`）：

```ts
parameters: { files: Array<{ path: string; description?: string }> }  // 1..maxFiles(默认8)
execute: 校验 path 必须存在且是普通文件（相对路径按 session 工作目录）
        → 在 turn 结束时 append 事件
```
写入事件：`session.append('deliverables/presented', { turn, callId, files })`（`:106-108`，在 `tools/result` 里、成功才写）。

所以"把产物声明给用户下载"= **调 `present` 工具**（模型侧）或 Host 侧直接 append 同形状的 `deliverables/presented`。UI 侧：`dsh-client-ui-deliverables` 渲染 `PresentRow` / `Deliverables` / `ReviewedFiles` 等（`PKG(dsh-client-ui-deliverables)\src\client\index.ts`），**不需要你的插件做任何事**。
坑：`present` 要求**有 open turn**（`:80-81`），turn 结束后补调会抛 `ToolContextUnavailableError`；`present` **不在 base bundle 里**，它由 preset 组合：`PKG(dsh-web-app)\presets\{standard,ptc,minimal}.patch.yml` 有 `tool-present` 行（如 `standard.patch.yml:129`），`PKG(dsh-sdk-app)\cordis.patch.yml:81` 也有一处；**自建 preset 不加这一行就没有 `present`**。

## L. API key 配置

### 42. Models 设置页覆盖什么

`dsh-client-ui-settings-models` 管理**全部 LLM provider 配置 + 凭据写入**：
- slots：`settings.models.provider-card`（keyed）、`settings.models.sign-in`（single, root）、`settings.models.footer`（list）（`PKG(dsh-client-ui-settings-models)\src\client\index.ts:143-144`、`slot-contract.ts:35`）。
- 它 inject `'remote.credentials'`、`'remote.settings'`、`'remote.llm'`（`index.ts:68`），并通过 `ctx.remote.credentials.set/unset` 写 key、`ctx.remote.settings.mutate` 写 provider 配置（`operations.ts:76-98`）。

**能直接承载"配置 API key"吗？能，而且这就是官方位置**（Settings → Models → 某个 provider 卡片里的 API Key 输入，`ApiKeyInput.tsx`）。

### 43. 凭据的真实读写路径与官方 API

- Provider：`@deepseek-ai/dsh-credentials-local`，文件 `$DSH_HOME/.credentials.yaml`。
  证据：`PKG(dsh-credentials-local)\src\index.ts:2-9`（分层说明）、`:61`（`CREDENTIALS_FILENAME = '.credentials.yaml'`）、`:65-67`（默认 path = harness home 下）。
- 分层优先级（同文件头注释）：`$DSH_HOME/.credentials.yaml`（provider 管理，`set/unset` 写这里） > `$DSH_HOME/.env`（**fallback，本 provider 永不写**）> 环境变量。
- **官方 API（不要直接写文件）**：
  - Host：`ctx.credentials`（`CredentialProvider`）——`describe(ref)`、`set(ref, value)`、`unset(ref)`。
  - Client：`await ctx.remote.credentials.set(ref, value)` / `.unset(ref)` / `.describe(refs)`，返回 `RemoteResult`（`response.ok ? … : response.error.message`，见 `operations.ts:78-85`）。
- 安全语义（`PKG(dsh-api-settings-controller)\src\credentials.ts:61-119`）：`describe` 只回 `{configured, source?, writable, masked?}`，**任何方法都不回值**；`ref` 必须匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`；`describe` 一次最多 64 个 ref；失败统一 `credential/rejected`（details 只带 ref，不带值）。

### 44. `dsh-api-settings-controller` 暴露的 Remote

`settings` 命名空间（`PKG(dsh-api-settings-controller)\src\index.ts:97-185`）：

| Remote | 签名 |
|---|---|
| `describe()` | `→ { writable, hasDocument, namespaces: SettingsNamespaceView[] }`（读始终 `redactSecrets: true`） |
| `update(ns, patch, expectedRevision?)` | 合并进用户段 |
| `replace(ns, section, expectedRevision?)` | 整体替换用户段 |
| `mutate(ns, ops: SettingsPathOpView[], expectedRevision?)` | 按路径做增量编辑（推荐给"只改一个字段"） |
| `openSettingsDocument(signal)` | 在原生编辑器里打开设置文档 |

`credentials` 命名空间（同包 `credentials.ts:83-119`）：`describe(refs)`、`set(ref, value)`、`unset(ref)`。
错误码：`settings/conflict`（revision 过期，必须重读重写）、`settings/rejected`、`credential/rejected`（`src/types.ts:10-29`）。

### 45. 官方推荐的"配置 API key"入口

按优先级：

1. **复用 Settings → Models**：零代码。你的东西只需要一个 provider/model。
2. **自己的面板里调 `ctx.remote.credentials.set(ref, value)`**：这就是 Models 页做的事，等价且安全（值只上行、写 `.credentials.yaml`）。同时用 `ctx.remote.llm.listProviders()` / `listConfigurableProviders()` 拿 provider 目录（`store.ts:233-234`）。
3. **用自己的设置命名空间 + `ctx.remote.settings.update(ns, patch)`**：适合非机密配置（baseURL、model 名）。机密配置不要走 settings（settings 只做 redaction，不负责密钥存储）。
4. **绝对不要**：手写 `.env` 或 `.credentials.yaml`。`.env` 是显式"永不写"的 fallback，手写会被下一次 `set/unset` 的原子重写覆盖或产生分层歧义。

---

## M. 官方任务板 `ctx.agentTeams`（**host-router 必读，优先级等同 I/J**）

调研中发现的、和"分区注册 + 持久任务板 + 派发 worker + 模型工具"最接近的**官方现成实现**：
`@deepseek-ai/dsh-agent-team`（base 已挂载，`PKG(dsh-base)\cordis.patch.yml:366-372`，`config.maxTasks: 256`）+ `@deepseek-ai/dsh-tool-agent-team`（模型工具）+ `@deepseek-ai/dsh-client-ui-agent-team`（Web UI，`PKG(dsh-web-app)\cordis.patch.yml:412-413`）。

### M1. 数据模型（持久、可重放）

```ts
// PKG(dsh-agent-team)\src\types.ts:47-101
type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
interface TeamTaskSnapshot {
  id: TeamTaskId; revision: number; subject: string; description: string;
  status: TeamTaskStatus; ownerId?: SessionId; ownerName?: string;
  blockedBy: TeamTaskId[]; writeScopes: string[]
}
interface TeamTaskView extends … { ready: boolean; writeScopeWarnings: string[] }
interface TeamProjection { enabled: boolean; tasks: TeamTaskView[]; failure?: string }
interface TeamMemberSnapshot { id: SessionId; name; description; provider; context: 'fresh'|'fork'; phase: 'provisioning'|'active'|'failed'; error? }
```

**任务持久化在 session 日志里**，不是外部数据库：
- 事件 `team/task`（`version: 2`，payload `{ teamId, task: TeamTaskSnapshot }`），`types.ts:181`、`projection.ts:48-52`；
- 事件 `team/mode`（`{ enabled: boolean }`），`projection.ts:87`；
- 折叠规则：同一 task 的 `revision` 必须连续（从 1 开始），否则报错（`projection.ts:137-140`）——即**每个任务事件是一次带版本的全量快照**，天然可重放、可审计。

### M2. 投影与客户端读取

```ts
// PKG(dsh-agent-team)\src\projection.ts:210-217
export const teamProjectionDefinition = {
  key: 'agentTeam',
  stateSchema: teamProjectionEntrySchema,   // { id: TeamId, enabled, tasks: TeamTaskSnapshot[], failure? }
  wire: { viewSchema: teamProjectionSchema, view: teamProjectionView },
}
```
所以客户端**直接** `useProjection('agentTeam')` 就能拿到 `{ enabled, tasks: TeamTaskView[], failure? }`（I-38 的同一套机制），不需要任何额外 Remote。这就是"任务板 UI + 实时进度"的官方最短路径。

### M3. 服务与工具

- 服务：`ctx.agentTeams`（`TeamService extends TypertRemoteService`，`PKG(dsh-agent-team)\src\index.ts:46`）；它在 `agent/created` 上做成员 provisioning（`:80`）。
  该服务的**公开 Remote 命名空间与方法名未核定**：本会话只读了 `src/index.ts`（7.0k）的类声明与 `src/{types,projection}.ts`，`src/task-board.ts`（12.9k）/`journal.ts`/`task-graph.ts` 未逐行读。需要精确签名时读 `src/index.ts` 里 `@Remote` 装饰的方法，并看 `ctx.agentTeams` 的 Context 声明（`index.ts:26-31`）。
- 模型工具（`PKG(dsh-tool-agent-team)\src\index.ts`，`inject: ['agentTeams','subagents','tools','systemPrompt']`）：
  `team_task_create`（`:118`）、`team_task_list`（`:144`）、`team_task_get`（`:185`）、`team_task_update`（`:201`），外加 system prompt 段 `team:policy`（`:113`）。
- 消息：`source.kind: 'team-message'`（`types.ts:121-126`），参数含 `teamId/messageId/senderId/senderName`。
- 工具与 todo/present 一样是**按 preset 组合**的：`PKG(dsh-web-app)\presets\{standard,ptc,minimal}.patch.yml` 里有 `tool-todo`、`tool-present` 行（如 `standard.patch.yml:119-129`），base 里没有 `tool-present`（只在 `dsh-sdk-app\cordis.patch.yml:81`）。**自建 preset 必须自己加这些行，否则那些工具不存在。**

### M4. 对 host-router 的设计含义

1. **"任务板"这个能力官方已经有了**：per-session 任务列表 + 依赖（`blockedBy`）+ 写域（`writeScopes`）+ 归属（`ownerId`）+ 版本化事件 + client projection + UI。先判断能不能**直接复用/扩展**（例如只加自己的"分区"维度），再决定要不要重写。
2. **要抄的模式（这是被验证过的最好形态）**：
   - 每个任务一次**全量快照 + 单调 `revision`** 写进 **owner session 的日志**（`session.append('yourdomain/task', {...})`），而不是插件内存或旁路 DB；
   - 用 `sessionProjections.register({ key, stateSchema, apply, wire: { view..., summary } })` 折叠成 client 可见 view；
   - `kind` 用 `'yourdomain/task'` 这种带命名空间的事件名 + `declare module '@deepseek-ai/dsh-session/types'` 声明，别用 `plugin:` 前缀（那是实验包保留）。
3. **不要**在插件里另造一套"任务内存表 + 定时器扫描"：官方路径是"日志是唯一真相 + 投影是派生缓存"（`DOC(practices.md:7-9`）。
4. 任务板要"跨 session 全局视图"时，官方 board 只覆盖单 session 的 team；跨 session 汇总需要你自己读多个 session 的 `agentTeam` 投影（`ctx.sessions.list.getSnapshot().projectionsBySession`）或加 storage domain（D-14）。

---

# 第二部分：宿主 / 包 / 工具 / 持久化（A–H）

## A. 包与 bundle 机制

### 1. 可安装 bundle 包需要哪些 manifest 字段

真实样例（语音/技能类可选 bundle）`PKG(dsh-experimental-badge-skill-bundle)\package.json`：

```json
{
  "name": "@deepseek-ai/dsh-experimental-badge-skill-bundle",
  "version": "0.2.2-rc.3",
  "type": "module",
  "icon": "./icon.svg",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./package.json": "./package.json"
  },
  "files": ["icon.svg","locale/*.json","docs","lib/index.js","cordis.patch.yml","lib/types/**/*.d.ts","src"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": { "@deepseek-ai/dsh-skill-badge": "0.2.2-rc.3" },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.1.0" }
}
```

CLI 模板（最小 host-only bundle，`DOC(host-plugin.md:9-27)`）：

```json
{ "name": "@local/my-plugin", "version": "1.0.0", "private": true, "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

字段规则（证据 `DOC(host-plugin.md:5-56)`）：
- `dsh.bundle.patch`：**必需**，bundle 的定义就是这个字段；值为 patch 文件相对路径。
- `exports` 必须包含：`.`（插件入口）、`./cordis.patch.yml`、`./locale/*.json`、`./icon`（或顶层 `icon` 字段）、`./package.json`。有 client 半还要 `./client`。要暴露源码给类型系统时加 `./src/*`。
- `icon`：包根（`package.json` 顶层 `"icon": "./icon.svg"`）优先于 `./icon` 导出；SVG/PNG/JPEG/WebP，≤256 KiB，必须在包内。
- `locale/*.json`：`{ "meta": { "title", "description", "detail" } }`，Plugin Manager / Settings 不激活插件也读它。
- `peerDependencies`：**只对 `@deepseek-ai/cordis` 声明 `~4.1.0`**（运行版 cordis 为 4.1.0）。宿主已提供的 `@deepseek-ai/dsh-*` 包**不要**写进 dependencies（"Packages shipped with dsh resolve from the dsh installation, so the bundle declares no dependencies on them"，`DOC(plugin-development.md:13)`）。
- `files`：本地目录安装是软链，`files` 不过滤；发布/打包时才生效（`DOC(host-plugin.md:36)`）。

### 2. `cordis.patch.yml` 语法

权威：`DOC(composition-reference.md:5-20)`。要点：

- 补丁是**有序层**，每层一个 mapping：`insert: [rows]` 或"按 id 定向覆盖"。
- `insert` 带 `id`（指向已存在的 `group: true` 行）时，行插进该 group 的 `config` 列表里。
- 带 `id` 且无 `insert` = 覆盖该行；**提供的字段整体替换该行字段；`config` 是整体替换，不做深合并**（必须重述该行需要的每个字段）。truthy 的 `name` 是"断言名字"，不是改名。
- 无 id 的非 insert 补丁、以及匹配不到行的目标：警告并跳过。
- 行字段：`id`、`name`（包 specifier，可以是子路径如 `@deepseek-ai/dsh-plugin-manager/tools`）、`config`、`disabled`、`inject`、`intercept`、`isolate`。
- `group: true` + `name: cordis:group` ⇒ `config` 是嵌套条目列表；`cordis:include` 从 `config.path` 读 YAML/JSON。
- `disabled` 可为 `boolean`、`null` 或 `!!js` 表达式（每次挂载决策求值）。**`config` 不能用来禁用行**。
- `!!js` 是 Loader 表达式（不是 `!js`）。写在 `config` 里则在注入激活后、对插件上下文求值，可用 `ctx.<service>`、`dshHomePath(...)`、`process.env`、`process.platform`。

真实片段（`PKG(dsh-base)\cordis.patch.yml`）：

```yaml
- insert:
    - id: plugin-manager
      name: '@deepseek-ai/dsh-plugin-manager'
      disabled: !!js "!ctx.get('profileContext')"
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
    - id: bash-sandbox
      name: '@deepseek-ai/dsh-bash-sandbox'
      disabled: !!js process.platform === 'win32'
```
（行号：`:20-33`、`:182-190`、`:249-253`）

自建 bundle 的最小 patch（`DOC(host-plugin.md:20-27)`）：

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

### 3. bundle 怎么挂到 profile

两条路，**都合法，但职责不同**：

1. **插件管理器（推荐，用户路径）**：`plugin_manager` `action: install_bundle`，`target` = 包目录绝对路径。它负责 `package.json` 写入、依赖安装、bundle 选择。
   证据：`DOC(plugin-development.md:3-5`、`DOC(host-plugin.md:73-75)`。
2. **直接改 profile manifest**：`C:\Users\<你>\.dsh\profiles\desktop\package.json` 的
   `dependencies`（本地包用 `file:E:/path`）+ `dsh.profile.bundles` 数组。
   证据：本机真实文件 `package.json:5-20`（deps 有 `"dsh-token-meter-badge": "file:E:/PythonProject/jiuwen/dsh-token-meter-badge"`，bundles 为 `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dshmarket","dsh-computer-use-win"]`）。

坑：手改 profile 后需要 `pnpm install` 才能让 `node_modules` 出现该包；`dsh --profile desktop --dump-config` 可看合成结果（`DOC(plugin-development.md:26)`）。**本任务下不要动 profile。**

### 4. `RETIRED_BUNDLES` 对已安装 profile 的影响

```js
// PKG(dsh-official-bundles)\lib\index.js:21
const RETIRED_BUNDLES = new Set(["@deepseek-ai/dsh-experimental-schedule-bundle", "@deepseek-ai/dsh-experimental-agent-team-profile"]);
```

处理逻辑在 app-boot（`PKG(dsh-app-boot)\src\profile.ts:608-619`）：

```ts
function dropRetiredBundles(dir, manifest) {
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const kept = bundles.filter(bundle => !RETIRED_BUNDLES.has(bundle))
  if (kept.length === bundles.length) return manifest
  return writeProfileManifest(dir, withBundles(manifest, kept))   // 会写回 profile
}
```

结论：
- **会自动从 profile 的 `dsh.profile.bundles` 里移除，并写回 `package.json`**（启动时）。所以"退役"对已安装 profile 的效果 = 该 bundle 不再参与合成。
- **不等于删包**：这个函数只改 bundles 列表，不动 `dependencies`、不动 `node_modules`。包文件是否被后续 `pnpm install` 清掉，`未核定`（取决于 package.json dependencies 是否也被改；本函数不改）。
- 同时注意 `INSTALLATION_OWNED_PROFILE_TUPLES`（同文件 `:15-19`）：headless 模板的旧元组会被整体替换成 `PROFILE_TEMPLATES` 的条目。
- 相关但不同：`PROTECTED_PLUGINS`（`dsh-official-bundles/lib/index.js:61-79`）是"插件管理器拒绝禁用/删除"的集合，含 `@deepseek-ai/dsh-tools`、`dsh-api-gateway`、`dsh-host-webserver`、`dsh-client-modules` 等。

## B. 分区（workspace）

### 5. `ctx.workspaceRegistry` 完整方法

服务类 `WorkspaceRegistry extends Service`，`static inject = ['storageDomain','sessionPersistence']`。
证据：`PKG(dsh-workspace)\src\index.ts:186-190`。

| 方法 | 签名 | 证据 |
|---|---|---|
| `create` | `(path: string, title?: string) => Promise<Workspace>` | `:254` |
| `initializeDefault` | `(resolveDirectory: () => Promise<string>) => Promise<Workspace \| undefined>` | `:274` |
| `get` | `(id: WorkspaceId) => Workspace \| undefined` | `:298` |
| `list` | `() => Workspace[]`（按持久顺序，同步） | `:308` |
| `delete` | `(id) => Promise<boolean>` | `:326` |
| `insertBefore` | `(id, beforeId?) => Promise<readonly WorkspaceId[]>` | `:337` |
| `archiveSession` | `(sessionId, options?: {stopActivity?: boolean}) => Promise<void>` | `:381` |
| `unarchiveSession` | `(sessionId) => Promise<void>` | `:420` |
| `pinSession` / `unpinSession` | `(sessionId) => Promise<void>` | `:450` / `:477` |
| `resolveByPath` | `(path) => Promise<Workspace \| undefined>` | `:524` |
| `archivedSessionIds` | getter | `:360` |

`Workspace` 接口（`PKG(dsh-workspace)\src\types.ts:69-153`）：
`id`、`path`（create 时 realpath 化的规范路径，之后永不改写）、`title`、`createdAt`、`updatedAt`、`sessionIds`（经 header 校验过滤后的有序候选）、
`setTitle(title)`、`attachSession(sessionId)`、`insertSessionBefore(sessionId, beforeSessionId?)`、`detachSession(sessionId)`、`status()`（`'ok'|'missing-dir'`）。

持久化格式：`storageDomain` 的 domain `workspace` v2，一个 `workspaces` 表（`WorkspaceRecord = {path,title,sessionIds,createdAt,updatedAt}`）+ 全局 `{initialized, defaultWorkspaceId?, workspaceIds[], archivedSessionIds[], pinnedSessionIds[], pendingMutation?}`。
证据：`PKG(dsh-workspace)\src\spec.ts:24-84`。

### 6. workspace 与 `session.header.cwd` 的关系

**不是"cwd 就是 workspace 根"，而是"cwd 决定成员资格，且只有 header.cwd 算数"。**

- `attachSession` 的校验："A new id's live or persisted **header cwd** must resolve to an existing directory **equal to** `path`；unknown ids、缺失/非法 cwd、不匹配都拒绝写入。"（`types.ts:109-120`）
- `sessionIds` 的过滤："missing headers、invalid cwd、canonical cwd mismatch 永不返回"（`types.ts:89-100`）。
- **`cd` 改的是 `working-directory/change` 事件（有效目录），`header.cwd` 不变**（见 C9/C10）。因此：一个 session `cd` 到别处后，**仍然属于原 workspace**；它不会自动跨到另一个 workspace。
- 反过来：想"把一个 session 放进某个 workspace"，必须让它**创建时的 header.cwd** 等于该 workspace 的规范路径 —— 也就是在创建/派发时指定 `cwd`（见 C8、C12），而不是事后 `cd`。

### 7. `dsh-api-workspace-controller` / `-files` 对 client 暴露的 Remote

`workspace` 命名空间（`WorkspaceController extends TypertRemoteService`，`namespace: 'workspace'`）：
`create`、`initializeDefault`、`rename`、`delete`、`insertBefore`、`insertSessionBefore`、`archiveSession`、`unarchiveSession`、`pinSession`、`unpinSession`、`follow`（**stream**，基线 + 有序增量）。
证据：`PKG(dsh-api-workspace-controller)\src\index.ts:72,90-260`。
`follow` 的帧类型：`{type:'baseline'|'upsert'|'remove'|'order'|'archived'|'pinned'|'replace'}`（`:224-259`），并做 `remoteAccess.allows()` 过滤。
它还会 `ctx.plugin(DirectoryPickerController)`（`:82`），目录选择是独立命名空间。

`workspace-files` 命名空间（`PKG(dsh-api-workspace-files)\src\index.ts`，23.8k）：目录列举、有界读、写入变更 feed（"bounded read, directory listing, and the agent-write change feed inside the session workspace root"，`PKG(dsh-web-app)\cordis.patch.yml:124-129` 的注释）。客户端侧封装在 `src/client/{remote,provider,change-feed}.ts`。**具体方法名未逐条核定**（文件较大，未逐行读完）——需要精确签名时读 `PKG(dsh-api-workspace-files)\src\index.ts` 的 `@Remote` 装饰器。

## C. 跨目录工作（最关键）

### 8. `subagent` 工具在 rc.3 的完整参数

**有 `cwd`。**（这是本任务最关键的一条：rc.3 已支持。）

参数（`PKG(dsh-tool-subagent)\src\index.ts:218-260`）：

| 参数 | 必填 | 说明 |
|---|---|---|
| `cwd` | 否 | 子级初始工作目录；相对路径按**调用者当前目录**解析；省略则继承该目录。之后两边各自独立。 |
| `description` | ✅ | 3–5 词显示标签 |
| `name` | 否 | 子级名，小写字母/数字/连字符，字母开头，≤32，`lead` 保留 |
| `prompt` | ✅ | 任务正文 |
| `agent_preset` | 条件 | 仅当配置了 preset 选择时出现（enum = 允许集合） |
| `provider` / `model` / `reasoning_effort` | 条件 | 仅当 `modelSelection: true` 时出现 |

工具名可配置（`Config.toolName`，默认 `subagent`；base 里还挂了 `toolName: subagent_fork` 的第二个实例，`PKG(dsh-base)\cordis.patch.yml:391-406`）。
`isConcurrencySafe: () => true`（`:273`）——可并行。
执行时把 `cwd` 放进 `SubagentStartRequest`：`...args.cwd === undefined ? {} : { cwd: args.cwd }`（`:318`）。

### 9. `childSessionMeta()` 实际代码：子会话 cwd 从哪来

```ts
// PKG(dsh-subagent)\src\child-agent.ts:135-154
export function childSessionMeta(parent, childDepth, isSeeded, selectedPreset?) {
  const parentHeader = parent.session.header
  return {
    ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},  // ← 父的【header】cwd
    ...agentPreset === undefined ? {} : { agentPreset },
    parentSession: parentHeader.id,
    isSeeded,
    origin: 'subagent',
    delegationDepth: childDepth,
  }
}
```

所以：**子 session 的 `header.cwd` = 父 session 的 `header.cwd`（不可变原值），与 `cwd` 参数无关。**

那 `cwd` 参数去哪了？分两步（`PKG(dsh-subagent)\src\manager.ts`）：

```ts
// :495-501  启动前解析目录
private async resolveDirectory(request, signal) {
  const cwd = request.cwd !== undefined && isAbsolute(request.cwd)
    ? request.cwd
    : resolve(await this.ctx.workingDirectory.ensure(request.parent, signal), request.cwd ?? '.')
  return cwd
}
// :356-362  用解析结果建子会话
const cwd = await this.resolveDirectory(spec, signal)
const prepared = await prepare({ sessionId: childId, cwd, parent, signal })
// :857-865  meta 用 childSessionMeta(...)（header.cwd = 父 header.cwd）
// :832-841  setup 里再改"有效目录"
await workingDirectory.set(child, create.cwd, inputs.signal)
```

**结论（务必写进实现假设）**：
- 子 session 的**有效工作目录** = `cwd` 参数（绝对）或"父的当前有效目录 + 相对路径"；文件工具的相对路径、`working_directory` 工具读到的是这个。
- 子 session 的**沙箱写边界（workspaceRoot）= 父的 `header.cwd`**，因为策略读 header，不读有效目录（见 10）。
- ⇒ **用 `cwd` 派发到另一个目录，并不能让子级在那里写文件**（在 `workspace-write` 下会被 `FS_SANDBOX_DENIED` 拒绝）。跨目录写必须另外解决（见 11 的 `registerWritableRoot`、或让父/根 session 的 header.cwd 就是目标目录、或提权到 `danger-full-access`）。

### 10. sandbox-policy 解析写根：**不**读 `workingDirectory.get(session)`

```ts
// PKG(dsh-sandbox-policy)\src\index.ts:208-230
resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
  return {
    mode: request.mode ?? this.overrideOf(session) ?? this.defaultMode,
    workspaceRoot: this.sessionWorkspaceRoot(session),
    ...
  }
}
private sessionWorkspaceRoot(session: Session | undefined): string {
  const cwd = session?.header.cwd                     // ← header.cwd
  if (cwd === undefined) return this.workspaceRoot     // 部署 fallback
  if (!isExecutionWorldPath(cwd)) throw new SandboxInvalidRootError(...)
  return cwd
}
```

对该包全包搜索 `workingDirectory`：**0 命中**（grep 结果为空）。所以"优先读 `workingDirectory.get(session)`"在 rc.3 **不成立**。

### ⚠️ 10-bis. 这一条在 0.2.2-rc.5 **已经改了**（版本漂移，必读）

rc.5 的同一函数（`CHK(packages/sandbox/sandbox-policy/src/index.ts:230-232)`）：

```ts
private sessionWorkspaceRoot(session: Session | undefined): string {
  const cwd = this.ctx.get('workingDirectory')?.get(session) ?? session.header.cwd
  ...
}
```

即 **rc.5 确实优先 `workingDirectory.get(session)`，rc.3 只用 `header.cwd`**。由此产生一条会让人写出 bug 的差异：

| 行为 | rc.3（本机运行版） | rc.5（源码 checkout） |
|---|---|---|
| `cd` 到别的目录后，`workspace-write` 的写边界 | **不动**（仍是最初 header.cwd），写新目录会被 `FS_SANDBOX_DENIED` | **跟着动**（写新目录可以） |
| `subagent` 的 `cwd` 参数对子级写边界 | **无效**（子级 header.cwd = 父 header.cwd） | 生效（子级 `workingDirectory` 被 set 成该目录） |
| `working_directory` 工具能否作为"跨目录手段" | **不能** | 能 |
| 沙箱策略与"当前目录"是否一致 | **不一致**（模型看到的 cwd 和它能写的目录不同） | 一致 |

**给 host-router 的硬结论：按 rc.3 写。** 跨目录写不要依赖 `cd` / `cwd` 参数，必须显式用 `ctx.sandboxPolicy.registerWritableRoot(session, dir)`（C11-1）或让 session 创建时 header.cwd 就是目标目录。这段代码在 rc.5 上仍然正确（只是多余），反过来则不成立。

文件工具的实际调用点也印证：
```ts
// PKG(dsh-tool-fs)\src\sandbox.ts:89-98
const standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} })
```
注释原文（`:81-82`）："The workspace root is the **original Session directory**, or the deployment fallback when absent."

`resolve()` 的完整输出 `SandboxExecutionPolicy`：`{ mode, workspaceRoot, additionalWritableRoots?, sessionId? }`。
`mode` 优先级：显式 `request.mode` > session 最后一次 `sandbox/mode` 事件 > 部署默认（`:208-220`）。

### 11. `dsh-tool-working-directory` 与 `dsh-working-directory`

工具（`PKG(dsh-tool-working-directory)\src\index.ts:19-42`）：
- 名字：`working_directory`
- 参数：`cd?: string`（省略=读当前目录；空串报 `ToolArgsError`）
- 输出：`{ cwd: string }`
- 行为：`cd` 省略 → `ctx.workingDirectory.ensure(agent, signal)`；否则 `set(agent, cd, signal)`

服务（`PKG(dsh-working-directory)\src\index.ts:76-195`）：

```ts
class WorkingDirectoryService extends Service {
  static inject = ['fs', 'sessionProjections', 'systemPrompt']
  readonly defaultDirectory: string
  get(session: Session): string                                    // 同步，无 IO
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>      // 校验当前目录，消失则回退原项目
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>  // 绝对或相对当前目录
}
```
- 事件：`working-directory/change { cwd }`（`:55-59`），投影 key `workingDirectory`（`:101-108`，`init: header => header.cwd`）。
- waterfall 事件：`working-directory/access(request, next)`（`:32-35`），用于和资源操作（如 checkout 移除）协调。
- 错误：`WorkingDirectoryError` + code `WORKING_DIRECTORY_INVALID` / `WORKING_DIRECTORY_NOT_FOUND` / `WORKING_DIRECTORY_UNAVAILABLE`。
- `set` 会 append 一条 `source: {kind:'working-directory'}` 的 user 消息并 `agent.inject(notice)`（`:217-237`）。

**子会话里能不能切目录？能。切换后沙箱写权限跟不跟？不跟。**
- `set` 的文档注释就写着："Change one Session's directory **without changing existing processes or permissions**"（`:177-179`）。
- 且 `SandboxPolicyService.resolve` 只读 header.cwd（见 10）。

跨目录写真正可用的官方手段，按推荐度：

1. **`ctx.sandboxPolicy.registerWritableRoot(session, directory)`**：给某个 live session 增加额外可写根，运行时生效、dispose 即撤销、必须 resume/fork 后重新注册；Windows 上**只对 harness 文件工具生效，不影响进程权限**。
   证据：`PKG(dsh-sandbox-policy)\src\index.ts:232-261`（返回值即 Cordis effect disposer）。
2. **让 session 的 header.cwd 一开始就是目标目录**：即创建/派发时就给对 `cwd`，或让用户在该目录开新 session / 新 workspace。
3. 部署 `config.additionalWritableRoots`（静态、全局，不区分 session；Windows 同上只对文件工具）。
4. `sandbox_permissions: 'danger-full-access'` 提权（需要审批；每次调用都带 justification）。

### 12. `ctx.agents.create({...})` 完整签名与最小可用例子

```ts
// PKG(dsh-agent)\src\index.ts:66-121
interface CreateAgentOptions {
  readonly sessionId: SessionId                     // 必需：agent 与 session 共用的身份
  readonly meta?: {
    readonly cwd?: string                            // 必须是绝对、已存在目录（session 边界校验）
    readonly parentSession?: SessionId
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  readonly inheritedEventCount?: SessionLogOffset    // isSeeded 时必需（fork 前缀长度）
  readonly seed?: readonly SessionEvent[]
  readonly agentOptions?: AgentOptions               // {provider?, model?, reasoningEffort?, maxTokens?}
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup                        // (agentCtx, agent) => void | AgentSetupCommit | Promise<...>
}
type AgentSetup = (agentCtx: Context, agent: Agent) => AgentSetupCommit | Promise<AgentSetupCommit | void> | void
interface AgentSetupCommit { commit(): void }
```
`ctx.agents.create(options) => Promise<AgentHandle>`，`AgentHandle = { agent, dispose(): Promise<void> }`（`:160-163`、`:410`）。
另有 `ctx.agents.resume({ resumeSessionId, agentOptions?, signal?, setup? })`（`:127-144`）。

`setup` 的契约（`:101-120`，逐条）：
- 在 `agentCtx` 铸造、Session 进入 store、`session/created` 完成之后被 await；
- Agent **尚未**进入 registry，`agent/created` 也还没发；
- setup 期间 Session 接受 live append；
- 所有通过 `agentCtx` 注册的东西（scoped tools、prompt sections、`restrict()`、listeners）在 `agent/created` 与首次 prompt 装配之前就存在；
- setup 抛错/被 owner dispose ⇒ 整个 scope 回滚，但**已提交的 Session 事件保留**；
- **"Setup composes, it never drives"**：不要在 setup 里驱动 agent（followup 等）；创建 resolve 之后再驱动。

最小可用例子（照抄 headless / subagent 的形状：先 setup 组作用域，再 followup 首条消息）：

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

const handle = await ctx.agents.create({
  sessionId: randomUUID() as SessionId,
  meta: { cwd: 'E:/PythonProject/rca-ab-test' },      // 绝对、已存在；决定沙箱写边界
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
  setup: async (agentCtx, agent) => {
    // 只做"组合"：scoped tool、prompt section、监听器
    agentCtx.systemPrompt.section({ name: 'router:task', order: 10, text: 'You are a worker.' })
  },
})
const agent = handle.agent
agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } }))
// 用完：await handle.dispose()
```

参考真实调用点：`PKG(dsh-subagent)\src\manager.ts:857-865`（`agents.create` + setup）、`:826-849`（setup 里 append session 事件、`workingDirectory.set`、`attachStructuredRuntime`）。

### 13. `ctx.subagents` seam 的 provider 接口

```ts
// PKG(dsh-subagent)\src\types.ts:321-364
interface SubagentProvider {
  readonly name: string
  readonly capabilities: { agentOptions: boolean; agentPreset: boolean; outputSchema: boolean; depthLimit: boolean }
  readonly inheritsParentContext: boolean
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>            // 外部执行
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>  // 进程内可续
}
interface SubagentRun { readonly id: SessionId; readonly result: Promise<SubagentResult>; dispose(): Promise<void> }
interface SubagentResult { output: readonly ContentBlock[]; structured?: unknown; diagnostic?: string; stopReason: SubagentStopReason }
type SubagentStopReason = 'completed'|'aborted'|'error'|'max-tokens'|'refusal'
```
`ResolvedSubagentStartRequest extends SubagentStartRequest`，`cwd` 已解析为绝对路径（`types.ts:193-197`）。
注册方式：provider 组件在 apply 里 `ctx.subagents.registerProvider(...)`（**具体方法名未逐字核定**，本会话只读了 `getProvider` / `resolveMaxDepth` / `startActivation` 的调用侧；需要实现自定义 provider 时读 `PKG(dsh-subagent)\src\index.ts` 的 `SubagentRuntime` 公开方法）。

对本任务的实际建议：**不要写自定义 `ctx.subagents` provider**。派发 worker 用现成的 `subagent` 工具或 `ctx.subagents.startActivation({provider:'spawn'|'fork', ...})`。

## D. 持久化

### 14. `ctx.storageDomain` 用法（含最小例子）

前提：宿主组合里 `dsh-storage-domain` 处于挂载状态（base 已挂，`backend: json`，见 A/B 节），且 `ctx.storage` 与后端存在。

API（`PKG(dsh-storage-domain)\src\index.ts:103-193`）：`ctx.storageDomain.open(spec) => Promise<Domain<S>>`；一个 domain 名只能开一次（`already-open`）；**调用方自己负责 `domain.close()`**（通常放进 `ctx.effect` 的 disposer）。

spec 写法（`PKG(dsh-storage-domain)\src\spec.ts:35-147`）：

```ts
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const taskRecord = z.object({
  id: z.string(), title: z.string(), status: z.enum(['pending','running','done']),
  workspaceId: z.string(), sessionId: z.string().optional(), updatedAt: z.string(),
})
export const taskDomainSpec = defineDomain({
  name: 'routerTasks',                 // 必须匹配 UNIT_NAME_RE
  version: 1,
  layout: 'per-record',                // 可选：'single'（默认）| 'per-record'
  global: { schema: z.object({ order: z.array(z.string()) }), initial: { order: [] } },  // 可选
  tables: { tasks: domainTable<string, z.infer<typeof taskRecord>>(taskRecord) },
})
```

读写 API（`PKG(dsh-storage-domain)\src\domain.ts:19-137`）：

```ts
const domain = await ctx.storageDomain.open(taskDomainSpec)
ctx.effect(() => () => { void domain.close() }, 'router: domain close')
const tasks = domain.table('tasks')      // KvTable
tasks.get(key)                            // 同步，从内存读
tasks.entries(); tasks.keys(); tasks.size
await tasks.put(key, value)               // 整体覆盖，不 merge
await tasks.delete(key)                   // → boolean
await tasks.deleteMany(keys)              // → 删除条数，一次写槽
await tasks.update(key, current => next)  // 写链上的原子 read-modify-write；缺失 key 抛 missing-key
domain.global.get(); await domain.global.set(value)   // 无 global 的 spec 访问会抛
```

校验与事件：
- 每次 `open` 都按 zod schema 校验**全部已存记录**，不合法则 `invalid-record` 拒绝打开；spec 可声明 `invalidRecords: 'backup-and-skip'`（仅用于可丢弃的派生数据，且后端要支持 `backupRecord`）。
- 每次落盘成功后 emit `domain/changed`，payload `{domain, table, key, operation:'put'|'deleted', value?}`；`table`/`key` 为 `''` 表示 global。
  证据：`PKG(dsh-storage-domain)\src\events.ts:10-47`。
- 写链顺序保证：先 await 后端持久化 → 再改内存 → 再 emit；后端失败则内存不变（`domain.ts:1-11` 模块注释）。
- 错误类型 `DomainError`，code：`already-open`/`closed`/`invalid-record`/`missing-key`/`backend-not-found`/`facet-unsupported`（`error.ts`）。

### 15. `dsh-storage-json` / `dsh-storage-sqlite` 的差异

**rc.3 只有 json。** 338 个包里没有 `dsh-storage-sqlite`；`dsh-base` 只挂 `storage-json`（`backend: json`）。
rc.5 checkout 里已有 `packages/storage/storage-sqlite`（`CHK(tsconfig.host.json:446)`）——这是**版本漂移**，不要按 rc.5 写配置。

`dsh-storage-json` 配置（`PKG(dsh-storage-json)\src\index.ts:28-36`）：
```yaml
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')   # 必需，无默认（避免 cwd 污染）
```
一个 unit 一个 JSON 文档（`single`）或每条记录一个文档（`per-record`），原子重写发布，注册为后端名 `json`（`:109-119`）。
路由：`storage-domain` 的 `config.backend`（默认）与 `config.routes`（按 domain 名覆盖）（`dsh-storage-domain\src\index.ts:52-62,109`）。

### 16. 直接 `node:fs` 写 `$DSH_HOME`？有官方解析函数

**有**：`@deepseek-ai/dsh-home-paths`（`PKG(dsh-home-paths)\src\index.ts`）：

```ts
export const DSH_HOME_DIR_NAME = '.dsh'
export const DSH_HOME_ENV = 'DSH_HOME'
export function resolveDshHome(configured?: string, env = process.env): string   // configured > $DSH_HOME > ~/.dsh
export function defaultDshHome(): string
export function expandHomePath(path: string): string                             // ~ / ~/ / ~\
export function dshHomePath(...segments: string[]): string                       // = join(resolveDshHome(), ...segments)
export function dshCachePath(...): string                                        // $DSH_HOME/cache/...
export function resolveAgentsHome(...) / dshHomeDisplay(...) / agentsHomeDisplay(...)
```
（行号：`:12-18`、`:70-91`、`:135-137`、`:160-173`）
patch 里也有同名全局可用：`root: !!js dshHomePath('storages')`（`PKG(dsh-base)\cordis.patch.yml:185`）。

在插件里用 `node:fs` 读写自己的文件（例如 `dshHomePath('router', 'tasks.json')`）是**可行且不违规**的：`dsh-home-paths` 只是路径解析，没有强制 schema/锁。代价是你要自己做原子写、并发、迁移、校验。
- 想要 schema 校验 + 变更事件 + 原子写 ⇒ 用 `ctx.storageDomain`（第 14 条）。
- 想要"一个文件、能被人肉编辑、结构简单" ⇒ 直接 `node:fs` + `dshHomePath`，但要自己用临时文件 + rename 做原子写（可参考 `@deepseek-ai/dsh-atomic-write`，rc.3 中存在）。
- **不要**写 `$DSH_HOME/.credentials.yaml`（凭据走 `ctx.credentials`）、不要碰 profile 目录。

## E. 工具注册

### 17. `defineTool({...})` 完整形态

`PKG(dsh-tools)\src\schema.ts:483-546`（`DefineToolOptions` + `defineTool` 在 `:555`）：

```ts
defineTool({
  name: string,                       // 唯一；`run_code` 保留，禁止
  description: string,
  parameters: {                       // 隐式开放 object 根；per-property `required: true`
    foo: { type: 'string', required: true, description: '…', enum: [...], const: '…' },
    bar: { type: 'number' | 'integer' | 'boolean' | 'null' },
    list: { type: 'array', items: <ValueSchemaSpec> },
    obj:  { type: 'object', additionalProperties: false, properties: {...} },  // 显式对象必须写 additionalProperties
    any:  { type: 'json' },
    un:   { oneOf: [<spec>, <spec>, ...] },
  },
  output: {
    schema: <ValueSchemaSpec>,        // 必须是 object 根，成功返回值按它校验
    render(args, value): ContentBlock[],          // 纯函数：转成模型可见 content
    presentationMeta?(args, value): JsonValue,    // 纯函数：可重放的展示元数据（持久化到 tool/result 的 meta）
  },
  deferLoading?: true,                // 请求延迟加载定义
  timeoutMs?: number,                 // 正有限；由 dsh-tool-call-timeout-policy 执行，绝不发给模型
  isConcurrencySafe?(args): boolean,  // 只在严格 true 时才可并行；省略/异常/非 true = 独占
  execute(args, exec): Promise<Value>,
  projectContent?(exec, result): ContentBlock[] | undefined,
  finalizeContent?(exec, result): ContentBlock[] | undefined,
  presentCall?(args): ToolCallView | undefined,
  presentResult?(args, result: ToolResult): ToolResultView | undefined,
})
```

schema DSL 细节（`schema.ts:13-107`）：每类节点共享 `description/title/default/examples`；`type: 'object'` 必须显式给 `additionalProperties`；`oneOf` 至少两个分支；参数根是隐式开放对象。
`defineTool` 的运行时行为：`execute` 前用编译出的 JSON Schema 校验参数，失败抛 `ToolArgsError`；presenters 用"软校验"，参数不合法就返回 `undefined`（因为要通过历史重放）。

`exec: ToolRunContext` 的字段（`PKG(dsh-tools)\src\contracts.ts:175-262`）：

```ts
{
  callId, rootCallId, name, schema?, arguments,
  agent?: Agent,              // 没有调用 agent 时 undefined（如非 agent 调用）
  toolSet?: ResolvedToolSet,  // 本 step 的工具准入集合；条件工具必需
  parent?: ToolExecutionToken,
  signal: AbortSignal,        // 必需，必须转发/观察
  token: ToolExecutionToken,
  deferContext(message: UserMessage): void,   // 结果落地后再追加 context
  concludeTurn(): void,                        // 成功结果终结当前 turn
}
```

### 18. `ToolArgsError` / `ToolContextUnavailableError` 构造签名

```ts
// PKG(dsh-tools)\src\schema.ts:461-471
class ToolArgsError extends HarnessError {
  readonly violations: string[]
  constructor(violations: string[])      // code = 'INVALID_ARGS'
}
// PKG(dsh-tools)\src\contracts.ts:310-325
class ToolContextUnavailableError extends HarnessError {
  constructor(message: string, options?: ErrorOptions)   // code = TOOL_CONTEXT_UNAVAILABLE
}
```
用法：`throw new ToolArgsError(['cd must not be empty'])`（模型可纠正的参数问题）；`throw new ToolContextUnavailableError('present requires an agent Session')`（组合/上下文缺失，模型纠正不了）。
输出契约违约由运行时抛 `ToolOutputError(toolName, violations)`（`contracts.ts:327-337`）。

### 19. 全局注册 vs 单 agent 作用域

```ts
// PKG(dsh-tools)\src\index.ts:121-153
register(definition: ToolDefinition, options?: { when? }): () => void
```
- **全局**：在插件自己的（无 scope 的）context 上 `ctx.tools.register(...)` ⇒ 所有 agent 可见。
- **单个 agent / preset 作用域**：在 `agent.ctx`（或 preset 的 scope context）上 `agent.ctx.tools.register(...)` ⇒ 只对该作用域可见；scoped 工具**遮蔽**同名全局工具（`:199-227`）。
- 同名冲突：同一层内重复注册直接抛错，错误信息明确提示"for a per-agent variant, register through that agent's `agent.ctx` instead"（`:68-71`）。
- **能拿到 `agent.ctx` 的官方时机**：`ctx.on('agent/created', ({agent}) => {...})`（`PKG(dsh-agent)\src\runtime-types.ts:291`）。注意 `DOC(practices.md:19)`：要把注册包进一个 `agent.ctx.effect()` 并**同时**在你自己的插件 effect 里保留这个 disposer（两方 owner）。
- 只做减法：`ctx.tools.restrict({allow|deny})` 必须在**scoped** context 上调用（否则抛错，`:162-189`）；`ctx.tools.guard(fn)` 是单调拒绝（`:384-386`）。
- 条件工具：`register(def, { when: ctx => boolean|Promise<boolean> })`，每 step 解析一次（`:264-297`），false 时既不声明也不可派发。

### 20. 把工具限定给特定 agent preset / 只在某 workspace 生效

- **限定给 preset**：把工具行写进该 preset 的插件列表（`DOC(compositions.md)`），或在 `agent/created` 里按 preset 判 `agent.ctx` 注册/`restrict()`。preset 身份：`ctx.get('agentPresets')?.composedPreset(agentCtx)`（用法见 `child-agent.ts:142`）。
- **`when` 也可以做运行时限定**：`when: ({agent}) => isMyPreset(agent)`（`ToolActivationContext = {agent, modelSelection, signal}`，`contracts.ts:106-113`）。
- **"只在某 workspace 生效"没有内建机制**：工具可见性的作用域键是 agent/preset（`scopeOf(ctx)`，`dsh-scope`），**不是 workspace**。可行做法是在 `when`/`execute` 里用 `ctx.workspaceRegistry` 判断该 session 属于哪个 workspace：
  ```ts
  when: ({ agent }) => ctx.workspaceRegistry.list().some(w =>
    w.sessionIds.includes(agent.session.header.id) && w.id === TARGET_WORKSPACE_ID)
  ```
  注意 `w.sessionIds` 是按 header.cwd 过滤的派生值（见 B6），`cd` 之后不会变。

## F. 唤醒与后台

### 21. `followup()` / `steer()` / `inject()` 与合法 user 消息

签名（`PKG(dsh-agent)\src\runtime-types.ts:234-272`）：

```ts
send(message: UserMessage, target: 'next-turn'|'next-step', wakeup: boolean): void
followup(message: UserMessage): void   // 队列一条独立 turn 并唤醒 driver
steer(message: UserMessage): void      // 最近 step 的 steering；idle 时开启 turn
inject(message: UserMessage): void     // 只排队上下文，不唤醒（会等到下一次 followup/steer）
```

构造合法 `UserMessage`：**用 `createUserMessage`，不要手写对象**（`PKG(dsh-llm)\src\message.ts:246-253`）：

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'
const msg = createUserMessage({
  content: [{ type: 'text', text: '...' }],   // ContentBlock[]
  source: { kind: 'user' },
})
// 返回 { id, role:'user', content, source }，已 deepFreeze + structuredClone
```
`id`/`role` 由工厂生成（`input` 显式禁止 `id`/`role`）。`MessageBase = { id, content, source }`（`:139-148`）。

`source.kind` 的合法值：**开放集合（merge-extensible）**。内置（`message.ts:110-115`）：`'user'`、`'model'`、`'tool'`、`'system-prompt'`。其他包各自 declare-merge 自己的 kind，例如
`'working-directory'`、`'runtime-context'`、`'plan-mode'`、`'goal'`、`'schedule'`、`'tool-registry'`、`'subagent-settled'`、`'agent-message'`、`'team-message'`、`'model-selection'`、`'compact-checkpoint'` 等（grep `interface MessageSourceMap` 全仓可列全）。
**你的插件要自定义 kind 必须 declare-merge**：
```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'router-task': { kind: 'router-task' } }
}
```
不要用不存在的 `'plugin'` catch-all（`message.ts:103-109` 明确说没有）。

### 22. `ctx.jobs` 能跑长任务吗？进程内还是持久？

- 服务：`ctx.jobs`（`JobRegistry`），抽象类，实现是 `@deepseek-ai/dsh-jobs-local`（base 已挂，`cordis.patch.yml:96-97`）。
- **进程内**："The **process-local registry** lives in `@deepseek-ai/dsh-jobs-local`"（`PKG(dsh-jobs)\src\index.ts:7-8`）。
- **跨重启：不保留**。job 记录挂在 registry 与 owner session 上；settled 记录在 owner 销毁 / 服务销毁后消失。可观测的"耐久"只有 `JobSpec.toolCall` 被保留在"durable lifecycle records"里（`types.ts:191`），那是工具调用日志，不是 job 本身。
- 语义要点（`index.ts:57-80`）：registration 的生命周期长于 producer/controller fiber；owner session 的 agent dispose 会 cancel 并 await job；settled 先到先赢、只发一轮事件；每个 job 有一条有界 output ring + 绝对字节偏移游标供任意 observer 读。
- 生产者接口：`ctx.jobs.start(spec)`，`spec.run(handle) => { cancel(reason?), done: Promise<JobOutcome> }`（`types.ts:157-213`）。
- **对任务板的含义**：后台长任务不要依赖 jobs 做持久真相；持久真相放会话日志或你自己的 storage domain，jobs 只作为"运行时句柄 + 实时输出"。

### 23. "任务完成回写 + 唤醒父 agent" 的现成机制

**有，就是 subagent runtime 的 result delivery。**
- 子级结算后，runtime 会向父 agent 推一条带 `source.kind:'subagent-settled'` 的消息并**唤醒父**：
  `PKG(dsh-subagent)\src\manager.ts:656` → `local.handle.agent.followup(message)`
  消息构造在 `PKG(dsh-subagent)\src\continuation-messages.ts:30-44,135-169`（`'subagent-settled': SubagentSettledMessageSource`，payload 带 child session id / 结果等）。
- 另有 `'agent-message'` kind（`continuation-messages.ts:42`）= `send_message` 工具的跨 agent 消息。
- 事件面：`subagent/…` 观测事件也存在于 `dsh-subagent\src\index.ts:160`（"A published child settled. Scope-filtered dispatch …"）。

所以任务板想"worker 干完 → 父 agent 继续"，**用 `subagent` 工具 + 默认 `delivery: 'parent'` 即可，不需要自己写唤醒**（`dsh-tool-subagent\src\index.ts:326-334`）。
若你要自己实现（例如 worker 是独立 session 而非 subagent）：结算后 `parentAgent.followup(createUserMessage({ source: { kind: '<你的 kind>' }, content: [...] }))`。注意 `inject()` **不会**唤醒（`runtime-types.ts:263-271`）。

## G. Client UI

### 24. `dsh.client` 段完整字段

解析器：`PKG(dsh-client-modules)\src\client\manifest.ts:173-193`。

```ts
interface DshClientManifest {
  platform: string        // 必需，字符串；shipped 包都是 'web'
  inject?: string[]       // 包名数组：这些包的 factory 必须先到达才物化本行
  external?: string[]     // 精确的非注入模块请求（见 WebBootGraph.entries）
  immediately?: boolean   // 第一阶段预取（bootstrap 期注册 factory）
}
```
真实样例：`PKG(dsh-experimental-badge-skill-bundle)` 之类的 UI bundle 与模板 `DOC templates/decoration/package.json:13-20`：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
}
```
`PKG(dsh-client-ui-renderer)\package.json:29-34` 是"不需要 inject"的例子（只有 `platform` + `immediately`）。

### 25. `exports` 里的 `./client` 入口怎么建

- 约定：包的 client 半就是 `<包名>/client` 这个 exports 子路径（`manifest.ts:209-218` 注释："`<id>/client` (the exports subpath …) IS its package's client half"，`stripClientSuffix` 在 `:218`）。
- shipped 包写法（`PKG(dsh-client-ui-renderer)\package.json:21-24`）：
  ```json
  "exports": { "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" } }
  ```
- 模板（无构建）写法：`"exports": { "./client": "./client.js" }`，`client.js` 用 `window.__ModuleLoader__.load({ id: '<包名>', factory(require){...} })`（`DOC templates/decoration/client.js:1-22`）。
- **factory 的 id 必须等于包名**（`DOC(ui-plugin.md:9)`），且由它返回一个 Cordis 插件对象 `{ inject, apply(ctx) }`。
- 产物怎么来：手写 JS（模板路线）或在源码 checkout 里用 `tsdown --env.DSH_BUILD_FACE client` 编出 `lib/client.js`（见 H31）。

### 26. 客户端注册面板/视图到侧栏或主区域

三种落点，按"加东西"的推荐度：

| 目标 | slot | kind | 备注 |
|---|---|---|---|
| 右侧栏 tab | `sidebar.right.pane.tab`（key = 你的 tab 定义 id） | keyed / session | 见 I-34，**任务板选这个** |
| 左侧栏内某座位 | `sidebar.panellist`(list,root)、`sidebar.footer.action`(list) | list | `PKG(dsh-client-ui-sidebar)\src\client\index.ts:97-104` |
| 主区域新面板 | `main` | keyed / root | 与 `ctx.layout.selectPanel(id)` 配套；需要自己提供侧栏入口 |
| 全帧浮层 | `shell.overlay` | list / root | 最"加不改"的位置 |
| 对话内 | `conversation.*`（见 I-35 列表） | 各不同 | `conversation.input.dock` / `conversation.composer.dock` 是最常用的两条 |

注册形态（`ctx.slots` 服务，由 renderer 提供 `'slots'`）：

```js
ctx.slots.inject('<slotName>', () => ctx.slots.register({ name: '<slotName>', id, order, locale, key?, inject?, children?, store? }, Component))
```
- `ctx.slots.inject(ownerKey, callback)`：owner 声明塌陷时回收其注册，恢复时重装（`DOC(practices.md:36`、模板 `client.js:16`）。
- **没有 `ctx.uiRenderer` 的公开用法**：`ctx.uiRenderer` 只出现在 renderer 包描述里（package.json description "React slot bindings, ctx.uiRenderer, and the assembled application root"）。第三方插件面向的是 `ctx.slots`。`mount.ts` 那套是**仓库内部脚手架**，不是插件契约；`未核定` 其在插件侧的可复用性。
- 组件必须是纯 React；资源（样式、定时器、监听器）在 `apply` 里用 `ctx.effect`/`ctx.on` 注册并返回 cleanup。组件崩溃会导致该 slot entry 空白（console: `slot entry crashed in '<slot>'`，`DOC(practices.md:35)`）。

### 27. 客户端怎么拿宿主数据

四条官方通道，按推荐度：

1. **投影（推荐，最省事）**：slot props 里的 `useProjection('<key>')`（I-38）。宿主声明 `wire.view` 的值会自动送到浏览器。
2. **Remote（读/写业务 API）**：`inject: ['remote', 'remote.<namespace>']`，然后 `await ctx.remote.<ns>.<method>(...)` → `RemoteResult`（`response.ok ? response.value : response.error.code/message`）。
   证据：`PKG(dsh-client-ui-settings-models)\src\client\index.ts:68`（inject 串里就写着 `'remote.credentials'` 等）、`operations.ts:76-98`。
   事件订阅：`ctx.remote.$on('<ns>/<event>', cb)`（`index.ts:124-127`）；流：`ctx.remote.$stream({name, open, ended})`（`PKG(dsh-client-ui-settings-account)\src\client\index.ts:99-101`）。
3. **Client 服务**：`ctx.sessions`（`list.getSnapshot()`、`binding(sessionId)`、`refreshProjections(id)`、`loadOlder()`）、`ctx.uiConversation`、`ctx.uiWorkspace`、`ctx.sidebarRight`、`ctx.sidebarRightTabs`、`ctx.layout`、`ctx.locale`、`ctx.theme`、`ctx.shortcuts`、`ctx.contextMenus`、`ctx.resources`。
4. **`@deepseek-ai/dsh-client-resources`**：**存在**（`PKG(dsh-client-resources)`，deps 含 `dsh-client-store` 与 `dsh-client-ui-slots`）。它提供 `ctx.resources`（资源模型，右侧栏 `inject` 列表里有 `'resources'`，见 `sidebar-right\src\client\index.ts:89`）。**具体 API 未核定**（未逐行读该包源码）。

⚠️ **重要限制**：`@deepseek-ai/dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`、`dsh-client-store` **都不在 rc.3 的运行版 asar 里**。shipped client 包把它们列为 `devDependencies`，只用于编译期类型（已按包核对）。因此：
- 运行时**只能** `require('react')` 和走 `window.__ModuleLoader__` 的模块表；
- 想用 `PropsRuntime` / `SlotMap` / primitives 的组件，必须在**源码 checkout**里编译（那里有这些 workspace 包），或者放弃类型自己写 DOM/CSS。
- `DOC(practices.md:35)` 还明确禁止 `require('@deepseek-ai/dsh-client-ui-primitives')`：要复制其源码里的 markup/CSS 自己实现。

### 28. 编译 client 端需要什么

- **路线 A（推荐，零构建）**：手写 `client.js`，用 `window.__ModuleLoader__.load({id, factory})`，`require('react')`。模板即此法（`DOC templates/decoration/client.js`）。不需要 tsconfig / tsdown / CSS 处理。
- **路线 B（在 checkout 里编译）**：
  - 每个 client 包自带 `tsconfig.json`（extends `../../../tsconfig.base.json`），client 聚合在根 `tsconfig.client.json`；
  - 构建命令：`pnpm run build:lib:client` = `tsc -b tsconfig.client.json && tsdown --config-loader native --env.DSH_BUILD_FACE client`（`CHK(package.json)` scripts）；
  - **CSS Modules**：源码里 `import css from './X.module.css'`，每个 client 包需要自带 `src/css-modules.d.ts`（根 `tsconfig.client.json` 的 include 里显式列了 `packages/client/*/src/css-modules.d.ts`、`packages/experimental/*/src/css-modules.d.ts`），tsdown 负责实际抽取/注入。
- 宿主半仍是普通 Node 包（`tsc -p tsconfig.host.json`）。

### 29. 一个最小可运行 client UI 插件完整文件清单

按 rc.3 的模板（`DOC templates/decoration/`）逐字清单：

```
my-plugin/
  package.json          # name/version/type/exports(./client,./locale/*.json,./icon)/files/dsh.bundle.patch/dsh.client
  cordis.patch.yml      # - insert: [{ id, name }]
  index.js              # export function apply() {}     ← host 半，可为空
  client.js             # window.__ModuleLoader__.load({ id: '<包名>', factory(require){ ... } })
  locale/en.json        # { "meta": { "title", "description", "detail" } }
  locale/zh.json
  docs/DETAIL.md        # meta.detail 指向
  icon.svg
```
（`DOC(host-plugin.md:29-56)` 的显示清单是**硬要求**：本地化标题/描述、可选详情页、原创或合规授权的图标、`exports` 覆盖 `./locale/*.json` 与 `./icon`。）

---

## H. 编译与验证

### 30. 在 `E:\PythonProject\deepseek-harness-latest` 新建包后如何被 TS 正确解析

（本节基于 rc.5 checkout 的实际结构；rc.3 无源码 checkout，只能参照。）

1. **放对目录**：`packages/<group>/<dir>/`。根 `pnpm-workspace.yaml` 的 glob 是 `packages/*/*`（`CHK(pnpm-workspace.yaml:1-4)`）——两层，新目录自动进 workspace，**不需要改 yaml**。
2. **包内 `tsconfig.json`**：照抄同组（`CHK(packages/workspace/workspace/tsconfig.json)`）：
   ```json
   { "extends": "../../../tsconfig.base.json",
     "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
     "include": ["src"],
     "references": [ { "path": "../../../vendor/cordis" }, { "path": "../../core/tools" }, ... ] }
   ```
   依赖的每个 workspace 包都要在 `references` 里列（composite 项目引用）。
3. **挂到聚合 program**：
   - host 半 ⇒ 在根 `tsconfig.host.json` 的 `references` 数组加 `{ "path": "./packages/<group>/<dir>" }`（`CHK(tsconfig.host.json:304-644)` 是那个数组）。
   - client 半 ⇒ 包内要有 `tsconfig.client.json` + `tsconfig.host.json` 两个面（shipped client 包都是这个形状：`tsconfig.host.json` / `tsconfig.client.json`），并在根 `tsconfig.client.json` / `tsconfig.host.json` 分别加 `{ "path": "./packages/<group>/<dir>/tsconfig.client.json" }` / `…/tsconfig.host.json`（例如 `CHK(tsconfig.host.json:310)` `packages/experimental/client-ui-cot-translation/tsconfig.host.json`）。
   - **不要**改根 `tsconfig.json`：它是 `files: []` 的 solution 文件，只引用 host/client 两个聚合（`CHK(tsconfig.json:1-15)`，注释明确 "NEVER add include/files entries"）。
4. **依赖声明**：包 `package.json` 里把用到的 workspace 包写成 `"@deepseek-ai/xxx": "0.2.2-rc.x"`（同仓惯例），然后 `pnpm install` 让 link 生效。
5. 如果只是想**独立做个插件包**（不改进 checkout 的构建图），完全不需要这些：`plugin_manager install_bundle` 接受任意本地目录（见 A3），TypeScript 只需你自己的 tsconfig。

### 31. 编译命令

- **host 插件包**：`pnpm run build:lib:host`（= `tsx scripts/compile-referenced-projects.ts host-libraries && tsc -p tsconfig.host.json && pnpm --filter @deepseek-ai/dsh-desktop run bundle`）。
  单包快速校验：`pnpm exec tsc -b packages/<group>/<dir>` 或 `pnpm run typecheck`。
  外部插件（不进 checkout）：`pnpm exec tsc -p tsconfig.json`（自己的）即可，产物是普通 ESM。
- **client 插件包**：`pnpm run build:lib:client`（= `tsc -b tsconfig.client.json && tsdown --config-loader native --env.DSH_BUILD_FACE client`）。
- **不需要编译的路线**：手写 `client.js` + `index.js`（模板路线），零构建，直接可装。
- 参考：`CHK(package.json)` 的 `scripts.build`/`build:lib`/`typecheck`；本机 pnpm/npm 需 `--registry=https://registry.npmmirror.com`、代理 `http://127.0.0.1:7890`。

### 32. 不重启、不改 profile 验证插件能加载

按可行度：

1. **装进 profile 后由 HMR 热生效（官方路径）**：`plugin_manager install_bundle` 后 `application` 返回 `applied` 表示已生效；**新增** bundle 可通过 HMR 激活，**替换已安装包的 JS 模块需要重启**（`DOC(host-plugin.md:75)`、`DOC(plugin-development.md:20)`）。这就是"不重启"能达到的上限。
2. **纯 Host 侧快速自检（不装）**：Electron as node 直接 import 你的包并调 `apply`：
   ```powershell
   ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" -e "import('file:///E:/.../index.js').then(m=>console.log(Object.keys(m)))"
   ```
   能验证语法/导出形状，验证不了 Cordis 注入与 UI。
3. **Cordis 检查工具**（若 profile 里有 `tool-cordis`/inspector）：`cordis_inspect_list` / `cordis_inspect_query`（`Service` / `Event` / `Config.listConfigs`）。本会话工具集里**没有**这两个工具，所以本任务下不可用；`host-router` 若在自己的会话里有，可直接查 Service 方法与 Config。
4. **`dsh --profile desktop --dump-config`**：打印合成后的 profile 配置（`DOC(plugin-development.md:26)`），能验证 patch 语法与行冲突，但会读 profile（只读操作）。
5. **明确不要做**：改 `~/.dsh/**`、重启应用、直接写 profile 的 `package.json`。

**`未核定`**：是否存在"加载一个未安装 bundle 并 dry-run 校验 patch"的官方命令。`dsh-app-boot` 里有 profile 解析与 patch 合成逻辑，但没有对外的 dry-run 入口被我找到。

---

# 附录：本任务最容易踩的坑（按作者经验排序）

1. **沙箱写边界读的是 `session.header.cwd`（不可变），不是当前工作目录。** `cd`、`subagent` 的 `cwd` 参数都不会移动写边界（**rc.3**；rc.5 已改为优先 `workingDirectory.get`，见 C10-bis）。跨目录写只能靠 `registerWritableRoot` / 创建时给对 cwd / 提权。（C9、C10、C11）
2. **`todo/write` 投影在 `turn/start` 被清空。** 面板要显示"历史完成清单"必须读日志事件，不能只读 `todos` 投影。（J37）
3. **`rightbar` 是 single slot 且已被右侧栏占据**，抢占 = 干掉文件树/终端/浏览器。要加东西只能加 tab 类型。（I33、I34）
4. **`@deepseek-ai/dsh-client-ui-slots` / primitives / dockkit / client-store 不在运行版 asar 里**，运行时不可 import；client 插件要么手写 JS，要么在 checkout 里编。（G27、G28）
5. **patch 的 `config` 是整体替换，不深合并**；覆盖已有行必须重述全部字段。（A2）
6. **`defineTool` 必须声明 `output.schema` + `output.render`**，否则 `tools.register` 直接 TypeError；`run_code` 名字保留。（E17）
7. **`ctx.tools.restrict()` 只能在 scoped context 上调**，全局调直接抛错。（E19）
8. **`inject()` 不会唤醒 agent**，只有 `followup()`/`steer()` 会。（F21）
9. **profile 里的 `RETIRED_BUNDLES` 会被启动时静默从 bundle 列表移除并写回**，别把依赖挂在退役 bundle 上。（A4）
10. **rc.3 没有 `dsh-storage-sqlite`**，只有 json；storage 后端名是 `json`。（D15）
11. **任务板/团队能力官方已有** `ctx.agentTeams` + `agentTeam` 投影 + `team_task_*` 工具 + `dsh-client-ui-agent-team` UI，且 base 已挂载。别在不知道它存在的情况下重写一套。（M）
12. **`todo_write` / `present` / `team_*` 是 per-preset 组合的**（`dsh-web-app\presets\*.patch.yml`），base 里没有 `tool-present`。自建 preset 不加行 = 工具不存在。（K41、M3）
13. **`hooks` 注入面在组件里变成 `use<Name>` prop，但权威类型在未发货的 `dsh-client-ui-slots` 里**，所以 prop 名只能从运行时 props 观察确认，不能靠 import 类型得到。（I34 备注、G27）
14. **`.env` 是凭据的只读 fallback**，`dsh-credentials-local` 永不写它；写 key 只能走 `ctx.credentials.set` / `ctx.remote.credentials.set`（落到 `$DSH_HOME/.credentials.yaml`）。（L43）



# dsh-client-ui-router

DeepSeek Harness Web 客户端的**任务面板插件**：挂在右侧栏的一个 tab 里，
显示「分区 / manager / worker / 任务」，每个任务能看到它的**工作清单**与**干到哪一步**。

```text
┌──────────────── 左：原生会话 ────────────────┬──── 右：本插件 ────────────────┐
│  你：把这几个需求做一下…                      │ 任务面板        3 分区 · 9 worker │
│  AI：按分区下发给 3 个 manager…               │ 投递需求  [一行一条，自动判分区] │
│                                              │ 分区花名册                        │
│                                              │  rca-ab-test  ● 在线  4 worker    │
│                                              │    worker-1 go build  ●           │
│                                              │    worker-2 已释放 ○（不占机器）   │
│                                              │ 待派 │ 进行中 │ 待验收 │ 已完成    │
│                                              │ …每个任务卡片带工作清单与当前步骤… │
└──────────────────────────────────────────────┴───────────────────────────────────┘
```

- **左半边不是本插件**：那是原生 conversation。本插件只贡献右侧一个 tab + 一个会话头按钮。
- **`待验收`（worker 自报）与 `已完成`（验收通过）是两条泳道**，永不合并。
- **空闲 worker 显示「已释放」**（虚线胶囊、空心点），不会让人以为机器还被占着。

截图（`docs/screenshots/`）：[停靠态·亮](docs/screenshots/panel-docked-light.png) ·
[停靠态·暗](docs/screenshots/panel-docked-dark.png) · [宽屏看板](docs/screenshots/board-wide.png)

---

## 1. 它是怎么挂上去的

rc.3 的右侧栏是**两阶段注册**（不是抢 `rightbar` 这个 single slot）：

```js
// 阶段一：登记一个 tab 类型
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'dsh-client-ui-router/board',   // 全局唯一，也是阶段二的 key
  kind: 'router-board',               // openTab 用的名字
  priority: 'extension',
  multiple: false,
  keepMounted: true,
  title: () => '任务面板',
}), 'client-ui-router: tab type')

// 阶段二：向 keyed slot 注册 body / title，key = definition.id
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab', key: 'dsh-client-ui-router/board', locale: 'router.board', inject: …,
}, RouterPanel))
```

> 直接注册 `rightbar` 会把文件树/终端/浏览器/文档预览四个面板一起顶掉——所以不走那条路。

入口：会话头按钮（`conversation.session.header.utilities`）调 `ctx.sidebarRight.openTab('router-board')`。
面板标题条还会带「待验收 N」，因为 worker 自报完成是最不该被漏掉的一件事。

## 2. 数据从哪来

| 数据 | 来源 |
|---|---|
| 分区、manager、worker、任务、状态、需求流水 | 宿主 `packages/host-router` 的 `router` Remote（见 [docs/CONTRACT.md](docs/CONTRACT.md)） |
| worker 的**工作清单** | 原生 `todos` 投影：`ctx.sessions.list.getSnapshot().projectionsBySession[workerSessionId].values.todos`，按需 `refreshProjections(id)`。宿主没接时回落任务自带的 `todos` |
| 宿主没装 | 内置示例数据，头部显示 `示例数据` 徽标，不假装是真的 |

「工作清单」**没有自定义协议**——`todo_write` 工具写 `todo/write` 事件，`dsh-tool-todo`
已经注册了 `todos` 投影（`wire.view`），客户端直接读。细节与坑（`turn/start` 会把它清成 `null`）
见 CONTRACT.md §5。

## 3. 构建与验证

```bash
cd E:\PythonProject\dsh-router-b\packages\client-ui-router

node node_modules/typescript/bin/tsc -p tsconfig.json          # 类型检查（无输出=通过）
node node_modules/typescript/bin/tsc -p tsconfig.build.json    # 产出 lib/types/**/*.d.ts
node scripts/build-client.mjs                                  # 产出 lib/client.js（loader 封装）
node scripts/build-host.mjs                                    # 产出 lib/index.js（Node 半边）
node scripts/verify-load.mjs                                   # 装载验证 + 首屏渲染断言
node scripts/build-preview.mjs                                 # 预览页（截图用）
node scripts/serve-preview.mjs                                 # http://127.0.0.1:4788/
```

`verify-load.mjs` 做的事（35 条断言，全部通过）：

1. 用 `vm` 执行 `lib/client.js`，断言它调用 `window.__ModuleLoader__.load({ id: 'dsh-client-ui-router', factory })`；
2. 用真实 React 回答 `require('react')`，断言 `factory()` 返回 `{ apply, inject }`；
3. 构造一个 ctx（slots/locale/sidebarRightTabs/sidebarRight/effect），跑 `apply(ctx)`，
   断言它注册了 tab 类型、`sidebar.right.pane.tab`、`.title`、会话头入口、以及 locale 命名空间；
4. 用 `react-dom/server` 渲染真正注册进去的那个组件，断言渲染出花名册、四条泳道、
   worker 的清单与当前步骤、以及 `reported` / `verified` **确实在不同泳道且不串味**；
5. 灌一份模拟的 `todos` 投影，断言卡片改读投影（`4/7` 覆盖了任务自带的 `3/7`）。

**没做的验证**：没有把这个包装进 `C:\Users\<user>\.dsh` 的 profile 里跑真机
（该目录明确不许动、也不许重启正在跑的应用）。所以「装进真实 profile 后 AppFrame 里长什么样」
未验证；已验证的是「bundle 的 loader 契约 + 注册路径 + 组件首屏渲染」。

## 4. 文件清单

```text
packages/client-ui-router/
├─ package.json                 dsh.client（inject + platform:"web"）、exports["./client"]、peer 全是范围
├─ tsconfig.json / tsconfig.build.json
├─ src/
│  ├─ index.ts                  Node 半边：空实现（Client-only 插件也要有 Host 入口才能被 profile 激活）
│  ├─ shims/dsh-client.d.ts     rc.3 客户端类型的**内联子集**（见 §6 原因）
│  └─ client/
│     ├─ index.ts               浏览器入口：tab 类型 + body + title + 会话头按钮
│     ├─ contract.ts            ★ 数据契约（分区/worker/任务/需求），reported≠verified 写在类型里
│     ├─ source.ts              BoardSource 抽象 + Host Remote 实现 + 解析
│     ├─ mock.ts                内置示例数据（发布/验收是真的会改状态）
│     ├─ native-todos.ts        读原生 todos 投影（含 asTodos 形状校验）
│     ├─ controller.ts          快照状态机（并发读合并、错误不白屏）
│     ├─ lanes.ts               四条泳道定义 + 清单进度
│     ├─ RouterPanel.tsx        面板主体（容器查询：窄=tab 切换，宽=四列看板）
│     ├─ Roster.tsx             分区花名册（manager/worker/presence）
│     ├─ TaskCard.tsx           任务卡（状态、清单、当前步骤、产物、验收动作）
│     ├─ Composer.tsx           投递需求（一行一条，Cmd/Ctrl+Enter 提交）
│     ├─ RouterPanelTitle.tsx   tab 标题（带待验收数）
│     ├─ RouterPanelButton.tsx  会话头入口按钮
│     ├─ format.ts / locales.ts (zh+en) / styles.ts（CSS 文本 + installStyles）
├─ scripts/                     build-client / build-host / build-preview / serve-preview / verify-load
├─ preview/                     预览页（frame 是假的，面板是真组件）
└─ docs/
   ├─ CONTRACT.md               ★ 期望宿主提供什么
   ├─ NATIVE-ENTRYPOINTS.md     上传/下载/API key 的原生路径（不重复实现）
   └─ screenshots/
```

## 5. 为什么不用官方 UI 包

rc.3 的 `practices.md:35` 明文要求客户端插件**不要** `require` `@deepseek-ai/dsh-client-ui-primitives`
这类包（它们只是各包的 devDependency，不在运行版 asar 里，且随时会变）。
所以这里的控件、CSS、清单、复选框全是自己画的，只引用 `--dsw-alias-*` / `--dsw-radius-*` 主题 token，
密度（12/12.5/13px 字号、18/20px 行高、4/6/8/10px 间距）照抄宿主自己的管理页。

`src/shims/dsh-client.d.ts` 是**类型层面**的内联子集（`import type` 会被擦除，运行时不产生 require），
声明内容抄自 rc.3 asar 里的真实源码，每块都标了出处。等这个包进了 monorepo，
删掉这个 shim、改成对 `packages/client/ui-slots` 等项目的 project reference 即可，其余代码不用动。

## 6. 已知风险

1. **没进真机 profile**：见 §3。真机上唯一没被覆盖的变量是「AppFrame 里右侧栏的可用高度/宽度」
   与「会话头 utilities 的位置」。两者都不影响注册本身。
2. **`useTabInfo` 的 prop 名未核定**：本插件没有用 `hooks.tabInfo`（面板不依赖 tab 自身的元信息），
   所以这个坑没踩；若以后要用，先打印 `props` 的 key 再写死。
3. **`todos` 投影只覆盖当前 turn**：历史清单必须宿主从日志的 `todo/write` 事件补（CONTRACT.md §5）。
4. **`reported` 与 `verified` 的推进权在宿主**：UI 只提供「通过验收 / 退回」两个动作，
   如果宿主自己把自报直接当完成，面板列得再清楚也救不了数据。
5. **预览页的左侧聊天是静态占位**，不是真会话；它只用来证明面板在真实宽度下的观感。

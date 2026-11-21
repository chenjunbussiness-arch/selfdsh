# 集成说明：host-router × client-ui-router

本文是**接通两个包时做的全部决定**的单一记录：用哪条 seam、线上契约长什么样、
两边的状态怎么映射、改了哪些文件、以及哪些部分**没有**被验证。

版本基线：运行中的 DSH **0.2.2-rc.3**。下文每条「官方行为」都带
`包/文件:行号`，路径相对
`C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\`。

---

## 0. 一句话

UI 要的是 `ctx.remote.router`（Typert Remote），宿主**没有也不需要**提供它：
宿主把同一份事实注册成 **同源 HTTP 路由** `/api/router/*`，UI 的 `BoardSource`
改成 `fetch()`。两边核心语义（状态机、`reported ≠ verified`）一律不动，
只在桥接层做映射。

为什么是 HTTP 而不是 Remote：`ctx.webServer` 是受支持的 seam，Web 外壳本身就是它伺服的，
`fetch('/api/router/board')` 天然同源；而 Typert 的 `@Remote` 装饰器与注册方式在 rc.3 里
**尚未核定**（`docs/API-0.2.2-rc.3.md` 全文没有一条 Remote 注册的权威证据），
按它实现等于把整个功能压在一个猜测上。

---

## 1. 路由注册的确切方法名（含出处）

**方法名：`ctx.webServer.register(route)`**

| 事实 | 证据（行号） |
|---|---|
| `register(route: WebRoute \| WebResourceRoute): () => void`，返回撤消函数 | `dsh-host-webserver/src/index.ts:445` |
| `WebRoute` = `{ kind: 'exact' \| 'prefix'; path: string; handler(req, res) }`，**handler 拥有整个 node:http 响应生命周期**（可以挂住不结束，所以能写 SSE） | 同文件 `:52-58` |
| `WebResourceRoute` = `{ kind; path; resource(request: Request, peer?): Promise<Response> }` | 同文件 `:68-74` |
| resource 路由**只应答 GET/HEAD**，其它方法直接 405 + `Allow: GET, HEAD` | 同文件 `:291`（`RESOURCE_METHODS`）、`:675-680` |
| 因此 `publish`/`verify` 这类 POST **必须**用 `handler` 路由，不能用 resource | 由上两条推出 |
| 三个表：`exact` / `prefixes` / `upgrades`；重复 (kind, path) 抛错 | 同文件 `:378-380`、`:446-449` |
| 匹配顺序：exact 命中 → 最长 prefix → fallback | 同文件 `:654-664` |
| fallback 座位已被宿主的静态前端占用，**不能抢** | `registerFallback` `:477-483`；`dsh-host-frontend-static/src/index.ts:152` |
| `Config.host` 拒绝 `0.0.0.0`/`::`（未指定地址＝把 RCE 暴露到网络） | 同文件 `:359-366` |
| 实际 desktop 配置是 `host: 127.0.0.1`、`compression: gzip` | `dsh-web-app/cordis.patch.yml:183-192` |
| gzip 中间件**跳过** `text/event-stream`（SSE 不会被缓冲） | `dsh-host-webserver/src/index.ts:248` |

**挂载时机用 `ctx.inject(['webServer'], cb)`，不要用一次性 `ctx.get('webServer')`。**
证据：`dsh-client-connection/src/index.ts:141-165`

```ts
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register(route), 'label')
})
```

理由：`apply()` 跑的时候 webServer 可能还没 bind；`inject` 的回调在服务可用时执行、
服务被替换时重跑，并且注册随插件一起 dispose。本项目 `host-router/src/index.ts` 的
桥接挂载段就是照这个形状写的，且 `ctx.inject` 缺失时降级为「只挂工具、不挂路由」并打日志。

前缀不冲突：`dsh-client-connection` 占的是 `prefix /api`（其 `API_PATH`），
我们的 `/api/router/*` 是**更长的 exact 路由**，按 `:654-664` 的规则先命中我们自己。
副作用是这些请求不走 connection 的 `admit()`（浏览器鉴权/DNS rebinding 检查）。
补偿措施：POST 一律要求 `content-type` 本质值是 `application/json`（与
`dsh-host-open-in-app/src/index.ts:250-256` 同样的写法）。跨源页面对 JSON POST
必须先过 CORS preflight，而服务端不返回任何 CORS 头，所以外部页面打不进来；
同时 web server 只绑 loopback。

---

## 2. HTTP 接口（宿主 → UI）

前缀 `BRIDGE_BASE = '/api/router'`，常量在
`packages/host-router/src/bridge.ts`（`BRIDGE_BASE`）与
`packages/client-ui-router/src/client/source.ts`（同名）。两边同源、无鉴权头、无 CORS 头。

| 方法 | 路径 | 请求体 | 成功响应 | 说明 |
|---|---|---|---|---|
| GET | `/api/router/board` | — | `UiBoardSnapshot`（`version: 2`） | 读整块看板；同时把宿主自己的 `snapshot.json` 刷一遍 |
| POST | `/api/router/publish` | `{ demands: string[] }` | `{ accepted: number, routed: { text, partitionId?, reason? }[] }` | 允许部分成功：未路由的条目**没有** `partitionId`，`reason` 说明原因 |
| POST | `/api/router/verify` | `{ taskId, verdict: 'verified' \| 'rejected', note?: string }` | `{ ok: true, task: { id, state } }`（`state` 是**宿主**状态：`verified` / `failed`） | 只接受 `reported` 状态的行 |
| POST | `/api/router/partition` | `{ id, enabled: boolean }` | `{ ok: true, partition: { id, enabled } }` | 即 `HostActions.setPartitionEnabled` |
| GET | `/api/router/events` | — | `text/event-stream` | 首帧 `event: hello`，之后每次 board 写入一帧 `event: changed`，20s 一次 `: ping` |

错误一律是 `{ "error": { "code": string, "message": string } }`：

| 状态码 | code | 触发条件 |
|---|---|---|
| 400 | `bad-request` | body 不是对象 / 字段类型不对 / 空 body / 非法 JSON |
| 404 | `not-found` | 未知 `taskId` 或未知分区（消息里列出已配置分区） |
| 405 | `method-not-allowed` | 方法不对（带 `Allow` 头） |
| 409 | `conflict` | 该任务不是 `reported`（例如还在 `dispatched`，或已 `verified`） |
| 413 | `body-too-large` | body > 256 KiB |
| 415 | `unsupported-media-type` | `content-type` 本质值不是 `application/json` |

约束：单次 `publish` 最多 64 条需求；空行会被丢掉；全部为空则 400。

SSE 的“变更信号”是 `<boardDir>/board.json` 的 mtime（`TaskBoard.flush` 每次写入都会动它），
所以任何路径引发的变更（工具调用、worker 结算、桥接自己的写）都只会产生**一帧**事件。
事件里**不带**看板数据——UI 自己去读 `/api/router/board`，这样信号和文档不会互相矛盾。
UI 侧 `subscribe()` 用 `EventSource`；收到 `hello` 之前、以及 `onerror` 之后退化为 5s 轮询，
所以 SSE 不可用也不会让面板停止更新。

---

## 3. 状态映射表

宿主持久状态（`board.ts:27-43`）→ 面板五态（`contract.ts` 的 `TaskState`）→ 右侧栏 tab。

| 宿主状态 | 含义 | 面板 `state` | 面板 tab（`bucket`） | 说明 |
|---|---|---|---|---|
| `queued` | 已接受，等 worker 槽位 | `queued` | `up-next` | |
| `dispatched` | 子会话已建，日志里还没 turn | `running` | `active` | 面板没有「已派发」这个词；有 worker 占着它，说 running 才是实话 |
| `running` | worker 日志显示已开 turn | `running` | `active` | |
| `reported` | worker **自报**完成，未验收 | `reported` | `active` | **不合并**。待验收也是「在办」，不是「已结」 |
| `verified` | 验收命令通过 / 人工通过 | `verified` | `resolved` | 唯一表示「完成」的状态 |
| `failed` | worker 出错，或验收不通过 | `rejected` | `resolved` | 退回原因进 `rejectionReason` |
| `blocked` | 挂起等人工决定 | `queued` | `up-next` | 没有在跑、也没结束，是要人处理的下一条 |
| `cancelled` | 被取消 | `rejected` | `resolved` | 终态；`hostState` 仍然写着 `cancelled` |

规则：

1. **`bucket` 是 `state` 的函数**（`BUCKET_OF_STATE`，`bridge.ts`），不是宿主状态的函数，
   所以泳道/tab 与卡片永远一致：
   `queued → up-next`；`running / reported → active`；`verified / rejected → resolved`。
2. **原始宿主状态永不丢**：每行都带 `hostState`，视图想区分 `blocked`/`cancelled` 直接读它。
3. `scheduled` 目前**没有生产者**：路由器的派发是「有槽位就跑」，没有定时器，
   所以不存在「未到期」的行。类型与 tab 保留，字段 `scheduledFor` 由宿主留空。

反向（面板动作 → 宿主）：

| 面板先验 | 写入 | 结果 |
|---|---|---|
| `verify(taskId, 'verified')` | `state: 'verified'`，`notes += "verified from the router panel at <t>"` | 通过 |
| `verify(taskId, 'rejected', note)` | `state: 'failed'`，`error = "rejected by operator: <note>"`，`notes += ...` | 退回即结算；**不会自动重派**（“退回”和“再跑一次”是两个决定，后者要再花一个 worker 会话） |
| 两者作用于非 `reported` 行 | — | 409，不猜 |

`reported ≠ verified` 在两侧都活着：宿主只有**独立的裁决动作**能产生 `verified`；
桥接层只做名字翻译，任何路径都不会把 `reported` 写成 `verified`。

### worker presence 映射

| 宿主事实 | 面板 `presence` | 依据 |
|---|---|---|
| 行处于 `dispatched`/`running` | `busy` | 该行正占着槽位 |
| 行处于 `reported` | `released` | 自报后**已经不占槽位**（`holdsSlot` 只认 dispatched/running），画成 busy 会骗人 |
| 分区剩余槽位 | `online` | 空闲、可派发 |
| — | `offline` | **永不发出**：路由器没有可达性探测，无证据就不下这个结论 |

worker 的 `id` 是 `w:<taskId>`（确定性，可直接做 React key），
只有仍在 roster 上的任务（`dispatched`/`running`/`reported`）才带 `workerId`；
`workerSessionId` 只要有 session 就带，供面板「打开会话 / 读 todos 投影」。
`elapsedSeconds` 是从该行 `createdAt` 起的秒数（board 只存一个时间戳，这是近似值）。

---

## 4. 字段映射

宿主 `snapshot.ts` 的 `TaskView` → 线上 `UiTaskView`（`bridge.ts`）：

| 线上字段 | 来源 | 备注 |
|---|---|---|
| `id` / `title` / `partitionId` | `id` / `subject` / `partition` | |
| `state` / `hostState` / `bucket` | 见 §3 | |
| `todos` | `todos.todos ?? []` | 直接对齐原生 `todo/write` 的 item |
| `todoProgress` | `{ done, total, ratio, current }` | 折叠自 worker 自己的 session 日志 |
| `progress` | 状态机粗进度（`running` 时用 todo 比例细化） | |
| `requestedAt` / `updatedAt` | `createdAt` / `updatedAt` | |
| `reportedAt` / `verifiedAt` | `updatedAt`（当状态为 reported / verified） | board 每行只有一个时间戳，这是唯一诚实的取法 |
| `attempt` | `max(1, attempts)` | 宿主从 0 计，面板从 1 计 |
| `rejectionReason` | `error`（仅当面板状态是 `rejected`） | |
| `result` / `verifyOutput` / `error` | 同名 | 直接透出，便于详情页 |
| `level` / `priority` | 同名 | |
| `workerId` / `workerSessionId` | 见 §3 | |

分区（`UiPartitionView`；`repo`/`path` 是同一个绝对根的两个名字，因为
`CONTRACT.md` 与集成需求用了两个不同的名字）：

| 线上字段 | 来源 |
|---|---|
| `id` / `name` | 分区名 |
| `repo` / `path` | `Partition.dir` |
| `enabled` | board 里该分区的持久记录 `disabled !== true` |
| `workerCount` | `Partition.slots`（配置并发） |
| `liveWorkers` / `queuedCount` / `unreviewedCount` / `taskCount` | 该分区的任务统计；`unreviewedCount` 就是左侧栏的「待审查」徽标 |
| `manager` | `{ id: 'mgr:<名称>', name: managerEnabled ? 'manager' : 'router', presence, dispatched, awaitingVerification }` |
| `workers` | 见 §3 的 roster 推导 |

**`demands`**：宿主的 `route_task`/`publish` 在**入队时**就决定分区（分区不明会直接报错），
所以不存在「等待路由的需求」。桥接层因此按 **1 个 root task = 1 条 demand** 派生
（`parentId === undefined` 才算；manager 拆出来的子任务是 pieces，不是 demand），
`routingReason` 用 `reason: because...` 拼出可审计的理由，`taskIds` 是精确的一条。
未路由的需求出现在 `POST publish` 的响应里，不在快照里。

**`credentials`**：只报「有没有」，永不报值。宿主调
`ctx.credentials.describe(ref)`（`dsh-credentials/src/index.ts:186-192`），
拿 `{ configured, source, writable }`；provider 的层级名（`env`/`file`/`project-env`/`user-env`）
被归一化成面板的四个值（`file` / `env` / `unset` / `unknown`，见 `credentialSourceOf`）。
默认 ref 表是 `DEEPSEEK_API_KEY`（`dsh-llm-deepseek-api-key/src/config.ts:25`）
与 `EXA_API_KEY`（`dsh-web-search-exa/lib/index.js:146`），可通过
`RouterConfig.credentialRefs` 改。provider 缺失或抛错时状态是 `configured:false` + `source:'unknown'`
——「问不到」不等于「没配」。

---

## 5. 改了哪些文件（逐条）

### `packages/host-router/`（宿主侧，允许全改）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/types.ts` | **新增** `WebRouteLike` / `WebServerLike` / `CredentialsServiceLike` / `InjectedPluginContext`；`PluginContext` 增加可选 `inject?()` | 结构式声明 webServer seam，保持「运行时零 `@deepseek-ai` import」这个优点 |
| `src/config.ts` | **新增** `CredentialRefConfig`、`DEFAULT_CREDENTIAL_REFS`、`RouterConfig.credentialRefs?` | 让「key 是否已配置」的 ref 表可配置而不是写死 |
| `src/board.ts` | `PartitionRecord` 新增可选 `disabled?` | 分区的启用/停用要持久（重启后仍然有效），board 是唯一持久层 |
| `src/snapshot.ts` | `TaskView` 新增 `reason` / `because` | demand 的 `routingReason` 需要路由证据，而它原本只在 board 行上 |
| `src/bridge.ts` | **新文件** | 状态/字段映射、5 条路由、SSE、错误码，全部集中在一处；`boardDocument()` 是纯函数，便于断言 |
| `src/index.ts` | ① 新增 `isEnabled()`；② `pump` 跳过停用分区；③ `route_task` 拒绝停用分区；④ `partition_list` 标出 `[DISABLED]`；⑤ 新增 `publishDemands` / `decideFromPanel` / `setPartitionState` / `credentialStatus`；⑥ 用 `ctx.inject(['webServer'], …)` 注册 `createRoutes(...)` | 把面板的三个写动作与路由挂载接上；停用分区必须同时拦住「模型工具」和「HTTP」，否则两条入口行为不一致 |
| `cordis.patch.yml` | `boardDir: null` 改为省略 | **修 bug**：`boardDir === undefined ? 默认 : resolve(boardDir)`，`null` 会走到 `resolve(null)` 并在激活时抛错 |
| `tests/bridge.test.mjs` | **新文件**，16 条 | 覆盖映射表、5 条路由、错误码、SSE 首帧与变更帧、停用分区、`reported ≠ verified` |

### `packages/client-ui-router/`（只动数据层与契约）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/client/source.ts` | 新增 `createHttpSource` / `createHttpActions` / `BRIDGE_BASE`；`resolveSource(undefined)` 改为「HTTP + 示例数据兜底」；`createHostSource` / `asBoardSnapshot` / `BoardSource` **原样保留** | 数据访问只改这一处（作者原本的抽象边界）；Remote 路径保留，等宿主哪天真的提供 Remote 也不用改回来 |
| `src/client/contract.ts` | **仅新增可选字段**：`TaskBucket`、`HostTaskState`、`TaskView.bucket?/hostState?/todoProgress?`、`PartitionView.path?/workerCount?/unreviewedCount?` | 视图重构需要「tab 归属」「待审查数量」「任务详情进度」；全部可选 ⇒ 向后兼容，缺了也不会崩 |
| `lib/client.js` | 重新构建 | 产物必须重编，否则浏览器里跑的还是旧数据层 |

**没有动**：`RouterPanel.tsx` / `Roster.tsx` / `TaskCard.tsx` / `Composer.tsx` /
`RouterPanelTitle.tsx` / `RouterPanelButton.tsx` / `styles.ts` / `controller.ts` /
`lanes.ts` / `locales.ts` / `format.ts` / `mock.ts` / `native-todos.ts` / `preview/*`。

### 根目录（bundle 本体）

| 文件 | 作用 |
|---|---|
| `package.json` | bundle manifest：`dsh.bundle.patch` + 两个 `file:` 依赖；**不写 `peerDependencies`** |
| `cordis.patch.yml` | 两条 row：`dsh-host-router`（含分区配置）、`dsh-client-ui-router` |
| `index.js` | bundle 自己的 host 半（空 `apply`），满足 `.` 导出与「能被当作普通插件挂载」 |
| `icon.svg` / `locale/{zh,en}.json` / `docs/DETAIL*.md` | 插件管理器/设置页展示所需的图标、标题、描述、详情页 |
| `docs/INTEGRATION.md` | 本文 |

---

## 5.5 给 UI 侧接线（`src/client/index.ts`，不属于本次改动范围）

`source.ts` 已经把面板要的一切都导出了，接线只需两行：

```ts
import { createHttpActions, resolveSource, type BoardSource } from './source.ts'

const source: BoardSource = resolveSource(hostSource)   // hostSource 为 undefined 时自动走 HTTP
const actions = createHttpActions()                     // 目前只实现 setPartitionEnabled
// 传给面板：{ ...actions } 即可作为 HostActions.setPartitionEnabled
```

`createHttpActions()` 刻意只返回已实现的动作：`HostActions` 里没被实现的可选成员缺席，
视图按作者的设计渲染成「未接线」，而不是假装成功。凭据的**读**不需要单独的动作
——`GET board` 的 `credentials` 数组已经是只读状态位；凭据的**写**属于凭据域
（官方通道是 `ctx.remote.credentials.set/unset`），本次没有实现。

---

## 6. 编译与验证结果

| 项目 | 命令 | 结果 |
|---|---|---|
| 宿主编译 | `node node_modules\typescript\bin\tsc -b E:\PythonProject\dsh-router-b\packages\host-router`（在 `E:\PythonProject\deepseek-harness-latest`） | **exit 0** |
| 宿主单测 | `node --test tests/router.test.mjs` | **12/12 通过** |
| 桥接单测 | `node --test tests/bridge.test.mjs` | **16/16 通过** |
| UI 编译 | `node node_modules\typescript\bin\tsc -b E:\PythonProject\dsh-router-b\packages\client-ui-router` | **exit 0** |
| UI 产物 | `node scripts/build-client.mjs` | `lib/client.js` 重新生成 |
| UI 加载断言 | `node scripts/verify-load.mjs` | **35 条全过** |

> `node --test tests/`（带目录）在 Windows / Node 24 上会报 `Cannot find module ...\tests`，
> 必须给到文件或通配（`node --test tests/*.test.mjs`）。

---

## 7. bundle 安装命令（**只写，不执行**）

推荐路径（插件管理器，会同时写 `dependencies` 与 `dsh.profile.bundles`）：

```text
plugin_manager  action: "install_bundle"  target: "E:\\PythonProject\\dsh-router-b"
```

等价的 CLI 路径（`dsh plugin` 是把参数转发给 profile 目录里的 pnpm）：

```powershell
dsh plugin --profile desktop add file:E:\PythonProject\dsh-router-b
```

若走 CLI，插件选择还需一步（裸 pnpm add 只写依赖，不写 bundle 列表）：
把 `"dsh-router-b"` 加进
`C:\Users\<你>\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles`，然后

```powershell
dsh plugin --profile desktop install
```

如需从 registry 拉依赖，追加：

```powershell
--registry=https://registry.npmmirror.com
```

**只装这一个 bundle**：`dsh-host-router` / `dsh-client-ui-router` 是它的依赖，
不要另外单独把它们装成 bundle —— 它们有自己的 `cordis.patch.yml`，
单独装会产生同 id 的重复行。

平台前提：本 profile 用 pnpm 的 `hoisted` linker
（`~/.dsh/profiles/desktop/node_modules/.modules.yaml: nodeLinker: hoisted`），
所以 bundle 的传递依赖会平铺到 profile 的 `node_modules/` 根，
两条 row 的包名才能从 profile 解析到。如果换成 `isolated` linker，
需要把两个包也写进 profile 的 `dependencies`（或改用 `link:` 直接指向包目录）。

---

## 8. 未验证 / 已知限制（如实）

**未验证**（本任务禁止安装、禁止重启、禁止碰 `~/.dsh/`，因此下列部分只有静态与单元级证据）：

1. **真实进程里路由是否成功挂载**：`ctx.inject(['webServer'], …)` 的运行时行为来自
   rc.3 源码与 `dsh-client-connection` 的同款写法，但**没有在真实 profile 里跑过**。
   首次安装后应检查日志里是否出现
   `host-router: HTTP bridge mounted at /api/router (...)`。
2. **浏览器里同源 `fetch` 的实际结果**：没有在 GUI 页面里执行过
   `fetch('/api/router/board')`。SSE 通路同理（单测里用假 req/res 驱动，真 socket 未跑）。
3. **两个 `file:` 依赖在真实 pnpm 安装下的解析**：按 `hoisted` linker 推断，
   未实际安装验证。
4. **`credentials.describe` 在真实 provider 下的返回值**：
   单测用假的 `describe()`；真实 `dsh-credentials-local` 的 `source` 取值只按枚举推断归一化。
5. **bundle 的 `dsh.bundle.patch` 层与 profile 现有层的合成结果**：未跑
   `--dump-config` 验证（那是读 profile 的操作，也在本任务边界外）。

**已知限制**（不是 bug，是当前设计边界）：

1. **`publish` 不一定立刻派发**：HTTP 没有 agent 身份，`dispatch` 需要一个 live parent。
   面板发布的需求会先入队（`queued`，即 `up-next`），
   当有一个可达的 agent（最近用过 router 工具的 agent）时才被 pump 起来；
   否则等下一次 router 工具调用或面板刷新再驱动。这是真实状态，不是失败。
2. **退回不自动重派**：`rejected` 落在宿主 `failed`，任务结算；要再试必须显式 retry
   （`task_control retry` 或重新发布需求）。面板目前没有 retry 按钮（属于 UI 范围）。
3. **`Scheduled` tab 恒空**：宿主没有调度器，`scheduledFor` 永不出现。
4. **没有 `offline` worker**：无可达性探测，不猜。
5. **`demands` 是派生流水**，不是真正的需求队列；未路由的需求只在 `publish` 响应里。
6. **人工验收不重跑验收命令**：人按「通过」就是裁决，不额外跑 `verify` 命令
   （那会在 HTTP 请求里阻塞数分钟）。要证据就先用工具的 `task_control verify`。
7. **`lib/client.js` 是构建产物**：改了 `src/client/*` 必须重跑
   `scripts/build-client.mjs`，否则浏览器里是旧代码。

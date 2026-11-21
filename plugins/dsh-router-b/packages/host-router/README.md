# dsh-host-router

宿主侧路由器：**声明式文件分区 → 每分区一个 manager → N 个 continuable worker session**，外加一张磁盘任务板和一份给 UI 的进度文档。

主界面发任务 → 路由到分区 → manager 决定「续用已有 worker」还是「新开一个」→ worker 干活并往自己的 session 写 todo → 看板/进度面板显示到「干到哪一步」。**`reported`（worker 自报完成）和 `verified`（验收通过）始终分开。**

---

## 1. 装法

本包是标准 bundle：`package.json` 里有 `dsh.bundle.patch`，patch 在 `cordis.patch.yml`。

```powershell
# 在 DSH 里（agent 侧）
plugin_manager action=install_bundle target=E:\PythonProject\dsh-router-b\packages\host-router
```

或由 profile patch 引用（**不要手改别人的 profile**；这里只是说明挂载形态）：

```yaml
- insert:
    - id: host-router
      name: dsh-host-router
      config:
        partitions: [...]      # 见第 2 节
```

安装后**新开一个会话**生效。工具出现在 `host-router` 这一行下：`route_task` / `partition_list` / `task_board` / `task_progress` / `task_control` / `task_resume`。

> 装载失败时先看插件行是否被 disabled。`dsh-app-boot` 在启动期会把 `@deepseek-ai/dsh-*` 的 **精确版本 peerDependencies** 当硬锁校验，不匹配就整行 disabled，而且错误会伪装成「某个 provider 没注册」。本包**故意不声明任何 peerDependencies**（运行时零 `@deepseek-ai/*` import），所以不受这条规则影响。**将来若要加 peer，一律用范围**（`>=0.2.0-rc.2`），不要用精确版本或 `~`。

---

## 2. 分区配置

分区 = 名字 + 一组成员文件 + 该分区的运行参数。`root` 必须是绝对路径：它同时是 worker 的工作目录。

```yaml
config:
  boardDir: null            # 默认 <DSH_HOME>/router
  manager: true             # 分区默认是否带 manager（可被分区覆盖）
  maxWorkers: 8             # 全局并发 worker 上限
  autoVerify: true          # 是否跑验收命令
  maxRetries: 1             # 预留（当前不自动重试，见第 6 节）
  verifyTimeoutMs: 600000   # 单条验收命令超时
  provider: spawn           # continuable 的 in-process 后端
  maxDepth: 2               # 传给 subagent seam 的递归上限
  defaultPartition: null    # 文本/文件都判不出时落到哪个分区；不配则报错
  partitions:
    - name: state
      root: E:/PythonProject/rca-ab-test/rca-state
      include: ['**/*.go', 'go.mod']     # 相对 root 的 glob，默认 ['**']
      exclude: ['vendor/**']
      keywords: [go, kratos, mcp]        # 供文本路由打分
      workers: 2                          # 该分区并发 worker 数
      manager: true                       # 覆盖默认
      preset: null                        # 给 manager/worker 用的 agent preset
      verify: ['go build ./...']          # 验收命令，在 root 下执行
      brief: |                            # 每个 worker 都会收到的一段常驻说明
        RFC 改动前先看 docs/contracts。
```

**成员判定**：`root` 之下 + 命中 `include` + 未命中 `exclude`。分区可以嵌套，嵌套时**最深（最长 root）的分区胜出**，不会两个分区同时认领一个文件。

**路由顺序**（`resolveRoute`）：

1. `partition` 明确给出 → `explicit`
2. `files` 给出 → 每个文件都必须属于同一分区 → `files`
3. 文本打分（分区名命中 +4，关键字命中 +2，文本里出现分区内绝对路径 +6）→ 最高分胜出 → `auto`
4. 都判不出 → `defaultPartition`（`default`）。
5. **歧义直接报错**，不猜：两个分区同分时返回候选列表要求点名。错路由的代价是一整个 worker session 干在错误的仓库里。

---

## 3. 两层 routing 具体长什么样

```
你的会话（第 1 层：分配）
  └── route_task(text) ── 按配置解析分区 ──┐
                                          │
  分区 manager child（第 2 层：指挥）← 该分区 manager: true 时才有
    ├── route_task(text, partition, parent_task=自己的 id) → 新 worker
    └── task_resume(已有 task)                            → 同一个 worker
                                          ▼
  worker child，cwd = 分区根，结算即释放
```

- **第 1 层**是和人对话的那个 agent。它只调 `route_task`，一次一件事，立刻返回。
- **第 2 层**是插件为分区起的 manager child（`level: 'manager'` 的任务行）。它的 prompt 明确要求：拆分 → 每片调 `route_task`（带 `parent_task`）或 `task_resume` → **不要自己动手** → 最后只报「派发计划」。
- `route_task` **带 `parent_task` 就说明调用方是 manager**（这是第 2 层的判据）：此时永远直接起 worker，不会再套一层 manager，天然防递归。
- 分区 `manager: false` 时不设第 2 层：`route_task` 直接起 worker（确定性下限，保证任何配置下都能推进）。

**并发（N 个 worker）**：每个分区 `workers` 个槽，全局 `maxWorkers` 兜底。满了不是拒绝，而是任务停在 `queued`；worker 结算或下一次读看板时由 pump 拉起。manager 单独占一个「每分区最多 1 个在飞」的槽，不占 worker 槽。

### 续用 vs 新开：策略写死在这里

| 场景 | 决定 | 理由 |
|---|---|---|
| 第 1 层 `route_task` | **永远新开** worker | 人类的需求之间没有隐含联系，复用会带进上一个任务的上下文污染，也会让「一个 worker 一个自洽任务」这个对应关系消失 |
| 第 2 层 manager | **优先续用，否则新开** | prompt 里明确规定：同分区已有 `reported` 的 worker 且新任务碰同一批文件/子系统 → `task_resume`（省掉重新摸仓库的成本，worker 保留自己的 todo 与历史）；新任务独立、或旧报告已经关掉那个话题 → `route_task` 新开 |
| `task_resume` 目标必须**不是** `running`/`dispatched` | 由调用方（manager 或人）保证 | 不给忙着的 session 塞消息 |
| 分区槽满 | 停在 `queued` | 不拒绝，不丢任务 |
| worker 结算后 | **runtime 立即释放**（in-process child 被 dispose） | 「常驻 ≠ 等待」：不占进程也不占模型配额；下次续用靠 session 日志冷恢复 |

`task_resume` 走 `ctx.subagents.sendMessage(sender, childId, content, {signal})`：目标已结算时由 seam 从持久化日志恢复（同一 subagent 树内），worker 保留自己的历史与工作目录。

---

## 4. 状态机

`queued → dispatched → running → reported → verified`，异常分叉 `failed` / `blocked` / `cancelled`。

- `dispatched`：child session 已建、日志里还没有 `turn/start`。
- `running`：日志里出现了 `turn/start`（**由日志证明**，不是猜的）。
- `reported`：worker 自己停了且 `stopReason === 'completed'`，但它说的只是**声明**。
- `verified`：该分区的 `verify` 命令全部退出 0。**只有这个状态算完成。**
- 分区没配 `verify`（或 `autoVerify: false`）时，任务**最多只能到 `reported`**，看板会明说。

**重启对账**：每次派发都会给任务行盖上本进程的 `runToken`。重启后读到 `running`/`dispatched` 且 token 不是自己的行 → 降级为 `reported` 并附错误说明（它的 worker 已经没了，永远不会再有结算通知）。**同 token 的行不动**，所以「另开一个读者」不会误伤在飞任务。

---

## 5. 给 UI 的数据

完整接口签名见 **[docs/HOST-CONTRACT.md](docs/HOST-CONTRACT.md)**。要点：

- 一份文档：`<boardDir>/snapshot.json`（默认 `<DSH_HOME>/router/snapshot.json`），包含全部任务 + 每个任务的 **`sessionId`** + 该 worker 的 **todo 列表与完成比** + 粗粒度 `progress` + `counts`。
- 为什么 todo 来自日志：`dsh-tool-todo` 的 `todos` 投影在每次 `turn/start` 会被清成 `null`，历史清单只能从 `todo/write` 事件折叠。宿主用 `ctx.sessionQuery.readSession(sessionId)` 读**原始事件**折叠，所以 worker 被释放后仍然可读。
- 任务记录字段（关键几个）：`id / partition / parentId / level / state / priority / attempts / cwd / subject / body / sessionId / worker / result / verify + verifyOutput / error / reason + because / runToken / createdAt / updatedAt`。**`sessionId` 一定存**，这是「打开这个 worker 的 session」和「续作」的唯一句柄。
- 可选：`ctx.hostRouter.{snapshot, task, snapshotPath}`（`ctx.set` 存在时发布，feature-detect）。UI 依赖它就必须回落到文件。

---

## 6. 已验证 / 未验证

**已验证（本机真跑）**

- `tsc -b` 对 `dsh-router-b/packages/host-router` **退出码 0**（用 `E:\PythonProject\deepseek-harness-latest` 的 TypeScript 6 编的）。
- `node --test tests/router.test.mjs` **12/12 通过**，跑的是编译产物 `lib/*.js`，配一个 fake `ctx`（fake tools / agents / subagents / sessionQuery），覆盖：
  - glob 与嵌套分区、显式/文件/文本路由、歧义报错
  - 派发参数断言：**`spec.cwd` 就是分区根**、`delivery: 'parent'`、prompt 里带分区 brief
  - 结算：`completed` → `reported`；验收 0 → `verified`；验收非 0 → `failed`（worker 的「我干完了」不能救回验收失败）
  - 容量：`workers: 1` 时第二个任务 `queued`，读看板后 pump 拉起
  - 两层：manager 行 + `parent_task` 派 worker + prompt 分别正确
  - 进度：日志 `turn/start` 把 `dispatched` 提升为 `running`、`todo/write` 折叠出 `1/2`、写出的 `snapshot.json` 字段正确
  - 控制：`cancel` 真的 interrupt；`task_resume` 走 `sendMessage` 且不新开 child
- 这条测试还抓到一个真 bug：Windows 上 `rename` 覆盖正被读的文件会 `EPERM`，看板写入已改成带退避重试的原子替换（`replaceFile`）。

**未验证（必须说清楚）**

- **没有在真实 DSH 进程里挂载过**。本机 profile 不允许我改（另一人在修），`plugin_manager` 也需要审批。所以「工具真的出现在会话里」「worker 真的按 `cwd` 落到分区」是**据源码推出来的，不是跑出来的**。
- 验收命令在 Windows 上走 `shell: true`（cmd.exe）；只测过 `node -e "..."`，没测过 `go build` / `npm run build` 这类长命令。
- manager 的「续用判断」是**模型判断**，不是算法。测试只证明了工具合同（resume 走同一 session），没有证明模型会在该续用的时候续用。
- `ctx.set` 是否存在没验证过；`ctx.hostRouter` 是 feature-detect，未实跑。
- **rc 漂移**：运行版是 `0.2.2-rc.3` / cordis `4.1.0`，工作区 checkout 是 `0.2.2-rc.5`。本包运行时只碰服务对象，类型是自己声明的结构接口，所以不绑任何一版的 .d.ts；但跨 rc 的真实行为差异没有回归测试。

---

## 7. 已知限制（请当设计约束读）

1. **沙箱写边界按 `session.header.cwd` 判定（rc.3）**。子会话的 header.cwd 继承自创建者，不是分区根。所以 `workspace-write` 模式下 worker 往分区根写**可能被 `FS_SANDBOX_DENIED`**。本机是 `danger-full-access` 所以现在能写，但**不能把这当设计前提**。三条路：
   - 部署侧 `sandbox-policy.additionalWritableRoots` 加上所有分区根（**最可靠**）；
   - 本插件已在每次派发后尽力调 `ctx.sandboxPolicy.registerWritableRoot(child.session, partition.root)`（`try/catch`，失败只 warn）。它**只在本进程有效、resume 后要重新注册、Windows 上只对文件工具生效**，且注册发生在 child 建好之后，存在一个极小的窗口期；
   - 或让 worker 显式提权。
2. **没有自动重试**。`maxRetries` 目前只解析不使用：失败行等人或 agent 调 `task_control action=retry`。理由是一次失败的根因通常需要判断，盲重试只会重复烧 token。
3. **`task_resume` 之后的行不会自动闭合**。续作的 session 是本进程外恢复的，插件手里没有对应的 activation handle。该行停在 `running`，由 `task_progress` / `task_board` 从日志折叠纠正（有 `turn/end` 且 child 不 live → `reported`/`failed`），或由 `task_control verify` 收尾。
4. **manager 是每任务一个 child**，不是一个长期驻留的分区管家。长期驻留会和「结算即释放」冲突，也会让「一个 manager 同时收多个任务的报告」这类状态难以对账。分区记录里保留了 `managerSessionId`（最近一个），仅供展示/追溯。
5. **分区之外的写**没有任何拦截机制：约束靠 prompt + 沙箱，不靠插件。
6. **不自动清 todo 历史**：`todos` 是当前轮清单，历史要自己从日志折叠。
7. `include`/`exclude` 只支持 `**` `*` `?`，不支持 brace/negation。
8. **没有复用 `ctx.agentTeams`**（评估过，见下）。

### 为什么没有复用官方 `ctx.agentTeams`

`@deepseek-ai/dsh-agent-team` 确实由 base 挂载（`maxTasks: 256`），任务模型和持久化都更成熟（`team/task` v2 事件、`agentTeam` 投影、`revision` 连续、`blockedBy`、`writeScopes`）。没有直接复用的原因：

- 它的任务行活在 **Lead 会话的日志**里。本插件要的是「用户可能新开 session，任务仍在」，而那需要跨 Lead 的持久层。
- 它不建模本任务的核心三件东西：**worker `sessionId`**、**验收证据**（`verify` + 输出）、**分区归属**。补齐等于在它之上再挂一层记录。
- 面板要的是「一次取走」，它的读法是一个 Lead 一个投影读。

值得抄的两点已经在设计里用了：`revision` 的位置被 `updatedAt` + 原子替换替代；`blockedBy` 的位置留了 `parentId` + `task_control block`。如果将来要接它，`TaskBoard` 是唯一需要换的接缝。

---

## 8. 代码结构

```
packages/host-router/
├── src/index.ts       # 插件主体：6 个工具、pump、派发、结算、服务发布
├── src/config.ts      # 分区声明、glob、路由决策、worker brief（纯函数）
├── src/board.ts       # 磁盘任务板：状态机、原子写 + 重试、runToken 对账
├── src/dispatch.ts    # startActivation / sendMessage / interrupt / 验收命令
├── src/snapshot.ts    # todo 与 turn 折叠、进度、给 UI 的一份文档
├── src/types.ts       # 运行版 rc.3 的服务结构契约（逐条注释来源）
├── tests/router.test.mjs
├── docs/HOST-CONTRACT.md
└── cordis.patch.yml
```

**为什么没有 peerDependencies**：本包运行时**不 import 任何 `@deepseek-ai/*` 模块**（`src/types.ts` 是手写结构接口，`defineTool` 也没用，工具定义直接写 JSON Schema）。好处有两个：不会被启动期 peer 校验 disabled；跨 rc 升级不用改依赖范围。代价是 dsh 侧 API 漂移只能在运行时暴露，靠 README 第 6 节的「未验证」清单和结构测试兜住。

## 9. 构建与验证命令

`tsconfig.json` 继承 `E:\PythonProject\deepseek-harness-latest\tsconfig.base.json`，只为拿到 TypeScript 选项和 `@types/node`；本包源码不 import 该 checkout 的任何包，所以编译产物与 checkout 版本无关。

```powershell
# 编译（--force 忽略增量信息）
cd E:\PythonProject\deepseek-harness-latest
node node_modules\typescript\bin\tsc -b E:\PythonProject\dsh-router-b\packages\host-router --force
# 期望：无输出，退出码 0；产物在 packages/host-router/lib/*.js

# 加载检查
cd E:\PythonProject\dsh-router-b\packages\host-router
node -e "import('./lib/index.js').then(m => console.log(m.name, m.inject))"

# 行为测试（跑的是 lib/，不是 src/）
node --test tests/router.test.mjs
```

改 `src/` 后必须重新编译再跑测试，否则测的是旧产物。

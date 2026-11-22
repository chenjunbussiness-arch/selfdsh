# 交接：分区路由插件（dsh-router-b）

这份文档是给「下一次打开这个项目的人（或 agent）」看的。当前会话的上下文会在应用重启后丢失，所以关键信息落在这里。

---

## 一、这是什么

一个 DeepSeek Harness bundle，实现「**文件分区 + 两层 routing + N worker + 右侧任务面板**」。

```
用户在一个窗口发需求
  → 主路由判定落到哪个分区
    → 分区 manager 决定「续用已有 worker」还是「新开 worker」
      → worker 干活，并通过 todo_write 写自己的工作清单
        → 右侧面板显示每个任务的清单和「正在做哪一步」
          → worker 自报完成(reported) ≠ 验收通过(verified)
```

## 二、代码在哪

```
E:\PythonProject\dsh-router-b\
├── package.json           bundle 清单（无 peerDependencies，故意的）
├── cordis.patch.yml       挂载点 + 三个分区示例
├── index.js               空 host 半边
├── icon.svg / locale/     插件管理器展示用
├── docs\
│   ├── API-0.2.2-rc.3.md  ★ 1241 行 API 事实核定，每条带「包/文件:行号」
│   ├── INTEGRATION.md     契约 + 状态映射表 + 限制清单
│   ├── HANDOFF.md         本文件
│   └── DETAIL.md / DETAIL.zh.md
└── packages\
    ├── host-router\       宿主侧：分区/看板/派发/结算/HTTP 桥
    └── client-ui-router\  Web 端：右侧栏面板
```

## 三、怎么装

### 已装（2026-11-18 23:2x）

根 bundle 已经用插件管理器装进 profile 了：

```powershell
plugin_manager  action: "install_bundle"  target: "E:\PythonProject\dsh-router-b"
```

**但装完之后 patch 两行报 `Cannot find package 'dsh-host-router'`。** 原因是插件管理器用的是 `link:`，把 `dsh-router-b` 整个目录**符号链接**过来，于是它自己 `dependencies` 里那两条 `file:` 子依赖**从未被安装进 profile 的 node_modules**。

**已修**（手工补的，重装时可能会再次需要）：

```powershell
$d = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$d\node_modules\dsh-host-router"      -Target "E:\PythonProject\dsh-router-b\packages\host-router"
New-Item -ItemType Junction -Path "$d\node_modules\dsh-client-ui-router"  -Target "E:\PythonProject\dsh-router-b\packages\client-ui-router"
```

同时把这两条写进 profile `package.json` 的 `dependencies`（用 `link:`，防止 pnpm 下次 prune 掉）：

```jsonc
"dsh-host-router":      "link:E:/PythonProject/dsh-router-b/packages/host-router",
"dsh-client-ui-router": "link:E:/PythonProject/dsh-router-b/packages/client-ui-router",
```

然后 `pnpm install --lockfile-only --registry=https://registry.npmmirror.com`（只同步锁文件，不碰 node_modules —— 因为跑完整 install 会去 swap 正被应用占用的 `dsh-computer-use-win`，上次就是这么把它删空的）。

**装前验证已过**：从 profile 目录 `import('dsh-host-router')` → `host-router` / `inject:["tools","subagents"]`；`import('dsh-client-ui-router')` → `client-ui-router`。`dsh-computer-use-win` 仍是 31 个文件。

备份：`~\.dsh\_profile-backups\desktop-20261118-231935\` 和 `~\.dsh\profiles\desktop\package.json.bak-link-*` / `pnpm-lock.yaml.bak-link-*`。

### 重新装一遍的完整顺序

```powershell
# 1. 确认两个 junction 在（不在就重建，见上）
# 2. 确认 profile package.json 的两条 link: 依赖在
# 3. 只同步锁文件
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install --lockfile-only --registry=https://registry.npmmirror.com
# 4. 重启应用
```

⚠️ **不要跑完整 `pnpm install`**——会去 swap 正被占用的 `dsh-computer-use-win`，上次把它删空了（已恢复）。

**装完必须重启应用。**

## 四、装完怎么验证

按顺序看三件事：

1. **日志里有没有路由挂载成功**
   ```
   host-router: HTTP bridge mounted at /api/router (...)
   ```
   没有这行 → `ctx.inject(['webServer'])` 没生效，看 `docs/INTEGRATION.md` 的降级说明。

2. **模型能不能看到工具**
   新开一个会话问它「你有几个路由相关的工具」，应该能看到 `route_task` / `task_board` / `task_note` / `task_block` / `task_resume` / `task_cancel` 之类。

3. **右侧栏有没有面板**
   应该有「任务」tab，里面是 `Active / Up next / Scheduled / Resolved` 四条泳道。
   如果显示「示例数据」徽标 → 说明 HTTP 桥没通，UI 退到了 mock。

## 五、分区怎么配

在 `cordis.patch.yml` 的 `config.partitions` 里，每项：

```yaml
- name: state                    # 分区名（唯一）
  root: E:/abs/path/to/partition # 必须是绝对路径
  include: ['**/*.go']           # 可选，默认全收
  exclude: ['vendor/**']
  keywords: [go, kratos]         # 主路由据此判定任务归属
  workers: 2                     # 该分区并发上限
  verify:                        # 验收命令；空 = 永远只能到 reported
    - go build ./...
```

⚠️ **不要写 `boardDir: null`** —— config 读的是 `undefined` 或路径，`null` 会走到 `resolve(null)` 崩在激活阶段。

## 六、已知限制（都是设计边界，不是 bug）

| 限制 | 原因 |
|---|---|
| `Scheduled` tab 恒空 | 路由器没有调度器，`scheduledFor` 无生产者 |
| 退回（rejected）不自动重派 | 需要人再发一次需求 |
| 人工验收不重跑验收命令 | 会阻塞 HTTP 数分钟；验收命令只在 worker 结算时跑 |
| 面板 publish 无 agent 身份 | 需求先入队 `queued`，有可达 agent 时才 pump 起来 |
| `offline` 状态永不出现 | 没有 worker 可达性探测，只有 `online/busy/released` |
| API Key 只显示已配置/未配置 | `credentials` Remote **值永不回读** |

## 七、踩过的坑（别重复）

1. **`peerDependencies` 一律用范围或不写。** `dsh-app-boot` 的启动预检会把 `@deepseek-ai/dsh-*` 的 peer 当**硬版本锁**，不满足就整行 `disabled`，插件静默消失。`dsh-web-search-exa` 就是这么坏的。
2. **运行时不能 import `@deepseek-ai/dsh-client-ui-slots` / `-primitives` / `-dockkit` / `dsh-client-store`** —— rc.3 的 asar 里没有这些包。UI 侧用 `src/shims/dsh-client.d.ts` 内联类型。
3. **不要抢 `rightbar`**（single slot，已被 sidebar-right 占用，强占会干掉文件树/终端/浏览器/预览）。用 `ctx.sidebarRightTabs.register()` 两阶段注册。
4. **`todos` 投影在 `turn/start` 被清成 null**。要历史清单必须读日志里的 `todo/write` 事件。
5. **Windows 上 `fs.rename` 覆盖正被读的文件会 EPERM**。看板原子写已带退避重试。
6. **运行版是 0.2.2-rc.3，而 `E:\PythonProject\deepseek-harness-latest` 是 rc.5。** 沙箱写根行为两者不同（rc.3 只认 `header.cwd`，rc.5 跟随 `workingDirectory`）。**以 rc.3 为准。**
7. `profiles\desktop\node_modules\@deepseek-ai\*` 有一批 junction 指向已消失的 `F:\deepseekHarness\…`。运行时无害，但**普通 Node 解析会穿过去落到 0.1.5-rc.2 的旧 checkout**，别在那条路径上验证 import。

## 八、出问题怎么回滚

```powershell
# 1. 停用 bundle：从 profile package.json 的 dsh.profile.bundles 移除 "dsh-router-b"
# 2. 或直接恢复备份：
$bak = "C:\Users\13558\.dsh\_profile-backups\desktop-20261118-231935"
Copy-Item "$bak\*" "C:\Users\13558\.dsh\profiles\desktop\" -Force
# 3. 重启应用
```

搜索修复的回滚：删掉 `profiles\desktop\compatibility.json`，重启。

## 九、验证记录（截至交接时）

| 项 | 结果 |
|---|---|
| `tsc -b packages\host-router` | exit 0 |
| `tsc -b packages\client-ui-router` | exit 0 |
| 宿主单测 `tests/{router,bridge}.test.mjs` | 28/28 pass |
| `scripts/verify-load.mjs` | 55 条 ok / 0 FAIL |
| **真实进程挂载** | ❌ **未验证** |
| **浏览器里真 fetch / SSE** | ❌ 未验证 |
| **真 pnpm 下 file: 依赖解析** | ❌ 未验证（按 hoisted linker 推断） |

## 十、任务顺序、挂起、工作区（2026-11-21）

### 顺序
- `route_task` 新增 `stage`（同一个父任务下的批次，数字小的先做完）和 `depends_on`（要先完成的任务 id）。
- 排队的任务只有在前置全部 `done/verified/reported` 后才会被派出；前置失败或被取消，它会变成 `blocked`，备注写明是哪个前置。前置重试成功后自动回到队列。
- manager 提示词要求一次把所有子任务发出（带 stage / depends_on），然后用 `task_wait`（按 `parent_task`）等子任务全部结束再汇报；manager 提前结束时路由器会提醒它继续等。

### 挂起
- 新工具 `task_suspend`（task_id、reason，可选 prerequisite / partition / wait_for）。给了 prerequisite 会自动建一个前置任务；前置完成后挂起的任务自动在原会话里继续，并带上前置的结果。已经交付的任务也能挂起再补。
- `task_control` 新增 `suspend`；`resume` 可以不等前置直接继续。
- 面板：右侧任务板「已挂起 · 等前置」分组；运行中/排队的行悬停有「挂起」，失败的行有「重试」。

### 进度提醒
- 任务开始、完成、挂起、唤醒时，路由器把合并后的【进度提醒】发到作战室，作战室用一两句话转述。配置：`progressNotices`（默认 true）、`progressNoticeDelayMs`（默认 3000，合并窗口）。
- 快照里新增 `groups`（每个需求的完成进度）和 `notices`（最近的提醒），任务板顶部显示整体进度条，底部显示最近提醒。

### 工作区
- 左侧栏新增「工作区」：左边是分区列表和分区根目录的文件树（按需逐层读取，不在 include/exclude 范围内的灰显），右边是根目录、include/exclude、启动时发现的配置问题、分区规范和这个分区的未完成任务。
- 接口：`GET /api/router/files?partition=<名字>&path=<相对目录>`，只返回名字、类型、大小、修改时间，不返回内容；不允许 `..`、绝对路径或指向根目录外的符号链接。
- worker 的分区说明里新增硬规则：只改分区内文件；需要改分区外或发现缺前置时调用 `task_suspend`；交付时在 `touched:` 下列出改过的路径。

### 生效方式
宿主侧改的是 `packages/host-router/src`，`lib/` 没动：在 Windows 上跑 `scripts/safe-build-host.sh` 生成 `lib.next/`，再跑 `scripts/safe-restart.sh`。界面的 `lib/client.js` 已经重新打包。

## routing → manager → session → worker（第一期整体改造）

整体方案和后续分期见 [ROADMAP.md](./ROADMAP.md)。本期改动：

- **路由快速转发**：作战室只识别分区，用户原话加上下文按分区各发一条 `route_task`，跨分区用 `depends_on`。只有标「无 manager」的分区由路由自己拆。
- **分区记忆**（`host-router/src/memory.ts`，存于 `<boardDir>/memory/<分区>.json`）：常驻笔记（最多 80 条）和工作日志（最多 300 条）。任务结束时自动记录，首次启动时用已结束的任务回填。每次派 manager 都把「本分区记得什么」注入提示词。
- **manager 新工具**：`session_list`、`session_read`（只读本路由派出的 session）、`partition_memory`（read / note / forget）。
- **manager 模型**：`tiers.json` 新增 `manager` 字段，默认 `strongest`。取值顺序：面板指定的模型 → 已保存的「高级」档（用最高推理档）→ 运行时可用模型里按名字最强的一个（opus/ultra/max/pro/reasoner/thinking/r1/large，其次比版本号、推理档数）→ 跟随默认模型。实际用的模型写在任务行的 `tierReason` 里，面板「模型档位」的 Manager 一行也会显示。
- **控制面**：`task_control` 新增 `cancel_tree`（停止该任务和它下面所有没结束的任务，先停上层）。面板发出的 `cancel` 和 `cancel_tree` 会标「人工停止」，并通知还在跑的上级 manager 不要重派。面板「停止」和「停止整个需求」要点两次确认，界面先变，失败再回滚。工作区页有「停止全部」。已停止的任务可以重试。
- **HTTP**：`GET/POST/DELETE /api/router/memory`（读分区记忆、加笔记、删笔记）。
- **部署**：host 的 `lib/` 不在仓库里重建，合并后执行 `scripts/safe-build-host.sh`，再执行 `scripts/safe-restart.sh`。client 的 `lib/client.js` 已重建并提交。

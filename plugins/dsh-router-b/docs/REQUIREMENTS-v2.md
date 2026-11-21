# 需求 v2（用户口述 → 规格）

> 2026-11-19 记录。来源：用户对「远程部署 harness 团队」的直接口述。
> 这份文件是 v2 改造的输入，不是设计稿。设计稿另起。

---

## 1. 目标形态

一个主窗口：我在里面提任务 → 自动落到工作区 → manager 决定这个任务是**新开 session** 还是**插进某个进行中的 session** → 右侧显示粗粒度的三件事。

不再追求「左侧项目列表 / 中栏聊天 / 右栏任务」三栏。右栏**不需要细致**。

---

## 2. 两级路由

| 级别 | 职责 | 现状 |
|---|---|---|
| **L1** | 判定任务属于哪个**工作区**（= 现有 partition） | ✅ 已有。`route_task` 的 `partition` 参数 + `config.partitions[].keywords` 关键词路由。工作区已选好 |
| **L2** | **manager** 决定：这个任务**新建一个 session**，还是**插入到某个进行中的 session** | ⚠️ 半成品。见 §5 差距 |

要点：L2 是**manager 的判断**，不是关键词匹配，也不是 lead agent 自己顺手选。必须能看到「为什么新建 / 为什么插进这条」。

术语对齐：用户说的 **session** = 现有代码里的 worker 子会话（`RouterTask.sessionId`）。「插入进行中」= 现有 `task_resume` 的 `continueWorker` 路径。

---

## 3. 右栏：只要三件事

放弃现有「四泳道 + 每任务完整卡片 + todo 清单」的密度。

1. **哪些工作区有任务** —— 按工作区聚合，每条给：在跑几条 / 待验收几条 / 待你决定几条。
2. **现在需要询问用户的有哪些** —— 一个「待你决定」桶。来源至少三类：
   - worker 中途提问（需要人回答才能继续）
   - `blocked` 状态的任务（现成原语，见 `board.ts` `TaskState`）
   - `reported` 待验收的任务（严格分开 reported / verified）
3. **每个任务的进度在哪** —— 粗粒度一句话：谁在做、走到哪、卡在哪。

---

## 4. 部署、同步、持久化

- **不做多机**。现在有两台只因为服务器上这套还跑不起来。
- 最终形态：**服务器是唯一运行时**，只做云 agent；服务器不会关。
- 本机的角色降级为：选工作区 / 提任务 / 看右栏 / 把本地新项目同步上去。
- **同步是双向的**：
  - 本地新起的项目 → 推到服务器
  - 有时候从服务器 → 拉回本地
- 持久化：面板、任务、worker 会话必须在**重启后还在**（服务器不关，但客户端会关）。

---

## 5. 与现状的差距（有代码证据）

| # | 需求 | 现状 | 差距 |
|---|---|---|---|
| G1 | L2 manager 显式决策 新建 / 插入 | `managerPrompt()` 只是**提示词嘱咐**模型：能复用就 `task_resume`、否则 `route_task`（`host-router/src/index.ts:80-106`）。决策结果没有字段记录「新建 or 插入」，`DispatchLevel` 只有 `manager` / `worker`（`board.ts:45-50`） | 要把「新建 vs 插入」变成一等字段（如 `attach?: 'new' \| { sessionId }`），并在 UI 显示理由 |
| G2 | 右栏只要工作区聚合 | `TaskBoard.tsx` 是四泳道（Active / Up next / Scheduled / Resolved），含完整卡片与 todo | 重做成「工作区行 + 待你决定 + 进度一句话」三个分区 |
| G3 | 「待你决定」桶 | 只有 `blocked` 状态 + `resumeNote`，**没有 worker 提问通道**。全仓 grep 无 question / pending-user 相关实现 | 全新。需要：worker 提的问答提升到顶层板 + 回答回灌到那条 worker session |
| G4 | 主窗口提任务即派发 | 主输入框发给当前会话的 lead agent，不经过路由板；要派发得打开 Tasks 面板用面板里的输入框 | 主输入框「发送即派发」 |
| G5 | 右栏默认可见 | 面板默认关闭，需点会话头部 Tasks 按钮 | 常开 |
| G6 | 单运行时（云 agent） | 现在插件装在**本机 desktop profile**（`link:E:/PythonProject/dsh-router-b`）；服务器 web profile 是另一套装法 | 服务器侧装好并验证；本机不再作为运行时而只是客户端 |
| G7 | 持久化 | ✅ 已满足。板子是 `$DSH_HOME/router/snapshot.json`，原子写 + `runToken` 区分「上次进程遗留」和「本次在飞」（`board.ts:92-99`、`index.ts:130-134`） | 无（需实测一次重启后的归属判定） |
| G8 | 双向项目同步 | 无。上一次只是把文件拷上去 | 全新。需要定方向、定冲突策略 |

---

## 6. 待确认（阻塞项）

1. 服务器「现在跑不起来」具体卡在哪：服务没起 / 起了但插件没生效 / 模型凭据 / 根本没试。
2. ~~「待你决定」的回答从哪进~~ → **已定：主输入框直接回，自动匹配到提问的那个任务。**
3. 项目同步用什么形态：git（各自 clone / push pull）、rsync 单向、还是别的。
4. 本机是否彻底不做运行时（所有 worker 都在服务器），还是保留「本机也能跑」的能力。

---

## 7. 已实施（2026-11-19）

### 7.1 上下文门限：256k 不再分派

用户口述：「虽然 worker 上下文 1M，但只要超过 256k 就不要分派了，让他自己搞完吧。」

落到 `packages/host-router/src/context.ts` + `index.ts`：

- 数据源不是估算：`pressureTokens = inputTokens + cacheReadTokens + cacheWriteTokens`，与 `token-meter/src/usage-projection.ts` 的 `pressureFrom()` 同一个定义；从会话日志里读最后一条带 usage 的 `assistant/message`（或 `assistant/attempt` 的 stream chunk）。**这样已结束的 worker 也能判**，不必拿到 live Session。
- 两个执法点：
  - `route_task`：判**调用方自己**的上下文（新 worker 从空开始，能撑大上下文的只有做决策的那条会话）。超限 → 拒绝派发，让调用者自己干完。
  - `task_resume`：判**目标 worker 会话**的上下文（这就是「插入进行中 session」那条路）。超限 → 不再追加，提示另起任务或自己做。
- 配置：`contextLimitTokens`，默认 `262144`；`0` 关闭。
- 读日志走 snapshot 那份 3s TTL 缓存，不会变成每次派发一次全量日志读。
- 未知用量（新会话 / 模型不上报 usage）按「未超限」处理：不能因为没测到就卡住。
- 验证：`node --test tests/bridge.test.mjs tests/router.test.mjs` → **31/31 通过**，其中 3 条是新加的（调用方超限拒绝 / 目标会话超限拒绝 / 0 关闭）。`tsc -b` exit 0。

**未验证**：真实进程里的行为（要重启桌面应用才会加载新的 `lib/`）。

### 7.2 报告契约：worker 必须说清楚自己做了什么

用户口述：「单个 session 一定要说清楚自己做了什么，让决策正确。」

原来 worker 的收尾是散文，manager 无法据此判断"该续插还是新建"。现在：

- `partitionBrief()` 要求 worker 结尾输出固定块（`--- report ---` + `summary:` / `touched:` / `left:` 三行）。
- `report.ts` 解析这个块（**只认最后一个 marker**，防止模型先引用格式再写真话；没有 marker 就返回 `undefined`，不猜）。
- 解析结果落到 `RouterTask.summary` / `.touched` / `.left`，`task_board` 的行里直接显示 `did:` / `touched:`。
- `managerPrompt()` 的 L2 决策改成读这两个字段：`touched` 有交集 → `task_resume`；无交集、或 `left: none` 且属另一子系统、或两个字段都没有 → 新开 worker；拿不准就新开。

**为什么这是"决策正确"的前提**：会话被复用的价值在于它记得相关的事；没有 `touched` 可对，复用就是赌博。

### 7.3 发现：真正会膨胀的是主窗口会话，不是 manager

- 每个分区 manager 是**每个任务新开一个** child（`dispatch()` 里 `level === 'manager'` 就 `startWorker`）；`managerBusy` 只防并发，`PartitionRecord.managerSessionId` 只写不读。⇒ manager 本身不会长期累积。
- 主窗口那条会话才是无限增长的：`dispatch()` 用 `delivery: 'parent'`，每个 worker 的收尾报告都以 user-role 消息回灌给它（`dispatch.ts` 注释里写明了这个机制）。任务越多，主窗口越像"一堆报告拼起来的东西"——这正是"完全不知道在做啥"的来源。
- 压缩入口是可编程的：`ctx.compaction.compactNow(agent, signal, commandId)`（`command-compact/src/index.ts:68`）。所以"定期清理"技术上可行。

⇒ 待定：清理策略（自动压缩 / 换新会话 / 只提示 / 先把回灌瘦身），见 §6。

### 7.4 已定：先瘦身回灌，暂不做清理

用户选择：**先瘦身回灌**，清理策略留到观察之后。

理由：回灌是增长源，清理是事后补救。先把源头掐小，比先加大扫除频率更划算。

做法（都在提示词层，不新增运行时机制）：

- worker 的收尾说明改成"你的最后一条消息就是发给派发方的全部内容，会被原样放进它的上下文"——明确告诉模型这条消息的读者和代价。
- 要求**报告块后什么都不写**、不复述任务、每行短。
- manager 的收尾同样限死：**最多三行**（起了哪几个 task id、各给了哪个 worker、放弃了什么）。

**局限要说清楚**：这是提示词约束，不是运行时强制。模型不遵守时，`parseWorkerReport` 返回 `undefined`，板上就没有 `did`/`touched`——manager 会按 §7.2 的规则当作"没有信息"处理（倾向新开）。要变成硬保证，只能在结算时截断回灌内容，而那需要改 `delivery` 的行为，当前 rc 没有这个入口。

**观察判据**：跑十来条任务后看主窗口的 `contextPressure`。还在快速逼近 256k，就回到 §6 的压缩/换会话方案。

### 7.5 验证记录

- `tsc -b packages\host-router` → exit 0
- `node --test tests/bridge.test.mjs tests/router.test.mjs` → **36/36 pass**
  - 上下文门限 3 条、报告契约 3 条、回灌瘦身 2 条
- 未验证：真实模型是否遵守报告格式与三行上限；真实进程里的门限与回灌行为（需重启应用）。

---

## 8. 部署记录：2026-11-19 同步到服务器

### 8.1 同步方式（有坑）

服务器上 `/srv/dsh-router-b/...` 和 `/root/.dsh/profiles/web/node_modules/dsh-*/...` 里的同名文件是**同一个 inode**（硬链接，pnpm 从 file: 源目录硬链过去的）。所以：

- ❌ 不能直接 `tar -xzf` 覆盖 `/srv`：解包会 unlink + 新建，硬链接断掉，profile 里那份还是旧内容。
- ✅ 正确做法：解包到 `/tmp`，再 `cp -rf tmp/xxx/. /srv/xxx/` 原地覆盖（cp 截断写，inode 不变，两边同时生效）；新文件再单独 `cp` 进 profile 那份。

本次只同步了 `packages/`、`docs/`、`locale/`、`icon.svg`、`index.js`。**没有覆盖** `cordis.patch.yml` 和根 `package.json`——服务器那份的分区根是 `/srv/workspace/...`、依赖是 `file:/srv/...`，本地那份是 `E:/...`。

### 8.2 验证结果

- `dsh-web` 重启后 active；日志里 `dsh web: http://127.0.0.1:42443/?token=...`。
- 面板（经 `ssh -L 14243:127.0.0.1:42443` 隧道 + token 打开）显示 **`3 partitions · 6 workers · updated 11:24:51`**，任务列表是真实数据，不是"示例数据"。⇒ 宿主 HTTP 桥在服务器上工作正常。
- 桥的真实路由是 `/api/router/board`（`BRIDGE_BASE + BOARD_PATH`），**不是** `/api/router/snapshot`。拿后者探测会得到 404，别据此判断"桥没挂"。
- 服务器上残留：4 条 `Queued`（Up next）+ 2 条 `Rejected`（Sent back），是之前测试留下的。

### 8.3 服务器的出网现状（实测）

| 目标 | 结果 |
|---|---|
| `api.github.com` | 200 |
| `api.deepseek.com` | 401（可达，缺有效 key） |
| `api.commandcode.ai` | 401（同上） |
| `www.google.com` | **000（不通）** |

⇒ 服务器能连 GitHub 和 LLM API，**连不上 Google**。任何依赖 Google 的 worker（搜资料、Trends）在服务器上会直接失败。

另：`/var/log/dsh-web.log` 里每次启动都有 `[llm-deepseek-api-key] model listing from https://api.deepseek.com/models failed (401); using the bundled catalog`——用的是 commandcode 的 key 去问 deepseek 官方，401 属预期噪音，但也可能是 headless 报 MISSING_CREDENTIAL 的线索。

### 8.4 待确认的网络信息（用户口述，细节缺失）

- 内网走 **FortiClient** VPN（本机）。
- 外网搜索走一个 Clash 类工具，用户记得叫 "mimoclash"（具体名字与端口待确认），有专门出口端口。
- 这两者与 worker 的关系还没定：是给 worker 注入代理环境变量，还是按分区声明"这个分区要内网 / 要外网"。

---

## 9. 主界面改造（层 2 + 层 1，2026-11-19）

> **2026-11-19 晚：作战室已撤掉。** 用户看了实际效果后判断"太搞笑了，就聊天窗口就好"。
> 主面板回到原生 `conversation`，`main` key 与 `sidebar.panellist` 行全部移除，
> `WarRoom.tsx` / `WarRoomIcon.tsx` 已删除，`panel.warroom` 文案一并清掉。
> 品牌（Team）保留。UI 改造改为在**右侧任务面板**上做，见 §9.5。

用户要求：「现在还是 deepseekharness 的模样，主界面能不能改掉」。

### 9.1 结论：能，但 single 座位是硬约束

`ui-slots` 对 single 座位独占：`single slot "x" already has a registration`（`ui-slots/src/index.ts:1284`）。所以换品牌不是"盖一层"，而是**先停用官方 brand 行**：
`ui-brand-official`（`bundle/web-app/cordis.patch.yml:375`）。

### 9.2 做了什么

| 改动 | 文件 |
|---|---|
| 新增 `main` keyed 面板「作战室」 | `client-ui-router/src/client/WarRoom.tsx` |
| 左栏导航行图标 | `WarRoomIcon.tsx`（`sidebar.panellist`，`id` = `router/war-room`） |
| 品牌替换（机会式） | `Brand.tsx`：`BrandMark` / `BrandName`，名字是常量 `PRODUCT_NAME = 'Team'` |
| 注册 | `src/client/index.ts`：`main` + `sidebar.panellist` + 两个 brand 座位 |
| 文案 | `locales.ts`：`panel.warroom` |

关键实现点：

- `main` 是 **keyed** 座位，加一个 key 是在聊天旁边**并存**，不是替换。聊天仍在 key `conversation`，左栏一点就回去。
- 左栏行的 `id` 必须等于 main 的 key，这是"点行切面板"的绑定方式（照 `ui-schedule` 的写法）。
- 注册完调 `layout.selectPanel(PANEL_ID)` 让作战室成为默认屏幕；失败被吞（layout 可能还没承认这个 key），不影响注册。
- 品牌注册包在 try/catch 里：官方 brand 没停用时座位被占、注册抛错，此时**静默保留官方品牌**，插件本身不受影响。这样"换不换皮"由 profile 的一行配置决定。

### 9.3 服务器上已生效（实测）

- `/root/.dsh/profiles/web/cordis.patch.yml` 加了 `- id: ui-brand-official / disabled: true`，备份在同目录 `cordis.patch.yml.bak-brand-20261119`。
- 隧道打开页面：左栏显示 **Team** 标记，导航出现 **War room**，主区是**作战室**，数据真实（`3 workspaces · 0 running · 2 queued · 1 waiting on you`）。
- **未做**：本机 desktop profile 没有停用官方 brand，也没重启，所以本机仍是旧外观（作战室可用）。

### 9.4 构建踩坑：TS5056

`npm run build` 在 Windows 上失败：`credentials.ts` 与 `Credentials.tsx` 在大小写不敏感文件系统上映射到同一个 `lib/types/client/credentials.d.ts`（TS5056）。**与本次改动无关，是既有问题**。

绕开方式（本次采用）：

```
node node_modules/typescript/bin/tsc -p tsconfig.json   # noEmit 类型检查
node scripts/build-client.mjs                            # esbuild 出 lib/client.js
node scripts/build-host.mjs
```

`lib/types` 因此没有重新生成（停在旧版本）。要修根因就得改文件名（`Credentials.tsx` → `CredentialForm.tsx`），属于独立改动。

### 9.5 右栏面板的 UI 优化（2026-11-19 晚）

作战室撤掉后，插件真正露脸的只有右侧面板，改动集中在那里。

**命名**：面板名从「任务面板 / Tasks」改成 **Routing / 路由**（用户原话：不要"作战室这么 der 的文字"，就叫 routing）。这一个键 `panel.title` 同时驱动三处：会话头部入口按钮、右栏 tab 标题、面板内标题。

**造型**：参照 Claude Duet 的任务栏（用户给的截图）——它的行极干净，只有图标 + 一行标题；分节头只有"名称 + 数字"；tab 是纯文字 + 一个填充的选中态。| 部位 | 改动 |
|---|---|
| 头部 | 标题 + 右侧 `+`（发起需求）与 `↻`（刷新，原来是文字按钮，两件东西轻重不一）；下方一条发丝线 |
| 元信息行 | 左侧分区/worker 数，右侧更新时间（原来看时间挤在中间） |
| Tab | 去掉外框轨道，改纯文字；选中项填充 `--dshr-fill` + 500 字重；计数为 0 不显示 |
| Tab 说明行 | 整行删除——它每次都要读，却只解释一次 |
| 分节头 | 只留 名称 + 计数（去掉说明文字与胶囊徽标、去掉分隔线），靠留白分节 |
| 任务行 | 折叠态只留 状态图标 + 单行标题；进度数字移到展开后的详情里；行高 40px，hover 才反色 |

验证：本地预览页截图对比 → `node scripts/build.mjs`（39 测试）→ 推服务器 → 真机截图确认。真机界面语言是英文，所以那边看到的是 `Active / Up next / Scheduled / Resolved`；中文环境下是 现在 / 排队 / 排程 / 已结束。

### 9.6 Routing 提升为主面板（2026-11-19 收尾）

用户反馈："还不是 routing 的界面"——工作区数据恢复后，打开应用仍停在空白首页，Routing 只在打开会话、点会话头部按钮后才出现。

改动：把任务板注册为 `main` 面板（key `router/routing`，左栏同名一行），`layout.selectPanel()` 在加载时选中它。组件不重写——`RoutingPage.tsx` 只是把同一个 `RouterPanel` 包了一层居中的 880px 卡片，所以主面板和右栏 tab 用的是同一份实现、同一个 controller，两边不可能说两套话。

聊天没丢：`main` 是 keyed 座位，`conversation` 的 key 原样保留，左栏点会话就回去。

验证：服务器重启后打开即 Routing 页面（Projects 栏 + 任务板 + API Key 状态），三行 `main`/`sidebar.panellist` 注册全部生效。

---

## 10. 可迁移化（2026-11-19）

目标：**始终保持插件形态，DSH 版本更新时可以随时迁移**，而不是 fork 一份外壳。做法与验证见 `docs/UPGRADE.md`，这里只记结论。

| 项 | 改动 | 验证 |
|---|---|---|
| 依赖可移植 | 根 `package.json` 的 `file:` 依赖从 `E:/PythonProject/...` 改成 `file:./packages/...` | 服务器上 dry-run 通过，目录可整体搬迁 |
| 一条命令装 | `scripts/install.mjs`：写 link 依赖、注册 bundle、建目录链接、（可选）停用官方 brand | 临时 profile 首次装 5 项、二次跑「already installed」；服务器上把 pnpm 副本换成了 symlink |
| 一条命令构建 | `scripts/build.mjs`：按版本挑编译器（宿主需 TS≥5.7），构建后直接跑 39 条测试 | exit 0，39/39 |
| 构建不再坏 | 改名 `credentials.ts` / `CredentialForm.tsx` 消除 TS5056 | `tsc -p tsconfig.build.json` exit 0 |
| 升级自检 | 激活时写 `<DSH home>/router/seams.json`（六个服务 + `ok`） | 服务器实测：全部 true，`ok: true` |

**为什么自检写文件而不是打日志**：`ctx.logger.info` 在 `dsh web` 服务下不落 `/var/log/dsh-web.log`，实测搜不到插件任何日志行，只能靠文件判断。

**仍然存在的迁移风险**（写在 UPGRADE.md 第五节）：客户端的 `src/shims/dsh-client.d.ts` 是按版本手写的类型面，版本升级后如果 slot 名或服务签名变了，这份 shim 要跟着改；这是唯一不能自动发现的地方。

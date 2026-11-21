# 原生入口：上传 / 下载 / API key

用户要的三件事里，只有「任务面板」需要新代码；另外三个入口 rc.3 全都有官方落点。
**本文只写路径与证据，插件不重复实现**——重造一套只会和原生入口抢位置、抢凭据来源。

证据路径均相对 `C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\`。

---

## 1. 配置 API key —— 用 Models 设置页，不要写文件

**用户路径**：设置（侧栏底部齿轮）→ **Models** → 选 provider 卡片 → API Key 输入框。
就落在 `dsh-client-ui-settings-models`，它管理**全部** provider 配置与凭据写入
（`src/client/index.ts:143-144`、`src/client/slot-contract.ts:35`；注入 `remote.credentials`
/ `remote.settings` / `remote.llm` 见 `src/client/index.ts:68`）。

**若要嵌到自己的面板里**（不必重造表单，只是调用同一套 Remote）：

```js
await ctx.remote.credentials.set(ref, value)     // 只上行，不回读
await ctx.remote.credentials.unset(ref)
await ctx.remote.credentials.describe(refs)      // → { configured, source?, writable, masked? }
```

安全语义（`dsh-api-settings-controller/src/credentials.ts:61-119`）：

- 任何方法都**不回传凭据值**，只回 `configured / source / writable / masked`；
- `ref` 必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；`describe` 一次最多 64 个；
- 失败统一 `credential/rejected`，details 只带 ref。

存储分层（`dsh-credentials-local/src/index.ts:2-9,61,65-67`）：

```
$DSH_HOME/.credentials.yaml   ← provider 管理，set/unset 原子重写这一层
$DSH_HOME/.env                ← 只读 fallback，provider 永不写
环境变量                       ← 最低
```

⇒ **绝对不要手写 `.env` 或 `.credentials.yaml`**：会被下一次 `set/unset` 的原子重写覆盖，
或造成分层歧义。另外本任务明确不动 `C:\Users\<user>\.dsh\`。

---

## 2. 上传（附件 / 需求里带的文件）—— 原生两条通道

- **Remote（小文件、精确字节）**：`upload`，
  `upload(agent, { data: base64, name? }, signal) → { receiptId, file }`
  （`dsh-client-file-upload/src/index.ts:112-120`）。
- **HTTP 流式（浏览器大文件）**：`POST /api/session/uploadFileBinary`
  （`dsh-client-file-upload/src/protocol.ts:2`，浏览器相对形式 `api/session/uploadFileBinary`）。
- 客户端面：`FileUploadService.upload(sessionId, Blob|Uint8Array|ReadableStream, name?, signal?, onProgress?)`
  （`dsh-client-file-upload/src/client/contract.ts:16-53`）。
- 落盘：内容寻址，`$DSH_HOME/attachments/v1/files/<sha[0:2]>/<sha>/<name>`
  （`dsh-attachment-local/src/index.ts:167-180`、`file-store.ts:70-82`）。
- UI 面：`dsh-client-ui-attachment`（拖放、附件轨、消息内图片）。**不是数据通道**。

两个必须知道的限制：

1. **子会话拒绝上传**：`session.header.origin === 'subagent'` 时抛 `subagent/attachment-invalid`
   （`dsh-client-file-upload/src/index.ts:283-291`）。⇒ worker 子会话里不要放上传按钮。
2. 上传只是**暂存 receipt**，必须被某条 prompt 引用后才 retire（`bindPrompt`，`:293-306`）。

---

## 3. 下载产物 —— 调 `present` 工具，UI 自动渲染

- 模型侧工具 `present`：`{ files: [{ path, description? }] }`，1..8 个，path 必须是会话工作目录下
  存在的普通文件（`dsh-tool-present/src/index.ts:38-109`）。
- 写事件 `deliverables/presented`（`:106-108`，成功才写）。
- 渲染：`dsh-client-ui-deliverables` 负责 `PresentRow` / `Deliverables` / `ReviewedFiles`，
  **插件什么都不用做**。

坑：

- `present` 要求**有 open turn**，turn 结束后补调会抛 `ToolContextUnavailableError`（`:80-81`）。
- `present` 不在 base bundle 里，由 preset 组合（`dsh-web-app/presets/standard.patch.yml:129`）。
  自建 preset 不加这一行就没有 `present`。

本插件在任务卡片上的产物行（`TaskView.artifacts`）**不是**第二条下载通道：
它只是把「这个任务产出了什么」显示在任务卡里，点击走 `ctx.sidebarRight.openResource(address)`，
最终仍是原生的资源查看/下载路径。真正的「交给用户下载」请让 worker 调 `present`。

---

## 4. 结论：本插件只做一件事

| 需求 | 谁负责 |
|---|---|
| 左边聊天 | 原生 `conversation`（`main` slot 的默认 key） |
| 右边任务面板 | **本插件**（`sidebar.right.pane.tab`） |
| 左栏「项目列表 + API Key」 | **本插件自己分栏**（panel 内部的 `ProjectRail`，理由见 §5） |
| worker 的「工作清单 / 干到哪一步」 | 原生 `todos` 投影（本插件只负责读） |
| 上传附件 | 原生 `dsh-client-file-upload` + `dsh-client-ui-attachment` |
| 下载产物 | 原生 `present` + `dsh-client-ui-deliverables` |
| 配 API key | 原生 Settings → Models（`remote.credentials`）；本插件的区块只用同一套 Remote 做状态与写入 |

---

## 5. 左栏：本插件自己分栏，**不**注册到原生左栏

结论先说：Claude Duet 那种「左栏项目列表 / 中栏聊天 / 右栏任务」三栏，在 rc.3 里只能做成
**「左栏画在右栏 panel 内部」**。原因是原生左栏既没有留给第三方的内容座位，也没有「换掉左栏内容」
的 API——`ctx.layout` 只有主面板选择与左右栏几何。

### 5.1 证据（`dsh-client-ui-layout/src/client/index.ts`）

| 行 | 内容 | 对本插件的含义 |
|---|---|---|
| `:59-70` | `sidebar` 是 **single** slot，注释写明 *OCCUPIED by ui-sidebar's SidebarRoot*，且「registering here **replaces the navigation column outright** rather than adding to it, and the seats it declares disappear with it」 | 注册进去 = 会话列表和它的 8 个子座位一起消失 → 硬约束禁止 |
| `:71-75` | `main` 是 **keyed** slot，保留 key `conversation` | 这是**中栏**：加一个新 key 只能把聊天换掉，不是左栏 |
| `:88` | `rightbar` single，已被 ui-sidebar-right 占用 | 抢了会干掉文件树/终端/浏览器/文档预览 → 硬约束禁止 |
| `:96-121` | `shell.bottom` / `shell.overlay`（list，全帧浮层）/ `shell.leading`（窗控，已占用） | 都不是「左栏内容」，浮层会盖住聊天 |

`ctx.layout` 的全部成员（`src/client/service.ts:28-54`）：

```ts
panelInfo: HostObservable<PanelInfo>      // { activePanelId }
selectPanel(panelId: MainPanelId|null)    // 只切「中栏」的 keyed 面板
beginNavigation(): AbortSignal
toggleSidebar(): void                     // 整条原生左栏 收起/展开
openRightbar(track, fullscreen) / closeRightbar()
```

**没有** panel 的 `visible` / `active` / `collapse` / `show` 之类，也没有「左栏内容」这个概念。
`toggleSidebar()` 收起的是整条会话列表，不会让位给我们的东西。

### 5.2 原生左栏内部的 8 个座位（`dsh-client-ui-sidebar/src/client/index.ts:88-108`）

| 座位 | kind | 现状 | 能放我们的东西吗 |
|---|---|---|---|
| `sidebar.brand.mark` / `.brand.name` | single | 被 ui-brand-official 占 | 否 |
| `sidebar.toggle.badge` | single | 被 ui-settings-general（桌面更新徽标）占 | 否 |
| `sidebar.panellist` | list | 空 | **是行不是容器**：条目 id 必须等于一个主面板 key，加的是导航行 |
| `sidebar.panellist.actions` | list | 空 | 只是「More」菜单里的行 |
| `sidebar.workspaces` | single | ui-workspace 的会话浏览器 | 否（抢了 = 会话列表没了） |
| `sidebar.settings` | single | ui-settings-general 的设置入口 + 弹窗 | 否 |
| `sidebar.footer.action` | list | 空 | 56px 栏里的一个按钮，放不下项目列表 |

⇒ 能「加」的三个座位（`panellist` / `panellist.actions` / `footer.action`）都只是**行或按钮**，
装不下一份项目列表 + API Key 状态。

### 5.3 所以怎么做

- 我们的 panel 内部自己分两栏：`ProjectRail`（项目 + 启停 + API Key）+ `TaskBoard`（四个 tab + 任务行）。
- 宽容器（≥660px）两栏并排；窄容器（真实的 420px 右栏）退化成「项目 / 任务」二选一视图，
  任务头部 `☰` 打开项目栏，项目栏 `×` 回到任务——同一份 DOM，容器查询驱动，不测 JS。
- 产物上仍是一块：右侧栏的一个 tab，不抢 `rightbar`，不碰 `sidebar`。

### 5.4 唯一还剩下的「真左栏」路径（本轮没做）

注册一个 `main` key（整块占中栏，与 Chat 平级）+ `sidebar.panellist` 一行入口 +
`sidebar.panel.icon` 图标工厂，用户点那一行在中栏与 Chat 之间切换。代价是：**中栏不再是聊天**，
与本轮「中栏保持原生聊天」直接冲突，所以只记录、不实现。

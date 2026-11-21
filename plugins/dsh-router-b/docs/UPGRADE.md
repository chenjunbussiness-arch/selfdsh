# 迁移与升级

这份文档回答一个问题：**DSH 换版本了，或者换机器了，怎么把这个插件挪过去。**

原则只有一条：它始终是**插件**，不是 fork。所有东西都通过 DSH 公开的挂载点接入（工具、subagent 服务、`ctx.inject(['webServer'])`、client slot），所以版本升级时坏的是"某几个挂载点变了"，而不是"整个外壳要重做一遍"。

---

## 一、这个 bundle 里有什么

```
dsh-router-b/
├── package.json            清单；依赖是相对路径 file:./packages/*
├── cordis.patch.yml        挂载行（host + client 两行）
├── index.js                空 host 半边
├── icon.svg / locale/      插件管理器展示
├── scripts/
│   ├── build.mjs           一条命令构建全部产物
│   └── install.mjs         一条命令装进任意 profile（幂等）
├── packages/
│   ├── host-router/        宿主：分区、看板、派发、结算、HTTP 桥
│   └── client-ui-router/   浏览器：右栏任务面板 + 作战室主面板 + 品牌
└── docs/
```

**能带走的**：整个目录（`packages/*/node_modules` 除外，那是构建工具，不是运行期依赖）。
**带不走的**：profile 的配置（`~/.dsh/profiles/<name>/`）——那是每台机器自己的身份、密钥和分区根。

---

## 二、换机器 / 新装

```bash
# 1. 把目录拷过去（不要带 node_modules）
# 2. 装进目标 profile
node scripts/install.mjs --profile ~/.dsh/profiles/web --disable-brand
# 3. 重启拥有这个 profile 的进程
```

`install.mjs` 做的事，全部幂等：

1. 在 profile 的 `package.json` 里写三条 `link:` 依赖（bundle 本身 + 两个子包）——**用 link，不用拷贝**，profile 永远不持有过期副本；
2. 把 `dsh-router-b` 加进 `dsh.profile.bundles`；
3. 在 `node_modules/` 下建三个目录链接（Windows 用 junction，不需要管理员权限）；
4. `--disable-brand` 时才追加：停用官方 `ui-brand-official`，让本插件接管 `sidebar.brand.mark` / `sidebar.brand.name`（single 座位被占时注册会抛错，见 `ui-slots/src/index.ts:1284`）。

它**故意不跑包管理器**：profile 级 `pnpm install` 会重写整棵树，本部署上已经因此把一个包删空过。链接 + 一行 `package.json` 对加载器就够了，而且用文本编辑器就能回滚。

装完看三处：

- `<DSH home>/router/seams.json` 里 `ok: true`；
- 左栏出现 **War room**；
- 右栏面板显示真实分区（不是"示例数据"）。

---

## 三、DSH 升级之后

```bash
node scripts/build.mjs                      # 重新构建 + 跑宿主测试
node scripts/install.mjs --profile <profile> # 通常是 no-op
# 重启，然后看 seams 那行
```

`build.mjs` 会按版本挑编译器：

- 浏览器半边只要 TS 5.6+（它只出声明和一个 esbuild bundle）；
- 宿主半边要求 **TS ≥ 5.7**，因为源码用 `.ts` 后缀导入而产物是 JS，需要 `rewriteRelativeImportExtensions`；
- 找不到就用 `DSH_TSC` 环境变量指定。

构建≈验证：最后一步直接跑宿主那 39 条测试（它们导入编译产物，构建坏了就过不去）。

---

## 四、升级时要逐个核对的接口点

这是全部的外部依赖面。**只改这七处**，其余都是本仓库自己的代码。

| # | 用到的能力 | 代码位置 | 断了的现象 | 怎么验 |
|---|---|---|---|---|
| 1 | `ctx.tools.register({name, parameters, output, execute})` | `host-router/src/index.ts` 各 `ctx.effect` | 模型看不到 `route_task` / `task_board` 等工具 | 新开会话问"你有几个路由工具" |
| 2 | `ctx.subagents.startActivation({ cwd, parent, prompt, delivery, signal })` | `dispatch.ts: startWorker` | 派发失败，任务停在 `queued` | 发一条任务看板子里是否 `dispatched` |
| 3 | `ctx.subagents.sendMessage(sender, childId, content, { signal })` | `dispatch.ts: continueWorker` | `task_resume` 报错，无法续插 | 对一条 `reported` 任务调 `task_resume` |
| 4 | `ctx.inject(['webServer'])` + `webServer.register(route)` | `index.ts` 末尾 | 面板退化成"示例数据"，`/api/router/*` 404 | `curl` 面板的 `/api/router/board`（带登录 cookie） |
| 5 | `ctx.get('sessionQuery').readSession(id)` | `snapshot.ts: createLogReader` | 进度/todo/上下文计量全空 | 看板子里的 `todos` 与 `did:` 行 |
| 6 | client：`ctx.slots.inject/register`、`layout.selectPanel`、`sidebar.panellist` | `client-ui-router/src/client/index.ts` | 主面板或左栏行不出现 | 打开页面看左栏 |
| 7 | single 座位占用语义（品牌） | 同上 + profile patch | 品牌静默保持官方（不报错） | 左栏左上角是不是 Team |

已知的跨版本差异样例（rc.3 → rc.5）：

- `subagent` **工具**的 `cwd` 参数在 rc.5 被移除，但 **服务** `startActivation({cwd})` 两版都在 —— 所以派发只走服务，不走工具。
- 沙箱写根的判定：rc.3 只看 `session.header.cwd`，rc.5 跟随 `workingDirectory` —— 所以派发时额外做一次 `sandboxPolicy.registerWritableRoot`（有就做，没有不影响）。

---

## 五、启动自检怎么读

每次激活写一份 `<DSH home>/router/seams.json`：

```json
{
  "at": "2026-11-19T03:48:52.707Z",
  "node": "v24.22.3",
  "seams": {
    "tools": true, "subagents": true, "agents": true,
    "sessionQuery": true, "credentials": true, "sandboxPolicy": true
  },
  "required": ["tools", "subagents"],
  "ok": true
}
```

**为什么要写文件而不是打日志**：`ctx.logger.info` 在 `dsh web` 服务下不会进 `/var/log/dsh-web.log`（实测日志里搜不到 `bridge mounted`，但插件明明在工作）。所以判断依据是这份文件，不是进程日志。

- `ok: false` ⇒ `tools` 或 `subagents` 丢了，这两个是硬依赖（`export const inject = ['tools', 'subagents']`），插件基本不能用，先查这个版本的服务名。
- `agents` / `sessionQuery` 为 false ⇒ 派发与进度都会失效。
- `credentials` / `sandboxPolicy` 为 false 通常没事：前者只是不报 API key 状态，后者只是不做写根授权（沙箱装不上时的正常降级）。

HTTP 桥是单独一件事：它的挂载发生在 `ctx.inject(['webServer'])` 回调里，判据是面板里出现真实分区（不是"示例数据"），或带登录 cookie 请求 `/api/router/board` 返回任务而不是 404。

---

## 六、回滚

```bash
# 1. 从 profile 里摘掉 bundle
#    package.json: dsh.profile.bundles 去掉 "dsh-router-b"
# 2. 或用 install 生成的备份
ls ~/.dsh/profiles/web/*.bak-install-*
# 3. 重启
```

`install.mjs` 每次改动都会留 `.bak-install-<时间戳>`，`cordis.patch.yml` 也一样。

---

## 七、已知陷阱

1. **不要把子包写进 `dsh.profile.bundles`。** `dsh-host-router` / `dsh-client-ui-router` 是 bundle 挂载的库，不是 bundle。一旦进了这个数组，加载器会把它们当独立 bundle 激活，读取**该包自己的** patch —— 而那份 patch 里的分区根是某台机器的路径，在别的机器上要么不存在（Linux 上 `E:/...` 甚至不算绝对路径）。
   实际症状：插件页出现 `启用失败：1 entry did not activate host-router (dsh-host-router): PartitionConfigError: partition "front" needs an absolute root`。
   处理：从 bundles 里删掉这两项（`scripts/install.mjs` 现在会自动清理），并确认 `packages/host-router/package.json` 里**没有** `dsh.bundle` 声明。
2. **profile 里的包是硬链接，不是副本。** 服务器上 `/srv/dsh-router-b/packages/...` 与 `profiles/web/node_modules/...` 是同一个 inode。直接 `tar -xzf` 覆盖会 unlink+新建，**断链**，profile 那份还是旧的。要解到临时目录再 `cp -rf src/. dest/`（截断写，inode 不变）。
3. **不要跑 profile 级 `pnpm install`。** 会去 swap 正被占用的 native 包，本部署上已经把 `dsh-computer-use-win` 删空过一次。
4. **single 座位不能抢。** `sidebar` / `rightbar` / `shell.bottom` / `shell.leading` 已被官方占用，抢了会顶掉会话列表或文件树。
5. **TS5056（已修）**：`credentials.ts` 与 `Credentials.tsx` 在大小写不敏感文件系统上映射到同一个 `.d.ts`。文件已改名 `CredentialForm.tsx`。
6. **宿主编译需要 TS ≥ 5.7**，浏览器半边 5.6 就够。`build.mjs` 会自己挑，挑不到会明确报错而不是半路失败。
7. **`app.asar` 不是目录**：桌面安装里 `resources/app.asar` 是单个文件，原生工具（`ls`/`cat`/`tar`）读不了，只有文件读取工具和 Electron 运行时能进去。文档里的 `::` 行号引用指的是 asar 内部路径。
8. **agent 浏览器同时开太多 SPA 标签会拖死 CDP**：本次验证时 6 个标签同时跑同一套 SPA，`Accessibility.getFullAXTree` 直接超时；关掉旧标签即恢复。
9. **反向代理必须转发 WebSocket upgrade，否则页面"看起来空"。** 中间那道入口门禁（`deploy/dsh-web-gate.mjs`）原来只用 `http.request` + `pipe` 转发 HTTP，没有 `upgrade` 监听。结果是：页面外壳能加载，但 `/connect` 的升级永远失败，客户端一直"重新连接中"，工作区和会话全是空的——数据其实都在。
   实测对照：同一台服务器、同一时刻，旧门禁打开是 `No sessions yet` + 工作区全空；修好的门禁打开是 3 个工作区 + 会话正常。
   修法是监听 `server.on('upgrade')`，把上游的 101 原样回转（`Sec-WebSocket-Accept` 必须逐字节转发，浏览器会校验），然后双向 `pipe` 两个 socket。

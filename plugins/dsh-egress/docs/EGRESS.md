# dsh-egress：模型出口管理

在界面上管理「服务器上 DSH 模型请求从哪个代理出去」，并为每个模型端点主机选一个出口。只管服务器上 DSH 进程的 `fetch` 流量。

研究结论与行号证据见 [RESEARCH.md](./RESEARCH.md)。

## 1. 它做什么

- 出口清单：`direct`（内置）和任意数量的 `http` / `https` / `socks5`（由代理解析域名，socks5h 语义），可带用户名密码。
- 绑定：目标主机（例如 `api.commandcode.ai`）→ 出口。没有单独绑定的主机走「默认出口」，初始值是 `direct`。
- 生效方式：**即时**。保存后下一条模型请求就走新出口，不需要重启 dsh-web。只有**第一次装/升级插件**需要重启一次，让钩子装上。
- 失败即断：选定的出口不通，请求直接抛错，错误里写明出口名，且写着 “not retried directly”。没有任何回退直连的路径。
- 探测：对固定端点 `https://ifconfig.me/ip` 发一次 GET（8 秒超时），返回出口 IP、延迟、错误。
- 最近 100 条请求日志：只记 时间、目标主机、出口、成功/失败、错误摘要。不记路径、请求头、请求体、prompt。
- agent 工具：只有只读的 `egress_status`（脱敏）。所有写操作只能人在界面做。

## 2. 架构

```
dsh-web 进程
 ├─ pi-ai OpenAI-completions ──► new OpenAI({fetch: undefined}) ──► globalThis.fetch   ← 每次请求构造时读取
 │                                                                   │
 │                                         dsh-host-egress 包装的 fetch（egressFetch）
 │                                           │ 回环地址、非 http(s) URL → 原 fetch（不出机器）
 │                                           │ 按目标主机查 绑定 → 默认出口
 │                                           ├─ direct → 原 fetch
 │                                           ├─ 代理出口 → undici.fetch + 该出口的 ProxyAgent / Socks5ProxyAgent
 │                                           └─ 出口缺失 / 配置损坏 / undici 缺失 / 代理失败 → 抛 EgressError（不直连）
 ├─ HTTP 桥 /api/egress/*（webServer.register）──► 同一个运行时 + config.json
 └─ 工具 egress_status（只读）
```

| 文件 | 内容 |
|---|---|
| `packages/host-egress/src/dispatch.ts` | fetch 钩子、出口选择、dispatcher 缓存、探测、环形日志 |
| `packages/host-egress/src/store.ts` | `config.json` 读写：原子写（临时文件 + rename，Windows EPERM 重试），目录 0700、文件 0600，改动文件后自动重读 |
| `packages/host-egress/src/validate.ts` | 校验、脱敏、回环判断 |
| `packages/host-egress/src/bridge.ts` | `/api/egress/{state,exit,binding,probe}` |
| `packages/host-egress/src/state.ts` | 脱敏后的状态文档、工具文本 |
| `packages/client-ui-egress/src/client/*` | 「出口」主面板（类名前缀 `dshe-`，zh/en，宿主桥不通时退回示例数据并显示「示例数据」徽标） |

HTTP 桥：

| 方法 路径 | 作用 |
|---|---|
| `GET /api/egress/state` | 出口（脱敏）、绑定、默认出口、生效方式、最近请求 |
| `PUT /api/egress/exit` | 新建/编辑出口。`id` 缺省为新建。编辑时密码留空保留原密码，`clearAuth:true` 清除认证 |
| `DELETE /api/egress/exit?id=` | 删除出口。仍被绑定或是默认出口时拒绝（`in-use`） |
| `PUT /api/egress/binding` | `{host, exit}`；`host:"*"` 设默认出口；`exit:null` 取消绑定 |
| `POST /api/egress/probe` | `{id}`，只读 `id`。没有 URL 字段，不能指定探测目标 |

写请求要求 `content-type: application/json`，并拒绝 `Sec-Fetch-Site: cross-site`。桥本身不另做登录：它挂在 DSH 的 web 服务上，前面已有 dsh-web-gate 和 nginx 的 Basic 认证。

## 3. 安全设计

1. **失败即断**。选定出口不通时没有任何回退。三处保证：`resolve()` 对「出口不存在 / 配置损坏」返回 `blocked`；`viaProxy` 失败一律包装成 `EgressError`；`direct` 只在用户明确选择（或默认出口保持初始值 `direct`）时使用。测试 `FAIL-CLOSED*` 用关闭的代理端口、被关掉的代理、损坏的配置、缺失的 undici 验证，并断言目标服务器命中数不变、直连 fetch 间谍零调用。
2. **钩子不随插件停用而撤销**。撤销会让所有已绑定代理的主机瞬间变成直连。要彻底撤销必须重启 dsh-web（见回滚）。
3. **机密**。代理认证只存在 `config.json`（0600，目录 0700）。读接口、状态文档、工具输出、错误信息、环形日志都不含用户名和密码：URL 一律 `scheme://***:***@host:port`，上游错误文本经 `scrub()` 去掉 `://user:pass@` 和已知机密字面值。
4. **输入校验**：host 只收 DNS 名或 IP 字面量，拒绝换行、NUL、URL、`@`、`:`、`/`、空格；端口 1–65535 整数；类型白名单 `http|https|socks5(h)`；名称 1–40 字符；id 为小写 slug 且不能是 `direct`；用户名不含 `:`；请求体上限 16 KB。
5. **探测防 SSRF**：端点写死在代码里（`PROBE_URL`），接口只读 `id`；测试用 `{id, url, host}` 的恶意请求确认额外字段被忽略。
6. **回环直通**：`localhost`、`127.0.0.0/8`、`::1` 等不经代理，否则 Web UI 自己的请求会绕出去。
7. **agent 只读**：`egress_status` 无参数、无写入口。
8. 文档和代码里不涉及本机 claude 的任何端口或配置。

## 4. 研究结论摘要

- 模型请求走 `globalThis.fetch`：pi-ai 每次 `stream()` 新建 OpenAI 客户端，客户端构造时取全局 `fetch`。所以包装全局 fetch 即时生效。
- DSH 现成的代理能力只有进程级环境变量（`HTTPS_PROXY` 等，启动时读一次），且 SOCKS 会被「报告并跳过，直连」。不满足 fail-closed，也不能按 provider 区分，所以不用。
- 服务器 Node v24.22.3，`--use-env-proxy` 可用，但同样只在启动时读环境、不支持 SOCKS。
- 服务器上已有 undici 8.11.2（`@deepseek-ai/dsh-http-proxy` 的依赖），导出 `ProxyAgent` 和 `Socks5ProxyAgent`。从 dsh-web 进程里用 `createRequire(...)('undici')` 能经 `NODE_PATH` 解析到它（ESM `import` 和不带 `NODE_PATH` 的 Node 解析不行）。不需要在服务器上装任何包。

| 能力 | 结论 |
|---|---|
| 按 provider（目标主机）独立出口 | 能，即时生效 |
| 整进程统一出口 | 能（把默认出口设成代理即可），即时生效 |
| 不覆盖 | `web-fetch-http`（自己用 undici）、子进程里的 curl/git、Worker 线程、AWS Bedrock |

## 5. 给 lead 的部署清单

前提：服务器 `<server>`，DSH 0.2.2-rc.5，profile `/root/.dsh/profiles/web`，已有 `/srv/dsh-router-b`（bundle 通过 `link:` 挂载）。以下步骤由 lead 执行；插件作者没有对服务器做任何写操作。

```powershell
$key = '<你的私钥>.pem'
$ssh = @('-i',$key,'-o','StrictHostKeyChecking=no')

# 0. 本机先构建并测试
cd E:\PythonProject\dsh-netops\egress
node scripts\build.mjs                      # 必须以 "build ok" 结尾

# 1. 打包（不含 node_modules 和 preview 产物；tests/fixtures 里是测试专用的自签证书，无关紧要）
$tar = "$env:TEMP\dsh-egress.tar"
tar -cf $tar -C E:\PythonProject\dsh-netops --exclude=node_modules --exclude=preview/dist --exclude=.preview.pid --exclude=docs/screenshots egress
scp @ssh $tar root@<server>:/tmp/dsh-egress.tar

# 2. 解压到 /srv/dsh-egress（目录里没有任何服务器上的已有文件被覆盖）
ssh @ssh root@<server> 'set -e; mkdir -p /srv/dsh-egress.new && tar -xf /tmp/dsh-egress.tar -C /srv/dsh-egress.new --strip-components=1 && mv /srv/dsh-egress.new /srv/dsh-egress && rm /tmp/dsh-egress.tar && ls /srv/dsh-egress'
```

3. **接入 profile**。优先用安装脚本（幂等，会先备份 `package.json` 为 `package.json.bak-install-<时间>`，只写 link，不跑包管理器）。先 dry-run：

```bash
cd /srv/dsh-egress
node scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run
node scripts/install.mjs --profile /root/.dsh/profiles/web
```

它做的事等于手工：

- `/root/.dsh/profiles/web/package.json` 的 `dependencies` 增加三行：
  ```json
  "dsh-egress": "link:/srv/dsh-egress",
  "dsh-host-egress": "link:/srv/dsh-egress/packages/host-egress",
  "dsh-client-ui-egress": "link:/srv/dsh-egress/packages/client-ui-egress"
  ```
- `dsh.profile.bundles` 追加 `"dsh-egress"`（与现有的 `"dsh-router-b"` 并列）。
- `/root/.dsh/profiles/web/node_modules/` 下建三个同名软链。

**`cordis.patch.yml` 不需要改。** bundle 的补丁在 `/srv/dsh-egress/cordis.patch.yml`，由 `dsh.bundle.patch` 自动叠加，挂载两行：`host-egress`（带 `providers: [{name: commandecode, baseURL: https://api.commandcode.ai/provider/v1}]`，让绑定表一开始就有这一行）和 `client-ui-egress`。想换数据目录或指定 undici，可在 profile 的 `cordis.patch.yml` 里对 id `host-egress` 覆盖 `config.dataDir` / `config.undiciPath`。

4. **重启一次**（唯一一次，之后改出口都不用重启）：

```bash
systemctl restart dsh-web && sleep 40 && tail -n 60 /var/log/dsh-web.log | grep -E 'dsh-egress|did not activate'
```

日志里应出现：
`dsh-egress: fetch hook installed (data /root/.dsh/egress); undici 8.11.2; 0 exit(s), default direct` 和
`dsh-egress: HTTP bridge mounted at /api/egress (state/exit/binding/probe)`。
如果是 `undici UNAVAILABLE`：在 profile 的 patch 里给 `host-egress` 加 `config.undiciPath: /usr/local/pnpm-global/store/v11/links/@/undici/8.11.2/540de117f520e26eb366da359d3efedef88ef85230031e43dab3cd8a442720f9/node_modules/undici/index.js`。此时代理出口的请求会失败（不会直连），direct 不受影响。

5. 数据目录 `/root/.dsh/egress/` 由插件首次启动创建（0700），`config.json` 在第一次保存时创建（0600）。不用手工建。

### 回滚

任何一步都可逆，且不碰 DSH 本体：

```bash
cd /root/.dsh/profiles/web
cp package.json package.json.before-rollback
# 从 package.json 删掉 dependencies 里的三行 dsh-*egress，并从 dsh.profile.bundles 去掉 "dsh-egress"
# （或直接恢复安装脚本做的备份： cp package.json.bak-install-<时间> package.json ）
rm -f node_modules/dsh-egress node_modules/dsh-host-egress node_modules/dsh-client-ui-egress   # 只是软链
systemctl restart dsh-web      # 钩子随进程消失，所有请求恢复原生 fetch
# 可选：mv /root/.dsh/egress /root/.dsh/egress.removed ；rm -rf /srv/dsh-egress
```

停用插件但不重启 dsh-web，钩子仍然在、仍按最后一次配置执行（这是设计，见安全设计第 2 条）。

## 6. 上线后真机验收

在浏览器里打开 `https://<server>:8443/`，侧栏出现「出口」。

1. **状态条**显示「即时生效」，右上角没有「示例数据」徽标；绑定表里有 `api.commandcode.ai [commandecode] → direct（跟随默认）`。
2. 点 **direct 的「探测」**：记下出口 IP，应该是服务器公网 IP（阿里云）。
3. 「添加出口」配一个可用的代理（http/https/socks5 任一），点它的「探测」：显示的 IP 应该是**代理的出口 IP，与第 2 步不同**。
4. 把 `api.commandcode.ai` 的下拉选成这个出口。发一条模型消息，应正常回复；展开「最近请求」，应看到 `api.commandcode.ai → <出口名> 成功`。可在代理侧日志再确认该连接确实到了代理。
5. **停掉代理**（或在代理主机上封掉来源），再发一条模型消息：应得到包含 `Egress "<出口名>" … could not carry the connection to api.commandcode.ai … not retried directly` 的错误，而不是正常回复；最近请求里是红点失败。可用 `ss -tnp | grep 443` 或 `tcpdump -nn host <commandcode 的 IP>` 确认服务器没有发起到 commandcode 的直连。
6. 恢复代理，重发，应恢复正常，全程没有重启 dsh-web。
7. 把绑定改回 `direct`，再探测/发消息，应恢复直连。
8. （可选）让 agent 调用 `egress_status`，输出里应只有脱敏 URL（`***:***@`）。
9. （可选）`stat -c '%a %n' /root/.dsh/egress /root/.dsh/egress/config.json` 应为 `700` / `600`。

失败排查：状态条显示「需重启 dsh-web」说明钩子没生效（刚装完没重启，或被别的代码覆盖了 `globalThis.fetch`）；显示红色「找不到 undici」按上面第 4 步处理；显示「配置文件无法读取」则所有非本机请求被拦截，修好或删除 `config.json`（插件会先把坏文件改名成 `config.json.corrupt-<时间>` 再写新的）。

## 7. 本机验证（已执行）

- `node scripts/build.mjs` 一条命令：宿主 `tsc` 编译（同时是类型检查）→ 客户端 `tsc --noEmit` → 声明 → 打包 → Node 入口 → 宿主测试，结果 `build ok`。
- 宿主测试 29 项（`packages/host-egress/tests`）：校验与脱敏、配置损坏、出口 CRUD、绑定与默认出口、探测只打固定端点、环形日志只留 100 条且不含机密、真实本机 CONNECT 代理 / SOCKS5（含认证）/ HTTPS 目标、代理关闭后失败且不直连、两主机两出口并即时切换、POST 体与 Request 对象经代理、钩子幂等。
- 界面预览：`npm`-free，`node scripts/build-preview.mjs && node scripts/serve-preview.mjs`，端口 4791。参数 `theme=dark|lang=en|form=new|edit|probe=ok|fail|both|log=open|mode=restart|bridge=down|width=<px>`。
- 截图在 `docs/screenshots/`：出口列表与探测（`01`）、新增表单（`02`）、编辑表单（`03`）、绑定表（英文，`04`）、深色（`05`）、需重启状态条 + 示例数据徽标（`06`）、窄屏（`07`）。

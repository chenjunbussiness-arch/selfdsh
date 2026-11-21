# 研究：DSH 0.2.2-rc.3/rc.5 模型请求出口

结论先行：**可以在插件里按目标主机为模型请求选出口，且绑定修改即时生效（不用重启 dsh-web）**。方案是在插件激活时包装 `globalThis.fetch`。第一次装插件要重启一次 dsh-web（由 lead 部署时做）。

证据均来自服务器 <服务器IP> 的只读探测（`ssh ... 'cat -n/grep -n'`），没有写任何文件、没有重启服务。路径缩写：

- `STORE` = `/usr/local/pnpm-global/store/v11/links`
- `PIAI` = `$STORE/@earendil-works/pi-ai/1.5.2/bcd6f785…/node_modules/@earendil-works/pi-ai`
- `ADAPTER` = `$STORE/@deepseek-ai/dsh-llm-pi-ai/0.2.2-rc.5/aa41e84c…/node_modules/@deepseek-ai/dsh-llm-pi-ai`
- `HTTPPROXY` = `$STORE/@deepseek-ai/dsh-http-proxy/0.2.2-rc.5/ff99b21a…/node_modules/@deepseek-ai/dsh-http-proxy`
- `UNDICI` = `$STORE/@/undici/8.11.2/540de117…/node_modules/undici`
- `OPENAI` = `$STORE/@/openai/7.19.0/73695c0c…/node_modules/openai`

服务器实际装的 DSH 是 **0.2.2-rc.5**（`dsh-web.service` 的 `ExecStart=/usr/local/pnpm-global/bin/dsh --profile web …`；STORE 下版本目录为 `0.2.2-rc.5`），不是本机的 rc.3。下面的结论以服务器为准，API 面（`ctx.webServer.register`、`ctx.tools.register`）与 `docs/API-0.2.2-rc.3.md` 一致。

## 1. 模型请求是怎么发出的

| 步骤 | 证据 |
|---|---|
| profile 的路由 `commandecode` 走 `@deepseek-ai/dsh-llm-pi-ai` | `/root/.dsh/profiles/web/cordis.patch.yml:13-40`，`api: openai-completions`，`baseURL: https://api.commandcode.ai/provider/v1` |
| 适配器调用 pi-ai 的 `models.streamSimple(...)`，**不传 `fetch`**，只传 headers、signal、apiKey | `ADAPTER/src/adapter.ts:475-482` |
| pi-ai 每次 `stream()` 都**新建一个 OpenAI 客户端**，把 `options?.fetch`（此处为 `undefined`）传入 | `PIAI/dist/api/openai-completions.js:187`（调用）、`:516-548`（`createClient`，`:542-547` 里 `new OpenAI({ apiKey, baseURL, dangerouslyAllowBrowser, fetch, defaultHeaders })`） |
| OpenAI SDK 在构造时取 `options.fetch ?? Shims.getDefaultFetch()` | `OPENAI/client.js:243`；`OPENAI/internal/shims.js:14-16`（`getDefaultFetch()` 返回全局标识符 `fetch`） |
| 模型发现同样直接调全局 `fetch(url, …)` | `ADAPTER/src/discovery.ts:382` |

两个关键推论：

1. 模型请求走的是 **`globalThis.fetch`**，没有 `node:https`、没有自带 agent。
2. 因为 OpenAI 客户端**每次请求重新构造**并在构造时读取当前的全局 `fetch`，插件替换 `globalThis.fetch` 后，**下一条请求就会用新的实现**，不需要重启。

## 2. 现成的代理能力

| 能力 | 结论 | 证据 |
|---|---|---|
| 按 provider 配代理的配置项 | **没有**。`llm-pi-ai` 的 provider 配置只有 `baseURL/api/apiKeyEnv/compat/models/headers` 等 | `ADAPTER/src/config.ts`、`deploy/65-piai-schema.sh` 输出 |
| 整进程代理（环境变量） | **有**。启动器在加载任何插件前调用 `installProxyFromEnvironment(options.environment, …)`，读 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`，装成 undici 全局 dispatcher | `…/@deepseek-ai/dsh/src/profile-boot.ts:286-292`；`HTTPPROXY/src/install.ts:199-248,322-330` |
| 环境变量的取值只在启动时读一次 | 改了要重启 dsh-web 才生效 | 同上（只在 boot 时调用） |
| 环境变量能否用 SOCKS | **不能，且会静默直连**：SOCKS 值被「报告并跳过，该 scheme 直连」 | `HTTPPROXY/src/policy.ts:154-161`（`names a SOCKS proxy … connecting directly for that scheme`） |
| 回环地址永远直连、`NO_PROXY` 可绕过 | 是 | `policy.ts:33,257-266,338-343` |
| 自定义 fetch/agent 注入点 | 适配器层**没有**；SDK 层 `new OpenAI({fetch})` 有，但适配器不暴露 | `ADAPTER/src/adapter.ts:475-482` 不传 fetch |
| 服务当前环境里的代理变量 | **无**（`/proc/<dsh-web pid>/environ` 里没有任何 `*PROXY*`） | 探测输出：只有 `NODE_PATH=…` |

「环境变量」方案对本需求有两个硬伤：一是 SOCKS 会悄悄直连（违反 fail-closed）；二是整进程统一、必须重启。所以不用它。

## 3. Node 与原生代理支持

- 服务器 `node -v` = **v24.22.3**（`/usr/local/bin/node`），内置 undici 7.30.2（`process.versions.undici`）。
- `node --help` 显示 `--use-env-proxy`（等价 `NODE_USE_ENV_PROXY=1`，解析 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY`），`process.allowedNodeEnvironmentFlags.has('--use-env-proxy') === true`。它同样只在进程启动时读环境，只认 http/https 代理，且不读 `ALL_PROXY`（`HTTPPROXY/src/install.ts:270-278`）。结论同上：不适合。
- 本机（仅用于开发测试）node v24.16.0，undici 7.25.0。

## 4. 插件里能不能自己挑出口

可以，条件都满足：

1. **有可用的 undici 8.11.2**。它是 `@deepseek-ai/dsh-http-proxy` 的依赖，已在 STORE 里；从 `/srv/...` 或 profile 目录用 CJS `require` 解析时可通过 dsh-web 进程的 `NODE_PATH` 命中：`createRequire('/srv/dsh-router-b/packages/host-router/lib/index.js').resolve('undici')` → `$UNDICI/index.js`；**去掉 `NODE_PATH` 后解析失败**（ESM `import 'undici'` 与普通 Node 解析都不会命中）。因此插件必须用 `createRequire(import.meta.url)` 加载 undici，并留一个 `undiciPath` 配置项做兜底。**不需要往服务器装任何包。**
2. **undici 8.11.2 导出了 `ProxyAgent`、`Socks5ProxyAgent`、`Agent`、`fetch`**（探测：`Dispatcher,Agent,Dispatcher1Wrapper,ProxyAgent,Socks5ProxyAgent,EnvHttpProxyAgent,…,fetch`）。
   - http/https 代理：`ProxyAgent`（`UNDICI/lib/dispatcher/proxy-agent.js:113-145`，`token` 选项承载 `Proxy-Authorization`）。HTTPS 目标用 CONNECT 隧道。
   - **socks5：`Socks5ProxyAgent`**（`UNDICI/lib/dispatcher/socks5-proxy-agent.js:42-86`，接受 `socks5://`/`socks://`，`options.username/password`；握手后用 `socks5Client.connect(targetHost, targetPort)` 把**域名**交给代理解析，即 socks5h 语义，`:183`）。所以 socks5 不需要额外库（服务器上没有 `socks` 包：`ls .../@/socks*` 无）。
3. **用 undici 自带的 `fetch` 配 `dispatcher`**，而不是 Node 内置 `fetch` + 外来 dispatcher。理由：Node 24 内置 fetch 捆的是 undici 7.30.2，undici 8 的 dispatcher 用另一套 handler 接口（`UNDICI/lib/dispatcher/dispatcher1-wrapper.js` 就是为此存在）。启动器自己是把 8.x 装成全局 dispatcher 让内置 fetch 去用，这依赖跨版本包装；本插件走同一个 undici 的 `fetch`，避开这层不确定性。
4. **每个出口一个 dispatcher，缓存并在编辑/删除时关闭**；按目标主机选 dispatcher，即「按 provider（目标主机）独立出口」。

### 覆盖面与已知做不到的路径

| 路径 | 是否被覆盖 | 说明 |
|---|---|---|
| OpenAI-completions 模型请求（commandcode） | **是** | 全局标识符 `fetch`，见 §1 |
| 模型发现 `discovery.ts:382` | 是 | 同上 |
| 其它走 `globalThis.fetch` 的调用（MCP over HTTP、web 搜索若用全局 fetch 等） | 是，按目标主机路由 | 未绑定主机走「默认出口」 |
| `web-fetch-http` | **不保证** | 自己 `import('undici')` 并读 `proxyRouteFor`（`HTTPPROXY/README.md`「Writing a new outbound call」） |
| `bedrock-converse-stream`（AWS SDK，`node:http2`） | **否** | 当前部署没有用 |
| 子进程（bash 工具）里的 curl/git/pnpm | **否** | 不是本插件范围 |
| 在本插件之前就把 `globalThis.fetch` 存进局部变量的代码 | 否 | 当前没发现；`GET /state` 的 `apply.hookActive` 会报告钩子是否被覆盖（被覆盖时状态条改成「需重启 dsh-web」） |
| Worker 线程 | 否 | 有自己的 `globalThis` |

## 5. 结论矩阵

| 能力 | 方式 | 是否即时 | 评价 |
|---|---|---|---|
| **按 provider/目标主机独立出口** | 插件包装 `globalThis.fetch`，按主机挑 undici dispatcher（ProxyAgent / Socks5ProxyAgent / Agent） | **即时**（增删出口、改绑定、改默认出口都在下一条请求生效） | **选定** |
| 整进程统一出口 | `HTTPS_PROXY` 环境变量 → 启动器全局 dispatcher | 需重启 dsh-web | 否决：只支持 http/https，SOCKS 会静默直连（`policy.ts:154-161`），违反 fail-closed |
| 整进程统一出口（替代） | `NODE_USE_ENV_PROXY=1` | 需重启 | 否决：同上，且不读 `ALL_PROXY` |
| 子进程 / `node:http(s)` 直连库 / Worker 线程 | — | — | **做不到**（见 §4 表） |

**生效方式：即时。** 唯一需要重启 dsh-web 的时刻是**第一次**装/升级本插件（让插件加载并安装钩子）。界面状态条显示「即时生效」；如果钩子被别的代码覆盖（`globalThis.fetch !== 我们的包装`）或没装上，状态条改成红色「需重启 dsh-web」并给出命令提示 `systemctl restart dsh-web`（只提示，插件自己不重启）。

## 6. fail-closed 设计要点（由研究推出）

- 钩子**永远安装**（只依赖 `globalThis.fetch` 存在），undici 惰性加载。undici 加载失败时，绑定到非直连出口的请求直接报错，不回退。
- 选中的出口不通、出口被删、绑定指向不存在的出口、配置文件损坏：一律抛 `EgressError`，**不调用原始 fetch**。
- 只有两种情况会直连：目标是回环地址（`localhost`、`127.0.0.0/8`、`::1` 等，与 `policy.ts:257-266` 同一规则，否则插件自己的 Web UI/桥会绕一圈）；或者该目标的有效出口是 `direct`（用户明确选择，或默认出口保持初始值 `direct` 的未绑定主机）。
- 插件被停用/热卸载时钩子**保留**（继续按最后一次配置执行），避免「停用插件 = 悄悄直连」。要彻底撤销必须重启 dsh-web，见 `EGRESS.md` 回滚。
- 用户中止请求（`AbortError`）原样抛出，不包装；其它失败包装成带出口名的 `EgressError`，错误消息含 `connection`，让 `dsh-llm-retry` 按网络错误处理（仍然经同一出口重试，不会换成直连）。

## 7. 插件骨架依据

- 宿主半边注册 HTTP 路由：`ctx.inject(['webServer'], webCtx => webCtx.webServer.register(route))`，`route = { kind:'exact', path, handler(req,res) }`（照抄 `dsh-router-b/packages/host-router/src/index.ts:1202-1211` 与 `bridge.ts` 的 `createRoutes`；`dsh-host-webserver/src/index.ts:52-58,445`）。
- 工具：`ctx.tools.register({ name, description, parameters, output:{schema,render}, execute })`，缺 `output` 会 TypeError（`docs/API-0.2.2-rc.3.md` §17、第 1231 行）。
- DSH 家目录：`DSH_HOME` 环境变量或 `~/.dsh`（`docs/API-0.2.2-rc.3.md:905-925`）。服务器 `/root/.dsh`、`/root/.dsh/router` 都是 0755 root，新建 `/root/.dsh/egress` 用 0700。
- 服务器上 profile `web` 已把 router 以 `link:/srv/dsh-router-b` 形式挂入（`/root/.dsh/profiles/web/package.json:5-14`），本插件照同样方式挂 `/srv/dsh-egress`。

## 8. 探测端点的选择

任务里建议的 `https://api.ipify.org?format=json` 在服务器上不可用：只读探测 `curl -m 8` 得到 `api.ipify.org` → `Connection refused`（18 ms），`api64.ipify.org` → 8 秒超时。同一台服务器上 `https://ifconfig.me/ip` 返回 200（0.71 s），`https://ipinfo.io/ip` 返回 200（0.89 s）。因此固定端点是 **`https://ifconfig.me/ip`**（纯文本 IP），写死在 `host-egress/src/dispatch.ts` 的 `PROBE_URL`，桥的探测接口只读取 `id`，没有任何 URL 字段。

## 9. 本机验证（对应的测试）

在本机用 node 起真实的 HTTP CONNECT 代理、SOCKS5 服务和 HTTPS 目标（`packages/host-egress/tests/helpers.mjs`），测试用 undici 8.11.2（与服务器同版本）：

- 请求经过代理：代理收到 `CONNECT 127.0.0.1:<port>`，直连用的 fetch 间谍从未被调用；
- 关掉代理或指向关闭端口后，请求抛 `EgressError`，目标服务器命中数不变（没有直连）；
- 绑定指向不存在的出口、配置文件损坏、undici 加载失败，三种情况同样拒绝；
- socks5：代理收到的是域名 `localhost`（atyp=3），即由代理解析；带用户名密码的 SOCKS5 也通过，密码错误时失败且错误信息不含密码。

注意：本机 Node 24.16 / undici 7.25 的内置 fetch 没有被测试使用，测试和服务器上的插件都走 undici 8.11.2 自带的 `fetch`。

# dsh-vpn

在阿里云服务器上管理「连内网 git 用的 VPN」。底层是 openfortivpn，只让用户列出的目标走隧道，永不改默认路由。连接和断开只能由人在 Web 页面上做，给 agent 的工具只有只读的 `vpn_status`。

## 1. 架构

```
浏览器 ──https:8443(nginx)──▶ dsh-web-gate:42444 ──▶ dsh web:42443
                                                       │  ctx.webServer.register
                                                       ▼
 client-ui-vpn (main 面板 "VPN" + 侧栏行)  ◀──fetch──▶  /api/vpn/*  (host-vpn bridge.ts)
                                                       │
                                  ProfileStore ────────┤  <DSH home>/vpn/{profiles.json, secrets/<id>, run.json}
                                  VpnManager ──────────┘  spawn(openfortivpn …) + ip route add + 看门狗
                                                          agent 工具: vpn_status（只读）
```

| 路径 | 作用 |
|---|---|
| `package.json` / `cordis.patch.yml` | bundle 清单，挂两行：`host-vpn`、`client-ui-vpn` |
| `packages/host-vpn/src` | `validate.ts` 输入校验，`redact.ts` 脱敏，`store.ts` 存储，`forti.ts` openfortivpn 参数/日志解析/换 cookie，`guard.ts` 路由保护，`manager.ts` 进程+状态机+看门狗，`bridge.ts` HTTP 桥，`index.ts` 激活 |
| `packages/client-ui-vpn/src/client` | `VpnPage.tsx`、`ProfileForm.tsx`、`source.ts`（HTTP + 示例数据回退）、`styles.ts`（`dshv-` 前缀） |
| `scripts/build.mjs` / `install.mjs` | 一条命令构建并跑测试；幂等的 profile 安装器 |

约定与 dsh-router-b 一致：bundle 无 `peerDependencies`；两个子包运行时不 import 任何 `@deepseek-ai/*`；不碰 `rightbar`；入口是 `sidebar.panellist` 行 + keyed `main` 面板。

### 进程管理：普通子进程，不用 systemd transient unit

选 `child_process.spawn`。理由：隧道随插件销毁而断开（`ctx.effect` 的 disposer 会 SIGTERM 子进程），一个切断服务器自身访问的隧道不应该在 DSH 之外继续存活。代价是 DSH 被 `kill -9` 时子进程会遗留，所以：

- 每次启动子进程都写 `run.json`（pid、命令名标记、profile id，0600）。
- 插件激活时 `recover()`：pid 已死则清理文件；pid 存活且 `/proc/<pid>/cmdline` 含 `openfortivpn` 才 SIGTERM（再 SIGKILL）；pid 被别的进程复用则不动。
- 遗留进程是「清理」而不是「接管」：新进程拿不到旧子进程的管道和看门狗上下文，接管一个无法监视的隧道不安全。
- 路由用 `ip route add … dev <ppp>`，加在隧道接口上。接口消失时内核自动删除这些路由，所以崩溃后没有残留路由。

## 2. 安全设计

1. **永不改默认路由。** 每个计划都带 `--no-routes`，不带 `--half-internet-routes`。隧道起来（日志出现 `Tunnel is up and running`）后，插件自己只对用户目标执行 `ip route add`。
2. **DNS 不动。** 默认 `--set-dns=0 --pppd-use-peerdns=0`，不会写 `/etc/resolv.conf`；只有 profile 里明确勾选「让 VPN 改写 resolv.conf」才改。主机名目标在连接前用当前解析器解析成 IP 再加路由；解析不了就报错，建议直接写 IP。
3. **目标校验**（`validate.ts`）：拒绝 `0.0.0.0`、`0.0.0.0/0`、`::`、`::/0`、`default`、`localhost`，IPv4 前缀短于 /8、IPv6 前缀短于 /16 一律拒绝（`0.0.0.0/1` + `128.0.0.0/1` 这类等价写法也被拒），`0.x.x.x` 拒绝；列表为空拒绝连接。
4. **路由保护**（`guard.ts`）：连接前读 `ip -4 route`，保护默认网关、本机源地址、127.0.0.1、看门狗公网探测地址、VPN 网关自身。目标若会按最长前缀抢走这些地址，直接拒绝并说明原因。本机现状的路由表下，`<默认网关>/32`、`<内网地址>/32`、`223.5.5.0/24` 都会被拒（测试覆盖）。
5. **看门狗。** 路由加完立即比较默认路由（只比 `via` 和 `dev`，忽略 DHCP 的 metric 变化）。之后 `watchdogSeconds`（默认 30）内每 2 秒检查一次：默认路由不变；`127.0.0.1:42443`（DSH 本机）可连；`223.5.5.5:53`（公网，走原默认路由）可连。连续两次探测失败或默认路由变化就自动断开，状态变 `failed`，原因写进日志和状态。窗口结束后进入 `passed`，只保留低频（15 秒）的默认路由检查。
   - 说明：插件看不到「外部来的 SSH 包能否回包」，所以用上面三项作代理指标。它们覆盖了「默认路由被改」「本机服务不通」「出公网不通」三种会让 SSH 失联的情形。第二层保险见 §6：连接前自己保持一条备用 SSH 会话。
6. **注入防护。** 所有外部命令（`openfortivpn`、`ip`）都是 `spawn(argv[])`，没有 shell。拒绝换行、NUL、C0 控制字符；会成为命令行值的字段拒绝以 `-` 开头；host 必须是主机名或 IP；port 1–65535；realm 限字符集；证书指纹必须是 64 位十六进制。密码和 token 从不进入 argv：密码写 0600 的临时配置文件（`-c`，进程退出后删除），cookie 走 stdin（`--cookie-on-stdin`）。
7. **机密存储。** 没有用 `ctx.credentials`：该服务是模型 key 的存储（`.credentials.yaml`，API 文档明确要求不要手写），且 rc.3 事实核定里没有确认 Host 侧可读回值的接口。机密放 `<DSH home>/vpn/secrets/<profile id>`（目录 0700，文件 0600，原子写）。所有读接口只返回 `secretConfigured: true/false`；`ProfileStore.readSecret` 只有连接管理器调用。界面输入框是 `type=password`、`autocomplete=new-password`，编辑时不预填，保存后清空。如果以后确认 `ctx.credentials` 可读，换 `SecretStore` 的实现即可（接口 4 个方法）。
8. **日志脱敏。** 写入环形缓冲（200 行）前过 `redact()`：已知机密（密码、整条 URL、URL 的每个 query 值、cookie）的原文、URL 编码和全字节百分号编码变体都替换成 `***`；另有 `SVPNCOOKIE=`、`token=`、`password = …`、`Authorization:` 等模式兜底。HTTP 错误体不含底层异常文本。
9. **HTTP 桥。** 写操作要求 `Content-Type: application/json`（跨站请求必须预检）；带 `Origin` 头时其 host 必须等于请求的 `Host`/`X-Forwarded-Host`，否则 403；请求体上限 32 KiB。所有路径位于 nginx Basic 认证之后。
10. **agent 只读。** 工具 `vpn_status` 无参数，输出状态、profile 名、接口、隧道 IP、运行时长、走隧道的目标、最近错误、看门狗状态、openfortivpn 是否安装。不含任何机密，也没有连接/断开工具。
11. **自定义命令默认关闭**（`allowCustomCommand: false`），开启后界面才出现该类型。

## 3. Profile 字段

| 字段 | 说明 |
|---|---|
| `id` | 服务端生成，`p-xxxxxxxx` |
| `name` | 必填，唯一，≤64 字符 |
| `type` | `password` / `token-url` / `custom` |
| `host`、`port` | 网关。`token-url` 由 URL 解析得到 |
| `username`、`realm` | 仅 `password` |
| `trustedCert` | 网关证书 sha256（64 位十六进制，可带冒号），可选 |
| `targets` | 走隧道的 CIDR / IP / 主机名，必填，≤64 条，去重 |
| `setDns` | 是否允许 VPN 改写 resolv.conf，默认 `false` |
| `command` | 仅 `custom`：argv 数组，第一项为绝对路径，`{url}` 会替换为存储的链接 |
| `secretConfigured` | 只读，机密是否已设置 |
| 写入专用 `secret` | 密码或 URL，只出现在 PUT 请求里 |

## 4. 两种认证的实际实现与限制

### password

生成 0600 临时配置文件（`host/port/username/password/realm/trusted-cert`），执行 `openfortivpn -c <file> --no-routes --set-dns=0 --pppd-use-peerdns=0`，退出后删除文件。密码不进 argv，`ps` 里看不到。openfortivpn 没有「密码走 stdin」的选项，所以用配置文件。

限制：不支持 OTP / 两步验证；密码首尾不能有空白（openfortivpn 会截掉）。

### token-url（形如 `https://host:port/path?token=xxx`）

核实结果：openfortivpn 的 `--cookie=<SVPNCOOKIE>` 与 `--cookie-on-stdin` 存在于 1.18 起的版本（已对照 1.20.0 的 `main.c` 和手册）。`--cookie` 要的是会话 cookie，不是 token 本身，所以实现为一个可审计的小步骤（`forti.ts: fetchCookie`）：

1. 只对用户保存的那一个 URL 发一次 HTTPS `GET`（TLS 套接字上手写请求，没有 agent、没有代理变量、没有重定向处理）。
2. 只读响应头，取 `Set-Cookie: SVPNCOOKIE=…`。收到 3xx 视为失败，不跟随，所以 token 不可能被发到别的主机。
3. cookie 通过 `--cookie-on-stdin` 交给 openfortivpn，不进 argv。cookie 和 URL 都进脱敏名单。
4. TLS：默认正常校验。填了 `trustedCert` 时跳过链校验，只接受 sha256 与之相等的证书（与 openfortivpn 的规则一致）。

限制，需要上线时用真网关确认：

- 这一步假设该 URL 是「GET 一次就返回 `Set-Cookie: SVPNCOOKIE`」的登录/授权链接。没有真实网关可测，单元测试只覆盖响应头解析和失败路径。如果实际链接是一个 SAML 或浏览器交互页，拿不到 cookie，界面会报「网关没有返回 SVPNCOOKIE」，不会硬编。
- Ubuntu 22.04 自带 openfortivpn 1.17.1，**没有** `--cookie-on-stdin`。检测到版本太旧时界面提示并拒绝连接。需要 token 链接时升级到 ≥1.18。
- 替代方案：`custom` 命令类型（见下），由用户自己负责。

### custom（替代方案，默认关闭）

`allowCustomCommand: true` 后可用。profile 里写 argv 数组（首项为绝对路径），任意参数里的 `{url}` 替换成保存的链接（机密，同样脱敏）。插件负责起停、日志脱敏、看门狗和目标路由（只有日志里出现接口名 `ppp0` 之类时才加路由，否则不加并在日志里说明）。命令本身做什么、会不会改默认路由由写命令的人负责；看门狗仍会在默认路由变化时断开它。

## 5. 服务器侧前置条件

已探测到的服务器事实（只读）：Ubuntu 22.04.5，内核 5.15，root，`/dev/ppp` 存在，**未安装 openfortivpn，也没有 pppd**，apt 候选 `openfortivpn 1.17.1-1build1`。默认路由 `via <默认网关> dev eth0`，Node v24。

```bash
apt-get update && apt-get install -y openfortivpn ppp     # password 类型够用（1.17.1）
# token 链接需要 >= 1.18：从源码构建（需要 gcc automake autoconf libssl-dev make pkg-config）或用更新的包
openfortivpn --version && ls -l /usr/sbin/pppd
```

权限：需要 root（起 pppd、`ip route add`），服务器本来就是 root。DSH 的 systemd 服务（`dsh-web`）如果设了 `ProtectSystem`/`NoNewPrivileges`/`CapabilityBoundingSet`，需要确认它允许 `NET_ADMIN` 和写 `/dev/ppp`；当前 unit 以 root 运行，上线验收第 3 步会暴露这类问题。

DSH 把 profile 数据写在 `$DSH_HOME/vpn`（未设时 `~/.dsh/vpn` → `/root/.dsh/vpn`）。目录由插件首次激活时创建（0700）。

## 6. 给 lead 的部署清单

**不在本机做的事**：下面的步骤都是服务器操作，本任务没有执行任何一步（也没有重启或修改服务器）。

0. 前置：确认 nginx 对 `:8443` 的 Basic 认证确实在位（仓库里的 `deploy/nginx-dsh-web.conf` 注释写着当前未加 `auth_basic`，而 ACCESS.md 写有 Basic）。VPN 写接口依赖这层保护。
1. 开一个备用 SSH 会话保持不要关，再做后面的事。
2. 装前置（§5），装完 `openfortivpn --version` 确认。
3. 拷贝源码到服务器（不要带 `node_modules`、`preview/dist`、`docs/screenshots` 之外的本机产物；`lib/` 要带，服务器不需要编译器）：
   ```powershell
   # 本机先构建
   node E:\PythonProject\dsh-netops\vpn\scripts\build.mjs
   # 打包并上传（排除 node_modules、预览产物、tsbuildinfo）
   cd E:\PythonProject\dsh-netops
   tar --exclude=node_modules --exclude=preview/dist --exclude='*.tsbuildinfo' --exclude=tests -czf $env:TEMP\dsh-vpn.tgz vpn
   scp -i C:\Users\13558\.ssh\ali-zzl-harness.pem $env:TEMP\dsh-vpn.tgz root@8.134.170.38:/tmp/
   ```
   ```bash
   mkdir -p /srv/dsh-vpn && tar -xzf /tmp/dsh-vpn.tgz -C /srv/dsh-vpn --strip-components=1
   ```
4. 安装到 profile（改 `/root/.dsh/profiles/web/package.json` 并建三个 node_modules 链接，会先留 `.bak-install-<时间戳>`）：
   ```bash
   cd /srv/dsh-vpn
   node scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run
   node scripts/install.mjs --profile /root/.dsh/profiles/web
   ```
   它做的事等价于：`package.json` 的 `dependencies` 加
   ```json
   "dsh-vpn": "link:/srv/dsh-vpn",
   "dsh-host-vpn": "link:/srv/dsh-vpn/packages/host-vpn",
   "dsh-client-ui-vpn": "link:/srv/dsh-vpn/packages/client-ui-vpn"
   ```
   `dsh.profile.bundles` 追加 `"dsh-vpn"`（与 `dsh-router-b` 并列）。`cordis.patch.yml` 不需要在 profile 里手写：bundle 自带（`dsh.bundle.patch`）。要调参数，在 profile 的 `cordis.patch.yml` 里用 id 覆盖：
   ```yaml
   - id: host-vpn
     name: dsh-host-vpn
     config:
       watchdogSeconds: 30
       allowCustomCommand: false
   ```
   安装器不跑 pnpm，不碰其它 bundle。
5. 重启 `dsh-web`（由 lead 决定时机）：`systemctl restart dsh-web`。
6. 看日志（`/var/log/dsh-web.log`）应有：
   `host-vpn: no leftover tunnel`、`host-vpn: HTTP bridge mounted at /api/vpn (...)`、`host-vpn: store /root/.dsh/vpn, watchdog 30s, ...`。
7. 回滚（任选）：
   ```bash
   node /srv/dsh-vpn/scripts/install.mjs --profile /root/.dsh/profiles/web --uninstall   # 去掉三条依赖、bundles 里的 dsh-vpn、三个链接
   # 或手工：从 package.json 的 dsh.profile.bundles 删掉 "dsh-vpn"，再 cp 回 package.json.bak-install-<时间戳>
   systemctl restart dsh-web
   ```
   隧道会随 dsh-web 停止被 SIGTERM。保险起见回滚后执行 `pgrep -a openfortivpn`（应为空）和 `ip route`（应与 §5 一致）。`/root/.dsh/vpn` 可保留，也可以 `rm -r` 掉（含机密文件，确认不再需要再删）。

## 7. 上线后真机验收

先决条件：已装 openfortivpn，lead 拿到一个测试网关的 host/port/账号（或 token URL）和一个只在内网可达的目标 IP。保持另一条 SSH 会话。

1. 打开 `https://8.134.170.38:8443/`，侧栏有「VPN」，页头**没有**「示例数据」徽标。
2. 未装 openfortivpn 时，状态卡显示「服务器上没有安装 openfortivpn」和安装命令，连接按钮不可点。
3. 新建 `password` profile，目标填内网目标 IP（先不用主机名）。保存后：密码框清空；`curl -s localhost:42443/api/vpn/profiles`（带 DSH 的 token cookie）的返回里只有 `secretConfigured: true`；`stat -c '%a %n' /root/.dsh/vpn /root/.dsh/vpn/secrets/*` 为 `700` 和 `600`。
4. 记录基线：`ip route`、`cat /etc/resolv.conf`、`md5sum /etc/resolv.conf`。
5. 点「连接」：状态依次为连接中 → 已连接；看门狗显示观察中 → 已通过。立刻检查：
   - `ip route` 只多出你列的目标，`default via <默认网关> dev eth0` 不变；
   - `/etc/resolv.conf` 的 md5 不变；
   - 备用 SSH 会话仍然响应，`curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:42443/` 正常；
   - `ping -c1 <内网目标>` 通，`git ls-remote <内网仓库>` 通；
   - `ps aux | grep -c [o]penfortivpn` 不是 0；`ps` 的参数里没有密码；`ls /root/.dsh/vpn` 里的 `run-*.conf` 存在（连接期间）。
6. 日志面板里搜不到密码或 token 的原文，应只见 `***`。
7. 让 agent 调 `vpn_status`：输出状态，没有机密，也没有连接类工具可用。
8. 点「断开」：状态回到未连接，新增路由消失，`run.json` 与 `run-*.conf` 被删，`pgrep openfortivpn` 为空。
9. 看门狗实测（可选，在备用会话里做）：连接后 `ip route replace default dev ppp0`——注意这会让服务器失联，不要在没有云控制台（VNC）兜底时做。更安全的替代：把 `localProbePort` 临时配成一个没人监听的端口再重启，连接后应在约 4–6 秒内自动断开并报「cannot reach the local DSH service」。
10. `kill -9` DSH 主进程后重启 `dsh-web`，日志应出现 `stopped leftover openfortivpn (pid …)`。
11. 用 token URL 类型重复 5–8（需要 openfortivpn ≥ 1.18）。

## 8. 本机验证记录

- `node scripts/build.mjs`：host `tsc -b` 干净、client `tsc --noEmit` 干净、client 打成 `lib/client.js`（只 `require` `react` 和 `react/jsx-runtime`，不含 `rightbar` 与任何 `@deepseek-ai` 导入）、host 测试 32/32 通过。
- 测试用 `tests/fixtures/fake-openfortivpn.mjs` 冒充 openfortivpn（输出典型日志行、退出码、stdin cookie），`ip` 与探测用假实现；不连网、不改路由。
- 预览：`npm run preview`（端口 4790）。截图在 `docs/screenshots/`。

# dsh-vpn：VPN 管理

## 这是什么

在运行 DSH 的 **Linux 服务器**上管理一条 FortiGate SSL VPN（底层是 `openfortivpn`），用来访问内网 git 等资源。

它只做**分流**：只有你列出的目标网段 / 主机走隧道，**永远不改默认路由、默认不改 DNS**，并带一个看门狗——隧道一旦影响到服务器自身的网络（默认路由变了、本机 DSH 或公网不通），就自动断开，避免把服务器“锁死”。连接和断开只能由人在页面上操作。

## 装好后在哪里看到

- **左侧栏多一行「VPN」**，点开主区域的 VPN 页面：配置列表（新建 / 编辑 / 删除）、连接 / 断开按钮、当前状态（接口、隧道 IP、在线时长、走隧道的目标）、看门狗状态、脱敏后的运行日志。
- **对模型开放的工具**：`vpn_status`（只读：是否已连接、用哪个配置、隧道地址、在线时长、走隧道的网段、最近错误、看门狗状态、`openfortivpn` 是否已安装）。它不能连接或断开，也不会显示密码或 token。
- 宿主侧接口：`/api/vpn/*`（status / profiles / profile / connect / disconnect / logs，需要已登录 Web）。

## 必须配置

1. **服务器上装好 `openfortivpn` 和 `ppp`，并以 root 运行 DSH**（要起 pppd、执行 `ip route add`）：

   ```bash
   apt-get update && apt-get install -y openfortivpn ppp
   openfortivpn --version && ls -l /usr/sbin/pppd
   ```

   - 用「账号密码」方式：Ubuntu 22.04 自带的 1.17.1 就够。
   - 用「token 链接」方式：需要 **openfortivpn ≥ 1.18**（要 `--cookie-on-stdin`），自带版本太旧时页面会提示并拒绝连接。
   - 不装的后果：页面显示「服务器上没有安装 openfortivpn」并给出安装命令，无法连接；`vpn_status` 报 `openfortivpn: not installed`。

2. **在 VPN 页面里新建一个配置**（不用改任何文件）：

   | 字段 | 示例 | 说明 |
   |---|---|---|
   | 名称 | `内网 git` | 必填，唯一 |
   | 类型 | `password` 或 `token-url` | 账号密码，或一条 `https://网关:端口/路径?token=…` 链接 |
   | 网关 / 端口 | `vpn.example.com` / `443` | `token-url` 类型从链接里自动解析 |
   | 用户名、密码、realm | — | 仅 `password` 类型 |
   | 走隧道的目标 | `10.20.0.0/16`、`git.corp.example` | **必填**，最多 64 条；不能写 `0.0.0.0/0`、`default` 这类会抢默认路由的目标 |
   | 网关证书 sha256 | 64 位十六进制 | 可选，自签证书时填 |

   密码 / token 保存在 `<DSH home>/vpn/secrets/<配置 id>`（文件 0600），之后页面上只显示“已设置”，不会回显。

## 可选配置

写在 profile 的 `<profile>/cordis.patch.yml` 里，按 id `host-vpn` 覆盖（覆盖时整段 `config` 会被替换，想保留的键要一起写上）：

```yaml
- id: host-vpn
  name: dsh-host-vpn
  config:
    watchdogSeconds: 30
    localProbePort: 42443
    publicProbe: 223.5.5.5:53
    allowCustomCommand: false
    recoverOnStart: true
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `dir` | `<DSH home>/vpn` | 配置和密钥存放目录（0700）。`<DSH home>` = `DSH_HOME`，没设时是 `~/.dsh` |
| `openfortivpn` | `openfortivpn` | 可执行文件路径，或一个命令前缀数组 |
| `watchdogSeconds` | `30` | 隧道建立后密集检查的时长（5～600 秒），之后改为每 15 秒只检查默认路由 |
| `localProbePort` | `42443` | 看门狗要确认仍能连通的本机 DSH Web 端口。**改过 DSH 端口时必须同步改** |
| `publicProbe` | `223.5.5.5:53` | 看门狗要确认仍能经原默认路由连通的公网地址 |
| `allowCustomCommand` | `false` | 开启「自定义命令」配置类型（命令本身的安全性由写命令的人负责） |
| `recoverOnStart` | `true` | 启动时清理上次遗留的 openfortivpn 进程 |

## 安装与更新

```bash
# 1. 构建（宿主侧编译 + 浏览器侧 lib/client.js + 测试）
node scripts/build.mjs

# 2. 装进 profile（幂等；先 --dry-run）
node scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run
node scripts/install.mjs --profile /root/.dsh/profiles/web

# 3. 重启 DSH
```

重启后日志里应出现 `host-vpn: HTTP bridge mounted at /api/vpn (...)` 和 `host-vpn: store …/vpn, watchdog 30s, custom commands disabled`。

注意：停用插件或重启 DSH 会**断开隧道**（隧道不会比插件活得更久）。

## 常见问题

- **连上几秒后自动断开，状态 `failed`**：看门狗发现默认路由变了，或本机 `127.0.0.1:<localProbePort>`、`publicProbe` 连不上。看日志里的原因；改过 DSH 端口的要改 `localProbePort`。
- **保存配置时提示目标被拒**：目标会抢走默认网关、本机地址、`127.0.0.1`、公网探测地址或 VPN 网关自身的路由；IPv4 前缀短于 /8、IPv6 短于 /16 也会被拒。把目标写得更精确。
- **主机名目标解析失败**：主机名在连接前用服务器当前 DNS 解析成 IP；内网域名解析不了就直接写 IP / 网段。
- **token 链接报「网关没有返回 SVPNCOOKIE」**：这个链接不是“GET 一次就发 cookie”的类型（可能是 SAML / 浏览器交互登录），本插件不支持；可改用账号密码，或开启 `allowCustomCommand` 自己写命令。
- **提示 `installed openfortivpn is too old for token URLs`**：升级到 openfortivpn ≥ 1.18。
- **提示缺 pppd**：`apt-get install -y ppp`。
- **不支持 OTP / 两步验证**；密码首尾不能有空白（openfortivpn 会截掉）。
- **Windows / macOS 上用不了**：本插件依赖 Linux 的 `ip route` 和 pppd，只面向 Linux 服务器。
- **页面显示示例数据**：浏览器连不上 `/api/vpn/*`（插件没装好、没重启或登录过期）。

## 更多文档

- [docs/VPN.md](docs/VPN.md)：完整说明——架构、安全设计、配置字段、两种认证的实现与限制、服务器前置条件、部署与验收清单。
- `docs/screenshots/`：各状态的界面截图。

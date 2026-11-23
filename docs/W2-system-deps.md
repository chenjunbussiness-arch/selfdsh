# W2 · 系统侧依赖与网络入口 —— DSH Web 作战室移植审计

> **2026-11-23 提示**：本文写于 agent-hub / dsh-hub 加入之前（当时只有 4～5 个插件），部分数字和步骤已过时。仓库现状与安装步骤以根目录 [README.md](../README.md) 为准，全部文档目录见 [INDEX.md](INDEX.md)。

> 审计范围：仅「操作系统层面为了跑起 DSH Web GUI 额外做过的改动」。
> 审计方式：全程只读（`systemctl status/cat/show`、`ss`、`ls`、`cat`、`nginx -T`、`curl -I`），
> 未 restart / enable / disable 任何服务，未改动 unit、nginx 配置，未 reload nginx，未 kill 进程。
> 除本报告外无任何写操作。
> 主机：Ubuntu 22.04.5 LTS（jammy），kernel `5.15.0-198-generic`，hostname `iZ7xv8t4x0ib6a8rktjo0eZ`，
> 网卡地址 `<内网地址>/20`（eth0），公网入口 `<server>`（见下）。
> 审计时间：2026-11-20 15:17–15:30 CST。

**一句话结论**：这台机器上 DSH 的入口是四层叠加的
`浏览器 → https://<server>:8443 (nginx, basic auth) → 127.0.0.1:42444 (dsh-web-gate) → 127.0.0.1:42443 (dsh web, systemd)`，
链路上有 **2 个自建 systemd unit、3 个自建脚本、1 份 nginx 站点配置、1 套自签 TLS 证书、1 个 basic auth 文件**，
再加上 `/root/.dsh` 的 root 专属状态目录。这些都必须在新机器上手工复刻，`pnpm install` 不会带来。

---

## 1. systemd

### 1.1 单元清单（实际存在两个，不止任务里提到的那个）

```bash
$ systemctl list-units --all --no-pager | grep -i dsh
  dsh-web-gate.service  loaded active running DSH Web stable entry gate (127.0.0.1:42444 -> 42443)
  dsh-web.service       loaded active running DeepSeek Harness Web UI (127.0.0.1:42443)
```

> 注意：`dsh-web-gate.service` 是任务书里没提但**必不可少**的一环，见 1.3。

### 1.2 dsh-web.service

```bash
$ systemctl status dsh-web.service --no-pager
● dsh-web.service - DeepSeek Harness Web UI (127.0.0.1:42443)
     Loaded: loaded (/etc/systemd/system/dsh-web.service; enabled; vendor preset: enabled)
     Active: active (running) since Fri 2026-11-20 12:47:43 CST; 2h 29min ago
    Process: 432871 ExecStartPre=/usr/local/bin/dsh-fix-zod (code=exited, status=0/SUCCESS)
   Main PID: 432879 (MainThread)
      Tasks: 14 (limit: 4206)
     Memory: 1.7G

$ systemctl is-enabled dsh-web.service
enabled
```

主进程实际命令行（`CGroup` 段，等价于 ExecStart 展开）：

```
432879 node /usr/local/pnpm-global/bin/../global/v11/49f9775095df6513e8ea2f08355f3462023a1e0be26574192d0f5326d06d8439/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --no-open --host 127.0.0.1 --port 42443 --trusted-host <server>:8443
```

### 1.3 dsh-web-gate.service

```bash
$ systemctl status dsh-web-gate.service
● dsh-web-gate.service - DSH Web stable entry gate (127.0.0.1:42444 -> 42443)
     Loaded: loaded (/etc/systemd/system/dsh-web-gate.service; enabled; vendor preset: enabled)
     Active: active (running)
     Main PID: 319466 (MainThread)
$ systemctl is-enabled dsh-web-gate.service
enabled
```

它跑的是 `/usr/local/bin/dsh-web-gate.mjs`（179 行，`node` 直跑）。脚本头注释说明了存在理由：

> `dsh web` 每次启动都会重新生成 launch token 和 cookie 签名密钥，且没有配置项可以固定。
> 这导致任何书签里的 `?token=` URL 在每次重启后失效。gate 站在 nginx 和 dsh web 之间，
> 从日志尾部读出本次启动的 token，替未认证的浏览器补上，其余流量（流式、WebSocket、上传、
> 插件 bundle）原样转发。

所以 **42444 不是可有可无的调试端口**，换机若只搬 42443 + nginx，用户书签会在每次重启后失效。

### 1.4 unit 文件真实路径与 drop-in

```bash
$ systemctl show -p FragmentPath -p DropInPaths -p SourcePath dsh-web.service dsh-web-gate.service
FragmentPath=/etc/systemd/system/dsh-web.service
DropInPaths=
FragmentPath=/etc/systemd/system/dsh-web-gate.service
DropInPaths=

$ ls -la /etc/systemd/system/dsh-web*
-rw-r--r-- 1 root root 443 Nov 19 10:07 /etc/systemd/system/dsh-web-gate.service
-rw-r--r-- 1 root root 610 Nov 19 00:27 /etc/systemd/system/dsh-web.service

$ ls -la /etc/systemd/system/dsh-web.service.d/ /etc/systemd/system/dsh-web-gate.service.d/
ls: cannot access '/etc/systemd/system/dsh-web.service.d/': No such file or directory
ls: cannot access '/etc/systemd/system/dsh-web-gate.service.d/': No such file or directory
$ ls -la /usr/lib/systemd/system/dsh-web*
ls: cannot access '/usr/lib/systemd/system/dsh-web*': No such file or directory
```

**结论**：都是本机自建的 `/etc/systemd/system/` 单元（不是发行版包自带），**无 drop-in 目录**，
所有配置都在两个文件本体里，搬走这两个文件即可，不会漏掉覆盖项。

### 1.5 逐字段摘要

| 字段 | dsh-web.service | dsh-web-gate.service |
|---|---|---|
| Description | DeepSeek Harness Web UI (127.0.0.1:42443) | DSH Web stable entry gate (127.0.0.1:42444 -> 42443) |
| Type | simple | simple |
| User / Group | `User=root` / 未指定 Group（继承 root） | 未指定（默认 root） |
| WorkingDirectory | **未设置**（继承 `/`） | **未设置** |
| Environment | `PNPM_HOME=/usr/local/pnpm-global`；`PATH=/usr/local/pnpm-global/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin` | `GATE_PORT=42444`；`GATE_UPSTREAM_HOST=127.0.0.1`；`GATE_UPSTREAM_PORT=42443`；`GATE_TOKEN_LOG=/var/log/dsh-web.log` |
| EnvironmentFile | 无 | 无 |
| ExecStartPre | `/usr/local/bin/dsh-fix-zod` | — |
| ExecStart | `/usr/local/pnpm-global/bin/dsh --profile web --no-open --host 127.0.0.1 --port 42443 --trusted-host <server>:8443` | `/usr/local/bin/node /usr/local/bin/dsh-web-gate.mjs` |
| Restart / RestartSec | `on-failure` / 5 | `always` / 3 |
| After / Wants | `After=network-online.target` / `Wants=network-online.target` | `After=network-online.target dsh-web.service` / `Wants=dsh-web.service` |
| StandardOutput / StandardError | 均 `append:/var/log/dsh-web.log` | 未设置（走 journal） |
| [Install] | `WantedBy=multi-user.target`，enabled | `WantedBy=multi-user.target`，enabled |

**Environment 中的敏感变量**：两个 unit 的 `Environment=` 里 **没有任何 API key / token**（仅端口、路径、PNPM_HOME）。
真正带密钥的是 `/root/.dsh/.env`（600，见 4.4），由 DSH 自身读取，不经过 systemd。

**本机绝对路径清单（换机必须逐条对上）**：
`/usr/local/pnpm-global`（PNPM_HOME + dsh shim）、`/usr/local/pnpm-global/bin/dsh`、
`/usr/local/bin/dsh-fix-zod`、`/usr/local/bin/dsh-web-gate.mjs`、`/usr/local/bin/node`、
`/var/log/dsh-web.log`、`/root/.dsh`、`<server>:8443`（trusted-host，写死在命令行里）。

### 1.6 两个必须一起搬的脚本

```bash
$ ls -la /usr/local/bin/dsh-fix-zod
-rwxr-xr-x 1 root root 661 Nov 19 00:18 /usr/local/bin/dsh-fix-zod
```

内容（全文）：每次启动前把 `zod` 重新软链进 dsh-web 的依赖解析链，绕开一次 pnpm 重装后的
`Cannot find module 'zod'`：

```bash
#!/usr/bin/env bash
# Re-link zod into dsh-web's resolution chain after a pnpm reinstall.
set -uo pipefail
F=$(find /usr/local/pnpm-global/store/v11/links/@deepseek-ai/dsh-web -type f -name 'typert.host.js' 2>/dev/null | head -1)
[ -z "${F:-}" ] && { echo "dsh-web not found"; exit 1; }
NM=$(dirname "$(dirname "$(dirname "$(dirname "$F")")")")
if [ -e "$NM/zod" ]; then echo "zod already linked"; exit 0; fi
ZOD=$(find /usr/local/pnpm-global/store/v11/links/@/zod -maxdepth 5 -type d -name zod -path '*node_modules/zod' 2>/dev/null | sort | tail -1)
[ -z "${ZOD:-}" ] && { echo "no zod in store"; exit 1; }
ln -s "$ZOD" "$NM/zod"
echo "linked $NM/zod -> $ZOD"
```

> 这是**针对本机 pnpm store 布局 v11 的 workaround**，路径写死。新机器若 pnpm store 版本不同
> （`store/v11` vs `store/v10`），脚本里的路径要跟着改，否则 ExecStartPre 会 `exit 1`，服务起不来。
> 日志尾部可见它当前是幂等空跑：`zod already linked`。

`/usr/local/bin/dsh-web-gate.mjs`：6616 字节，179 行，无第三方依赖（只用 `node:fs` / `node:http`），
从 `GATE_TOKEN_LOG` 尾部 64KB 里正则抓最后一个 `token=`，其余请求原样 HTTP 代理到 `GATE_UPSTREAM_PORT`。
迁移时**整个文件复制**即可，无需 npm 安装任何东西。

### 1.7 运行时环境

```bash
$ ls -la /usr/local/pnpm-global/bin/dsh
-rwxr-xr-x 1 root root 5164 Nov 19 00:15 /usr/local/pnpm-global/bin/dsh   # sh shim，非普通软链
$ node -v ; which node
v24.22.3
/usr/local/bin/node        # -rwxr-xr-x 1 1000 1000 126891984 Nov 11 08:39（tar 解包，非 apt 包）
$ dpkg -l | grep -E '^ii\s+(nodejs|nginx)' 
ii  nginx        1.18.0-6ubuntu14.22
ii  nginx-common 1.18.0-6ubuntu14.22
ii  nginx-core   1.18.0-6ubuntu14.22
# 没有 nodejs 包 → Node 是手工装到 /usr/local/bin 的
```

Node 必须 ≥ 24（`v24.22.3`），且 `dsh` 通过 `PNPM_HOME=/usr/local/pnpm-global` 解析。
换机若把 Node 装在别处（nvm/fnm/apt），unit 里的 `PATH` 与 `Environment=` 都要改。

---

## 2. 端口与监听

```bash
$ ss -ltnp
LISTEN 0 4096  127.0.0.1:19092  0.0.0.0:*  users:(("mihomo-egress",pid=351076,fd=3))
LISTEN 0 4096  127.0.0.1:17890  0.0.0.0:*  users:(("mihomo-egress",pid=342569,fd=3))
LISTEN 0 4096  127.0.0.1:17892  0.0.0.0:*  users:(("mihomo-egress",pid=351076,fd=6))
LISTEN 0 511   127.0.0.1:42443  0.0.0.0:*  users:(("MainThread",pid=432879,fd=21))
LISTEN 0 511   127.0.0.1:42444  0.0.0.0:*  users:(("MainThread",pid=319466,fd=21))
LISTEN 0 128     0.0.0.0:22     0.0.0.0:*  users:(("sshd",pid=849,fd=3))
LISTEN 0 511     0.0.0.0:8443   0.0.0.0:*  users:(("nginx",pid=351466,fd=6),("nginx",pid=351465,fd=6),("nginx",pid=71947,fd=6))
LISTEN 0 2048  127.0.0.1:4000   0.0.0.0:*  users:(("litellm",pid=350092,fd=12))
LISTEN 0 5     127.0.0.1:7993   0.0.0.0:*  users:(("python3.12",pid=382006,fd=3))
LISTEN 0 4096  127.0.0.53%lo:53  0.0.0.0:*  users:(("systemd-resolve",pid=680,fd=14))
LISTEN 0 128       [::]:22         [::]:*  users:(("sshd",pid=849,fd=4))
```

| 端口 | 绑定地址 | 谁在听 | 是什么 | 对外可达 |
|---|---|---|---|---|
| 42443 | `127.0.0.1`（仅本机） | pid 432879 `MainThread` = `dsh-web.service` | **DSH Web 本体**（`dsh --profile web --port 42443`） | 否（需经 8443） |
| 42444 | `127.0.0.1`（仅本机） | pid 319466 = `dsh-web-gate.service`（node） | **稳定入口 gate**，转发到 42443，补 launch token | 否（需经 8443） |
| 8443 | **`0.0.0.0`（对外）** | nginx master 71947 + 2 worker | **唯一对外入口**，HTTPS + basic auth，反代到 42444 | 是（受云安全组约束，见 2.1） |
| 4000 | `127.0.0.1` | pid 350092 `litellm` = `gemini-gateway.service` | Gemini LiteLLM 网关（OpenAI 兼容） | 否，经 nginx `/llm/gemini/` |
| 7993 | `127.0.0.1` | pid 382006 `python3.12` = `kiro-relay.service` | Kiro relay（OpenAI 兼容） | 否，经 nginx `/llm/kiro/` |
| 22 | `0.0.0.0` / `[::]` | sshd | SSH | 是 |
| 19092 / 17890 / 17892 | `127.0.0.1` | `mihomo-egress` | 出口代理（与 DSH 的 egress 面板相关，非必需） | 否 |
| 53 | `127.0.0.53` | systemd-resolved | 本机 DNS | 否 |

**回答任务里的疑问**：
- 42443 = DSH Web 本体，**只听 127.0.0.1**，没有直接对外。
- 42444 = 自建 `dsh-web-gate`（node 脚本），**不是** DSH 的一部分，是额外加的稳定入口层。
- 8443 = **nginx HTTPS 反代**，绑 `0.0.0.0`，是用户实际访问的地址（`https://<server>:8443`）。

### 2.1 防火墙

```bash
$ ufw status verbose
ufw: not installed
$ firewall-cmd --list-all
firewalld: not installed
$ iptables -S            # 注意：iptables 不在非登录 PATH 里，需绝对路径 /usr/sbin/iptables
-P INPUT ACCEPT
-P FORWARD ACCEPT
-P OUTPUT ACCEPT
$ /usr/sbin/iptables -t nat -S
-P PREROUTING ACCEPT
-P INPUT ACCEPT
-P OUTPUT ACCEPT
-P POSTROUTING ACCEPT
$ /usr/sbin/nft list ruleset
（空输出）
```

**结论**：**OS 层没有任何防火墙**——ufw、firewalld 均未安装，iptables 三条链全 `ACCEPT` 且**零条规则**，
nft 规则集为空。也就是说 8443 在主机层是**完全开放**的，唯一的访问控制是 nginx 的 `auth_basic`。

> **未确认**：云厂商安全组（这台是阿里云 `iZ...` 实例风格 hostname，公网 IP `<server>` 不在任何本机网卡上，
> 应为 EIP/NAT 映射）无法从机器内部查询。**8443 的对外放行极可能是安全组规则，换机必须在新云控制台单独放行 8443/TCP**，
> 这条无法用命令验证，请人工在控制台核对。

HTTP 行为验证（只读 curl）：

```bash
$ curl -k -s -o /dev/null -w '%{http_code}' https://127.0.0.1:8443/    → 401   # basic auth 拦截（符合预期）
$ curl -s   -o /dev/null -w '%{http_code}' http://127.0.0.1:42444/    → 302   # gate 带 token 跳转
$ curl -s   -o /dev/null -w '%{http_code}' http://127.0.0.1:42443/    → 401   # DSH 自身 browser-auth 拦截
```

---

## 3. nginx

**已安装且正在运行**（`nginx` 不在 PATH，二进制在 `/usr/sbin/nginx`）：

```bash
$ /usr/sbin/nginx -v
nginx version: nginx/1.18.0 (Ubuntu)
$ dpkg -l | grep nginx
ii  nginx          1.18.0-6ubuntu14.22
ii  nginx-common   1.18.0-6ubuntu14.22
ii  nginx-core     1.18.0-6ubuntu14.22

$ systemctl status nginx --no-pager
● nginx.service - A high performance web server and a reverse proxy server
     Loaded: loaded (/lib/systemd/system/nginx.service; enabled; vendor preset: enabled)
     Active: active (running) since Thu 2026-11-19 00:27:10 CST; 1 day 14h ago
   Main PID: 71947 (nginx)
$ systemctl is-enabled nginx
enabled
```

### 3.1 站点文件

```bash
$ ls -la /etc/nginx/sites-available/ /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
/etc/nginx/sites-available/:
-rw-r--r-- 1 root root 2412 May 31  2023 default
-rw-r--r-- 1 root root 1561 Nov 19 18:43 dsh-web
-rw-r--r-- 1 root root  964 Nov 19 00:46 dsh-web.bak-\      ← 备份文件，文件名结尾带一个空格，未被 include

/etc/nginx/sites-enabled/:
lrwxrwxrwx 1 root root 34 Nov 19 00:27 dsh-web -> /etc/nginx/sites-available/dsh-web   ← 只有这一个

/etc/nginx/conf.d/:
（空）
```

`nginx -T` 确认**实际生效**的 server 只有 `sites-enabled/dsh-web` 一个（`default` 站点未 enable，
`dsh-web.bak- ` 因不在 `sites-enabled` 且文件名怪异而不生效）：

```bash
$ /usr/sbin/nginx -T | grep -nE 'configuration file|listen|server_name|proxy_pass|ssl_certificate'
197:# configuration file /etc/nginx/sites-enabled/dsh-web:
204:    listen 8443 ssl;
205:    server_name <server>;
207:    ssl_certificate     /etc/nginx/tls/dsh.crt;
208:    ssl_certificate_key /etc/nginx/tls/dsh.key;
232:        proxy_pass http://127.0.0.1:7993/;
236:        proxy_pass http://127.0.0.1:4000/;
243:        proxy_pass http://127.0.0.1:42444;
```

### 3.2 `/etc/nginx/sites-available/dsh-web` 全文摘要（1561 字节）

| 项 | 值 |
|---|---|
| `listen` | `8443 ssl`（绑 0.0.0.0，IPv4+IPv6 由 nginx 默认行为决定） |
| `server_name` | `<server>`（公网 IP，不是本机网卡地址） |
| `ssl_certificate` | `/etc/nginx/tls/dsh.crt`（自签，1172 B，`-rw-r--r--`） |
| `ssl_certificate_key` | `/etc/nginx/tls/dsh.key`（1704 B，`-rw------- root`，**内容未打印**） |
| `ssl_protocols` | `TLSv1.2 TLSv1.3` |
| `ssl_session_cache` | `shared:SSL:10m` |
| `error_page 497` | `=301 https://$host:$server_port$request_uri`（http 打到 8443 时自动跳 https） |
| `proxy_http_version` | `1.1` ← **WebSocket 必需** |
| `proxy_set_header Upgrade` | `$http_upgrade` ← WebSocket 支持 |
| `proxy_set_header Connection` | `$connection_upgrade`（文件顶部有 `map` 定义） |
| 其他 header | `Host $http_host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto` |
| `proxy_read_timeout` / `proxy_send_timeout` | 均 `3600s`（长连接/流式） |
| `proxy_buffering` | `off`（SSE 流式必需） |
| `client_max_body_size` | `512m`（大附件上传） |
| `location /` | `auth_basic "DSH"` + `auth_basic_user_file /etc/nginx/.dsh-auth`，`proxy_pass http://127.0.0.1:42444;` |
| `location /llm/kiro/` | `proxy_pass http://127.0.0.1:7993/;` + 透传 `Authorization` |
| `location /llm/gemini/` | `proxy_pass http://127.0.0.1:4000/;` + 透传 `Authorization` |

**proxy_pass 目标**：主站是 **`http://127.0.0.1:42444`（gate）**，不是 42443；
另有两条 LLM 网关子路径分别指向 7993（kiro-relay）和 4000（gemini-gateway）。

配套的认证文件（**内容为 bcrypt 口令，未打印**）：

```bash
$ ls -la /etc/nginx/.dsh-auth
-rw-r----- 1 root www-data 44 Nov 19 13:17 /etc/nginx/.dsh-auth
```

> 44 字节 = 1 行 `用户:bcrypt散列`。换机要么复制这个文件，要么用
> `htpasswd -c /etc/nginx/.dsh-auth <用户名>` 重建（需要 `apache2-utils`）。
> 权限必须是 `root:www-data 640`，否则 nginx worker（`user www-data;`）读不到，全站 500。

---

## 4. 其它系统侧耦合

### 4.1 /etc/hosts —— 无本项目条目

```bash
$ cat /etc/hosts
127.0.0.1 localhost
127.0.1.1 localhost
::1 ip6-localhost ip6-loopback
fe00::0 ip6-localnet
ff00::0 ip6-mcastprefix
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
```

只有系统默认内容，**没有** `dsh` / `<server>` 相关映射。
所以 `server_name <server>` 与 `--trusted-host <server>:8443` 都是硬编码公网 IP，换机若公网 IP 变化**必须同步改这两处**（改完 nginx 要 reload、DSH 要重启）。

### 4.2 systemd timer / cron —— 无 DSH 相关

```bash
$ systemctl list-timers --all --no-pager
15 timers listed.   # fwupd-refresh / apt-daily / logrotate / man-db / fstrim / motd 等，全是系统自带
$ ls -la /etc/cron.d/
e2scrub_all   .placeholder   sysstat      # 三个都是发行版自带
$ crontab -l -u root
no crontab for root
$ ls -la /var/spool/cron/crontabs/
（空）
```

**结论**：**没有任何 DSH 相关的 timer 或 cron 任务**。DSH 的周期性工作（如 router/vpn 巡检）走的是 DSH 自己的
`scheduled tasks`（存在 `/root/.dsh` 里），不是系统 cron，换机后需在 GUI 里重新确认。

### 4.3 logrotate —— 没有 DSH 条目（隐患）

```bash
$ ls -la /etc/logrotate.d/
alternatives apport apt bootlog btmp chrony dpkg nginx ppp rsyslog ubuntu-pro-client ufw unattended-upgrades wtmp
$ grep -rIl -e dsh -e '/root/.dsh' -e '/srv/workspace' /etc/logrotate.d/
（无输出）
$ ls -la /var/log/dsh-web.log
-rw-r--r-- 1 root root 15782 Nov 20 12:47 /var/log/dsh-web.log
```

systemd 用 `StandardOutput=append:` 直接追加写 `/var/log/dsh-web.log`，但**没有任何 logrotate 规则管它**，
日志会无限增长（且 gate 每次请求都会 stat 它）。移植时建议顺手补一条 logrotate（见第 5 节骨架），
并注意 `append:` 模式下用 `copytruncate` 才不会写坏。

### 4.4 运行用户与 /root/.dsh 权限 —— 必须是 root

```bash
$ ls -ld /root/.dsh
drwx------ 10 root root 4096 Nov 20 12:47 /root/.dsh
$ ls -la /root/.dsh
-rw-r--r--  .anonymous-user-id          37
drwx------  attachments/
drwx------  cache/
-rw-------  .credentials.yaml           281
-rw-------  .credentials.yaml.bak-20261119-100247
drwx------  egress/
-rw-------  .env                         136
drwxr-xr-x  profiles/
drwxr-xr-x  router/
drwx------  sessions/
drwx------  storages/
drwx------  vpn/
```

- 状态目录是 `/root/.dsh`，权限 `700 root:root`，**且 unit 里 `User=root`**，所以这套部署**只有 root 能跑**。
  普通用户跑会去读自己的 `~/.dsh`，拿不到现有 profiles / sessions / credentials。
- `/root` 本身是 `700`，即使把 unit 改成别的用户也读不到，除非整体迁移状态目录并改 ownership。
- `/root/.dsh/.env`（600）内含两个密钥变量，**只报变量名**：
  `KIRO_API_KEY=<redacted>`、`GEMINI_GATEWAY_KEY=<redacted>`。
  这两个是 `kiro-relay` / `gemini-gateway` 用的，DSH 的 DeepSeek key 在 `.credentials.yaml`（600，未打印）。
- 结论：**换机后仍应以 root 运行**（或专门建一个用户并把 `~/.dsh` 整个 chown 过去，同时改 unit 的 `User=`）。

### 4.5 与主链路相邻、但属于 W2 边界的服务

| 服务 | unit 路径 | 监听 | 作用 |
|---|---|---|---|
| `gemini-gateway.service` | `/etc/systemd/system/gemini-gateway.service` | 127.0.0.1:4000 | `EnvironmentFile=/etc/llm/gemini.env`，`WorkingDirectory=/opt/llm/gemini-gateway`，`ExecStart=/opt/llm/gemini-gateway/venv/bin/litellm --config /opt/llm/gemini-gateway/config.yaml --host 127.0.0.1 --port 4000` |
| `kiro-relay.service` | `/etc/systemd/system/kiro-relay.service` | 127.0.0.1:7993 | `EnvironmentFile=/etc/llm/kiro.key` + `/etc/llm/kiro-relay.env`，`ExecStart=/root/.local/share/uv/python/cpython-3.12.16-linux-x86_64-gnu/bin/python3.12 /opt/llm/kiro-relay/kiro_relay.py --host 127.0.0.1 --port 7993 --proxy ${KIRO_RELAY_PROXY} --key ${KIRO_RELAY_KEY} --max-concurrent 8` |

这两个**不决定 GUI 能否打开**（缺了只是 `/llm/*` 路径 502），但 nginx 配置里引用了它们，
且 `kiro-relay` 的 Python 解释器路径在 `/root/.local/share/uv/...`（uv 装的 3.12.16），
搬机时若不在 W1/W3 范围，可先只搬 DSH 三件套、把 `/llm/` 两个 location 留空或指向新网关。

---

## 5. 移植结论表

| 项目 | 绝对路径 | 关键内容 | 换机是否必须重做 | 怎么重做（命令级） |
|---|---|---|---|---|
| **DSH unit** | `/etc/systemd/system/dsh-web.service` | `User=root`，ExecStartPre=`dsh-fix-zod`，ExecStart=dsh shim + `--profile web --host 127.0.0.1 --port 42443 --trusted-host <IP>:8443`，`Restart=on-failure/5`，日志 append `/var/log/dsh-web.log` | **必须** | 见 5.1 骨架 → `systemctl daemon-reload && systemctl enable --now dsh-web` |
| **Gate unit** | `/etc/systemd/system/dsh-web-gate.service` | node 跑 `dsh-web-gate.mjs`，42444→42443，`GATE_TOKEN_LOG=/var/log/dsh-web.log`，`Restart=always/3` | **必须**（否则书签 token 每次重启失效） | 见 5.2 骨架 → `systemctl daemon-reload && systemctl enable --now dsh-web-gate` |
| **gate 脚本** | `/usr/local/bin/dsh-web-gate.mjs` | 6616 B / 179 行，零依赖，从日志尾部取 launch token 并代理 | **必须** | `install -m 0755 dsh-web-gate.mjs /usr/local/bin/`（整文件复制） |
| **zod 修复脚本** | `/usr/local/bin/dsh-fix-zod` | bash，把 store 里的 zod 软链进 dsh-web 依赖链；**路径写死 `store/v11`** | **必须** | `install -m 0755 dsh-fix-zod /usr/local/bin/`；若新机 pnpm store 不是 `v11` 需改脚本内路径；不需要就删掉 ExecStartPre 行 |
| **nginx 站点** | `/etc/nginx/sites-available/dsh-web`（enable 符号链接 `/etc/nginx/sites-enabled/dsh-web`） | `listen 8443 ssl`，`server_name <server>`，`proxy_pass http://127.0.0.1:42444`，Upgrade/Connection、`proxy_buffering off`、`client_max_body_size 512m`、`auth_basic` | **必须** | 见 5.3 骨架 → `ln -s ../sites-available/dsh-web /etc/nginx/sites-enabled/dsh-web && nginx -t && systemctl reload nginx` |
| **TLS 证书** | `/etc/nginx/tls/dsh.crt` / `/etc/nginx/tls/dsh.key` | 自签，TLS1.2/1.3；key 权限 600 | **必须**（可复用，也可重签） | 复制两个文件并 `chmod 600 dsh.key`；重签见 5.3 备注 |
| **basic auth 文件** | `/etc/nginx/.dsh-auth` | 44 B，1 行 `user:bcrypt`，`root:www-data 640` | **必须** | 复制并 `chown root:www-data && chmod 640`；或 `htpasswd -c /etc/nginx/.dsh-auth <用户名>` |
| **防火墙 / 安全组** | 无本机规则（iptables 全 ACCEPT，无 ufw/firewalld） | OS 层不拦；**云安全组放行 8443/TCP**（未确认，需控制台核） | **必须**（云侧） | 新机安全组入方向放行 `8443/tcp`；若改用 ufw：`ufw allow 8443/tcp`（本机未装 ufw，保持现状即可） |
| **运行用户 / 状态目录** | `/root/.dsh`（700 root） | profiles/sessions/credentials/.env(密钥)/attachments 全在此 | **必须**（迁移状态） | `rsync -a /root/.dsh/ newhost:/root/.dsh/`；或改 unit `User=` + `chown -R` 到新用户 |
| **Node 运行时** | `/usr/local/bin/node`（v24.22.3，非 apt 包） | ≥24，`/usr/local/pnpm-global` 为其配套 pnpm 全局目录 | **必须** | 装 Node 24 到同一路径（或改 unit 的 `PATH`/`Environment=`）；`PNPM_HOME=/usr/local/pnpm-global` 需一致 |
| **日志** | `/var/log/dsh-web.log` | systemd append，**无 logrotate** | 建议补 | `touch /var/log/dsh-web.log`；加 `/etc/logrotate.d/dsh-web`（见 5.4） |
| **/etc/hosts** | `/etc/hosts` | 无项目条目 | 否 | 无需改动 |
| **cron / timer** | — | 无 DSH 相关 | 否 | 无需改动 |
| LLM 网关（相邻） | `/etc/systemd/system/gemini-gateway.service`、`kiro-relay.service`、`/opt/llm/*`、`/etc/llm/*` | 4000 / 7993 | 视需求（不影响 GUI 打开） | 不搬则把 nginx 的 `/llm/kiro/`、`/llm/gemini/` 两个 location 删掉或改指向 |

### 5.1 `/etc/systemd/system/dsh-web.service` 可复制骨架

```ini
[Unit]
Description=DeepSeek Harness Web UI (127.0.0.1:42443)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=PNPM_HOME=/usr/local/pnpm-global
Environment=PATH=/usr/local/pnpm-global/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin
# 可选：仅在 pnpm 重装后出现 "Cannot find module 'zod'" 时才需要
ExecStartPre=/usr/local/bin/dsh-fix-zod
ExecStart=/usr/local/pnpm-global/bin/dsh --profile web --no-open --host 127.0.0.1 --port 42443 --trusted-host <公网IP或域名>:8443
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/dsh-web.log
StandardError=append:/var/log/dsh-web.log

[Install]
WantedBy=multi-user.target
```

> `--trusted-host` 必须与 nginx 的 `server_name` / 浏览器地址栏 host **完全一致**（含端口），否则 DSH 的
> Host 校验会拒绝请求。换机改 IP 时这两处一起改。

### 5.2 `/etc/systemd/system/dsh-web-gate.service` 可复制骨架

```ini
[Unit]
Description=DSH Web stable entry gate (127.0.0.1:42444 -> 42443)
After=network-online.target dsh-web.service
Wants=dsh-web.service

[Service]
Type=simple
ExecStart=/usr/local/bin/node /usr/local/bin/dsh-web-gate.mjs
Environment=GATE_PORT=42444
Environment=GATE_UPSTREAM_HOST=127.0.0.1
Environment=GATE_UPSTREAM_PORT=42443
Environment=GATE_TOKEN_LOG=/var/log/dsh-web.log
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

### 5.3 `/etc/nginx/sites-available/dsh-web` 可复制骨架

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 8443 ssl;
    server_name <公网IP或域名>;          # 必须与 --trusted-host 一致

    ssl_certificate     /etc/nginx/tls/dsh.crt;
    ssl_certificate_key /etc/nginx/tls/dsh.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;

    # http 打到 8443 时自动跳 https
    error_page 497 =301 https://$host:$server_port$request_uri;

    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;      # WebSocket 必需
    proxy_set_header Connection $connection_upgrade; # WebSocket 必需
    proxy_set_header Host       $http_host;
    proxy_set_header X-Real-IP  $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout  3600s;    # 长连接 / 流式
    proxy_send_timeout  3600s;
    proxy_buffering     off;      # SSE 必需

    client_max_body_size 512m;    # 大附件上传

    # 可选：LLM 网关子路径（未搬网关则删掉这两块）
    location /llm/kiro/ {
        proxy_pass http://127.0.0.1:7993/;
        proxy_set_header Authorization $http_authorization;
    }
    location /llm/gemini/ {
        proxy_pass http://127.0.0.1:4000/;
        proxy_set_header Authorization $http_authorization;
    }

    location / {
        auth_basic           "DSH";
        auth_basic_user_file /etc/nginx/.dsh-auth;
        proxy_pass http://127.0.0.1:42444;   # 注意：gate，不是 42443
    }
}
```

启用与自签证书（命令级）：

```bash
ln -s /etc/nginx/sites-available/dsh-web /etc/nginx/sites-enabled/dsh-web
mkdir -p /etc/nginx/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout /etc/nginx/tls/dsh.key -out /etc/nginx/tls/dsh.crt \
  -subj "/CN=<公网IP或域名>"
chmod 600 /etc/nginx/tls/dsh.key && chmod 644 /etc/nginx/tls/dsh.crt
htpasswd -c /etc/nginx/.dsh-auth <用户名>     # 需要 apache2-utils；或直接复制原文件
chown root:www-data /etc/nginx/.dsh-auth && chmod 640 /etc/nginx/.dsh-auth
nginx -t && systemctl reload nginx
```

### 5.4 建议补的 logrotate（当前缺失）

```bash
cat > /etc/logrotate.d/dsh-web <<'EOF'
/var/log/dsh-web.log {
    daily
    rotate 7
    missingok
    notifempty
    copytruncate
    compress
}
EOF
```

> 用 `copytruncate` 是因为 systemd `append:` 持有 fd，`create` 方式会让 systemd 继续写旧 inode。

---

## 6. 「换机必须重做」清单（按操作顺序）

1. 装 Node 24 到 `/usr/local/bin/node`，建 `PNPM_HOME=/usr/local/pnpm-global`，全局安装 dsh（版本与源机一致）。
2. 复制两个脚本：`/usr/local/bin/dsh-web-gate.mjs`、`/usr/local/bin/dsh-fix-zod`（0755）。
   —— 若新机 pnpm store 不是 `store/v11`，改 `dsh-fix-zod` 内路径或删掉 ExecStartPre。
3. 写 `/etc/systemd/system/dsh-web.service`、`/etc/systemd/system/dsh-web-gate.service`（5.1 / 5.2），
   把 `--trusted-host` 改成新机的对外 `IP:8443`。`daemon-reload` + `enable --now`。
4. `apt install nginx`；写 `/etc/nginx/sites-available/dsh-web`（5.3），`server_name` 与第 3 步保持一致，
   建 `sites-enabled` 符号链接。
5. 放 TLS 证书 `/etc/nginx/tls/dsh.{crt,key}`（key 600）与 `/etc/nginx/.dsh-auth`（root:www-data 640）。
6. `nginx -t && systemctl reload nginx`。
7. 云安全组放行 `8443/tcp`（**本机无防火墙，唯一放行层在云侧，需人工确认**）。
8. 迁移 `/root/.dsh`（700 权限，含 profiles/sessions/credentials/.env），保持 root 运行。
9. 补 `/etc/logrotate.d/dsh-web`（5.4）。
10. 验证链：`curl -kI https://<IP>:8443/` 应 401 → 带 basic auth 应 302/200 →
    `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:42444/` 应 302。

## 7. 未确认项（不编造）

| 项 | 原因 |
|---|---|
| 云安全组是否放行 8443 | 控制台信息，机器内部无 API/凭据可查；`<server>` 不在任何本机网卡上，判断为 EIP/NAT |
| `<server>` 的绑定方式（EIP / NAT / SLB） | 同上，仅从 `ip addr` 看到内网 `<内网地址>` |
| `dsh-fix-zod` 在新机的必要性 | 取决于新机 pnpm store 版本与 @deepseek-ai/dsh-web 的依赖布局，需装完实测 |
| `.credentials.yaml` / `.env` 的具体密钥值 | 按只读与脱敏要求未读取/未打印 |
| `dsh-web-gate.mjs` 是否会随 DSH 升级失效 | 它依赖 dsh web 日志格式（`dsh web: http://...?token=...`）；DSH 若改日志格式，gate 需同步改 |

# mihomo 本地出口（sg-mihomo）运维说明

## 1. 为什么需要它

订阅提供的是 Clash 格式节点（hysteria2、vless-reality），dsh-egress 只支持 `http / https / socks5` 出口。在服务器上跑一个 mihomo（Clash.Meta 内核），把订阅转成一个只在本机回环地址上监听的 http/socks5 混合端口，dsh-egress 再把它当成普通代理出口使用。

不使用 tun、redir、tproxy，所以服务器的默认路由和 DNS 不受影响，生产的 dsh-web、dsh-web-gate、nginx 也不受影响。只有被绑定到 `sg-mihomo` 的目标主机的模型请求会经过它。

## 2. 架构

```
订阅（机密 URL，只在 sub.url 里）
   │  curl（URL 经 stdin 传给 curl，不上命令行）
   ▼
mihomo-egress-refresh（root）──► 改写安全项 ──► mihomo -t 校验 ──► 替换 config.yaml ──► systemctl restart
                                                                           │
                                                                           ▼
                                      mihomo-egress（用户 mihomo）监听 127.0.0.1:17890（http + socks5，需认证）
                                                                           │  hysteria2 / vless-reality（选 SG-Auto）
                                                                           ▼
dsh-web 进程 ── dsh-egress 出口 sg-mihomo（http://***:***@127.0.0.1:17890）──► 新加坡节点 ──► 目标 API
```

默认出口组是 `SG-Auto`（url-test，自动选延迟最低的节点）。

## 3. 文件位置（出口服务器）

| 路径 | 说明 |
|---|---|
| `/usr/local/bin/mihomo-egress` | mihomo 二进制，755。取自 MetaCubeX/mihomo 官方 GitHub release，`mihomo-linux-amd64-compatible-v1.19.34.gz`，已按 API 提供的 sha256 digest 核对 |
| `/etc/mihomo-egress/` | 配置目录，0750 `root:mihomo` |
| `/etc/mihomo-egress/config.yaml` | 生成的配置，0640 `root:mihomo`，含本地代理的用户名和密码 |
| `/etc/mihomo-egress/sub.url` | 订阅链接，0600 `root:root`，只有 root 能读 |
| `/etc/mihomo-egress/.auth` | 本地代理的用户名和密码（两行），0600 `root:root`。refresh 重新生成配置时沿用它，所以 dsh-egress 出口里存的凭据不会失效 |
| `/etc/mihomo-egress/config.yaml.bak` | 上一份配置（第二次刷新起出现） |
| `/usr/local/sbin/mihomo-egress-refresh` | 刷新脚本，0750 root |
| `/etc/systemd/system/mihomo-egress.service` | systemd 单元（User=mihomo，NoNewPrivileges，ProtectSystem=strict，ReadWritePaths=/etc/mihomo-egress，ProtectHome，PrivateTmp） |
| 系统用户 `mihomo` | `--system --no-create-home --shell /usr/sbin/nologin` |

没有定时器。订阅只在手动运行刷新脚本时更新。

## 4. 日常操作

查看状态：

```bash
systemctl is-active mihomo-egress
ss -ltnp | grep 17890          # 应只有 127.0.0.1:17890
journalctl -u mihomo-egress -n 30 --no-pager
```

刷新订阅（root）：

```bash
/usr/local/sbin/mihomo-egress-refresh
```

流程：读 `sub.url` → 下载到临时文件 → 用 python3-yaml 改写 → `mihomo-egress -t` 校验 → 通过才替换 `config.yaml` 并重启服务。任何一步失败都保留旧配置并以非零退出。stdout 只输出一行结果，不含订阅内容和密码。

脚本固定改写的项：`mixed-port: 17890`、`bind-address: 127.0.0.1`、`allow-lan: false`、`authentication`（沿用 `.auth`）、`skip-auth-prefixes`（改成一个无关网段，因为 mihomo 默认对 127.0.0.0/8 免认证）、删除 `external-controller*`、`secret`、`tun`、`redir-port`、`tproxy-port`、`listeners`，`dns.enable: false` 且去掉 `dns.listen`，`geo-auto-update: false`。

规则默认简化为单条 `MATCH,SG-Auto`。订阅里的 `GEOIP,CN,DIRECT` 需要下载 GeoIP 库，本机下载超时，会导致配置校验失败。要保留订阅规则可设 `MIHOMO_KEEP_RULES=1`，前提是 geo 数据能下载。

更换订阅链接：用 root 把新链接写入 `/etc/mihomo-egress/sub.url`（保持 0600，不要把链接放在命令行参数里），再运行刷新脚本。

## 5. 在 dsh-egress 里的配置

出口名 `sg-mihomo`，类型 http，主机 127.0.0.1，端口 17890，带用户名和密码（取自 `.auth`）。界面和 `GET /api/egress/state` 里显示的 URL 是脱敏的（`http://***:***@127.0.0.1:17890`）。

用法：在「出口」页把要走新加坡的目标主机（例如 `api.commandcode.ai`）绑定到 `sg-mihomo`。当前交付状态是出口保留、绑定仍是 `direct`，由用户决定是否切换。

故障关闭：mihomo 停止时，绑定到 `sg-mihomo` 的请求会报 `ECONNREFUSED 127.0.0.1:17890 ... not retried directly`，不会回退直连。

## 6. 停用

```bash
systemctl disable --now mihomo-egress
```

然后在出口页把所有绑定到 `sg-mihomo` 的主机改回 `direct`，再删除出口 `sg-mihomo`。出口仍被绑定或是默认出口时，删除会被拒绝。

## 7. 卸载

先完成第 6 节，再执行：

```bash
systemctl disable --now mihomo-egress
rm -f /etc/systemd/system/mihomo-egress.service
systemctl daemon-reload
rm -f /usr/local/bin/mihomo-egress /usr/local/sbin/mihomo-egress-refresh
rm -rf /etc/mihomo-egress          # 含 sub.url、.auth、config.yaml
userdel mihomo
# 可选：apt-get remove python3-yaml（如果它是为本方案装的；在本机它本来就已安装，不要删）
```

## 8. 安全设计

- 只监听回环：`bind-address: 127.0.0.1`、`allow-lan: false`。TCP 和 UDP 的 17890 都只在 127.0.0.1 上。
- 必须认证：用户名和密码是 `openssl rand -hex 12` 生成的 24 位随机串，只存在 0600/0640 文件里。无认证访问返回 407，socks5 无认证被拒。
- 无管理口：不设 `external-controller`，没有 9090。
- 不改路由和 DNS：无 tun、redir、tproxy。`dns.enable: false`，不绑 53 端口，不碰 `/etc/resolv.conf`，systemd-resolved 的 127.0.0.53:53 照常工作。
- 订阅 token 只在 `sub.url`（0600 root）里。刷新脚本用 stdin 把 URL 交给 curl，不出现在进程参数里，也不进日志和 stdout。
- 最小权限运行：专用系统用户 `mihomo`，nologin，`NoNewPrivileges`、`ProtectSystem=strict`（只可写 `/etc/mihomo-egress`）、`ProtectHome`、`PrivateTmp`。
- 失败保留旧配置：校验不过不替换，不重启。

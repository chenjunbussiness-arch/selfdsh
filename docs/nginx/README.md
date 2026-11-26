# nginx 站点模板（脱敏）— dsh-web / browser-novnc / gitea / couple-fit

2026-11-21 从源机 `/etc/nginx/sites-available/` 只读复制并脱敏，**不是可直接 `nginx -t` 的文件**：
所有主机名、证书文件名、口令文件路径、站点根目录都换成了占位符，按目标机填写后再放进
`/etc/nginx/sites-available/` 并 `ln -s` 到 `sites-enabled/`。

| 模板 | 端口 | 作用 | 后端 |
|---|---|---|---|
| `dsh-web.conf` | 8443 ssl | DSH Web GUI 的固定入口（TLS + basic auth + 旧版 Chromium polyfill）；另有 dsh-fileshare 临时链接的两条免 Basic 认证的 location | nginx → `127.0.0.1:42444`（dsh-web-gate）→ `42443`（dsh web）；`/api/fileshare/d/`、`/api/fileshare/u/` 直连 `42443` |
| `browser-novnc.conf` | 8445 ssl | 浏览器桌面（noVNC）独立站点 | nginx → `127.0.0.1:6080`（websockify → VNC 5900） |
| `gitea.conf` | 8444 ssl | 自建 Gitea，**强制 mTLS**（`ssl_verify_client on`） | nginx → `127.0.0.1:3000` |
| `couple-fit.conf` | 8450 http | 纯静态单页站点 | `root` 指向页面目录 |

## 占位符

| 占位符 | 含义 |
|---|---|
| `__SERVER_NAME__` | 对外访问用的域名或 IP（nginx `server_name`，须与 DSH `--trusted-host` 一致） |
| `__TLS_CERT__` / `__TLS_KEY__` | 站点证书与私钥的绝对路径（源机在 `/etc/nginx/tls/` 下） |
| `__CLIENT_CA__` | Gitea mTLS 的客户端 CA 证书路径（`ssl_client_certificate`） |
| `__HTPASSWD_FILE__` | basic-auth 口令文件路径（源机为 `/etc/nginx/.dsh-auth`，用 `htpasswd` 生成） |
| `__SITE_ROOT__` | 静态站点根目录 |

`couple-fit.conf` 的 `server_name _;` 与监听端口是原样保留的默认值；`dsh-web` / `browser-novnc`
里 `map` 的变量名是故意分开的（`$connection_upgrade` 与 `$novnc_connection_upgrade`），
同名 `map` 重复定义会让 `nginx -t` 失败。

## 迁移时注意（来自 2026-11-21 实测）

1. **8443/8445 的证书**（`dsh.crt`）SAN 覆盖 `<server>`、`127.0.0.1` 和 `localhost`，
   换地址后无需重签。
2. **8444 的 Gitea 证书**（`gitea.crt`）是**迁移前的地址**签发的：CN 与 SAN 里只有那个旧公网 IP
   和 `127.0.0.1`，**不含 `<server>`**。所以浏览器或 `git` 访问 `https://<server>:8444`
   会主机名校验失败；要么重签证书把新地址加进 SAN，要么临时用
   `--resolve <server>:8444:127.0.0.1` / `-k`，并把 CA 导入客户端信任库。
   仓库内不放任何证书或私钥。
3. 8444 是 **mTLS**：客户端必须带 `client.p12`（或 `client.crt` + `client.key`）。
   证书与口令由运维单独保管，**不进本仓库**；仓库文档里出现 `client.p12` 只是文件名说明。
4. 阿里云安全组需要放行 TCP `8443`、`8444`、`8445`、`8450`（按实际启用的站点）。

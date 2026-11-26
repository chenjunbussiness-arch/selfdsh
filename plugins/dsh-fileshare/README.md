# dsh-fileshare：文件中转（临时下载 / 上传链接）

## 这是什么

云端 agent 做出来的文件，以前要 `scp` 才拿得下来。装上这个插件后：

- **下载**：agent（或你在页面上）给一个文件生成临时链接，浏览器点开就下，`curl -O` 也行，支持断点续传。
- **上传**：生成一个临时上传链接，对方在网页上拖文件进去，或 `curl -T 文件 链接`，文件直接落到服务器指定文件夹。

链接本身就是凭证：32 位随机令牌，默认下载 1 小时、上传 30 分钟过期，随时可撤销，还能限制下载次数、上传文件数和总容量。

## 装好后在哪里看到

- 侧边栏「文件中转」：分享文件、收文件两张卡片，下面是链接列表（有效 / 全部，可撤销，能看到上传链接收到了哪些文件）和允许的文件夹。
- agent 多了 4 个工具：

| 工具 | 做什么 |
|---|---|
| `file_share` | 给一个文件生成下载链接。`path`（相对 agent 工作目录或绝对路径），或 `hub_task` + `name` 分享 dsh-hub 任务的产物；可选 `ttl_minutes`、`max_downloads`、`note` |
| `file_upload_link` | 生成上传链接。`dir`（不填就进收件箱）、`ttl_minutes`、`max_files`、`max_mb`；回答里带 `curl -T` 用法 |
| `file_links` | 列出链接和状态（不含令牌） |
| `file_link_revoke` | 撤销一个链接，立刻失效 |

工具说明里要求模型把返回的 `url` 原样贴给你，所以对 agent 说「把 out/report.pdf 发我」就会拿到一个能点的链接。

## 必须配置：nginx

生产环境 nginx 在 `location /` 上有 Basic 认证，拿到链接的手机、别的电脑会被挡住。要给两个前缀单开 location，**直连 dsh web（42443），不能经过 42444 的 gate**：gate 会替没登录的浏览器补上 DSH 的 launch token，经过它等于把 DSH 登录送给拿到链接的人。

模板已经写进 `docs/nginx/dsh-web.conf`（放在 `location /` 前面）：

```nginx
location ^~ /api/fileshare/d/ {
    limit_except GET HEAD { deny all; }
    proxy_pass http://127.0.0.1:42443;
    proxy_set_header Host              $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header Accept-Encoding   "";
}
location ^~ /api/fileshare/u/ {
    limit_except GET HEAD PUT POST { deny all; }
    client_max_body_size    4096m;
    proxy_request_buffering off;
    proxy_pass http://127.0.0.1:42443;
    proxy_set_header Host              $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP         $remote_addr;
}
```

`/api/fileshare` 下其它接口（列表、生成、撤销、hello）仍走 `location /`，要 Basic 认证 + DSH 登录。

## 链接里的地址

链接要用对外域名，**绝不会用内网地址**。按顺序取：

1. 配置里的 `publicBaseUrl`（例如 `https://你的域名:8443`）；
2. 你从对外地址打开 DSH 页面时，页面会把浏览器看到的地址告诉插件（`/api/fileshare/hello`，只在没配 `publicBaseUrl` 时用）；
3. 都没有时只给路径 `/api/fileshare/d/<令牌>/<文件名>`，你自己拼上域名。

回环、10/8、172.16/12、192.168/16、100.64/10、169.254/16、IPv6 内网段、`localhost`、单段主机名以及 `.local` `.lan` `.internal` `.corp` 等后缀一律拒绝；配了内网的 `publicBaseUrl` 会被丢弃并在日志里警告。

## 可选配置

写在 **profile 的** `cordis.patch.yml`（例如 `/root/.dsh/profiles/web/cordis.patch.yml`）。注意 patch 的 `config` 整体替换，想保留的键要重写一遍：

```yaml
- id: host-fileshare
  name: dsh-host-fileshare
  config:
    publicBaseUrl: https://你的域名:8443
    roots: [/srv/workspace, /root/.dsh/router-workspaces]
    downloadTtlMinutes: 60
    uploadTtlMinutes: 30
```

| 键 | 默认 | 说明 |
|---|---|---|
| `publicBaseUrl` | 空 | 链接前缀，见上一节 |
| `roots` | `[]` | 允许分享 / 接收的文件夹。`/`、家目录、DSH home 及其上级太宽，会被忽略 |
| `includeSessionCwd` | `true` | agent 会话的工作目录也算允许的文件夹 |
| `inboxDir` | `<DSH home>/fileshare/inbox` | 上传链接不指定文件夹时放这里 |
| `hubArtifactsDir` | `<DSH home>/agent-hub/artifacts` | `hub_task` 用；只能分享 `<任务>/outputs/` 里的文件 |
| `stateFile` | `<DSH home>/fileshare/links.json` | 链接记录（权限 600，只存令牌哈希） |
| `downloadTtlMinutes` / `downloadMaxTtlMinutes` | 60 / 10080 | 下载链接有效期 / 上限 |
| `uploadTtlMinutes` / `uploadMaxTtlMinutes` | 30 / 1440 | 上传链接有效期 / 上限 |
| `uploadMaxFiles` | 20 | 一个上传链接最多收几个文件 |
| `uploadMaxMb` / `uploadMaxMbCap` | 512 / 4096 | 一个上传链接的总容量 / 上限（nginx 的 `client_max_body_size` 要够大） |
| `maxActiveLinks` | 500 | 同时有效的链接上限 |
| `keepExpiredDays` | 7 | 过期 / 撤销的记录保留几天 |
| `deny` | 见下 | 永不分享、永不写入的名字 |

默认 `deny`：`.ssh .gnupg .aws .azure .kube .docker .git .svn .hg .env .env.* *.env .netrc .npmrc .pypirc .git-credentials .htpasswd .dsh-auth *.pem *.key *.p12 *.pfx *.jks *.keystore *.kdbx *.ovpn id_rsa* id_dsa* id_ecdsa* id_ed25519* authorized_keys known_hosts secrets.* credentials credentials.json tokens *.token shadow passwd`（路径任何一段命中都拒绝，不分大小写）。

## 安全设计

- **令牌**：24 字节随机数（base64url 32 位）。`links.json` 只存 sha256，完整链接只在生成那一刻出现一次；页面列表、`file_links` 都不含令牌。
- **路径**：分享和写入都先 `realpath`，必须落在允许的文件夹里；`..`、指出去的软链接、目录、非普通文件都拒绝。下载时再核对一次真实路径并用 `O_NOFOLLOW` 打开，防止生成后被换成软链接。DSH home 里的东西（会话、凭证）不能分享，收件箱除外。
- **下载响应**：默认 `attachment`，加 `?view=1` 只对文本、PDF、图片、音视频在浏览器里打开；始终带 `sandbox` 的 CSP、`nosniff`、`no-store`、`no-referrer`，上传来的 HTML / SVG 不会在 DSH 的域名下执行。
- **上传**：文件名只取最后一段，去掉控制字符和开头的点，同名自动编号 `name (1).ext`，不会覆盖；先写临时文件、边写边计量，超容量立即 413 并删掉；提交时在锁里重新核对次数和容量。上传链接不能读文件。
- **登录**：页面用的接口要 DSH 登录，POST 还要 `x-dsh-fileshare: 1` 头（挡跨站表单）。公开的只有 `d/` 和 `u/` 两个前缀。
- **多进程**：同一个 DSH home 下的多个 DSH 进程（web 服务、headless、别的 profile）共用 `links.json`：读时文件变了就重读，写时拿 `links.json.lock` 锁并重读后再写。

## 安装与更新

```bash
cd selfdsh
# 1. 构建页面的浏览器产物（不构建也能用工具，只是没有页面）
node plugins/dsh-fileshare/scripts/build.mjs
# 2. 装进 profile（幂等；可先 --dry-run）
node plugins/dsh-fileshare/scripts/install.mjs --profile /root/.dsh/profiles/web
# 3. 重启 DSH，然后看日志里有
#    dsh-fileshare: links in ...; 4 tools registered
#    dsh-fileshare: routes mounted at /api/fileshare (...)
# 4. nginx 加上面两条 location，nginx -t && systemctl reload nginx
# 5. 从对外地址打开一次 DSH 页面（或配 publicBaseUrl）
```

卸载：`node plugins/dsh-fileshare/scripts/install.mjs --profile <dir> --uninstall`。

## 常见问题

- **链接只有路径没有域名**：没配 `publicBaseUrl`，也还没从对外地址打开过 DSH。二选一即可。
- **别的设备打开链接要账号密码**：nginx 还没加两条 location。
- **上传大文件 413**：链接的容量不够（`max_mb`），或 nginx 的 `client_max_body_size` 太小。
- **「outside every allowed directory」**：文件不在 `roots` 或 agent 的工作目录里。
- **想分享整个文件夹**：先打包（`tar czf out.tgz dir/`）再分享，插件不分享目录。

## 更多文档

- `docs/ARCHITECTURE.md`：模块、接口、真机实测记录。

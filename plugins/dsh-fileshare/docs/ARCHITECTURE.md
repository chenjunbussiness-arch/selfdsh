# dsh-fileshare 架构与实测记录

## 一、目标

云端 agent 的产出文件不用 `scp` 就能拿到，外面的文件也能不用 `scp` 传上服务器。做法是临时链接：随机令牌 + 过期 + 可撤销 + 次数 / 容量上限，只开放允许的文件夹，链接里绝不出现内网地址。

## 二、结构

```
plugins/dsh-fileshare/
  index.js, package.json, cordis.patch.yml, locale/, icon.svg   bundle：把两个子包插进 profile
  packages/host-fileshare/        宿主（Node ESM，无需构建）
    config.js       配置解析和默认值
    origin.js       对外地址：内网判定、校验 publicBaseUrl、从请求头取地址
    paths.js        允许的文件夹、deny 名单、realpath 检查、安全文件名
    store.js        links.json：原子写、跨进程锁、只存令牌哈希
    service.js      生成 / 列出 / 撤销；拼链接；hub 任务产物
    public.js       公开路由 d/（下载）和 u/（上传）
    upload-page.js  上传网页（白天 / 黑夜跟随系统）
    manage.js       要登录的路由：hello、links、create、revoke
    tools.js        file_share、file_upload_link、file_links、file_link_revoke
    index.js        挂工具和路由
    tests/          node --test，25 个
  packages/client-ui-fileshare/   DSH 页面（TSX，esbuild 打成 lib/client.js）
  scripts/build.mjs, install.mjs
```

## 三、接口

| 路由 | 登录 | 说明 |
|---|---|---|
| `GET/HEAD /api/fileshare/d/<令牌>/<文件名>` | 否 | 下载；单段 Range（206 / 416）；从第 0 字节开始的 GET 记一次下载；`?view=1` 安全类型在浏览器里打开 |
| `GET /api/fileshare/u/<令牌>/` | 否 | 上传网页；`?status=1` 返回 JSON；没有末尾斜杠时 301 |
| `PUT/POST /api/fileshare/u/<令牌>/<文件名>` | 否 | 上传一个文件（或 `?name=`），返回 `{ok,name,size,sha256,filesLeft,bytesLeft}` |
| `POST /api/fileshare/hello` | 是 | 页面告诉插件浏览器看到的地址（没配 `publicBaseUrl` 时用；内网地址拒绝） |
| `GET /api/fileshare/links` | 是 | 地址来源、允许的文件夹、默认值、链接列表（不含令牌） |
| `POST /api/fileshare/create` | 是 | `{kind:'download',path,...}` 或 `{kind:'upload',dir,...}` |
| `POST /api/fileshare/revoke` | 是 | `{id}` |

要登录的 POST 还要 `x-dsh-fileshare: 1` 头。失效的链接返回 410（浏览器访问给一张说明页），不存在的返回 404。

## 四、状态

`<DSH home>/fileshare/links.json`（600）：

```json
{ "version": 1,
  "origin": { "base": "https://…", "seenAt": "…" },
  "workspaces": ["最近用过的 agent 工作目录，最多 20 个"],
  "links": [{ "id": "10 位十六进制", "tokenHash": "sha256", "kind": "download", "path": "…", "root": "…",
              "expiresAt": "…", "maxDownloads": null, "downloads": 0, "by": "agent|page", "note": "…" }] }
```

过期 / 撤销 / 用完的记录保留 `keepExpiredDays` 天后清掉。

## 五、真机实测记录（DSH 0.2.2-rc.5，2026-11-26）

在干净的 Linux 上用 npm 装的 `@deepseek-ai/dsh@0.2.2-rc.5`（Node 24），新建 web profile 和 headless profile，用 `scripts/install.mjs` 装上本插件，`roots` 指向一个测试文件夹；agent 那一路接本地「假模型」（OpenAI 兼容，按脚本先调 `file_share`、再调 `file_upload_link`）。

**跑通的**：

- 启动后两个子包都加载：页面的 `dsh-client-ui-fileshare/client.js` 出现在 DSH 首页的插件清单里，`/api/fileshare/*` 挂上；不登录访问 `links` 返回 401，登录后 200。
- `hello`：从 `127.0.0.1` 来的请求被拒绝（「internal addresses are never used in links」）；从对外域名来的请求记下 `https://域名`，之后生成的链接都用它。
- 生成下载链接：`.ssh/id_rsa`（deny）、`../` 跳出、`/etc/hostname`（不在允许文件夹）、指向外面的软链接、目录，全部拒绝并给出原因。
- 下载 3 MB 文件：HEAD 头正确（attachment、sandbox CSP、nosniff、no-store、Accept-Ranges）；Range 206 内容逐字节一致；限 2 次时第 3 次 410；假令牌 404；`links.json` 里查不到令牌原文。
- 上传：网页 200 且不含服务器路径；无斜杠 301；同名自动变 `report (1).txt`；限 2 个文件时第 3 个 410；文件名 `../../evil.txt` 落成 `evil.txt`、`.env` 落成 `env`；超容量 413 且不留临时文件；上传链接读文件 404；撤销后网页显示「链接已撤销」、PUT 410。
- agent 工具：假模型在 headless 会话里调用 `file_share`（相对工作目录的 `out/report.txt`）和 `file_upload_link`（`incoming2`），返回的 `url` 用配置的对外域名；用 web 服务的端口直接下载成功，上传成功。
- 直接带奇怪路径打到 DSH（`/api/fileshare/d/../links`、`%2e%2e` 等）：要么被 DSH 归一化后挡在登录 / 可信主机检查外，要么落到下载路由返回 404，拿不到别的东西。

**发现并已修**：

1. headless（或别的 profile）生成的链接，web 服务认不出来，返回 404：链接记录只在进程启动时读一次。现在读时文件变了就重读，写时加跨进程锁再重读。加了一个两个 store 并发写同一文件的测试。
2. 撤销 / 过期的上传链接打开网页返回 200（页面内容是「已撤销」）。改成 410，和下载一致。

**没测的**：

- 真的 nginx（这台机器没有 nginx）：两条 location 是照生产模板写的，合并后请按 README 加上并 `nginx -t`。
- 页面截图：这台机器装不了浏览器，页面只做了构建和类型检查；在真 DSH 里打开看一眼。
- 真实模型会不会主动用这几个工具（假模型是按脚本调的）。

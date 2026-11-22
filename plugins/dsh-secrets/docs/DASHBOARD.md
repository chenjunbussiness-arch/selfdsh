# dsh-secrets 只读密钥看板

> 一句话：**看得到有哪些密钥、它们的元数据和指纹，看不到任何一个值。**
> 值只能通过 `secret_*` 工具使用（`secret_exec` 注入环境变量、`secret_http` 的 `${secret:NAME}`
> 占位符、`secret_check` 比对候选值）。这和 [DESIGN.md](../DESIGN.md) 的原则“能写能用，读不回明文”一致：
> 看板只是给人看的 `secret_list`，没有新增任何读回路径。

## 1. 组成

| 部分 | 位置 | 作用 |
| --- | --- | --- |
| 宿主侧接口 | `packages/host-secrets/bridge.js` | 两个只读 GET 路由，注册在 `ctx.webServer` 上，带登录校验 |
| 挂载 | `packages/host-secrets/index.js` → `mountBridge()` | `ctx.inject(['webServer'], …)`；没有 `webServer` 时只是不挂接口，10 个工具照常工作 |
| 浏览器侧页面 | `packages/client-ui-secrets/` | `main` 面板 `secrets/page` + 侧栏 `sidebar.panellist` 一行“密钥” |
| 补丁层 | `cordis.patch.yml` | 新增 `client-ui-secrets` 一行（`dsh-client-ui-secrets`） |
| 测试 | `packages/host-secrets/tests/bridge.test.mjs` | 登录、无明文、筛选、vault 不存在 / 已锁定、只读 |

页面选用 **整页（main 面板 + 侧栏入口）**，与 dsh-vpn 的写法一致，而不是 token-stats 的侧栏底部卡片：
表格加筛选、搜索需要宽度，且密钥看板不是需要一直挂在眼前的信息。

## 2. 接口

两个路由都在 `/api/secrets/` 下，只接受 `GET`（其它方法 `405`，`allow: GET`），不读请求体、不写任何文件，
响应头带 `cache-control: no-store` 与 `x-content-type-options: nosniff`。

### 2.1 登录校验

与 dsh-token-stats 的 `requireLogin` 完全相同：`/api/secrets/*` 比 `dsh-client-connection` 的 `/api`
前缀路由更长，会被优先匹配，导致连接插件自己的登录检查不运行，所以在路由外再套一层：
在请求时读取 `connection` 服务并调用 `requestRejection(req)`。

| 情况 | 响应 |
| --- | --- |
| 已登录 | 交给路由处理 |
| 未登录 | `401`，`text/plain`，正文 `unauthorized` |
| 无权限 | `403`，`forbidden` |
| 没有 `connection` 服务 | `503`，`login service unavailable` |

### 2.2 `GET /api/secrets/summary`

```jsonc
{
  "generatedAt": "2026-11-22T09:30:00.000Z",
  "vault": {
    "state": "unlocked",            // missing | unlocked | locked | error
    "exists": true,
    "unlocked": true,
    "keySource": "passphrase-env",  // 或 keyfile
    "keyConfigured": true,          // 主密钥材料当前是否可用（环境变量已设 / keyfile 可读）
    "path": "/root/.dsh/secrets.vault"
    // state 为 locked / error 时另有 "error": { "code": "...", "message": "..." }
  },
  "total": 3,
  "untagged": 1,
  "tags": [ { "tag": "prod", "count": 2 }, { "tag": "ci", "count": 1 } ],  // 数量降序，再按标签名
  "lastUpdatedAt": "2026-11-22T09:10:00.000Z",       // 最近一次“值”更新；空库为 null
  "lastMetaUpdatedAt": "2026-11-22T09:12:00.000Z"    // 最近一次描述/标签更新
}
```

### 2.3 `GET /api/secrets/list?tag=&query=`

| 参数 | 含义 |
| --- | --- |
| `tag` | 精确匹配标签（区分大小写）。缺省或空串 = 不筛选 |
| `query` | 名称或描述中的子串，不区分大小写。缺省或空串 = 不筛选。**不匹配值** |

两个参数会先 `trim()`，超过 256 个字符返回 `400 { error: { code: "bad-request" } }`。
筛选逻辑与 `secret_list` 共用 `tools.js` 的 `filterNames()`，两边结果一致。

```jsonc
{
  "generatedAt": "…",
  "vault": { /* 同 summary */ },
  "filter": { "tag": "prod", "query": null },   // 实际生效的筛选（空则为 null）
  "total": 3,      // 库中全部条目数（不受筛选影响）
  "matched": 2,    // 符合筛选的条数（= items.length）
  "items": [
    {
      "name": "OPENAI_KEY",
      "description": "OpenAI API key for the eval runner",   // 完整描述（secret_list 会截断到 60 字）
      "tags": ["prod", "llm"],
      "fingerprint": "3f9a1c0b",        // sha256(value) 的前 8 位十六进制
      "length": 28,                     // 值的 Unicode 码点数
      "createdAt": "…",
      "updatedAt": "…",                 // 值最后一次变化
      "metaUpdatedAt": "…"              // 描述/标签最后一次变化
    }
  ]
}
```

每个条目都经由 `tools.js` 导出的 `item()` 生成——它就是 `secret_list` 用的同一个投影，
所以字段集合固定为上面 8 个，**不存在 `value` 字段**，也没有值的前缀/后缀/编码形式。

### 2.4 vault 状态与错误

| `vault.state` | 何时 | HTTP | `items` |
| --- | --- | --- | --- |
| `missing` | vault 文件不存在（还没 `secret_set` 过） | 200 | `[]`，**不会因此创建文件** |
| `unlocked` | 解密成功 | 200 | 正常 |
| `locked` | `error.code`：`key-missing`（没设口令/keyfile 不存在）、`decrypt-failed`（口令不对或文件损坏）、`key-invalid`（keyfile 权限/长度不符）、`key-source-mismatch`（vault 的 kdf 与 keySource 配置不一致） | 200 | `[]` |
| `error` | 其它读取失败，如 vault 文件权限带组/其他位（`vault-unreadable`） | 200 | `[]` |

只有意料之外的异常才是 `500 { error: { code: "internal" } }`。`error.message` 原样来自 `vault.js`，
其文案只会带路径或环境变量名，不含值、口令或密钥材料（测试里专门断言了错误口令不会被回显）。

解密由 `Vault#load()` 完成，bridge 不复制任何解密代码；`keyConfigured` 通过 `Vault#keyMaterial()`
判断，取到的字节立即 `fill(0)`，不出函数。解密后的条目只在一次请求内存在，交给 `item()` /
`filterNames()` 后即丢弃，与工具调用的内存行为相同。

## 3. 界面

侧栏新增一行 **“密钥”**（`sidebar.panellist`，order -25），打开主区域的 **密钥看板** 页：

- 顶部醒目的黄色提示框：**“值不可查看”**——本页只显示元数据，密钥只能通过 `secret_*` 工具使用，
  并解释指纹/长度只用于区分值、不能还原明文。
- vault 状态行：状态徽标（已解锁 / 尚未创建 / 已锁定 / 无法读取）、主密钥来源、主密钥是否就绪、
  密钥总数、最近更新时间、vault 文件路径。
- 工具栏：关键字搜索框（250 ms 防抖，Esc 清空）、标签筛选条（“全部” + 各标签及数量，再点一次取消）、
  “显示 m / n”、无标签数量、“清除筛选”。
- 表格：名称 / 描述 / 标签 / 指纹 / 长度 / 更新时间。点表格里的标签即按该标签筛选；
  更新时间显示绝对时间 + 相对时间，悬停显示创建、值更新、元数据更新三个时间。
  **没有“显示值”或“复制值”按钮**——接口里本来就没有值。
- 右上角“刷新”按钮；页面重新可见时自动刷新一次。
- 状态：
  - 加载中：“正在读取保险库…”
  - vault 不存在：“保险库还没有创建”+ 用 `secret_set` / `ingest-file.mjs` 的提示
  - 空库：“保险库是空的”
  - 筛选无结果：“没有匹配的密钥”+ 清除筛选按钮（并提示搜索不匹配值）
  - 已锁定 / 无法读取：横幅说明原因（按 `error.code` 给出修复建议）+ 原始错误信息
  - 接口失败且无旧数据：错误卡片 + 重试（401/403 提示重新登录，503 提示登录服务或接口未挂载）
  - 接口失败但有旧数据：保留旧表格，顶部提示“刷新失败，下面是 hh:mm:ss 的数据”
- 中英文：`locale` 命名空间 `secretsDashboard`，`zh` / `en` 两套词典（`src/client/locales.ts`，
  `en` 用 `Record<keyof typeof zh, string>` 约束，缺键会在类型检查时报错）。
- 配色全部取自 `--dsw-alias-*`，深浅色主题跟随外壳；样式类名统一 `dss-` 前缀。

## 4. 构建

浏览器侧 `packages/client-ui-secrets/lib/client.js` 是构建产物，**仓库里没有提交**
（这次修改是在没有 node / esbuild 的环境里完成的）。需要在有 Node ≥ 22 和 esbuild 的机器（通常就是服务器）上构建：

```bash
cd /path/to/dsh-warroom/plugins/dsh-secrets
node scripts/build.mjs
# 或指定 esbuild 所在的 node_modules：
DSH_CLIENT_MODULES=/path/to/some/node_modules node scripts/build.mjs
```

`scripts/build.mjs` 会：

1. 对 host-secrets 的 7 个模块 `node --check`（含新增的 `bridge.js`）；
2. 按顺序寻找 esbuild：`DSH_CLIENT_MODULES` → `client-ui-secrets/node_modules` →
   同级 `dsh-token-stats` / `dsh-vpn` / `dsh-router-b` 客户端包的 `node_modules`，找到后给
   `client-ui-secrets` 建一个 `node_modules` 链接（Windows 上是 junction）；
3. 运行 `packages/client-ui-secrets/scripts/build-client.mjs`，输出
   `window.__ModuleLoader__.load({id:"dsh-client-ui-secrets",factory:…})` 信封格式的 `lib/client.js`，
   React 与 `@deepseek-ai/*` 均为 external；
4. 校验产物：信封前缀、无运行时 `require("@deepseek-ai/…")`、包含 `secrets/page` / `sidebar.panellist` / `/api/secrets`。

可选的类型检查（需要 typescript 与 @types/react）：

```bash
cd packages/client-ui-secrets && npx tsc -p tsconfig.json --noEmit
```

宿主侧测试：

```bash
cd plugins/dsh-secrets && node --test packages/host-secrets/tests/*.test.mjs
```

## 5. 安装

```bash
# 先预演，再真跑（幂等，可重复执行）
node scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run
node scripts/install.mjs --profile /root/.dsh/profiles/web
```

安装脚本现在会处理三个包：`dsh-secrets`、`dsh-host-secrets`、`dsh-client-ui-secrets`
（profile `package.json` 里的 `link:` 依赖 + `node_modules` 目录链接/junction），只把 `dsh-secrets`
登记进 `dsh.profile.bundles`。若 `lib/client.js` 还没构建，会打印 warning——此时工具照常可用，只是没有看板页。
`--uninstall` 会同时移除三项。

装完重启 profile 所属服务（何时重启由运维决定），日志里应出现：

```
dsh-secrets: read-only dashboard bridge mounted at /api/secrets/{summary,list}
dsh-secrets: vault /root/.dsh/secrets.vault (keySource passphrase-env), 10 tools registered
```

然后在浏览器里（已登录）验证：

```bash
# 未登录应为 401
curl -i https://<host>/api/secrets/summary
# 浏览器开发者工具里看 /api/secrets/list 的响应：只有 8 个元数据字段，无 value
```

## 6. 安全说明

- 看板暴露的信息与 `secret_list` 相同（另加完整描述和 vault 状态），对象是已登录的 Web 用户。
  指纹是 `sha256` 前 8 位：对 API key / token 这类高熵值无风险，但极短、低熵的值（如 4 位 PIN）
  理论上可被枚举，与 USAGE.md §7 的说明一致。
- 搜索只匹配名称和描述；用值去搜索得不到任何结果，页面不能被当作“猜值”的预言机（测试覆盖）。
- 接口是只读的：不提供删除、改名、写入；这些仍然只能由智能体通过 `secret_*` 工具完成。

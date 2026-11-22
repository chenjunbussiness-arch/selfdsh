# dsh-secrets 使用手册

`dsh-secrets` 是 DeepSeek Harness 的本地加密保险库：**代理可以写入和使用密钥，但永远读不回来**。
没有 `secret_get`，也没有任何代码路径会返回一个值。

本手册的每条结论都来自本仓库的实现：

- `DESIGN.md`（威胁模型、文件格式、脱敏设计）
- `scripts/install.mjs`（安装器）
- `cordis.patch.yml`（bundle 挂载行与默认 config）
- `packages/host-secrets/{config.js,tools.js,vault.js,placeholders.js,redact.js}`

## 0. 速览

| 项 | 值 |
|---|---|
| vault 文件 | `<DSH_HOME 或 ~/.dsh>/secrets.vault`，AES-256-GCM，0600 |
| 主密钥来源 | `keySource: passphrase-env`（默认）或 `keyfile` |
| 口令环境变量 | `passphraseEnv`，默认 `DSH_SECRETS_PASSPHRASE` |
| keyfile | `keyfilePath`，默认 `<DSH_HOME>/secrets.key`，必须 0600 |
| 条目字段 | `value`、`description`、`tags`、`createdAt`、`updatedAt`、`metaUpdatedAt`（`fingerprint`、`length` 按需算，不落盘） |
| 名字正则 | `/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/` |
| 工具数量 | 10 个，启动日志会打印 `10 tools registered` |
| 只读看板 | Web 侧栏“密钥”页 + `GET /api/secrets/summary`、`GET /api/secrets/list`（登录校验，只有元数据/指纹/长度），见 [DASHBOARD.md](DASHBOARD.md) |

10 个工具：`secret_set`、`secret_describe`、`secret_list`、`secret_check`、`secret_rename`、
`secret_delete`、`secret_exec`、`secret_http`、`secret_export`、`secret_import`。

`DSH_HOME` 未设置时就是 `~/.dsh`（`config.js` 的 `dshHome()`）；本机是 `/root/.dsh`，
所以默认路径是 `/root/.dsh/secrets.vault` 和 `/root/.dsh/secrets.key`。

---

## 1. 安装

工作目录：`/srv/workspace/deepseek-harness/dsh-secrets`。示例 profile 用本机的
`/root/.dsh/profiles/web`。

### 1.1 先 dry-run，再真跑

```bash
cd /srv/workspace/deepseek-harness/dsh-secrets
node scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run
```

dry-run 不写任何文件，只打印 `would change N thing(s) in <profile>:` 和逐条动作。
确认清单没问题、并且**用户已经同意改这个 profile** 之后，再跑同一条命令去掉 `--dry-run`：

```bash
node scripts/install.mjs --profile /root/.dsh/profiles/web
```

脚本本身**不会弹确认框**，也不会跑包管理器（profile 级 `pnpm install` 会重写整棵依赖树）。
它做的三件事，每一件都可重复执行（幂等，已装则打印 `already installed`）：

1. profile 的 `package.json` 里，`dependencies` 写入
   `dsh-secrets: link:<本仓库>`、`dsh-host-secrets: link:<本仓库>/packages/host-secrets` 和
   `dsh-client-ui-secrets: link:<本仓库>/packages/client-ui-secrets`（只读看板页）；
2. `dsh.profile.bundles` 里保证有 `dsh-secrets`，并把两个子包从 bundles 里移除
   （它们是被引用的库，不是 bundle）；
3. 在 `<profile>/node_modules/` 下建这三个名字的目录软链（Windows 上是 junction）。

看板页的浏览器产物 `packages/client-ui-secrets/lib/client.js` 需要先 `node scripts/build.mjs`
构建；没构建时安装脚本只打印 warning，工具不受影响。详见 [DASHBOARD.md](DASHBOARD.md) §4–§5。

其它副作用与前置条件（都来自 `install.mjs`）：

- 每次改写 `package.json` 前，会留一份 `<profile>/package.json.bak-install-<时间戳>`；
- profile 目录必须有 `package.json`（否则 `not a DSH profile (no package.json)`，退出码 2）；
- 必须有 `dsh.profile.bundles` 数组（否则 `profile package.json has no dsh.profile.bundles array; refusing to guess`，退出码 2）；
- profile 路径支持 `~`，参数只有 `--profile`、`--dry-run`、`--uninstall`、`--help`，其它参数报
  `unknown argument: X` 并退出码 2。

### 1.2 卸载

```bash
node scripts/install.mjs --profile /root/.dsh/profiles/web --uninstall
```

只做反向的三件事：删掉三个 `dependencies`、从 `bundles` 里删 `dsh-secrets`、删三个软链。
**vault 文件和 keyfile 原样保留**，不会删数据；要销毁数据得自己 `rm`。

### 1.3 装完要重启，还是 HMR 就够？

- **HMR 只对客户端 bundle 有效**（例如 `client-ui-*/lib/client.js` 这类浏览器侧产物）。
- `dsh-secrets` 的工具与看板接口是**宿主侧 Node 代码**（`packages/host-secrets/*.js`），DSH 只在**启动时**
  加载一次（看板页 `client-ui-secrets/lib/client.js` 是浏览器侧产物，重建后刷新页面即可，但首次挂载仍需重启）。所以装完、改完源码、改完 profile 的 `cordis.patch.yml`，都必须重启。
- 重启走：

```bash
bash /srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-restart.sh
```

  它会先等在飞任务结束（`WAIT_MIN` 分钟，`--now` 跳过）、停 `dsh-web.service`、若存在
  `lib.next/` 就换进 `lib/`、再启动、探活 `/api/router/board`，失败时回滚 `lib.prev/`。
- 本包是 `link:` 源码直挂，没有 `lib/` 构建产物，**不需要** `safe-build-host.sh`。反过来，
  任何宿主插件的 `lib/` 都不要手写——那是 DSH 启动时加载的目录。
- 重启后确认装上了：

```bash
grep 'dsh-secrets:' /var/log/dsh-web.log | tail -1
# dsh-secrets: vault /root/.dsh/secrets.vault (keySource passphrase-env), 10 tools registered
```

### 1.4 把口令交给 DSH 服务进程

**推荐：写进 `<DSH home>/.env`（默认 `/root/.dsh/.env`），插件自己读取。**

```bash
install -m 600 /dev/null /root/.dsh/.env        # 已存在就跳过这一步
echo "DSH_SECRETS_PASSPHRASE='你的口令'" >> /root/.dsh/.env
chmod 600 /root/.dsh/.env
```

- 查找顺序：① 进程环境变量 `DSH_SECRETS_PASSPHRASE`（非空才算）→ ② `envFile` 里的同名行。
- `.env` 修改后自动生效（按文件修改时间和大小检测），不用重启。
- 路径和变量名在 profile 的 `cordis.patch.yml` 里配置（`vaultPath`、`passphraseEnv`、`envFile`），见 §1.6。
- 用这种方式时口令不在 DSH 进程的环境变量里，所以 `secret_exec` 起的子进程也继承不到它。
- 文件对组或其他用户可读时，日志里会提醒 `chmod 600`，但不会打印任何值。

下面两种（systemd 注入）仍然可用，进程环境变量优先于 `.env`：


服务是 `dsh-web.service`（`User=root`，`StandardOutput=append:/var/log/dsh-web.log`）。
只有该进程的环境里有 `DSH_SECRETS_PASSPHRASE`，工具才能解密；在交互 shell 里 `export` 对
systemd 启动的服务无效。

**推荐：EnvironmentFile（权限 600，不暴露在 `systemctl cat` 里）**

```bash
install -m 600 /dev/null /etc/dsh-secrets.env
printf 'DSH_SECRETS_PASSPHRASE=%s\n' '你的口令' >> /etc/dsh-secrets.env
systemctl edit dsh-web.service        # 写入下面两行
# [Service]
# EnvironmentFile=/etc/dsh-secrets.env
systemctl daemon-reload
bash /srv/workspace/deepseek-harness/dsh-router-b/scripts/safe-restart.sh
```

**另一种：drop-in 里直接 `Environment=`**

```bash
systemctl edit dsh-web.service
# [Service]
# Environment=DSH_SECRETS_PASSPHRASE=你的口令
chmod 600 /etc/systemd/system/dsh-web.service.d/override.conf   # drop-in 默认 0644，会进 systemctl cat
systemctl daemon-reload
```

注意 `Environment=` 的取值会被 systemd 拆词，口令里有空格、`$`、引号时用 `EnvironmentFile`
更稳。装了 drop-in 之后 `systemctl show dsh-web -p Environment` 会把口令打到终端，别在共享终端里敲。

### 1.5 或者：用 600 权限的 keyfile，不给服务传口令

```bash
head -c 32 /dev/urandom > /root/.dsh/secrets.key
chmod 600 /root/.dsh/secrets.key
ls -l /root/.dsh/secrets.key      # -rw------- 1 root root 32 ...
```

（本机 `/root/.dsh` 已存在、模式 0700：vault 只要求该目录**不被组/其他写**（`mode & 0o022`），
0700 满足，不用改；如果目录是 0775/0777 则会报 `vault directory <dir> is writable by group/other`。）

再把配置改成 `keySource: keyfile`（见 1.6）。keyfile 内容支持三种写法，代码按顺序识别：

- 64 个十六进制字符（32 字节）；
- base64 形式的 32 字节（`/^[A-Za-z0-9+/]{43}=$/`）；
- 其它情况按原始字节用，至少 32 字节。

文件带组/其他权限位会被直接拒绝：
`keyfile <path> is accessible by group/other (mode 0644); run "chmod 600 <path>" first`。
太短则是 `keyfile is too short: need 32 raw bytes, 64 hex characters or base64 of 32 bytes`。

keyfile 换来的是「服务进程环境里没有口令」，代价是「同 UID 能读这个文件」，安全性等价于口令
放在同一个账号里。两种来源**只能选一种**：已有 vault 的 kdf 与配置不符会被拒绝
（`vault uses kdf "scrypt" but keySource is "keyfile"`），切换不是自动迁移，要走 §4 的导出/导入。

### 1.6 在 profile 的 cordis.patch.yml 里覆盖配置

bundle 自带的 `cordis.patch.yml` 只挂了这一行：

```yaml
- insert:
    - id: host-secrets
      name: dsh-host-secrets
      config:
        keySource: passphrase-env
        passphraseEnv: DSH_SECRETS_PASSPHRASE
        redactToolOutput: true
```

要改就写进 **profile 的** `<profile>/cordis.patch.yml`（本机 `/root/.dsh/profiles/web/cordis.patch.yml`），
用「带 id、不带 insert」的覆盖形式：

```yaml
- id: host-secrets
  name: dsh-host-secrets
  config:
    keySource: keyfile
    vaultPath: /root/.dsh/secrets.vault
    keyfilePath: /root/.dsh/secrets.key
    execAllowedCommands: [curl, git]
    httpAllowedHosts: [api.fal.ai, '*.aliyuncs.com']
    redactToolOutput: true
```

**关键坑：patch 的 `config` 是整行整体替换，不做深合并。** 覆盖时必须把想保留的每个键都重述
一遍，否则它们回到代码默认值。上面这行如果把 `redactToolOutput` 漏了，它仍然默认 `true`（默认值
相同，所以看不出来）；但漏了 `passphraseEnv` 就会回到默认的 `DSH_SECRETS_PASSPHRASE`。

config 里的未知键会抛 `dsh-host-secrets config: unknown key <key>`；类型不对会抛
`must be an integer in [min, max]` / `must be a boolean` / `must be a non-empty string` 之类，
错误信息里只有键名，不含值。改完 profile 同样要重启（§1.3）。

全部配置键（默认值与范围都取自 `config.js`）：

| 键 | 默认 | 含义与范围 |
|---|---|---|
| `vaultPath` | `<DSH_HOME>/secrets.vault` | vault 文件路径，会被 `resolve()` 成绝对路径 |
| `keySource` | `passphrase-env` | 只能是 `passphrase-env` 或 `keyfile` |
| `passphraseEnv` | `DSH_SECRETS_PASSPHRASE` | 存放主口令的环境变量名 |
| `envFile` | `<DSH home>/.env` | 读取口令的 dotenv 文件；`false` 表示只看进程环境变量 |
| `keyfilePath` | `<DSH_HOME>/secrets.key` | `keySource: keyfile` 时使用 |
| `scryptN` / `scryptR` / `scryptP` | 32768 / 8 / 1 | N 必须是 2 的幂，1024–1048576；r 1–32；p 1–16 |
| `maxOutputChars` | 65536 | exec/http 输出截断长度，256–10000000 |
| `execTimeoutMs` / `execMaxTimeoutMs` | 60000 / 600000 | 实际生效的超时是两者的较小值 |
| `execAllowedCommands` | `null`（任意） | 允许的可执行文件名列表（精确名或 basename） |
| `httpAllowedHosts` | `null`（任意） | 主机列表，支持 `*.suffix` |
| `httpTimeoutMs` | 30000 | 100–3600000 |
| `httpFollowRedirects` | `false` | 默认不跟随 3xx |
| `redactToolOutput` | `true` | 全局 post-execute 脱敏开关 |
| `redactMinLength` | 8 | 参与全局脱敏的最小值长度（码点），1–4096 |
| `lockTimeoutMs` / `lockStaleMs` | 10000 / 30000 | 跨进程锁等待与过期 |

---

## 2. 初始化 passphrase

### 2.1 它就是环境变量

没有「初始化命令」：第一次写入（`secret_set`、`secret_describe`、`secret_delete`、
`secret_rename`、`secret_import`）时，`vault.mutate()` 会按需建目录（0700）、生成新的 kdf
（16 字节 salt）并落盘。salt 只在创建时生成一次、之后一直复用，所以派生密钥不变；nonce
每次写入都是新的 12 字节随机值。

口令来自 `passphraseEnv` 指定的环境变量（默认 `DSH_SECRETS_PASSPHRASE`），按 UTF-8 原始字节
参与 scrypt。缺失时的报错是：
`master key missing: set environment variable DSH_SECRETS_PASSPHRASE`。

### 2.2 强度建议

scrypt 参数 N=32768（2^15）、r=8、p=1、16 字节 salt、32 字节 key、`maxmem` 64 MiB，一次派生
约 100 ms。这意味着**攻击者拿到 vault 文件后可以离线爆破**：安全强度几乎完全取决于口令本身的熵。

- 建议 ≥ 20 个随机字符，或 5–6 个 diceware 词；用密码管理器生成和保存。
- 不要复用登录密码、不要用别的服务的 API key、不要用一句话里的常见词。
- 想要「不靠人记」就选 keyfile：32 字节随机数，熵最高（`head -c 32 /dev/urandom`）。
- N/r/p 只影响**新建**的 vault 和导出文件；已存在的 vault 永远按它自己 header 里的参数打开，
  改 `scryptN` 不会让旧文件不可读，也不会给旧文件升级参数。

### 2.3 它存在哪

- **不在 vault 里**。vault 文件里只有 `format/version/kdf/cipher/nonce/tag/ciphertext` 这些字段，
  `kdf` 只含参数和 salt，没有任何口令或密钥材料。密文里是 entries，口令不在里面。
- **不在任何文件里**（选择 `passphrase-env` 时）：代码只从环境变量读，写完不落盘。
- 派生的 32 字节 key 会在进程内存里缓存（键是 `sha256(kdf 参数 + salt + key material)`，最多 16 条），
  因为 scrypt 太慢；**解密后的条目从不缓存**，每次操作读、解、用、丢。导出用的 passphrase
  `cache: false`，从不进缓存。
- 换口令/换 keySource 目前没有 rekey 工具，只能导出 → 改配置 → 导入（§4）。

---

## 3. 日常使用

所有工具返回的都是元数据或脱敏后的输出，**没有例外**。错误统一抛 `Error(message)`，消息里最多
出现名字，不会出现值或口令。

| 工具 | 参数 | 返回 |
|---|---|---|
| `secret_set` | `name`、`value`（必填）、`description?`、`tags?` | `{name, fingerprint, length, created, hint?}` |
| `secret_describe` | `name`、`description?`、`tags?`（至少一个） | `{name, fingerprint, length, description, tags, updatedAt, metaUpdatedAt}` |
| `secret_list` | `tag?`、`query?` | `{items, total}` |
| `secret_check` | `name`、`value?` | `{name, exists, fingerprint?, matches?}` |
| `secret_rename` | `from`、`to`、`overwrite?`（默认 false） | `{from, to, overwritten}` |
| `secret_delete` | `name` | `{name, deleted: true}` |
| `secret_exec` | `command`、`args?`、`secrets`、`env?`、`cwd?`、`timeoutMs?` | `{command, args, exitCode, signal, success, timedOut, aborted, stdout, stderr, truncated, injected}` |
| `secret_http` | `url`、`method?`、`headers?`、`body?`、`timeoutMs?` | `{status, ok, url, redirected, headers, body, truncated}` |
| `secret_export` | `path`、`passphrase`（≥8 字符） | `{path, sha256, entries, bytes}` |
| `secret_import` | `path`、`passphrase`、`strategy`、`onConflict?` | `{strategy, added, overwritten, skipped, removed}` |

### 3.1 写入：`secret_set`

```json
{"name": "FAL_API_KEY_PROD",
 "value": "<粘贴真实 key>",
 "description": "fal.ai 生图额度兑换 key",
 "tags": ["ai", "image", "prod"]}
```

返回：

```json
{"name": "FAL_API_KEY_PROD", "fingerprint": "9f2c1ab4", "length": 64, "created": true}
```

- `value` 按字面存储（不 trim、不改写），必须非空，上限 64 KiB（`value is larger than 65536 bytes`）。
- 同名再写 = 覆盖值。`createdAt` 保留，`description`/`tags` 保留旧值（除非本次显式给了），
  `updatedAt` 变；`metaUpdatedAt` 只在元数据变化或新建时变。
- 新建且描述为空时额外返回 `hint: "建议补充描述 (description)"`。
- `description` 上限 4000 字符；`tags` 最多 32 个、每个 1–64 字符且**不能含空格或逗号**，
  重复项自动去重。

### 3.2 改元数据：`secret_describe`

```json
{"name": "FAL_API_KEY_PROD",
 "description": "fal.ai 生图额度兑换 key（生产，充值额度）",
 "tags": ["ai", "image", "prod", "billing"]}
```

只动元数据：`value`、`fingerprint`、`updatedAt` 不变，`metaUpdatedAt` 前进。给的是**整体替换**
（`tags` 不是追加）；两个都不给会报 `give description and/or tags`。

### 3.3 查看：`secret_list`

```json
{}                              // 全部
{"tag": "ai"}                   // 精确匹配某个 tag
{"query": "fal"}                // name 或描述的大小写不敏感子串
{"tag": "ai", "query": "生图"}   // 与关系
```

返回 `{items: [...], total: N}`，每项含
`name, description, tags, fingerprint, length, createdAt, updatedAt, metaUpdatedAt`。

- 结果按 `name` 升序。
- `tag` 是**精确**匹配；`query` 用**完整** description 匹配，但返回时 description 截到
  **60 个码点**并加 `…`（截断只影响展示）。
- `fingerprint` = `sha256(value)` 的前 8 个十六进制字符；`length` 是码点数，不是字节数。
- 这条不需要「值」，但 vault 存在时仍要能解密才列得出来；vault 文件不存在就当空库。
- 人要看同样的信息，用 Web 侧栏的 **密钥看板**（[DASHBOARD.md](DASHBOARD.md)）：同一个 `item()`
  投影、同一套筛选（`filterNames()`），描述不截断，同样不含值。

### 3.4 核对：`secret_check`

```json
{"name": "FAL_API_KEY_PROD"}
// {"name": "FAL_API_KEY_PROD", "exists": true, "fingerprint": "9f2c1ab4"}

{"name": "FAL_API_KEY_PROD", "value": "<候选值>"}
// {"name": "FAL_API_KEY_PROD", "exists": true, "fingerprint": "9f2c1ab4", "matches": true}
```

`matches` 用 `crypto.timingSafeEqual` 比较两边的 SHA-256 摘要，不泄露长度或前缀信息。适合
「迁移后抽查」「怀疑某次写入写错」这类场景——不需要把值读出来。

### 3.5 改名与删除

```json
{"from": "FAL_API_KEY", "to": "FAL_API_KEY_PROD"}
-> {"from": "FAL_API_KEY", "to": "FAL_API_KEY_PROD", "overwritten": false}
```

- `to` 已存在且没给 `overwrite: true` → `secret already exists: <to> (pass overwrite: true to replace it)`。
- `from === to` 直接返回 `overwritten: false`，不写盘。
- 时间戳随条目一起搬走，不重算。

```json
{"name": "FAL_API_KEY_DEV"}
-> {"name": "FAL_API_KEY_DEV", "deleted": true}
```

删除不可恢复（没有回收站、没有版本）。批量清理前先 §4 导出一份。

### 3.6 注入环境变量：`secret_exec`

```json
{"command": "curl",
 "args": ["-sS", "-H", "Authorization: Bearer $FAL_API_KEY_PROD", "https://api.fal.ai/v1/status"],
 "secrets": ["FAL_API_KEY_PROD"]}
```

名字里带 `.` 或 `-` 时（如 `github.token`）不能用数组形式，改用映射：

```json
{"command": "git", "args": ["ls-remote", "https://github.com/org/repo"],
 "secrets": {"GITHUB_TOKEN": "github.token"}, "env": {"GIT_TERMINAL_PROMPT": "0"}}
```

规则（`tools.js` 的 `secret_exec`、`runChild`）：

- **没有 shell 字符串形式**：`command` + `args` 直接进 `child_process.spawn(..., {shell: false})`。
  要用管道/重定向必须显式写 `{"command": "bash", "args": ["-c", "..."]}`，让这个选择可见。
- `secrets` 两种形式：字符串数组（每个名字必须同时是合法环境变量名
  `/^[A-Za-z_][A-Za-z0-9_]*$/`，否则报
  `secret name <n> is not a valid env var name; use the mapping form {ENV_NAME: "..."}`）；
  或映射 `{ENV_NAME: secretName}`。空集合报 `secrets must name at least one secret`。
- 子进程环境 = `process.env` + `env` + 注入的密钥。`env` 的键与注入名冲突会报
  `env.<K> collides with an injected secret`。
- **脱敏**：注入值及其 base64（含去 padding）、base64url、URL 编码、大小写 hex 形式，在
  stdout/stderr 里都被替换成 `[REDACTED:NAME]`；返回的 `command`/`args` 回显也过同一套替换。
- **输出**：stdout/stderr 各最多收 1 MiB，然后脱敏、截到 `maxOutputChars`（65536），
  `truncated.stdout` / `truncated.stderr` 标记是否截断。收集撞到 1 MiB 上限时会先丢掉末尾
  等于「最长脱敏形式」长度的字符，避免被切断的值以未脱敏前缀漏出。
- **结果**：`exitCode`、`signal`、`timedOut`、`aborted`、`success`（`exitCode === 0` 且未超时未中断）、
  `injected: [{env, name, fingerprint}]`。
- **超时**：`timeoutMs` 默认 `execTimeoutMs`（60000），并被 `execMaxTimeoutMs`（600000）封顶；
  超时/中止先 SIGTERM，2 秒后 SIGKILL。
- **报错**：未知名字 `secret not found: NAME`；命令被白名单挡住
  `command not allowed by execAllowedCommands: <basename>`；起不来
  `failed to start command: ENOENT`（只给 code，不给命令行）。
- `execAllowedCommands` 默认 `null` 表示任意；设成列表后按「精确名或 basename」匹配。

### 3.7 带密钥发 HTTP：`secret_http`

```json
{"method": "POST",
 "url": "https://api.fal.ai/v1/requests",
 "headers": {"Authorization": "Bearer ${secret:FAL_API_KEY_PROD}", "Content-Type": "application/json"},
 "body": "{\"prompt\": \"a cat\"}"}
```

- 占位符 `${secret:NAME}` 在 **url、header 值、body** 三处都会被替换。
- `$${secret:` 是转义，输出字面量 `${secret:`；其它 `$` 原样保留。
- 错误信息：
  - 未知名字 → `secret not found: NAME`
  - 空名字、名字不合正则、缺 `}` → `malformed placeholder at offset N in url`（或 `in body`、
    `in header <Key>`），offset 是该字段里 `$` 的 0-based UTF-16 偏移
  - 协议不是 http/https → `only http: and https: URLs are allowed`
  - 主机不在白名单 → `host not allowed by httpAllowedHosts: <hostname>`
  - 网络失败 → `request failed: <code>`；超时 → `request timed out after <N> ms`
- **默认不跟随重定向**（`httpFollowRedirects: false`）。所以带着密钥的 `Authorization` 头不会被
  转发到第三方地址；3xx 的 `status` 和脱敏后的 `location` 头会原样返回，`redirected` 为 `false`。
  需要跟随就显式把 `httpFollowRedirects` 设成 `true`，并同时收紧 `httpAllowedHosts`。
- `httpAllowedHosts` 默认 `null` = 任意主机；可以写精确 host 或 `*.suffix`，校验的是**替换后**的
  URL 主机名（`*.aliyuncs.com` 不匹配 `aliyuncs.com` 本身）。
- 返回里 response headers 和 body 都经过脱敏，body 再截到 `maxOutputChars`；
  `truncated` 是布尔值。
- `method` 默认 `GET`，只接受字母（`/^[A-Za-z]{1,16}$/`）；`timeoutMs` 默认 `httpTimeoutMs`（30000）。
- 提示：把密钥放 header，别放 URL query——URL 会进 `url` 返回值、日志和浏览器历史。

---

### 3.8 按项目导入、PEM 证书与密钥清单

`secret_set` 适合一条一条写；成批的密钥和证书走仓库里的两个脚本（都在 `dsh-secrets/` 下执行）：
`scripts/ingest-file.mjs` 把投放目录里的文件解析成条目写进 vault，`scripts/scan-keys.mjs`
只读地扫出「哪里有密钥文件」并生成清单。两者都不经过 MCP 工具：前者直接 `import`
`packages/host-secrets/vault.js` 写库，所以值不会进入会话日志；后者从不读 vault、也不输出值。

#### 3.8.1 投放目录与项目分类

```text
<keys-dir>/                    默认 /srv/workspace/keys（0700）
├── inbox/                     投放目录，等待导入
│   ├── <项目名>/              按项目分子目录（只扫一级）
│   └── <文件>                 根目录散装文件
├── processed/                 成功 / 部分成功归档（.err 在旁边）
└── rejected/                  整文件失败归档（.err 在旁边）
```

| 文件位置 | project tag | 名字前缀 |
|---|---|---|
| `<keys-dir>/inbox/<项目名>/<文件>` | 自动 `project:<项目名小写>` | **强制**：每个条目名以 `<项目名大写、非字母数字→_>_` 开头（`xhs` → `XHS_`，`my-proj` → `MY_PROJ_`） |
| `<keys-dir>/inbox/<文件>` | 不加（与旧行为一致） | 不校验 |
| 同上 + `--project <名>` | `project:<名小写>` | 不校验（只打 tag） |

- 项目目录里**只要有一条**名字不符，整个文件进 `rejected/`、一条都不写库，退出码 1；
  `.err` 写明是哪条不符，也会列出「名字合规但因为整文件拒绝而没写入」的条目。
- 只扫描 inbox 的**一级**子目录；更深的子目录被忽略，并在运行头部提示。
- 显式 `--dir` / `--processed` / `--rejected` 优先于 `--keys-dir`；只给 `--dir` 时，
  processed/rejected 跟着它的父目录走（旧用法不变）。`--inbox` 与 `--dir` 同义。

```bash
cd /srv/workspace/deepseek-harness/dsh-secrets

# 预演：只解析，打印 name / tag / 指纹 / 长度 / 告警
node scripts/ingest-file.mjs --dry-run

# 真跑：写库 + 归档到 processed/ 或 rejected/
node scripts/ingest-file.mjs
```

上面两条省略参数时用默认的 `/srv/workspace/keys`；演练时换成 `--keys-dir /tmp/<临时目录>`
之类的临时根目录。`--dry-run` 不写库、不搬文件、不生成 `.err`，也不需要口令/keyfile，退出码 0。

根目录散装文件要统一归类就用 `node scripts/ingest-file.mjs --project <项目名> --dry-run`。
注意它**只打 tag、不校验前缀**；想真正约束命名，把文件放进 `inbox/<项目名>/`。

#### 3.8.2 PEM / 证书 / key 文件

扩展名大小写不敏感：`.pem` `.key` `.crt` `.p12`（`.PEM`、`.P12` 同样命中）。
**整个文件就是一个 secret**：

- `.pem` / `.key` / `.crt`：按 UTF-8 文本整体读入，不按行拆分、不 `trim`、不做换行归一化；
  写库前做 UTF-8 往返字节校验，保证 `sha256(value)` 等于 `sha256(源文件)`（含结尾换行）。
- `.p12`：按原始字节读入，以**标准 base64** 存储，不做 PKCS#12 解析（也不校验证书链或口令）。
- 0 字节的空文件、非法 UTF-8（例如把 DER 改名成 `.pem`）都是**整文件失败**，进 `rejected/`。
- 值上限仍是 64 KiB，超限按条目拒绝，不写库。

| 扩展名 | 追加的 tag |
|---|---|
| `.pem` | `kind:pem` |
| `.key` | `kind:key` |
| `.crt` | `kind:crt`、`kind:cert` |
| `.p12` | `kind:p12`、`kind:cert`、`binary:b64` |

此外每条都还有原有的 `src:<格式>`、`prefix:<文件名>`；在项目目录里再加 `project:<项目名>`。

默认条目名是 `<PROJECT>_<文件名去扩展名、转大写、非字母数字→下划线>`；不在项目目录时只用
文件名部分：

| 输入 | 默认条目名 |
|---|---|
| `inbox/lumen/lumen.pem` | `LUMEN_LUMEN` |
| `inbox/xhs/ca.crt` | `XHS_CA` |
| `inbox/solo.pem`（根目录，无 `--project`） | `SOLO` |
| `--project ACME` + `inbox/root.pem` | `ACME_ROOT` |

文件第一行写成 `# name: XXX` 时，用 `XXX` 覆盖默认名；**该行仍原样保留在值里**，整文件
`sha256` 不变。覆盖名同样要匹配名字正则，放在项目目录里也必须以项目前缀开头，否则整文件被拒。

#### 3.8.3 JSON 的三种条目形态

对象形态里每个 key 支持三种写法，**逐条处理，单条跳过不影响整文件**：

| 写法 | 行为 |
|---|---|
| `{"NAME": "value"}` | 直接写入 |
| `{"NAME": {"value": "v", "description": "d", "tags": ["a"]}}` | `value` 写入，`description`/`tags` 一并入库（与自动 tag 合并去重） |
| `{"NAME": {"id": "...", "secret": "..."}}` 等缺 `value` 键的对象 | 只跳过该条，提示「一个 key 一个条目：`{"NAME": {"value": "..."}}`」 |

- `value` 不是字符串（`123`、`null`、数组）、`description` 不是字符串、`tags` 不是字符串数组：
  都只跳过该条并写进 `.err`，绝不让整文件失败。`tags` 里的非字符串元素被丢掉，`.err` 里提示。
- 数组形态 `[{"name": ..., "value": ..., "description"?, "tags"?}]` 维持旧行为，同样逐条跳过。
- **空值**（空字符串或纯空白）在所有格式里都跳过；`.err` 里把所有空值**合并成一段**
  `empty-values（N 条）`，每行 `NAME: 空值已跳过`，不会刷成 N 个错误段。
- **同一文件内两个不同名字的值 sha256 相同**：告警 `A 与 B 值完全相同（指纹 xxxxxxxx）`，
  只给指纹前 8 位；写进 `.err` 和运行汇总，`--dry-run` 也显示。**仅告警，不改变退出码。**

#### 3.8.4 部分成功、`.err` 与退出码

| 结局 | 归档位置 | `.err` |
|---|---|---|
| 全部成功 | `processed/` | 无 |
| 部分成功（有条目/空值被跳过，或有同值告警） | `processed/` | `processed/<文件>.err` |
| 整文件失败（语法错、读不了、没有解析出条目、项目前缀不符） | `rejected/` | `rejected/<文件>.err` |

`.err` 只含文件路径、名字、行号或条目序号、原因和 8 位指纹，**不含值**，和归档文件同目录同名。
归档是扁平的，不保留项目子目录；同名文件由脚本加时间戳，不会互相覆盖。

| 退出码 | 含义 |
|---|---|
| 0 | 全部成功（或 dry-run） |
| 1 | 有条目/空值被跳过、有文件被拒绝（含前缀校验失败）、归档或 `.err` 写入失败 |
| 2 | 参数/环境/解锁错误（没有写入任何东西） |
| 3 | 写库失败（没有搬动文件） |

#### 3.8.5 只读清单：`scan-keys.mjs`

```bash
# 扫默认根目录 /srv/workspace，清单打到 stdout
node scripts/scan-keys.mjs

# 写清单（真实清单就放在 keys 目录下）
node scripts/scan-keys.mjs /srv/workspace --out /srv/workspace/keys/key-inventory.md

# 防泄漏自检：重新扫描，检查清单里是否出现任何值片段
node scripts/scan-keys.mjs /srv/workspace --audit /srv/workspace/keys/key-inventory.md

# 在 stderr 打印各阶段耗时与计数（不含值）
node scripts/scan-keys.mjs --verbose
```

- 参数：`[root]`（默认 `/srv/workspace`）、`--out FILE`（省略则 stdout）、`--audit FILE`
  （只自检，命中则退出码 4）、`--verbose`、`-h/--help`。
- 输出列：文件路径、名字、疑似类型、文件大小、最后修改时间(UTC)、长度桶
  （`1-15` / `16-31` / `32-63` / `64-127` / `128+`）、值 `sha256` 前 8 位、疑似重复
  （同组 `dup-1`、`dup-2`…）、建议项目（按路径最深目录段猜，猜不出写「待定」）。
  清单另有概览、重复组、已忽略的示例文件、已跳过/无法解析几张表。
- 安全保证：清单和终端输出**只出现**名字、类型、大小、时间、长度桶和 `sha256` 前 8 位，
  不会输出任何真实值、值前缀/后缀或掩码片段；`--audit` 会重新扫描并检查清单里是否出现值的
  任意 8 字符窗口，命中就拒绝通过。脚本不写被扫描文件，也不接触 vault。
- 剔除规则：`.env.example` / `.env.sample` / `*.template` / `*.dist` 这类示例文件只列进
  「已忽略的示例文件」；空值和 `<your-token>`、`${VAR}`、`changeme`、`xxxx` 之类占位符不计数；
  `pem`/`cert` 按文件整份算一个条目，`sha8` 是文件字节的哈希。
- 真实清单的位置是 `/srv/workspace/keys/key-inventory.md`（0600），每轮导入后重建。它只回答
  「哪里有、像什么、是否重复」，不回答「值是什么」。

#### 3.8.6 安全与顺序

- 先在临时 `DSH_HOME` 里演练（`mktemp -d` + `DSH_HOME=<临时目录>`），别拿真实 vault 试错，
  演练完删掉临时目录。
- 任何时候不要把值、值的片段或指纹以外的东西贴进聊天/日志/工单；脚本的 stdout 和 `.err`
  已经按这个原则设计。
- 导入真实文件前**必须先 `--dry-run`**，看清 name / tag / 前缀 / 空值 / 同值告警再真跑。
- 命名、tag、轮换、`processed/` 明文清理的规范见 `/srv/workspace/keys/key-policy.md`；
  投放目录的说明见 `/srv/workspace/keys/README.md`。
- 命令与参数以脚本 `--help` 为准：`node scripts/ingest-file.mjs --help`、
  `node scripts/scan-keys.mjs --help`。

---

## 4. 导出并迁移到新机器

导出文件是**独立加密**的：`format: "dsh-secrets-export"`，用导出时给的口令 + 新的 salt 重新
scrypt，跟 vault 的主口令/主 key 完全无关。描述、tags、时间戳都在密文里，明文只有 header。

### 4.1 老机器：导出

先记一份清单（条目数、名字、描述，方便之后对比）：

```json
{"tag": "prod"}
```

然后导出到一个**已存在的目录**（会在这个目录里自动起名
`secrets-export-YYYYMMDDTHHMMSSZ.dshvault`）：

```json
{"path": "/root/backup", "passphrase": "<导出专用强口令，≥8 字符>"}
```

返回：

```json
{"path": "/root/backup/secrets-export-20261120T155118Z.dshvault",
 "sha256": "3f9c...（64 位十六进制）", "entries": 12, "bytes": 3456}
```

- `path` 也可以是文件路径，但该文件**必须不存在**（以 `wx` 打开，绝不覆盖），否则
  `file already exists: <path>`；父目录不存在报 `directory does not exist for <path>`。
- 文件以 0600 创建并 fsync。
- `passphrase` 少于 8 字符直接 `passphrase must be at least 8 characters`；这个口令与 vault
  主口令无关，可以是另一个。

### 4.2 校验 sha256

```bash
sha256sum /root/backup/secrets-export-20261120T155118Z.dshvault
# 必须和 secret_export 返回的 sha256 完全一致
ls -l /root/backup/secrets-export-20261120T155118Z.dshvault   # -rw------- 
```

这个 sha256 是文件文本内容的摘要，所以拷贝/传输之后再算一次，两边一致才说明文件没坏、没被截断。

### 4.3 传到新机器并复核

```bash
scp /root/backup/secrets-export-20261120T155118Z.dshvault newhost:/root/backup/
ssh newhost 'sha256sum /root/backup/secrets-export-20261120T155118Z.dshvault'
```

两边一致再往下走。传输后如果权限变宽（例如 0644），先 `chmod 600`。

### 4.4 新机器：装插件、设新的主密钥

1. 装插件（§1.1 的 dry-run + 真跑），重启，确认日志里有 `10 tools registered`。
2. 给新机器设**它自己的**主密钥（跟导出 passphrase 无关，可以不同）：
   - 口令路线：`/etc/dsh-secrets.env` 里写 `DSH_SECRETS_PASSPHRASE=...`，drop-in 引
     `EnvironmentFile`，`daemon-reload` 后重启；或
   - keyfile 路线：`head -c 32 /dev/urandom > ~/.dsh/secrets.key && chmod 600 ~/.dsh/secrets.key`，
     并把 `keySource: keyfile` 写进 profile 的 `cordis.patch.yml`（§1.6）。
3. 新 vault 此时还不存在，第一次写入时会自动创建。

### 4.5 导入：merge 还是 replace

```json
{"path": "/root/backup/secrets-export-20261120T155118Z.dshvault",
 "passphrase": "<导出时的口令>",
 "strategy": "merge",
 "onConflict": "skip"}
```

- `strategy: "merge"`：只加新名字；同名条目由 `onConflict` 决定——
  `"skip"`（默认，保留新机器上的值）或 `"overwrite"`（用文件里的值覆盖）。
  返回 `{strategy, added, overwritten, skipped, removed: 0}`。
- `strategy: "replace"`：让 vault **恰好等于**导入集合，新机器上不在文件里的名字会被删掉
  （`removed` 计数），同名条目算 `overwritten`。`replace` 不允许带 `onConflict`
  （`onConflict applies to strategy "merge" only`）。
- 导入的条目**保留原有时间戳**。
- 导入文件的 kdf 必须是 scrypt（`export file must use scrypt`）。

### 4.6 验证

**一、条目和元数据对得上**：列一遍清单，比对 `total` 与老机器的条目数，抽查几条的
`description` / `tags` / `fingerprint`。

```json
{}
```

**二、值对得上**（不需要读出值，用候选值比对）：

```json
{"name": "FAL_API_KEY_PROD", "value": "<老机器上那份 key>"}
-> {"name": "FAL_API_KEY_PROD", "exists": true, "fingerprint": "9f2c1ab4", "matches": true}
```

**三、端到端可用**：挑一个无副作用、只读的调用，看 `exitCode` 和状态码，而不是看密钥。

```json
{"command": "curl",
 "args": ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "-H", "Authorization: Bearer $FAL_API_KEY_PROD",
          "https://api.fal.ai/v1/status"],
 "secrets": ["FAL_API_KEY_PROD"]}
```

### 4.7 常见导入失败

| 报错 | 含义 |
|---|---|
| `decryption failed: wrong passphrase or corrupted file` | 导出 passphrase 错，或文件被改过/截断（GCM 认证失败） |
| `file is not a dsh-secrets-export v1 file` | 拿错文件（例如把 `secrets.vault` 当导出文件）或 JSON 坏了 |
| `cannot read import file <path>: ENOENT` | 路径不对 |
| `import file payload is malformed` | 文件结构对但内容不合法 |
| `export file must use scrypt` | header 的 kdf 不是 scrypt |

**迁移收尾**：确认无误后 `rm` 掉传输用的导出文件副本；导出文件本身就是密文，但仍按密钥对待
（它 + 口令 = 全部密钥）。老机器的 vault 是否删除由你决定，删了就没有回退路径。

---

## 5. 忘记 passphrase 会怎样

**vault 的主口令或 keyfile 丢了 = 数据永久丢失。** 没有恢复码、没有后门、没有密钥托管：
`vault.js` 里没有任何恢复分支，唯一的失败信息是
`decryption failed: wrong passphrase or corrupted file`（口令错和数据损坏在密码学上不可区分）。
文件还在、字节完好，也打不开。

几条容易混淆的边界：

- **导出 passphrase 是独立的**：它不参与 vault 解密，vault 主口令也不参与导出文件解密。
  所以「导出文件的口令忘了」只损失那份导出；「vault 口令忘了」不影响你已经导出的文件——
  这正是导出存在的意义。前提是导出时用的口令你还记得。
- **keyfile 和口令不能互相救**：`keySource` 只能选一种；vault header 里的 kdf 决定它能被哪种
  材料打开。丢了 keyfile 不能靠猜 `DSH_SECRETS_PASSPHRASE` 打开。
- **fingerprint 不是备份**：它只是 `sha256(value)` 的前 8 位，反推不出值。
- **没有 rekey/恢复工具**：忘记口令时唯一的「抢救」是去翻旧备份、旧导出文件、旧机器上的
  vault 副本。

建议：

1. 口令/密钥文件进密码管理器（或离线保险箱），**和 vault 分开存**；
2. keyfile 单独备份一份到另一处（它 32 字节，抄下来很容易）；
3. 定期做一次演练：在新目录/新机器上 `secret_import` 一次，确认导出文件真的能打开；
4. 不要把口令写进 `description`/`tags`（这些会被 `secret_list` 原样返回给模型，见 §6）。

---

## 6. 怎么起名和写描述

### 6.1 名字

正则：`/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/` —— 字母或 `_` 开头，之后是字母、数字、`_`、`.`、`-`，
最长 128 字符。`.` 和 `-` 是为了可读性（`github.token`）而允许的，但 `secret_exec` 的**数组形式**
还要求名字同时是合法环境变量名（`/^[A-Za-z_][A-Za-z0-9_]*$/`，不含 `.`/`-`），所以带点的名字在
exec 里必须用映射形式。取名时直接全大写 + 下划线最省事。

推荐 `provider_purpose_env` 三段式，全部符合上面的正则：

| 名字 | 说明 |
|---|---|
| `FAL_API_KEY_PROD` | fal.ai 生产 key |
| `ALIYUN_RAM_ECS_POWER_AK` | 阿里云 RAM 子账号 AK，权限只有 ECS 开关机 |
| `OPENAI_API_KEY_DEV` | OpenAI 开发环境 key |

要点：

- **服务/提供方**在前（`FAL`、`ALIYUN_RAM`、`OPENAI`），**用途**在中间（`ECS_POWER`、`IMAGE_GEN`），
  **环境**在后（`PROD` / `STAGING` / `DEV`）。按这个顺序检索和排序都顺。
- 权限越窄，名字里越要写出来（`ECS_POWER` 而不是笼统的 `ALIYUN_AK`），以后不会误用。
- 同一服务的多套 key 必须带环境后缀，别靠「后来那个」。

### 6.2 描述

描述是给人**和模型**看的检索依据（`secret_list` 的 `query` 就在里面搜）。写「这是什么 + 用在哪 +
权限范围」：

- 「fal.ai 生图额度兑换 key」
- 「阿里云 RAM 子账号 AK，仅 ECS 开关机」
- 「GitHub 只读 PAT，只给 repo:status 用」

**反例（不要写）：**

- ❌ 值本身或它的任何片段：`sk-abc...`、`末尾 4 位 1234`、`前缀 fal_`；
- ❌ 口令提示：「就是我的常用密码 + 123」「和邮箱同一个密码」；
- ❌ 账号登录密码、控制台密码、验证码；
- ❌ 只写「测试」「临时」「key」这类无法检索、也无法判断权限的词。

### 6.3 tags

- 示例：`cloud`、`ai`、`deploy`、`prod`、`readonly`、`image`。
- 规则：最多 32 个，每个 1–64 字符，**不能含空格或逗号**（正则 `/^[^\s,]{1,64}$/`），重复自动去重。
- `secret_list` 的 `tag` 是精确匹配，所以标签要统一小写、统一词表（别混 `AI`/`ai`）。
- 用两三个维度组合即可：`cloud` + `prod` + `deploy`；`ai` + `image`。

### 6.4 description/tags 到底在不在密文里？

**在。** 明文 payload 是
`{ "entries": { "NAME": { "value", "description", "tags", "createdAt", "updatedAt", "metaUpdatedAt" } } }`，
整体 AES-256-GCM 加密。vault 文件里可读的只有 `format`、`version`、`kdf`（含 salt 和 scrypt 参数）、
`cipher`、`nonce`、`tag` 这些 header 字段，以及不透明的 `ciphertext`（密文的 base64）；描述和
标签都在后者里面。导出文件同理。

但这**不代表它们可以写敏感信息**：`secret_list` 会把 `description`（截到 60 码点）和 `tags`
原样返回给模型，并进入会话记录。所以把描述和标签当成「会展示给模型、会留在会话日志里」的
信息来写——它们是元数据，不是保险库里的秘密。

---

## 7. 安全边界与局限

诚实地照 `DESIGN.md` 的威胁模型抄一遍。**能防**：vault 文件被拷走/被备份/被别的 UID 读（密文 +
0600 + 0700 目录 + 拒绝组/其他权限位）、篡改（GCM 认证 header 和密文，改一字节就解不开）、
「模型随口把值说出来」（没有任何工具返回值，exec/http 输出会被脱敏）。

**不能防**：

1. **同 UID 进程**：任何以 DSH 用户身份运行的进程都能读 keyfile 或 `DSH_SECRETS_PASSPHRASE`，
   然后解密整个 vault。加密保护的是静态文件，不是被拿下的账号。本机服务是 `User=root`，
   所以 root 能读一切。
2. **`secret_exec` 可以被滥用**：子进程环境里就是明文。`printenv | base64 -w0 | rev`、把值写进
   文件、发到网络上，都能绕过脱敏。脱敏覆盖字面值以及它的 base64/base64url/URL 编码/hex
   （大小写）形式，是「常见编码的尽力而为」，不是保证——大字符串里**非对齐偏移**的 base64
   片段检测不到。缓解手段是把 `execAllowedCommands` 收紧成固定列表（如 `["curl","git"]`），
   但允许的命令加上任意参数（`bash -c ...`）就等于 shell。
3. **`secret_http` 会把密钥发到代理指定的主机**。缓解是 `httpAllowedHosts`；它的默认值是
   `null`（任意主机），这是有意的便利取舍，不是疏漏。
4. **`secret_set` 的参数会进会话日志**：DSH 在任何插件运行之前就记录工具参数并在 UI 里显示，
   所以那次调用的 `value` 会出现在会话记录里，vault 无法修复。要让值不进日志，只能换一种投递
   方式（例如在一个日志随后会删掉的会话里写）。
5. **fingerprint 可被离线猜**：它是 `sha256(value)` 的前 8 个十六进制字符。低熵的值（短 PIN）
   可以被暴力枚举；API key、token 不受影响。
6. **短值**：短于 4 字符的值只做字面脱敏（不做编码形式）；全局 post-execute 监听会跳过短于
   `redactMinLength`（默认 8）的值，以免误伤无关输出。
7. **内存**：明文在一次操作的持续时间里存在于进程内存，JS 字符串无法清零，会留到 GC。
8. **全局脱敏的覆盖面有限**：它只改模型可见的 `text` 内容块，不改其它工具的 canonical `value`，
   也不改工具参数；vault 不存在或没 key 时静默跳过（只 warn 一次）。开关是 `redactToolOutput`。
9. **文件级保护的前提**：vault 文件必须是 0600（带组/其他位会拒绝并提示 `chmod 600`），vault
   所在目录不能被组/其他写（否则提示 `chmod 700`；本机 `/root/.dsh` 是 0700，不触发）。用
   `scp`/`cp` 搬进来的 vault 副本记得 `chmod 600`。
10. **不替代 `ctx.credentials`**：LLM 的 key 仍然走 `dsh-credentials-local` 的明文 0600 YAML，
    dsh-secrets 是独立的另一个保险库，不改 profile 组成、也不改 LLM key 的解析路径。

遇到「我需要把值读回来」的需求时，先确认这不是设计目标：这个插件的全部价值在于**没有读回路径**。
需要人工核对就用 `secret_check`（比对候选值），需要搬机器就用 `secret_export` / `secret_import`。

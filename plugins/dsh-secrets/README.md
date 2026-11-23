# dsh-secrets：密钥保险库

## 这是什么

一个放在本机的**加密密钥库**（AES-256-GCM）。模型可以把 API key、token、证书等存进去，也可以“用”它们——注入成命令的环境变量，或在 HTTP 请求里用占位符代入——但**任何工具都读不回明文**。

另带一个只读的「密钥看板」页面，只显示名称、描述、标签、指纹、长度、更新时间等**元数据**，永远不显示值。

## 装好后在哪里看到

- **左侧栏多一行「密钥」**（英文界面为 “Secrets”），点开主区域的「密钥看板」页：保险库状态（已解锁 / 尚未创建 / 已锁定 / 无法读取）、主密钥来源是否就绪、密钥总数、可按标签筛选和关键字搜索的表格。**页面上没有“显示值”或“复制值”按钮**，接口里本来就没有值。
- **对模型开放的 10 个工具**：

  | 工具 | 作用 |
  |---|---|
  | `secret_set` | 写入 / 覆盖一个密钥（可带描述、标签） |
  | `secret_describe` | 只改描述和标签 |
  | `secret_list` | 列出名称和元数据（不含值） |
  | `secret_check` | 核对某个值是否与库里一致（不回显） |
  | `secret_rename` / `secret_delete` | 改名 / 删除 |
  | `secret_exec` | 把密钥注入环境变量后运行一条命令，输出里的密钥值自动打码 |
  | `secret_http` | 发 HTTP(S) 请求，URL / 请求头 / 请求体里的 `${secret:名称}` 占位符会被替换成密钥，返回内容自动打码 |
  | `secret_export` / `secret_import` | 加密导出 / 导入（迁移到新机器用） |

- 默认还会给**所有工具的文本输出**做一次打码：只要出现库里已有的密钥值（≥ 8 个字符），就替换掉。
- 宿主侧只读接口：`GET /api/secrets/summary`、`GET /api/secrets/list`（需要已登录 Web，只返回元数据）。

## 必须配置

**主口令 `DSH_SECRETS_PASSPHRASE`**（二选一，推荐第一种）：

**方式 A：写进插件自己的文件 `<DSH home>/secrets.env`**（`<DSH home>` = `DSH_HOME`，没设时是 `~/.dsh`，服务器上即 `/root/.dsh`）

```bash
install -m 600 /dev/null /root/.dsh/secrets.env      # 已存在就跳过
echo "DSH_SECRETS_PASSPHRASE='一串足够长的随机口令'" >> /root/.dsh/secrets.env
chmod 600 /root/.dsh/secrets.env
```

- 文件名是 **`secrets.env`，不是 `.env`**。
- ⚠ **绝对不要写进 `<DSH home>/.env`**：那是 DSH 自己的凭据文件，里面出现任何 `DSH_` 开头的变量，DSH 都会拒绝启动（报 `... only the launching environment may set ...`）。插件也不会从那个文件读 `DSH_` 变量。
- 改 `secrets.env` 后自动生效，不用重启。
- 也可以放进启动 DSH 的进程环境（例如 systemd 的 `EnvironmentFile=`）；进程环境变量优先于 `secrets.env`。
- 口令建议 ≥ 20 个随机字符。**忘了口令，库里的东西就再也解不开**，请用密码管理器保存。

**方式 B：改用 keyfile，不用口令**

```bash
head -c 32 /dev/urandom > /root/.dsh/secrets.key
chmod 600 /root/.dsh/secrets.key
```

然后在 profile 的 `cordis.patch.yml` 里把 `keySource` 改成 `keyfile`（见下面「可选配置」）。

**不配的后果**：工具照样注册，但任何读写都会失败，报
`master key missing: set environment variable DSH_SECRETS_PASSPHRASE`；看板显示「已锁定」（`key-missing`）。

## 可选配置

写在 profile 的 `<profile>/cordis.patch.yml` 里，按 id `host-secrets` 覆盖。**整段 `config` 会被替换、不做合并**，想保留的键（如 `passphraseEnv`）都要重写一遍：

```yaml
- id: host-secrets
  name: dsh-host-secrets
  config:
    vaultPath: /root/.dsh/secrets.vault
    keySource: passphrase-env              # passphrase-env | keyfile
    passphraseEnv: DSH_SECRETS_PASSPHRASE
    envFile: /root/.dsh/secrets.env        # 不能是 /root/.dsh/.env；false = 只看进程环境
    # keyfilePath: /root/.dsh/secrets.key  # keySource: keyfile 时用
    redactToolOutput: true
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `vaultPath` | `<DSH home>/secrets.vault` | 加密库文件（0600） |
| `keySource` | `passphrase-env` | 主密钥来源：`passphrase-env` 或 `keyfile`，两者不能混用 |
| `passphraseEnv` | `DSH_SECRETS_PASSPHRASE` | 口令所在的变量名 |
| `envFile` | `<DSH home>/secrets.env` | 读口令的 dotenv 文件；`false` = 只看进程环境变量 |
| `keyfilePath` | `<DSH home>/secrets.key` | keyfile 路径，权限必须 600 |
| `execAllowedCommands` | 不限 | `secret_exec` 允许运行的命令名列表 |
| `httpAllowedHosts` | 不限 | `secret_http` 允许访问的主机，支持 `*.example.com` |
| `execTimeoutMs` / `execMaxTimeoutMs` | `60000` / `600000` | 命令超时 / 上限 |
| `httpTimeoutMs` | `30000` | HTTP 超时 |
| `httpFollowRedirects` | `false` | 是否跟随 3xx |
| `maxOutputChars` | `65536` | 命令 / HTTP 输出截断长度 |
| `redactToolOutput` | `true` | 对所有工具输出做全局打码 |
| `redactMinLength` | `8` | 参与全局打码的最短值长度 |
| `scryptN` / `scryptR` / `scryptP` | `32768` / `8` / `1` | 口令派生参数（只影响新建的库和导出文件） |
| `lockTimeoutMs` / `lockStaleMs` | `10000` / `30000` | 跨进程文件锁 |

写了未知的键会报 `dsh-host-secrets config: unknown key <键名>`，插件不会启动。

## 怎么用

装好、配好口令、重启后，直接在对话里让模型操作，例如：

- “把这个 key 存成 `FAL_API_KEY`，描述写 fal.ai 生图，标签 `fal`” → `secret_set`
- “用 `FAL_API_KEY` 调一下 fal 的接口” → `secret_http`（请求头写 `Authorization: Key ${secret:FAL_API_KEY}`，明文不出现在对话里）
- “用 `GITHUB_TOKEN` 跑 `gh repo list`” → `secret_exec`

库文件在第一次写入时自动创建，不需要初始化命令。批量导入文件、迁移到新机器见 [docs/USAGE.md](docs/USAGE.md)。

## 安装与更新

```bash
# 1. 构建看板页的浏览器产物 packages/client-ui-secrets/lib/client.js（不构建也能用工具，只是没有页面）
node scripts/build.mjs

# 2. 装进 profile（幂等；先 --dry-run）
node scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run
node scripts/install.mjs --profile /root/.dsh/profiles/web

# 3. 先把主口令放好，再重启 DSH
```

重启后日志里应出现：`dsh-secrets: vault …/secrets.vault (keySource passphrase-env, …), 10 tools registered`。

卸载：`node scripts/install.mjs --profile <dir> --uninstall`（库文件和 keyfile 原样保留，不会删数据）。改宿主侧代码或 profile 配置后都要重启；只改了看板页，重新构建后刷新页面即可。

## 常见问题

- **DSH 启动失败，提示 `sets "DSH_SECRETS_PASSPHRASE", which only the launching environment may set`**：口令被写进了 `<DSH home>/.env`。把那一行挪到 `<DSH home>/secrets.env`，再从 `.env` 删掉。
- **`master key missing: set environment variable DSH_SECRETS_PASSPHRASE`**：没找到口令。检查 `secrets.env` 的路径、变量名拼写、是否是空值。
- **看板显示「已锁定」`decrypt-failed`**：口令不对或库文件损坏。
- **`keyfile ... is accessible by group/other`**：`chmod 600` keyfile。太短会报 `keyfile is too short`（需要 32 字节、64 位十六进制或 32 字节的 base64）。
- **`vault uses kdf "scrypt" but keySource is "keyfile"`**：已有的库是用口令建的，不能直接切换来源；要先导出、改配置、再导入（见 USAGE.md §4）。
- **日志提醒 `chmod 600`**：`secrets.env` 对组或其他用户可读，收紧权限（日志不会打印值）。
- **用了 `secrets.env` 后，`secret_exec` 的子进程里没有 `DSH_SECRETS_PASSPHRASE`**：这是预期行为，口令不在 DSH 进程环境里。

## 更多文档

- [docs/USAGE.md](docs/USAGE.md)：使用手册（安装、口令、每个工具、批量导入、导出迁移、忘记口令会怎样、命名建议）。
- [docs/DASHBOARD.md](docs/DASHBOARD.md)：只读看板的接口与界面。
- [DESIGN.md](DESIGN.md)：设计（威胁模型、文件格式、密钥派生、打码）。
- [docs/READINESS.md](docs/READINESS.md)：上线就绪评估，含已知的文档与实现偏差。

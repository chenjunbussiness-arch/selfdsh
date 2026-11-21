# dsh-secrets 就绪评估（READINESS）

> **核查时间**：2026-11-21 凌晨 01:14–01:57（Asia/Shanghai）
> **核查对象**：插件仓库 `/srv/workspace/deepseek-harness/dsh-secrets`、目标 profile `/root/.dsh/profiles/web`、服务 `dsh-web.service`
> **核查范围**：**只读 + 安装器 dry-run**。未安装插件、未修改 profile 任何文件、未创建 `secrets.vault` / `secrets.key`、未重启或停止 `dsh-web`。
> **证据来源**：四份并行实测报告（见文末「证据文件路径」），加本文作者对文档与源码行号的只读抽查复核。
> **阅读提示**：文中 dry-run 一律指「预演、不写任何文件」。截至目前，本机**没有**任何 dsh-secrets 的安装痕迹。

---

## 1. 结论一句话

**插件本体可用（测试 29/29 全绿、安装器 dry-run 干净、宿主 CLI 端到端写库成功），但现在还不能导入密钥**：它尚未安装进 `web` profile，`dsh-web` 进程里也没有任何主口令来源；离「能用」只差三件事——装进 profile、注入主口令、重启 `dsh-web` 让插件加载。

---

## 2. 已验证

以下每一条都是实测结论，不是推断。

### 2.1 仓库自带测试：29/29 通过

`package.json` 的测试入口是 `node --test packages/host-secrets/tests/*.test.mjs`；实跑 `npm test`（Node v24.22.3）：

```
# tests 29 / suites 0 / pass 29 / fail 0 / cancelled 0 / skipped 0
# duration_ms ≈ 9036
```

- 退出码 **0**，无失败、无跳过。
- 分文件：`integration` 3/3、`redact` 6/6、`tools` 11/11、`vault` 9/9。
- 测试全部使用临时 `DSH_HOME`（`mkdtemp` 后清理），**未污染 `/root/.dsh`**；仓库内也没有 `node_modules`（源码只依赖 `node:*` 内置模块，无需联网安装）。

### 2.2 安装器 dry-run：声明改 3 处，实际零写入

原样执行 `node scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run`，退出码 **0**：

```
would change 3 thing(s) in /root/.dsh/profiles/web:
  - package.json: dependencies + bundles
  - node_modules: link dsh-secrets
  - node_modules: link dsh-host-secrets
(dry run: nothing written)
```

零写入的硬证据：

- `package.json` sha256 前后同为 `438418fe…0161dc`，`cordis.patch.yml` 前后同为 `e958da63…5c1b65`。
- 两文件的 size / mtime 未变；`node_modules` 目录 mtime 未变；profile 下没有新增 `*.bak-install-*` / `*.tmp-*`。
- 原因在实现上：dry-run 分支里 `act()` 只登记标签、不执行 `replaceFile` / `symlinkSync`。

> 请注意措辞：dry-run **没有改动任何东西**，上面那段输出只是「若要安装会改哪三处」的预演清单。

### 2.3 当前是「未安装」，不是「装了没生效」——四条依据

| # | 依据 | 实测结果 |
|---|---|---|
| 1 | profile 的 `package.json` | 12 条 `dependencies`（router / egress / vpn / token-stats 各三件套）**均无** `dsh-secrets` / `dsh-host-secrets`；`dsh.profile.bundles` 6 项里也没有 |
| 2 | `node_modules` | 仅 12 个 `dsh-*` 软链，两个 secrets 链接不存在；`dsh-secrets/node_modules` 也不存在 |
| 3 | `cordis.patch.yml` | 全文 260 行，无 secrets 配置块；`grep -i secret` 唯一命中是第 244 行的一条注释（讲 stdio MCP 会剔除含 KEY/TOKEN/SECRET 的环境变量） |
| 4 | 启动日志 | `/var/log/dsh-web.log` 中没有 `dsh-secrets: vault … 10 tools registered` 这类插件日志 |

### 2.4 密钥文件不存在，投放目录为空

- `/root/.dsh/secrets.vault`：**不存在**。
- `/root/.dsh/secrets.key`：**不存在**。
- 真实 `/srv/workspace/keys/{inbox,processed,rejected}`：三个目录都存在（0700 root），**内容为空**。

### 2.5 主口令来源：完全没有

`systemctl show dsh-web -p Environment` 只有 **2 个键**（只报键名，值脱敏）：

```
PNPM_HOME=<redacted>
PATH=<redacted>
```

- **没有** `DSH_SECRETS_PASSPHRASE`，也没有 `DSH_SECRETS_KEYFILE`。
- 运行中进程 `/proc/432879/environ` 共 11 个键（HOME / INVOCATION_ID / LANG / LOGNAME / NODE_PATH / PATH / PNPM_HOME / PWD / SHELL / SYSTEMD_EXEC_PID / USER），**没有任何 `DSH_*` 键**。
- unit 文件与 `ExecStart` / `WorkingDirectory` / `EnvironmentFiles` 中也没有 keyfile 或 passphrase 相关配置，`/etc/systemd/system/` 下 `grep DSH_SECRETS` 无命中。

### 2.6 宿主 CLI `ingest-file.mjs`：端到端可用（在 /tmp 隔离环境验证）

在临时 `DSH_HOME` 内 dry-run（3 个样本，全假值），退出码 0：

```
汇总：文件=3 解析=14 跳过=8 失败文件=0 计划写入=12
dry-run：未写入保险库、未搬动文件、未生成 .err、未读取口令/keyfile。
```

运行后临时目录保持为空（无 vault、无 processed/rejected、inbox 原样）。随后真跑同批样本：写入 **12 个键**、`processed=3`、vault 权限 **0600**；用同一口令独立 `Vault.load()` 列举，`count=12` 且 `TEST_KEY` / `JSON_KEY` / `YAML_KEY` 三条值比对全部 `MATCH`。全合法样本真跑退出码 **0**；含跳过条目的真跑退出码 **1**（部分成功，库已写入）。

### 2.7 文档与实现：6 处实质偏差

| # | 偏差 | 文档侧 | 代码侧（实测） |
|---|---|---|---|
| 1 | **首次建库不检查父目录组/其他可写** | `docs/USAGE.md:139-140,655-657` 称目录 0775/0777 会报错 | `vault.js:409-421` 的 `load()` 先 `assertPrivateFile`，vault 不存在时 ENOENT 直接返回空库，`assertDir()`（`396-403`）不执行；`452-457` 只在目录不存在时 `mkdir` 0700，已存在的宽权限目录既不报错也不 chmod。实测在 `/tmp`（1777）下 `load()` 无报错 |
| 2 | **新 CLI 没有进入插件文档** | `DESIGN.md` / `docs/USAGE.md` 完全未提 `scripts/ingest-file.mjs`；`/srv/workspace/keys/README.md:134-137` 仍写「脚本还没就位」 | 脚本 833 行，已可用；`package.json` 无 `ingest` script，`tests/` 无对应测试 |
| 3 | **导出用的 scrypt 参数写错** | `DESIGN.md:200-203` 写 “scrypt (vault's N/r/p)” | `tools.js:503` 实际用 `newScryptKdf(config.scrypt)`，即**当前 config**。`docs/USAGE.md:235-236` 的说法才是对的 |
| 4 | **全局脱敏的告警语义不符** | `docs/USAGE.md:653-654` 称「vault 不存在或没 key 时静默跳过（只 warn 一次）」 | `index.js:33` vault 不存在直接 return，**0 次 warn**；`index.js:50-56` 只有 key 缺失等异常才 warn 一次。实测：vault 不存在 2 次调用 0 warn，key 缺失 2 次调用 1 warn |
| 5 | **JSON 损坏被归错错误码** | `docs/USAGE.md:529` 把「JSON 坏了」归到 `file is not a dsh-secrets-export v1 file` | 实际走 `vault.js:139` 的 `file is not a dsh-secrets-export file (invalid JSON)`；结构不符才走 `vault.js:144` 的 `… v1 file` |
| 6 | **工具层导入不校验扩展名、不检查导入文件权限** | `docs/USAGE.md:433,469` 的 `.dshvault` 与 `chmod 600` 只是示例/建议 | `tools.js:540-542` 只 `resolve` + `readFile`：合法导出文件改名成 `.json` 仍可导入；导入文件即使是 0644 也不拦 |

---

## 3. 缺什么

### 3.1 阻断项（三条同时成立，就是「现在不能导入密钥」的全部原因）

**B1｜未安装**
profile 的 `package.json`、`node_modules`、`cordis.patch.yml` 三处都没有 dsh-secrets 的痕迹（依据见 2.3）。插件代码在仓库里，但 `dsh-web` 根本不会加载它。

**B2｜没有任何主口令来源**
`passphrase-env` 需要的 `DSH_SECRETS_PASSPHRASE` 不在服务环境里，`keyfile` 需要的 `secrets.key` 也不存在，unit 里也没有 `EnvironmentFile`。同时 `vault` 也不存在——也就是说「第一次建库」这一步同样还没有发生。缺主口令时插件会直接报 `master key missing: set environment variable DSH_SECRETS_PASSPHRASE`。

**B3｜首次启用必须重启 `dsh-web`**
DSH 在进程启动时加载 profile 的 bundles / 插件。装完不重启不会生效，日志也不会出现 `10 tools registered`。**重启会打断当前会话与正在跑的任务**，这是必须由用户明确同意的动作。

> 另外两个「隐形前置条件」（不单独列为阻断，但必须在动手前确认）：
> - vault 父目录必须是 0700。由于偏差 1，首次建库**不会**替你检查目录权限，宽权限目录会被静默接受（`/root/.dsh` 目前是 0700，符合要求）。
> - 主口令必须在**重启之前**就位，否则插件启动即失败。

### 3.2 待修文档 / 缺陷（不阻止上线，但会误导使用者）

**文档偏差 6 处**（即 2.7 表，此处只列修法）：

1. 要么让首次建库也执行 `assertDir()`，要么把 `USAGE.md:139-140,655-657` 改成「仅对已存在的 vault 生效」。安全上建议改代码。
2. 把 `ingest-file.mjs` 写进 `DESIGN.md` / `docs/USAGE.md`，并修正 `/srv/workspace/keys/README.md:134-137` 的过期说明。
3. `DESIGN.md:200-203` 的 “vault's N/r/p” 改成 “current config's N/r/p”。
4. `USAGE.md:653-654` 改成「vault 不存在时静默跳过、不告警；key 缺失时告警一次」。
5. `USAGE.md:529` 拆成两行：JSON 坏 → `(invalid JSON)`；结构不符 → `v1 file`。
6. 在文档里明确写「导入不校验扩展名、不检查导入文件权限」，或补上检查。

**`ingest-file.mjs` 的缺陷**（按危险程度）：

- **默认路径脚枪（高）**：不带任何参数真跑，会直接写 `/root/.dsh/secrets.vault` 并把**真实** `/srv/workspace/keys/inbox` 里的文件搬进 `processed/`；而 `/srv/workspace/keys/README.md` 推荐的正是这条无参数命令。没有 `--home`、没有确认提示、也没有「非 dry-run 必须显式指定 vault」的保护。
- **vault 权限补救提示指错文件（高）**：vault 是 0644 时，提示却让人 `chmod 600 .../secrets.key`，实际要改的是 vault 文件（`assertVaultReady()` 里写死了 keyfile 路径）。
- **dry-run 退出码恒 0（中）**：即使有失败文件（实测 6 个失败 + 4 条跳过）仍然 `exit 0`，与 `--help` 里的退出码表矛盾；当成预检门禁会误判「全部通过」。
- **空 inbox 无口令仍 exit 2（中）**：没有任何东西要写，却因为缺 `DSH_SECRETS_PASSPHRASE` 失败，对定时空跑不友好。
- **description 上限被 provenance 后缀重复计算（中）**：3999 字符（本身未超 4000）会因自动追加 `from <文件> (<路径>)` 而被拒。
- **文本文件名生成的 key 静默截断到 128 字符（中）**：128 与 129 字符的两个文件名会撞成同一个 key，后者覆盖前者且只留一条 note。
- 次要问题：inbox 里的符号链接与子目录被静默忽略（永远不处理、也不进 `.err`）；JSON 重复 key 静默后者覆盖；`--help --bogus` 不显示帮助；读文件前没有大小上限。

---

## 4. 上线步骤（含风险）

> 共 **7 步**。标注「需用户点头」的步骤必须得到明确同意才能执行；其余步骤可在同意范围内由执行者完成。

### 步骤 1｜选定主口令来源 —— **需用户点头**
在两种互斥方案里选一个：`passphrase-env`（一句口令，好记，但要长期保管）或 `keyfile`（32 字节随机数，熵最高，不靠人记）。
**风险**：这个选择一旦建库就**不可更改**——vault header 记录了 kdf，之后换来源会被拒绝（`vault uses kdf "keyfile" but keySource is "passphrase-env"`）。选错只能重建库、重导一遍。

### 步骤 2｜把主口令注入 `dsh-web` 的环境 —— **需用户点头（敏感操作）**
推荐写 systemd drop-in + `EnvironmentFile`（如 `/etc/dsh-secrets.env`，**0600 root**），而不是直接写 `Environment=`。
**风险**：直接写 `Environment=` 意味着口令**明文落在 unit 文件里**；改用 `EnvironmentFile` 时 unit 只留文件路径，口令单独存在 0600 文件里，暴露面更小。口令绝不能进仓库、命令行历史、日志或聊天记录。注入后、重启前，插件仍不会读它。

### 步骤 3｜备份 profile 的两个文件
复制 `/root/.dsh/profiles/web/package.json` 与 `cordis.patch.yml` 到带时间戳的备份名。
说明：安装器自己也会留 `package.json.bak-install-<ts>`；`cordis.patch.yml` **不在安装器的写入名单里**，这里备份纯属保险。

### 步骤 4｜跑安装器（先 dry-run，再真跑）—— **需用户点头**
先 `--dry-run` 复核仍是那 3 处改动，再执行不带 `--dry-run` 的同一条命令。
**风险**：真跑会**修改 profile 的 `package.json`**（加 `dsh-secrets` / `dsh-host-secrets` 两条 `link:` 依赖，并把 `dsh-secrets` 加进 `dsh.profile.bundles`）**并在 `node_modules` 建两个目录软链**。这是 profile 级改动，会影响该 profile 的所有会话。

### 步骤 5｜只读核对安装结果
确认：`package.json` 出现两条 link 依赖 + `dsh-secrets` 在 bundles 里；`node_modules/dsh-secrets`、`node_modules/dsh-host-secrets` 两个软链指向 `/srv/workspace/deepseek-harness/dsh-secrets`（及 `packages/host-secrets`）。此时**仍不会**有 vault 文件。

### 步骤 6｜重启 `dsh-web` —— **需用户明确同意（风险最高）**
用 `scripts/safe-restart.sh` 由人执行重启。
**风险**：重启会**打断当前会话和正在跑的任务**；如果第 2 步的口令没就位，插件启动就会失败并报 `master key missing`，插件功能等于没上。重启后查日志应看到 `dsh-secrets: vault <path> (keySource ...), 10 tools registered`。

### 步骤 7｜首次建库并导入，然后验收
用 `secret_set` 写一条测试值，或先用 `ingest-file.mjs --dry-run` 预演、再显式指定 `--vault` / `--dir` 真跑。
**风险**：这一步会**真正生成 `/root/.dsh/secrets.vault`（0600）**，并可能生成 `secrets.key`；文件一旦生成就有真实数据，**不能随手删**。验收项：vault 0600、`/root/.dsh` 0700、能 `secret_list` 看到条目、值能 `MATCH`。

### 回滚（任一步失败时）
1. 还原 `/root/.dsh/profiles/web/package.json`（用 `package.json.bak-install-<ts>` 或步骤 3 的手备份）。
2. 还原 `cordis.patch.yml` 备份（保险动作；安装器本不写它）。
3. 删除两个软链：`node_modules/dsh-secrets`、`node_modules/dsh-host-secrets`。
4. 再重启一次 `dsh-web`（同样需要用户同意）以回到未加载状态。
5. **不要删 `secrets.vault` / `secrets.key`**：里面可能已有真实数据，删了不可恢复；只想回退插件就保留它们，等下次启用。

### vault 与 key 的保管风险（务必让用户知情）
- `secrets.vault` 是 AES-256-GCM + scrypt 加密的，**没有后门、没有恢复口令、没有管理员重置**。
- **key（口令）丢了，vault 就等于一堆废字节**；vault 文件丢了，数据同样没了。两者要分开备份（离线、0600、不与 vault 放同一目录、不放在同一台机器上）。
- 本次核查**没有**创建这两个文件，也没有读取任何真实口令。

---

## 5. 具体问题回答

### a) 现在能不能「从一个文件批量导入」？

**要分两层，结论不同。**

- **作为插件工具：不能。** 工具 `secret_import` 只接受 `secret_export` 生成的加密信封（`format: "dsh-secrets-export"` v1、AES-256-GCM + scrypt，`tools.js:543-544`、`vault.js:137-154`），且**不校验扩展名**（`tools.js:540-542`）。实测：`.env` / YAML 报 `(invalid JSON)`，明文 JSON 报 `… v1 file`。所谓「只能吃 `.dshvault` 导出文件」在**内容格式**上基本正确（不看扩展名）。
- **作为宿主脚本：可以，但要手动跑。** `scripts/ingest-file.mjs`（833 行）支持 `.env`（KEY=VALUE / export / 引号 / 注释）、`.json`（字符串对象或 `[{name,value,description,tags}]`）、`.yaml`/`.yml`（仅扁平 `key: value`）、其它扩展名整文件当一个值（文件名生成 key）。但它**没有接线**到 `package.json` scripts、**没有测试**、**没有写进插件文档**，只能 `node scripts/ingest-file.mjs` 手工执行。

### b) 导入是否需要先有主口令？`dsh-web` 进程环境里有没有？

**需要。两种来源任选其一**：环境变量 `DSH_SECRETS_PASSPHRASE`，或 `--key-source keyfile` 指向的 `secrets.key`（0600、≥32 字节）。两者都没有时直接 `exit 2`，报 `master key missing`。
**`dsh-web` 里没有。** `systemctl show dsh-web -p Environment` 实际只有 `PNPM_HOME` 与 `PATH` 两个键（值脱敏，不采集），运行进程的 11 个环境变量里也没有任何 `DSH_*`。即使是 `--dry-run`，脚本也会去读 vault 文件头判断 keySource，只是不读口令本身。

### c) 装上到能用一共几步？哪几步必须用户同意？

**共 7 步**（详见第 4 节）：1 选口令来源 → 2 注入主口令 → 3 备份 profile → 4 跑安装器 → 5 只读核对 → 6 重启 `dsh-web` → 7 首次建库并验收。
**必须用户明确同意的有 4 步：第 1、2、4、6 步。** 其中第 6 步（重启）风险最高，会打断当前会话；第 2 步（注入口令）属敏感操作；第 4 步会改 profile 的 `package.json` 与 `node_modules`；第 1 步的选择不可逆。第 7 步会真正生成 vault，建议事先一并说明。

---

## 6. 证据文件路径

- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/W1-docs-consistency.md` —— 文档 ↔ 实现一致性核查（6 处偏差、行号、只读探针）
- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/W2-tests.md` —— 测试 29/29、逐文件结果、无污染证据
- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/W3-state.md` —— 安装器 dry-run、未安装四依据、主口令来源、sha256 前后对比
- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/W4-ingest-verify.md` —— `ingest-file.mjs` 隔离验证（12 键 MATCH、缺陷清单、真实路径零写入）
- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/W2-tests-raw.log` —— `npm test` 原始输出
- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/dryrun.log` —— 安装器 dry-run 原始输出
- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/W4-logs/dryrun.log` —— `ingest-file.mjs` dry-run 原始日志（打码）
- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/W4-logs/realrun.log` —— `ingest-file.mjs` 真跑原始日志（打码）
- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/W4-logs/probe-dry.log` —— 畸形样本 dry-run 日志
- `/srv/workspace/deepseek-harness/.dsh-artifacts/t20261120171223-284/W4-logs/probe-real.log` —— 畸形样本真跑日志

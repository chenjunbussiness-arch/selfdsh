# 作战室移植审计 W1：DSH 运行时配置与 router 状态数据

> **2026-11-23 提示**：本文写于 agent-hub / dsh-hub 加入之前（当时只有 4～5 个插件），部分数字和步骤已过时。仓库现状与安装步骤以根目录 [README.md](../README.md) 为准，全部文档目录见 [INDEX.md](INDEX.md)。

- 审计角色：W1（只读；未修改、未删除、未重启任何服务）
- 审计时间：2026-11-20 15:17–15:30（Asia/Shanghai）
- 主机：本机（`/` 为 ext4），DSH 版本 `0.2.2-rc.5`（`dsh --version` 输出）
- 在跑进程：`node .../@deepseek-ai/dsh/lib/bin.js --profile web --no-open --host 127.0.0.1 --port 42443 --trusted-host 8.134.170.38:8443`（PID 432879），由 systemd 单元 `dsh-web.service` 拉起；另有 `dsh-web-gate.service`（127.0.0.1:42444 → 42443）
- 密钥处理：本报告中出现的 `DEEPSEEK_API_KEY`、`KIRO_API_KEY`、`GEMINI_GATEWAY_KEY` 都只是**字段名**；没有打印任何值。`.credentials.yaml` 只解析了结构，未输出值。

> 结论先行：本机的「运行时配置」几乎全部集中在两处 —— **profile 覆盖层** `/root/.dsh/profiles/web/cordis.patch.yml`（模型 provider / 权限 / 品牌 / 子代理上限）与 **bundle 补丁** `/srv/workspace/deepseek-harness/dsh-router-b/cordis.patch.yml`（分区根目录 / 并发 / 验收）。这两份文件都**不被 git 记录到环境外**，换机必须逐项重做；`/root/.dsh/router` 里只有 `tiers.json` 值得带，`board.json` 可选，其余（`snapshot.json`、`seams.json`、`*.tmp-*`、`*.bak-*`）都是可再生的。

---

## A. `/root/.dsh/profiles/web/` 全部文件清单

### A.1 清单与逐文件作用

命令：

```bash
ls -la /root/.dsh/profiles/web/
find /root/.dsh/profiles/web -maxdepth 1 -name '.*' -printf '%p\n'
```

实测输出（节选，权限/大小/时间为原文）：

```text
-rw------- 1 root root 5975 Nov 20 12:58 cordis.patch.yml
-rw------- 1 root root 2450 Nov 19 16:32 cordis.patch.yml.bak-20261119-191250
-rw------- 1 root root 1932 Nov 19 11:39 cordis.patch.yml.bak-brand-20261119
-rw------- 1 root root  895 Nov 19 01:41 cordis.patch.yml.bak-llm
-rw------- 1 root root 2768 Nov 19 22:30 cordis.patch.yml.bak-llm-20261119-233505
-rw-r--r-- 1 root root  223 Nov 20 12:47 cordis.yml
drwxr-xr-x 3 root root 4096 Nov 20 00:02 node_modules
-rw-r--r-- 1 root root 1158 Nov 20 00:02 package.json
-rw-r--r-- 1 root root  279 Nov 19 11:47 package.json.bak-install-1795060061996
-rw-r--r-- 1 root root  456 Nov 19 12:35 package.json.bak-install-1795062915001
-rw-r--r-- 1 root root  429 Nov 19 15:50 package.json.bak-install-1795074649729
-rw-r--r-- 1 root root  639 Nov 19 15:50 package.json.bak-install-1795074649801
-rw-r--r-- 1 root root  822 Nov 20 00:02 package.json.bak-install-1795104176139
drwx------ 3 root root 4096 Nov 19 01:06 .plugin-manager
-rw-r--r-- 1 root root 1367 Nov 19 01:06 pnpm-lock.yaml
-rw-r--r-- 1 root root   61 Nov 19 00:09 pnpm-workspace.yaml
```

| 绝对路径 | 大小 | 作用 | 分类 |
|---|---|---|---|
| `/root/.dsh/profiles/web/cordis.yml` | 223 B | profile 根入口，内容是空数组 `[]`；注释明确“树由 patch 组合，不要编辑本文件” | **profile 清单（已被清空，交给 patch）** |
| `/root/.dsh/profiles/web/package.json` | 1158 B | profile 清单：12 个 `link:` 绝对路径依赖 + `dsh.profile.bundles` 六层 bundle 顺序 | **profile 清单（真正决定装什么）** |
| `/root/.dsh/profiles/web/cordis.patch.yml` | 5975 B | 用户覆盖层：provider/模型、权限、品牌、语言、子代理上限、默认模型、会话交互、主题 | **覆盖层（唯一的用户配置层）** |
| `…/cordis.patch.yml.bak-*`（4 个） | 895–2768 B | 覆盖层历史备份（`bak-llm`、`bak-llm-20261119-233505`、`bak-brand-20261119`、`bak-20261119-191250`） | 备份，**不加载** |
| `…/package.json.bak-install-*`（5 个） | 279–822 B | `scripts/install.mjs`/pnpm 安装前的 profile 清单备份 | 备份，**不加载** |
| `…/pnpm-workspace.yaml` | 61 B | `packages: [.]`、`nodeLinker: hoisted`、`autoInstallPeers: false` | 安装方式（换机要复现） |
| `…/pnpm-lock.yaml` | 1367 B | 安装锁文件（只含 link 依赖，实际包不在 profile 里） | 安装状态 |
| `…/node_modules/`（12 个符号链接） | — | 见 A.2；全部指向 `/srv/...` 绝对路径 | **安装结果（换机必须重建）** |
| `…/.plugin-manager/logs/operation-O5TN9c/pnpm.log` | 0 B | 插件管理器操作日志（空） | 运行日志，可丢弃 |

`node_modules` 的 12 条链接（`ls -l` 原文目标，注意全部是绝对路径，其中 3 个仓库通过 `/srv/` 下的符号链接再指回工作区）：

```text
dsh-client-ui-egress  -> /srv/dsh-egress/packages/client-ui-egress
dsh-client-ui-router  -> /srv/dsh-router-b/packages/client-ui-router
dsh-client-ui-token-stats -> /srv/workspace/deepseek-harness/dsh-token-stats/packages/client-ui-token-stats
dsh-client-ui-vpn     -> /srv/dsh-vpn/packages/client-ui-vpn
dsh-egress            -> /srv/dsh-egress
dsh-host-egress       -> /srv/dsh-egress/packages/host-egress
dsh-host-router       -> /srv/dsh-router-b/packages/host-router
dsh-host-token-stats  -> /srv/workspace/deepseek-harness/dsh-token-stats/packages/host-token-stats
dsh-host-vpn          -> /srv/dsh-vpn/packages/host-vpn
dsh-router-b          -> /srv/dsh-router-b
dsh-token-stats       -> /srv/workspace/deepseek-harness/dsh-token-stats
dsh-vpn               -> /srv/dsh-vpn
```

而 `/srv/dsh-router-b`、`/srv/dsh-egress`、`/srv/dsh-vpn` 本身是符号链接（2026-11-19 17:33 创建）：

```text
lrwxrwxrwx /srv/dsh-router-b -> /srv/workspace/deepseek-harness/dsh-router-b
lrwxrwxrwx /srv/dsh-egress   -> /srv/workspace/deepseek-harness/dsh-egress
lrwxrwxrwx /srv/dsh-vpn      -> /srv/workspace/deepseek-harness/dsh-vpn
```

> **换机含义**：profile 的 `dependencies`/`node_modules` 写死了 `/srv/dsh-router-b` 等路径。新机器若只把仓库放到别处，`pnpm install` 会失败或加载不到插件；必须先建这 3 个 `/srv/` 符号链接，或改 `install.mjs` 重新生成。

### A.2 插件是通过什么字段被拉起来的（字段名 + 行号）

链路是 **`package.json` 的 bundle 列表 → 每个 bundle 自己的 `dsh.bundle.patch` → profile 覆盖层**，`cordis.yml` 不承载内容：

1. `/root/.dsh/profiles/web/cordis.yml:1-4`（原文）：

   ```yaml
   # dsh profile root — an empty entry list. The tree is composed as patches:
   # each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
   # --patch overlays. Edit cordis.patch.yml, not this file.
   []
   ```

2. `/root/.dsh/profiles/web/package.json:18-28` —— 字段 **`dsh.profile.bundles`**，六个 bundle 按序：

   ```json
   "dsh": {
     "profile": {
       "bundles": [
         "@deepseek-ai/dsh-base",
         "@deepseek-ai/dsh-web-app",
         "dsh-router-b",
         "dsh-egress",
         "dsh-vpn",
         "dsh-token-stats"
       ]
     }
   }
   ```

   `package.json:4-17` 的 `dependencies` 用 `link:` 把 4 个 bundle 和 8 个子包钉到本机绝对路径（`dsh-router-b` 在 `package.json:5`，`dsh-token-stats` 在 `package.json:14`）。

3. 每个 bundle 用字段 **`dsh.bundle.patch`** 指向自己的补丁：
   - `/srv/workspace/deepseek-harness/dsh-router-b/package.json:36-40` → `./cordis.patch.yml`
   - `/srv/workspace/deepseek-harness/dsh-token-stats/package.json:35-39` → `./cordis.patch.yml`
   - `dsh-egress`、`dsh-vpn` 的 `package.json` 同构（`dsh.bundle.patch`）

4. bundle 补丁用 **`insert:` 行**（行内字段 `id` / `name` / `config`）挂插件：
   - `/srv/workspace/deepseek-harness/dsh-router-b/cordis.patch.yml:29-106`：`insert` → `host-router`（`:30-104`）、`client-ui-router`（`:105-106`）
   - `/srv/workspace/deepseek-harness/dsh-token-stats/cordis.patch.yml:18-25`：`host-token-stats` / `client-ui-token-stats`
   - `/srv/workspace/deepseek-harness/dsh-egress/cordis.patch.yml:25-33`：`host-egress` / `client-ui-egress`
   - `/srv/workspace/deepseek-harness/dsh-vpn/cordis.patch.yml:23-33`：`host-vpn` / `client-ui-vpn`

5. profile 覆盖层用 **`id` + `name` + `config`** 改「已有行」，不新增本项目插件：
   `/root/.dsh/profiles/web/cordis.patch.yml:13-14` 即 `id: llm-pi-ai` + `name: "@deepseek-ai/dsh-llm-pi-ai"`；字段语义见 DSH 文档 `references/composition-reference.md:9-11`（有 `id` 无 `insert` 命中同 id 行；`config` 整体替换而非深合并）。

实测佐证（只读命令 `dsh --profile web --dump-config`，输出按层注释分段）：

```text
$ dsh --profile web --dump-config | grep -n '^# =='
1:# == @deepseek-ai/dsh-base
51:# == @deepseek-ai/dsh-base, patched by /root/.dsh/profiles/web/cordis.patch.yml
...
1440:# == dsh-router-b
1441:- id: host-router
1442-  name: dsh-host-router
1443-  config:
1444-    manager: true
1445-    maxWorkers: 0
1446-    autoVerify: false
...
1518:# == dsh-egress
1527:# == dsh-vpn
1538:# == dsh-token-stats
```

`plugin_manager list_plugins` 也给出了每条插入行的 `patchId`（= bundle 补丁里的 `id`）：`include:host-router` → `"patchId":"host-router"`，`client-ui-router`、`host-egress`、`client-ui-egress`、`host-vpn`、`client-ui-vpn`、`host-token-stats`、`client-ui-token-stats` 同样 `enabled:true`、`fiberPhase:active`。**结论：不是靠 profile 的 plugins 列表，而是 `package.json:dsh.profile.bundles` + bundle 的 `dsh.bundle.patch` insert 行 + profile 覆盖层。**

### A.3 `cordis.patch.yml` 逐条摘录（与本项目相关性）

文件：`/root/.dsh/profiles/web/cordis.patch.yml`（5975 B，权限 600）。只摘结构，全部不含密钥值。

| 行号 | `id` / `name` | 分类 | 内容与作用（键 / 值） | 与本项目关系 |
|---|---|---|---|---|
| 4–7 | `ui-settings-general` / `@deepseek-ai/dsh-client-ui-settings-general` | 宿主内置 | `welcomeNoticeVersion: 2026-09-28.1` | 无关（欢迎提示只出现一次） |
| 13–139 | `llm-pi-ai` / `@deepseek-ai/dsh-llm-pi-ai` | 宿主内置插件，**项目定制的 provider 表** | `providers` 下 3 个：`commandecode`（`:17-40`，`apiKeyEnv: DEEPSEEK_API_KEY`、`api: openai-completions`、`baseURL: https://api.commandcode.ai/provider/v1`、`compat.thinkingFormat: deepseek`、`supportsDeveloperRole:false`、模型 `deepseek/deepseek-v4.1-flash` 1M ctx/384k out）；`kiro`（`:42-90`，`apiKeyEnv: KIRO_API_KEY`、`baseURL: http://127.0.0.1:7993/v1`、`kiro/claude-opus-5.5`、`sonnet-5.5`、`haiku-5.5`）；`gemini`（`:91-139`，`apiKeyEnv: GEMINI_GATEWAY_KEY`、`baseURL: http://127.0.0.1:4000/v1`、`streamIdleTimeoutMs: 900000`、6 个模型 `gemini-4-hydrogen/carbon/argon`、`gemini-3.8-flash`、`3.5-flash`、`3.1-flash-lite`） | **强相关**：路由 worker/manager 实际用的模型路由全在这里；两个 `127.0.0.1` 端点依赖本机 kiro-relay(7993) 与 gemini-gateway(4000) |
| 140–153 | `permission` / `@deepseek-ai/dsh-permission-presets` | 宿主内置 | `presets.read-only/workspace-write/danger-full-access` 三档；`defaultPreset: danger-full-access`（`:153`） | **强相关**：作战室要无人值守跑，默认必须免批准；换机不改会卡在审批 |
| 155–161 | `ui-brand-official` / `@deepseek-ai/dsh-client-ui-brand-official` | 宿主内置行**被禁用** | `disabled: true`（`:161`）；注释 `:155-158` 说明 `sidebar.brand.mark/name` 是 `single` 座位，官方行不禁用则 `dsh-client-ui-router` 注册会抛 `single slot ... already has a registration` | **强相关**：禁用官方品牌，把两个座位让给 router 面板；`install.mjs --disable-brand` 干的就是这事 |
| 162–165 | `locale` / `@deepseek-ai/dsh-client-locale` | 宿主内置 | `preference: zh` | 相关（界面中文） |
| 167–172 | `subagent` / `@deepseek-ai/dsh-subagent` | 宿主内置 | `maxActiveSubagents: 64`（`:172`）；注释 `:167-168` 说明这是 2 核 3.5G 机器上 router `maxWorkers: 0`（不设限）时的唯一硬保护 | **强相关**：换到更大/更小机器要重算 |
| 173–178 | `agent-default-model` / `@deepseek-ai/dsh-agent-default-model` | 宿主内置 | `provider: commandecode`、`model: deepseek/deepseek-v4.1-flash`、`reasoningEffort: low` | **强相关**：`host-router` 的 anchor 会话与未指定档位的 worker 继承它（源码 `src/index.ts:679` 取 `agentDefaultModel.currentSelection()`） |
| 180–186 | `ui-conversation` / `@deepseek-ai/dsh-client-ui-conversation` | 宿主内置 | `busyEnter: steer` | 相关（多 worker 连发消息并入当前轮，不排队） |
| 187–190 | `ui-theme` / `@deepseek-ai/dsh-client-ui-theme` | 宿主内置 | `preference: dark` | 弱相关（纯外观） |

**没有一条是「本项目插件」行**：`host-router` / `client-ui-router` / `host-token-stats` / `client-ui-token-stats` 都不在这个文件里，它们来自 `dsh-router-b`、`dsh-token-stats` 两个 bundle 的 insert 行（见 A.2）。这一点在移植时最容易搞反。

> 备份文件 `cordis.patch.yml.bak-llm*`、`bak-brand*` 是覆盖层历史（不同的 provider/品牌写法），**加载器不读**，只可作参考，不要带进新环境。

---

## B. `/root/.dsh/` 下其它与路由 / provider / MCP 相关的配置

### B.1 一级、二级目录盘点与分类

命令：`ls -la /root/.dsh/`、`find /root/.dsh -maxdepth 2 -mindepth 1`、`du -sh /root/.dsh/*`

| 绝对路径 | 大小 | 分类 | 说明 |
|---|---|---|---|
| `/root/.dsh/.env` | 136 B | **配置（含密钥）** | 只有 2 个字段名：`KIRO_API_KEY`、`GEMINI_GATEWAY_KEY`（`grep -oE '^[A-Za-z_][A-Za-z0-9_]*='` 实测）；值未展示。按 `dsh-credentials-local` 源码注释 `lib/index.js:17-20`，`$DSH_HOME/.env` 是凭据解析的**最后一级 fallback**（优先级：`.credentials.yaml` > 进程环境 > 启动目录 `.env` > `$DSH_HOME/.env`） |
| `/root/.dsh/.credentials.yaml` | 281 B | **凭据（含密钥）** | YAML；顶层字段 `version` / `records` / `refs`。`records` 下有 `client-connection/browser-session`（`kind: grant`，`payload` 内含 `secret` 字段，值不展示）；`refs` 下有 `DEEPSEEK_API_KEY`（值不展示）。**这是浏览器会话授权 + 模型密钥，换机必须重录，不要拷贝** |
| `/root/.dsh/.credentials.yaml.bak-20261119-100247` | 281 B | 凭据备份 | 同上，旧备份，迁移时不要带 |
| `/root/.dsh/.anonymous-user-id` | 37 B | 运行标识 | 匿名遥测 ID；机器专有，不要带 |
| `/root/.dsh/egress/config.json` | 693 B | **配置（provider 出口绑定）** | JSON；顶层键 `version` / `exits` / `bindings` / `defaultExit` / `probes`。`exits` 1 条：id `sg-mihomo`，字段 `id/name/host/port/type/auth/createdAt`（**auth 内是代理账号口令，值不展示**）；`bindings` 1 条：`api.commandcode.ai -> direct`；`defaultExit: direct`；`probes` 2 条。属 dsh-host-egress 插件数据（默认目录 `<DSH home>/egress`，见 `dsh-egress/cordis.patch.yml:15`） |
| `/root/.dsh/vpn/profiles.json` | 504 B | **配置（机器专有）** | JSON；`version` + `profiles`（1 条，字段 `name: git`、`type: password`、host/port/username 等，值不展示） |
| `/root/.dsh/vpn/secrets/p-7b6f001d` | 9 B | **凭据** | VPN 密码文件（不展示） |
| `/root/.dsh/vpn/run-d9897efeceb1.conf` | 156 B | 运行数据 | 上次 openfortivpn 的运行配置，可丢弃 |
| `/root/.dsh/profiles/web/` | 148 K（含 node_modules 链接） | **配置** | 见 A 节 |
| `/root/.dsh/profiles/headless/` | — | 配置（另一 profile） | `package.json` 只装 `@deepseek-ai/dsh-base` + `dsh-headless`，`cordis.patch.yml` 只有 commandecode 一个 provider，`reasoningEffort: max`。**当前 web 服务不用它**，与本项目无关 |
| `/root/.dsh/profiles/web.bak-20261119-010643/` | — | 备份 | 旧 web profile，不加载 |
| `/root/.dsh/router/` | 3.1 M | **运行数据（本项目状态）** | 见 C 节 |
| `/root/.dsh/sessions/--srv-workspace-*/…` | 23 M，328 个文件 | 运行数据 | 会话日志（`*.jsonl.zstd` 及索引）。含 6 个 workspace 目录：`--srv-workspace--`、`--srv-workspace-deepseek-harness--`、`--srv-workspace-google~0020tend--`、`--srv-workspace-rca-ab-test--`、`--srv-workspace-rca-ab-test-rca-front--`、`--srv-workspace-rca-ab-test-rca-openjiuwen-agent--`。历史可选带；token-stats 与 router 的 worker 进度都读它 |
| `/root/.dsh/storages/workspace.json` | 1737 B | 运行数据 | 存储单元 `workspace` v2；`tables.workspaces` 3 条，`path` 分别是 `/srv/workspace/rca-ab-test`、`/srv/workspace`、`/srv/workspace/google tend`（本机路径，换机要改/重建） |
| `/root/.dsh/storages/schedule.json` | 19.6 K | 运行数据 | 存储单元 `schedule` v2；`tables.tasks` 4 条定时任务，含 `deliveryHistory`/`target`/`record`，与机器/会话 id 绑定，可选 |
| `/root/.dsh/storages/session_projcache/sessions/*.json` | 2.5 M | 缓存 | 会话投影缓存，删掉会重建 |
| `/root/.dsh/attachments/v1/` | 14 M | 运行数据 | 上传附件（84 个文件），不要带 |
| `/root/.dsh/cache/attachments/` | 288 K | 缓存 | 可丢弃 |

### B.2 模型 provider 配置在哪

**没有** `config.*` / `providers.*` / `models.*` 这类独立文件；整个 `/root/.dsh` 下只有 `.credentials.yaml` 一个凭据文件。provider 定义只有两处：

1. `/root/.dsh/profiles/web/cordis.patch.yml:13-139`（YAML，`providers` 键）—— 3 个 provider，见 A.3。
2. 宿主内置的 DeepSeek 官方 provider：`plugin_manager list_plugins` 里 `include:llm-deepseek`（`@deepseek-ai/dsh-llm-deepseek-api-key`）与 `include:llm-deepseek-account` 均 `enabled:active`，密钥经 `DEEPSEEK_API_KEY` 解析。

凭据来源优先级（源码证据 `/usr/local/pnpm-global/store/v11/links/@deepseek-ai/dsh-credentials-local/0.2.2-rc.5/…/lib/index.js:13-20`）：

```text
$DSH_HOME/.credentials.yaml        (provider-managed, written by set/unset)
> inherited process environment    (fallback)
> <invocation cwd>/.env            (fallback)
> $DSH_HOME/.env                   (fallback)
```

所以 `.env` 里的 `KIRO_API_KEY` / `GEMINI_GATEWAY_KEY` **不是 systemd 注入的**（`/proc/432879/environ` 只有 11 个变量，没有这两个），而是 DSH 凭据层按上述顺序读取的。换机时若只拷 `cordis.patch.yml` 不补 `.env`，`kiro`/`gemini` 两个 provider 会没有 key（`commandecode` 用的是 `.credentials.yaml` 里的 `DEEPSEEK_API_KEY`）。

### B.3 MCP 配置

- `/root/.dsh` 下**没有任何** `mcp.json`、`mcpServers` 字段或 `*mcp*` 文件：
  - `find /root/.dsh -iname '*mcp*' -not -path '*/node_modules/*'` → 空
  - `grep -ril --exclude-dir=node_modules --exclude-dir=sessions -E 'mcpServers|"mcp"' /root/.dsh/` → 空
  - `grep -rl 'mcpServers' /root/.dsh/sessions | wc -l` → 0（会话日志里也没有）
  - `/var/log/dsh-web.log` 中 `grep -ci mcp` → `0`
- 插件层：`plugin_manager list_plugins` 显示 `include:mcp-manager`（`@deepseek-ai/dsh-mcp-manager`，`enabled:true`）与 `include:mcp-resources` 处于 active；但**没有任何 `@deepseek-ai/dsh-mcp-client` 行**（MCP server 在 DSH 里是每个 server 一条 `dsh-mcp-client` insert 行，见文档 `references/mcp-bundle.md:2-3`）。
- **MCP server 名字清单：空**。即本机「作战室」没有接任何 MCP server；若新机器要接（例如 rca-state 的 MCP），需要新建 bundle 补丁 insert `@deepseek-ai/dsh-mcp-client`，当前没有可迁移的 MCP 配置。

### B.4 含本机绝对路径 / 本机专有信息的文件（移植阻碍点）

| 文件 | 本机专有内容 |
|---|---|
| `/root/.dsh/profiles/web/package.json:5-16` | 12 条 `link:/srv/dsh-router-b`、`/srv/dsh-egress`、`/srv/dsh-vpn`、`/srv/workspace/deepseek-harness/dsh-token-stats` |
| `/root/.dsh/profiles/web/node_modules/*` | 12 条绝对路径符号链接（同 A.1） |
| `/srv/workspace/deepseek-harness/dsh-router-b/cordis.patch.yml:40,68,90` | 分区根 `/srv/workspace/rca-ab-test`、`"/srv/workspace/google tend"`、`/srv/workspace/deepseek-harness` |
| `/root/.dsh/profiles/web/cordis.patch.yml:46,95` | provider 端点 `http://127.0.0.1:7993/v1`、`http://127.0.0.1:4000/v1`（本机中继/gateway） |
| `/root/.dsh/egress/config.json` | 出口 `sg-mihomo` 的 host/port/auth；绑定 `api.commandcode.ai` |
| `/root/.dsh/vpn/profiles.json` + `vpn/secrets/` | `git` VPN 的 host/端口/账号/密码 |
| `/root/.dsh/storages/workspace.json` | 3 个 workspace 的 `path` 全是 `/srv/workspace/...` |
| `/root/.dsh/sessions/…`（328 个） | 会话的 cwd/路径元数据指向 `/srv/workspace/...`；换路径后旧会话仍在，但里面的绝对路径引用会失效 |
| `/etc/systemd/system/dsh-web.service`、`dsh-web-gate.service` | `ExecStart` 的 dsh 绝对路径、`--profile web`、端口 42443、`--trusted-host 8.134.170.38:8443`、`ExecStartPre=/usr/local/bin/dsh-fix-zod` |
| `/srv/workspace/deepseek-harness/dsh-vpn/cordis.patch.yml:28` | `localProbePort: 42443` 写死 Web 端口，换端口要同步改 |

---

## C. `/root/.dsh/router/` 状态数据

### C.1 逐文件

命令：`ls -la /root/.dsh/router/`、`cat -n`（小文件）、`python3 -c 'json.load(...)'` 取顶层键。

当前目录（2026-11-20 15:24–15:26 实测，board/snapshot 仍在被运行中的进程写入，大小会继续增长）：

```text
-rw-r--r-- 125       anchor.json
-rw-r--r-- 125       anchor.json.prev-20261120-104607
-rw-r--r-- 1146859   board.json
-rw-r--r-- 269115    board.json.tmp-374695
-rw-r--r-- 401436    board.json.tmp-383462
-rw-r--r-- 524288    board.json.tmp-411927
-rw-r--r-- 0         board.json.tmp-419088
-rw-r--r-- 281       seams.json
-rw-r--r-- 846091    snapshot.json
-rw-r--r-- 423       tiers.json
-rw-r--r-- 423       tiers.json.bak-20261120-013609
```

写入方统一是 **`host-router` 插件**，它跑在 `dsh-web.service` 的 node 进程（PID 432879）里；`boardDir` 默认 `<DSH home>/router`，源码 `/srv/workspace/deepseek-harness/dsh-router-b/packages/host-router/src/index.ts:283-285`：

```ts
const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
const boardDir = config.boardDir === undefined ? join(home, 'router') : resolve(config.boardDir)
const snapshotPath = join(boardDir, 'snapshot.json')
```

`dsh-router-b/cordis.patch.yml:25-27` 明确「`boardDir` 故意省略」，所以就是 `/root/.dsh/router`。

| 绝对路径 | 用途 | 写入点（源码 file:line） | 顶层键 / 当前规模 | 缺失或为空时是否自愈 | 迁移结论 |
|---|---|---|---|---|---|
| `/root/.dsh/router/board.json` | 任务板：全部任务 + 每个分区的 manager 记录（历史任务记录） | 打开/创建 `src/board.ts:250-263`（`join(dir,'board.json')` :257）；原子写 `src/board.ts:387-404`（`flush`/`flushNow`，先写 `board.json.tmp-<pid>` 再 rename，:400） | `version`(=1) / `tasks`(137) / `partitions`(5)。按分区：`deepseek-harness` 79、`google-tend` 43、`rca-ab-test` 12、`agent` 3；按状态：`done` 89、`failed` 29、`reported` 10、`verified` 3、`cancelled` 3、`running` 3 | **会**。`src/board.ts:331-353`：读不到（ENOENT）→ 空板返回；JSON 坏 → 把原文件改名 `board.json.corrupt-<ts>`，从空板启动；启动时 `reconcile()`（`src/board.ts:365-383`）把「别的 runToken 留下的 running/dispatched」改成 `interrupted`（有 sessionId）或 `queued`（无 sessionId） | **可选**。要保留历史任务/在途记录才带；不带则新建空板，插件正常工作。注意 `partitions` 里 `front`、`agent` 是旧配置残留（当前 bundle 只声明 3 个分区），带过去也会留在历史里 |
| `/root/.dsh/router/tiers.json` | 三档难度→模型路由的用户设置（面板可改） | `src/tier.ts:205-214`（`TierStore.open` 读）、`:221-228`（`set` 写 `tiers.json.tmp-<pid>` 再 rename）；HTTP 入口 `src/bridge.ts:51`（`TIERS_PATH=/api/router/tiers`）、`:750-762`（GET/POST）、`:866`（路由注册） | `auto`(true) / `tiers`{`easy`,`medium`,`hard`}；档位与模型：`easy` → `commandecode` / `deepseek/deepseek-v4.1-flash` / `low`；`medium` → `commandecode` / `deepseek/deepseek-v4.1-flash` / `high`；`hard` → `kiro` / `kiro/claude-opus-5.5` / `high` | **会**。`src/tier.ts:205-213` 读失败一律吞掉用默认；默认由 `defaultTiers()`（`:185-198`）从**实时模型列表**重算：`easy`=最便宜（名字含 flash/haiku 加权），`medium`/`hard`=profile 默认模型；`normaliseSettings()`（`:232-246`）丢弃未知档位、`auto` 缺省为 true | **建议带**（423 B，纯文本，无密钥）。不带会按新机器模型列表自动重算，可能选中不同模型 → 行为对不上。换机后若 provider 名、模型 id 不变则无需改；`kiro/claude-opus-5.5` 依赖本机 7993 中继，必须先确认 |
| `/root/.dsh/router/anchor.json` | 「作战室」锚点会话 id：面板把需求投进这个 root session，重启后恢复同一会话 | 读 `src/index.ts:621-625`；写 `src/index.ts:660-663`（`persistAnchor`），首次创建时 `:723-742` 写 | `sessionId` / `title`("作战室") / `at` | **会**。读不到或解析失败 → `anchorSessionId=undefined`，首次派活时新建 `session-<uuid>` 并写回（`src/index.ts:723-742`）；若文件里的 id 在 `~/.dsh/sessions` 里 resume 失败，也会新建（`:701-721`，日志 `cannot resume anchor ... creating a new one`） | **可选，且必须与 `sessions/` 一起带**。只带 `anchor.json` 会指向不存在的会话 → 自动新建，等于没带；不带则丢锚点聊天历史。换了代码目录后锚点 session 的 cwd 仍是旧路径 |
| `/root/.dsh/router/seams.json` | 启动自检报告：宿主是否提供 `tools`/`subagents`/`agents`/`sessionQuery`/`credentials`/`sandboxPolicy` 六个 seam（能力接缝） | 每次启动写：`src/index.ts:543-556`（`:548` writeFile） | `at` / `node`(v24.22.3) / `seams`{6 个 bool，当前全 true} / `required`(["tools","subagents"]) / `ok`(true) | **会**。每次 boot 覆盖写，不参与任何读取判断 | **不要带**。纯自检快照，新机启动即重写 |
| `/root/.dsh/router/snapshot.json` | UI 用的整板快照：每个任务的 worker session、todo 进度、计数、分区列表（派生数据） | 写 `src/index.ts:885-887`（`writeFile(snapshotPath, ...)`）；构造 `src/snapshot.ts:410-453`（`buildSnapshot`，`:443` `generatedAt`） | `version`(1) / `generatedAt`("2026-11-20T07:25:20Z") / `counts`{6 状态} / `partitions`(3：当前配置的 3 个分区) / `tasks`(137) | **会**。没有读取方，每次刷新由 board + session 日志重算 | **不要带**。派生缓存，带了也会被覆盖；且含旧路径/旧 worker 状态，反而误导 |
| `/root/.dsh/router/board.json.tmp-*`（4 个） | 原子写的中间文件；`tmp-419088` 为 0 字节，说明有过一次中断的写 | 同 `flushNow`；正常应被 rename 掉 | 不是合法状态文件 | 无 | **不要带**。可安全删除（本次审计未删） |
| `/root/.dsh/router/anchor.json.prev-20261120-104607` | 锚点轮换前的备份（`scripts/rotate-anchor-and-drill.sh` 产物） | 脚本 | 同上 | 无 | 不要带 |
| `/root/.dsh/router/tiers.json.bak-20261120-013609` | tiers 旧备份 | 面板/脚本 | 同上 | 无 | 不要带 |

补充事实：

- `board.json` 的 `partitions` 是 **manager 注册表**（`managerSessionId`/`managerName`/`managerUpdatedAt`），当前 5 个键：`front`、`agent`、`deepseek-harness`、`rca-ab-test`、`google-tend`（`front`/`agent` 已无任务或仅有 3 条旧任务，且不在当前 bundle 配置里）。
- `snapshot.json` 的 `partitions` 来自**当前配置**（`src/snapshot.ts:433-447` 对 `deps.partitions` 过滤），只有 3 个：`rca-ab-test`、`google-tend`、`deepseek-harness` —— 与 `board.json` 的 5 个键不同，这正说明 board 是历史累积、snapshot 是派生。
- 会话与 board 的耦合：`board.json` 的任务行带 `sessionId`、`runToken`、`cwd`；worker 进度（todo）不在 board 里，而在 `~/.dsh/sessions/**` 的 `todo/write` 事件里（`src/snapshot.ts:1-22` 注释）。所以**只迁 board 不迁 sessions**，历史行会显示“reported/failed”但没有 todo 进度。

### C.2 「必须带 / 可选 / 不要带」结论

| 文件 | 结论 | 理由 |
|---|---|---|
| `tiers.json` | **必须带（推荐）/ 至少手工重录** | 决定 easy/medium/hard 三档实际模型；不带就按新机模型列表自动重算，行为会变。423 B、无密钥，直接 scp 最省事 |
| `board.json` | **可选** | 只是历史任务与 manager 注册表；缺失自愈为空板。若带：在停写后拷贝，启动时旧 `running` 行会被标 `interrupted`；旧分区 `front`/`agent` 行会留在历史里 |
| `anchor.json` | **可选，且必须与 `sessions/` 成对** | 单独带无意义（session 不存在→自动新建）；带 sessions 才能恢复“作战室”对话 |
| `seams.json` | **不要带** | 每次启动按新机能力重写；旧内容还可能误导排障 |
| `snapshot.json` | **不要带** | 派生缓存，启动/刷新即重算 |
| `board.json.tmp-*` / `anchor.json.prev-*` / `tiers.json.bak-*` | **不要带** | 中间产物/旧备份，无读取方 |

---

## D. 结论汇总表（A + B + C）

「仓库内」= 在 `/srv/workspace/deepseek-harness` 的 git 工作区里，可随仓库走；「环境侧」= 在 `/root/.dsh` 或 `/etc`，不在仓库里，换机必须手工重做。

| 绝对路径 | 内容作用 | 仓库内 / 环境侧 | 换机是否必须重做 | 怎么重做（命令级） |
|---|---|---|---|---|
| `/srv/workspace/deepseek-harness/dsh-router-b/cordis.patch.yml` | bundle 补丁：`host-router`（manager/maxWorkers 0/autoVerify false）+ 3 个分区根、排除、关键词；`client-ui-router` 行 | 仓库内 | **必须改值**（文件随仓库走，但 3 个 `root` 是本机路径） | 编辑 `:40`、`:68`、`:90` 三个 `root:` 为新机路径；保留 `workers: 0`、`manager: true`、`maxWorkers: 0`、`autoVerify: false` |
| `/srv/workspace/deepseek-harness/dsh-token-stats/cordis.patch.yml` | 插入 `host-token-stats` / `client-ui-token-stats`，`ttlMs: 4000`、`warmupDelayMs: 800` | 仓库内 | 不需要改（除非换端口/目录） | 原样随仓库 |
| `/srv/workspace/deepseek-harness/dsh-egress/cordis.patch.yml` | 插入 egress 两半；`providers[0].baseURL = https://api.commandcode.ai/provider/v1` | 仓库内 | 视 provider 端点是否变 | 若新机不走 commandcode，改 `:31` 的 `baseURL`/`name` |
| `/srv/workspace/deepseek-harness/dsh-vpn/cordis.patch.yml` | 插入 VPN 两半；`localProbePort: 42443`、`publicProbe: 223.5.5.5:53` | 仓库内 | **若 Web 端口变则必须改** | 改 `:28` 为新 Web 端口 |
| `/root/.dsh/profiles/web/package.json` | profile 清单：12 条 `link:` 绝对路径 + `dsh.profile.bundles` 六项 | 环境侧 | **必须重做** | 先建好 `/srv/dsh-router-b`、`/srv/dsh-egress`、`/srv/dsh-vpn` 三个符号链接（或改脚本里的 `BUNDLE` 路径），然后依次跑 4 个 `install.mjs`（见文末命令块） |
| `/root/.dsh/profiles/web/node_modules/`（12 条链接） | 让 profile 能解析 4 个 bundle 与 8 个子包 | 环境侧 | **必须重建** | 由 4 个 `scripts/install.mjs` 自动创建；不要手工 `pnpm install`（注释 `install.mjs:18-21` 明确说会毁树） |
| `/root/.dsh/profiles/web/cordis.patch.yml` | 覆盖层：provider 表、权限默认、品牌禁用、语言、子代理上限、默认模型、交互、主题 | 环境侧 | **必须重做（逐条）** | 见下方「profile 覆盖层重建步骤」；`baseURL` 的 `127.0.0.1:7993`/`4000` 要按新机中继改，`subagent.maxActiveSubagents` 按新机内存改 |
| `/root/.dsh/profiles/web/cordis.yml` | 空数组入口（`[]`） | 环境侧 | 不需要（保持空即可） | `printf '# dsh profile root\n[]\n' > …/cordis.yml` |
| `/root/.dsh/.credentials.yaml` | `DEEPSEEK_API_KEY` 凭据 + 浏览器会话 grant | 环境侧（含密钥） | **必须重录，禁止拷贝** | 在 Web UI「设置 → 账号/模型」重新填 `DEEPSEEK_API_KEY`（或经 credentials provider 的 set 写入）；浏览器会话会重新生成 |
| `/root/.dsh/.env` | `KIRO_API_KEY`、`GEMINI_GATEWAY_KEY` 两个 fallback 凭据 | 环境侧（含密钥） | **必须重写（值不同）** | `install -m 600 /dev/null /root/.dsh/.env` 后按 `KEY=值` 两行写入（新机的 kiro/gemini 中继 key） |
| `/root/.dsh/egress/config.json` | 出口 `sg-mihomo`（host/port/auth）+ 绑定 `api.commandcode.ai -> direct` + 默认出口 direct | 环境侧（含代理口令） | **视情况必须重做** | 新机若不需要代理：不建该文件即可（默认全 direct，见 `dsh-egress/cordis.patch.yml:22-23`）；需要代理则在 Egress 面板重新添加出口并绑定 |
| `/root/.dsh/vpn/profiles.json` + `/root/.dsh/vpn/secrets/` | `git` VPN 的 host/账号/密码 | 环境侧（含密码） | **需要内网 git 时必须重做** | VPN 面板重新添加 profile；密码重新输入（不要拷贝 `secrets/`） |
| `/root/.dsh/router/tiers.json` | 三档模型路由（easy/medium=commandecode DSV4.1，hard=kiro opus-5.5） | 环境侧（本项目状态） | **建议带；provider/模型变则改** | `install -m 644 /dev/null /root/.dsh/router/tiers.json` 后从旧机拷贝；在 Router 面板「档位」里核对三档 |
| `/root/.dsh/router/board.json` | 历史任务板（137 条）+ 5 个分区 manager 注册表 | 环境侧（本项目状态） | 可选 | 停 DSH 后拷贝 `board.json`；不拷贝则空板 |
| `/root/.dsh/router/anchor.json` | 「作战室」锚点 session id | 环境侧（本项目状态） | 可选（须配 sessions） | 与 `/root/.dsh/sessions/` 一起拷贝；否则删掉让它自动新建 |
| `/root/.dsh/router/snapshot.json`、`seams.json`、`board.json.tmp-*`、`*.bak-*`、`*.prev-*` | 派生缓存 / 自检 / 中间产物 | 环境侧 | **不要带** | 不拷贝；新机首次启动自动重建 |
| `/root/.dsh/sessions/`（328 个文件，23 M） | 会话日志：锚点对话、worker 历史、token-stats 数据源 | 环境侧（运行数据） | 可选 | 想保留历史再拷贝；token 统计会从 0 重新累积（token-stats 只读 `~/.dsh/sessions/**/*.jsonl.zstd`，见其 bundle 补丁注释 `:5`） |
| `/root/.dsh/storages/workspace.json`、`schedule.json`、`session_projcache/` | 工作区列表（3 个 `/srv/workspace/...` 路径）、4 条定时任务、投影缓存 | 环境侧（运行数据/缓存） | workspace.json 建议重建；schedule 可选；projcache 不要 | 工作区在 UI 里重新添加即可；`session_projcache` 删掉自动重建 |
| `/root/.dsh/attachments/`、`/root/.dsh/cache/` | 附件与缓存 | 环境侧 | 不要带 | — |
| `/etc/systemd/system/dsh-web.service` | 启动 `dsh --profile web --port 42443 --trusted-host …`，`ExecStartPre=/usr/local/bin/dsh-fix-zod` | 环境侧 | **必须重写** | 按新机 dsh 路径/端口/域名改 `ExecStart` 与 `Environment=PATH`；`systemctl daemon-reload && systemctl enable --now dsh-web` |
| `/etc/systemd/system/dsh-web-gate.service` | 42444 → 42443 的稳定入口（`/usr/local/bin/dsh-web-gate.mjs`） | 环境侧 | 视需要（要固定入口就要） | 复制 `/usr/local/bin/dsh-web-gate.mjs` + unit，改 `GATE_PORT`/`GATE_UPSTREAM_PORT` |

### D.1 换机「必须重做」清单（按顺序）

1. **代码落位 + 链接**：仓库放到新机后，建 3 个 `/srv/` 符号链接（或改 `install.mjs`）：
   ```bash
   ln -sfn /srv/workspace/deepseek-harness/dsh-router-b /srv/dsh-router-b
   ln -sfn /srv/workspace/deepseek-harness/dsh-egress  /srv/dsh-egress
   ln -sfn /srv/workspace/deepseek-harness/dsh-vpn     /srv/dsh-vpn
   ```
2. **profile 安装 4 个 bundle**（每个都支持 `--dry-run` 先看）：
   ```bash
   node /srv/workspace/deepseek-harness/dsh-router-b/scripts/install.mjs  --profile /root/.dsh/profiles/web --disable-brand
   node /srv/workspace/deepseek-harness/dsh-egress/scripts/install.mjs    --profile /root/.dsh/profiles/web
   node /srv/workspace/deepseek-harness/dsh-vpn/scripts/install.mjs       --profile /root/.dsh/profiles/web
   node /srv/workspace/deepseek-harness/dsh-token-stats/scripts/install.mjs --profile /root/.dsh/profiles/web
   ```
   `dsh-router-b/scripts/install.mjs:238` 起会检查分区根是否存在并 warning；`--disable-brand` 会往 profile `cordis.patch.yml` 追加 `ui-brand-official` 的 `disabled: true`（`:194-207`）。
3. **profile 覆盖层逐条重建**（可直接从旧机拷 `/root/.dsh/profiles/web/cordis.patch.yml` 再改）：
   - `llm-pi-ai.providers.commandecode.baseURL`（`:21`）→ 新机可达的 commandcode 端点；
   - `providers.kiro.baseURL`（`:46`）`http://127.0.0.1:7993/v1` → 新机 kiro-relay 地址；
   - `providers.gemini.baseURL`（`:95`）`http://127.0.0.1:4000/v1` → 新机 gemini-gateway 地址；
   - `subagent.maxActiveSubagents`（`:172`）按新机内存重算（本机 64，2 核 3.5G）；
   - `agent-default-model`（`:173-178`）与 `permission.defaultPreset`（`:153`）保持原值；
   - `ui-brand-official.disabled`（`:159-161`）必须为 `true`，否则 `client-ui-router` 抢不到品牌座位。
4. **凭据**：UI 重录 `DEEPSEEK_API_KEY`；写新的 `/root/.dsh/.env`（`KIRO_API_KEY`、`GEMINI_GATEWAY_KEY`）。
5. **bundle 补丁里的 3 个分区根**改成新机路径（`dsh-router-b/cordis.patch.yml:40,68,90`），否则 router 启动后所有分区都指向不存在的目录。
6. **启动方式**：重写 `/etc/systemd/system/dsh-web.service`（+ 可选 gate），确认 `dsh --profile web` 的 `--port` 与 `dsh-vpn/cordis.patch.yml:28` 的 `localProbePort` 一致。
7. **状态**：`tiers.json` 直接带（或面板重录三档）；`board.json`/`anchor.json`/`sessions` 按需带；`snapshot.json`、`seams.json`、`*.tmp-*`、`*.bak-*` 一律不带。
8. **验证**（只读）：
   ```bash
   dsh --profile web --dump-config | grep -n -A3 'id: host-router'
   dsh --profile web --dump-config | grep -n 'llm-pi-ai\|agent-default-model'
   ```
   页面打开后看 Router 面板是否列出 3 个分区、Tier 面板是否显示三档模型。

---

## E. 未确认 / 卡住的点

- **`opencode`/`commandcode` 上游可用性**：`https://api.commandcode.ai/provider/v1` 是否对新机器 IP 开放，未验证（本审计只读、未发外部请求）。
- **`kiro`/`gemini` 本地中继的部署方式**（7993 / 4000 是谁在监听、如何启动）不在 `/root/.dsh` 内，本次未展开；移植手册需要另找这两个服务的部署单元。
- **MCP manager 的动态设置存放位置**：`@deepseek-ai/dsh-mcp-manager` 是 settings 驱动，但本机没有配置任何 server，故无法确认真实持久化文件路径；当前结论「MCP server 清单为空」有 `find`/`grep`/日志三重证据，但“如果以后配置了会写到哪”未确认。
- **`/root/.dsh/.env` 是否被 systemd 之外的方式注入**：已验证运行进程环境里没有这两个 key，且 DSH 凭据层把 `$DSH_HOME/.env` 当 fallback（源码 `dsh-credentials-local/lib/index.js:13-20`）；但本机 kiro/gemini 中继是否需要 key 才放行，未验证。
- **board.json 在审计期间持续增长**（1,128,795 → 1,146,859 B，任务 137 条不变、状态在变），所有“当前大小/状态计数”都是 15:24 的快照，迁移时以实时为准。

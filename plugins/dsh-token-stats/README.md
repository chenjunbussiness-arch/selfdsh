# dsh-token-stats：Token 用量统计

## 这是什么

在 DSH Web 左侧栏底部加一张小卡片，显示**今天一共用了多少 token**，以及按模型拆开的占比；点开能看最近 7 天 / 30 天的每日用量。

数据直接从本机 DSH 的会话日志里统计，**只读**：不写任何文件、不改会话、不给模型加工具。

## 装好后在哪里看到

- **左侧栏底部、「设置」上方**的一张卡片「Token 用量」：今日总量 + 按模型的彩色条。
- 点卡片展开浮层：今日 / 近 7 天 / 近 30 天切换、每日柱状图（按模型着色）、「立即刷新」按钮。
- 没有侧栏行、没有独立页面，也**没有对模型开放的工具**。
- 宿主侧只多了一个只读接口 `GET /api/token-stats/summary`（需要已登录 Web）。

## 必须配置

**无需配置，装上即用。** 插件默认读 `<DSH home>/sessions`（`<DSH home>` = 环境变量 `DSH_HOME`，没设时是 `~/.dsh`）。

## 可选配置

写在 profile 的 `<profile>/cordis.patch.yml` 里，按 id `host-token-stats` 覆盖（注意：覆盖时整段 `config` 会被替换，想保留的键要一起写上）：

```yaml
- id: host-token-stats
  name: dsh-host-token-stats
  config:
    sessionsDir: /root/.dsh/sessions   # 一般不用写
    ttlMs: 4000
    warmupDelayMs: 800
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `sessionsDir` | `<DSH home>/sessions` | 会话日志根目录 |
| `ttlMs` | `4000` | 统计结果缓存多久（毫秒），期间不重新扫描目录 |
| `warmupDelayMs` | `800` | 启动后多久在后台预热一次统计（毫秒），让第一次打开就是热的 |

## 怎么看这些数字

- **总量 = 新输入 + 缓存读 + 缓存写 + 输出**，全部用模型服务商返回的真实用量，不是按字数估算。
- 按**北京时间（UTC+8）**分天。
- 只统计本机 `sessions` 目录下的会话；别的机器（例如 agent-hub 的 worker）上的用量不在这里。

## 安装与更新

需要 Node ≥ 22（建议 22.15 及以上，读取 `.zstd` 日志要用到 `zlib.zstdDecompressSync`）。

```bash
# 1. 构建浏览器侧产物 packages/client-ui-token-stats/lib/client.js
node scripts/build.mjs

# 2. 装进 profile（幂等；先 --dry-run 看看会改什么）
node scripts/install.mjs --profile ~/.dsh/profiles/web --dry-run
node scripts/install.mjs --profile ~/.dsh/profiles/web

# 3. 重启拥有这个 profile 的 DSH 进程
```

安装脚本只做三件事：在 profile 的 `package.json` 写 `link:` 依赖、把 `dsh-token-stats` 加进 `dsh.profile.bundles`、在 `node_modules` 下建目录链接。它不跑包管理器、不重启。卸载：`node scripts/install.mjs --profile <dir> --uninstall`。

重启后日志里应出现：`host-token-stats: read-only usage bridge mounted at /api/token-stats/summary`。

更新：拉新代码 → 重新 `node scripts/build.mjs` → 刷新页面（只改了浏览器侧时）；改了 `packages/host-token-stats/*.js` 要重启 DSH。

## 常见问题

- **卡片显示「统计服务不可用」/「读不到用量统计」**：宿主侧接口没挂上或没响应。确认已重启、日志里有上面那行；接口返回 401/403 时重新登录 Web。
- **显示「暂无用量数据」**：`sessions` 目录里还没有会话日志，跑一次对话后再看；或者 `DSH_HOME` / `sessionsDir` 指错了目录。
- **启动日志 `token-stats: warm-up failed: ...`**：多半是 Node 版本太旧（没有 `zstdDecompressSync`）或目录不可读，升级 Node 到 22.15+ 后重启。
- **数字比服务商账单略少**：正在写入中的会话文件，插件会先沿用上一次读到的结果，下次刷新再补上；数字不会倒退。
- **装上后卡片不出现**：没构建 `lib/client.js`（安装脚本会打印 `warning: not built yet`），先跑 `node scripts/build.mjs`。

## 更多文档

- `cordis.patch.yml` 顶部注释：配置键说明。
- `packages/host-token-stats/scanner.js` 开头注释：读哪些事件、缓存与增量读取、计费口径。

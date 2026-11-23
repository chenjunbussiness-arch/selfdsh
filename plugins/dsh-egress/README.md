# dsh-egress：模型出口

## 这是什么

决定 DSH 发出的**模型请求从哪个代理出去**：可以给每个模型服务地址（例如 `api.commandcode.ai`）单独指定一个出口（`http` / `https` / `socks5` 代理，或直连 `direct`）。

它是**失败即断**的：选定的代理不通时请求直接报错，错误里写明出口名，**绝不会悄悄改成直连**。在面板里改完，下一条请求就生效，不用重启。

## 装好后在哪里看到

- **左侧栏多一行「出口」**（英文界面为 “Egress”），点开主区域的「出口」面板，里面有：
  - 出口列表：新建 / 编辑 / 删除代理出口，「探测」按钮可以看出口 IP 和延迟；
  - 绑定表：每个模型服务主机 → 用哪个出口；还有一行「默认出口」（没单独绑定的主机都走它）；
  - 最近 100 条请求日志（只有时间、目标主机、出口、成败，不记请求内容）。
- **对模型开放的工具**：`egress_status`（只读，查看每个主机当前走哪个出口、各出口最近一次探测结果；不显示任何代理密码）。改出口只能人在面板里做。
- 宿主侧接口：`/api/egress/state`、`/exit`、`/binding`、`/probe`（需要已登录 Web）。

## 必须配置

**无需配置，装上即用。** 刚装好时出口列表是空的，所有主机都走内置的 `direct`（直连），行为和没装一样。

想让模型请求走代理时，在「出口」面板里操作即可，不用改任何文件，例如：

1. 新建出口：类型 `http`，主机 `127.0.0.1`，端口 `7890`（本机 Clash 的 HTTP 代理），需要认证再填用户名密码；
2. 点「探测」，确认能看到出口 IP；
3. 在绑定表里把 `api.commandcode.ai` 绑到这个出口（或者把「默认出口」改成它）。

## 可选配置

写在 profile 的 `<profile>/cordis.patch.yml` 里，按 id `host-egress` 覆盖（覆盖时整段 `config` 会被替换，bundle 自带的 `providers` 想保留就要一起写上）：

```yaml
- id: host-egress
  name: dsh-host-egress
  config:
    dataDir: /root/.dsh/egress
    providers:
      - name: commandecode
        baseURL: https://api.commandcode.ai/provider/v1
    # undiciPath: /绝对路径/node_modules/undici/index.js
```

| 键 | 默认值 | 含义 |
|---|---|---|
| `dataDir` | `<DSH home>/egress` | 出口和绑定存放的目录（目录 0700，`config.json` 0600）。`<DSH home>` = `DSH_HOME`，没设时是 `~/.dsh` |
| `providers` | bundle 自带一条：`commandecode` → `https://api.commandcode.ai/provider/v1` | 让绑定表**一开始就列出**这些主机（不配的话，主机要等第一次请求后才出现）。`name` 只是显示名，真正绑定的是 `baseURL` 的主机名 |
| `undiciPath` | 自动查找 | undici（≥7）`index.js` 的绝对路径。只有日志里出现 `undici UNAVAILABLE` 时才需要写 |

出口和绑定本身**不在配置文件里**，而是在 `<dataDir>/config.json`，由面板读写，不建议手改。

## 管不到的流量

只接管 DSH 进程里经 `fetch` 发出的模型请求。以下**不受影响**：`web_fetch` 等自己带 HTTP 客户端的工具、子进程里的 `git` / `curl`、Worker 线程、AWS Bedrock。访问本机（`localhost`、`127.0.0.0/8`、`::1`）的请求永远直连。

## 安装与更新

```bash
# 1. 构建（宿主侧 TypeScript 编译 + 浏览器侧 lib/client.js + 测试，最后应打印 build ok）
node scripts/build.mjs          # 宿主编译需要 TypeScript ≥ 5.7，可用 DSH_TSC 指定 tsc

# 2. 装进 profile（幂等；先 --dry-run）
node scripts/install.mjs --profile ~/.dsh/profiles/web --dry-run
node scripts/install.mjs --profile ~/.dsh/profiles/web

# 3. 重启一次 DSH（只有第一次装 / 升级插件需要；之后改出口都不用重启）
```

重启后日志里应出现：
`dsh-egress: fetch hook installed (data …/egress); undici <版本>; 0 exit(s), default direct` 和
`dsh-egress: HTTP bridge mounted at /api/egress (state/exit/binding/probe)`。

## 常见问题

- **日志里 `undici UNAVAILABLE`**：找不到 undici。此时走代理出口的请求会失败（不会直连），`direct` 不受影响。在 profile 的 patch 里给 `host-egress` 加 `config.undiciPath`（undici 的 `index.js` 绝对路径）后重启。
- **日志里 `CONFIG UNREADABLE, non-loopback requests are blocked`**：`config.json` 损坏或读不了，为了不误直连，所有外发请求都会被拦。修好或删掉这个文件（删掉等于回到全部直连）。
- **请求报错，带 “not retried directly”**：选中的代理不通。先在面板里「探测」该出口，或者临时把绑定改回 `direct`。
- **删出口提示 `in-use`**：它还被某个主机绑定或是默认出口，先改绑定再删。
- **停用插件后仍然走代理**：钩子故意不随插件停用撤销（否则已绑代理的主机会瞬间变直连）。要彻底撤销必须重启 DSH。
- **面板右上角显示「示例数据」**：浏览器连不上宿主接口（插件没装好、没重启，或登录过期）。
- **探测结果**：固定请求 `https://ifconfig.me/ip`（8 秒超时），不能自定义探测地址。

## 更多文档

- [docs/EGRESS.md](docs/EGRESS.md)：完整说明、架构、安全设计、部署与回滚清单。
- [docs/MIHOMO.md](docs/MIHOMO.md)：服务器上 mihomo 本地出口的运维说明。
- [docs/RESEARCH.md](docs/RESEARCH.md)：为什么这样实现（研究结论与证据）。
- [docs/DETAIL.zh.md](docs/DETAIL.zh.md) / [docs/DETAIL.md](docs/DETAIL.md)：功能简介（中 / 英）。

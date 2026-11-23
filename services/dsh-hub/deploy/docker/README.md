# 本地联调：Docker 里的 dsh-hub + 本地 DSH + Docker worker

在 MYDESK 上把整条链路跑一遍，不需要服务器，Windows 上也不用装 Node：

```
本地 DSH（dsh-local，控制方） ──https://127.0.0.1:7891──┐
                                                       ├─ hub 容器（自签 TLS，只发布在 127.0.0.1）
docker-worker 容器（node=docker，工作区 sandbox）──https://hub:7891──┘
```

前提：Docker Desktop 已启动。下面的命令都在 PowerShell 里、本目录下执行：

```powershell
cd E:\PythonProject\dsh-warroom\services\dsh-hub\deploy\docker
```

## 1. 启动 hub

```powershell
docker compose up -d --build hub
docker compose logs hub
```

日志里应能看到：
- `generating a local CA and a server certificate`（只在第一次启动时出现）
- `CA certificate copied to /out/hub-ca.pem`：本目录 `out\hub-ca.pem` 就是给 DSH 用的 CA
- `listening on https://0.0.0.0:7891`
- `no "allow" list` 警告：本地测试可以忽略，端口只发布在 127.0.0.1，外面访问不到

自检（显式不走代理，避免 Clash 的系统代理接管本机地址）：

```powershell
py -c "import ssl,urllib.request as u;o=u.build_opener(u.ProxyHandler({}),u.HTTPSHandler(context=ssl.create_default_context(cafile=r'out\hub-ca.pem')));print(o.open('https://127.0.0.1:7891/v1/health').read().decode())"
# {"ok":true,"version":"2.0.0","client_ip":"..."}
```

拉镜像失败时：在 Docker Desktop → Settings → Resources → Proxies 里填 `http://127.0.0.1:7890`。如果 `apk add` 失败，就在构建时加上 `--build-arg HTTPS_PROXY=http://host.docker.internal:7890`，同时打开 Clash 的「允许局域网连接」。

## 2. 给本地 DSH 签发控制方令牌

令牌只在签发时显示一次。下面这段会直接把它写进文件，不在屏幕上显示：

```powershell
New-Item -ItemType Directory -Force "$HOME\.dsh\agent-hub" | Out-Null
$t = (docker compose exec -T hub node server.mjs controller add dsh-local) -match '^dshc_' | Select-Object -First 1
"DSH_HUB_TOKEN=$t" | Set-Content -Encoding ascii "$HOME\.dsh\agent-hub\controller.local.env"
Remove-Variable t
(Get-Content "$HOME\.dsh\agent-hub\controller.local.env") -replace '=.+', '=***'   # 应输出 DSH_HUB_TOKEN=***
```

- 用单独的 `controller.local.env`，不会覆盖连服务器用的 `controller.env`。
- 想重新签发：先 `docker compose exec hub node server.mjs controller revoke dsh-local`，再执行上面这段。
- **不要**把它写进 `$HOME\.dsh\.env`，否则 DSH 会拒绝启动。

## 3. 把本地 DSH 指向这个 hub

编辑 `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml` 里的 `host-agent-hub` 段，改之前先备份：

```yaml
- id: host-agent-hub
  # name 等其他行保持原样
  config:
    hubUrl: https://127.0.0.1:7891
    controllerId: dsh-local
    caFile: E:/PythonProject/dsh-warroom/services/dsh-hub/deploy/docker/out/hub-ca.pem
    timeoutMs: 15000
    tokenEnv: DSH_HUB_TOKEN
    envFile: C:/Users/<你>/.dsh/agent-hub/controller.local.env
    # 不写 proxy：本机回环地址直连
```

原来连服务器的配置是 `hubUrl: https://<server>:7891`。可以先注释掉留着，测完再改回去。这个 profile 不会热加载，改完要**重启 DSH**。

在 DSH 对话里验证：让它调用 `agent_list`、`task_list`，结果应为空列表，并且不报错。

## 4. 启动 docker worker 并批准

```powershell
docker compose --profile worker up -d worker
docker compose logs -f worker
```

看到 `enrollment requested ... waiting` 就说明 worker 在等批准。然后在 DSH 对话里说：

> 调用 agent_requests，然后用 agent_approve 批准 docker-worker，workspaces 只给 sandbox。

worker 日志接着会出现 `approved`、`token saved`、`== run ==`，之后每 30 秒发一次心跳。`agent_list` 里应显示 docker-worker 为 online、node 为 docker、工作区为 sandbox。

## 5. 派一个任务，看完整闭环

在 DSH 对话里：

> task_dispatch：agent = docker-worker，type = document，workspace = sandbox，require_online = true，title = 本地联调，instruction = 列出工作区文件并回报。

几秒内 worker 日志会出现 `demo-executor: answered task_...`。再让 DSH 调用 `task_get`，传入这个 task_id 和 `output_name: summary.md`：应看到任务原文、`workspace: sandbox -> /workspaces/sandbox`，以及 `hello.txt`。

还可以顺便测下面几项：
- **离线提醒**：`docker compose stop worker`，等 90 秒后再派任务。不带 `require_online` 时会返回 `agent-offline` 提醒，带上则直接 409。重新 `start` 后，排队的任务会被领走。
- **按机器路由**：派任务时写 `node: mydesk`，docker-worker 不会领。
- **工作区校验**：写 `workspace: deepseek-harness`。因为没有授予这个工作区，派发时直接返回 409 `unroutable`。
- **面板**：右侧任务板的「Agent」标签能看到在线状态和任务。前提是 client-ui 已经编译过。

## 6. 下一步：让 AWS Quick 也作为 worker 接进来（可选）

用单独的 worker 目录，不影响连服务器的配置：

```powershell
$wd = "$HOME\.dsh\worker-local"
py E:\PythonProject\dsh-warroom\plugins\dsh-agent-hub\scripts\agent_client.py init --worker-dir $wd
# 编辑 $wd\.env：
#   DSH_HUB_URL=https://127.0.0.1:7891
#   DSH_HUB_PROXY=off
#   DSH_HUB_CAFILE=E:/PythonProject/dsh-warroom/services/dsh-hub/deploy/docker/out/hub-ca.pem
#   DSH_AGENT_ID=quick-mydesk
#   DSH_NODE=mydesk
#   DSH_EXCHANGE=E:/dsh-exchange
# 编辑 $wd\profile.json：{"node":"mydesk","workspaces":{"deepseek-harness":"E:/PythonProject/dsh-warroom"}}
py E:\PythonProject\dsh-warroom\plugins\dsh-agent-hub\scripts\agent_client.py register --worker-dir $wd
py E:\PythonProject\dsh-warroom\plugins\dsh-agent-hub\scripts\agent_client.py run --worker-dir $wd
```

AWS Quick 读写 `E:\dsh-exchange`。这个文件夹要在 Quick 的 Customize → Knowledge 里开放，再建一个定时计划去检查 inbox。

## 清理

```powershell
docker compose --profile worker down        # 停止容器，保留 hub 的状态和证书
docker compose --profile worker down -v     # 连数据卷一起删：令牌、状态、证书都会重建
```

`down -v` 之后 CA 会重新生成。DSH 和 worker 用的 `out\hub-ca.pem` 会自动更新，但控制方令牌要重新签发（第 2 步），docker worker 也要重新注册。

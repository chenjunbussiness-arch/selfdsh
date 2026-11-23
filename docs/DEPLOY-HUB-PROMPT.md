# 给云端 dsh 的部署提示词：dsh-hub + agent-hub 插件（v2）

> 用法：整段复制给服务器上的云端 dsh。分两轮：第一轮做到「重启 dsh-web 之前」就停，写报告；你手动重启后，再发第二轮。
> 原因：云端 dsh 自己就跑在 dsh-web 里，它重启 dsh-web 会把自己的会话断掉。

---

## 第一轮（部署，到重启前为止）

```text
你在这台 Linux 云服务器上以 root 工作（DSH_HOME=/root/.dsh，DSH 服务是 dsh-web.service）。任务：部署 dsh-hub v2（独立服务，端口 7891）并把 dsh-agent-hub 插件装进 web profile。用中文汇报。

红线（必须遵守）：
- 任何令牌、私钥、口令都不能出现在你的输出、日志或报告里；需要时只报告前缀（如 dshc_dsh-cloud_）和长度。签发令牌时用管道直接写进文件，不要先打印。
- 修改任何已有文件前先备份成 <文件>.bak-<时间戳>。
- 不要 git push，不要改 mihomo（17890/17892），不要关闭或放宽防火墙里 7891 以外的任何规则。
- 不要重启 dsh-web.service（你自己就跑在里面）。做到需要重启时停下，写报告。
- 某一步失败就停下，报告原文错误和你的判断，不要绕过 TLS 校验或权限检查。
- 任何 DSH_ 开头的变量（DSH_HUB_TOKEN、DSH_SECRETS_PASSPHRASE 等）都不能写进 /root/.dsh/.env：那是 DSH 自己的凭据文件，里面一出现 DSH_ 开头的变量，DSH 就拒绝启动（"... which only the launching environment may set ..."）。不要改 /root/.dsh/.env，也不要打印它的内容（只允许用 grep -c 统计 DSH_ 开头的行数）；计数不是 0 就停下告诉我。

步骤：
0. 环境：node --version（要求 >= 22）、command -v node（记下绝对路径，systemd 要用）、hostname -I、curl -s ifconfig.me（公网 IP）、ss -ltnp | grep -E ':7890|:7891|:17890' 。7891 已被占用就停下报告。

1. 代码：找到 dsh-warroom 仓库在本机的 checkout（看 /srv、/srv/workspace 下 git remote 含 dsh-warroom 的目录；记作 $REPO）。
   - git -C $REPO fetch --all，切到包含 v2 的分支（优先 agent-hub，其次 sync-to-gitea；用 git branch -a 列出来让我知道你选了哪个）。
   - 检查这些文件存在，缺任何一个就停下：
     $REPO/services/dsh-hub/server.mjs
     $REPO/services/dsh-hub/lib/{hub,http,config,cli}.js
     $REPO/plugins/dsh-agent-hub/packages/host-agent-hub/{index,hub-client,proxy,env-file,tools,bridge}.js
     $REPO/plugins/dsh-agent-hub/packages/client-ui-agent-hub/lib/client.js（前端构建产物）
     $REPO/plugins/dsh-router-b/packages/client-ui-router/lib/client.js
   - 运行测试：cd $REPO/services/dsh-hub && node --test tests/*.test.mjs；cd $REPO/plugins/dsh-agent-hub/packages/host-agent-hub && node --test tests/*.test.mjs。汇报通过数/失败数，有失败就停下。

2. TLS（服务器只接受外网流量，hub 自己做 TLS）：
   - 先看本机有没有能用的证书（/etc/letsencrypt/live/*、nginx 配置里的 ssl_certificate）。证书的 SAN 必须同时包含【公网 IP 或域名】和 127.0.0.1（同机的 dsh-cloud 用 https://127.0.0.1:7891 连）。
   - 没有合适的就自签：在 /etc/dsh-hub/tls/ 下生成一个 CA（ca.pem/ca.key）和一张服务器证书（fullchain.pem/privkey.pem），SAN = IP:<公网IP>, IP:127.0.0.1, DNS:localhost，有效期 825 天。私钥 chmod 600，目录 chmod 700。ca.key 生成完就移到 /root/.dsh/agent-hub/ca-private/（chmod 700）留档，不要放在 tls 目录里。
   - 汇报：证书路径、SAN、到期时间、sha256 指纹。

3. hub 配置 /root/.dsh/agent-hub/hub.json（目录 chmod 700）：
   {"port":7891,"host":"0.0.0.0",
    "tls":{"cert":"/etc/dsh-hub/tls/fullchain.pem","key":"/etc/dsh-hub/tls/privkey.pem"},
    "allow":["127.0.0.1/32","::1"],
    "trustProxy":false,"maxRetries":2,"offlineAfterMs":90000,"sweepIntervalMs":15000,"maxResultBytes":20971520}
   - allow 先只放回环地址。MYDESK 的出口 IP 现在还不知道：之后在 MYDESK 上跑 check，被 403 挡住时返回里会带 client_ip，再把它加进来。
   - 如果 /root/.dsh/agent-hub/state.json 已经存在，先备份并告诉我（可能是 v1 留下的）。

4. 签发控制方令牌（不要打印令牌）：
   cd $REPO/services/dsh-hub
   - dsh-cloud：先 install -d -m 700 /root/.dsh/agent-hub && install -m 600 /dev/null /root/.dsh/agent-hub/controller.env（文件已存在就先备份，如果里面已经有 DSH_HUB_TOKEN 行，停下问我）。再用管道把 `DSH_HOME=/root/.dsh node server.mjs controller add dsh-cloud` 输出里匹配 dshc_[A-Za-z0-9_-]+ 的那一段，写成一行 DSH_HUB_TOKEN=<令牌> 追加到 /root/.dsh/agent-hub/controller.env。之后 chmod 600 /root/.dsh/agent-hub/controller.env。**不要写进 /root/.dsh/.env**（DSH 会拒绝启动，见红线）。
   - dsh-local：同样方式写进 /root/.dsh/agent-hub/dsh-local.token（chmod 600），由我手动拷到 MYDESK。
   - 验证只用：grep -c '^DSH_HUB_TOKEN=dshc_dsh-cloud_' /root/.dsh/agent-hub/controller.env（应为 1）、grep -c '^[[:space:]]*\(export[[:space:]]\+\)\?DSH_' /root/.dsh/.env（应为 0，只看计数，不打印内容）、node server.mjs controller list。

5. systemd：
   sed -e 's#__DSH_WARROOM__#'"$REPO"'#g' -e 's#/usr/bin/node#<第0步的 node 绝对路径>#' $REPO/services/dsh-hub/deploy/dsh-hub.service > /etc/systemd/system/dsh-hub.service
   systemctl daemon-reload && systemctl enable --now dsh-hub
   等 3 秒后：systemctl status dsh-hub --no-pager；journalctl -u dsh-hub -n 50 --no-pager（应有 listening on https://0.0.0.0:7891）。
   自检：curl -s --cacert <CA 或 fullchain> https://127.0.0.1:7891/v1/health → {"ok":true,...,"client_ip":"127.0.0.1"}。

6. 本机防火墙：查 ufw / firewalld / iptables 有没有挡 7891，只放行 tcp/7891，不改别的。云厂商安全组你改不了：在报告里写明「需要用户在控制台安全组放行 TCP 7891 入站」。

7. agent-hub 插件（只做到重启前）：
   - node $REPO/plugins/dsh-agent-hub/scripts/install.mjs --profile /root/.dsh/profiles/web --dry-run，把输出给我看，再去掉 --dry-run 执行。
   - 在 /root/.dsh/profiles/web/cordis.patch.yml 末尾追加（先备份；如果已有 id: host-agent-hub 条目，改它而不是再加一个）：
     - id: host-agent-hub
       name: dsh-host-agent-hub
       config:
         hubUrl: https://127.0.0.1:7891
         controllerId: dsh-cloud
         caFile: <第2步的 CA 文件；用公共 CA 证书时删掉这一行>
         timeoutMs: 15000
         tokenEnv: DSH_HUB_TOKEN
         envFile: /root/.dsh/agent-hub/controller.env   # 默认值，可省略；绝不能是 /root/.dsh/.env
         # 同机直连，不写 proxy
   - 检查插件配置能被解析：dsh --profile web --dump-config | grep -n -A8 'id: host-agent-hub'（显示时把任何 dshc_ 开头的值打码）。
   - dsh-secrets：确认 profile 里 host-secrets 的 envFile 是 /root/.dsh/secrets.env（或不写，默认就是它），**不是** /root/.dsh/.env；DSH_SECRETS_PASSPHRASE 也不能在 /root/.dsh/.env 里（只汇报现状和变量名，不改）。

8. 写报告 /root/.dsh/agent-hub/DEPLOY-REPORT.md（不含任何令牌/私钥），内容：$REPO 和分支、测试结果、证书信息、hub 状态和自检结果、防火墙与安全组待办、插件安装输出、改过的文件和备份路径、给 MYDESK 的信息（hub 地址 https://<公网IP>:7891、CA 文件路径（需要拷到 MYDESK）、dsh-local.token 路径）。
   然后停下，告诉我：「可以重启 dsh-web 了」。
```

---

## 第二轮（你手动 `systemctl restart dsh-web` 之后再发）

```text
dsh-web 已经重启。继续验证 agent-hub，用中文汇报，红线同上一轮（不打印令牌）。
1. journalctl -u dsh-web -n 200 --no-pager | grep -i agent-hub：应看到 11 control tools registered、controller of https://127.0.0.1:7891 as dsh-cloud；没有 hub-token-missing / hub-unreachable。
2. 调用工具 agent_list、agent_requests、task_list，把结果给我（应该都是空的，但不能报错）。
3. 派一个测试任务：task_dispatch {agent: "pool:document", type: "document", title: "连通测试", instruction: "回复 ok"}，应返回 warnings: ["no-online-worker"]（还没有 worker 在线）。然后 task_cancel 掉它。
4. 验证任务强度：task_dispatch {agent: "pool:document", type: "document", title: "强度测试", instruction: "回复 ok", effort: {mode: "fast", thinking: "high"}} 应返回 400 bad-task（fast 没有思考）；改成 effort: {mode: "smart", thinking: "medium"} 应正常入队（warnings: ["no-online-worker"]），然后 task_cancel 掉。
5. 打开 Web 界面的右侧任务板，确认「现在 / 已结束 / 工作区」后面出现「Agent」标签（你看不到界面的话就跳过，告诉我去看）。
6. 更新 /root/.dsh/agent-hub/DEPLOY-REPORT.md 的验证部分。
```

---

## 升级：已部署的服务器加上 runtime / effort（协议第 10 节）

```text
把服务器上的 dsh-hub 和 agent-hub 插件升级到支持 worker runtime 和任务 effort 的版本。用中文汇报，不打印任何令牌。
1. cd $REPO && git pull（或按我给的方式同步代码），记下前后 commit。
2. 跑测试，全部通过才继续：
   cd $REPO/services/dsh-hub && node --test tests/*.test.mjs（必须包含 tests/runtime.test.mjs）
   cd $REPO/plugins/dsh-agent-hub && node --test packages/host-agent-hub/tests/*.test.mjs
3. systemctl restart dsh-hub，curl --cacert <CA> https://127.0.0.1:7891/v1/health 应返回 ok。
4. 停下，告诉我「可以重启 dsh-web 了」。我重启后你再：调用 agent_list，确认每个 worker 多了 runtime 字段（没声明的 worker 没有这个字段，正常）；按第二轮第 4 步验证 effort。
```

---

## 之后在 MYDESK 上做（不是给 dsh 的）

1. 默认直连，不用改 Clash。只有直连不通、或 hub 拒绝了本机 IP 时，才在 Clash 规则靠前加 `- IP-CIDR,<服务器公网IP>/32,<固定节点名>`，并在 `.env` 里设 `DSH_HUB_PROXY=http://127.0.0.1:7890`。
2. 把服务器上的 CA 文件拷到 `C:\Users\<你>\.dsh\worker\hub-ca.pem`；`dsh-local.token` 拷到本地 dsh 能读的地方（不要放进 Quick 能访问的文件夹）。
3. `python agent_client.py init`，在 `.env` 填 `DSH_HUB_URL=https://<服务器公网IP>:7891`、`DSH_HUB_PROXY=off`（直连；不通再换成 `http://127.0.0.1:7890`）、`DSH_HUB_CAFILE=C:/Users/<你>/.dsh/worker/hub-ca.pem`。
4. `python agent_client.py check` → 被 403 挡住时记下 `client_ip`，让云端 dsh 把它加进 hub.json 的 `allow` 并 `systemctl restart dsh-hub`，再 check 一次。
5. `python agent_client.py register` → 在 dsh 里 `agent_requests`（能看到 worker 声明的 runtime：档位、思考强度、可点名的 agent）/ `agent_approve` → `python agent_client.py run`。worker 的 runtime 写在 `profile.json`（不写就用平台内置值），改了下一次心跳自动同步。

# 在自家电脑上 clone 作战室仓库

适用：macOS / Linux 的 bash。Windows 用户请用 **Git Bash** 执行同样的命令（路径里的 `$HOME` 同样可用）。
仓库是私有仓，地址 `https://<服务器IP>:8444/dev/dsh-warroom.git`（Gitea `dev/dsh-warroom`），
证书是自签的，认证用 **Gitea 用户名 + token**。

按顺序做：**先确认网络通，再解决证书，最后 clone**。下面每一节都可以整段复制。

---

## 1. 前提

1. **服务器安全组放行 TCP 8444 入方向。** 这一步只能在阿里云控制台做，本机无法验证。
   没放行的现象是 `git clone` 一直卡住，或者直接 `Connection refused` / `Operation timed out`。
2. 本地 **git 2.30+**，带 `openssl` 和 `curl`（macOS / 主流 Linux 默认都有）。

```bash
git --version                     # 预期 git version 2.30 或更高
command -v openssl curl           # 预期打印两个路径
```

连通性自检（`-k` 只是跳过证书校验，用来区分「网络不通」和「证书不受信」）：

```bash
curl -k -sS -o /dev/null -w '%{http_code}\n' --max-time 10 \
  'https://<服务器IP>:8444/dev/dsh-warroom.git/info/refs?service=git-upload-pack'
# 预期 401：说明 8444 通了、请求到了 Gitea，只是没带凭据。
# 超时 / Connection refused：回第 1 条检查安全组和公网 IP。
```

## 2. 证书

服务器用的是自签证书：`subject = issuer = CN=<服务器IP>`，SAN 含 `IP:<服务器IP>` 和 `IP:127.0.0.1`，
有效期至 **2036-11-17**，只支持 TLS 1.2 / 1.3。浏览器和 git 默认都会报
`SSL certificate problem: self-signed certificate`。两种解法，任选一种。

### (a) 一次性跳过校验（最快，只对本次命令生效）

```bash
# 写法 1：环境变量，只影响这一条命令
GIT_SSL_NO_VERIFY=true git clone https://<服务器IP>:8444/dev/dsh-warroom.git

# 写法 2：-c 参数，同样只影响这一条命令
git -c http.sslVerify=false clone https://<服务器IP>:8444/dev/dsh-warroom.git
```

> 不要把 `http.sslVerify=false` 写进全局配置，否则对所有仓库都关掉了证书校验。

### (b) 正规做法：导出证书，只对这个站点信任

```bash
# 1) 从 8444 导出一份 PEM 证书（服务器证书是自签的，导出的就是它自己的 CA）
openssl s_client -connect <服务器IP>:8444 -servername <服务器IP> </dev/null 2>/dev/null \
  | openssl x509 -outform PEM > "$HOME/gitea-8444.crt"

# 2) 复核：不是空文件，且 subject / issuer 都是 CN = <服务器IP>
ls -l "$HOME/gitea-8444.crt"
openssl x509 -in "$HOME/gitea-8444.crt" -noout -subject -issuer -dates

# 3) 让 git 只对这个地址使用这份 CA（双引号里的 URL 必须带结尾的 /）
git config --global http."https://<服务器IP>:8444/".sslCAInfo "$HOME/gitea-8444.crt"

# 4) 验证：配置已写入，且 curl 用这份 CA 能完成 TLS 握手（401 只是没带凭据）
git config --get http."https://<服务器IP>:8444/".sslCAInfo   # 预期打印 crt 路径
curl -sS --cacert "$HOME/gitea-8444.crt" -o /dev/null -w '%{http_code}\n' --max-time 10 \
  'https://<服务器IP>:8444/dev/dsh-warroom.git/info/refs?service=git-upload-pack'
```

撤销（换机器、证书轮换或不想再信任时）：

```bash
git config --global --unset http."https://<服务器IP>:8444/".sslCAInfo
rm -f "$HOME/gitea-8444.crt"
```

浏览器里想不再点「继续访问」，可以把同一份 `gitea-8444.crt` 导入系统钥匙串 / 受信任根证书（可选，不影响 git）。

## 3. clone

```bash
mkdir -p "$HOME/src" && cd "$HOME/src"       # 换成你想放代码的目录
git clone https://<服务器IP>:8444/dev/dsh-warroom.git
cd dsh-warroom
```

首次会提示两次输入：

```text
Username for 'https://<服务器IP>:8444': <你的Gitea用户名>
Password for 'https://<你的Gitea用户名>@<服务器IP>:8444': <粘贴token>
```

- 用户名就是 Gitea 账号名；**密码处粘贴管理员单独发给你的 token**（输入时不回显，粘贴后直接回车）。
- 也可以把用户名写进 URL，这样只输 token：`git clone "https://<你的Gitea用户名>@<服务器IP>:8444/dev/dsh-warroom.git"`。
- 不想每次输，可以启用凭据缓存（可选）：macOS `git config --global credential.helper osxkeychain`；
  Linux `git config --global credential.helper 'cache --timeout=3600'`（`store` 会把 token 明文写进 `~/.git-credentials`，谨慎）。
- **token 只放在密码提示里，不要写进 URL、脚本或提交到任何文件。**

clone 完确认：

```bash
git log --oneline -1
ls            # 预期看到 plugins  profile  docs  README.md
```

## 4. 之后更新

```bash
cd "$HOME/src/dsh-warroom"
git status --short          # 先确认工作区干净
git fetch origin
git merge --ff-only origin/main
```

也可以写成一行（`git fetch && git merge --ff-only` 的完整形式）：`git fetch origin && git merge --ff-only origin/main`。

为什么不用 `git pull`：`pull` 会按 `pull.rebase` 配置自动 rebase，或者生成一个 merge commit，
在本地有改动时还可能悄悄留下冲突中间态。`git merge --ff-only` 只做快进，**一旦本地和远端分叉就直接报错**，
不会改历史，适合这种「只读部署 + 偶尔本地改配置」的仓库。

本地改过文件、又想先更新：

```bash
git stash push -u -m "local changes before update"
git fetch origin
git merge --ff-only origin/main
git stash pop                # 有冲突就手工解决
```

更新后如果 `plugins/**/lib/` 或 `profile/**` 有变化，按第 5 节重新走一遍安装与自检。

## 5. 装好后的验证（从这里开始真正安装）

clone 只是拿到源码，**装到 DSH 上要照 `docs/README-MIGRATE.md` 做**。四个关键章节（行号以当前仓库为准）：

| 章节 | 位置 |
|---|---|
| `### 2.5 install.mjs：调用顺序与参数` | `docs/README-MIGRATE.md` 第 158 行 |
| `### 2.6 profile 注册与 14 条软链校验` | 见 README-MIGRATE §0 |
| `### 2.7 4 段 --dump-config 验证` | 第 244 行 |
| `### 2.8 启动与自检` | 第 272 行 |

先复核锚点还在（行号变了就以 grep 结果为准）：

```bash
cd "$HOME/src/dsh-warroom"
grep -n '^### 2\.[5-8]' docs/README-MIGRATE.md
```

**第一步该做什么：**

1. **先通读 `docs/README-MIGRATE.md`**，从 **2.5** 起按序做；2.1–2.4 是系统依赖、Node/pnpm/DSH 版本与构建，新机同样要先过。
2. **把 `profile/` 的 4 个文件挂到目标机 `~/.dsh/profiles/web/`**：
   `cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml` 直接复制；
   `package.json` 按 2.6 节生成（**不要直接沿用仓库里带源机 `link:` 绝对路径的那份**）。

   ```bash
   cd "$HOME/src/dsh-warroom"
   mkdir -p "$HOME/.dsh/profiles/web"
   cp profile/cordis.patch.yml profile/cordis.yml profile/pnpm-workspace.yaml "$HOME/.dsh/profiles/web/"
   chmod 600 "$HOME/.dsh/profiles/web/cordis.patch.yml"
   # package.json 按 2.6 节第 2 步的 heredoc 生成
   ```

3. **跑 2.6 的顺序注册与 14 条软链校验**：顺序必须是 `dsh-router-b → dsh-egress → dsh-vpn → dsh-token-stats → dsh-secrets`
   （顺序即 bundles 顺序），校验脚本每行应输出 `OK <名字>`，最后 `ls -la ~/.dsh/profiles/web/node_modules | grep -c -- '->'` 为 12。
4. **跑 2.7 的 4 段 `--dump-config` 验证**：`dsh --profile web --dump-config | grep -n '^# == dsh-'` 应正好 4 行，
   且 `id: ui-brand-official` 下面有 `disabled: true`。
5. **最后跑 2.8 启动与自检**：`systemctl enable --now dsh-web.service dsh-web-gate.service`，
   入口链预期 `401 / 302 / 401`，`/api/router/board`、`/api/router/tiers`、`/api/token-stats/summary` 都是 200。
6. 之后换入新构建的 host 由**人工**执行 `plugins/dsh-router-b/scripts/safe-restart.sh`；构建用 `safe-build-host.sh`
   （只写 `lib.next/`），不要直接改运行中的 `lib/`。

## 6. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `SSL certificate problem: self-signed certificate`（或 `server certificate verification failed`） | git 不信任自签证书 | 回第 2 节：临时加 `-c http.sslVerify=false`，或导出 crt 配 `http.<url>.sslCAInfo` |
| `Authentication failed` / `401` / `403` | token 过期、粘贴错、或账号对该仓无权限 | 找管理员重发 token；确认用户名是 Gitea 账号名而不是邮箱；确认对 `dev/dsh-warroom` 至少有读权限 |
| `Repository not found` / `remote: Repository not found` | 组织名 / 仓库名拼错，或私有仓在未通过认证时不可见 | 确认 URL 是 `https://<服务器IP>:8444/dev/dsh-warroom.git`，并在提示时填了用户名 + token |
| `git clone` 卡住不动，或 `Connection refused` / `Operation timed out` | 安全组没放行 TCP 8444，或公网 IP 变了 | 控制台放行 8444 入方向；用第 1 节的 `curl -k` 自检区分网络与证书问题 |
| 导出的 `gitea-8444.crt` 是空文件 / `unable to load certificate` | 端口或 SNI 不对、或中间设备拦了 8444 | 确认 `-connect <服务器IP>:8444` 且带 `-servername <服务器IP>`；先跑第 1 节的 curl |

## 7. 结论

**本机第一步：确认 TCP 8444 通 → 按第 2 节解决自签证书 → `git clone` → 从 `docs/README-MIGRATE.md` 的 2.5 节开始按序安装。**

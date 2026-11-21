# CLONE.md · 在 Windows / WSL 上克隆 dsh-warroom（tag v2026.11.21）

本文只做一件事：把私有仓库 `dev/dsh-warroom` 安全地克隆到你的 Windows 或 WSL 机器上。
装到 DSH 里是下一步的事，见仓库里的 `docs/README-MIGRATE.md` 与同目录的 `MANIFEST.md`。

照抄规则：所有尖括号 `<...>` 都是占位符，**替换时连同尖括号一起删掉**；否则 bash 会把 `<`
当成输入重定向。命令默认在 **Git Bash**（Windows）或 **WSL 的 bash** 里执行，只有标注
PowerShell 的才在 PowerShell 里跑。

---

## 0. 先记住这几个事实

| 项 | 值 |
|---|---|
| 仓库地址 | `https://192.0.2.10:8444/dev/dsh-warroom.git` |
| Gitea 用户名 | `ops1e5d1a` |
| 仓库 | `dev/dsh-warroom`（私有） |
| 发布 tag | `v2026.11.21` |
| 访问方式 | HTTPS **8444**，强制 mTLS（必须带客户端证书） |
| 服务器证书（叶子） | **2026-11-21 已重签**：CN=`gitea-8444`，签发者 `CN=192.0.2.20`（旧自签根），SAN 含 `192.0.2.10`、`127.0.0.1`、`192.0.2.20`、`localhost`，有效期至 **2036-11-18**，SHA256 指纹 `5E:44:48:C6:…:4C:6E:50`，序列号 `035845556CB710B5D2FE270DF319273F` |
| 客户端信任锚 | 分发的 `gitea.crt` = **旧自签根**（CN=`192.0.2.20`，sha256 `6458b34e…626e9d`），本次**未变**；它是 CA，不是服务器叶子证书 |
| 客户端证书 | `client.p12`（PKCS#12，CN=`warroom-client`，颁发者 `DSH Client CA (gitea-8444)`，有效期至 2035-12-03） |
| p12 口令 | 服务器上的 `client-p12-password.txt`（单行） |
| Gitea 登录口令 | 服务器 `/root/.gitea-admin.cred`，**由管理员线下提供**；不要写进 URL、文档、脚本或聊天 |
| 旧地址 | 已废弃，**一律用 `192.0.2.10`**；旧地址只作为证书里的 CN/SAN 出现（见 2.5），不要用它连接 |

证书源目录（服务器上，只读）：

```text
/srv/workspace/.dsh-artifacts/gitea-mtls/
├── client.p12                 # 客户端证书 + 私钥（PKCS#12）
├── client-p12-password.txt    # 上面这个 p12 的口令（单行）
├── gitea.crt                  # 客户端信任锚 = 旧自签根（--cacert / sslCAInfo 用这个）
├── gitea-server-chain.crt     # 仅供核对/排障：当前 nginx 下发的叶子+根链（不是 --cacert 的替代品）
├── gitea-server.crt           # 仅供核对/排障：只含服务器叶子（看 SAN/有效期/指纹用）
├── client.crt                 # 可选：已转好的 PEM 客户端证书
└── client.key                 # 可选：已转好的 PEM 客户端私钥
```

先跑一次连通性自检（**只看端口/TLS 通不通**，不下载、不认证、不涉及证书校验判断）：

```bash
# Git Bash / WSL / macOS 都自带 openssl；能打印出下面的 subject/issuer 就说明端口通
openssl s_client -connect 192.0.2.10:8444 -servername 192.0.2.10 -brief </dev/null 2>&1 | head -20
# Windows PowerShell 也可以只探端口：
#   Test-NetConnection 192.0.2.10 -Port 8444
```

能连上（`CONNECTION ESTABLISHED` / 打印出 `subject=`）就说明 TCP 与 TLS 正常；此时不带客户端证书
访问会被 mTLS 拒绝（HTTP `400`），这是预期行为，第 4 节带上证书即可。
如果超时或 `Connection refused`，先看第 6.3 节，不要继续折腾证书。

---

## 1. 从服务器取证书三件套

> 前提：你有服务器 SSH 账号（`<user>`，通常是 `root`），并且能登录 `<server>`
> （就是 `192.0.2.10`）。没有 SSH 权限时，让管理员把这三个文件线下给你，放到同一个目录即可。

### 1.1 Git Bash / WSL / macOS

```bash
# 把这两个占位符换成实际值（尖括号一起删掉）
SCP_USER='<user>'       # 例：root
SCP_HOST='<server>'     # 例：192.0.2.10

mkdir -p "$HOME/gitea-mtls" && chmod 700 "$HOME/gitea-mtls"

scp "$SCP_USER@$SCP_HOST:/srv/workspace/.dsh-artifacts/gitea-mtls/client.p12" \
    "$SCP_USER@$SCP_HOST:/srv/workspace/.dsh-artifacts/gitea-mtls/client-p12-password.txt" \
    "$SCP_USER@$SCP_HOST:/srv/workspace/.dsh-artifacts/gitea-mtls/gitea.crt" \
    "$HOME/gitea-mtls/"

ls -l "$HOME/gitea-mtls"
```

如果服务器上还有 `client.crt` / `client.key`，可以顺手一起取（后面就不用再转换）：

```bash
scp "$SCP_USER@$SCP_HOST:/srv/workspace/.dsh-artifacts/gitea-mtls/client.crt" \
    "$SCP_USER@$SCP_HOST:/srv/workspace/.dsh-artifacts/gitea-mtls/client.key" \
    "$HOME/gitea-mtls/"
```

### 1.2 Windows PowerShell（系统自带 OpenSSH 的 scp）

```powershell
# 替换尖括号内容
$S = "<user>@<server>"          # 例：root@192.0.2.10
New-Item -ItemType Directory -Force "$HOME\gitea-mtls" | Out-Null

scp "${S}:/srv/workspace/.dsh-artifacts/gitea-mtls/client.p12"            "$HOME\gitea-mtls\"
scp "${S}:/srv/workspace/.dsh-artifacts/gitea-mtls/client-p12-password.txt" "$HOME\gitea-mtls\"
scp "${S}:/srv/workspace/.dsh-artifacts/gitea-mtls/gitea.crt"             "$HOME\gitea-mtls\"

Get-ChildItem "$HOME\gitea-mtls"
```

`$HOME` 在 PowerShell 里就是 `C:\Users\<你>`。证书目录权限收紧（可选，但建议）：

```powershell
icacls "$HOME\gitea-mtls" /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"
```

### 1.3 文件核对

```bash
cd "$HOME/gitea-mtls"
ls -l
file client.p12 gitea.crt 2>/dev/null || true
openssl x509 -in gitea.crt -noout -subject -issuer -dates
```

预期能看到 `client.p12`、`client-p12-password.txt`、`gitea.crt` 三个文件；
`gitea.crt` 是**客户端信任锚（旧自签根 CA）**，subject/issuer 都是 `CN = 192.0.2.20`，到期 2036-11-17。
想确认服务器当前用的是哪张叶子证书，再看 `gitea-server.crt`（新叶子 CN=`gitea-8444`，到期 2036-11-18）：

```bash
openssl x509 -in gitea-server.crt -noout -subject -issuer -dates -ext subjectAltName
```

`client-p12-password.txt` 里只有一行口令，不要 `cat` 到终端、不要贴到聊天里。

---

## 2. Windows 原生 Git：schannel 换成 OpenSSL，再把 p12 转 PEM

Windows 上原生 Git（Git for Windows）默认用 **schannel**（Windows 安全通道）。schannel
**不会**读取 `http.sslCert` / `http.sslKey` 指向的 PEM 文件，也不能直接吃 `.p12` 路径，
所以最常见的现象是：证书明明配了，服务器仍回 `400 No required SSL certificate was sent`。
解决方式就是本文这套：**切到 OpenSSL 后端 + 显式指定 PEM 证书和私钥**。

### 2.1 先看当前后端

在 **Git Bash** 里执行：

```bash
git --version
git config --show-origin --get http.sslBackend
openssl version
```

- `git config` 没输出（退出码 1）表示没显式配过后端，Git for Windows 默认走 schannel。
- 如果输出里能看到 `Program Files/Git/etc/gitconfig` 和 `schannel`，说明是**系统级**配置，
  下面用 `--global` 覆盖它（global 优先级高于 system）。
- `openssl` 找不到时，用 Git 自带的绝对路径：
  `"/c/Program Files/Git/usr/bin/openssl.exe" version`。

### 2.2 切到 OpenSSL 后端

```bash
git config --global http.sslBackend openssl
git config --show-origin --get http.sslBackend
```

第二行应输出 `file:"C:\\Users\\<你>\\.gitconfig"  openssl`。
如果公司策略在系统级锁了 schannel，global 仍然会覆盖；若还不行，检查有没有
`GIT_SSL_BACKEND` 环境变量：

```bash
echo "${GIT_SSL_BACKEND:-<未设置>}"
```

> 这个开关是**全局**的：切到 OpenSSL 后，访问其它 HTTPS 站点会改用 Git 自带的 CA bundle，
> 一般无感。若确实影响内网站点，可只在单条命令上加 `-c http.sslBackend=openssl`，不改全局。

### 2.3 把 client.p12 转成 PEM（证书 + 私钥）

在 Git Bash 里，进入证书目录：

```bash
cd "$HOME/gitea-mtls"

# 1) 只导出客户端证书（-clcerts 排除 p12 里的 CA 证书）
openssl pkcs12 -in client.p12 -clcerts -nokeys \
  -out client.crt -passin file:client-p12-password.txt

# 2) 导出私钥（-nodes = 私钥不再加密，方便 git 非交互读取）
openssl pkcs12 -in client.p12 -nocerts -nodes \
  -out client.key -passin file:client-p12-password.txt

chmod 600 client.key
ls -l client.crt client.key
```

口令输入方式二选一：

- **推荐**：`-passin file:client-p12-password.txt`，口令不经过命令行、不回显、不进 shell 历史；
  前提是当前目录就是口令文件所在目录（或写全路径 `file:C:/Users/<你>/gitea-mtls/client-p12-password.txt`）。
- 手输：去掉 `-passin ...`，执行后出现 `Enter Import Password:`，粘贴口令回车（输入不回显）。

转换后自检（三行都要正常）：

```bash
openssl x509 -in client.crt -noout -subject -issuer -dates
# 期望 subject=CN = warroom-client，issuer=CN = DSH Client CA (gitea-8444)

openssl pkey -in client.key -noout -check
# 期望 RSA key ok

openssl x509 -in client.crt -noout -pubkey | openssl sha256
openssl pkey -in client.key -pubout | openssl sha256
# 两行哈希必须相同，说明证书和私钥是一对
```

常见报错：

| 报错 | 原因 | 处理 |
|---|---|---|
| `Mac verify error: invalid password?` | 口令错、口令文件带 CRLF、或复制时多了空格 | 用 `xxd client-p12-password.txt` 看最后一行的字节（行尾应是 `0a`）；必要时 `tr -d '\r' < client-p12-password.txt > pw.txt` 后 `-passin file:pw.txt` |
| `unable to load client.p12` | 文件没下全 / 被当文本改过 | 重新 scp，核对字节数与服务器 `ls -l` 一致 |
| `No such file or directory` | 不在证书目录，或路径用了 `/c/...` 但 Git 读不到 | `pwd` 确认；用绝对路径 |

### 2.4 配置 server CA 与客户端证书（按 host:port 精确匹配）

Git 的 `http.<url>.*` 键必须**带端口**，否则匹配不到 8444，客户端证书会被静默地不发出去。
Windows 路径统一用**正斜杠** `C:/...`，不要用 `~`：

```bash
# 把 <你> 换成你的 Windows 用户名
git config --global http."https://192.0.2.10:8444/".sslCAInfo "C:/Users/<你>/gitea-mtls/gitea.crt"
git config --global http."https://192.0.2.10:8444/".sslCert   "C:/Users/<你>/gitea-mtls/client.crt"
git config --global http."https://192.0.2.10:8444/".sslKey    "C:/Users/<你>/gitea-mtls/client.key"
```

核对（应看到三行，键名里带 `:8444`）：

```bash
git config --global --get-regexp '^http\.'
```

路径与引号三条规则：

1. 值里有空格时必须整体加双引号，例如 `"C:/Users/Zhang San/gitea-mtls/client.crt"`。
2. 用正斜杠。若一定要用反斜杠，在 gitconfig 里每个 `\` 要写成 `\\`，否则会被当转义符；
   最省事的做法是不要用反斜杠。
3. **不要**把 Git Bash 的 `/c/Users/...` 写进配置给原生 `git.exe` 用；用
   `cygpath -w "$HOME/gitea-mtls/client.crt"` 看真正的 Windows 路径，再改写成 `C:/...`。

### 2.5 证书已重签（SAN 已含 192.0.2.10）：按正常配置即可，无需关校验

**2026-11-21 服务端证书已重签并 reload 完成**，新叶子证书：

| 项 | 值 |
|---|---|
| subject | `CN = gitea-8444` |
| issuer | `CN = 192.0.2.20`（旧自签根，未变） |
| SAN | `DNS:localhost`、`DNS:<ECS主机名>`、`IP:127.0.0.1`、`IP:192.0.2.10`、`IP:192.0.2.20` |
| 有效期 | 2026-11-21 → 2036-11-18 |
| SHA256 指纹 | `5E:44:48:C6:CB:90:84:37:43:E5:EE:FB:06:15:76:FB:73:81:20:BE:7C:90:B4:15:AA:96:87:D6:A0:4C:6E:50` |
| 序列号 | `035845556CB710B5D2FE270DF319273F` |

也就是说，之前那条“certificate subject name (192.0.2.20) does not match target host name
'192.0.2.10'”的报错**已经不存在了**。用 `192.0.2.10` 连接时，主机名校验能正常通过。

自己确认一遍（看服务器实际下发的叶子，不看信任锚）：

```bash
openssl s_client -connect 192.0.2.10:8444 -servername 192.0.2.10 \
  -CAfile "$HOME/gitea-mtls/gitea.crt" -brief </dev/null 2>&1 | head -20
# 期望：Verification: OK / Verify return code: 0 (ok)
# 想直接看 SAN 就用交付目录里的 gitea-server.crt：
openssl x509 -in "$HOME/gitea-mtls/gitea-server.crt" -noout -ext subjectAltName
# 期望输出里含 IP Address:192.0.2.10
```

三条边界，出错前先看这三条：

1. **CA 信任锚没变**：`gitea.crt` 仍然是那张旧自签根（CN=`192.0.2.20`，sha256
   `6458b34e…626e9d`）。老用户手里的 `gitea.crt` **继续有效，不用更换**；重新下载也无害
   （内容逐字节相同）。反过来说，**不要**拿 `gitea-server.crt` / `gitea-server-chain.crt`
   当 `sslCAInfo`——它们只是排障副本，会随叶子重签而变化。
2. **如果你本地固定过旧叶子**（例如把旧叶子指纹/证书写进了 `sslCAInfo`、证书固定（pinning）、
   或安全策略里的白名单），**需要更新**：旧叶子序列号 `6230F71C…F8A85E66`、有效期至 2036-11-17；
   新叶子序列号 `03584555…19273F`、有效期至 2036-11-18。固定旧叶子的客户端会报
   `certificate ... does not match` / `unknown authority`。
3. **出问题先分类，再决定，不要全局关校验**：

   | 现象 | 含义 | 处理 |
   |---|---|---|
   | `400 No required SSL certificate was sent` | 客户端证书没发出去（不是服务器证书问题） | 看 6.4 |
   | `certificate subject name ... does not match` | 主机名/SAN 不匹配 | 确认连的是 `192.0.2.10`，并确认 `gitea.crt` 是新的信任锚；不要用 `-k` 绕过 |
   | `unable to get local issuer certificate` / `unknown CA` | `sslCAInfo` 指错或没配 | 指回 `$HOME/gitea-mtls/gitea.crt`（见 6.1） |
   | `401` / `Authentication failed` | TLS 已通过，账号问题 | 看 6.2 |

> **不需要 `http.sslVerify=false`，也不要 `GIT_SSL_NO_VERIFY=1`。**
> 证书已经包含 `192.0.2.10`，按 2.4 正常配好 `sslCAInfo` / `sslCert` / `sslKey` 即可；
> 更不要执行 `git config --global http.sslVerify false`（那会对所有仓库永久关闭校验）。
> 本文任何章节都不会让你用“关校验”来换连通性。

---

## 3. WSL 配置法

WSL 里的 git 是 Linux 版（Debian/Ubuntu 打包，通常用 **gnutls** 后端）。它**不需要**也不支持
`http.sslBackend openssl`——本机实测会直接报：

```text
fatal: Unsupported SSL backend 'openssl'. Supported SSL backends:
        gnutls
```

先确认你用的是哪一个 git：

```bash
which git
git --version
```

- 输出 `git version 2.x.x`（不带 `windows`）→ 按本节配置，**不要**设 `sslBackend`。
- 输出里带 `windows`（说明你在 WSL 里调用了 `git.exe`）→ 回到第 2 节，按 Windows 原生 Git 配。

### 3.1 放证书并收紧权限

```bash
mkdir -p "$HOME/.gitea-mtls" && chmod 700 "$HOME/.gitea-mtls"

# 方式一：直接从服务器 scp（同 1.1，只是目标目录换成 ~/.gitea-mtls）
# 方式二：证书已经在 Windows 的 C:\Users\<你>\gitea-mtls，从 /mnt/c 拷进来
cp /mnt/c/Users/<你>/gitea-mtls/client.p12 \
   /mnt/c/Users/<你>/gitea-mtls/client-p12-password.txt \
   /mnt/c/Users/<你>/gitea-mtls/gitea.crt \
   "$HOME/.gitea-mtls/"

cd "$HOME/.gitea-mtls"
chmod 600 client.p12 client-p12-password.txt
chmod 644 gitea.crt
ls -l
```

如果只拿到三件套，先在 WSL 里转 PEM（命令同 2.3）：

```bash
cd "$HOME/.gitea-mtls"
openssl pkcs12 -in client.p12 -clcerts -nokeys -out client.crt -passin file:client-p12-password.txt
openssl pkcs12 -in client.p12 -nocerts -nodes -out client.key  -passin file:client-p12-password.txt
chmod 600 client.key
```

### 3.2 配置

```bash
git config --global http."https://192.0.2.10:8444/".sslCAInfo "$HOME/.gitea-mtls/gitea.crt"
git config --global http."https://192.0.2.10:8444/".sslCert   "$HOME/.gitea-mtls/client.crt"
git config --global http."https://192.0.2.10:8444/".sslKey    "$HOME/.gitea-mtls/client.key"
git config --global --get-regexp '^http\.'
```

`$HOME` 在 WSL 里是 Linux 路径（`/home/<你>`），Linux git 能直接读，没问题。

### 3.3 证书相关报错时

证书已于 2026-11-21 重签，SAN 已含 `192.0.2.10`，**按 3.2 配好即可，不需要关校验**。
真报错时按 2.5 的“三条边界 + 分类表”处理，不要用 `-k` / `GIT_SSL_NO_VERIFY=1` 绕过：

```bash
# 先看服务端信任链是否 OK（不下载代码）
openssl s_client -connect 192.0.2.10:8444 -servername 192.0.2.10 \
  -CAfile "$HOME/.gitea-mtls/gitea.crt" -brief </dev/null 2>&1 | head -20
```

### 3.4 环境变量兜底（可选的第二套写法）

部分 git 构建/发行版会读下面这些环境变量，可以用作兜底；**但不是所有版本都认**
（尤其 `GIT_SSL_CERT` / `GIT_SSL_KEY`），所以优先用 3.2 的 `git config`：

```bash
export GIT_SSL_CAINFO="$HOME/.gitea-mtls/gitea.crt"
export GIT_SSL_CERT="$HOME/.gitea-mtls/client.crt"
export GIT_SSL_KEY="$HOME/.gitea-mtls/client.key"
```

验证你的 git 到底认不认：把证书路径故意指错，如果报“加载证书失败”，说明认；
如果照常走到账号提示，说明不认，回 3.2：

```bash
GIT_SSL_CERT=/nonexistent.pem GIT_TERMINAL_PROMPT=0 \
  git ls-remote https://192.0.2.10:8444/dev/dsh-warroom.git 2>&1 | head -3
```

这些变量只对当前 shell 生效；别写进 `~/.bashrc` 当成永久配置（容易和 git config 打架）。

---

## 4. clone

### 4.1 口令从哪来

Gitea 登录口令在服务器 `/root/.gitea-admin.cred`，由管理员**线下**提供给你。
它和 p12 口令是两回事：

| 口令 | 用途 | 来源 |
|---|---|---|
| Gitea 登录口令 | HTTPS 认证（用户名 `ops1e5d1a`） | `/root/.gitea-admin.cred`，管理员线下给 |
| p12 口令 | 解锁 `client.p12` | `client-p12-password.txt`（第 1 节已取） |

**红线**：不要把口令写进 URL（`https://user:pass@...` 会把口令留在 shell 历史、git remote
配置和进程列表里）、不要写进任何文件、不要贴在聊天或 issue 里。只在 git 的 `Password:` 提示处输入。

### 4.2 先做一次“只握手、不拉代码”的自检

```bash
GIT_TERMINAL_PROMPT=0 git ls-remote https://192.0.2.10:8444/dev/dsh-warroom.git
```

- 输出 `fatal: could not read Username for 'https://192.0.2.10:8444': terminal prompts disabled`
  → **TLS 和 mTLS 都通了**，只差账号认证，可以继续 clone。
- 输出 `remote: Verify` + `fatal: Authentication failed`
  → 同样是**证书已通过**（服务器已经进到 HTTP 认证阶段），只是该账号需要二次验证/令牌；
  找管理员确认账号状态或改用访问令牌，**不要去关证书校验**。
- 输出 `400` / `certificate ... does not match` / `unable to get local issuer certificate`
  → 回第 2、3 节或第 6 节排查，先别 clone。

### 4.3 正式 clone（原文照抄）

```bash
mkdir -p "$HOME/src" && cd "$HOME/src"
git clone https://ops1e5d1a@192.0.2.10:8444/dev/dsh-warroom.git
```

首次会提示一次（用户名已经在 URL 里，所以只问口令）：

```text
Password for 'https://ops1e5d1a@192.0.2.10:8444':
```

把管理员给你的登录口令粘贴进去（输入不回显），回车。

- Windows 上如果弹出 Git Credential Manager 窗口，选“Token/Password”，粘贴同一个口令；
  它会缓存起来，下次 `git fetch` 不再问。
- WSL 想少输几次（可选，仅当前用户）：

```bash
git config --global credential.helper 'cache --timeout=3600'
```

- 不要用 `store`（会把口令明文写进 `~/.git-credentials`）。

### 4.4 切到发布 tag

```bash
cd dsh-warroom
git fetch --tags origin
git tag -l 'v2026.11.21'
git checkout v2026.11.21
```

`git checkout` 后处于 detached HEAD，这是发布 tag 的正常状态，不要在这个状态上直接改代码。
要改就先开分支：

```bash
git switch -c my-deploy v2026.11.21
```

### 4.5 tag 与下载包 zip 的关系

**tag `v2026.11.21` 是唯一发布基准。** 下载包 zip 由该 tag 对应的提交导出，不含 `.git`，
所以 `git checkout v2026.11.21` 后的工作树与解压 zip 得到的是同一批文件。

两处差异要知道：

1. zip 可能按插件平铺（顶层是 `dsh-router-b/`、`dsh-egress/`…），而仓库里是
   `plugins/dsh-router-b/`、`plugins/dsh-egress/`…；文件内容相同，只是前缀不同。
   对照表见 `MANIFEST.md` 第 1 节。
2. zip 里不会有 git 元数据（`.git/`、tag、提交历史）。

`vendor/exa-mcp-server/`（Exa stdio MCP，19 文件，MIT）和 `scripts/browser*` 也已随包提供，
**不需要**再 `npm install`；缺了它们说明包不完整。

互校方法：

```bash
git ls-files | wc -l          # 仓库文件数
unzip -l dsh-warroom-*.zip | tail -1   # zip 条目数（含目录条目，需减掉目录数）
test -f plugins/dsh-secrets/packages/host-secrets/vault.js && echo vault.js-OK
```

---

## 5. 验证清单（clone 完逐条跑）

```bash
cd "$HOME/src/dsh-warroom"

git log -1 --format='%H%n%ci%n%s'
# 期望：一个提交哈希 + 2026-11-21 的提交时间 + 发布说明

git tag -l
# 期望包含 v2026.11.21

git describe --tags
# 期望：v2026.11.21

git ls-remote origin
# 期望看到 refs/heads/main 和 refs/tags/v2026.11.21（会再问一次口令）

git ls-files | wc -l
# 期望 398 = 347（基线）+ 49（本次新增：dsh-secrets 22、vendor/exa 19、nginx 模板 5、
#             scripts 2、docs/MANIFEST.md 1）+ 根目录 CLONE.md、MANIFEST.md 2
# 以 tag 实际为准，不应低于 390

test -f plugins/dsh-secrets/packages/host-secrets/vault.js && echo 'OK: vault.js'
# 平铺包（没有 plugins/ 前缀）就用：test -f dsh-secrets/packages/host-secrets/vault.js
test -f plugins/dsh-router-b/packages/host-router/lib/index.js && echo 'OK: host-router lib'
test -f plugins/dsh-router-b/packages/client-ui-router/lib/client.js && echo 'OK: router client bundle'
test -f profile/package.json && echo 'OK: profile'
test -f vendor/exa-mcp-server/dist/stdio.cjs && echo 'OK: exa vendor'
test -f docs/MANIFEST.md && echo 'OK: docs MANIFEST'
test -x scripts/browser && echo 'OK: browser tool'

git status --short
# 期望：无输出（工作区干净）
```

再确认 tag 指向的就是当前 HEAD：

```bash
git rev-parse HEAD
git rev-parse v2026.11.21^{commit}
# 两行必须相同
```

---

## 6. 常见错误逐条排查

### 6.1 证书不受信任 / unknown CA / unable to get local issuer certificate

典型报错：

```text
SSL certificate problem: self-signed certificate
unable to get local issuer certificate
Problem with the SSL CA cert (path? access rights?)
```

按顺序查（四条以内解决）：

```bash
# 1) 后端是不是 OpenSSL、CA 路径是否真的配了
git config --show-origin --get http.sslBackend
git config --get http."https://192.0.2.10:8444/".sslCAInfo

# 2) 文件在不在、能不能被 openssl 读（这是信任锚 = 旧自签根，subject=issuer=CN=192.0.2.20）
openssl x509 -in "$HOME/gitea-mtls/gitea.crt" -noout -subject -dates

# 3) 信任锚自校验（期望 "gitea.crt: OK"）
openssl verify -CAfile "$HOME/gitea-mtls/gitea.crt" "$HOME/gitea-mtls/gitea.crt"

# 4) 服务器当前叶子能不能被这个信任锚验过（需要 gitea-server.crt；期望 OK）
openssl verify -CAfile "$HOME/gitea-mtls/gitea.crt" \
  -untrusted "$HOME/gitea-mtls/gitea-server-chain.crt" "$HOME/gitea-mtls/gitea-server.crt"
```

补充判断：

- `sslCAInfo` 为空 → 回 2.4 配；路径含 `~` 或 `/c/...` → 改成 `C:/...` 绝对路径。
- `sslCAInfo` 必须指向**旧自签根** `gitea.crt`（sha256 `6458b34e…626e9d`）。
  `gitea-server.crt` / `gitea-server-chain.crt` 是排障副本，链文件里虽然也含根、能“碰巧”验过，
  但会随叶子重签失效，**不要**用它当 `sslCAInfo`。
- 如果报的是 `certificate subject name ... does not match target host name`，那不是 CA 问题；
  2026-11-21 重签后 SAN 已含 `192.0.2.10`，出现这个错多半是本地还放着**旧叶子**或连错地址，见 2.5。

### 6.2 401 / 403 / Authentication failed

先分清是“TLS 没过（400）”还是“TLS 过了、账号不对（401/403）”：

```bash
GIT_TERMINAL_PROMPT=0 git ls-remote https://192.0.2.10:8444/dev/dsh-warroom.git
```

- `400` → 客户端证书没发出去，看 6.4，不是账号问题。
- `401` / `403` / `Authentication failed` → 账号或口令问题，按下面查：

```bash
# 1) 用户名必须是 Gitea 账号名 ops1e5d1a，不是邮箱
git config --get credential.username
git config --global --get credential.helper

# 2) 清掉缓存的旧凭据后重试
#    Windows：控制面板 → 凭据管理器 → Windows 凭据 → 删除 git:https://192.0.2.10
cmdkey /list | findstr 192.0.2.10
#    Git Bash 里也可以：
git credential-manager erase <<'EOF'
protocol=https
host=192.0.2.10:8444
EOF
```

```bash
# 3) 确认 p12 口令没错（不是 Gitea 口令）
openssl pkcs12 -in "$HOME/gitea-mtls/client.p12" \
  -passin file:"$HOME/gitea-mtls/client-p12-password.txt" -noout && echo P12-PASSWORD-OK
```

还要确认：账号对 `dev/dsh-warroom` 至少有读权限；口令不是旧的、没过期。

### 6.3 连接超时 / Connection refused / Operation timed out

先确认你连的是**新 IP**，不是旧 IP：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 \
  --cacert "$HOME/gitea-mtls/gitea.crt" https://192.0.2.10:8444/
# 期望 400（mTLS 拦截，说明 TLS 已通、只差客户端证书）；000 表示没连上
```

Windows PowerShell：

```powershell
Test-NetConnection 192.0.2.10 -Port 8444
curl.exe -m 10 -o NUL -w "%{http_code}`n" --cacert "$HOME\gitea-mtls\gitea.crt" https://192.0.2.10:8444/
```

WSL：

```bash
nc -vz -w 5 192.0.2.10 8444
```

如果 `Test-NetConnection` 的 `TcpTestSucceeded` 是 `False`：阿里云安全组放行 TCP **8444** 入方向，
并确认实例公网 IP 确实是 `192.0.2.10`。如果只有旧地址能连，说明你用的是过期资料，换回 `192.0.2.10`。

### 6.4 mTLS handshake 失败（400 / No required SSL certificate was sent / 495）

`400` 几乎都是“客户端证书没发出去”，而不是证书内容错。逐条查：

```bash
# 1) 后端 + 三个路径是否都配了（键名必须带 :8444）
git config --show-origin --get http.sslBackend
git config --global --get-regexp '^http\.https://8\.134\.170\.38:8444/'
```

```bash
# 2) 绕过 git，直接用 curl 验证“证书能不能过 nginx”（带 CA + 客户端证书，不关校验）
curl -sS -o /dev/null -w '%{http_code}\n' \
  --cacert "$HOME/gitea-mtls/gitea.crt" \
  --cert "$HOME/gitea-mtls/client.crt" --key "$HOME/gitea-mtls/client.key" \
  'https://192.0.2.10:8444/dev/dsh-warroom.git/info/refs?service=git-upload-pack'
# 期望 401（mTLS 与服务器证书校验都通过、只差账号）；400 = 证书没被接受
```

```bash
# 3) 看 TLS 握手细节
openssl s_client -connect 192.0.2.10:8444 -servername 192.0.2.10 \
  -cert "$HOME/gitea-mtls/client.crt" -key "$HOME/gitea-mtls/client.key" \
  -CAfile "$HOME/gitea-mtls/gitea.crt" -brief </dev/null
```

关键判断：

- 第 2 步 400，且 nginx 返回 `No required SSL certificate was sent` → 证书没发；检查
  `sslCert` / `sslKey` 是否指向 PEM（不是 `.p12`）、是否有读权限、键名端口是否 `:8444`。
- 第 2 步 400，且提示 `unknown ca` / `certificate unknown` → 服务器不认这张客户端证书：
  确认用的是 `client.p12` 里那张（CN=`warroom-client`，issuer=`DSH Client CA (gitea-8444)`），
  不是自己新签的；必要时找管理员核对 `ssl_client_certificate` 指向的 CA。
- 第 2 步 401 → mTLS 已通过，问题在 Gitea 账号，转 6.2。

### 6.5 Windows 反斜杠 / 路径 / 引号问题

典型报错：`could not load PEM client certificate`、`error reading X.509 key or certificate file`、
`Problem with the SSL CA cert (path? access rights?)`。

```bash
# 1) 看 git 实际读到的值（反斜杠有没有被吃掉）
git config --global --get-regexp '^http\.'

# 2) 看 Windows 真实路径，别把 /c/Users/... 写给原生 git.exe
cygpath -w "$HOME/gitea-mtls/client.crt"
ls -l "$HOME/gitea-mtls/client.crt" "$HOME/gitea-mtls/client.key"

# 3) 路径有空格时必须带引号
git config --global http."https://192.0.2.10:8444/".sslCert "C:/Users/Zhang San/gitea-mtls/client.crt"
```

规则回顾：

- 用 `C:/Users/<你>/...`（正斜杠）；用反斜杠就要写成 `C:\\Users\\...`（双反斜杠）。
- 不要用 `~`、不要用 `%USERPROFILE%`（git 不展开）。
- 在 Git Bash 里 `cd` 到目录后用 `pwd -W` 可以得到 `C:/...` 形式。
- 配置写错后，`git config --global --unset http."https://192.0.2.10:8444/".sslCert` 可撤销单条。

---

## 7. 安全红线（请当真）

1. `client.p12`、`client.key`、`client-p12-password.txt` 都是凭据：只放在 700 目录、600 权限，
   不要进仓库、不要进网盘、不要发群。
2. Gitea 登录口令只从管理员线下拿，只在 `Password:` 提示处输入；不要写进 URL、脚本、
   `.git-credentials`、issue、聊天记录。
3. **不需要关 `http.sslVerify`**：证书已重签，SAN 含 `192.0.2.10`，按第 2、3 节正常配置
   即可。任何情况下都不要 `git config --global http.sslVerify false`，也不要用
   `-c http.sslVerify=false` / `GIT_SSL_NO_VERIFY=1` 去换连通性；报错时按 6.x 先看错误类型。
4. 证书/口令一旦疑似泄露，找管理员重签客户端证书并改 Gitea 口令；旧证书在到期前技术上仍有效
   （当前未配 CRL）。
5. 仓库本身不含任何密钥、口令、证书、`sessions/`、`secrets.vault`；如果你在仓库里看到这类文件，
   不要提交，先报告管理员。

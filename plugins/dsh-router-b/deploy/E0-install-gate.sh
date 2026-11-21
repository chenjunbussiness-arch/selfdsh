#!/usr/bin/env bash
# Install the stable entry gate and put nginx back in front of it with a fixed
# password, so the page URL never changes again.
set -uo pipefail

echo "===== 1. 安装 gate 脚本 ====="
install -m 0755 /tmp/dsh-web-gate.mjs /usr/local/bin/dsh-web-gate.mjs
ls -l /usr/local/bin/dsh-web-gate.mjs

echo
echo "===== 2. systemd 单元 ====="
cat > /etc/systemd/system/dsh-web-gate.service <<'UNIT'
[Unit]
Description=DSH Web stable entry gate (127.0.0.1:42444 -> 42443)
After=network-online.target dsh-web.service
Wants=dsh-web.service

[Service]
Type=simple
ExecStart=/usr/local/bin/node /usr/local/bin/dsh-web-gate.mjs
Environment=GATE_PORT=42444
Environment=GATE_UPSTREAM_HOST=127.0.0.1
Environment=GATE_UPSTREAM_PORT=42443
Environment=GATE_TOKEN_LOG=/var/log/dsh-web.log
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now dsh-web-gate >/dev/null 2>&1
systemctl restart dsh-web-gate
sleep 2
systemctl is-active dsh-web-gate
ss -tln | grep 42444 || echo "NOT listening"

echo
echo "===== 3. nginx 换成固定密码 + 指向 gate ====="
cat > /etc/nginx/sites-available/dsh-web <<'CONF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 8443 ssl;
    server_name 8.134.170.38;

    ssl_certificate     /etc/nginx/tls/dsh.crt;
    ssl_certificate_key /etc/nginx/tls/dsh.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;

    # 明文 http 打到 8443 时自动跳到 https
    error_page 497 =301 https://$host:$server_port$request_uri;

    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host       $http_host;
    proxy_set_header X-Real-IP  $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout  3600s;
    proxy_send_timeout  3600s;
    proxy_buffering     off;

    client_max_body_size 512m;

    # 固定账号密码：这是"进页面的 key"，永不轮换。
    # DSH 自己的 launch token 由后面的 gate 自动补上，你不需要再管它。
    location / {
        auth_basic           "DSH";
        auth_basic_user_file /etc/nginx/.dsh-auth;
        proxy_pass http://127.0.0.1:42444;
    }
}
CONF
nginx -t 2>&1 | tail -2
systemctl reload nginx

echo
echo "===== 4. 本机自测 ====="
echo "--- 无凭据（应 401）---"
curl -sk -o /dev/null -w '  no-auth=%{http_code}\n' --max-time 8 https://127.0.0.1:8443/
echo "--- 有凭据访问裸根（应 302 到 ?token=）---"
# 安装时替换为实际口令：把下面 -u 'admin:<占位符>' 中的占位符换成实际值
curl -sk -u 'admin:__REDACTED_SET_ON_NEW_MACHINE__' -o /dev/null -w '  auth-root=%{http_code} loc=%{redirect_url}\n' --max-time 8 https://127.0.0.1:8443/
echo "--- gate 直连（绕过 nginx）---"
curl -s -o /dev/null -w '  gate-root=%{http_code} loc=%{redirect_url}\n' --max-time 8 http://127.0.0.1:42444/

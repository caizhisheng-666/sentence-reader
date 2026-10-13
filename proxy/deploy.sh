#!/usr/bin/env bash
# 在 Ubuntu 24.04 服务器上以 root 运行：bash deploy.sh
# 作用：装 Node.js 和 Caddy(自动 https)，把翻译中转配成开机自启服务。
# 密钥在运行时输入，只写入服务器上的 /etc/translate-proxy.env（仅 root 可读），不经过任何聊天或代码。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 root 运行"; exit 1; }

read -rp "API 域名（如 api.miaomiaosw.com）: " DOMAIN
read -rp "允许调用的网站地址，多个用逗号分隔（如 https://xxx.github.io）: " ORIGINS
read -rp "Access Key ID: " AK
read -rsp "Secret Access Key（输入时不显示）: " SK; echo

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nodejs git curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https gpg

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

DIR=/opt/translate-proxy
mkdir -p "$DIR"
cp "$(dirname "$0")/server.js" "$DIR/server.js"

umask 077
cat > /etc/translate-proxy.env <<EOF
VOLC_AK=$AK
VOLC_SK=$SK
ALLOW_ORIGINS=$ORIGINS
PORT=8787
USAGE_FILE=/var/lib/translate-proxy/usage.json
EOF
chmod 600 /etc/translate-proxy.env
umask 022

cat > /etc/systemd/system/translate-proxy.service <<EOF
[Unit]
Description=sentence-reader translate proxy
After=network.target
[Service]
ExecStart=/usr/bin/node $DIR/server.js
EnvironmentFile=/etc/translate-proxy.env
DynamicUser=yes
StateDirectory=translate-proxy
Restart=always
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:8787
}
EOF

systemctl daemon-reload
systemctl enable --now translate-proxy
systemctl restart caddy
sleep 3
echo "--- 本机检查 ---"
curl -s http://127.0.0.1:8787/health || true; echo
echo "完成。几十秒后在浏览器打开 https://$DOMAIN/health 应显示 ok:true"

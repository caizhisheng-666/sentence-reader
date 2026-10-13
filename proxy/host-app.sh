#!/usr/bin/env bash
# 在服务器上运行：sudo bash host-app.sh
# 作用：把「一句一读」放到本服务器，用 app.你的域名 访问；并每 5 分钟自动同步 GitHub main 的最新版。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行"; exit 1; }
read -rp "软件域名（如 app.miaomiaosw.com）: " APP
WEB=/var/www/sentence-reader

if [ ! -d "$WEB/.git" ]; then
  mkdir -p /var/www
  git clone --depth 1 -b main https://github.com/caizhisheng-666/sentence-reader.git "$WEB"
fi

# 同步任务：每 5 分钟拉一次 main
cat > /etc/cron.d/sentence-reader-update <<EOF
*/5 * * * * root cd $WEB && git fetch -q --depth 1 origin main && git reset -q --hard origin/main
EOF
chmod 644 /etc/cron.d/sentence-reader-update

# Caddy 站点
if ! grep -q "^$APP" /etc/caddy/Caddyfile; then
cat >> /etc/caddy/Caddyfile <<EOF

$APP {
  root * $WEB
  @hidden path /.git/* /proxy/* /*.md /index.backup*
  respond @hidden 404
  header Cache-Control "no-cache"
  encode gzip
  file_server
}
EOF
fi

# 允许新网址调用翻译中转
ENVF=/etc/translate-proxy.env
if ! grep -q "https://$APP" $ENVF; then
  sed -i "s|^ALLOW_ORIGINS=\(.*\)|ALLOW_ORIGINS=\1,https://$APP|" $ENVF
  systemctl restart translate-proxy
fi

systemctl reload caddy
sleep 3
echo "完成。浏览器打开 https://$APP 应能看到软件。"

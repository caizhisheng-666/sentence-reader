#!/bin/bash
# 自动更新翻译/书库服务器：网站目录里的 proxy/server.js 变了，就检查语法、换上、重启服务。
# 一次性安装（在服务器上执行一次）：
#   sudo cp /var/www/sentence-reader/tools/server-autoupdate.sh /usr/local/bin/sr-autoupdate.sh
#   sudo chmod +x /usr/local/bin/sr-autoupdate.sh
#   (sudo crontab -l 2>/dev/null; echo '* * * * * /usr/local/bin/sr-autoupdate.sh >> /var/log/sr-autoupdate.log 2>&1') | sudo crontab -
SRC=/var/www/sentence-reader/proxy/server.js
DST=/opt/translate-proxy/server.js
[ -f "$SRC" ] || exit 0
cmp -s "$SRC" "$DST" && exit 0
if node --check "$SRC" 2>/dev/null; then
  cp "$DST" "$DST.bak" 2>/dev/null
  cp "$SRC" "$DST" && systemctl restart translate-proxy && echo "$(date '+%F %T') server.js 已更新并重启"
else
  echo "$(date '+%F %T') 新的 server.js 语法有问题，没有更新"
fi

#!/bin/bash
# 网站自动更新：GitHub 上有新版本就快进更新 /var/www/sentence-reader；服务器上有改动时不动，只记日志
# 一次性安装（在服务器上执行一次，已于 2026-11-04 装好）：
#   sudo cp 本文件 /usr/local/bin/sr-site-update.sh && sudo chmod +x /usr/local/bin/sr-site-update.sh
#   (sudo crontab -l 2>/dev/null | grep -v sr-site-update; echo '* * * * * flock -n /tmp/sr-site-update.lock /usr/local/bin/sr-site-update.sh >> /var/log/sr-site-update.log 2>&1') | sudo crontab -
D=/var/www/sentence-reader
G="git -c safe.directory=$D -C $D"
$G fetch -q origin main 2>/dev/null || exit 0
[ "$($G rev-parse HEAD)" = "$($G rev-parse origin/main)" ] && exit 0
if $G merge --ff-only -q origin/main; then
  echo "$(date '+%F %T') 已更新：$($G log -1 --oneline)"
else
  echo "$(date '+%F %T') 没能自动更新（服务器上的文件被改过），请手动处理"
fi

#!/usr/bin/env bash
# 在服务器上运行：sudo bash /var/www/sentence-reader/proxy/caddy-cache.sh
# 作用：让浏览器把带版本号的组件文件（网址里有 ?v=）长期存在手机里，下次打开不用再下载；
#       网页本身（index.html 等）仍然每次检查更新。改之前会备份 Caddyfile，配置检查不通过会自动还原。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行"; exit 1; }
F=${CADDYFILE:-/etc/caddy/Caddyfile}
if grep -q '@versioned' "$F"; then echo "已经设置过了，不用再运行。"; exit 0; fi
BAK="$F.bak.$(date +%Y%m%d%H%M%S)"
cp "$F" "$BAK"
python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = '  header Cache-Control "no-cache"\n'
new = ('  @versioned query v=*\n'
       '  @plain not query v=*\n'
       '  header @versioned Cache-Control "public, max-age=31536000, immutable"\n'
       '  header @plain Cache-Control "no-cache"\n')
if old not in s:
    sys.exit('没找到 header Cache-Control "no-cache" 这一行，没有改动。')
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY
if caddy validate --config "$F" --adapter caddyfile >/tmp/caddy-validate.log 2>&1; then
  systemctl reload caddy
  echo "完成。组件文件以后会长期缓存在手机里。备份在 $BAK"
else
  cp "$BAK" "$F"
  echo "配置检查没通过，已经还原成原来的样子，网站不受影响。把下面的内容发给 Claude："
  tail -5 /tmp/caddy-validate.log
  exit 1
fi

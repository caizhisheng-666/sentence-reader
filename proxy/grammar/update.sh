#!/bin/bash
# 更新句子结构分析的代码（不重装 spaCy）：sudo bash /var/www/sentence-reader/proxy/grammar/update.sh
set -e
cp /var/www/sentence-reader/proxy/grammar/analyze.py /var/www/sentence-reader/proxy/grammar/server.py /opt/grammar/
systemctl restart grammar && sleep 5
curl -s http://127.0.0.1:8791/health | grep -q '"ok": true' && echo "✅ 已更新" || (echo "❌ 失败："; journalctl -u grammar -n 20 --no-pager)

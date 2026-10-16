#!/bin/bash
# 一句一读 · 安装句子结构分析服务（spaCy）。用法：sudo bash /var/www/sentence-reader/proxy/grammar/install.sh
set -e
SRC=/var/www/sentence-reader/proxy/grammar
DST=/opt/grammar
echo "== 1/5 安装 Python 工具"
apt-get update -qq && apt-get install -y -qq python3-venv python3-pip >/dev/null
echo "== 2/5 建立独立的 Python 环境 $DST/venv"
mkdir -p $DST && python3 -m venv $DST/venv
echo "== 3/5 安装 spaCy（约 1-3 分钟）"
$DST/venv/bin/pip install -q --upgrade pip
$DST/venv/bin/pip install -q "spacy>=3.8,<3.9"
echo "== 4/5 下载英语模型（约 35 MB）"
$DST/venv/bin/pip install -q "https://github.com/explosion/spacy-models/releases/download/en_core_web_md-3.8.0/en_core_web_md-3.8.0-py3-none-any.whl"
cp $SRC/analyze.py $SRC/server.py $DST/
echo "== 5/5 设置开机自动运行"
cat > /etc/systemd/system/grammar.service <<UNIT
[Unit]
Description=sentence-reader grammar (spaCy)
After=network.target
[Service]
ExecStart=$DST/venv/bin/python $DST/server.py
WorkingDirectory=$DST
Restart=always
RestartSec=3
MemoryMax=700M
User=nobody
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now grammar >/dev/null 2>&1
systemctl restart grammar
sleep 6
if curl -s http://127.0.0.1:8791/health | grep -q '"ok": true'; then echo "✅ 安装完成，句子结构分析服务已经在运行"; else echo "❌ 服务没有启动成功，请把下面这几行发给开发者："; journalctl -u grammar -n 20 --no-pager; fi

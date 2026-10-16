#!/usr/bin/env python3
# 一句一读 · 句子结构分析服务（只在本机 127.0.0.1 上监听，由 translate-proxy 转发）
# 运行：python3 server.py   （默认端口 8791，可用环境变量 GRAMMAR_PORT 改）
import json, os, sys, threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spacy
from analyze import analyze

MODEL = os.environ.get('GRAMMAR_MODEL', 'en_core_web_md')
nlp = spacy.load(MODEL, exclude=['ner'])
lock = threading.Lock()
cache = OrderedDict()

def get(s):
    with lock:
        if s in cache:
            cache.move_to_end(s); return cache[s]
    r = analyze(nlp, s)
    with lock:
        cache[s] = r
        while len(cache) > 20000: cache.popitem(last=False)
    return r

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _out(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if self.path == '/health': return self._out(200, {'ok': True, 'model': MODEL})
        self._out(404, {'error': 'not-found'})
    def do_POST(self):
        if self.path != '/parse': return self._out(404, {'error': 'not-found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            if n > 200000: return self._out(413, {'error': 'too-large'})
            j = json.loads(self.rfile.read(n) or b'{}')
            if isinstance(j.get('list'), list):
                lst = [str(x)[:800] for x in j['list'][:300]]
                return self._out(200, {'ok': True, 'list': [get(x) for x in lst]})
            s = str(j.get('s') or '').strip()[:800]
            if not s: return self._out(400, {'error': 'empty'})
            self._out(200, {'ok': True, 'r': get(s)})
        except Exception as e:
            self._out(500, {'error': 'parse-failed', 'msg': str(e)[:200]})

if __name__ == '__main__':
    port = int(os.environ.get('GRAMMAR_PORT', '8791'))
    print('grammar service on 127.0.0.1:%d (%s)' % (port, MODEL), flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()

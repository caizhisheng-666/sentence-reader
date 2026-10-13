// 一句一读 翻译中转：浏览器 -> 本服务 -> 火山引擎机器翻译(TranslateText)
// 密钥只从环境变量读取，绝不写进代码或网页。无第三方依赖，Node 18+ 即可。
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AK = process.env.VOLC_AK || '';
const SK = process.env.VOLC_SK || '';
const PORT = +process.env.PORT || 8787;
const ALLOW = (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MONTH_LIMIT = +process.env.MONTH_LIMIT || 1800000;      // 每月字符硬上限，低于免费的 200 万
const MAX_TEXT = +process.env.MAX_TEXT || 500;                // 单次最长字符
const RATE_PER_MIN = +process.env.RATE_PER_MIN || 120;         // 每个 IP 每分钟次数
const DAILY_PER_IP = +process.env.DAILY_PER_IP || 20000;      // 每个 IP 每天最多多少字符（只算真正请求火山的，缓存命中不算）
const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, 'cache.json');
const CACHE_MAX = +process.env.CACHE_MAX || 30000;
const USAGE_FILE = process.env.USAGE_FILE || path.join(__dirname, 'usage.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';              // 故事城后台口令（至少 20 位）。没设置就不开放上架功能
const SHOP_DIR = process.env.SHOP_DIR || path.join(path.dirname(USAGE_FILE), 'shop');
const SHOP_FILE = path.join(SHOP_DIR, 'catalog.json'), SHOP_FILES = path.join(SHOP_DIR, 'files'), SHOP_PRIV = path.join(SHOP_DIR, 'private');   // files 公开下载；private 是收费商品，只有付款后才发给买家
const MAX_UPLOAD = +process.env.MAX_UPLOAD || 300 * 1048576;
const HOST = process.env.VOLC_HOST || 'translate.volcengineapi.com';
const PROTO = process.env.VOLC_PROTO || 'https';
const REGION = 'cn-north-1', SERVICE = 'translate';

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// ---- 火山引擎 V4 签名 ----
function signedHeaders(body, now = new Date()) {
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261014T001200Z
  const short = xDate.slice(0, 8);
  const query = 'Action=TranslateText&Version=2020-06-01';
  const h = { 'content-type': 'application/json', host: HOST, 'x-content-sha256': sha(body), 'x-date': xDate };
  const names = Object.keys(h).sort();
  const canonHeaders = names.map(n => n + ':' + h[n]).join('\n') + '\n';
  const signedNames = names.join(';');
  const canonReq = ['POST', '/', query, canonHeaders, signedNames, sha(body)].join('\n');
  const scope = [short, REGION, SERVICE, 'request'].join('/');
  const toSign = ['HMAC-SHA256', xDate, scope, sha(canonReq)].join('\n');
  const kSign = hmac(hmac(hmac(hmac(SK, short), REGION), SERVICE), 'request');
  const sig = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
  h.authorization = `HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signedNames}, Signature=${sig}`;
  return { headers: h, query };
}

function volcTranslate(text) {
  const body = JSON.stringify({ TargetLanguage: 'zh', SourceLanguage: 'en', TextList: [text] });
  const { headers, query } = signedHeaders(body);
  const lib = PROTO === 'http' ? http : https;
  const [hostname, port] = HOST.split(':');
  return new Promise((resolve, reject) => {
    const req = lib.request({ hostname, port: port || undefined, path: '/?' + query, method: 'POST', headers, timeout: 8000 }, res => {
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => {
        let j; try { j = JSON.parse(buf); } catch (e) { return reject(new Error('upstream-bad-json')); }
        const list = j.TranslationList || (j.Result && j.Result.TranslationList);
        const t = list && list[0] && list[0].Translation;
        if (res.statusCode === 200 && t) return resolve(t);
        const meta = j.ResponseMetaData || j.ResponseMetadata || {};
        reject(new Error('upstream-' + res.statusCode + (meta.Error ? ':' + meta.Error.Code : '')));
      });
    });
    req.on('timeout', () => req.destroy(new Error('upstream-timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// ---- 月度用量（持久化到文件，重启不丢） ----
function monthKey() { return new Date().toISOString().slice(0, 7); }
let usage = { month: monthKey(), chars: 0 };
try { const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); if (u.month === monthKey()) usage = u; } catch (e) {}
function addUsage(n) {
  if (usage.month !== monthKey()) usage = { month: monthKey(), chars: 0 };
  usage.chars += n;
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (e) {}
}

// ---- 翻译缓存：同一句只请求一次火山，别的用户直接用 ----
let cache = new Map(), cacheDirty = false;
try { cache = new Map(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch (e) {}
function cacheGet(k) { return cache.get(k); }
function cacheSet(k, v) { if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); cache.set(k, v); cacheDirty = true; }
setInterval(() => { if (!cacheDirty) return; cacheDirty = false; try { fs.writeFileSync(CACHE_FILE, JSON.stringify([...cache])); } catch (e) {} }, 60000).unref();

// ---- 每个 IP 每天用量 ----
const daily = new Map();
const dayKey = () => new Date().toISOString().slice(0, 10);
function dailyUsed(ip) { const d = daily.get(ip); return d && d.day === dayKey() ? d.chars : 0; }
function dailyAdd(ip, n) { daily.set(ip, { day: dayKey(), chars: dailyUsed(ip) + n }); if (daily.size > 20000) for (const [k, v] of daily) if (v.day !== dayKey()) daily.delete(k); }

// ---- 简单限速 ----
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
  return arr.length > RATE_PER_MIN;
}

function send(res, code, obj, origin) {
  const h = { 'Content-Type': 'application/json; charset=utf-8' };
  if (origin) { h['Access-Control-Allow-Origin'] = origin; h['Vary'] = 'Origin'; }
  res.writeHead(code, h); res.end(JSON.stringify(obj));
}

// ---- 故事城商品目录：软件里“生成语音”后直接上架，不用再推送网站 ----
function shopRead() { try { const j = JSON.parse(fs.readFileSync(SHOP_FILE, 'utf8')); return Array.isArray(j.items) ? j : { items: [], removed: [] }; } catch (e) { return { items: [], removed: [] }; } }
function shopWrite(j) { fs.mkdirSync(SHOP_DIR, { recursive: true }); const t = SHOP_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(j)); fs.renameSync(t, SHOP_FILE); }
function adminOk(req) {
  if (ADMIN_TOKEN.length < 20) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest(), b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
const badTries = new Map();
function adminLimited(ip, fail) {
  const now = Date.now(), arr = (badTries.get(ip) || []).filter(t => now - t < 600000);
  if (fail) { arr.push(now); badTries.set(ip, arr); }
  return arr.length >= 8;
}
const pubHead = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };
function cleanItem(b) {
  if (!b || typeof b !== 'object') return null;
  const kind = b.kind === 'voice' ? 'voice' : 'story';
  const id = String(b.id || ''), title = String(b.title || '').slice(0, 120);
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(id) || !title) return null;
  const o = { id, kind, title };
  for (const k of ['titleZh', 'level', 'desc', 'forId']) if (typeof b[k] === 'string' && b[k]) o[k] = b[k].slice(0, 400);
  if (Number.isFinite(+b.count) && +b.count > 0) o.count = Math.round(+b.count);
  if (Number.isFinite(+b.price) && +b.price > 0 && +b.price < 100000) o.price = Math.round(+b.price * 100) / 100;
  if (b.voice === true) o.voice = true;
  if (typeof b.file === 'string' && /^(api:files\/[A-Za-z0-9._-]{1,90}|stories\/[A-Za-z0-9._-]{1,90})$/.test(b.file)) o.file = b.file;
  if (Array.isArray(b.preview)) o.preview = b.preview.slice(0, 5).map(p => ({ en: String((p && p.en) || '').slice(0, 300), zh: String((p && p.zh) || '').slice(0, 300) }));
  return o;
}
function readBody(req, limit) {
  return new Promise((ok, no) => { let raw = '', n = 0; req.on('data', c => { n += c.length; if (n <= limit) raw += c; }); req.on('end', () => n > limit ? no(new Error('too-big')) : ok(raw)); req.on('error', no); });
}
async function shopRoutes(req, res) {
  const url = req.url.split('?')[0];
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'GET' && url === '/catalog') { res.writeHead(200, { ...pubHead, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(shopRead())); return true; }
  let m = /^\/files\/([A-Za-z0-9._-]{1,90})$/.exec(url);
  if (req.method === 'GET' && m) {
    const f = path.join(SHOP_FILES, m[1]);
    if (!fs.existsSync(f)) { res.writeHead(404, pubHead); res.end(); return true; }
    res.writeHead(200, { ...pubHead, 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); return true;
  }
  if (!url.startsWith('/admin/')) return false;
  const origin = req.headers.origin, okO = origin && ALLOW.includes(origin) ? origin : null;
  const hd = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO) { hd['Access-Control-Allow-Origin'] = okO; hd.Vary = 'Origin'; }
  const out = (c, o) => { res.writeHead(c, hd); res.end(JSON.stringify(o)); return true; };
  if (!okO) return out(403, { error: 'origin-not-allowed' });
  if (adminLimited(ip, false)) return out(429, { error: 'too-many-failures' });
  if (!adminOk(req)) { adminLimited(ip, true); return out(401, { error: 'unauthorized' }); }
  try {
    m = /^\/admin\/private\/([A-Za-z0-9._-]{1,90})$/.exec(url);
    if (req.method === 'GET' && m) {
      const f = path.join(SHOP_PRIV, m[1]); if (!fs.existsSync(f)) return out(404, { error: 'not-found' });
      const h2 = { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(f).size }; if (okO) { h2['Access-Control-Allow-Origin'] = okO; h2.Vary = 'Origin'; }
      res.writeHead(200, h2); fs.createReadStream(f).pipe(res); return true;
    }
    if (req.method === 'POST' && url === '/admin/item') {
      const it = cleanItem(JSON.parse(await readBody(req, 20000))); if (!it) return out(400, { error: 'bad-item' });
      const j = shopRead(); const k = j.items.findIndex(x => x.id === it.id); if (k >= 0) j.items[k] = it; else j.items.push(it);
      j.removed = (j.removed || []).filter(x => x !== it.id); shopWrite(j); return out(200, { ok: true, count: j.items.length });
    }
    m = /^\/admin\/item\/([a-z0-9-]{1,60})$/.exec(url);
    if (req.method === 'DELETE' && m) {
      const j = shopRead(); j.items = j.items.filter(x => x.id !== m[1]); j.removed = [...new Set([...(j.removed || []), m[1]])]; shopWrite(j); return out(200, { ok: true });
    }
    m = /^\/admin\/file\/([A-Za-z0-9._-]{1,90}\.(?:zip|srbook))$/.exec(url);
    if (req.method === 'PUT' && m) {
      const priv = /[?&]private=1\b/.test(req.url), dir = priv ? SHOP_PRIV : SHOP_FILES;
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, '.' + m[1] + '.tmp'); let n = 0, bad = false;
      await new Promise((ok, no) => {
        const w = fs.createWriteStream(tmp); w.on('error', no);
        req.on('data', c => { if (bad) return; n += c.length; if (n > MAX_UPLOAD) { bad = true; w.destroy(); return; } w.write(c); });   // 超限就丢掉后面的数据，等对方发完再回 413
        req.on('end', () => { if (bad) { try { fs.unlinkSync(tmp); } catch (e) {} ok(); } else w.end(ok); }); req.on('error', no);
      });
      if (bad) return out(413, { error: 'too-big' });
      fs.renameSync(tmp, path.join(dir, m[1])); return out(200, { ok: true, bytes: n });
    }
  } catch (e) { return out(e.message === 'too-big' ? 413 : 400, { error: e.message === 'too-big' ? 'too-big' : 'bad-request' }); }
  return out(404, { error: 'not-found' });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'OPTIONS' && await shopRoutes(req, res)) return;
  const origin = req.headers.origin;
  const okOrigin = origin && ALLOW.includes(origin) ? origin : null;
  if (req.method === 'OPTIONS') {
    if (!okOrigin) { res.writeHead(403); return res.end(); }
    res.writeHead(204, { 'Access-Control-Allow-Origin': okOrigin, 'Access-Control-Allow-Methods': 'POST, PUT, DELETE, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', Vary: 'Origin' });
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, month: usage.month, used: usage.chars, limit: MONTH_LIMIT }, null);
  if (req.method !== 'POST' || req.url !== '/translate') return send(res, 404, { error: 'not-found' }, okOrigin);
  if (!okOrigin) return send(res, 403, { error: 'origin-not-allowed' }, null);   // 只允许你自己的网站调用
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return send(res, 429, { error: 'rate-limited' }, okOrigin);

  let raw = ''; let tooBig = false;
  req.on('data', c => { raw += c; if (raw.length > 4000) { tooBig = true; req.destroy(); } });
  req.on('end', async () => {
    if (tooBig) return;
    let text; try { text = JSON.parse(raw).text; } catch (e) {}
    if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'bad-request' }, okOrigin);
    text = text.slice(0, MAX_TEXT);
    const key = text.trim();
    const hit = cacheGet(key);
    if (hit) return send(res, 200, { translation: hit, cached: true }, okOrigin);   // 缓存命中：不占火山额度
    if (usage.month !== monthKey()) usage = { month: monthKey(), chars: 0 };
    if (usage.chars + text.length > MONTH_LIMIT) return send(res, 429, { error: 'quota' }, okOrigin);
    if (dailyUsed(ip) + text.length > DAILY_PER_IP) return send(res, 429, { error: 'daily' }, okOrigin);
    try {
      const t = await volcTranslate(text);
      addUsage(text.length); dailyAdd(ip, text.length); cacheSet(key, t);
      send(res, 200, { translation: t }, okOrigin);
    } catch (e) {
      console.error(new Date().toISOString(), e.message);
      send(res, 502, { error: 'upstream' }, okOrigin);
    }
  });
});

if (require.main === module) {
  if (!AK || !SK) { console.error('缺少环境变量 VOLC_AK / VOLC_SK'); process.exit(1); }
  if (!ALLOW.length) { console.error('缺少环境变量 ALLOW_ORIGINS（你的网站地址）'); process.exit(1); }
  server.listen(PORT, '127.0.0.1', () => console.log('translate proxy on 127.0.0.1:' + PORT));
}
module.exports = { server, signedHeaders };

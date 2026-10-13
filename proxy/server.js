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

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const okOrigin = origin && ALLOW.includes(origin) ? origin : null;
  if (req.method === 'OPTIONS') {
    if (!okOrigin) { res.writeHead(403); return res.end(); }
    res.writeHead(204, { 'Access-Control-Allow-Origin': okOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' });
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

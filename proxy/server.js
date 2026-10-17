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
  for (const k of ['titleZh', 'level', 'desc', 'forId', 'buy']) if (typeof b[k] === 'string' && b[k]) o[k] = b[k].slice(0, 400);
  if (Number.isFinite(+b.count) && +b.count > 0) o.count = Math.round(+b.count);
  if (Number.isFinite(+b.price) && +b.price > 0 && +b.price < 100000) o.price = Math.round(+b.price * 100) / 100;
  if (typeof b.buyUrl === 'string' && /^https:\/\/[^\s<>"']{4,300}$/.test(b.buyUrl)) o.buyUrl = b.buyUrl;      // 购买链接（比如闲鱼商品页），只收 https
  if (Number.isFinite(+b.freeUntil) && +b.freeUntil > 1e12 && +b.freeUntil < 4e12) o.freeUntil = Math.round(+b.freeUntil);      // 限时免费截止时间（毫秒时间戳）
  if (b.voice === true) o.voice = true;
  if (Number.isFinite(+b.ver) && +b.ver >= 1 && +b.ver < 100000) o.ver = Math.round(+b.ver);      // 内容更新次数：买家书架里的版本比它小，就提示“有更新”
  if (typeof b.file === 'string' && /^(api:files\/[A-Za-z0-9._-]{1,90}|stories\/[A-Za-z0-9._-]{1,90})$/.test(b.file)) o.file = b.file;
  if (typeof b.sample === 'string' && /^api:files\/[a-z0-9][a-z0-9-]{0,59}-sample\.srbook$/.test(b.sample)) o.sample = b.sample;      // 收费故事的免费试读版（比如第一章）
  if (Number.isFinite(+b.sampleCount) && +b.sampleCount > 0) o.sampleCount = Math.round(+b.sampleCount);
  if (Array.isArray(b.preview)) o.preview = b.preview.slice(0, 5).map(p => ({ en: String((p && p.en) || '').slice(0, 300), zh: String((p && p.zh) || '').slice(0, 300) }));
  return o;
}
// ---- 最小 zip 读写（故事包都是本软件生成的，不压缩或 deflate）：把语音拆成一句一个文件，读到哪句取哪句 ----
const zlib = require('zlib');
function unzipBuf(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('bad-zip');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad-zip');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28), raw = buf.slice(start, start + csize);
    if (!name.endsWith('/')) out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    p += 46 + nl + xl + cl;
  }
  return out;
}
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) {
  const parts = [], cen = []; let off = 0;
  for (const f of files) {
    const nm = Buffer.from(f.name), crc = crc32(f.data), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt32LE(0x00210000, 10);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(f.data.length, 18); h.writeUInt32LE(f.data.length, 22); h.writeUInt16LE(nm.length, 26);
    parts.push(h, nm, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt32LE(0x00210000, 12);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    cen.push(c, nm); off += 30 + nm.length + f.data.length;
  }
  const cd = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const CLIP_RE = /^clips\/([0-9a-f]{16,64})\.mp3$/;
function extractClips(id, entries, priv) {          // 语音拆成 files/<故事>/<句子哈希>.mp3
  const dir = path.join(priv ? SHOP_PRIV : SHOP_FILES, id); fs.mkdirSync(dir, { recursive: true });
  let n = 0; for (const e of entries) { const m = CLIP_RE.exec(e.name); if (m) { fs.writeFileSync(path.join(dir, m[1] + '.mp3'), e.data); n++; } }
  return n;
}
function rebuildVoiceZip(id, priv) {                // 增量补了几句语音以后，把“下载全部语音”的总包重新按目录里所有语音打一遍，免得总包只剩新补的几句
  const dir = path.join(priv ? SHOP_PRIV : SHOP_FILES, id); if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter(f => /^[0-9a-f]{16,64}\.mp3$/.test(f));
  const ents = files.map(f => ({ name: 'clips/' + f, data: fs.readFileSync(path.join(dir, f)) }));
  const target = path.join(priv ? SHOP_PRIV : SHOP_FILES, id + '.voice.zip'), tmp = target + '.tmp';
  fs.writeFileSync(tmp, zipStore([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'sr-voicepack', v: 1, id: 'story-' + id, count: files.length })) }, ...ents]));
  fs.renameSync(tmp, target); return files.length;
}
// ---- 兑换码：买家在闲鱼等地方付款后拿到兑换码，在软件里输入，服务器核对后把收费故事发给他 ----
const CODES_FILE = path.join(SHOP_DIR, 'codes.json'), CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', CODE_MAX_USES = 3;
function codesRead() { try { const j = JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')); return j && j.codes ? j : { codes: {} }; } catch (e) { return { codes: {} }; } }
function codesWrite(j) { fs.mkdirSync(SHOP_DIR, { recursive: true }); const t = CODES_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(j)); fs.renameSync(t, CODES_FILE); }
const normCode = x => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCode = c => c.replace(/(.{4})(?=.)/g, '$1-');
function genCode() { let c = ''; for (let i = 0; i < 12; i++) c += CODE_ALPHA[crypto.randomInt(CODE_ALPHA.length)]; return c; }
const redeemFails = new Map();
function redeemLimited(ip, fail) {
  const now = Date.now(), arr = (redeemFails.get(ip) || []).filter(t => now - t < 600000);
  if (fail) { arr.push(now); redeemFails.set(ip, arr); if (redeemFails.size > 5000) for (const [k, v] of redeemFails) if (!v.length || now - v[v.length - 1] > 600000) redeemFails.delete(k); }
  return arr.length >= 10;
}
const claimLog = new Map();
function claimLimited(ip) {                       // 限时免费：同一个网络 1 小时最多领 10 次
  const now = Date.now(), arr = (claimLog.get(ip) || []).filter(t => now - t < 3600000); arr.push(now); claimLog.set(ip, arr);
  if (claimLog.size > 5000) for (const [k, v] of claimLog) if (now - v[v.length - 1] > 3600000) claimLog.delete(k);
  return arr.length > 10;
}
// ---- 跟读打分：把用户读这一句的录音（16k 单声道 wav）转给 Azure 发音评估，Key 只放在服务器上 ----
const AZ_KEY = process.env.AZURE_SPEECH_KEY || '', AZ_REGION = process.env.AZURE_SPEECH_REGION || '', AZ_HOST = process.env.AZURE_STT_HOST || '';
const PRON_DAILY_MAX = +process.env.PRON_DAILY_MAX || 600, PRON_PER_IP_HOUR = +process.env.PRON_PER_IP_HOUR || 120;
const pronLog = new Map(); let pronDay = { d: '', n: 0 };
function pronLimited(ip) {
  const now = Date.now(), arr = (pronLog.get(ip) || []).filter(t => now - t < 3600000); arr.push(now); pronLog.set(ip, arr);
  if (pronLog.size > 5000) for (const [k, v] of pronLog) if (now - v[v.length - 1] > 3600000) pronLog.delete(k);
  const d = new Date().toISOString().slice(0, 10); if (pronDay.d !== d) pronDay = { d, n: 0 };
  if (arr.length > PRON_PER_IP_HOUR) return 'too-many';
  if (pronDay.n >= PRON_DAILY_MAX) return 'daily-limit';
  return '';
}
function pronAzure(wav, ref) {
  const pa = Buffer.from(JSON.stringify({ ReferenceText: ref, GradingSystem: 'HundredMark', Granularity: 'Phoneme', Dimension: 'Comprehensive', EnableMiscue: true })).toString('base64');
  const tu = /^http:\/\//.test(AZ_HOST) ? new URL(AZ_HOST) : null, host = tu ? tu.hostname : (AZ_HOST || AZ_REGION + '.stt.speech.microsoft.com');   // http:// 只用于本地测试
  return new Promise(ok => {
    const q = (tu ? http : https).request({ host, port: tu ? tu.port : 443, path: '/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed', method: 'POST', timeout: 15000,
      headers: { 'Ocp-Apim-Subscription-Key': AZ_KEY, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000', 'Pronunciation-Assessment': pa, Accept: 'application/json', 'Content-Length': wav.length } }, r => {
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => ok({ s: r.statusCode, b: Buffer.concat(ch).toString('utf8') }));
    });
    q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', e => ok({ s: 0, b: String(e && e.message) })); q.end(wav);
  });
}
/* ---------- AI 讲解：把一句英文交给豆包（火山方舟）讲清楚意思、难点词、语法。同一句只讲一次，结果存在服务器上，以后谁点都直接取 ---------- */
const ARK_KEY = process.env.ARK_API_KEY || '', ARK_MODEL = process.env.ARK_MODEL || 'doubao-seed-2-1-lite-260915', ARK_HOST = process.env.ARK_HOST || 'https://ark.cn-beijing.volces.com';
const EXPLAIN_DAILY_MAX = +process.env.EXPLAIN_DAILY_MAX || 300, EXPLAIN_PER_IP_HOUR = +process.env.EXPLAIN_PER_IP_HOUR || 30;
const EXPLAIN_FILE = path.join(SHOP_DIR, 'explain-cache.json');
const explainCache = new Map(); try { for (const [k, v] of JSON.parse(fs.readFileSync(EXPLAIN_FILE, 'utf8'))) explainCache.set(k, v); } catch (e) {}
let explainDirty = false;
setInterval(() => { if (!explainDirty) return; explainDirty = false; try { fs.mkdirSync(SHOP_DIR, { recursive: true }); const t = EXPLAIN_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify([...explainCache])); fs.renameSync(t, EXPLAIN_FILE); } catch (e) {} }, 30000).unref();
const explainLog = new Map(); let explainDay = { d: '', n: 0 };
function explainLimited(ip) {
  const now = Date.now(), arr = (explainLog.get(ip) || []).filter(t => now - t < 3600000); arr.push(now); explainLog.set(ip, arr);
  if (explainLog.size > 5000) for (const [k, v] of explainLog) if (now - v[v.length - 1] > 3600000) explainLog.delete(k);
  if (arr.length > EXPLAIN_PER_IP_HOUR) return 'too-many';
  return '';
}
function explainDailyFull() { const d = new Date().toISOString().slice(0, 10); if (explainDay.d !== d) explainDay = { d, n: 0 }; return explainDay.n >= EXPLAIN_DAILY_MAX; }
const EXPLAIN_SYS = '你是耐心的英语老师，学生是中国的小学生和他们的家长，英语基础比较弱。用户给你一句英文，你只输出一个 JSON 对象，不要任何别的文字，格式：' +
  '{"zh":"这句话自然流畅的中文意思","words":[{"w":"难词或短语原文","m":"在这句话里的意思，一句话"}],"grammar":"这句话最值得学的一个语法点，用简单的大白话讲，不超过 60 字","tip":"一个帮助记忆或朗读的小提示，可以为空字符串"}。' +
  'words 最多 4 个，只选真正会让学生卡住的词、短语、固定搭配，太简单的词不要选；如果整句都很简单，words 可以为空数组。语法点不要堆术语，要让小学生也能看懂。';
function arkChat(sentence) {
  const body = JSON.stringify({ model: ARK_MODEL, messages: [{ role: 'system', content: EXPLAIN_SYS }, { role: 'user', content: sentence }], temperature: 0.3, max_tokens: 700, thinking: { type: 'disabled' } });
  const u = new URL(ARK_HOST), isHttp = u.protocol === 'http:';
  return new Promise(ok => {
    const q = (isHttp ? http : https).request({ hostname: u.hostname, port: u.port || (isHttp ? 80 : 443), path: '/api/v3/chat/completions', method: 'POST', timeout: 25000,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ARK_KEY, 'Content-Length': Buffer.byteLength(body) } }, r => {
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => ok({ s: r.statusCode, b: Buffer.concat(ch).toString('utf8') }));
    });
    q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', e => ok({ s: 0, b: String(e && e.message) })); q.end(body);
  });
}
function parseExplain(text) {                       // 模型偶尔会在 JSON 外面套 ```json，宽松地取出来，并把字段整理干净
  const m = /\{[\s\S]*\}/.exec(String(text || '')); if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch (e) { return null; }
  const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
  const zh = str(j.zh, 300); if (!zh) return null;
  const words = (Array.isArray(j.words) ? j.words : []).slice(0, 4).map(x => ({ w: str(x && x.w, 60), m: str(x && x.m, 120) })).filter(x => x.w && x.m);
  return { zh, words, grammar: str(j.grammar, 200), tip: str(j.tip, 150) };
}
const GRAMMAR_URL = process.env.GRAMMAR_URL || 'http://127.0.0.1:8791', gramCache = new Map(), gramLog = new Map();
function gramLimited(ip) {                        // 同一个网络 1 小时最多分析 600 句
  const now = Date.now(), arr = (gramLog.get(ip) || []).filter(t => now - t < 3600000); arr.push(now); gramLog.set(ip, arr);
  if (gramLog.size > 5000) for (const [k, v] of gramLog) if (now - v[v.length - 1] > 3600000) gramLog.delete(k);
  return arr.length > 600;
}
let tkCache = { m: 0, map: new Map() };
function tokenLookup(tk) {                        // 买家凭证 → 他买的那本故事（兑换码被撤销就失效）
  if (!/^[0-9a-f]{32}$/.test(tk)) return null;
  let st; try { st = fs.statSync(CODES_FILE); } catch (e) { return null; }
  if (st.mtimeMs !== tkCache.m) { const map = new Map(), j = codesRead(); for (const r of Object.values(j.codes)) if (r.tk && !r.revoked) map.set(r.tk, r.story); tkCache = { m: st.mtimeMs, map }; }
  return tkCache.map.get(tk) || null;
}
function readBody(req, limit) {
  return new Promise((ok, no) => { let raw = '', n = 0; req.on('data', c => { n += c.length; if (n <= limit) raw += c; }); req.on('end', () => n > limit ? no(new Error('too-big')) : ok(raw)); req.on('error', no); });
}
function readBodyBuf(req, limit) {
  return new Promise((ok, no) => { const ch = []; let n = 0; req.on('data', c => { n += c.length; if (n <= limit) ch.push(c); }); req.on('end', () => n > limit ? no(new Error('too-big')) : ok(Buffer.concat(ch))); req.on('error', no); });
}
async function shopRoutes(req, res) {
  const url = req.url.split('?')[0];
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'GET' && url === '/catalog') { res.writeHead(200, { ...pubHead, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(shopRead())); return true; }
  const cm = /^\/files\/([a-z0-9][a-z0-9-]{0,59})\/([0-9a-f]{16,64})\.mp3$/.exec(url);
  if (req.method === 'GET' && cm) {
    const f = path.join(SHOP_FILES, cm[1], cm[2] + '.mp3');
    if (!fs.existsSync(f)) { res.writeHead(404, pubHead); res.end(); return true; }
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); return true;
  }
  const pm = /^\/pfiles\/([0-9a-f]{32})\/(story\.srbook|voice\.zip|[0-9a-f]{16,64}\.mp3)$/.exec(url);
  if (req.method === 'GET' && pm) {                 // 收费故事：只有兑换过的买家（凭证）才能取文字和语音
    const sid = tokenLookup(pm[1]), seg = pm[2];
    const f = !sid ? '' : seg === 'story.srbook' ? path.join(SHOP_PRIV, sid + '.srbook') : seg === 'voice.zip' ? path.join(SHOP_PRIV, sid + '.voice.zip') : path.join(SHOP_PRIV, sid, seg);
    if (!f || !fs.existsSync(f)) { res.writeHead(404, pubHead); res.end(); return true; }
    const mp3 = /\.mp3$/.test(seg);
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': mp3 ? 'private, max-age=86400' : 'no-store', 'Content-Type': mp3 ? 'audio/mpeg' : 'application/zip', 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); return true;
  }
  if (req.method === 'POST' && url === '/redeem') {
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    if (redeemLimited(ip, false)) return out0(429, { error: 'too-many-failures' });
    let b; try { b = JSON.parse(await readBody(req, 2000)); } catch (e) { return out0(400, { error: 'bad-request' }); }
    const code = normCode(b && b.code), j = codesRead(), rec = code.length === 12 ? j.codes[code] : null;
    if (!rec || rec.revoked) { redeemLimited(ip, true); return out0(404, { error: 'bad-code' }); }
    if ((rec.uses || 0) >= CODE_MAX_USES) return out0(403, { error: 'used-up' });
    const item = shopRead().items.find(x => x.id === rec.story); if (!item) return out0(404, { error: 'story-gone' });
    rec.uses = (rec.uses || 0) + 1; rec.lastAt = new Date().toISOString(); if (!rec.tk) rec.tk = crypto.randomBytes(16).toString('hex');
    codesWrite(j); return out0(200, { ok: true, tk: rec.tk, item, left: CODE_MAX_USES - rec.uses });
  }
  if (req.method === 'POST' && url === '/pron') {     // 跟读打分
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    if (!AZ_KEY || !(AZ_REGION || AZ_HOST)) return out0(503, { error: 'not-configured' });
    const ref = String(new URL(req.url, 'http://x').searchParams.get('text') || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!ref || !/[A-Za-z]/.test(ref)) return out0(400, { error: 'no-text' });
    const lim = pronLimited(ip); if (lim) return out0(429, { error: lim });
    let wav; try { wav = await readBodyBuf(req, 1200000); } catch (e) { return out0(413, { error: 'too-large' }); }
    if (!wav || wav.length < 1000 || wav.slice(0, 4).toString() !== 'RIFF') return out0(400, { error: 'bad-audio' });
    pronDay.n++;
    const r = await pronAzure(wav, ref);
    if (r.s === 401 || r.s === 403) return out0(502, { error: 'azure-key' });
    if (r.s !== 200) return out0(502, { error: 'azure-failed', code: r.s });
    let j; try { j = JSON.parse(r.b); } catch (e) { return out0(502, { error: 'azure-bad-reply' }); }
    if (j.RecognitionStatus && j.RecognitionStatus !== 'Success') return out0(200, { ok: false, status: j.RecognitionStatus });
    // Azure 短音频接口的分数有两种放法：直接放在 NBest[0] / 每个词上（常见），或包在 PronunciationAssessment 里。两种都认。
    const nb = (j.NBest || [])[0] || {}, pa = Object.assign({}, nb, nb.PronunciationAssessment || {});
    const words = (nb.Words || []).map(w => { const wp = Object.assign({}, w, w.PronunciationAssessment || {}); return { w: w.Word, s: Math.round(wp.AccuracyScore || 0), e: wp.ErrorType || 'None' }; });
    if (pa.PronScore == null && pa.AccuracyScore != null) pa.PronScore = (pa.AccuracyScore || 0) * 0.6 + (pa.FluencyScore || 0) * 0.2 + (pa.CompletenessScore || 0) * 0.2;
    return out0(200, { ok: true, total: Math.round(pa.PronScore || 0), acc: Math.round(pa.AccuracyScore || 0), flu: Math.round(pa.FluencyScore || 0), comp: Math.round(pa.CompletenessScore || 0), pros: pa.ProsodyScore != null ? Math.round(pa.ProsodyScore) : null, heard: nb.Display || '', words });
  }
  if (req.method === 'POST' && url === '/explain') {  // AI 讲解
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    if (!ARK_KEY) return out0(503, { error: 'not-configured' });
    let s0; try { s0 = String((JSON.parse(await readBody(req, 4000)) || {}).s || '').replace(/\s+/g, ' ').trim().slice(0, 600); } catch (e) { return out0(400, { error: 'bad-request' }); }
    if (!s0 || !/[A-Za-z]/.test(s0)) return out0(400, { error: 'empty' });
    const hit = explainCache.get(s0); if (hit) return out0(200, { ok: true, r: hit, cached: true });     // 讲过的句子：不花钱、不占次数
    if (explainLimited(ip)) return out0(429, { error: 'too-many' });
    if (explainDailyFull()) return out0(429, { error: 'daily-limit' });
    explainDay.n++;
    const r2 = await arkChat(s0);
    if (r2.s === 401 || r2.s === 403) return out0(502, { error: 'ark-key' });
    if (r2.s === 429) return out0(503, { error: 'ark-busy' });
    if (r2.s !== 200) return out0(502, { error: 'ark-failed', code: r2.s });
    let content = ''; try { content = JSON.parse(r2.b).choices[0].message.content; } catch (e) {}
    const r3 = parseExplain(content); if (!r3) return out0(502, { error: 'ark-bad-reply' });
    explainCache.set(s0, r3); explainDirty = true; if (explainCache.size > 20000) explainCache.delete(explainCache.keys().next().value);
    return out0(200, { ok: true, r: r3 });
  }
  if (req.method === 'POST' && url === '/grammar') {  // 句子结构分析：转给本机的 spaCy 服务（proxy/grammar/server.py）
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(typeof o === 'string' ? o : JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    if (gramLimited(ip)) return out0(429, { error: 'too-many' });
    let s0; try { s0 = String((JSON.parse(await readBody(req, 4000)) || {}).s || '').trim().slice(0, 800); } catch (e) { return out0(400, { error: 'bad-request' }); }
    if (!s0) return out0(400, { error: 'empty' });
    const hit = gramCache.get(s0); if (hit) return out0(200, hit);
    const body = JSON.stringify({ s: s0 }), gu = new URL(GRAMMAR_URL + '/parse');
    const r2 = await new Promise(ok => { const q = http.request({ hostname: gu.hostname, port: gu.port, path: gu.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000 }, rr => { let b = ''; rr.setEncoding('utf8'); rr.on('data', c => b += c); rr.on('end', () => ok({ s: rr.statusCode, b })); }); q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', () => ok(null)); q.end(body); });
    if (!r2 || r2.s !== 200) return out0(503, { error: 'grammar-unavailable' });
    gramCache.set(s0, r2.b); if (gramCache.size > 5000) gramCache.delete(gramCache.keys().next().value);
    return out0(200, r2.b);
  }
  if (req.method === 'POST' && url === '/claim') {   // 限时免费领取：活动期间不用兑换码，领到的买家永久拥有
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    if (claimLimited(ip)) return out0(429, { error: 'too-many' });
    let b; try { b = JSON.parse(await readBody(req, 2000)); } catch (e) { return out0(400, { error: 'bad-request' }); }
    const item = shopRead().items.find(x => x.id === String((b && b.story) || ''));
    if (!item || !item.price) return out0(404, { error: 'story-not-found' });
    if (!item.freeUntil || item.freeUntil < Date.now()) return out0(403, { error: 'not-free' });
    const j = codesRead(); let key; do { key = 'F' + genCode().slice(1); } while (j.codes[key]);
    const tk = crypto.randomBytes(16).toString('hex'); j.codes[key] = { story: item.id, at: new Date().toISOString(), uses: 1, free: true, tk }; codesWrite(j);
    return out0(200, { ok: true, tk, item });
  }
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
    m = /^\/admin\/sample\/([a-z0-9][a-z0-9-]{0,50})$/.exec(url);
    if (req.method === 'POST' && m) {                  // 试读版的语音：把收费故事里试读那几句的语音复制一份到公开目录
      const b = JSON.parse(await readBody(req, 200000)), hs = Array.isArray(b.hashes) ? b.hashes.filter(x => /^[0-9a-f]{16,64}$/.test(x)).slice(0, 5000) : [];
      const src = path.join(SHOP_PRIV, m[1]), dst = path.join(SHOP_FILES, m[1] + '-sample');
      fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(dst, { recursive: true });
      let n = 0; for (const h of hs) { const f = path.join(src, h + '.mp3'); if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(dst, h + '.mp3')); n++; } }
      return out(200, { ok: true, copied: n });
    }
    m = /^\/admin\/clips\/([a-z0-9][a-z0-9-]{0,59})$/.exec(url);
    if (req.method === 'GET' && m) {                   // 这本书服务器上已经有哪些句子的语音（补语音时只做缺的）
      const have = new Set(); for (const base of [SHOP_FILES, SHOP_PRIV]) { try { for (const f of fs.readdirSync(path.join(base, m[1]))) { const h = /^([0-9a-f]{16,64})\.mp3$/.exec(f); if (h) have.add(h[1]); } } catch (e) {} }
      return out(200, { have: [...have] });
    }
    if (req.method === 'POST' && url === '/admin/codes') {          // 给某本收费故事批量生成兑换码
      const b = JSON.parse(await readBody(req, 2000)), n = Math.max(1, Math.min(200, Math.round(+b.n || 1)));
      const it = shopRead().items.find(x => x.id === b.story); if (!it) return out(404, { error: 'story-not-found' });
      if (!it.price) return out(400, { error: 'story-is-free' });
      const j = codesRead(), made = [];
      while (made.length < n) { const c = genCode(); if (j.codes[c]) continue; j.codes[c] = { story: it.id, at: new Date().toISOString(), uses: 0 }; made.push(fmtCode(c)); }
      codesWrite(j); return out(200, { ok: true, codes: made });
    }
    if (req.method === 'POST' && url === '/admin/codes/issue') {      // 发货：取出下一个没用过、也没发出去过的码，并标记为“已发出”
      const b = JSON.parse(await readBody(req, 1000)), j = codesRead();
      if (b.undo) { const c = normCode(b.undo), r = j.codes[c]; if (!r) return out(404, { error: 'not-found' }); delete r.issued; codesWrite(j); return out(200, { ok: true }); }
      const ent = Object.entries(j.codes).filter(([, r]) => r.story === b.story && !r.free && !r.revoked && !r.uses && !r.issued).sort((a, c) => String(a[1].at).localeCompare(String(c[1].at)));
      if (!ent.length) return out(404, { error: 'none-left' });
      ent[0][1].issued = new Date().toISOString(); codesWrite(j);
      return out(200, { ok: true, code: fmtCode(ent[0][0]), left: ent.length - 1 });
    }
    if (req.method === 'GET' && url === '/admin/codes') {
      const q = new URL(req.url, 'http://x').searchParams.get('story') || '', j = codesRead();
      const list = Object.entries(j.codes).filter(([, r]) => !r.free && (!q || r.story === q)).map(([c, r]) => ({ code: fmtCode(c), story: r.story, at: r.at, uses: r.uses || 0, revoked: !!r.revoked, issued: !!r.issued })).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 1000);
      return out(200, { codes: list, max: CODE_MAX_USES });
    }
    m = /^\/admin\/codes\/([A-Za-z0-9-]{12,20})$/.exec(url);
    if (req.method === 'DELETE' && m) {
      const j = codesRead(), c = normCode(m[1]); if (!j.codes[c]) return out(404, { error: 'not-found' });
      j.codes[c].revoked = true; codesWrite(j); return out(200, { ok: true });
    }
    if (req.method === 'POST' && url === '/admin/item') {
      const it = cleanItem(JSON.parse(await readBody(req, 20000))); if (!it) return out(400, { error: 'bad-item' });
      const j = shopRead(); const k = j.items.findIndex(x => x.id === it.id); if (k >= 0) j.items[k] = it; else j.items.push(it);
      j.removed = (j.removed || []).filter(x => x !== it.id); shopWrite(j); return out(200, { ok: true, count: j.items.length });
    }
    m = /^\/admin\/price\/([a-z0-9][a-z0-9-]{0,59})$/.exec(url);
    if (req.method === 'POST' && m) {                  // 改价格：免费 ⇄ 收费，把这本书的文字和语音在公开目录和私有目录之间搬一下
      const id = m[1], b = JSON.parse(await readBody(req, 1000)), j = shopRead(), k = j.items.findIndex(x => x.id === id);
      if (k < 0) return out(404, { error: 'story-not-found' });
      const it = j.items[k], np = Math.round((+b.price || 0) * 100) / 100;
      if (!(np >= 0 && np < 100000)) return out(400, { error: 'bad-price' });
      const toPriv = np > 0 && !it.price, toFree = np === 0 && !!it.price;
      if (toPriv || toFree) {
        if (it.file && !/^api:files\//.test(it.file)) return out(400, { error: 'static-file' });
        const from = toPriv ? SHOP_FILES : SHOP_PRIV, to = toPriv ? SHOP_PRIV : SHOP_FILES, names = [id + '.srbook', id + '.voice.zip', id];
        if (!fs.existsSync(path.join(from, id + '.srbook'))) return out(404, { error: 'file-not-found' });
        if (names.some(n => fs.existsSync(path.join(to, n)))) return out(409, { error: 'target-exists' });
        fs.mkdirSync(to, { recursive: true });
        for (const n of names) if (fs.existsSync(path.join(from, n))) fs.renameSync(path.join(from, n), path.join(to, n));
        if (toPriv) delete it.file; else it.file = 'api:files/' + id + '.srbook';
      }
      if (np > 0) it.price = np; else delete it.price;
      shopWrite(j); return out(200, { ok: true, price: np, moved: toPriv ? 'private' : toFree ? 'public' : '' });
    }
    m = /^\/admin\/split\/([a-z0-9][a-z0-9-]{0,59})$/.exec(url);
    if (req.method === 'POST' && m) {                  // 旧格式（语音打包在故事里）→ 故事只留文字，语音拆成一句一个文件
      const priv = !fs.existsSync(path.join(SHOP_FILES, m[1] + '.srbook')), dir = priv ? SHOP_PRIV : SHOP_FILES, f = path.join(dir, m[1] + '.srbook');
      if (!fs.existsSync(f)) return out(404, { error: 'not-found' });
      const ents = unzipBuf(fs.readFileSync(f)), clipsE = ents.filter(e => CLIP_RE.test(e.name)), rest = ents.filter(e => !CLIP_RE.test(e.name));
      if (!clipsE.length) return out(200, { ok: true, already: true });
      const n = extractClips(m[1], clipsE, priv);
      fs.writeFileSync(path.join(dir, m[1] + '.voice.zip'), zipStore([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'sr-voicepack', v: 1, id: 'story-' + m[1], count: n })) }, ...clipsE]));
      const tmp2 = f + '.tmp'; fs.writeFileSync(tmp2, zipStore(rest)); fs.renameSync(tmp2, f);
      return out(200, { ok: true, clips: n, bytes: fs.statSync(f).size });
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
      fs.renameSync(tmp, path.join(dir, m[1]));
      const vm = /^([a-z0-9][a-z0-9-]{0,59})\.voice\.zip$/.exec(m[1]);
      let clips = 0; if (vm) { try { clips = extractClips(vm[1], unzipBuf(fs.readFileSync(path.join(dir, m[1]))), priv); rebuildVoiceZip(vm[1], priv); } catch (e) { return out(400, { error: 'bad-voice-zip' }); } }
      return out(200, { ok: true, bytes: n, clips });
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

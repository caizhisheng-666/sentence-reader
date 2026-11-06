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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';              // 故事城后台口令（至少 8 位；连续输错 8 次会被锁 10 分钟）。没设置就不开放上架功能
const SHOP_DIR = process.env.SHOP_DIR || path.join(path.dirname(USAGE_FILE), 'shop');
const SHOP_FILE = path.join(SHOP_DIR, 'catalog.json'), SHOP_FILES = path.join(SHOP_DIR, 'files'), SHOP_PRIV = path.join(SHOP_DIR, 'private');   // files 公开下载；private 是收费商品，只有付款后才发给买家
const MAX_UPLOAD = +process.env.MAX_UPLOAD || 300 * 1048576;
const VOICE_PART_MAX = +process.env.VOICE_PART_MAX || 64 * 1048576;   // 语音总包会自动切成每份约这么大（买家手机一次只处理一份，不会撑爆内存）
const VOICE_ZIP_MAX = +process.env.VOICE_ZIP_MAX || 3 * 1024 * 1048576;   // “下载全部语音”总包的体积上限（合并时要整个读进内存，服务器内存小就别调大）
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
const baseOf = id => String(id).replace(/--[a-z0-9-]+$/, '');      // “编号--am-michael” 是这本书第二个声音的语音目录
function shopRead() { try { const j = JSON.parse(fs.readFileSync(SHOP_FILE, 'utf8')); return Array.isArray(j.items) ? j : { items: [], removed: [] }; } catch (e) { return { items: [], removed: [] }; } }
function shopWrite(j) { fs.mkdirSync(SHOP_DIR, { recursive: true }); const t = SHOP_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(j)); fs.renameSync(t, SHOP_FILE); }
function adminOk(req) {
  if (ADMIN_TOKEN.length < 8) return false;
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
  if (Array.isArray(b.voices)) { const v = [...new Set(b.voices.filter(x => typeof x === 'string' && /^[a-z0-9_]{1,24}$/.test(x)))].slice(0, 8); if (v.length) o.voices = v; }   // 另外录好的声音（比如男声 am_michael），语音在“编号--am-michael”目录
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
// ---- 每本书含多少个雅思词（B1 及以上）：书单里显示“含 XX 个雅思词”。和手机书架上的算法一样（同一份 grammar.js 还原词形、同一份 ielts/words.json），
//      按书文件的修改时间缓存，书更新了会重算。网站目录里没有词库时不显示，不影响书单 ----
const SITE_DIR = process.env.SITE_DIR || '/var/www/sentence-reader';
/* ---------- 每天自动备份：把服务器上“丢了就找不回”的小文件（兑换码、目录、报错、统计、AI 讲解缓存、书的文字、补充雅思词条）打成一个包。
   录音（mp3/zip）和朗读缓存不进包：录音在你电脑上能重录，朗读缓存会自动重新生成。包放在 BACKUP_DIR，保留最近 BACKUP_KEEP 份；
   你电脑上的喵喵录音机会定时把最新的包下载到 D:\19.喵喵录书\服务器备份（异地一份），开发者模式里也能手动下载 ---------- */
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(SHOP_DIR), 'backups'), BACKUP_KEEP = +process.env.BACKUP_KEEP || 30;
const BACKUP_NAME = /^sr-\d{8}-\d{4}\.tar\.gz$/;
let backupBusy = false, backupLast = '';
function backupList() {
  try { return fs.readdirSync(BACKUP_DIR).filter(f => BACKUP_NAME.test(f)).sort().reverse().map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, bytes: st.size, mtime: st.mtimeMs }; }); } catch (e) { return []; }
}
function backupRun() {
  if (backupBusy) return Promise.resolve({ ok: false, error: 'busy' });
  backupBusy = true;
  const d = new Date(Date.now() + 8 * 3600000).toISOString(), name = 'sr-' + d.slice(0, 10).replace(/-/g, '') + '-' + d.slice(11, 16).replace(':', '') + '.tar.gz';   // 文件名用北京时间
  const out = path.join(BACKUP_DIR, name), tmp = out + '.tmp';
  const args = ['-czf', tmp, '--exclude=*.mp3', '--exclude=*.zip', '--exclude=*.tmp', '--exclude=./tts', '-C', SHOP_DIR, '.'];
  if (fs.existsSync(path.join(SITE_DIR, 'ielts', 'extra'))) args.push('-C', SITE_DIR, 'ielts/extra');
  if (fs.existsSync(USAGE_FILE)) args.push('-C', path.dirname(USAGE_FILE), path.basename(USAGE_FILE));
  return new Promise(ok => {
    try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
    require('child_process').execFile('tar', args, { timeout: 600000 }, (err, so, se) => {
      backupBusy = false;
      if (err && err.code !== 1) { try { fs.unlinkSync(tmp); } catch (e) {} backupLast = new Date().toISOString() + ' 失败：' + String(se || err.message).slice(0, 200); console.error('backup failed:', backupLast); return ok({ ok: false, error: backupLast }); }   // tar 返回 1 只是“打包时有文件在变”，包照样能用
      try { fs.renameSync(tmp, out); } catch (e) { return ok({ ok: false, error: String(e.message) }); }
      for (const x of backupList().slice(BACKUP_KEEP)) { try { fs.unlinkSync(path.join(BACKUP_DIR, x.name)); } catch (e) {} }
      backupLast = new Date().toISOString() + ' 成功：' + name; ok({ ok: true, name, bytes: fs.statSync(out).size });
    });
  });
}
setInterval(() => { const l = backupList()[0]; if (!l || Date.now() - l.mtime > 20 * 3600000) backupRun(); }, 3600000).unref();   // 每小时看一眼：最新的包超过 20 小时就再打一个
setTimeout(() => { const l = backupList()[0]; if (!l || Date.now() - l.mtime > 20 * 3600000) backupRun(); }, 60000).unref();
const IW = { ok: null, failAt: 0, cache: new Map(), lem: new Map() };
function iwInit() {
  const xf = path.join(SITE_DIR, 'ielts', 'extra', 'words-extra.json');     // 补充词条（生成后才有）：文件变了就整个重新加载
  let xm = 0; try { xm = fs.statSync(xf).mtimeMs; } catch (e) {}
  if (IW.ok && xm !== IW.xm) { IW.ok = null; IW.cache.clear(); IW.lem.clear(); }
  if (IW.ok) return true;
  if (IW.ok === false && Date.now() - IW.failAt < 600000) return false;   // 失败了 10 分钟后再试（比如词库还没传上来）
  try {
    const vm = require('vm'), ctx = { window: {} }; ctx.self = ctx.window; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(SITE_DIR, 'grammar.js'), 'utf8'), ctx);
    const words = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'ielts', 'words.json'), 'utf8'));
    try { const x = JSON.parse(fs.readFileSync(xf, 'utf8')); for (const k in x) if (!words[k]) words[k] = x[k]; } catch (e) {}
    IW.EG = ctx.window.EG; IW.words = words; IW.xm = xm; IW.ok = !!(IW.EG && IW.EG.lemmaCandidates);
  } catch (e) { IW.ok = false; IW.failAt = Date.now(); console.error('雅思词统计暂不可用：' + e.message); }
  return IW.ok;
}
function iwKey(w) {
  if (IW.lem.has(w)) return IW.lem.get(w);
  let k = IW.words[w] ? w : '';
  if (!k) try { for (const c of IW.EG.lemmaCandidates(w)) if (IW.words[c.w]) { k = c.w; break; } } catch (e) {}
  if (IW.lem.size > 200000) IW.lem.clear();
  IW.lem.set(w, k); return k;
}
function iwOf(it) {
  try {
    if (!iwInit()) return 0;
    const f = it.file && it.file.startsWith('api:files/') ? path.join(SHOP_FILES, it.file.slice(10)) : it.file && it.file.startsWith('stories/') ? path.join(SITE_DIR, it.file) : path.join(SHOP_PRIV, it.id + '.srbook');
    const st = fs.statSync(f), ck = f + ':' + st.mtimeMs, hit = IW.cache.get(it.id);
    if (hit && hit.ck === ck) return hit.n;
    const ent = unzipBuf(fs.readFileSync(f)).find(e => e.name === 'book.txt'), seen = new Set();
    if (ent) for (const t of ent.data.toString('utf8').toLowerCase().replace(/[’‘]/g, "'").split(/[^a-z'\-]+/)) {
      if (!t) continue; const k = iwKey(t), c = k && IW.words[k].c; if (c && c !== 'A1' && c !== 'A2') seen.add(k);
    }
    IW.cache.set(it.id, { ck, n: seen.size }); return seen.size;
  } catch (e) { return 0; }
}
function catalogOut() { const j = shopRead(); return { ...j, items: (j.items || []).map(it => { const n = iwOf(it); return n ? { ...it, iw: n } : it; }) }; }
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
/* ---------- 公共单词库：所有英文书共用，同一个词（同一个声音）只录一次。words/<声音>/<单词哈希>.mp3，哈希和句子一样是 SHA-256('vp1\n' + 单词) ---------- */
const WORDS_DIR = path.join(SHOP_DIR, 'words'), WVK = /^[a-z0-9_]{1,24}$/, HASH_RE = /^[0-9a-f]{16,64}$/;
const wordsDir = v => path.join(WORDS_DIR, v);
function linkInto(src, dst) { try { fs.linkSync(src, dst); } catch (e) { if (e.code !== 'EEXIST') fs.copyFileSync(src, dst); } }   // 同一个文件挂到书的目录里，不多占硬盘
/* ---------- 中文听书·公版书库：开发者上传电子书（句子清单）和本机录好的自然人声，所有人免口令直接听 ---------- */
const ZL_DIR = path.join(SHOP_DIR, 'zl'), ZL_CAT = path.join(ZL_DIR, 'catalog.json'), ZL_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
function zlRead() { try { const j = JSON.parse(fs.readFileSync(ZL_CAT, 'utf8')); return Array.isArray(j.items) ? j : { items: [] }; } catch (e) { return { items: [] }; } }
function zlWrite(j) { fs.mkdirSync(ZL_DIR, { recursive: true }); const t = ZL_CAT + '.tmp'; fs.writeFileSync(t, JSON.stringify(j)); fs.renameSync(t, ZL_CAT); }
const ZL_VK = /^[a-z0-9_]{1,24}$/, vkey = v => String(v || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
function zlVoices(id, it) {                         // 一本书可以有好几种声音：根目录是“默认声音”（k 为空），其余在 v-<k>/ 里
  const base = path.join(ZL_DIR, id), cnt = d => { try { return fs.readdirSync(d).filter(f => /^[0-9a-f]{16,64}\.mp3$/.test(f)).length; } catch (e) { return 0; } };
  const out = [{ k: '', name: (it && it.voice) || '默认', clips: cnt(base) }];
  try { for (const d of fs.readdirSync(base)) { const m = /^v-([a-z0-9_]{1,24})$/.exec(d); if (!m) continue; let nm = m[1]; try { nm = fs.readFileSync(path.join(base, d, 'name.txt'), 'utf8').trim() || nm; } catch (e) {} out.push({ k: m[1], name: nm, clips: cnt(path.join(base, d)) }); } } catch (e) {}
  return out;
}
function zlDirFor(id, k) {                          // 这次上传/查询的声音放在哪个目录：和默认声音同名就放根目录
  const it = zlRead().items.find(x => x.id === id), root = vkey(it && it.voice), kk = vkey(k);
  return !kk || !it || kk === root ? path.join(ZL_DIR, id) : path.join(ZL_DIR, id, 'v-' + kk);
}
/* ---- 点播录音：手机上点“开始录这个声音”→ 登记到待录清单 → 电脑上的录音机去取、录好上传 ---- */
const zlLive = { at: 0, v: '' };
const ZL_Q = path.join(ZL_DIR, 'queue.json'), ZL_WORKER = { ts: 0, job: '', msg: '' };
function zqRead() { try { const j = JSON.parse(fs.readFileSync(ZL_Q, 'utf8')); return Array.isArray(j.jobs) ? j : { jobs: [] }; } catch (e) { return { jobs: [] }; } }
function zqWrite(j) { fs.mkdirSync(ZL_DIR, { recursive: true }); const t = ZL_Q + '.tmp'; fs.writeFileSync(t, JSON.stringify(j)); fs.renameSync(t, ZL_Q); }
const zlClipCount = id => { try { return fs.readdirSync(path.join(ZL_DIR, id)).filter(f => /^[0-9a-f]{16,64}\.mp3$/.test(f)).length; } catch (e) { return 0; } };
function extractClips(id, entries, priv) {          // 语音拆成 files/<故事>/<句子哈希>.mp3
  const dir = path.join(priv ? SHOP_PRIV : SHOP_FILES, id); fs.mkdirSync(dir, { recursive: true });
  let n = 0; for (const e of entries) { const m = CLIP_RE.exec(e.name); if (m) { fs.writeFileSync(path.join(dir, m[1] + '.mp3'), e.data); n++; } }
  return n;
}
function rebuildVoiceZip(id, priv) {                // 增量补了几句语音以后，把“下载全部语音”的总包重新按目录里所有语音打一遍，免得总包只剩新补的几句
  const dir = path.join(priv ? SHOP_PRIV : SHOP_FILES, id); if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter(f => /^[0-9a-f]{16,64}\.mp3$/.test(f));
  const total = files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0); if (total > VOICE_ZIP_MAX) return { tooBig: true, total };
  const base = priv ? SHOP_PRIV : SHOP_FILES, groups = []; let cur = [], sz = 0;
  for (const f of files) { const n = fs.statSync(path.join(dir, f)).size; if (cur.length && sz + n > VOICE_PART_MAX) { groups.push(cur); cur = []; sz = 0; } cur.push(f); sz += n; }
  if (cur.length) groups.push(cur);
  groups.forEach((g, k) => {                         // 每一份：id.voice.zip、id.voice2.zip、id.voice3.zip …，每份里都写明一共几份
    const target = path.join(base, id + (k ? '.voice' + (k + 1) : '.voice') + '.zip'), tmp = target + '.tmp';
    fs.writeFileSync(tmp, zipStore([{ name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'sr-voicepack', v: 1, id: 'story-' + id, count: g.length, total: files.length, parts: groups.length, part: k + 1 })) }, ...g.map(f => ({ name: 'clips/' + f, data: fs.readFileSync(path.join(dir, f)) }))]));
    fs.renameSync(tmp, target);
  });
  for (let k = groups.length + 1; k < 200; k++) { const old = path.join(base, id + '.voice' + k + '.zip'); if (fs.existsSync(old)) fs.unlinkSync(old); else break; }   // 语音变少了：删掉多余的旧份
  return files.length;
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
/* ---------- 中文听书的自然人声：Azure 神经网络语音合成。只有开发者令牌能调；同一句只合成一次，存在磁盘上；每天有字数上限 ---------- */
const TTS_HOST = process.env.AZURE_TTS_HOST || '', TTS_DAILY_CHARS = +process.env.TTS_DAILY_CHARS || 200000;
const TTS_DIR = path.join(SHOP_DIR, 'tts'), TTS_USE = path.join(SHOP_DIR, 'tts-usage.json');
const TTS_VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural'];
let ttsUse = { d: '', n: 0 }; try { ttsUse = JSON.parse(fs.readFileSync(TTS_USE, 'utf8')); } catch (e) {}
function ttsAzure(text, voice) {
  const ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="' + voice + '">' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</voice></speak>';
  const tu = /^http:\/\//.test(TTS_HOST) ? new URL(TTS_HOST) : null, host = tu ? tu.hostname : (TTS_HOST || AZ_REGION + '.tts.speech.microsoft.com');
  const body = Buffer.from(ssml, 'utf8');
  return new Promise(ok => {
    const q = (tu ? http : https).request({ host, port: tu ? tu.port : 443, path: '/cognitiveservices/v1', method: 'POST', timeout: 15000,
      headers: { 'Ocp-Apim-Subscription-Key': AZ_KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'sentence-reader', 'Content-Length': body.length } }, r => {
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => ok({ s: r.statusCode, b: Buffer.concat(ch) }));
    });
    q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', e => ok({ s: 0, b: Buffer.from(String(e && e.message)) })); q.end(body);
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
/* 可以接多家模型：先用智谱的免费 GLM-Flash，出错/太忙再用豆包顶上。哪家没配 Key 就跳过 */
const GLM_KEY = process.env.GLM_API_KEY || '', GLM_MODEL = process.env.GLM_MODEL || 'glm-4.7-flash', GLM_HOST = process.env.GLM_HOST || 'https://open.bigmodel.cn';
const AI_PROVIDERS = [
  GLM_KEY && { name: 'glm', key: GLM_KEY, model: GLM_MODEL, host: GLM_HOST, path: '/api/paas/v4/chat/completions', timeout: +process.env.GLM_TIMEOUT_MS || 20000 },
  ARK_KEY && { name: 'ark', key: ARK_KEY, model: ARK_MODEL, host: ARK_HOST, path: '/api/v3/chat/completions' },
].filter(Boolean);
const AI_ON = AI_PROVIDERS.length > 0;
const aiStat = {};                                    // 每家调用了几次、失败几次，开发者排查用
function aiRaw(p, payload) {
  const pl = Object.assign({}, payload, { model: p.model });
  if (p.name === 'glm' && !/^glm-4/i.test(p.model)) {   // GLM-5 系列始终思考：不能发 thinking 字段，只能用 reasoning_effort（low/high/max）；思考也占 max_tokens，要给够
    delete pl.thinking; pl.reasoning_effort = process.env.GLM_EFFORT || 'low'; pl.max_tokens = Math.max(pl.max_tokens || 0, 2048);
  }
  const body = JSON.stringify(pl);
  const u = new URL(p.host), isHttp = u.protocol === 'http:';
  return new Promise(ok => {
    const q = (isHttp ? http : https).request({ hostname: u.hostname, port: u.port || (isHttp ? 80 : 443), path: p.path, method: 'POST', timeout: p.timeout || 25000,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key, 'Content-Length': Buffer.byteLength(body) } }, r => {
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => ok({ s: r.statusCode, b: Buffer.concat(ch).toString('utf8') }));
    });
    q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', e => ok({ s: 0, b: String(e && e.message) })); q.end(body);
  });
}
async function arkRequest(payload) {
  let last = { s: 503, b: 'no-provider' };
  for (const p of AI_PROVIDERS) {
    const st = aiStat[p.name] || (aiStat[p.name] = { ok: 0, fail: 0, last: '' });
    const r = await aiRaw(p, payload);
    let good = r.s === 200; if (good) { try { good = !!JSON.parse(r.b).choices[0].message.content; } catch (e) { good = false; } }
    if (good) { st.ok++; return r; }
    st.fail++; st.last = new Date().toISOString() + ' ' + r.s + ' ' + String(r.b).slice(0, 160);
    console.error('AI ' + p.name + ' failed:', r.s, String(r.b).slice(0, 200));
    last = r;
  }
  return last;
}
function arkChat(sentence) {
  return arkRequest({ model: ARK_MODEL, messages: [{ role: 'system', content: EXPLAIN_SYS }, { role: 'user', content: sentence }], temperature: 0.3, max_tokens: 700, thinking: { type: 'disabled' } });
}
function parseExplain(text) {                       // 模型偶尔会在 JSON 外面套 ```json，宽松地取出来，并把字段整理干净
  const raw = String(text || '').trim(), m = /\{[\s\S]*\}/.exec(raw);
  let j = null; if (m) { try { j = JSON.parse(m[0]); } catch (e) {} }
  if (!j) return null;
  const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
  const zh = str(j.zh, 300); if (!zh) return null;
  const words = (Array.isArray(j.words) ? j.words : []).slice(0, 4).map(x => ({ w: str(x && x.w, 60), m: str(x && x.m, 120) })).filter(x => x.w && x.m);
  return { zh, words, grammar: str(j.grammar, 200), tip: str(j.tip, 150) };
}
/* ---------- AI 对话：围绕当前这一句，和 AI 老师用简单英语聊几句。对话不能缓存，所以单独限次数 ---------- */
const CHAT_DAILY_MAX = +process.env.CHAT_DAILY_MAX || 200, CHAT_PER_IP_HOUR = +process.env.CHAT_PER_IP_HOUR || 40;
const chatLog = new Map(); let chatDay = { d: '', n: 0 };
function chatLimited(ip) {
  const now = Date.now(), arr = (chatLog.get(ip) || []).filter(t => now - t < 3600000); arr.push(now); chatLog.set(ip, arr);
  if (chatLog.size > 5000) for (const [k, v] of chatLog) if (now - v[v.length - 1] > 3600000) chatLog.delete(k);
  return arr.length > CHAT_PER_IP_HOUR;
}
function chatDailyFull() { const d = new Date().toISOString().slice(0, 10); if (chatDay.d !== d) chatDay = { d, n: 0 }; return chatDay.n >= CHAT_DAILY_MAX; }
const CHAT_SYS = '你是一位温柔、有耐心的英语口语老师，正在和一个中国的小学生（或英语基础很弱的家长）练习英语对话。对话围绕学生正在读的这一句英文展开。规则：' +
  '1）你说的英语要非常简单（相当于小学三四年级水平），每次最多 2 句，最后用一个简短的问题引导学生继续说；' +
  '2）如果学生的英语有错误或不自然，在 fix 里给出更好的说法，并在 fixZh 里用一句中文讲清楚为什么；没有错就让 fix 和 fixZh 为空字符串；' +
  '3）如果学生用中文提问或回答，你可以先用一句中文简短回答，再引导他尝试用英语说；' +
  '4）多鼓励，但不要夸张；不聊和学习无关、不适合儿童的话题，遇到就温和地把话题拉回这一句。' +
  '所有字段的文字里都不要出现英文双引号，需要引用句子时用单引号。只输出一个 JSON 对象，不要任何别的文字：{"en":"你说的英语","zh":"上面英语的中文意思","fix":"","fixZh":""}。';
function arkChatTurn(sentence, hist, msg) {
  const messages = [{ role: 'system', content: CHAT_SYS + '\n学生正在读的这一句：' + sentence }];
  for (const h of hist) messages.push({ role: h.r === 'me' ? 'user' : 'assistant', content: h.r === 'me' ? h.t : JSON.stringify({ en: h.t, zh: '', fix: '', fixZh: '' }) });   // 老师以前的话也包成 JSON，免得模型学着只回纯文字
  messages.push({ role: 'user', content: (msg || '（学生刚打开对话，请你先用一个简单的英语问题开场）') + '\n（只输出 JSON 对象，格式同前。）' });
  return arkRequest({ model: ARK_MODEL, messages, temperature: 0.6, max_tokens: 500, thinking: { type: 'disabled' } });
}
function parseChat(text) {
  const raw = String(text || '').trim(), m = /\{[\s\S]*\}/.exec(raw);
  let j = null; if (m) { try { j = JSON.parse(m[0]); } catch (e) {} }
  if (!j && m) {                                       // 模型常在 fix 里把“更好的说法”用英文双引号括起来，导致 JSON 损坏：按字段顺序硬抠出来
    const g = (k, nx) => { const x = new RegExp('"' + k + '"\\s*:\\s*"([\\s\\S]*?)"\\s*' + (nx ? ',\\s*"' + nx + '"' : '\\}')).exec(m[0]); return x ? x[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim() : ''; };
    const en0 = g('en', 'zh') || ((/"en"\s*:\s*"([^"]+)"/.exec(m[0]) || [])[1] || '');
    if (en0) j = { en: en0, zh: g('zh', 'fix'), fix: g('fix', 'fixZh'), fixZh: g('fixZh', null) };
  }
  if (!j) { const plain = raw.replace(/```[a-z]*|```/g, '').trim().slice(0, 400); return /[A-Za-z]/.test(plain) && !/^[{\[]/.test(plain) ? { en: plain, zh: '', fix: '', fixZh: '' } : null; }   // 模型偶尔不按 JSON 回：把纯文字当作老师的话
  const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
  const en = str(j.en, 400); if (!en) return null;
  return { en, zh: str(j.zh, 300), fix: str(j.fix, 300), fixZh: str(j.fixZh, 300) };
}
/* ---------- 访问统计：每台设备一个匿名随机编号，按北京时间的“天”记录。不收集姓名、账号、完整 IP ---------- */
const VISITS_FILE = path.join(SHOP_DIR, 'visits.json'), VISIT_KEEP_DAYS = 180;
let visits = {}, visitsDirty = false;
try { visits = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8')) || {}; } catch (e) {}
function flushVisits() { if (!visitsDirty) return; visitsDirty = false; try { fs.mkdirSync(SHOP_DIR, { recursive: true }); const t = VISITS_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(visits)); fs.renameSync(t, VISITS_FILE); } catch (e) {} }
setInterval(flushVisits, 30000).unref(); process.on('SIGTERM', () => { flushVisits(); process.exit(0); });
const bjDay = ts => new Date(ts + 8 * 3600000).toISOString().slice(0, 10);
function uaInfo(ua) {
  ua = String(ua || '');
  const dv = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '其他';
  const br = /MicroMessenger/.test(ua) ? '微信' : /Edg\//.test(ua) ? 'Edge' : /(CriOS|Chrome)\//.test(ua) ? 'Chrome' : /(Safari)\//.test(ua) ? 'Safari' : '其他';
  return { dv, br };
}
function ipMask(ip) {                                  // 只留网段，不留完整 IP：1.2.3.4 → 1.2.3.*
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 3).join('.') + '.*';
  return ip.split(':').slice(0, 3).join(':') + ':*';
}
/* ---------- 阅读情况：只统计“学习资料”里的书（自己导入的书不上报）。每台设备每本书记：最远读到第几句、总句数、第一次和最近一次时间。
   设备用匿名编号的指纹，不存原编号；开发者在“访问统计 → 阅读情况”里看每本书多少人读、读到哪、在哪里放弃 ---------- */
/* ---------- 补充雅思词条的发音：录音机（ieltsrec.py）录好上传到 shop/ielts-audio/<uk|us|ex|ex2>/<词的 slug>.mp3；
   手机查词时先拿 /ielts-audio/have 知道哪些词有哪几种发音，再从 /ielts-audio/<种类>/<slug>.mp3 取 ---------- */
const IA_DIR = path.join(SHOP_DIR, 'ielts-audio'), IA_KINDS = { uk: 1, us: 2, ex: 4, ex2: 8 }, IA_SLUG = /^[a-z0-9_]{1,60}$/;
let iaHave = null, iaHaveAt = 0;
function iaHaveMap() {
  if (iaHave && Date.now() - iaHaveAt < 60000) return iaHave;
  const m = {};
  for (const k in IA_KINDS) { let fsl = []; try { fsl = fs.readdirSync(path.join(IA_DIR, k)); } catch (e) {} for (const f of fsl) if (f.endsWith('.mp3')) { const s = f.slice(0, -4); m[s] = (m[s] || 0) | IA_KINDS[k]; } }
  iaHave = m; iaHaveAt = Date.now(); return m;
}
/* ---------- AI 词卡：大词典里查不到的词、或者不是雅思词的生词，让 AI 按 Word Atlas 同样的规范生成词条（音标、释义、例句、搭配、提示），
   所有人共用一份（shop/aiword/words.json），第二个人再查同一个词就不再调用 AI。加进背单词时再用智谱免费的 CogView-3-Flash 画一张插图
   （shop/aiword/img/<slug>.webp）；发音由电脑上的录音机（ieltsrec.py）定时拉 /admin/aiword/pending 录好，和补充词条的发音放在一起 ---------- */
const AIW_DIR = path.join(SHOP_DIR, 'aiword'), AIW_FILE = path.join(AIW_DIR, 'words.json'), AIW_IMG = path.join(AIW_DIR, 'img');
const AIW_PER_IP_HOUR = +process.env.AIW_PER_IP_HOUR || 40, AIW_DAILY_MAX = +process.env.AIW_DAILY_MAX || 1500, AIW_IMG_DAILY = +process.env.AIW_IMG_DAILY || 300;
const AIW_IMG_MODEL = process.env.AIW_IMG_MODEL || 'cogview-3-flash';
const AIW_RE = /^[a-z][a-z'\-]{0,39}$/, AIW_LV = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const AIW_TOPICS = ['education', 'work', 'technology', 'science', 'environment', 'health', 'society', 'government', 'economy', 'media', 'arts', 'travel', 'city', 'nature', 'daily', 'emotion', 'thinking', 'sport', 'history'];
let aiw = {}, aiwDirty = false; const aiwBusy = new Map(), aiwLog = new Map(); let aiwDay = { d: '', n: 0, img: 0 };
try { aiw = JSON.parse(fs.readFileSync(AIW_FILE, 'utf8')) || {}; } catch (e) {}
function aiwFlush() { if (!aiwDirty) return; aiwDirty = false; try { fs.mkdirSync(AIW_DIR, { recursive: true }); const t = AIW_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(aiw)); fs.renameSync(t, AIW_FILE); } catch (e) { console.error('aiword save:', e.message); } }
setInterval(aiwFlush, 20000).unref(); process.on('exit', aiwFlush);
function aiwToday() { const d = bjDay(Date.now()); if (aiwDay.d !== d) aiwDay = { d, n: 0, img: 0 }; return aiwDay; }
function aiwLimited(ip) { const now = Date.now(), arr = (aiwLog.get(ip) || []).filter(t => now - t < 3600000); arr.push(now); aiwLog.set(ip, arr); if (aiwLog.size > 5000) for (const [k, v] of aiwLog) if (now - v[v.length - 1] > 3600000) aiwLog.delete(k); return arr.length > AIW_PER_IP_HOUR; }
const aiwSlug = k => String(k).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
function aiwImgFile(s) { for (const x of ['webp', 'png', 'jpg']) { const f = path.join(AIW_IMG, s + '.' + x); if (fs.existsSync(f)) return f; } return ''; }
function aiwOut(k) {                                   // 给手机的词条：和雅思词库同样的字段，x:2 表示“AI 词卡”；f = 不是普通单词（人名、地名等）的说明
  const r = aiw[k]; if (!r) return null;
  if (r.f) return { f: r.f };
  const o = { u: r.u, c: r.c, p: r.p, s: r.s, e: r.e, k: r.k, x: 2, i: aiwSlug(k) };
  if (r.t) o.t = r.t; if (r.us) o.us = r.us; if (r.w) o.w = r.w; if (r.g) o.g = 1;
  return o;
}
const AIW_SYS = `You are the lead lexicographer of an open-source English vocabulary atlas for Chinese learners (school students and adults, IELTS band 5-7).
A learner met this word while reading an English book and the dictionary could not help. Write ORIGINAL content in your own words.
Accuracy beats creativity: IPA, part of speech, Chinese meanings and grammar must be correct. Prefer standard British IPA for "uk" and General American for "us", with slashes.
If the word is an inflected form (past tense, plural, -ing, comparative...), still describe the form given, and mention the base form in the first sense, e.g. "（hop 的过去式）跳".
If the word is archaic, dialect, a misspelling of a real word, or a sound/onomatopoeia, still explain it, and say so briefly in "tip".
If it is NOT an English word at all, or only a person's name, a place name or a brand, set "flag" to a short Chinese note such as "人名（彼得）" or "地名：英国的一个郡" or "不是英文单词", and leave the other fields empty.
Return strict JSON only, no other text:
{"w": headword exactly as given,
 "uk": "/IPA/", "us": "/IPA/",
 "senses": [{"pos": "n.|v.|adj.|adv.|prep.|conj.|pron.|phr.|num.|int.|det.|aux.", "zh": "简洁中文释义，可用；分隔，≤14字"}],
 "ex": [{"en": "Everyday sentence, 7-13 words, natural, uses the word or an inflected form", "zh": "自然的中文翻译"},
        {"en": "Second sentence, 10-20 words, a little more formal", "zh": "自然的中文翻译"}],
 "col": ["0-3 useful collocations, each as 'english phrase｜中文'"],
 "tip": "≤36字中文：最有用的一条用法/辨析/记忆提示。不得编造词源。",
 "cefr": "A1|A2|B1|B2|C1|C2",
 "topic": one of ${JSON.stringify(AIW_TOPICS)},
 "scene": "English, ≤25 words: one concrete, cheerful, child-safe picture that shows the most common meaning; no text, letters or numbers in the picture",
 "flag": ""}
senses: 1-3 senses, most common first; if a context sentence is given, make sure the sense used there is included.
Sentences must be safe for all ages, culturally neutral, and must not mention real brands or living public figures.`;
function aiwClean(j, k) {
  const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n);
  if (!j || typeof j !== 'object') return null;
  if (j.flag) return { f: str(j.flag, 40), at: Date.now() };
  const s = (Array.isArray(j.senses) ? j.senses : []).filter(x => x && x.zh).slice(0, 3).map(x => [str(x.pos, 8), str(x.zh, 40)]);
  const e = (Array.isArray(j.ex) ? j.ex : []).filter(x => x && x.en && x.zh).slice(0, 2).map(x => [str(x.en, 220), str(x.zh, 160)]);
  if (!s.length || !e.length) return null;
  const o = { u: str(j.uk, 60), c: AIW_LV.includes(j.cefr) ? j.cefr : 'B2', p: AIW_TOPICS.includes(j.topic) ? j.topic : 'daily', s, e,
    k: (Array.isArray(j.col) ? j.col : []).filter(x => typeof x === 'string' && x.includes('｜')).slice(0, 3).map(x => str(x, 60)), at: Date.now(), v: 0 };
  if (j.tip) o.t = str(j.tip, 60); if (j.us) o.us = str(j.us, 60); if (j.scene) o.sc = str(j.scene, 240);
  const w = str(j.w, 40); if (w && w !== k && w.toLowerCase() === k) o.w = w;   // 只接受大小写不同（比如专有形容词）
  return o;
}
async function aiwGen(k, ctx) {                        // 同一个词同时有人在生成，就等同一个结果
  if (aiw[k]) return aiw[k];
  if (aiwBusy.has(k)) return aiwBusy.get(k);
  const p = (async () => {
    const user = 'Word: ' + k + (ctx ? '\nContext sentence from the book (only to choose the right sense): ' + ctx : '');
    const r = await arkRequest({ messages: [{ role: 'system', content: AIW_SYS }, { role: 'user', content: user }], temperature: 0.3, max_tokens: 1500, thinking: { type: 'disabled' } });
    if (r.s !== 200) throw new Error('ai-' + r.s);
    let txt = ''; try { txt = JSON.parse(r.b).choices[0].message.content; } catch (e) {}
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}'); let j = null; if (a >= 0 && b > a) try { j = JSON.parse(txt.slice(a, b + 1)); } catch (e) {}
    const o = aiwClean(j, k); if (!o) throw new Error('ai-bad');
    aiw[k] = o; aiwDirty = true; aiwToday().n++; return o;
  })();
  aiwBusy.set(k, p); try { return await p; } finally { aiwBusy.delete(k); }
}
function httpGetBuf(u, limit, hops) {
  return new Promise((ok, no) => {
    const q = https.get(u, { timeout: 30000 }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (hops || 0) < 3) { r.resume(); return httpGetBuf(new URL(r.headers.location, u).href, limit, (hops || 0) + 1).then(ok, no); }
      if (r.statusCode !== 200) { r.resume(); return no(new Error('HTTP ' + r.statusCode)); }
      const ch = []; let n = 0; r.on('data', c => { n += c.length; if (n > limit) q.destroy(new Error('too-big')); else ch.push(c); }); r.on('end', () => ok(Buffer.concat(ch)));
    });
    q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', no);
  });
}
const aiwImgQ = []; let aiwImgRun = false; const aiwImgStat = { ok: 0, fail: 0, last: '' };
function aiwImgQueue(k) { const r = aiw[k]; if (!r || r.f || r.g || r.gf >= 3 || aiwImgQ.includes(k)) return; aiwImgQ.push(k); aiwImgPump(); }
async function aiwImgPump() {                          // 一次只画一张：免费模型并发很低
  if (aiwImgRun || !GLM_KEY) return; aiwImgRun = true;
  try {
    while (aiwImgQ.length) {
      const k = aiwImgQ.shift(), r = aiw[k]; if (!r || r.g) continue;
      if (aiwToday().img >= AIW_IMG_DAILY) { aiwImgQ.unshift(k); break; }   // 今天画够了，明天接着画（见下面的定时器）
      aiwToday().img++;
      try {
        const prompt = 'Simple flat vector illustration for a children\'s vocabulary card, soft pastel colors, clean shapes, plain light background, no text, no letters, no numbers. ' + (r.sc || ('The meaning of the English word "' + k + '": ' + r.s.map(x => x[1]).join('；')));
        const body = JSON.stringify({ model: AIW_IMG_MODEL, prompt, size: '1024x1024' });
        const res = await new Promise(ok => {
          const u = new URL(GLM_HOST), q = https.request({ hostname: u.hostname, port: u.port || 443, path: '/api/paas/v4/images/generations', method: 'POST', timeout: 90000,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GLM_KEY, 'Content-Length': Buffer.byteLength(body) } }, rr => { const ch = []; rr.on('data', c => ch.push(c)); rr.on('end', () => ok({ s: rr.statusCode, b: Buffer.concat(ch).toString('utf8') })); });
          q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', e => ok({ s: 0, b: String(e.message) })); q.end(body);
        });
        let url = ''; try { url = JSON.parse(res.b).data[0].url; } catch (e) {}
        if (res.s !== 200 || !url) throw new Error(res.s + ' ' + String(res.b).slice(0, 160));
        const buf = await httpGetBuf(url, 15 * 1048576), s = aiwSlug(k);           // 图片链接是临时的，马上下载存好
        fs.mkdirSync(AIW_IMG, { recursive: true });
        const ext = buf[0] === 0x89 ? 'png' : 'jpg', raw = path.join(AIW_IMG, s + '.' + ext), webp = path.join(AIW_IMG, s + '.webp'); fs.writeFileSync(raw, buf);
        const conv = (cmd, args) => new Promise(ok => require('child_process').execFile(cmd, args, { timeout: 60000 }, e => ok(!e)));
        let done = await conv('cwebp', ['-quiet', '-q', '78', '-resize', '512', '0', raw, '-o', webp]) || await conv('convert', [raw, '-resize', '512x512', '-quality', '78', webp]);   // 压成 512px 的 webp（约 30KB），手机上加载快
        if (done) fs.unlinkSync(raw);                                              // 服务器上没有 cwebp / ImageMagick 就直接用原图
        r.g = 1; aiwDirty = true; aiwImgStat.ok++;
      } catch (e) { r.gf = (r.gf || 0) + 1; aiwDirty = true; aiwImgStat.fail++; aiwImgStat.last = new Date().toISOString() + ' ' + k + ' ' + String(e.message).slice(0, 160); console.error('aiword img:', aiwImgStat.last); await new Promise(z => setTimeout(z, 5000)); }
      await new Promise(z => setTimeout(z, 1500));
    }
  } finally { aiwImgRun = false; }
}
setInterval(() => { for (const k in aiw) if (aiw[k].v > 0 && !aiw[k].g && !(aiw[k].gf >= 3)) aiwImgQueue(k); }, 3 * 3600000).unref();   // 漏画的（当天额度用完、失败）每 3 小时补一次
setTimeout(() => { for (const k in aiw) if (aiw[k].v > 0 && !aiw[k].g && !(aiw[k].gf >= 3)) aiwImgQueue(k); }, 90000).unref();
const READS_FILE = path.join(SHOP_DIR, 'reads.json');
let reads = {}, readsDirty = false;
try { reads = JSON.parse(fs.readFileSync(READS_FILE, 'utf8')) || {}; } catch (e) {}
setInterval(() => { if (!readsDirty) return; readsDirty = false; try { fs.mkdirSync(SHOP_DIR, { recursive: true }); const t = READS_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(reads)); fs.renameSync(t, READS_FILE); } catch (e) {} }, 30000).unref();
const readLog = new Map();
function readLimited(ip) { const now = Date.now(), arr = (readLog.get(ip) || []).filter(t => now - t < 3600000); arr.push(now); readLog.set(ip, arr); if (readLog.size > 5000) for (const [k, v] of readLog) if (now - v[v.length - 1] > 3600000) readLog.delete(k); return arr.length > 300; }
function recordRead(d, b, m, n) {
  const k = crypto.createHash('sha256').update('rd1:' + d).digest('hex').slice(0, 12), now = Date.now();
  const bk = reads[b] || (reads[b] = {}); if (!bk[k] && Object.keys(bk).length >= 50000) return;
  const r = bk[k] || (bk[k] = { f: now, m: 0, n: 0 }); r.m = Math.max(r.m, m); r.n = n; r.l = now; readsDirty = true;
}
function readsSummary() {
  const titles = {}; for (const it of shopRead().items) titles[it.id] = it.title;
  const now = Date.now();
  return Object.entries(reads).map(([id, ds]) => {
    const rs = Object.values(ds).filter(r => r.n > 0), pct = rs.map(r => Math.min(1, (r.m + 1) / r.n));
    const buckets = new Array(10).fill(0); for (const p of pct) buckets[Math.min(9, Math.floor(p * 10))]++;
    return { id, title: titles[id] || id, readers: rs.length, done: pct.filter(p => p >= 0.98).length, avg: pct.length ? Math.round(pct.reduce((a, b) => a + b, 0) / pct.length * 100) : 0,
      active7: rs.filter(r => now - r.l < 7 * 864e5).length, new7: rs.filter(r => now - r.f < 7 * 864e5).length, buckets, total: (rs[0] || {}).n || 0 };
  }).sort((a, b) => b.readers - a.readers);
}
const hitLog = new Map();
// ---- 单词报错：读者觉得雅思词条（释义、例句、插图、发音）有错，点一下报上来；开发者在软件里集中查看、改完标“已处理”。不记 IP ----
/* ---------- 多设备同步：一个同步码对应一份学习进度（书架进度、背单词、学习统计、几项设置）。不需要账号。
   服务器只按同步码的指纹（sha256）存文件，不存同步码本身；合并在手机上做，服务器只负责“版本号对上才能写”。
   每个 IP 每小时最多新建 10 个码、输错 20 次；单份最大 3MB ---------- */
const SYNC_DIR = path.join(SHOP_DIR, 'sync'), SYNC_MAX = 3 * 1048576, SYNC_ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const syncNorm = c => { c = String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); if (c.length === 12 && c.startsWith('MIAO')) c = c.slice(4); return /^[2-9A-HJKMNP-Z]{8}$/.test(c) ? c : ''; };
const syncShow = c => 'MIAO-' + c.slice(0, 4) + '-' + c.slice(4);
const syncFile = c => path.join(SYNC_DIR, crypto.createHash('sha256').update('sr-sync-1:' + c).digest('hex').slice(0, 40) + '.json');
function syncNewCode() { for (;;) { let s = ''; for (const x of crypto.randomBytes(8)) s += SYNC_ALPHA[x % SYNC_ALPHA.length]; if (!fs.existsSync(syncFile(s))) return s; } }
function syncRead(c) { try { return JSON.parse(fs.readFileSync(syncFile(c), 'utf8')); } catch (e) { return null; } }
function syncWrite(c, j) { fs.mkdirSync(SYNC_DIR, { recursive: true }); const f = syncFile(c), t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(j)); fs.renameSync(t, f); }
const syncHits = new Map();
function syncLimited(ip, kind, max) {
  const k = kind + ':' + ip, now = Date.now(), arr = (syncHits.get(k) || []).filter(t => now - t < 3600000);
  syncHits.set(k, arr); if (syncHits.size > 5000) for (const [kk, v] of syncHits) if (!v.length || now - v[v.length - 1] > 3600000) syncHits.delete(kk);
  return arr.length >= max;
}
const syncMark = (ip, kind) => { const k = kind + ':' + ip; (syncHits.get(k) || syncHits.set(k, []).get(k)).push(Date.now()); };
const REPORT_FILE = path.join(SHOP_DIR, 'reports.jsonl'), REPORT_DONE = path.join(SHOP_DIR, 'reports-done.json'), REPORT_WHY = ['释义不对', '例句有问题', '插图不对', '发音不对', '等级不对', '其他'];
const repLog = new Map();
function repLimited(ip) {
  const now = Date.now(), arr = (repLog.get(ip) || []).filter(t => now - t < 3600000); arr.push(now); repLog.set(ip, arr);
  if (repLog.size > 5000) for (const [k, v] of repLog) if (now - v[v.length - 1] > 3600000) repLog.delete(k);
  return arr.length > 30;
}
function repDone() { try { return JSON.parse(fs.readFileSync(REPORT_DONE, 'utf8')); } catch (e) { return {}; } }
function repList() {
  let lines = []; try { lines = fs.readFileSync(REPORT_FILE, 'utf8').split('\n').filter(Boolean).slice(-5000); } catch (e) {}
  const done = repDone(), by = new Map();
  for (const l of lines) { let r; try { r = JSON.parse(l); } catch (e) { continue; }
    const g = by.get(r.w) || { w: r.w, n: 0, why: {}, notes: [], last: 0 }; g.n++; g.why[r.why] = (g.why[r.why] || 0) + 1;
    if (r.note && g.notes.length < 10) g.notes.push(r.note); g.last = Math.max(g.last, r.t); by.set(r.w, g); }
  return [...by.values()].map(g => ({ ...g, done: !!(done[g.w] && done[g.w] >= g.last) })).sort((a, b) => (a.done - b.done) || (b.n - a.n) || (b.last - a.last));
}
function hitLimited(ip) {
  const now = Date.now(), arr = (hitLog.get(ip) || []).filter(t => now - t < 3600000); arr.push(now); hitLog.set(ip, arr);
  if (hitLog.size > 5000) for (const [k, v] of hitLog) if (now - v[v.length - 1] > 3600000) hitLog.delete(k);
  return arr.length > 120;
}
function recordHit(d, ip, ua, v, pwa) {
  const now = Date.now(), day = bjDay(now), t = visits[day] || (visits[day] = {});
  const { dv, br } = uaInfo(ua), r = t[d];
  if (r) { r.l = now; r.n++; r.v = v; r.ip = ipMask(ip); r.pwa = pwa ? 1 : 0; }
  else if (Object.keys(t).length < 50000) t[d] = { f: now, l: now, n: 1, dv, br, ip: ipMask(ip), v, pwa: pwa ? 1 : 0 };
  const keys = Object.keys(visits).sort(); while (keys.length > VISIT_KEEP_DAYS) delete visits[keys.shift()];
  visitsDirty = true;
}
function visitsSummary(days) {
  const keys = Object.keys(visits).sort(), first = new Map();
  for (const k of keys) for (const d of Object.keys(visits[k])) if (!first.has(d)) first.set(d, k);
  return keys.slice(-days).reverse().map(k => { const ds = Object.keys(visits[k]); return { date: k, devices: ds.length, hits: ds.reduce((a, d) => a + visits[k][d].n, 0), newDevices: ds.filter(d => first.get(d) === k).length }; }).concat([{ total: first.size }]);
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
  if (req.method === 'GET' && url === '/catalog') { res.writeHead(200, { ...pubHead, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(catalogOut())); return true; }
  if (req.method === 'GET' && url === '/zl/catalog') {  // 声音和句数实时算（点播录音后会变），15 秒内复用上一次结果
    if (!zlLive.at || Date.now() - zlLive.at > 15000) { const j = zlRead(); zlLive.v = JSON.stringify({ items: j.items.map(it => { const vs = zlVoices(it.id, it); return { ...it, voices: vs, clips: vs[0].clips }; }) }); zlLive.at = Date.now(); }
    res.writeHead(200, { ...pubHead, 'Content-Type': 'application/json; charset=utf-8' }); res.end(zlLive.v); return true;
  }
  const zi = /^\/zl\/([a-z0-9][a-z0-9-]{0,40})\/info$/.exec(url);
  if (req.method === 'GET' && zi) {                    // 一本书现在有哪些声音、各录了多少句、录音机在不在线（公开，手机端用来显示进度）
    const it = zlRead().items.find(x => x.id === zi[1]); if (!it) { res.writeHead(404, pubHead); res.end(); return true; }
    const q = zqRead().jobs.filter(j => j.id === zi[1]).map(j => ({ voice: j.voice, name: j.name, from: j.from }));
    res.writeHead(200, { ...pubHead, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ id: it.id, n: it.n, voices: zlVoices(zi[1], it), queue: q, worker: { online: Date.now() - ZL_WORKER.ts < 90000, job: ZL_WORKER.job, msg: ZL_WORKER.msg } })); return true;
  }
  const zm = /^\/zl\/([a-z0-9][a-z0-9-]{0,40})\/((?:v-[a-z0-9_]{1,24}\/)?(?:book\.json|[0-9a-f]{16,64}\.mp3))$/.exec(url);
  if (req.method === 'GET' && zm) {
    const f = path.join(ZL_DIR, zm[1], zm[2]);
    if (!fs.existsSync(f)) { res.writeHead(404, pubHead); res.end(); return true; }
    const isBook = zm[2] === 'book.json';   // 注意：book.json 不会出现在 v-xxx/ 里，下面 exists 会判 404
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': isBook ? 'no-cache' : 'public, max-age=31536000, immutable', 'Content-Type': isBook ? 'application/json; charset=utf-8' : 'audio/mpeg', 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); return true;
  }
  const wm = /^\/words\/([a-z0-9_]{1,24})\/([0-9a-f]{16,64})\.mp3$/.exec(url);
  if (req.method === 'GET' && wm) {                 // 公共单词库：点单词时，书里没有的词来这里取
    const f = path.join(wordsDir(wm[1]), wm[2] + '.mp3');
    if (!fs.existsSync(f)) { res.writeHead(404, pubHead); res.end(); return true; }
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); return true;
  }
  const cm = /^\/files\/([a-z0-9][a-z0-9-]{0,59})\/([0-9a-f]{16,64})\.mp3$/.exec(url);
  if (req.method === 'GET' && cm) {
    const f = path.join(SHOP_FILES, cm[1], cm[2] + '.mp3');
    if (!fs.existsSync(f)) { res.writeHead(404, pubHead); res.end(); return true; }
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res); return true;
  }
  const pm = /^\/pfiles\/([0-9a-f]{32})\/(story\.srbook|voice[0-9]{0,3}\.zip|[0-9a-f]{16,64}\.mp3)$/.exec(url);
  if (req.method === 'GET' && pm) {                 // 收费故事：只有兑换过的买家（凭证）才能取文字和语音
    const sid = tokenLookup(pm[1]), seg = pm[2];
    const f = !sid ? '' : seg === 'story.srbook' ? path.join(SHOP_PRIV, sid + '.srbook') : /^voice[0-9]{0,3}\.zip$/.test(seg) ? path.join(SHOP_PRIV, sid + '.' + seg) : path.join(SHOP_PRIV, sid, seg);
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
  if (req.method === 'GET' && url === '/ielts-audio/have') { res.writeHead(200, { ...pubHead, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }); res.end(JSON.stringify(iaHaveMap())); return true; }
  const mIa = /^\/ielts-audio\/(uk|us|ex|ex2)\/([a-z0-9_]{1,60})\.mp3$/.exec(url);
  if (req.method === 'GET' && mIa) {
    const f = path.join(IA_DIR, mIa[1], mIa[2] + '.mp3'); if (!fs.existsSync(f)) { res.writeHead(404, pubHead); res.end(); return true; }
    res.writeHead(200, { ...pubHead, 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(f).size, 'Cache-Control': 'public, max-age=2592000' }); fs.createReadStream(f).pipe(res); return true;
  }
  if (req.method === 'POST' && (url === '/aiword' || url === '/aiword/get')) {   // AI 词卡：查一个词（没有就生成）/ 一次取多个已有的（换手机、多设备同步后补齐词条）
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    let b0; try { b0 = JSON.parse(await readBody(req, 20000)) || {}; } catch (e) { return out0(400, { error: 'bad-request' }); }
    if (url === '/aiword/get') {
      const o = {}; for (const w of (Array.isArray(b0.ws) ? b0.ws : []).slice(0, 500)) { const k = String(w || '').toLowerCase(); if (AIW_RE.test(k) && aiw[k]) o[k] = aiwOut(k); }
      return out0(200, { ok: true, words: o });
    }
    const k = String(b0.w || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[‐‑‒–—―]/g, '-').trim(); if (!AIW_RE.test(k)) return out0(400, { error: 'bad-word' });
    if (!aiw[k]) {
      if (!AI_ON) return out0(503, { error: 'ai-off' });
      if (aiwLimited(ip)) return out0(429, { error: 'too-many' });
      if (aiwToday().n >= AIW_DAILY_MAX) return out0(429, { error: 'daily-full' });
      try { await aiwGen(k, String(b0.ctx || '').slice(0, 400)); } catch (e) { return out0(502, { error: String(e.message || 'ai-failed') }); }
    }
    const r = aiw[k];
    if (b0.add && !r.f) { r.v = (r.v || 0) + 1; aiwDirty = true; aiwImgQueue(k); }
    return out0(200, { ok: true, e: aiwOut(k) });
  }
  const mAiw = /^\/aiword\/img\/([a-z0-9_]{1,60})$/.exec(url);
  if (req.method === 'GET' && mAiw) {
    const f = aiwImgFile(mAiw[1]); if (!f) { res.writeHead(404, pubHead); res.end(); return true; }
    const ct = f.endsWith('.webp') ? 'image/webp' : f.endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.writeHead(200, { ...pubHead, 'Content-Type': ct, 'Content-Length': fs.statSync(f).size, 'Cache-Control': 'public, max-age=2592000' }); fs.createReadStream(f).pipe(res); return true;
  }
  if (req.method === 'POST' && url === '/read') {    // 阅读情况：学习资料里的书读到第几句
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    let b0; try { b0 = JSON.parse(await readBody(req, 500)) || {}; } catch (e) { return out0(400, { error: 'bad-request' }); }
    const d0 = String(b0.d || ''), id0 = String(b0.b || ''), m0 = Math.floor(+b0.m), n0 = Math.floor(+b0.n);
    if (!/^[a-z0-9]{12,40}$/.test(d0) || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(id0) || !(n0 > 0 && n0 < 1e6) || !(m0 >= 0 && m0 < n0)) return out0(400, { error: 'bad' });
    if (!shopRead().items.some(x => x.id === id0)) return out0(404, { error: 'not-in-catalog' });   // 只记书单里有的书
    if (readLimited(ip)) return out0(429, { error: 'too-many' });
    recordRead(d0, id0, m0, n0); return out0(200, { ok: true });
  }
  if (req.method === 'POST' && url === '/hit') {     // 访问统计：App 打开时报一下“匿名设备编号”
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    let b0; try { b0 = JSON.parse(await readBody(req, 500)) || {}; } catch (e) { return out0(400, { error: 'bad-request' }); }
    const d0 = String(b0.d || ''); if (!/^[a-z0-9]{12,40}$/.test(d0)) return out0(400, { error: 'bad-id' });
    if (hitLimited(ip)) return out0(429, { error: 'too-many' });
    recordHit(d0, ip, req.headers['user-agent'], String(b0.v || '').slice(0, 30), b0.pwa);
    return out0(200, { ok: true });
  }
  if (req.method === 'POST' && /^\/sync\/(new|get|put|rotate)$/.test(url)) {   // 多设备同步
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    let b0; try { b0 = JSON.parse((await readBodyBuf(req, SYNC_MAX)).toString('utf8') || '{}') || {}; } catch (e) { return out0(e.message === 'too-big' ? 413 : 400, { error: e.message === 'too-big' ? 'too-big' : 'bad-request' }); }
    const op = url.slice(6);
    if (op === 'new') {
      if (syncLimited(ip, 'new', 10)) return out0(429, { error: 'too-many' });
      syncMark(ip, 'new'); const c = syncNewCode(); syncWrite(c, { v: 0, at: Date.now(), data: null });
      return out0(200, { ok: true, code: syncShow(c), v: 0 });
    }
    if (syncLimited(ip, 'bad', 20)) return out0(429, { error: 'too-many-wrong' });
    const c = syncNorm(b0.code), cur = c && syncRead(c);
    if (!cur) { syncMark(ip, 'bad'); return out0(404, { error: 'no-such-code' }); }
    if (op === 'get') return out0(200, { ok: true, v: cur.v, at: cur.at, data: cur.data });
    if (op === 'put') {
      if (+b0.v !== cur.v) return out0(409, { error: 'changed', v: cur.v, data: cur.data });     // 别的设备刚写过：手机上重新合并再写
      if (!b0.data || typeof b0.data !== 'object') return out0(400, { error: 'bad-data' });
      const nj = { v: cur.v + 1, at: Date.now(), data: b0.data }; syncWrite(c, nj);
      return out0(200, { ok: true, v: nj.v, at: nj.at });
    }
    if (op === 'rotate') {                             // 换新码：旧码马上作废
      const n = syncNewCode(); syncWrite(n, cur); try { fs.unlinkSync(syncFile(c)); } catch (e) {}
      return out0(200, { ok: true, code: syncShow(n), v: cur.v });
    }
  }
  if (req.method === 'POST' && url === '/report') {  // 单词报错
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    let b0; try { b0 = JSON.parse(await readBody(req, 2000)) || {}; } catch (e) { return out0(400, { error: 'bad-request' }); }
    const w0 = String(b0.w || '').toLowerCase().trim(), why0 = REPORT_WHY.includes(b0.why) ? b0.why : '其他';
    if (!/^[a-z][a-z' .\-]{0,40}$/.test(w0)) return out0(400, { error: 'bad-word' });
    if (repLimited(ip)) return out0(429, { error: 'too-many' });
    fs.mkdirSync(SHOP_DIR, { recursive: true });
    fs.appendFileSync(REPORT_FILE, JSON.stringify({ t: Date.now(), w: w0, why: why0, note: String(b0.note || '').replace(/\s+/g, ' ').slice(0, 200), from: String(b0.from || '').slice(0, 10), v: String(b0.v || '').slice(0, 30) }) + '\n');
    return out0(200, { ok: true });
  }
  if (req.method === 'POST' && url === '/explain') {  // AI 讲解
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    if (!AI_ON) return out0(503, { error: 'not-configured' });
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
  if (req.method === 'POST' && url === '/chat') {     // AI 对话
    const origin0 = req.headers.origin, okO0 = origin0 && ALLOW.includes(origin0) ? origin0 : null;
    const hd0 = { 'Content-Type': 'application/json; charset=utf-8' }; if (okO0) { hd0['Access-Control-Allow-Origin'] = okO0; hd0.Vary = 'Origin'; }
    const out0 = (c, o) => { res.writeHead(c, hd0); res.end(JSON.stringify(o)); return true; };
    if (!okO0) return out0(403, { error: 'origin-not-allowed' });
    if (!AI_ON) return out0(503, { error: 'not-configured' });
    let b0; try { b0 = JSON.parse(await readBody(req, 8000)) || {}; } catch (e) { return out0(400, { error: 'bad-request' }); }
    const s0 = String(b0.s || '').replace(/\s+/g, ' ').trim().slice(0, 600), m0 = String(b0.m || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const h0 = (Array.isArray(b0.h) ? b0.h : []).slice(-8).map(x => ({ r: x && x.r === 'me' ? 'me' : 'ai', t: String((x && x.t) || '').slice(0, 400) })).filter(x => x.t);
    if (!s0 || !/[A-Za-z]/.test(s0)) return out0(400, { error: 'empty' });
    if (chatLimited(ip)) return out0(429, { error: 'too-many' });
    if (chatDailyFull()) return out0(429, { error: 'daily-limit' });
    chatDay.n++;
    let r3 = null;
    for (let a = 0; a < 2 && !r3; a++) {               // 回复解析不出来就自动再问一次（模型偶尔会出格）
      const r2 = await arkChatTurn(s0, h0, m0);
      if (r2.s === 401 || r2.s === 403) return out0(502, { error: 'ark-key' });
      if (r2.s === 429) return out0(503, { error: 'ark-busy' });
      if (r2.s !== 200) return out0(502, { error: 'ark-failed', code: r2.s });
      let content = ''; try { content = JSON.parse(r2.b).choices[0].message.content; } catch (e) {}
      r3 = parseChat(content); if (!r3) console.error('chat bad reply (try ' + (a + 1) + '):', JSON.stringify(String(content).slice(0, 300)));
    }
    if (!r3) return out0(502, { error: 'ark-bad-reply' });
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
    if (url === '/admin/ielts-audio' && req.method === 'PUT') {     // 补充雅思词条的发音：zip 里是 clips/<slug>.mp3；?kind=uk|us|ex|ex2
      const k = new URL(req.url, 'http://x').searchParams.get('kind') || ''; if (!IA_KINDS[k]) return out(400, { error: 'bad-kind' });
      let ents; try { ents = unzipBuf(await readBodyBuf(req, MAX_UPLOAD)); } catch (e) { return out(e.message === 'too-big' ? 413 : 400, { error: e.message === 'too-big' ? 'too-big' : 'bad-zip' }); }
      const d = path.join(IA_DIR, k); fs.mkdirSync(d, { recursive: true }); let n = 0;
      for (const e of ents) { const mm = /^clips\/([a-z0-9_]{1,60})\.mp3$/.exec(e.name); if (mm && e.data.length > 100) { fs.writeFileSync(path.join(d, mm[1] + '.mp3'), e.data); n++; } }
      iaHave = null; return out(200, { ok: true, n });
    }
    if (url === '/admin/aiword' && req.method === 'GET') {          // AI 词卡概况（开发者模式里看）
      const all = Object.values(aiw), have = iaHaveMap();
      const added = Object.keys(aiw).filter(k => aiw[k].v > 0 && !aiw[k].f);
      return out(200, { total: all.length, flagged: all.filter(r => r.f).length, added: added.length, img: added.filter(k => aiw[k].g).length,
        audio: added.filter(k => (have[aiwSlug(k)] || 0) & 1).length, today: aiwToday(), imgQueue: aiwImgQ.length, imgStat: aiwImgStat,
        recent: Object.keys(aiw).sort((a, b) => aiw[b].at - aiw[a].at).slice(0, 40).map(k => ({ k, f: aiw[k].f || '', v: aiw[k].v || 0, g: !!aiw[k].g, s: (aiw[k].s || []).map(x => x[0] + ' ' + x[1]).join('；') })) });
    }
    if (url === '/admin/aiword/pending' && req.method === 'GET') {  // 录音机问：哪些加进背单词的 AI 词卡还没录发音
      const have = iaHaveMap(), list = [];
      for (const k in aiw) { const r = aiw[k]; if (r.f || !(r.v > 0)) continue; const s = aiwSlug(k), a = have[s] || 0; if ((a & 15) === 15) continue; list.push({ k, i: s, w: r.w || k, a, ex: (r.e || []).map(x => x[0]) }); }
      return out(200, { words: list });
    }
    m = /^\/admin\/aiword\/([a-z][a-z'\-]{0,39})$/.exec(decodeURIComponent(url));
    if (m && req.method === 'DELETE') {                            // 词条有错：删掉，下次有人查会重新生成（插图一起删）
      const k = m[1]; if (!aiw[k]) return out(404, { error: 'not-found' });
      delete aiw[k]; aiwDirty = true; const f = aiwImgFile(aiwSlug(k)); if (f) try { fs.unlinkSync(f); } catch (e) {}
      return out(200, { ok: true });
    }
    if (url === '/admin/words/missing' && req.method === 'POST') {   // 录音机问：这些单词（哈希）公共库里哪些还没有？{voice, hashes} → {missing}
      const b = JSON.parse(await readBody(req, 6 * 1048576) || '{}'), v = String(b.voice || ''); if (!WVK.test(v)) return out(400, { error: 'bad-voice' });
      const hs = Array.isArray(b.hashes) ? b.hashes.filter(h => HASH_RE.test(h)).slice(0, 80000) : [];
      let have = new Set(); try { have = new Set(fs.readdirSync(wordsDir(v)).map(f => f.slice(0, -4))); } catch (e) {}
      return out(200, { missing: hs.filter(h => !have.has(h)), total: have.size });
    }
    if (url === '/admin/words' && req.method === 'PUT') {            // 一批单词语音：zip（不压缩），里面是 clips/<单词哈希>.mp3；?voice=af_heart
      const v = new URL(req.url, 'http://x').searchParams.get('voice') || ''; if (!WVK.test(v)) return out(400, { error: 'bad-voice' });
      let ents; try { ents = unzipBuf(await readBodyBuf(req, MAX_UPLOAD)); } catch (e) { return out(e.message === 'too-big' ? 413 : 400, { error: e.message === 'too-big' ? 'too-big' : 'bad-zip' }); }
      const d = wordsDir(v); fs.mkdirSync(d, { recursive: true }); let n = 0;
      for (const e of ents) { const k = CLIP_RE.exec(e.name); if (k && e.data.length > 100) { fs.writeFileSync(path.join(d, k[1] + '.mp3'), e.data); n++; } }
      return out(200, { ok: true, words: n });
    }
    m = /^\/admin\/words\/link\/([a-z0-9][a-z0-9-]{0,59})$/.exec(url);
    if (m && req.method === 'POST') {                  // 把这本书用到的单词从公共库挂进书的语音目录：读者照常按书取语音、下载“全部语音”时也带着单词
      const b = JSON.parse(await readBody(req, 6 * 1048576) || '{}'), v = String(b.voice || ''); if (!WVK.test(v)) return out(400, { error: 'bad-voice' });
      const bk = baseOf(m[1]), priv = !fs.existsSync(path.join(SHOP_FILES, bk + '.srbook')) && fs.existsSync(path.join(SHOP_PRIV, bk + '.srbook'));
      const dir = path.join(priv ? SHOP_PRIV : SHOP_FILES, m[1]); fs.mkdirSync(dir, { recursive: true });
      let linked = 0; const missing = [];
      for (const h of (Array.isArray(b.hashes) ? b.hashes : []).filter(x => HASH_RE.test(x)).slice(0, 80000)) {
        const src = path.join(wordsDir(v), h + '.mp3'), dst = path.join(dir, h + '.mp3');
        if (!fs.existsSync(src)) { missing.push(h); continue; }
        if (!fs.existsSync(dst)) { linkInto(src, dst); linked++; }
      }
      return out(200, { ok: true, linked, missing });
    }
    m = /^\/admin\/clips\/([a-z0-9][a-z0-9-]{0,59})$/.exec(url);
    if (req.method === 'GET' && m) {                   // 这本书服务器上已经有哪些句子的语音（补语音时只做缺的）
      const have = new Set(); for (const base of [SHOP_FILES, SHOP_PRIV]) { try { for (const f of fs.readdirSync(path.join(base, m[1]))) { const h = /^([0-9a-f]{16,64})\.mp3$/.exec(f); if (h) have.add(h[1]); } } catch (e) {} }
      return out(200, { have: [...have] });
    }
    m = /^\/admin\/zl\/([a-z0-9][a-z0-9-]{0,40})\/want$/.exec(url);
    if (m) {                                           // 点播：请电脑录音机录这本书的某个声音（POST {voice, name, from}）；DELETE ?voice= 取消
      const id = m[1], it = zlRead().items.find(x => x.id === id); if (!it) return out(404, { error: 'no-book' });
      const q = zqRead();
      if (req.method === 'POST') {
        const b = JSON.parse(await readBody(req, 4000) || '{}'), vk = vkey(b.voice); if (!vk) return out(400, { error: 'bad-voice' });
        const name = String(b.name || vk).slice(0, 40), from = Math.max(0, Math.min((it.n || 1) - 1, parseInt(b.from) || 0));
        const dir = zlDirFor(id, vk); fs.mkdirSync(dir, { recursive: true }); if (dir !== path.join(ZL_DIR, id)) { const nf = path.join(dir, 'name.txt'); if (!fs.existsSync(nf) || b.name) fs.writeFileSync(nf, name); }
        q.jobs = q.jobs.filter(j => !(j.id === id && j.voice === vk)); q.jobs.unshift({ id, voice: vk, name, from, at: Date.now() }); q.jobs = q.jobs.slice(0, 50); zqWrite(q); zlLive.at = 0;
        return out(200, { ok: true, jobs: q.jobs.length });
      }
      if (req.method === 'DELETE') { const vk = vkey(new URL(req.url, 'http://x').searchParams.get('voice')); q.jobs = q.jobs.filter(j => !(j.id === id && j.voice === vk)); zqWrite(q); return out(200, { ok: true }); }
    }
    if (req.method === 'GET' && url === '/admin/queue') {   // 录音机来取待录清单（最新点的排最前）
      const books = zlRead().items, jobs = zqRead().jobs.map(j => { const it = books.find(x => x.id === j.id); return it ? { ...j, n: it.n, title: it.title } : null; }).filter(Boolean);
      return out(200, { jobs });
    }
    if (req.method === 'POST' && url === '/admin/zl/purge-voices') {   // 删掉所有书里不在 keep 里的声音（旧的 Qwen 录音）：{keep:[声音编号], dry:true 只看不删}
      const b = JSON.parse(await readBody(req, 4000) || '{}'), keep = new Set((Array.isArray(b.keep) ? b.keep : []).map(vkey).filter(Boolean)), dry = !!b.dry;
      if (!keep.size) return out(400, { error: 'no-keep' });
      const kept = k => k.split('_x_').every(x => keep.has(x)), isClip = f => /^[0-9a-f]{16,64}\.mp3$/.test(f), j = zlRead(), rep = []; let files = 0;
      for (const it of j.items) {
        const base = path.join(ZL_DIR, it.id), r = { id: it.id, title: it.title, del: [] }; let names = [];
        try { names = fs.readdirSync(base); } catch (e) { continue; }
        const root = names.filter(isClip);
        if (root.length && !kept(vkey(it.voice))) { r.del.push({ k: '', name: it.voice, clips: root.length }); files += root.length; if (!dry) for (const f of root) fs.rmSync(path.join(base, f), { force: true }); }
        for (const d of names) {
          const m = /^v-([a-z0-9_]{1,24})$/.exec(d); if (!m || kept(m[1])) continue;
          let n = 0; try { n = fs.readdirSync(path.join(base, d)).filter(isClip).length; } catch (e) {}
          r.del.push({ k: m[1], clips: n }); files += n; if (!dry) fs.rmSync(path.join(base, d), { recursive: true, force: true });
        }
        if (r.del.length) rep.push(r);
        if (!dry) { it.voices = zlVoices(it.id, it); it.clips = it.voices[0].clips; }
      }
      const q = zqRead(), qdel = q.jobs.filter(x => !kept(x.voice));
      if (!dry) { zlWrite(j); q.jobs = q.jobs.filter(x => kept(x.voice)); zqWrite(q); zlLive.at = 0; }
      return out(200, { ok: true, dry, books: rep.length, files, queue: qdel.map(x => ({ id: x.id, voice: x.voice })), detail: rep });
    }
    if (req.method === 'POST' && url === '/admin/queue/done') { const b = JSON.parse(await readBody(req, 2000) || '{}'), vk = vkey(b.voice), q = zqRead(); q.jobs = q.jobs.filter(j => !(j.id === b.id && j.voice === vk)); zqWrite(q); return out(200, { ok: true }); }
    if (req.method === 'POST' && url === '/admin/worker/ping') { const b = JSON.parse(await readBody(req, 2000) || '{}'); ZL_WORKER.ts = Date.now(); ZL_WORKER.job = String(b.job || '').slice(0, 80); ZL_WORKER.msg = String(b.msg || '').slice(0, 80); return out(200, { ok: true }); }
    m = /^\/admin\/zl\/([a-z0-9][a-z0-9-]{0,40})(?:\/(have|clips|book))?$/.exec(url);
    if (m && m[1] && (m[2] || req.method === 'DELETE')) {
      const id = m[1], dir = path.join(ZL_DIR, id);
      if (req.method === 'GET' && m[2] === 'have') { let have = []; const vq = new URL(req.url, 'http://x').searchParams.get('voice'); try { have = fs.readdirSync(zlDirFor(id, vq)).map(f => /^([0-9a-f]{16,64})\.mp3$/.exec(f)).filter(Boolean).map(x => x[1]); } catch (e) {} return out(200, { have }); }
      if (req.method === 'PUT' && m[2] === 'clips') {          // 一批语音：zip（不压缩），里面是 clips/<句子哈希>.mp3
        let ents; try { ents = unzipBuf(await readBodyBuf(req, MAX_UPLOAD)); } catch (e) { return out(e.message === 'too-big' ? 413 : 400, { error: e.message === 'too-big' ? 'too-big' : 'bad-zip' }); }
        const cdir = zlDirFor(id, new URL(req.url, 'http://x').searchParams.get('voice')); fs.mkdirSync(cdir, { recursive: true }); let n = 0;
        for (const e of ents) { const k = CLIP_RE.exec(e.name); if (k && e.data.length > 100) { fs.writeFileSync(path.join(cdir, k[1] + '.mp3'), e.data); n++; } }
        zlLive.at = 0; return out(200, { ok: true, clips: n });
      }
      if (req.method === 'PUT' && m[2] === 'book') {            // 书的内容 + 上架：{title, author, voice, s:[句子], p:[每段起点]}
        const b = JSON.parse((await readBodyBuf(req, 30 * 1048576)).toString('utf8'));
        if (!b || !Array.isArray(b.s) || !b.s.length || b.s.length > 300000 || !b.s.every(x => typeof x === 'string')) return out(400, { error: 'bad-book' });
        const title = String(b.title || '').trim().slice(0, 80); if (!title) return out(400, { error: 'no-title' });
        const book = { title, author: String(b.author || '').trim().slice(0, 40), s: b.s, p: Array.isArray(b.p) ? b.p.filter(x => Number.isInteger(x) && x >= 0 && x < b.s.length) : [0], voice: String(b.voice || '').slice(0, 40) };
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'book.json.tmp'), JSON.stringify(book)); fs.renameSync(path.join(dir, 'book.json.tmp'), path.join(dir, 'book.json'));
        const j = zlRead(), k = j.items.findIndex(x => x.id === id), old = k >= 0 ? j.items[k] : null, vq = vkey(new URL(req.url, 'http://x').searchParams.get('voice'));
        const extra = !!old && !!vq && vq !== vkey(old.voice);      // 给已有的书加第二、第三种声音：不改默认声音，只登记这个声音的名字
        if (extra) { const vd = path.join(dir, 'v-' + vq); fs.mkdirSync(vd, { recursive: true }); fs.writeFileSync(path.join(vd, 'name.txt'), String(b.voice || vq).slice(0, 40)); }
        const it = { id, title, author: book.author, n: book.s.length, chars: book.s.reduce((a, x) => a + x.length, 0), voice: extra ? old.voice : book.voice, clips: 0, at: Date.now() };
        it.voices = zlVoices(id, it); it.clips = it.voices[0].clips;
        if (k >= 0) j.items[k] = it; else j.items.push(it); zlWrite(j); zlLive.at = 0;
        return out(200, { ok: true, item: it });
      }
      if (req.method === 'DELETE' && !m[2]) { fs.rmSync(dir, { recursive: true, force: true }); const j = zlRead(); j.items = j.items.filter(x => x.id !== id); zlWrite(j); zlLive.at = 0; return out(200, { ok: true }); }
    }
    if (req.method === 'POST' && url === '/admin/tts') {            // 中文自然人声：{text, voice} → mp3
      if (!AZ_KEY || (!AZ_REGION && !TTS_HOST)) return out(503, { error: 'not-configured' });
      const b = JSON.parse(await readBody(req, 5000)), text = String(b.text || '').trim().slice(0, 300), voice = TTS_VOICES.includes(b.voice) ? b.voice : TTS_VOICES[0];
      if (!text) return out(400, { error: 'empty' });
      const key = crypto.createHash('sha1').update(voice + '|' + text).digest('hex'), f = path.join(TTS_DIR, key.slice(0, 2), key + '.mp3');
      const send = buf => { const h2 = { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' }; if (okO) { h2['Access-Control-Allow-Origin'] = okO; h2.Vary = 'Origin'; } res.writeHead(200, h2); res.end(buf); return true; };
      try { return send(fs.readFileSync(f)); } catch (e) {}
      const d = new Date().toISOString().slice(0, 10); if (ttsUse.d !== d) ttsUse = { d, n: 0 };
      if (ttsUse.n + text.length > TTS_DAILY_CHARS) return out(429, { error: 'daily-limit' });
      const r = await ttsAzure(text, voice);
      if (r.s !== 200 || r.b.length < 100) return out(502, { error: 'azure-failed', status: r.s });
      ttsUse.n += text.length; try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, r.b); fs.writeFileSync(TTS_USE, JSON.stringify(ttsUse)); } catch (e) {}
      return send(r.b);
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
    if (req.method === 'GET' && url === '/admin/reads') return out(200, { items: readsSummary() });
    if (req.method === 'GET' && url === '/admin/visits') {            // 访问统计：每天多少台设备；带 date 就列出那一天的每台设备
      const q = new URL(req.url, 'http://x').searchParams, date = q.get('date');
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return out(400, { error: 'bad-date' });
        const keys = Object.keys(visits).sort(), first = new Map();
        for (const k of keys) for (const d of Object.keys(visits[k])) if (!first.has(d)) first.set(d, k);
        const list = Object.entries(visits[date] || {}).map(([d, r]) => ({ id: d.slice(0, 6), dv: r.dv, br: r.br, ip: r.ip, v: r.v, pwa: r.pwa, n: r.n, f: r.f, l: r.l, isNew: first.get(d) === date, days: keys.filter(k => visits[k][d]).length })).sort((a, b) => b.l - a.l);
        return out(200, { date, list });
      }
      return out(200, { days: visitsSummary(Math.min(120, Math.max(1, +q.get('days') || 30))) });
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
    if (req.method === 'GET' && url === '/admin/reports') return out(200, { items: repList() });
    if (req.method === 'POST' && url === '/admin/reports/done') {   // 标为已处理：这个词在此之前的报错都算处理过了；之后再有人报还会出来
      const b = JSON.parse(await readBody(req, 500)), w = String(b.w || '').toLowerCase(); if (!w) return out(400, { error: 'bad-word' });
      const d = repDone(); d[w] = Date.now(); fs.mkdirSync(SHOP_DIR, { recursive: true }); fs.writeFileSync(REPORT_DONE, JSON.stringify(d)); return out(200, { ok: true });
    }
    if (req.method === 'GET' && url === '/admin/backups') return out(200, { items: backupList(), keep: BACKUP_KEEP, busy: backupBusy, last: backupLast });
    if (req.method === 'POST' && url === '/admin/backups/run') return out(200, await backupRun());
    m = /^\/admin\/backups\/(sr-\d{8}-\d{4}\.tar\.gz)$/.exec(url);
    if (req.method === 'GET' && m) {
      const f = path.join(BACKUP_DIR, m[1]); if (!fs.existsSync(f)) return out(404, { error: 'not-found' });
      res.writeHead(200, { ...hd, 'Content-Type': 'application/gzip', 'Content-Length': fs.statSync(f).size, 'Content-Disposition': 'attachment; filename="' + m[1] + '"', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res); return true;
    }
    if (url === '/admin/devdoc') {                       // 开发者使用说明：存在服务器私有目录（不在公开的 GitHub 仓库里），只有带后台口令才能看、能改
      const f = path.join(SHOP_DIR, 'devdoc.md');
      if (req.method === 'GET') { if (!fs.existsSync(f)) return out(404, { error: 'no-doc' }); res.writeHead(200, { ...hd, 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(f)); return true; }
      if (req.method === 'PUT') { const b = await readBody(req, 2 * 1048576); fs.mkdirSync(SHOP_DIR, { recursive: true }); fs.writeFileSync(f + '.tmp', b); fs.renameSync(f + '.tmp', f); return out(200, { ok: true, bytes: b.length }); }
    }
    if (req.method === 'POST' && url === '/admin/item') {
      const it = cleanItem(JSON.parse(await readBody(req, 20000))); if (!it) return out(400, { error: 'bad-item' });
      const j = shopRead(); const k = j.items.findIndex(x => x.id === it.id); if (k >= 0 && !it.voices && j.items[k].voices) it.voices = j.items[k].voices;   // 在开发者页改书名、价格时，别把录好的男声弄丢
      if (k >= 0) j.items[k] = it; else j.items.push(it);
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
        const from = toPriv ? SHOP_FILES : SHOP_PRIV, to = toPriv ? SHOP_PRIV : SHOP_FILES, names = [id + '.srbook', id + '.voice.zip', id, ...Array.from({ length: 60 }, (_, k) => id + '.voice' + (k + 2) + '.zip').filter(n => fs.existsSync(path.join(from, n)))];
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
    m = /^\/admin\/voices\/([a-z0-9][a-z0-9-]{0,59})$/.exec(url);
    if (m && req.method === 'POST') {                  // 录音机录好了第二个声音：在学习材料里记上，手机上就能选
      const b = JSON.parse(await readBody(req, 1000) || '{}'), v = String(b.voice || ''); if (!WVK.test(v)) return out(400, { error: 'bad-voice' });
      const j = shopRead(), it = j.items.find(x => x.id === m[1]); if (!it) return out(404, { error: 'story-not-found' });
      it.voices = [...new Set([...(it.voices || []), v])].slice(0, 8); shopWrite(j); return out(200, { ok: true, voices: it.voices });
    }
    m = /^\/admin\/repack\/([a-z0-9][a-z0-9-]{0,59})$/.exec(url);       // 语音已经齐全、但总包没生成（或太大没合成）时：只重新打一遍“下载全部语音”包，不用重传
    if (m && req.method === 'POST') {
      const bk = baseOf(m[1]), priv = !fs.existsSync(path.join(SHOP_FILES, bk + '.srbook'));
      if (priv && !fs.existsSync(path.join(SHOP_PRIV, bk + '.srbook'))) return out(404, { error: 'not-found' });
      const r = rebuildVoiceZip(m[1], priv); if (r && r.tooBig) return out(200, { ok: true, tooBig: true, total: r.total });
      const base = priv ? SHOP_PRIV : SHOP_FILES; let parts = 0; for (let k = 1; k < 200; k++) { if (fs.existsSync(path.join(base, m[1] + (k === 1 ? '.voice' : '.voice' + k) + '.zip'))) parts = k; else break; }
      return out(200, { ok: true, clips: r || 0, parts });
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
      let clips = 0, big = null; if (vm) {
        try {
          const ents = unzipBuf(fs.readFileSync(path.join(dir, m[1]))); clips = extractClips(vm[1], ents, priv);
          if (!/[?&]last=0\b/.test(req.url)) { const r = rebuildVoiceZip(vm[1], priv); if (r && r.tooBig) big = r.total; }   // 分批上传时，只有最后一批才合并总包
          else fs.unlinkSync(path.join(dir, m[1]));        // 中间批：只留拆开的一句一个文件，不留这一批的小包（否则会被当成总包下载）
        } catch (e) { return out(400, { error: 'bad-voice-zip' }); }
      }
      return out(200, { ok: true, bytes: n, clips, tooBig: big !== null, total: big });
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

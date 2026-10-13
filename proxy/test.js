// 本地测试：起一个假的火山接口，验证中转逻辑（不涉及真实密钥）
process.env.VOLC_AK = 'AKTEST'; process.env.VOLC_SK = 'SKTEST';
process.env.ALLOW_ORIGINS = 'https://ok.example';
process.env.VOLC_HOST = '127.0.0.1:9911'; process.env.VOLC_PROTO = 'http';
process.env.MONTH_LIMIT = '30'; process.env.RATE_PER_MIN = '20'; process.env.DAILY_PER_IP = '12'; process.env.CACHE_FILE = '/tmp/cache-test.json';
process.env.USAGE_FILE = '/tmp/usage-test.json';
for (const f of ['/tmp/usage-test.json','/tmp/cache-test.json']) try { require('fs').unlinkSync(f); } catch (e) {}
const http = require('http'), assert = require('assert');
let seen;
const fake = http.createServer((q, r) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { seen = { url: q.url, h: q.headers, b: JSON.parse(b) };
  r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ TranslationList: [{ Translation: '你好' }] })); }); }).listen(9911);
const { server } = require('./server.js'); server.listen(9912);
const call = (path, o = {}) => new Promise(ok => { const q = http.request({ port: 9912, path, method: o.m || 'POST', headers: { 'Content-Type': 'application/json', ...(o.h || {}) } }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => ok({ s: r.statusCode, b, h: r.headers })); }); q.end(o.body); });
(async () => {
  const O = { Origin: 'https://ok.example' };
  let r = await call('/translate', { h: O, body: JSON.stringify({ text: 'Hello' }) });
  assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).translation, '你好'); assert.equal(r.h['access-control-allow-origin'], 'https://ok.example');
  assert.match(seen.h.authorization, /^HMAC-SHA256 Credential=AKTEST\/\d{8}\/cn-north-1\/translate\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/);
  assert.equal(seen.url, '/?Action=TranslateText&Version=2020-06-01'); assert.deepEqual(seen.b.TextList, ['Hello']); assert.equal(seen.b.TargetLanguage, 'zh');
  const n0 = seen; seen = null;
  r = await call('/translate', { h: O, body: JSON.stringify({ text: 'Hello' }) });
  assert.equal(JSON.parse(r.b).cached, true); assert.equal(seen, null);   // 缓存命中不请求火山
  r = await call('/translate', { h: O, body: JSON.stringify({ text: 'World!!' }) }); assert.equal(r.s, 200);
  r = await call('/translate', { h: O, body: JSON.stringify({ text: 'abc' }) }); assert.equal(r.s, 429); assert.equal(JSON.parse(r.b).error, 'daily');
  r = await call('/translate', { h: { Origin: 'https://evil.example' }, body: JSON.stringify({ text: 'Hi' }) }); assert.equal(r.s, 403);
  r = await call('/translate', { h: O, body: '{}' }); assert.equal(r.s, 400);
  r = await call('/translate', { h: O, body: JSON.stringify({ text: 'x'.repeat(40) }) }); assert.equal(r.s, 429); assert.equal(JSON.parse(r.b).error, 'quota');
  r = await call('/translate', { m: 'OPTIONS', h: O }); assert.equal(r.s, 204);
  for (let i = 0; i < 25; i++) r = await call('/translate', { h: O, body: JSON.stringify({ text: 'a' }) });
  assert.equal(r.s, 429); assert.equal(JSON.parse(r.b).error, 'rate-limited');
  console.log('ALL OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

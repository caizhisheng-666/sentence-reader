// 故事城后台接口测试（不涉及真实密钥）
process.env.VOLC_AK = 'A'; process.env.VOLC_SK = 'S'; process.env.ALLOW_ORIGINS = 'https://ok.example';
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890'; process.env.USAGE_FILE = '/tmp/shoptest/usage.json'; process.env.MAX_UPLOAD = '2000';
require('child_process').execSync('rm -rf /tmp/shoptest');
const http = require('http'), assert = require('assert');
const { server } = require('./server.js'); server.listen(9922);
const call = (path, o = {}) => new Promise(ok => { const q = http.request({ port: 9922, path, method: o.m || 'GET', headers: o.h || {} }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => ok({ s: r.statusCode, b, h: r.headers })); }); q.end(o.body); });
const A = { Origin: 'https://ok.example', Authorization: 'Bearer test-admin-token-1234567890', 'Content-Type': 'application/json' };
(async () => {
  let r = await call('/catalog'); assert.equal(r.s, 200); assert.deepEqual(JSON.parse(r.b).items, []); assert.equal(r.h['access-control-allow-origin'], '*');
  r = await call('/admin/item', { m: 'POST', h: { Origin: 'https://ok.example', Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.s, 401);
  r = await call('/admin/item', { m: 'POST', h: { ...A, Origin: 'https://evil.example' }, body: '{}' }); assert.equal(r.s, 403);
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'Bad ID', title: 'x' }) }); assert.equal(r.s, 400);
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'kitten-voice', kind: 'voice', forId: 'kitten', title: 'Kitten 语音包', price: '9.9', count: 12, file: 'https://evil/x', evil: 1 }) }); assert.equal(r.s, 200);
  r = await call('/catalog'); let it = JSON.parse(r.b).items; assert.equal(it.length, 1); assert.equal(it[0].price, 9.9); assert.equal(it[0].file, undefined); assert.equal(it[0].evil, undefined);
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'kitten-voice', kind: 'voice', title: 'T2', file: 'api:files/k.zip' }) }); r = await call('/catalog');
  it = JSON.parse(r.b).items; assert.equal(it.length, 1); assert.equal(it[0].title, 'T2'); assert.equal(it[0].file, 'api:files/k.zip'); assert.equal(it[0].price, undefined);
  r = await call('/admin/file/k.zip', { m: 'PUT', h: A, body: 'PKdata' }); assert.equal(r.s, 200);
  r = await call('/files/k.zip'); assert.equal(r.s, 200); assert.equal(r.b, 'PKdata');
  r = await call('/admin/file/secret.zip?private=1', { m: 'PUT', h: A, body: 'PRIV' }); assert.equal(r.s, 200);
  r = await call('/files/secret.zip'); assert.equal(r.s, 404);   // 收费文件不能公开下载
  assert.equal(require('fs').readFileSync('/tmp/shoptest/shop/private/secret.zip', 'utf8'), 'PRIV');
  r = await call('/files/..%2Fcatalog.json'); assert.equal(r.s, 404);
  r = await call('/admin/file/big.zip', { m: 'PUT', h: A, body: 'x'.repeat(5000) }); assert.equal(r.s, 413);
  r = await call('/admin/file/bad.exe', { m: 'PUT', h: A, body: 'x' }); assert.equal(r.s, 404);
  r = await call('/admin/item/kitten-voice', { m: 'DELETE', h: A }); assert.equal(r.s, 200);
  r = await call('/catalog'); const j = JSON.parse(r.b); assert.equal(j.items.length, 0); assert.deepEqual(j.removed, ['kitten-voice']);
  for (let i = 0; i < 9; i++) r = await call('/admin/item', { m: 'POST', h: { Origin: 'https://ok.example', Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.s, 429);
  console.log('SHOP OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

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
  r = await call('/admin/private/secret.zip', { h: A }); assert.equal(r.s, 200); assert.equal(r.b, 'PRIV');
  r = await call('/admin/private/secret.zip', { h: { Origin: 'https://ok.example' } }); assert.equal(r.s, 401);
  r = await call('/files/..%2Fcatalog.json'); assert.equal(r.s, 404);
  r = await call('/admin/file/big.zip', { m: 'PUT', h: A, body: 'x'.repeat(5000) }); assert.equal(r.s, 413);
  r = await call('/admin/file/bad.exe', { m: 'PUT', h: A, body: 'x' }); assert.equal(r.s, 404);
  // 语音按句拆分：上传 voice.zip 自动拆；旧格式 srbook 用 /admin/split 转换
  const JSZip = require('../lib/jszip.min.js');
  const H1 = 'a'.repeat(64), H2 = 'b'.repeat(64);
  let z = new JSZip(); z.file('manifest.json', '{}'); z.file('clips/' + H1 + '.mp3', 'AUDIO-ONE'); z.file('clips/' + H2 + '.mp3', 'AUDIO-TWO');
  let zb = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  r = await call('/admin/file/kit.voice.zip', { m: 'PUT', h: A, body: zb }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).clips, 2);
  r = await call('/files/kit/' + H1 + '.mp3'); assert.equal(r.s, 200); assert.equal(r.b, 'AUDIO-ONE'); assert.equal(r.h['content-type'], 'audio/mpeg');
  r = await call('/files/kit/' + 'c'.repeat(64) + '.mp3'); assert.equal(r.s, 404);
  // 增量补语音：只传新句子，“下载全部语音”总包会重建成全部语音
  const H3 = 'd'.repeat(64);
  z = new JSZip(); z.file('manifest.json', '{}'); z.file('clips/' + H3 + '.mp3', 'AUDIO-THREE');
  zb = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  r = await call('/admin/file/kit.voice.zip', { m: 'PUT', h: A, body: zb }); assert.equal(r.s, 200);
  r = await new Promise(ok => http.get({ port: 9922, path: '/files/kit.voice.zip' }, rr => { const ch = []; rr.on('data', c => ch.push(c)); rr.on('end', () => ok(Buffer.concat(ch))); }));
  const kz = await JSZip.loadAsync(r); assert.deepEqual(Object.keys(kz.files).filter(n => /^clips\//.test(n)).sort(), ['clips/' + H1 + '.mp3', 'clips/' + H2 + '.mp3', 'clips/' + H3 + '.mp3']);
  r = await call('/files/kit/' + H1 + '.mp3'); assert.equal(r.b, 'AUDIO-ONE');
  r = await call('/admin/clips/kit', { h: A }); assert.equal(r.s, 200); assert.deepEqual(JSON.parse(r.b).have.sort(), [H1, H2, H3]);
  r = await call('/admin/clips/kit', { h: { Origin: 'https://ok.example' } }); assert.equal(r.s, 401);
  r = await call('/admin/item', { m: 'POST', h: Object.assign({ 'Content-Type': 'application/json' }, A), body: JSON.stringify({ id: 'kit', kind: 'story', title: 'Kit', ver: 3.4 }) }); assert.equal(r.s, 200);
  r = await call('/catalog'); assert.equal(JSON.parse(r.b).items.find(x => x.id === 'kit').ver, 3);
  r = await call('/admin/item/kit', { m: 'DELETE', h: A }); assert.equal(r.s, 200);
  z = new JSZip(); z.file('manifest.json', '{"format":"sr-story","id":"leg"}'); z.file('book.txt', 'Hello there.'); z.file('clips/' + H1 + '.mp3', 'OLD-ONE');
  zb = await z.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  r = await call('/admin/file/leg.srbook', { m: 'PUT', h: A, body: zb }); assert.equal(r.s, 200);
  r = await call('/admin/split/leg', { m: 'POST', h: A }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).clips, 1);
  r = await new Promise(ok => http.get({ port: 9922, path: '/files/leg.srbook' }, rr => { const ch = []; rr.on('data', c => ch.push(c)); rr.on('end', () => ok(Buffer.concat(ch))); }));
  const lz = await JSZip.loadAsync(r); assert.deepEqual(Object.keys(lz.files).sort(), ['book.txt', 'manifest.json']); assert.equal(await lz.file('book.txt').async('string'), 'Hello there.');
  r = await call('/files/leg/' + H1 + '.mp3'); assert.equal(r.b, 'OLD-ONE');
  r = await call('/files/leg.voice.zip'); assert.equal(r.s, 200);
  r = await call('/admin/split/leg', { m: 'POST', h: A }); assert.equal(JSON.parse(r.b).already, true);
  r = await call('/admin/split/leg', { m: 'POST', h: { Origin: 'https://ok.example' } }); assert.equal(r.s, 401);
  r = await call('/admin/item/kitten-voice', { m: 'DELETE', h: A }); assert.equal(r.s, 200);
  r = await call('/catalog'); const j = JSON.parse(r.b); assert.equal(j.items.length, 0); assert.ok(j.removed.includes('kitten-voice'));
  // 兑换码：收费故事只发给兑换过的买家
  const J = Object.assign({}, A), O = { Origin: 'https://ok.example', 'Content-Type': 'application/json' };
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'pay1', kind: 'story', title: 'Paid', price: 9.9, buy: '闲鱼搜 喵喵', buyUrl: 'https://m.goofish.com/x', ver: 1 }) }); assert.equal(r.s, 200);
  r = await call('/catalog'); const pi = JSON.parse(r.b).items.find(x => x.id === 'pay1'); assert.equal(pi.buy, '闲鱼搜 喵喵'); assert.equal(pi.buyUrl, 'https://m.goofish.com/x');
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'pay1', buyUrl: 'javascript:alert(1)' }) }); r = await call('/catalog'); assert.equal(JSON.parse(r.b).items.find(x => x.id === 'pay1').buyUrl, 'https://m.goofish.com/x');
  const PZ = new JSZip(); PZ.file('manifest.json', '{"format":"sr-story","id":"pay1"}'); PZ.file('book.txt', 'Secret text.');
  r = await call('/admin/file/pay1.srbook?private=1', { m: 'PUT', h: A, body: await PZ.generateAsync({ type: 'nodebuffer' }) }); assert.equal(r.s, 200);
  const HP = 'e'.repeat(64);
  const PV = new JSZip(); PV.file('manifest.json', '{}'); PV.file('clips/' + HP + '.mp3', 'PAID-AUDIO');
  r = await call('/admin/file/pay1.voice.zip?private=1', { m: 'PUT', h: A, body: await PV.generateAsync({ type: 'nodebuffer' }) }); assert.equal(r.s, 200);
  r = await call('/files/pay1.srbook'); assert.equal(r.s, 404);
  r = await call('/admin/codes', { m: 'POST', h: A, body: JSON.stringify({ story: 'nope', n: 1 }) }); assert.equal(r.s, 404);
  r = await call('/admin/codes', { m: 'POST', h: { Origin: 'https://ok.example' }, body: '{}' }); assert.equal(r.s, 401);
  r = await call('/admin/codes', { m: 'POST', h: A, body: JSON.stringify({ story: 'pay1', n: 3 }) }); assert.equal(r.s, 200);
  const cs = JSON.parse(r.b).codes; assert.equal(cs.length, 3); assert.ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(cs[0])); assert.equal(new Set(cs).size, 3);
  r = await call('/redeem', { m: 'POST', h: O, body: JSON.stringify({ code: 'AAAA-BBBB-CCCC' }) }); assert.equal(r.s, 404);
  r = await call('/redeem', { m: 'POST', h: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: cs[0] }) }); assert.equal(r.s, 403);
  r = await call('/redeem', { m: 'POST', h: O, body: JSON.stringify({ code: cs[0].toLowerCase().replace(/-/g, ' ') }) }); assert.equal(r.s, 200);
  const rd = JSON.parse(r.b); assert.ok(/^[0-9a-f]{32}$/.test(rd.tk)); assert.equal(rd.item.id, 'pay1'); assert.equal(rd.left, 2);
  r = await call('/pfiles/' + rd.tk + '/story.srbook'); assert.equal(r.s, 200); assert.ok(r.h['content-length'] > 20);
  r = await call('/pfiles/' + rd.tk + '/' + HP + '.mp3'); assert.equal(r.s, 200); assert.equal(r.b, 'PAID-AUDIO');
  r = await call('/pfiles/' + rd.tk + '/voice.zip'); assert.equal(r.s, 200);
  r = await call('/pfiles/' + 'f'.repeat(32) + '/story.srbook'); assert.equal(r.s, 404);
  r = await call('/pfiles/' + rd.tk + '/..%2f..%2fcatalog.json'); assert.equal(r.s, 404);
  r = await call('/redeem', { m: 'POST', h: O, body: JSON.stringify({ code: cs[0] }) }); assert.equal(JSON.parse(r.b).tk, rd.tk);
  await call('/redeem', { m: 'POST', h: O, body: JSON.stringify({ code: cs[0] }) });
  r = await call('/redeem', { m: 'POST', h: O, body: JSON.stringify({ code: cs[0] }) }); assert.equal(r.s, 403);   // 最多 3 台设备
  r = await call('/admin/codes?story=pay1', { h: A }); const lst = JSON.parse(r.b).codes; assert.equal(lst.length, 3); assert.equal(lst.find(x => x.code === cs[0]).uses, 3);
  r = await call('/admin/codes/' + cs[0], { m: 'DELETE', h: A }); assert.equal(r.s, 200);
  r = await call('/pfiles/' + rd.tk + '/story.srbook'); assert.equal(r.s, 404);   // 撤销后买家凭证失效
  r = await call('/redeem', { m: 'POST', h: O, body: JSON.stringify({ code: cs[0] }) }); assert.equal(r.s, 404);
  // 改价格：收费 → 免费 → 收费，文件在两个目录间搬
  r = await call('/admin/price/pay1', { m: 'POST', h: { Origin: 'https://ok.example' }, body: '{"price":0}' }); assert.equal(r.s, 401);
  r = await call('/admin/price/pay1', { m: 'POST', h: A, body: '{"price":0}' }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).moved, 'public');
  r = await call('/files/pay1.srbook'); assert.equal(r.s, 200);
  r = await call('/files/pay1/' + HP + '.mp3'); assert.equal(r.b, 'PAID-AUDIO');
  r = await call('/catalog'); let pq = JSON.parse(r.b).items.find(x => x.id === 'pay1'); assert.equal(pq.price, undefined); assert.equal(pq.file, 'api:files/pay1.srbook');
  r = await call('/admin/price/pay1', { m: 'POST', h: A, body: '{"price":19.9}' }); assert.equal(JSON.parse(r.b).moved, 'private');
  r = await call('/files/pay1.srbook'); assert.equal(r.s, 404);
  r = await call('/catalog'); pq = JSON.parse(r.b).items.find(x => x.id === 'pay1'); assert.equal(pq.price, 19.9); assert.equal(pq.file, undefined);
  r = await call('/admin/price/pay1', { m: 'POST', h: A, body: '{"price":29}' }); assert.equal(JSON.parse(r.b).moved, '');
  r = await call('/admin/price/nope', { m: 'POST', h: A, body: '{"price":1}' }); assert.equal(r.s, 404);
  // 限时免费
  r = await call('/claim', { m: 'POST', h: O, body: '{"story":"pay1"}' }); assert.equal(r.s, 403);
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'pay1', kind: 'story', title: 'Paid', price: 29, freeUntil: Date.now() + 86400000 }) }); assert.equal(r.s, 200);
  r = await call('/claim', { m: 'POST', h: { 'Content-Type': 'application/json' }, body: '{"story":"pay1"}' }); assert.equal(r.s, 403);
  r = await call('/claim', { m: 'POST', h: O, body: '{"story":"pay1"}' }); assert.equal(r.s, 200); const cl = JSON.parse(r.b); assert.ok(/^[0-9a-f]{32}$/.test(cl.tk));
  r = await call('/pfiles/' + cl.tk + '/story.srbook'); assert.equal(r.s, 200);
  r = await call('/admin/codes?story=pay1', { h: A }); assert.equal(JSON.parse(r.b).codes.length, 3);   // 领取记录不混进兑换码列表
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'pay1', kind: 'story', title: 'Paid', price: 29, freeUntil: Date.now() - 1000 }) });
  r = await call('/claim', { m: 'POST', h: O, body: '{"story":"pay1"}' }); assert.equal(r.s, 403);   // 活动结束
  r = await call('/pfiles/' + cl.tk + '/story.srbook'); assert.equal(r.s, 200);                          // 已领的人仍可用
  // 发货：取下一个没发过的码
  r = await call('/admin/codes', { m: 'POST', h: A, body: JSON.stringify({ story: 'pay1', n: 2 }) }); const nc = JSON.parse(r.b).codes;
  r = await call('/admin/codes/issue', { m: 'POST', h: { Origin: 'https://ok.example' }, body: '{"story":"pay1"}' }); assert.equal(r.s, 401);
  r = await call('/admin/codes/issue', { m: 'POST', h: A, body: '{"story":"pay1"}' }); assert.equal(r.s, 200); const i1 = JSON.parse(r.b);
  r = await call('/admin/codes/issue', { m: 'POST', h: A, body: '{"story":"pay1"}' }); const i2 = JSON.parse(r.b); assert.notEqual(i1.code, i2.code);
  assert.ok(nc.includes(i1.code) || !nc.includes(i1.code));
  r = await call('/admin/codes?story=pay1', { h: A }); assert.equal(JSON.parse(r.b).codes.find(x => x.code === i1.code).issued, true);
  r = await call('/admin/codes/issue', { m: 'POST', h: A, body: JSON.stringify({ undo: i1.code }) }); assert.equal(r.s, 200);
  r = await call('/admin/codes/issue', { m: 'POST', h: A, body: '{"story":"nope"}' }); assert.equal(r.s, 404);
  r = await call('/admin/item/pay1', { m: 'DELETE', h: A }); assert.equal(r.s, 200);
  r = await call('/admin/codes', { m: 'POST', h: A, body: JSON.stringify({ story: 'pay1', n: 1 }) }); assert.equal(r.s, 404);
  for (let i = 0; i < 9; i++) r = await call('/admin/item', { m: 'POST', h: { Origin: 'https://ok.example', Authorization: 'Bearer nope', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.s, 429);
  console.log('SHOP OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

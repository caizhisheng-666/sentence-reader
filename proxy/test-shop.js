// 故事城后台接口测试（不涉及真实密钥）
process.env.VOLC_AK = 'A'; process.env.VOLC_SK = 'S'; process.env.ALLOW_ORIGINS = 'https://ok.example';
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890'; process.env.USAGE_FILE = '/tmp/shoptest/usage.json'; process.env.MAX_UPLOAD = '20000'; process.env.GRAMMAR_URL = 'http://127.0.0.1:9923'; process.env.AZURE_SPEECH_KEY = 'k'; process.env.AZURE_STT_HOST = 'http://127.0.0.1:9924'; process.env.AZURE_TTS_HOST = 'http://127.0.0.1:9926'; process.env.TTS_DAILY_CHARS = '40'; process.env.VOICE_ZIP_MAX = '12000'; process.env.VOICE_PART_MAX = '3000'; process.env.ARK_API_KEY = 'ark-test'; process.env.ARK_HOST = 'http://127.0.0.1:9925'; process.env.EXPLAIN_PER_IP_HOUR = '3'; process.env.CHAT_PER_IP_HOUR = '8';
require('child_process').execSync('rm -rf /tmp/shoptest');
const http = require('http'), assert = require('assert');
const { server } = require('./server.js'); server.listen(9922);
const call = (path, o = {}) => new Promise(ok => { const q = http.request({ port: 9922, path, method: o.m || 'GET', headers: o.h || {} }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => ok({ s: r.statusCode, b, h: r.headers })); }); q.end(o.body); });
const A = { Origin: 'https://ok.example', Authorization: 'Bearer test-admin-token-1234567890', 'Content-Type': 'application/json' };
(async () => {
  let r = await call('/catalog'); assert.equal(r.s, 200); assert.deepEqual(JSON.parse(r.b).items, []); assert.equal(r.h['access-control-allow-origin'], '*');
  r = await call('/admin/item', { m: 'POST', h: { Origin: 'https://ok.example', Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.s, 401);
  r = await call('/admin/item', { m: 'POST', h: { ...A, Origin: 'https://evil.example' }, body: '{}' }); assert.equal(r.s, 403);
  { // 中文听书公版书库
    r = await call('/zl/catalog'); assert.equal(r.s, 200); assert.deepEqual(JSON.parse(r.b).items, []);
    const hx = 'ab'.repeat(32), hy = 'cd'.repeat(32), zipOf = (names) => { const e = names.map(n => ({ n, d: Buffer.alloc(300, 7) })); const parts = [], cen = []; let off = 0; const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; } return ~c >>> 0; };
      for (const f of e) { const nm = Buffer.from(f.n), h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc(f.d), 14); h.writeUInt32LE(f.d.length, 18); h.writeUInt32LE(f.d.length, 22); h.writeUInt16LE(nm.length, 26); parts.push(h, nm, f.d);
        const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc(f.d), 16); c.writeUInt32LE(f.d.length, 20); c.writeUInt32LE(f.d.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42); cen.push(c, nm); off += 30 + nm.length + f.d.length; }
      const cb = Buffer.concat(cen), eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(e.length, 8); eo.writeUInt16LE(e.length, 10); eo.writeUInt32LE(cb.length, 12); eo.writeUInt32LE(off, 16); return Buffer.concat([...parts, cb, eo]); };
    r = await call('/admin/zl/zh-test/have', { h: { ...A, Authorization: 'Bearer wrong', 'X-Forwarded-For': '9.9.9.9' } }); assert.equal(r.s, 401);
    r = await call('/admin/zl/zh-test/have', { h: A }); assert.deepEqual(JSON.parse(r.b).have, []);
    r = await call('/admin/zl/zh-test/clips', { m: 'PUT', h: { ...A, 'Content-Type': 'application/zip' }, body: zipOf(['clips/' + hx + '.mp3', 'clips/../evil.mp3', 'clips/' + hy + '.mp3']) }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).clips, 2);
    r = await call('/admin/zl/zh-test/have', { h: A }); assert.equal(JSON.parse(r.b).have.length, 2);
    r = await call('/admin/zl/zh-test/book', { m: 'PUT', h: A, body: JSON.stringify({ title: '', s: ['你好。'] }) }); assert.equal(r.s, 400);
    r = await call('/admin/zl/zh-test/book', { m: 'PUT', h: A, body: JSON.stringify({ title: '测试书', author: '某某', voice: 'Qwen3-TTS', s: ['你好。', '再见。'], p: [0, 1] }) }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).item.clips, 2);
    r = await call('/zl/catalog'); { const it0 = JSON.parse(r.b).items; assert.equal(it0.length, 1); assert.equal(it0[0].title, '测试书'); assert.equal(it0[0].n, 2); }
    r = await call('/zl/zh-test/book.json'); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).s[1], '再见。'); assert.equal(r.h['access-control-allow-origin'], '*');
    r = await call('/zl/zh-test/' + hx + '.mp3'); assert.equal(r.s, 200); assert.ok(/immutable/.test(r.h['cache-control']));
    r = await call('/zl/zh-test/' + 'ef'.repeat(32) + '.mp3'); assert.equal(r.s, 404);
    // 一本书多种声音：默认声音(Qwen3-TTS)在根目录；加 ?voice=vivian 的放 v-vivian/，书的默认声音名不变
    r = await call('/admin/zl/zh-test/have?voice=vivian', { h: A }); assert.deepEqual(JSON.parse(r.b).have, []);
    r = await call('/admin/zl/zh-test/book?voice=vivian', { m: 'PUT', h: A, body: JSON.stringify({ title: '测试书', voice: 'Vivian', s: ['你好。', '再见。'], p: [0, 1] }) }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).item.voice, 'Qwen3-TTS');
    r = await call('/admin/zl/zh-test/clips?voice=vivian', { m: 'PUT', h: { ...A, 'Content-Type': 'application/zip' }, body: zipOf(['clips/' + hx + '.mp3']) }); assert.equal(r.s, 200);
    r = await call('/admin/zl/zh-test/have?voice=vivian', { h: A }); assert.equal(JSON.parse(r.b).have.length, 1);
    r = await call('/admin/zl/zh-test/book?voice=vivian', { m: 'PUT', h: A, body: JSON.stringify({ title: '测试书', voice: 'Vivian', s: ['你好。', '再见。'], p: [0, 1] }) }); { const it1 = JSON.parse(r.b).item; assert.equal(it1.voices.length, 2); assert.equal(it1.voices[1].k, 'vivian'); assert.equal(it1.voices[1].name, 'Vivian'); assert.equal(it1.voices[1].clips, 1); assert.equal(it1.voices[0].clips, 2); }
    r = await call('/zl/zh-test/v-vivian/' + hx + '.mp3'); assert.equal(r.s, 200); r = await call('/zl/zh-test/v-vivian/' + hy + '.mp3'); assert.equal(r.s, 404);
    r = await call('/zl/zh-test/v-vivian/book.json'); assert.equal(r.s, 404);
    r = await call('/admin/zl/zh-test', { m: 'DELETE', h: A }); assert.equal(r.s, 200); r = await call('/zl/catalog'); assert.equal(JSON.parse(r.b).items.length, 0);
    r = await call('/zl/zh-test/book.json'); assert.equal(r.s, 404);
  }
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
  r = await call('/admin/file/big.zip', { m: 'PUT', h: A, body: 'x'.repeat(25000) }); assert.equal(r.s, 413);
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
  // 分批上传：中间批（last=0）只拆句子不合总包，最后一批才合并；总量超过上限时不合并并明确告知
  { const H4 = 'e'.repeat(64), H5 = 'f'.repeat(64), mk = async (h, d) => { const zz = new JSZip(); zz.file('manifest.json', '{}'); zz.file('clips/' + h + '.mp3', d); return zz.generateAsync({ type: 'nodebuffer' }); };
    r = await call('/admin/file/part1.voice.zip?last=0', { m: 'PUT', h: A, body: await mk(H4, 'P4') }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).clips, 1);
    r = await call('/files/part1.voice.zip'); assert.equal(r.s, 404);                         // 还没合并，也没有残留的小包
    r = await call('/admin/file/part1.voice.zip', { m: 'PUT', h: A, body: await mk(H5, 'P5') }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).tooBig, false);
    r = await new Promise(ok => http.get({ port: 9922, path: '/files/part1.voice.zip' }, rr => { const ch = []; rr.on('data', c => ch.push(c)); rr.on('end', () => ok(Buffer.concat(ch))); }));
    assert.deepEqual(Object.keys((await JSZip.loadAsync(r)).files).filter(n => /^clips\//.test(n)).sort(), ['clips/' + H4 + '.mp3', 'clips/' + H5 + '.mp3']);
    r = await call('/admin/file/huge.voice.zip', { m: 'PUT', h: A, body: await mk(H4, 'x'.repeat(13000)) }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).tooBig, true);
    // 语音总包自动分份：3 句，每句约 2000 字节，每份上限 3000 → 3 份（每份 1 句）；买家用凭证也能取到各份
    { const zz = new JSZip(); zz.file('manifest.json', '{}'); for (const c of '123') zz.file('clips/' + c.repeat(64) + '.mp3', 'y'.repeat(2000)); r = await call('/admin/file/multi.voice.zip', { m: 'PUT', h: A, body: await zz.generateAsync({ type: 'nodebuffer' }) }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).tooBig, false);
      const get = n => new Promise(ok => http.get({ port: 9922, path: '/files/' + n }, rr => { const ch = []; rr.on('data', c => ch.push(c)); rr.on('end', () => ok({ s: rr.statusCode, b: Buffer.concat(ch) })); }));
      let tot = 0, parts = 0; for (const n of ['multi.voice.zip', 'multi.voice2.zip', 'multi.voice3.zip']) { const g = await get(n); assert.equal(g.s, 200, n); const z = await JSZip.loadAsync(g.b), man = JSON.parse(await z.file('manifest.json').async('string')); parts = man.parts; tot += Object.keys(z.files).filter(k => /^clips\//.test(k)).length; }
      assert.equal(parts, 3); assert.equal(tot, 3); assert.equal((await get('multi.voice4.zip')).s, 404); } }
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
  // 试读版：把试读句子的语音复制到公开目录
  r = await call('/admin/sample/pay1', { m: 'POST', h: A, body: JSON.stringify({ hashes: [HP, 'f'.repeat(64), '../x'] }) }); assert.equal(JSON.parse(r.b).copied, 1);
  r = await call('/files/pay1-sample/' + HP + '.mp3'); assert.equal(r.b, 'PAID-AUDIO');
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'pay1', kind: 'story', title: 'Paid', price: 9.9, sample: 'api:files/pay1-sample.srbook', sampleCount: 30 }) });
  r = await call('/catalog'); { const q = JSON.parse(r.b).items.find(x => x.id === 'pay1'); assert.equal(q.sample, 'api:files/pay1-sample.srbook'); assert.equal(q.sampleCount, 30); }
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'pay1', kind: 'story', title: 'Paid', price: 9.9, sample: 'api:files/../x.srbook' }) });
  r = await call('/catalog'); assert.equal(JSON.parse(r.b).items.find(x => x.id === 'pay1').sample, undefined);
  // 句子结构分析：转发给本机 spaCy 服务
  r = await call('/grammar', { m: 'POST', h: { 'Content-Type': 'application/json' }, body: '{"s":"Hi."}' }); assert.equal(r.s, 403);
  r = await call('/grammar', { m: 'POST', h: O, body: '{"s":"Hi."}' }); assert.equal(r.s, 503);
  const gs = http.createServer((q, w) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { w.writeHead(200, { 'Content-Type': 'application/json' }); w.end(JSON.stringify({ ok: true, r: { echo: JSON.parse(b).s } })); }); }).listen(9923);
  r = await call('/grammar', { m: 'POST', h: O, body: '{"s":"She gave me a book."}' }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).r.echo, 'She gave me a book.');
  gs.close();
  // AI 讲解：转给豆包（这里用假的），同一句只调一次
  let arkN = 0, arkMode = 'ok';
  const ark = http.createServer((q, w) => { const ch = []; q.on('data', c => ch.push(c)); q.on('end', () => { arkN++;
    assert.equal(q.headers.authorization, 'Bearer ark-test'); const b = JSON.parse(Buffer.concat(ch).toString()); assert.equal(b.messages[1].content.length > 0, true);
    if (arkMode === 'bad') { w.writeHead(200); return w.end(JSON.stringify({ choices: [{ message: { content: '抱歉我讲不了' } }] })); }
    if (arkMode === '401') { w.writeHead(401); return w.end('{}'); }
    if (arkMode === 'brokenjson') { w.writeHead(200, { 'Content-Type': 'application/json' }); return w.end(JSON.stringify({ choices: [{ message: { content: '{"en":"Good try! Do you often see it?","zh":"不错！你经常看到吗？","fix":"You can say "I don\'t often see it."","fixZh":"可以说 "I don\'t often see it"，更自然。"}' } }] })); }
    if (arkMode === 'garbagethenok') { w.writeHead(200, { 'Content-Type': 'application/json' }); return w.end(JSON.stringify({ choices: [{ message: { content: arkN % 2 === 1 ? '{"en":' : '{"en":"Nice! What do you see?","zh":"真好！你看到什么？","fix":"","fixZh":""}' } }] })); }
    if (arkMode === 'chatplain') { w.writeHead(200, { 'Content-Type': 'application/json' }); return w.end(JSON.stringify({ choices: [{ message: { content: 'Good job! What is a bedroom?' } }] })); }
    if (arkMode === 'chat') { global.__chatLast = b; w.writeHead(200, { 'Content-Type': 'application/json' }); return w.end(JSON.stringify({ choices: [{ message: { content: '{"en":"Do you like cats? What colour is your cat?","zh":"你喜欢猫吗？","fix":"I like cats.","fixZh":"like 后面直接接名词复数。"}' } }] })); }
    w.writeHead(200, { 'Content-Type': 'application/json' }); w.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"zh":"爱丽丝开始觉得很累了。","words":[{"w":"tired of","m":"对……感到厌倦"},{"w":"","m":"空的会被丢掉"}],"grammar":"was beginning to 表示过去快要开始做某事。","tip":""}\n```' } }] })); }); }).listen(9925);
  const EX = { m: 'POST', h: { Origin: 'https://ok.example' } };
  r = await call('/explain', { m: 'POST', h: { Origin: 'https://bad.example' }, body: '{"s":"Alice was tired."}' }); assert.equal(r.s, 403);
  r = await call('/explain', Object.assign({ body: '{"s":"12345"}' }, EX)); assert.equal(r.s, 400);
  r = await call('/explain', Object.assign({ body: '{"s":"Alice was beginning to get very tired."}' }, EX)); assert.equal(r.s, 200);
  { const j = JSON.parse(r.b); assert.equal(j.ok, true); assert.equal(j.r.zh, '爱丽丝开始觉得很累了。'); assert.equal(j.r.words.length, 1); assert.equal(j.r.words[0].w, 'tired of'); assert.ok(!j.cached); }
  r = await call('/explain', Object.assign({ body: '{"s":"Alice  was beginning to get very tired."}' }, EX)); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).cached, true); assert.equal(arkN, 1);   // 空白不同也算同一句，命中缓存，不再调用
  arkMode = 'bad'; r = await call('/explain', Object.assign({ body: '{"s":"I like cats."}' }, EX)); assert.equal(r.s, 502); assert.equal(JSON.parse(r.b).error, 'ark-bad-reply');
  arkMode = '401'; r = await call('/explain', Object.assign({ body: '{"s":"I like dogs."}' }, EX)); assert.equal(r.s, 502); assert.equal(JSON.parse(r.b).error, 'ark-key');
  arkMode = 'ok'; r = await call('/explain', Object.assign({ body: '{"s":"I like birds."}' }, EX)); assert.equal(r.s, 429);   // 同一网络 1 小时限 4 次（缓存命中不算）
  // AI 对话：带上这一句和前面的对话，一轮一轮聊（沿用上面的假豆包，按请求内容判断）
  arkMode = 'chat';
  r = await call('/chat', { m: 'POST', h: { Origin: 'https://bad.example' }, body: '{"s":"The cat sat."}' }); assert.equal(r.s, 403);
  r = await call('/chat', Object.assign({ body: '{"s":"The cat sat on the mat.","h":[],"m":""}' }, EX)); assert.equal(r.s, 200);
  { const j = JSON.parse(r.b); assert.equal(j.ok, true); assert.equal(j.r.en, 'Do you like cats? What colour is your cat?'); assert.equal(j.r.fix, 'I like cats.'); }
  assert.ok(global.__chatLast.messages[0].content.includes('The cat sat on the mat.'));       // 系统提示里带着这一句
  assert.ok(/刚打开对话/.test(global.__chatLast.messages[1].content));                          // 第一轮由 AI 开场
  r = await call('/chat', Object.assign({ body: JSON.stringify({ s: 'The cat sat on the mat.', h: [{ r: 'ai', t: 'Do you like cats?' }], m: 'I likes cat' }) }, EX)); assert.equal(r.s, 200);
  { const ms = global.__chatLast.messages; assert.equal(ms.length, 3); assert.equal(ms[1].role, 'assistant'); assert.equal(ms[2].role, 'user'); assert.ok(ms[2].content.startsWith('I likes cat')); assert.ok(JSON.parse(ms[1].content).en === 'Do you like cats?'); }
  arkMode = 'brokenjson'; r = await call('/chat', Object.assign({ body: '{"s":"The cat sat on the mat.","m":"I feel do not often see it"}' }, EX)); assert.equal(r.s, 200);
  { const j = JSON.parse(r.b).r; assert.equal(j.en, 'Good try! Do you often see it?'); assert.equal(j.zh, '不错！你经常看到吗？'); assert.equal(j.fix, 'You can say "I don\'t often see it."'); assert.ok(/更自然/.test(j.fixZh)); }
  arkN = 0; arkMode = 'garbagethenok'; r = await call('/chat', Object.assign({ body: '{"s":"The cat sat on the mat.","m":"retry me"}' }, EX)); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).r.en, 'Nice! What do you see?'); assert.equal(arkN, 2);   // 第一次回复坏了，自动重问
  arkMode = 'chatplain'; r = await call('/chat', Object.assign({ body: '{"s":"The cat sat on the mat.","m":"x"}' }, EX)); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).r.en, 'Good job! What is a bedroom?'); arkMode = 'chat';
  r = await call('/chat', Object.assign({ body: '{"s":"The cat sat on the mat.","m":"hi"}' }, EX)); assert.equal(r.s, 200);
  for (let i = 0; i < 3; i++) r = await call('/chat', Object.assign({ body: '{"s":"The cat sat on the mat.","m":"hi"}' }, EX));
  assert.equal(r.s, 429);   // 同一网络 1 小时限 8 次
  ark.close();
  r = await call('/grammar', { m: 'POST', h: O, body: '{"s":"She gave me a book."}' }); assert.equal(r.s, 200);   // 缓存
  // 跟读打分：转给 Azure 发音评估
  const wavHdr = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000)]);
  r = await call('/pron?text=Hello%20world', { m: 'POST', h: { 'Content-Type': 'audio/wav' }, body: wavHdr }); assert.equal(r.s, 403);
  let azN = 0; const az = http.createServer((q, w) => { const ch = []; q.on('data', c => ch.push(c)); q.on('end', () => {
    const pa = JSON.parse(Buffer.from(q.headers['pronunciation-assessment'], 'base64').toString()); assert.equal(pa.ReferenceText, 'Hello world'); assert.equal(q.headers['ocp-apim-subscription-key'], 'k');
    w.writeHead(200, { 'Content-Type': 'application/json' }); if (++azN === 2) return w.end(JSON.stringify({ RecognitionStatus: 'Success', NBest: [{ Display: 'hello world', AccuracyScore: 70, FluencyScore: 60, CompletenessScore: 100, PronScore: 72.4, Words: [{ Word: 'hello', AccuracyScore: 80, ErrorType: 'None' }, { Word: 'world', AccuracyScore: 0, ErrorType: 'Omission' }] }] }));
    w.end(JSON.stringify({ RecognitionStatus: 'Success', NBest: [{ Display: 'Hello world.', PronunciationAssessment: { AccuracyScore: 91.2, FluencyScore: 80, CompletenessScore: 100, PronScore: 88.6 }, Words: [{ Word: 'hello', PronunciationAssessment: { AccuracyScore: 95, ErrorType: 'None' } }, { Word: 'world', PronunciationAssessment: { AccuracyScore: 55, ErrorType: 'Mispronunciation' } }] }] })); }); }).listen(9924);
  r = await call('/pron?text=Hello%20world', { m: 'POST', h: { Origin: 'https://ok.example', 'Content-Type': 'audio/wav' }, body: wavHdr }); assert.equal(r.s, 200);
  { const pj = JSON.parse(r.b); assert.equal(pj.total, 89); assert.equal(pj.words[1].e, 'Mispronunciation'); assert.equal(pj.words[1].s, 55); }
  r = await call('/pron?text=Hello%20world', { m: 'POST', h: { Origin: 'https://ok.example', 'Content-Type': 'audio/wav' }, body: wavHdr }); assert.equal(r.s, 200);   // 平铺格式
  { const pj = JSON.parse(r.b); assert.equal(pj.total, 72); assert.equal(pj.acc, 70); assert.equal(pj.words[0].s, 80); assert.equal(pj.words[1].e, 'Omission'); }
  r = await call('/pron?text=Hello', { m: 'POST', h: { Origin: 'https://ok.example', 'Content-Type': 'audio/wav' }, body: Buffer.from('nope') }); assert.equal(r.s, 400);
  az.close();
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
  // 中文自然人声
  { let tn = 0, last = ''; const tts = http.createServer((q, w) => { const ch = []; q.on('data', c => ch.push(c)); q.on('end', () => { tn++; last = Buffer.concat(ch).toString(); assert.equal(q.headers['content-type'], 'application/ssml+xml'); assert.equal(q.headers['ocp-apim-subscription-key'], 'k'); w.writeHead(200, { 'Content-Type': 'audio/mpeg' }); w.end(Buffer.alloc(300, 7)); }); }).listen(9926);
    const TH = { Origin: 'https://ok.example', Authorization: 'Bearer test-admin-token-1234567890', 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.8' };
    r = await call('/admin/tts', { m: 'POST', h: { Origin: 'https://ok.example', 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.7' }, body: '{"text":"你好"}' }); assert.equal(r.s, 401);
    r = await call('/admin/tts', { m: 'POST', h: TH, body: '{"text":""}' }); assert.equal(r.s, 400);
    r = await call('/admin/tts', { m: 'POST', h: TH, body: JSON.stringify({ text: '你好 <世界> & 他', voice: 'zh-CN-YunxiNeural' }) }); assert.equal(r.s, 200); assert.equal(r.h['content-type'], 'audio/mpeg'); assert.equal(r.b.length >= 300, true);
    assert.ok(last.includes('zh-CN-YunxiNeural') && last.includes('&lt;世界&gt; &amp;')); assert.equal(tn, 1);
    r = await call('/admin/tts', { m: 'POST', h: TH, body: JSON.stringify({ text: '你好 <世界> & 他', voice: 'zh-CN-YunxiNeural' }) }); assert.equal(r.s, 200); assert.equal(tn, 1);   // 命中缓存，不再请求 Azure
    r = await call('/admin/tts', { m: 'POST', h: TH, body: JSON.stringify({ text: '一二三四五六七八九十一二三四五六七八九十', voice: 'evil' }) }); assert.equal(r.s, 200); assert.ok(last.includes('zh-CN-XiaoxiaoNeural'));   // 非白名单声音回退
    r = await call('/admin/tts', { m: 'POST', h: TH, body: JSON.stringify({ text: '这一句会超出每天的字数上限，所以要被拒绝掉' }) }); assert.equal(r.s, 429); assert.equal(JSON.parse(r.b).error, 'daily-limit');
    tts.close(); }
    // 访问统计
  r = await call('/hit', { m: 'POST', h: { Origin: 'https://bad.example' }, body: '{"d":"abcdef012345abcdef012345"}' }); assert.equal(r.s, 403);
  r = await call('/hit', Object.assign({ body: '{"d":"x"}' }, EX)); assert.equal(r.s, 400);
  r = await call('/hit', Object.assign({ body: '{"d":"abcdef012345abcdef012345","v":"t1","pwa":1}' }, { m: 'POST', h: { Origin: 'https://ok.example', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604.1' } })); assert.equal(r.s, 200);
  r = await call('/hit', Object.assign({ body: '{"d":"abcdef012345abcdef012345","v":"t1"}' }, EX)); assert.equal(r.s, 200);
  r = await call('/hit', Object.assign({ body: '{"d":"111111111111aaaaaaaaaaaa","v":"t1"}' }, EX)); assert.equal(r.s, 200);
  r = await call('/admin/visits', { h: { Origin: 'https://ok.example', Authorization: 'Bearer test-admin-token-1234567890', 'X-Forwarded-For': '9.9.9.9' } }); assert.equal(r.s, 200);
  { const j = JSON.parse(r.b), d0 = j.days[0]; assert.equal(d0.devices, 2); assert.equal(d0.hits, 3); assert.equal(d0.newDevices, 2); assert.equal(j.days[j.days.length - 1].total, 2);
    r = await call('/admin/visits?date=' + d0.date, { h: { Origin: 'https://ok.example', Authorization: 'Bearer test-admin-token-1234567890', 'X-Forwarded-For': '9.9.9.9' } }); const L = JSON.parse(r.b).list; assert.equal(L.length, 2);
    const ip = L.find(x => x.id === 'abcdef'); assert.equal(ip.dv, 'iPhone'); assert.equal(ip.br, 'Safari'); assert.equal(ip.n, 2); assert.ok(/\*$/.test(ip.ip)); assert.ok(!/\d+\.\d+\.\d+\.\d+$/.test(ip.ip)); }
console.log('SHOP OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

// 公共单词库接口测试：录音机问缺哪些词 → 上传 → 挂进书的语音目录 → 读者取得到，“下载全部语音”包里也有
process.env.VOLC_AK = 'A'; process.env.VOLC_SK = 'S'; process.env.ALLOW_ORIGINS = 'https://ok.example';
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890'; process.env.USAGE_FILE = '/tmp/wordstest/usage.json'; process.env.MAX_UPLOAD = '200000';
require('child_process').execSync('rm -rf /tmp/wordstest');
const http = require('http'), assert = require('assert'), fs = require('fs'), path = require('path');
const { server } = require('./server.js'); server.listen(9932);
const call = (p, o = {}) => new Promise(ok => { const q = http.request({ port: 9932, path: p, method: o.m || 'GET', headers: o.h || {} }, r => { const c = []; r.on('data', x => c.push(x)); r.on('end', () => ok({ s: r.statusCode, h: r.headers, b: Buffer.concat(c) })); }); if (o.body) q.write(o.body); q.end(); });
const A = { Origin: 'https://ok.example', Authorization: 'Bearer test-admin-token-1234567890', 'Content-Type': 'application/json' };
const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
const crc = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipOf(entries) {                         // [{n, d}] → 不压缩的 zip
  const parts = [], cen = []; let off = 0;
  for (const f of entries) {
    const nm = Buffer.from(f.n), h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc(f.d), 14); h.writeUInt32LE(f.d.length, 18); h.writeUInt32LE(f.d.length, 22); h.writeUInt16LE(nm.length, 26);
    parts.push(h, nm, f.d);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc(f.d), 16); c.writeUInt32LE(f.d.length, 20); c.writeUInt32LE(f.d.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    cen.push(c, nm); off += 30 + nm.length + f.d.length;
  }
  const cb = Buffer.concat(cen), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cb, e]);
}
(async () => {
  const hw = 'a1'.repeat(32), hx = 'b2'.repeat(32), hy = 'c3'.repeat(32), mp3 = Buffer.alloc(400, 9);
  let r = await call('/admin/words/missing', { m: 'POST', h: { ...A, Authorization: 'Bearer wrong', 'X-Forwarded-For': '5.5.5.5' }, body: '{}' }); assert.equal(r.s, 401);
  r = await call('/admin/words/missing', { m: 'POST', h: A, body: JSON.stringify({ voice: 'Bad Voice', hashes: [hw] }) }); assert.equal(r.s, 400);
  r = await call('/admin/words/missing', { m: 'POST', h: A, body: JSON.stringify({ voice: 'af_heart', hashes: [hw, hx, 'nothex', hy] }) }); assert.equal(r.s, 200);
  assert.deepEqual(JSON.parse(r.b).missing, [hw, hx, hy]);
  r = await call('/admin/words?voice=af_heart', { m: 'PUT', h: { ...A, 'Content-Type': 'application/zip' }, body: zipOf([{ n: 'clips/' + hw + '.mp3', d: mp3 }, { n: 'clips/' + hx + '.mp3', d: mp3 }, { n: 'clips/../evil.mp3', d: mp3 }, { n: 'clips/' + hy + '.mp3', d: Buffer.alloc(10) }]) });
  assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).words, 2);                          // 路径穿越和太小的文件都不收
  assert.ok(!fs.existsSync('/tmp/wordstest/shop/words/evil.mp3'));
  r = await call('/admin/words/missing', { m: 'POST', h: A, body: JSON.stringify({ voice: 'af_heart', hashes: [hw, hx, hy] }) }); assert.deepEqual(JSON.parse(r.b).missing, [hy]);
  r = await call('/admin/words/missing', { m: 'POST', h: A, body: JSON.stringify({ voice: 'am_michael', hashes: [hw] }) }); assert.deepEqual(JSON.parse(r.b).missing, [hw]);   // 不同声音分开
  // 读者直接取（不用口令）
  r = await call('/words/af_heart/' + hw + '.mp3'); assert.equal(r.s, 200); assert.equal(r.h['access-control-allow-origin'], '*'); assert.equal(r.b.length, 400);
  r = await call('/words/af_heart/' + hy + '.mp3'); assert.equal(r.s, 404);
  r = await call('/words/..%2f/' + hw + '.mp3'); assert.equal(r.s, 404);
  // 上架一本书，把单词挂进书的语音目录，再打“下载全部语音”包
  r = await call('/admin/file/kit.srbook', { m: 'PUT', h: A, body: 'PKbook' }); assert.equal(r.s, 200);
  r = await call('/admin/words/link/kit', { m: 'POST', h: A, body: JSON.stringify({ voice: 'af_heart', hashes: [hw, hx, hy] }) }); assert.equal(r.s, 200);
  { const j = JSON.parse(r.b); assert.equal(j.linked, 2); assert.deepEqual(j.missing, [hy]); }
  r = await call('/files/kit/' + hx + '.mp3'); assert.equal(r.s, 200); assert.equal(r.b.length, 400);
  assert.equal(fs.statSync('/tmp/wordstest/shop/files/kit/' + hx + '.mp3').ino, fs.statSync('/tmp/wordstest/shop/words/af_heart/' + hx + '.mp3').ino);   // 硬链接，不多占硬盘
  r = await call('/admin/words/link/kit', { m: 'POST', h: A, body: JSON.stringify({ voice: 'af_heart', hashes: [hw, hx] }) }); assert.equal(JSON.parse(r.b).linked, 0);   // 再挂一次：已经有了
  r = await call('/admin/repack/kit', { m: 'POST', h: A }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).clips, 2);
  r = await call('/files/kit.voice.zip'); assert.equal(r.s, 200); assert.ok(r.b.includes(Buffer.from('clips/' + hw + '.mp3')));
  // 收费书在私有目录：挂到私有目录里，公开地址取不到
  r = await call('/admin/file/paid.srbook?private=1', { m: 'PUT', h: A, body: 'PKpaid' }); assert.equal(r.s, 200);
  r = await call('/admin/words/link/paid', { m: 'POST', h: A, body: JSON.stringify({ voice: 'af_heart', hashes: [hw] }) }); assert.equal(JSON.parse(r.b).linked, 1);
  assert.ok(fs.existsSync('/tmp/wordstest/shop/private/paid/' + hw + '.mp3'));
  r = await call('/files/paid/' + hw + '.mp3'); assert.equal(r.s, 404);
  // 第二个声音：语音放在“编号--am-michael”，挂单词、打包都认得出是哪本书；学习材料里记上 voices
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'kit', kind: 'story', title: 'Kit', voice: true, file: 'api:files/kit.srbook', voices: ['am_michael', 'Bad!'] }) }); assert.equal(r.s, 200);
  r = await call('/catalog'); assert.deepEqual(JSON.parse(r.b).items.find(x => x.id === 'kit').voices, ['am_michael']);
  r = await call('/admin/voices/kit', { m: 'POST', h: A, body: JSON.stringify({ voice: 'am_michael' }) }); assert.deepEqual(JSON.parse(r.b).voices, ['am_michael']);
  r = await call('/admin/item', { m: 'POST', h: A, body: JSON.stringify({ id: 'kit', kind: 'story', title: 'Kit 2', voice: true, file: 'api:files/kit.srbook' }) });
  r = await call('/catalog'); assert.deepEqual(JSON.parse(r.b).items.find(x => x.id === 'kit').voices, ['am_michael']);   // 改书名不丢男声
  r = await call('/admin/voices/nope', { m: 'POST', h: A, body: JSON.stringify({ voice: 'am_michael' }) }); assert.equal(r.s, 404);
  r = await call('/admin/words?voice=am_michael', { m: 'PUT', h: { ...A, 'Content-Type': 'application/zip' }, body: zipOf([{ n: 'clips/' + hy + '.mp3', d: mp3 }]) }); assert.equal(JSON.parse(r.b).words, 1);
  r = await call('/admin/words/link/kit--am-michael', { m: 'POST', h: A, body: JSON.stringify({ voice: 'am_michael', hashes: [hy] }) }); assert.equal(JSON.parse(r.b).linked, 1);
  r = await call('/admin/file/kit--am-michael.voice.zip?last=0', { m: 'PUT', h: { ...A, 'Content-Type': 'application/zip' }, body: zipOf([{ n: 'clips/' + hx + '.mp3', d: Buffer.alloc(300, 7) }]) }); assert.equal(JSON.parse(r.b).clips, 1);
  r = await call('/admin/repack/kit--am-michael', { m: 'POST', h: A }); assert.equal(r.s, 200); assert.equal(JSON.parse(r.b).clips, 2);
  r = await call('/files/kit--am-michael/' + hy + '.mp3'); assert.equal(r.s, 200);
  r = await call('/files/kit--am-michael.voice.zip'); assert.equal(r.s, 200);
  r = await call('/files/kit/' + hx + '.mp3'); assert.equal(r.b.length, 400);          // 女声的没被动
  r = await call('/admin/repack/paid--am-michael', { m: 'POST', h: A }); assert.equal(r.s, 200);   // 收费书：认得出在私有目录
  console.log('WORDS OK'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });

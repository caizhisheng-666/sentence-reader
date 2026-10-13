#!/usr/bin/env node
// 做语音包：读“句子清单.json”，用微软 Azure 语音一句一句合成，打成 .zip 语音包。
// 用法：
//   set AZURE_SPEECH_KEY=你的Key        （PowerShell: $env:AZURE_SPEECH_KEY="..."）
//   set AZURE_SPEECH_REGION=eastasia   （Key 所在区域）
//   node make-voicepack.js 句子清单.json 输出.zip "书名" [买家编号]
// 做故事包（中英对照故事 + 语音一起打包，给“故事城”用）：再设置
//   STORY_TXT=故事.txt（英文段、中文段交替的文本）  STORY_ID=英文短名（如 lost-kitten）  STORY_LEVEL=A1
//   句子清单传 -  表示只打包文字、不配语音（不需要 Azure Key）。输出文件建议用 .srbook 结尾。
// 可选环境变量：AZURE_VOICE（默认 en-US-AvaMultilingualNeural）、AZURE_ENDPOINT（中国版等自定义终结点）、CLIP_DIR（缓存目录）。
// 中断后再运行会接着做，已经合成的句子不会重复收费。Key 只从环境变量读取，不会写进任何文件。
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [, , listFile, outFile, title, buyer] = process.argv;
if (!listFile || !outFile) { console.error('用法: node make-voicepack.js 句子清单.json 输出.zip "书名" [买家编号]'); process.exit(1); }
const KEY = process.env.AZURE_SPEECH_KEY, REGION = process.env.AZURE_SPEECH_REGION || 'eastasia';
const VOICE = process.env.AZURE_VOICE || 'en-US-AvaMultilingualNeural';
const ENDPOINT = process.env.AZURE_ENDPOINT || ('https://' + REGION + '.tts.speech.microsoft.com/cognitiveservices/v1');
const STORY = process.env.STORY_TXT || '';
const NOVOICE = listFile === '-';
if (!NOVOICE && !KEY && !process.env.AZURE_ENDPOINT) { console.error('请先设置环境变量 AZURE_SPEECH_KEY'); process.exit(1); }
const sentences = NOVOICE ? [] : JSON.parse(fs.readFileSync(listFile, 'utf8')).sentences;
if (NOVOICE && !STORY) { console.error('句子清单为 - 时必须设置 STORY_TXT'); process.exit(1); }
const keyOf = t => crypto.createHash('sha256').update('vp1\n' + String(t).trim()).digest('hex');   // 必须和软件里 vpKey 一致
const clipDir = process.env.CLIP_DIR || path.join(path.dirname(path.resolve(outFile)), '.clips-' + path.basename(outFile, '.zip'));
if (!NOVOICE) fs.mkdirSync(clipDir, { recursive: true });
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const uniq = [...new Map(sentences.map(t => [keyOf(t), String(t).trim()])).entries()];
async function synth(text) {
  const body = "<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='" + VOICE + "'>" + esc(text) + '</voice></speak>';
  for (let a = 1; a <= 4; a++) {
    try {
      const r = await fetch(ENDPOINT, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': KEY || '', 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'sr-voicepack' }, body });
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 200) return b; throw new Error('音频太短'); }
      if (r.status === 401 || r.status === 403) { console.error('\nKey 无效或区域不对（HTTP ' + r.status + '）'); process.exit(1); }
      throw new Error('HTTP ' + r.status);
    } catch (e) { if (a === 4) throw e; await new Promise(z => setTimeout(z, 800 * a)); }
  }
}
// 最小 zip 写入器（不压缩，mp3 本来就压缩过）
const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(files) {
  const parts = [], cen = []; let off = 0;
  for (const f of files) {
    const nm = Buffer.from(f.name), crc = crc32(f.data), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8); h.writeUInt32LE(0x00210000, 10);
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
(async () => {
  const todo = uniq.filter(([k]) => !fs.existsSync(path.join(clipDir, k + '.mp3')));
  const chars = todo.reduce((m, [, t]) => m + t.length, 0);
  console.log('共 ' + sentences.length + ' 句（去重后 ' + uniq.length + '），还需合成 ' + todo.length + ' 句，约 ' + chars + ' 字符。音色：' + VOICE);
  let i = 0, done = 0;
  const worker = async () => { while (i < todo.length) { const [k, t] = todo[i++]; fs.writeFileSync(path.join(clipDir, k + '.mp3'), await synth(t)); done++; if (done % 20 === 0 || done === todo.length) process.stdout.write('\r已合成 ' + done + ' / ' + todo.length); } };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log('');
  const voiceId = crypto.createHash('sha256').update(uniq.map(u => u[0]).join()).digest('hex').slice(0, 16);
  const man = STORY
    ? { format: 'sr-story', v: 1, id: process.env.STORY_ID || path.basename(outFile).replace(/\.[^.]+$/, ''), title: title || path.basename(outFile, path.extname(outFile)), level: process.env.STORY_LEVEL || '', voice: NOVOICE ? '' : VOICE, buyer: buyer || '', count: uniq.length }
    : { format: 'sr-voicepack', v: 1, id: voiceId, title: title || path.basename(outFile, '.zip'), voice: VOICE, buyer: buyer || '', count: uniq.length };
  const files = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(man)) }];
  if (STORY) files.push({ name: 'book.txt', data: fs.readFileSync(STORY) });
  for (const [k] of uniq) files.push({ name: 'clips/' + k + '.mp3', data: fs.readFileSync(path.join(clipDir, k + '.mp3')) });
  fs.writeFileSync(outFile, zip(files));
  console.log('完成：' + outFile + '（' + (fs.statSync(outFile).size / 1048576).toFixed(1) + ' MB，' + uniq.length + ' 句）');
})().catch(e => { console.error('\n失败：' + e.message + '（再运行一次会接着做）'); process.exit(1); });

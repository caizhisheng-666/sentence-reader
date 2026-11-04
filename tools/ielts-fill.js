#!/usr/bin/env node
/* 补齐雅思词：把 Word Atlas（词光）缺的雅思词，按词光同样的编写规范，用火山方舟大模型生成词条文字。
 *
 * 在香港服务器上运行（密钥直接读服务器上的 /etc/translate-proxy.env，不经过任何人）：
 *   sudo bash -c 'set -a; . /etc/translate-proxy.env; set +a; nohup node /var/www/sentence-reader/tools/ielts-fill.js > /var/log/ielts-fill.log 2>&1 &'
 *   tail -f /var/log/ielts-fill.log          # 看进度，Ctrl+C 只是退出查看，不会停止生成
 *
 * 输入：tools/ielts-missing.json（[{w, hint}]，词光缺的词 + ECDICT 的中文提示，提示只用来判断哪些义项重要）
 * 输出：ielts/extra/parts/NNNN.json（每批 10 个词，断了重跑会跳过已完成的批次）
 *       ielts/extra/words-extra.json（软件读取的格式，和 ielts/words.json 一样，多一个 x:1 表示“补充词条”）
 * ielts/extra/ 在 .gitignore 里，不进 GitHub，自动更新也不会动它。
 *
 * 编写规范（SYSTEM 提示词）改编自 Word Atlas 的 scripts/atlas/gen_text.py（MIT License, Copyright (c) 2026 Word Atlas contributors），
 * 去掉了插画场景字段，其余要求一致：准确优先、原创、两类例句、不编造词源、内容安全中立。
 */
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'), http = require('http');

const SITE = process.env.SITE_DIR || path.join(__dirname, '..');
const OUT = path.join(SITE, 'ielts', 'extra'), PARTS = path.join(OUT, 'parts');
const KEY = process.env.ARK_API_KEY || '', MODEL = process.env.IELTS_FILL_MODEL || process.env.ARK_MODEL || 'doubao-seed-2-1-lite-260915';
const HOST = process.env.ARK_HOST || 'https://ark.cn-beijing.volces.com';
const BATCH = 10, WORKERS = +process.env.IELTS_FILL_WORKERS || 4;
const TOPICS = ['education', 'work', 'technology', 'science', 'environment', 'health', 'society', 'government', 'economy', 'media', 'arts', 'travel', 'city', 'nature', 'daily', 'emotion', 'thinking', 'sport', 'history'];

const SYSTEM = `You are the lead lexicographer of an open-source English vocabulary atlas for Chinese learners preparing for IELTS (band 5.5-7.5).
Write ORIGINAL content in your own words. The raw notes you receive are only a hint for which senses matter; never copy them.
Accuracy beats creativity: IPA, part of speech, Chinese meanings and grammar must be correct. Prefer standard British IPA for ipa_uk and General American for ipa_us, with slashes.
Return strict JSON only: {"entries":[...]} with one entry per input word, same order, using exactly this shape:
{
 "w": headword exactly as given,
 "uk": "/IPA/", "us": "/IPA/",
 "senses": [{"pos": "n.|v.|adj.|adv.|prep.|conj.|pron.|phr.|num.|int.|det.|aux.", "zh": "简洁中文释义，可用；分隔，≤14字", "en": "learner-friendly English definition, ≤12 words"}],
 "ex": [
   {"en": "Everyday sentence, 7-13 words, natural, vivid, uses the headword exactly or an inflected form", "zh": "自然的中文翻译"},
   {"en": "IELTS-style sentence, 12-22 words, academic/discussion register on an IELTS topic", "zh": "自然的中文翻译"}
 ],
 "col": ["2-4 high-value collocations, each as 'english phrase｜中文'"],
 "tip": "≤36字中文：最有用的一条用法/辨析/记忆提示。不得编造词源；没有可靠词源就讲用法或易混词。",
 "cefr": "A1|A2|B1|B2|C1|C2",
 "topic": one of ${JSON.stringify(TOPICS)},
 "flag": "" or short note if the headword is malformed, offensive, or not a real English word
}
senses: 1-3 senses, most IELTS-useful first.
Sentences must be safe for all ages, culturally neutral, and must not mention real brands or living public figures. Do not reuse the same names across entries; avoid 'Tom' and 'Mary'.`;

function log(m) { console.log(new Date().toISOString().slice(11, 19), m); }

function ark(body) {
  const u = new URL(HOST), mod = u.protocol === 'http:' ? http : https, data = JSON.stringify(body);
  return new Promise((ok, no) => {
    const q = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: '/api/v3/chat/completions', method: 'POST', timeout: 180000,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'Content-Length': Buffer.byteLength(data) } }, r => {
      const ch = []; r.on('data', c => ch.push(c)); r.on('end', () => {
        const t = Buffer.concat(ch).toString('utf8');
        if (r.statusCode !== 200) return no(new Error('HTTP ' + r.statusCode + ' ' + t.slice(0, 200)));
        try { ok(JSON.parse(t).choices[0].message.content); } catch (e) { no(new Error('坏的返回：' + t.slice(0, 200))); }
      });
    });
    q.on('timeout', () => q.destroy(new Error('超时'))); q.on('error', no); q.end(data);
  });
}

function parseEntries(txt) {
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('返回里没有 JSON');
  const j = JSON.parse(txt.slice(a, b + 1));
  if (!Array.isArray(j.entries)) throw new Error('JSON 里没有 entries');
  return j.entries;
}

const LV = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
function clean(e, want) {                              // 检查字段，转成软件用的精简格式
  if (!e || typeof e !== 'object' || e.flag) return null;
  const s = (Array.isArray(e.senses) ? e.senses : []).filter(x => x && x.zh).slice(0, 3).map(x => [String(x.pos || '').trim(), String(x.zh).trim()]);
  const ex = (Array.isArray(e.ex) ? e.ex : []).filter(x => x && x.en && x.zh).slice(0, 2).map(x => [String(x.en).trim(), String(x.zh).trim()]);
  if (!s.length || ex.length < 2) return null;
  const o = { u: String(e.uk || '').trim(), c: LV.includes(e.cefr) ? e.cefr : 'B2', p: TOPICS.includes(e.topic) ? e.topic : 'daily', s, e: ex,
    k: (Array.isArray(e.col) ? e.col : []).filter(x => typeof x === 'string' && x.includes('｜')).slice(0, 4), x: 1 };
  if (e.tip) o.t = String(e.tip).slice(0, 60);
  if (e.us) o.us = String(e.us).trim();
  if (String(e.w || '').trim() && String(e.w).trim() !== want) o.w = String(e.w).trim();
  return o;
}

async function runBatch(i, batch) {
  const f = path.join(PARTS, String(i).padStart(4, '0') + '.json');
  if (fs.existsSync(f)) return 'cached';
  const user = 'Words:\n' + batch.map(g => '- ' + g.w + '  (notes: ' + g.hint + ')').join('\n');
  let last;
  for (let t = 1; t <= 4; t++) {
    try {
      const txt = await ark({ model: MODEL, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], temperature: 0.4, max_tokens: 6000, thinking: { type: 'disabled' } });
      const ents = parseEntries(txt), out = {};
      batch.forEach((g, k) => { const e = ents.find(x => x && String(x.w || '').toLowerCase().trim() === g.w) || ents[k]; const c = clean(e, g.w); if (c) out[g.w] = c; });
      fs.writeFileSync(f + '.tmp', JSON.stringify(out)); fs.renameSync(f + '.tmp', f);
      return Object.keys(out).length + '/' + batch.length;
    } catch (e) { last = e; log('  第 ' + i + ' 批第 ' + t + ' 次失败：' + e.message); await new Promise(r => setTimeout(r, 5000 * t)); }
  }
  throw last;
}

function compile() {
  const all = {};
  for (const f of fs.readdirSync(PARTS).filter(x => /^\d+\.json$/.test(x)).sort()) Object.assign(all, JSON.parse(fs.readFileSync(path.join(PARTS, f), 'utf8')));
  fs.writeFileSync(path.join(OUT, 'words-extra.json.tmp'), JSON.stringify(all));
  fs.renameSync(path.join(OUT, 'words-extra.json.tmp'), path.join(OUT, 'words-extra.json'));
  return Object.keys(all).length;
}

(async () => {
  if (!KEY) { console.error('没有 ARK_API_KEY。请按文件开头的命令，先读入 /etc/translate-proxy.env 再运行。'); process.exit(1); }
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'ielts-missing.json'), 'utf8'));
  fs.mkdirSync(PARTS, { recursive: true });
  const batches = []; for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
  log('共 ' + list.length + ' 个词，' + batches.length + ' 批，模型 ' + MODEL + '，同时跑 ' + WORKERS + ' 批');
  let next = 0, done = 0, fail = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < batches.length) {
      const i = next++;
      try { const r = await runBatch(i, batches[i]); done++; if (r !== 'cached') log('第 ' + (i + 1) + '/' + batches.length + ' 批完成（' + r + ' 个有效）'); }
      catch (e) { fail++; log('第 ' + (i + 1) + ' 批放弃：' + e.message + '（重新运行会再试）'); }
      if (done % 10 === 0) compile();
    }
  }));
  const n = compile();
  log('完成：' + n + ' 个补充词条写进了 ielts/extra/words-extra.json' + (fail ? '；' + fail + ' 批失败，重新运行同一条命令会只补失败的' : ''));
})();

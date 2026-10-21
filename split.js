'use strict';
/* 一句一读的切句、切词规则。手机（index.html）和电脑上的录音机用的是同一个文件：
   录音机按这里切出来的句子和单词录音，手机按同样的规则读书，语音才对得上（语音按句子内容的哈希找）。
   只放纯文字处理，不碰页面和存储。改这里的规则时，已经录好的语音里切法变了的句子要重录。 */
/* ---------- 文本处理 ---------- */
/* ---------- 换行处理：哪些换行是“断句”，哪些只是排版折行 ---------- */
// 古腾堡等 txt 每行只有 70 字左右就硬折行（折行处不是句子边界）；绘本、epub 则是一行/一段一句。
// 规则：①空行前一段没有句末标点 → 是标题/署名，断开；②折行文本里，只有“很短、没标点、下一行大写开头”的行才断开；
//       ③非折行文本里，没标点、下一行大写开头的行都断开。其余换行当空格。
const BRK = '\uE000';
const LINE_END_RE = /[.!?…:;]["'”’)\]]*$/;
function markBreaks(text) {
  text = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (text.indexOf('\n') < 0) return text.replace(/\s+/g, ' ');
  const raw = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim());
  const lens = raw.filter(Boolean).map(l => l.length).sort((a, b) => a - b);
  if (!lens.length) return '';
  const p90 = lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.9))];
  const nearMax = lens.filter(n => n >= p90 * 0.85).length / lens.length;
  const hardWrapped = p90 >= 55 && nearMax >= 0.4;
  const shortLimit = Math.min(45, Math.round(p90 * 0.6));
  const out = []; let pendingBlank = false;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line) { pendingBlank = true; continue; }
    if (out.length) {
      const prev = out[out.length - 1].line;
      const noEnd = !LINE_END_RE.test(prev);
      const nextUpper = /^["'“‘(\[]*[A-Z0-9]/.test(line);
      let brk = false;
      if (pendingBlank) brk = noEnd;
      else if (noEnd && nextUpper) brk = hardWrapped ? prev.length < shortLimit : true;
      out[out.length - 1].brk = brk;
    }
    out.push({ line, brk: false }); pendingBlank = false;
  }
  return out.map((o, i) => o.line + (i < out.length - 1 ? (o.brk ? ' ' + BRK + ' ' : ' ') : '')).join('').replace(/\s+/g, ' ');
}
function splitSentences(text) {
  text = markBreaks(text).trim();
  // 中英对照书：只留英文。①括号里的中文注释整体去掉（如 hammer (锤子)）；②全角标点换成半角（如 ？→?，１８７９→1879）；
  // ③每一段中文都当作分隔符，这样英文段落之间即使没有句末标点，也不会被粘成一整句。
  text = text.replace(/[（(][^()（）A-Za-z]*[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff][^()（）A-Za-z]*[)）]/g, ' ');
  text = text.replace(/[\uff01-\uff5e]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  text = text.replace(/[\uE000\u2160-\u217f\u2460-\u24ff\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g, ' \u2029 ');
  text = text.replace(/[ \t]+/g, ' ').trim();
  text = text.replace(/\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Mt|MR|MRS|MS|DR|ST|JR|SR|PROF|MT)\./g, '$1\u2024');   // 称呼缩写不当句末（含全大写，如书开头的 MR. JONES）
  text = text.replace(/\b(No|NO)\.(?=\s*\d)/g, '$1\u2024');   // No. 5 这种编号才保护；对话里说的 "No." 照常断句
  text = text.replace(/\b((?:[A-Z]\.){2,3})(?=s\b)/g, m => m.replace(/\./g, '\u2024'));   // A.J.s（A.J. 的复数）不拆开
  text = text.replace(/\b((?:[A-Z]\.){1,3}[A-Z])\.(?=\s+[a-z]|\s*[,;:])/g, (m, w) => w.replace(/\./g, '\u2024') + '\u2024');   // A.J. / J.K. 这类缩写后面接小写词或逗号：不当作句末
  text = text.replace(/\b((?:[A-Z]\.){1,3}[A-Z])\.(?=\s+[A-Z])/g, (m, w) => w.replace(/\./g, '\u2024') + '.');   // 缩写后面是大写词：只保护中间的点
  text = text.replace(/([a-z][.!?])(?=[“‘])/g, '$1 '); // 句号后面紧跟着左引号，补个空格才能断句
  text = text.replace(/([a-zA-Z])\.([A-Z])/g, '$1. $2'); // 修复类似 "I.Down"、"CHAPTER II.The" 这种缺空格的粘连
  text = text.replace(/([?!]+["”’])\s+(?=(?:[A-Z][\w'’.\u2024-]*\s+){1,2}(?:said|asked|replied|shouted|yelled|whispered|cried|answered|added|announced|explained|laughed|called|exclaimed|continued|sighed|muttered|screamed|groaned|giggled|snapped|suggested|wondered|demanded|declared|admitted)\b)/g, '$1\u2025');   // 说话人是大写人名："……!" Alexia said proudly.
  text = text.replace(/([?!]+["”’])\s+(?=[a-z])/g, '$1\u2025');   // "……?" asked Michael. —— 问号/感叹号加右引号后面接小写的说话人，仍是同一句
  return text.replace(/([.!?]+["'”’)\]]*)\s+/g, '$1\u2029').split('\u2029')
    .map(s => s.replace(/\u2024/g, '.').replace(/\u2025/g, ' ').trim())
    .filter(s => s.length > 1 && /[A-Za-z]{2}/.test(s) && !/https?:\/\/|www\.|ISBN|©/i.test(s));
}
/* ---------- 中英对照：把材料里自带的中文译文，和对应的英文句子配上对 ---------- */
const ANNOT_RE = /[（(][^()（）A-Za-z]*[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff][^()（）A-Za-z]*[)）]/g;
const ZH_KEEP = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u2160-\\u217f\\u2460-\\u24ff\\uff00-\\uffef';   // 含全角标点：中文译文按原样保留
const ZH_RUN_RE = new RegExp('[' + ZH_KEEP + '“‘](?:[' + ZH_KEEP + '\\s\\d,.;:!?"\'“”‘’()\\-·…—]*[' + ZH_KEEP + '”’])?', 'g');
const IDEO_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 把一页/一节文字切成按顺序排列的“英文段”和“中文段”。英文段里的句子照常切句；中文段先留着，后面配对用。
function parseBlockSegs(text) {
  let t = markBreaks(text).trim();
  t = t.replace(ANNOT_RE, ' ');
  const raw = []; let last = 0, m;
  ZH_RUN_RE.lastIndex = 0;
  while ((m = ZH_RUN_RE.exec(t))) {
    if (!IDEO_RE.test(m[0])) continue;                    // 只有标点，不算中文
    if (m.index > last) raw.push({ lang: 'en', text: t.slice(last, m.index) });
    raw.push({ lang: 'zh', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < t.length) raw.push({ lang: 'en', text: t.slice(last) });
  const segs = [];                                         // 夹在两段中文之间的一小段英文（如人名 Hank）算作中文的一部分
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i], prev = segs[segs.length - 1], nxt = raw[i + 1];
    if (r.lang === 'en' && prev && prev.lang === 'zh' && nxt && nxt.lang === 'zh' && r.text.trim().split(/\s+/).length <= 3 && (!/[.!?]["”’)]*\s*$/.test(r.text) || /^\s*(?:[A-Z]\.){1,4}\s*$/.test(r.text))) { prev.text += r.text + nxt.text; i++; continue; }
    segs.push({ lang: r.lang, text: r.text });
  }
  const sentences = [], out = [];
  for (const sg of segs) {
    if (sg.lang === 'zh') { out.push({ lang: 'zh', text: sg.text }); continue; }
    if (!/[A-Za-z]/.test(sg.text)) continue;
    const ss = splitSentences(sg.text);
    if (ss.length) { out.push({ lang: 'en', n: ss.length }); sentences.push(...ss); }
  }
  return { sentences, segs: out };
}
const ZH_CH = '\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef“”‘’—…';
const ZH_GAP_RE = new RegExp('([' + ZH_CH + '])\\s+(?=[' + ZH_CH + '])', 'g');
const ZH_TAG_RE = /[说道问喊叫答笑嚷吼嘀咕回答宣布补充解释接着]/;
function splitZh(t) {
  // PDF 里取出来的中文，字与字之间常被插入空格（“我 想 啊 想”）：中文之间的空格一律去掉
  const clean = String(t).replace(/\s+/g, ' ').trim().replace(ZH_GAP_RE, '$1');
  const parts = (clean.match(/[^。！？!?]+[。！？!?]*[”’」』）)]*/g) || []).map(x => x.trim()).filter(x => IDEO_RE.test(x));
  // 英文里“台词 + 说话人”是一句（"...," said Alexia.），中文常在引号结束处断开（“……。”亚历克西娅说。）：把这种短短的说话人片段并回上一句
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev && /[。！？!?…][”」』]$/.test(prev) && !/^[“「『‘]/.test(p) && p.replace(/[^\u3400-\u9fff]/g, '').length <= 14 && ZH_TAG_RE.test(p)) out[out.length - 1] = prev + p;
    else out.push(p);
  }
  return out;
}
// 中文的章节标题（如“第一章 陌生人”）后面常常没有句号，会和第一句正文粘在一起：单独拆出来，才能和英文的标题句对上
const ZH_HEAD_RE = /^(第[一二三四五六七八九十百零〇\d]+[章节回幕部篇集](?:\s*[^\s。！？]{1,10}(?=\s))?)\s*/;
function fixZhHeading(zs, firstEn) {
  const m = zs.length ? zs[0].match(ZH_HEAD_RE) : null;
  if (!m) return zs;
  const head = m[1].trim(), rest = zs[0].slice(m[0].length).trim();
  if (!rest) return zs;
  return (TOC_CHAPTER_RE.test(String(firstEn || '').trim()) ? [head, rest] : [rest]).concat(zs.slice(1));   // 英文没有标题句时，中文标题不用
}
// allSegs：全书按顺序排列的语言段（英文段带全书句子序号 idxs）。英文段和紧挨着的中文段配成一对；
// 句数相同就一句对一句；句数不同就把整段译文给这一段的每一句。译文长度和英文差太多的（如版权页）不配。
function alignSegs(allSegs, sentences) {
  const merged = [];
  for (const sg of allSegs) {
    const last = merged[merged.length - 1];
    if (last && last.lang === sg.lang) { if (sg.lang === 'en') last.idxs = last.idxs.concat(sg.idxs); else last.text += ' ' + sg.text; }
    else merged.push(sg.lang === 'en' ? { lang: 'en', idxs: sg.idxs.slice() } : { lang: 'zh', text: sg.text });
  }
  let ez = 0, ze = 0;
  for (let i = 0; i + 1 < merged.length; i++) { if (merged[i].lang === 'en' && merged[i + 1].lang === 'zh') ez++; else if (merged[i].lang === 'zh' && merged[i + 1].lang === 'en') ze++; }
  const enFirst = ez >= ze, zh = {}, para = {};              // 英文在前中文在后，还是中文在前英文在后，看哪种更多
  let exact = 0, paraN = 0;
  for (let i = 0; i + 1 < merged.length; i++) {
    const a = merged[i], b = merged[i + 1];
    const en = enFirst ? (a.lang === 'en' && b.lang === 'zh' ? a : null) : (a.lang === 'zh' && b.lang === 'en' ? b : null);
    const zseg = enFirst ? b : a;
    if (!en) continue;
    const enLetters = en.idxs.reduce((n, gi) => n + letterCount(sentences[gi]), 0);
    const zs = fixZhHeading(splitZh(zseg.text), sentences[en.idxs[0]]), zChars = zs.join('').replace(/[^\u3400-\u9fff]/g, '').length;
    const ratio = zChars / Math.max(1, enLetters);
    if (enLetters < 8 || zChars < 2 || ratio < 0.12 || ratio > 1.3) continue;
    if (zs.length === en.idxs.length) { en.idxs.forEach((gi, k) => { zh[gi] = zs[k]; }); exact += en.idxs.length; }
    else if (zseg.text.length <= 500) { const whole = zs.join(''); en.idxs.forEach(gi => { zh[gi] = whole; para[gi] = 1; }); paraN += en.idxs.length; }
  }
  if (exact + paraN < 3) return { zh: {}, para: {}, exact: 0, paraN: 0 };   // 配上的太少，多半是误配，不要
  return { zh, para, exact, paraN };
}
function stripGutenberg(text) {
  const startRe = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n*]*\*\*\*/i;
  const endRe = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG[^\n*]*\*\*\*/i;
  const sm = text.match(startRe);
  if (sm) text = text.slice(sm.index + sm[0].length);
  const em = text.match(endRe);
  if (em) text = text.slice(0, em.index);
  return text;
}
function fixStoryHeadings(t) {                    // 早期上架的 .md 书里，“第一章 · Chapter One”这种双语标题还是一行，会让后面的译文错位：拆成“英文一行 + 中文一行”
  return String(t).replace(/^[ \t]*([\u3400-\u9fff][\u3400-\u9fff0-9\s]{0,14}?)[ \t]*[·•][ \t]*([A-Z][A-Za-z0-9 ',!?:\-]{1,60}?)[ \t]*(?:[（(]([^()（）A-Za-z]*[\u3400-\u9fff][^()（）A-Za-z]*)[)）])?[ \t]*$/gm, (m, zh, en, zh2) => en.trim() + '\n\n' + zh.trim() + (zh2 ? ' ' + zh2.trim() : ''));
}
/* 上架：清理文件里混进来的网页样式、自动识别书名 / 中文名 / 等级 */
function devClean(raw) {
  let s = String(raw).replace(/\r/g, '').replace(/^﻿/, '');
  const hasHtml = /<(style|script|html|head|body|div|p|h1|br)\b/i.test(s);
  const title = ((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const h1 = ((s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, '\n');
  if (hasHtml) s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // 去掉没有标签包着的 CSS 段落（比如 body { background: … }）
  s = s.split(/\n\s*\n/).filter(p => !(/[{}]/.test(p) && (p.match(/[a-z-]+\s*:\s*[^;{}]+;/gi) || []).length >= 2 && !/[一-鿿]/.test(p))).join('\n\n');
  return { text: s.replace(/\n{3,}/g, '\n\n').trim(), htmlTitle: h1 || title };
}
function devMeta(text, fileName, htmlTitle) {
  const head = [htmlTitle || ''].concat(text.split('\n').map(x => x.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/[*_`]+/g, '').trim()).filter(Boolean).slice(0, 6)).filter(x => x && x.length <= 90);
  let en = '', zh = '';
  for (const l of head) {
    if (!en) { const m = l.match(/《\s*([A-Za-z][^《》]*?)\s*》/) || l.match(/[（(]\s*([A-Za-z][A-Za-z0-9 ,.'’:&!?-]*?)\s*[）)]/); if (m) en = m[1]; }
    if (!en && !/[一-鿿]/.test(l) && /^[A-Za-z0-9 ,.'’:&!?-]{2,60}$/.test(l) && !/[.!?]$/.test(l.replace(/\.\.\.$/, '')) && l.split(/\s+/).length <= 10) en = l;
    if (!en && /[\u4e00-\u9fff]/.test(l)) { const m = l.match(/^([A-Za-z][A-Za-z0-9 ,.'’:&!?-]*[A-Za-z0-9!?])\s*[\u4e00-\u9fff《（(]/) || l.match(/[\u4e00-\u9fff》）)]\s*([A-Za-z][A-Za-z0-9 ,.'’:&!?-]*[A-Za-z0-9!?])$/); if (m && m[1].split(/\s+/).length <= 10) en = m[1]; }
    if (!zh && /[一-鿿]/.test(l)) {
      let z = (l.match(/《([^《》]*[一-鿿][^《》]*)》/) || [])[1] || l.replace(/[（(][^）)]*[）)]/g, '').replace(/[A-Za-z][A-Za-z0-9 ,.'’:&!?-]*/g, '');
      z = z.replace(/(中英|英汉|汉英)?(双语|对照)[^，,。]*$/, '').replace(/^[\s#：:·\-—]+|[\s：:·\-—]+$/g, '').trim();
      if (z && z.length <= 20 && !/[，。！？；：]/.test(z)) zh = z;
    }
  }
  if (!en) en = String(fileName || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/[一-鿿（）()《》]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!zh) { const fz = String(fileName || '').replace(/\.[^.]+$/, '').match(/[\u4e00-\u9fff][\u4e00-\u9fff\s·：]*/); if (fz) zh = fz[0].trim().slice(0, 20); }
  return { en: en.slice(0, 80), zh };
}
function levelOf(sents, lex) {                    // 估等级：主要看用词（每个词有多常见：词频 + 中考/高考/四六级标签），再参考句子长短；lex 是 lexlevel.js 里的词表（没有就按中等算）
  const pick = sents.length > 3000 ? sents.filter((_, i) => i % Math.ceil(sents.length / 3000) === 0) : sents;
  let W = 0, S = 0; const cnt = [0, 0, 0, 0, 0, 0, 0], seen = new Map(), names = new Set();
  for (const s of pick) {
    const ws = String(s).match(/[A-Za-z]+(?:'[A-Za-z]+)?/g); if (!ws || ws.length < 2) continue;
    S++; W += ws.length;
    ws.forEach((w0, k) => {
      if (k > 0 && /^[A-Z][a-z]/.test(w0)) { names.add(w0.toLowerCase()); return; }   // 句中大写开头：多半是人名地名，不算生词
      let w = w0.toLowerCase(); w = w === "can't" ? 'can' : w === "won't" ? 'will' : w.replace(/n't$/, '').replace(/'(s|d|ll|re|ve|m)$/, '');
      const L = lex ? (lex.get(w) || lex.get(w.replace(/(ies)$/, 'y')) || lex.get(w.replace(/(es|s|ed|ing|ly|er|est)$/, '')) || 6) : 3;
      if (!seen.has(w)) seen.set(w, L);
    });
  }
  for (const [w, L] of seen) if (!names.has(w)) cnt[L]++;           // 按“不同的词”算：同一个生词反复出现只算一次
  const tot = cnt.reduce((a, b) => a + b, 0);
  if (!S || !tot) return { label: '', vocab: 0, wps: 0 };
  let vocab = 6, acc = 0; for (let L = 1; L <= 6; L++) { acc += cnt[L]; if (acc / tot >= 0.9) { vocab = L; break; } }   // 认识书里 90% 的不同单词需要到哪一级
  const wps = W / S, syn = wps < 8 ? 1 : wps < 11 ? 2 : wps < 15 ? 3 : wps < 19 ? 4 : wps < 24 ? 5 : 6;
  const lvl = Math.max(1, Math.min(6, Math.round(vocab * 0.7 + syn * 0.3)));
  const label = ['', 'A1 入门', 'A2 初级', 'B1 中级', 'B2 中高级', 'C1 高级', 'C2 精通'][lvl];
  const VOC = ['', '2000', '4000', '8000', '15000', '30000', '30000 以上'];
  return { label, vocab, syn, wps: Math.round(wps * 10) / 10, need: VOC[vocab], hard: Math.round((1 - (cnt[1] + cnt[2] + cnt[3]) / tot) * 1000) / 10 };
}
function devParse(text) {                           // 解析中英对照文本：句子 + 前两句的中文（做试读）
  const pb = parseBlockSegs(text); const allSegs = []; let off = 0;
  for (const sg of pb.segs) { if (sg.lang === 'en') { allSegs.push({ lang: 'en', idxs: Array.from({ length: sg.n }, (_, k) => off + k) }); off += sg.n; } else allSegs.push(sg); }
  const al = /[㐀-鿿]/.test(text) ? alignSegs(allSegs, pb.sentences) : { zh: {} };
  const preview = [1, 2, 3].filter(i => pb.sentences[i] && al.zh[i]).slice(0, 2).map(i => ({ en: pb.sentences[i], zh: al.zh[i] }));
  return { sents: pb.sentences, preview };
}
function devWithWords(sents) {                      // 句子之外再加上书里出现的所有不同单词（小写）：点单词时也是自然语音。一本书几千个词，费用很小
  const seen = new Set(), out = sents.slice();
  for (const t of sents) for (const w of String(t).toLowerCase().replace(/[’‘]/g, "'").match(/[a-z]+(?:'[a-z]+)*/g) || []) if (w.length <= 24 && !seen.has(w)) { seen.add(w); out.push(w); }
  return out;
}

/* ---------- 章节标题、字母数（手机上的目录也用） ---------- */
function letterCount(t) { return ((t || '').match(/[A-Za-z]/g) || []).length; }
const CHAPTER_WORD = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\\d{1,3}|[ivxlcdm]{1,7}';
const TOC_CHAPTER_RE = new RegExp('^(chapter|part|book)\\s+(' + CHAPTER_WORD + ')\\b', 'i');

/* ---------- 学习材料：书的句子和单词（和“学习材料”里下载安装时的切法完全一样） ---------- */
function storySentences(text) {                     // 材料包 book.txt → 手机上看到的句子（installStory → importBook 的同一套步骤）
  let t = fixStoryHeadings(text);
  if (/project gutenberg/i.test(t.slice(0, 3000))) t = stripGutenberg(t);
  return parseBlockSegs(t).sentences.slice(0, 50000);
}
function storyWords(sents) { return devWithWords(sents).slice(sents.length); }   // 书里所有不同的单词（小写）

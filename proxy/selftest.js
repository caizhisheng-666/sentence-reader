// 诊断：用服务器上的密钥，对火山 TranslateText 试几种签名变体，只打印结果代码，不打印密钥。
// 运行: sudo bash -c 'set -a; . /etc/translate-proxy.env; node selftest.js'
const https = require('https'), crypto = require('crypto');
const AK = process.env.VOLC_AK || '', SK0 = process.env.VOLC_SK || '';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
function call(label, { sk, ct, region = 'cn-north-1', service = 'translate' }) {
  return new Promise(resolve => {
    const body = JSON.stringify({ TargetLanguage: 'zh', SourceLanguage: 'en', TextList: ['Miss Daisy is crazy!'] });
    const xDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), short = xDate.slice(0, 8);
    const h = { 'content-type': ct, host: 'translate.volcengineapi.com', 'x-content-sha256': sha(body), 'x-date': xDate };
    const names = Object.keys(h).sort();
    const cr = ['POST', '/', 'Action=TranslateText&Version=2020-06-01', names.map(n => n + ':' + h[n]).join('\n') + '\n', names.join(';'), sha(body)].join('\n');
    const scope = [short, region, service, 'request'].join('/');
    const sts = ['HMAC-SHA256', xDate, scope, sha(cr)].join('\n');
    const key = hmac(hmac(hmac(hmac(sk, short), region), service), 'request');
    h.authorization = `HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(key, sts).toString('hex')}`;
    const req = https.request({ hostname: 'translate.volcengineapi.com', path: '/?Action=TranslateText&Version=2020-06-01', method: 'POST', headers: h, timeout: 8000 }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => {
        let j = {}; try { j = JSON.parse(b); } catch (e) {}
        const m = j.ResponseMetaData || j.ResponseMetadata || {};
        const t = j.TranslationList && j.TranslationList[0] && j.TranslationList[0].Translation;
        console.log(label.padEnd(34), 'HTTP', res.statusCode, t ? '成功: ' + t : (m.Error ? m.Error.Code + ' / ' + (m.Error.Message || '').replace(AK, '***').slice(0, 120) : b.slice(0, 100)));
        resolve();
      });
    });
    req.on('error', e => { console.log(label, '网络错误', e.message); resolve(); }); req.end(body);
  });
}
(async () => {
  console.log('AK长度', AK.length, 'SK长度', SK0.length, 'SK结尾是否==', /=$/.test(SK0));
  let dec = null; try { dec = Buffer.from(SK0, 'base64'); } catch (e) {}
  await call('1 原始SK + json', { sk: SK0, ct: 'application/json' });
  await call('2 原始SK + json;charset', { sk: SK0, ct: 'application/json; charset=utf-8' });
  if (dec) await call('3 SK先base64解码 + json', { sk: dec, ct: 'application/json' });
  await call('4 原始SK + region cn-beijing', { sk: SK0, ct: 'application/json', region: 'cn-beijing' });
})();

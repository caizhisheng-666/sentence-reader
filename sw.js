const CACHE_NAME = 'sentence-reader-v112';
const PRECACHE = [
  './', './index.html', './dict-basic.js', './grammar.js', './manifest.json', './icon-192.png', './icon-512.png',
  './lib/jszip.min.js', './lib/pdf.min.js', './lib/pdf.worker.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache =>
    Promise.all(PRECACHE.map(u => cache.add(u).catch(() => {})))
  ));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 词典文件：体积大，只走网络（已经导入浏览器数据库了，不需要再缓存一份）
  if (url.pathname.endsWith('.gz') || url.pathname.endsWith('/dict.tsv')) return;

  // 翻译接口：只走网络，不缓存
  if (url.hostname.includes('mymemory.translated.net') || url.hostname.includes('translate.googleapis.com')) return;

  // 故事城的目录和故事文件：要最新的，不经过缓存
  if (url.origin === self.location.origin && url.pathname.includes('/stories/')) return;

  // 本站文件：缓存优先，马上打开；同时在后台下载最新版存起来，下次打开就是新版（网慢时也不用干等）
  if (url.origin === self.location.origin) {
    event.respondWith(caches.open(CACHE_NAME).then(async cache => {
      const cached = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      const net = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; });
      event.waitUntil(net.then(() => {}, () => {}));
      if (cached) return cached;
      return net.catch(() => caches.match('./index.html'));
    }));
    return;
  }

  // 其他网站（如故事城目录、故事文件、翻译接口）：不经过缓存，每次都取最新的
  if (url.hostname !== 'cdnjs.cloudflare.com') return;

  // CDN 组件（只在本站组件加载失败时才会用到）：缓存优先
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(req, copy));
      return res;
    }))
  );
});

// 喵喵听书：只缓存自己的页面，保证离线也能打开书架和读已导入的书
const CACHE_NAME = 'zhreader-v3';
const FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', '../lib/jszip.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('zhreader-') && k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !u.pathname.includes('/zhreader/') && !u.pathname.endsWith('/lib/jszip.min.js')) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

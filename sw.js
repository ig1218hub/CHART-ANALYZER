/* Q-Terminal 서비스워커: 같은 사이트 파일만 '네트워크 우선'으로 받고, 오프라인일 때만 저장본을 씁니다. (시세·API는 건드리지 않음) */
const V = 'qt-shell-v2';
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(['./', 'index.html', 'config.js', 'icon.svg']).catch(() => {}))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.endsWith('admin.html')) return;
  e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; }).catch(() => caches.match(r).then(m => m || caches.match('index.html'))));
});

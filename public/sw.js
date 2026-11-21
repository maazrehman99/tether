// Keeps the app on the phone so it opens with no signal.
// Online: always ask the PC first (a tiny "not changed" check when nothing changed), so updates show at once.
// Offline or slow (over 2.5 s): use the saved copy.
const CACHE = 'tether-v4';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/md.js', '/theme.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon.svg', '/apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname === '/ws' || url.pathname.startsWith('/api/')) return;
  const key = url.pathname === '/' ? '/index.html' : url.pathname;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(key);
    const net = fetch(e.request, { cache: 'no-cache' }).then((r) => { if (r.ok) c.put(key, r.clone()); return r; });
    if (!hit) return net;
    const slow = new Promise((res) => setTimeout(() => res(hit), 2500));
    return Promise.race([net.catch(() => hit), slow]);
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('/'))));
});
// Push: a message from your computer while the app is closed (Claude needs approval, or finished).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Tether', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Tether', {
    body: d.body || '', tag: d.tag || 'tether', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [80, 40, 80],
  }));
});

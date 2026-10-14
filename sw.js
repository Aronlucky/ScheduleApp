// Фоновый помощник планера:
//  • хранит копию сайта, чтобы планер открывался без интернета (сначала сеть, при неудаче — копия);
//  • показывает напоминания по push-сигналу облака, даже когда планер закрыт.
// Запросы к облаку синхронизации (другой адрес) он не трогает.

const CACHE = 'planner-v1';
const SHELL = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const page = req.mode === 'navigate';
  const key = page ? './' : url.pathname;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);   // плохая сеть — не ждём, отдаём копию
      const res = await fetch(req, { signal: ctrl.signal, cache: 'no-cache' });
      clearTimeout(timer);
      if (res.ok) {
        // Safari не принимает «перенаправленные» ответы для страниц, поэтому кладём чистую копию
        const copy = res.redirected ? new Response(await res.clone().blob(), { headers: res.headers }) : res.clone();
        await cache.put(key, copy);
      }
      return res;
    } catch {
      const hit = await cache.match(key, { ignoreSearch: true });
      return hit || Response.error();
    }
  })());
});

// ---------- напоминания ----------
// Страница кладёт в IndexedDB список ближайших напоминаний: { tag, at, title, body }.
function readReminders() {
  return new Promise(resolve => {
    const open = indexedDB.open('planner', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve([]);
    open.onsuccess = () => {
      try {
        const get = open.result.transaction('kv').objectStore('kv').get('reminders');
        get.onsuccess = () => resolve(Array.isArray(get.result) ? get.result : []);
        get.onerror = () => resolve([]);
      } catch { resolve([]); }
    };
  });
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    const now = Date.now();
    const due = (await readReminders()).filter(r => r.at <= now + 90e3 && r.at > now - 15 * 60e3);
    // браузеры требуют показать уведомление на каждый push; одинаковый tag заменяет, а не дублирует
    if (!due.length) {
      return self.registration.showNotification('Планер', { body: 'Пора проверить дела', tag: 'planner-generic', icon: 'icon-192.png' });
    }
    for (const r of due) {
      await self.registration.showNotification(String(r.title).slice(0, 200), {
        body: String(r.body || '').slice(0, 300), tag: String(r.tag), icon: 'icon-192.png', badge: 'icon-192.png'
      });
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return self.clients.openWindow('./');
  })());
});

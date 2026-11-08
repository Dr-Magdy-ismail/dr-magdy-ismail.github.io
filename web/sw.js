const CACHE = "drmagdy-v2";
const FILES = ["./", "./index.html", "./faq.js", "./manifest.json", "./icon-192.png", "./icon-512.png", "./doctor.jpg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// النت الأول، ولو مفيش نت نرجع للنسخة المحفوظة.
// (طلبات قراءة الروشتة والبوت POST فمش بتتحفظ.)
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request))
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(list => {
    if (list.length) return list[0].focus();
    return self.clients.openWindow("./index.html");
  }));
});

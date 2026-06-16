const CACHE_NAME = "quant-review-v2";
const urlsToCache = [
  ".",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "https://cdn.jsdelivr.net/npm/dexie@3.2.4/dist/dexie.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

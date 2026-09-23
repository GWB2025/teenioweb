// GitHub Pages projects share an origin. Only manage caches for this app's scope.
const CACHE_PREFIX = `teenio-web:${self.registration.scope}:`;
const CACHE = `${CACHE_PREFIX}v0.6.0`;
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=0.6.0",
  "./app.js?v=0.6.0",
  "./protocol.js",
  "./calculator.js",
  "./program-table.js",
  "./stored-programs.js?v=0.5.0",
  "./storage-writing.js?v=0.5.0",
  "./memory-cards.js?v=0.6.0",
  "./program-upload.js?v=0.6.0",
  "./serial.js?v=0.5.1",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    void caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(response => response || caches.match("./index.html"))));
});

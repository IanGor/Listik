// Offline support for the built app (registered in production only, src/index.tsx).
// The page is network-first, so a new build arrives on the next load; hashed
// build files are cache-first, since a hash never changes its content.
// Bump CACHE when this file's strategy changes.
// v2: only the app's own page is kept for offline (v1 kept any answer, an
// error page or a Wi-Fi login page too, and then started offline with it).
const CACHE = 'listik-v2';
const SHELL = ['./', './manifest.webmanifest', './favicon.svg', './icons/icon.svg', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && !response.redirected && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put('./', copy));
          }
          return response;
        })
        .catch(() => caches.match('./')),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) =>
      hit ?? fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }),
    ),
  );
});

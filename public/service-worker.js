const CACHE_NAME = "relevo-shell-v6";
const SHELL_ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Cache-first for the app shell, network-only for the /api/search calls
// (search results should always be fresh — the app itself caches the last
// result set in localStorage for offline viewing, see app.js).
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only cache plain http/https GET requests. Browser extensions inject
  // requests with schemes like chrome-extension:// that Cache.put() rejects,
  // and non-GET requests can't be cached at all.
  if (
    event.request.method !== "GET" ||
    !url.protocol.startsWith("http") ||
    url.pathname.startsWith("/api/")
  ) {
    return; // let it hit the network / worker directly, untouched by the cache
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
      );
    })
  );
});

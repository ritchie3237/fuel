// Today's Fuel — offline service worker.
// Bump CACHE when you change app files so phones pull the update.
const CACHE = "fuel-v11";
const ASSETS = [
  "./index.html",
  "./smoothie-experiment.html",
  "./garmin.html",
  "./garmin-data.json",
  "./garmin.webmanifest",
  "./hicon-192.png",
  "./hicon-512.png",
  "./hicon-180.png",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the page/app code (so updates show immediately when online),
// falling back to cache when offline/bricked. Other assets stay cache-first.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const req = e.request;
  const isAppCode =
    req.mode === "navigate" ||
    /\.(html|js|webmanifest|json)$/.test(new URL(req.url).pathname);

  if (isAppCode) {
    // Try the network first; cache the fresh copy; if offline, serve the cache.
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true }))
        )
    );
    return;
  }

  // Images / icons: cache-first (they rarely change), update in background.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            cache.put(req, res.clone());
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

const CACHE_NAME = "haiha-usd-watch-v5";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./favicon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(APP_SHELL.map((url) => cache.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

function isLiveDataRequest(url) {
  return url.includes("/api/") || url.includes("hhmt.com.au") || url.includes("app.hhmt.com.au");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Financial/live data: network only. Never present cached API data as live.
  if (isLiveDataRequest(req.url)) {
    event.respondWith(fetch(req, { cache: "no-store" }));
    return;
  }

  // Navigation: prefer fresh HTML, fall back to cached app shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", clone));
          }
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Same-origin static assets: cache first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
      )
    );
    return;
  }

  // External static resources (fonts / Chart.js): network first, then runtime cache.
  // They are intentionally not part of cache.addAll(), so a third-party outage
  // cannot make service-worker installation fail.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

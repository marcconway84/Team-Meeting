// Offline cache for the installed app.
//
// The page is one self-contained file, so there is very little to keep: the page
// itself, the icons and the manifest. Everything the game needs to be played is
// inside the page already.
//
// The cache name carries a hash of the built page, stamped in by scripts/build.py.
// Without that an installed copy would go on serving yesterday's round for ever.
const CACHE = "redletter-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg",
               "./icon-192.png", "./icon-512.png", "./icon-180.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // The game server is never cached: a leaderboard served from yesterday would be
  // worse than no leaderboard, and a shared clock read from a cache is not a clock.
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  // Network first, so a published change is picked up as soon as there is a
  // connection, falling back to the cache when there is not.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("./index.html")))
  );
});

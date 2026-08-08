const CACHE_NAME = "energiaterkep-pwa-v1";
const SCOPE_ROOT_URL = new URL("./", self.registration.scope);
const SCOPE_ROOT = SCOPE_ROOT_URL.toString();
const OFFLINE_DATA_URL = new URL("data/energy-latest.json", SCOPE_ROOT_URL).toString();
const ESSENTIAL_ASSETS = [
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
  "icons/favicon-16.png",
  "data/energy-latest.json",
].map((path) => new URL(path, SCOPE_ROOT_URL).toString());

function isCacheable(response) {
  return response.ok && (response.type === "basic" || response.type === "default");
}

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const rootRequest = new Request(SCOPE_ROOT, { cache: "reload" });
  const rootResponse = await fetch(rootRequest);
  if (!isCacheable(rootResponse)) throw new Error("The app shell is unavailable");

  await cache.put(SCOPE_ROOT, rootResponse.clone());
  const html = await rootResponse.text();
  const referencedAssets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1], SCOPE_ROOT_URL))
    .filter((url) => url.origin === SCOPE_ROOT_URL.origin && !url.pathname.includes("/api/"));

  await cache.addAll([...new Set([...ESSENTIAL_ASSETS, ...referencedAssets].map(String))]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, fallbackKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(fallbackKey, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(fallbackKey);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirstWithRefresh(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const refresh = async () => {
    const response = await fetch(request);
    if (isCacheable(response)) await cache.put(request, response.clone());
    return response;
  };

  if (cached) {
    refresh().catch(() => null);
    return cached;
  }
  return refresh();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== SCOPE_ROOT_URL.origin) return;

  // Live API responses must never be hidden behind a service-worker cache.
  if (url.pathname.includes("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SCOPE_ROOT));
    return;
  }

  if (url.pathname.endsWith("/data/energy-latest.json")) {
    event.respondWith(networkFirst(request, OFFLINE_DATA_URL));
    return;
  }

  event.respondWith(cacheFirstWithRefresh(request));
});

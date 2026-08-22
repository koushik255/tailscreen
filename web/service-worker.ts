/// <reference lib="webworker" />

const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const CACHE = "tailscreen-shell-v12";
const SHELL = ["/", "/styles.css?v=12", "/app.js?v=12", "/icon.svg", "/apple-touch-icon.png", "/manifest.webmanifest"];

worker.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  void worker.skipWaiting();
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  void worker.clients.claim();
});

worker.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      void caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    } catch {
      const cached = await caches.match(event.request) ?? await caches.match("/");
      if (!cached) throw new Error("Page is unavailable offline");
      return cached;
    }
  })());
});

/*
 * Service worker, deliberately almost empty.
 *
 * It exists so the app is installable (Chrome wants a registered worker with a fetch
 * handler) and so a lost connection produces a page instead of the browser's dinosaur.
 * It does NOT cache application responses, and that is a decision, not an omission:
 *
 *  - Every page here is authenticated and RLS-scoped. A cached response is one worker's
 *    data sitting in a shared cache, served later to whoever opens the app on that phone.
 *  - The numbers are the product. A dashboard that shows yesterday's "18 aguardando" from
 *    a cache is worse than a dashboard that refuses to load: the manager acts on it.
 *  - Deliveries and confirmations are writes against Postgres RPCs. There is no useful
 *    offline story for them short of a real outbox, which is not what this is.
 *
 * So: navigations go to the network, and only fail over to a static offline page. Static
 * assets under /icons are the only thing precached.
 */

const CACHE = "selo-shell-v3";
const OFFLINE_URL = "/offline.html";
// The worker's link gets its own offline page. Landing on "sem ligação" after scanning a
// QR at the almoxarifado reads as "the system is broken"; what is actually true is that
// the link keeps working for days and can be opened later. Different audience, different
// message -- the manager's generic page would be wrong here.
const OFFLINE_CONFIRMATION_URL = "/offline-confirmacao.html";
const PRECACHE = [OFFLINE_URL, OFFLINE_CONFIRMATION_URL, "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  // The precached icons, cache-first. Without this the offline pages render a broken image:
  // they are served from cache, but their <img> is a separate request that still went to a
  // network that is not there. Static, non-sensitive, and already in PRECACHE.
  if (new URL(request.url).pathname.startsWith("/icons/")) {
    event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
    return;
  }

  // Beyond that, only top-level navigations are handled. Everything else -- data, Server
  // Action POSTs, scripts -- goes straight to the network with no interference.
  if (request.mode !== "navigate") return;

  // The worker flow lives under /e/ -- both /e/<token> and the token-less /e/s/<id>.
  const isWorkerLink = new URL(request.url).pathname.startsWith("/e/");

  event.respondWith(
    fetch(request).catch(async () => {
      const cache = await caches.open(CACHE);
      const fallback = await cache.match(isWorkerLink ? OFFLINE_CONFIRMATION_URL : OFFLINE_URL);
      // Served as the response to the original navigation, not as a redirect, so the
      // address bar keeps the /e/<token> URL and the page's own "tentar de novo" retries
      // that exact link.
      return fallback ?? Response.error();
    }),
  );
});

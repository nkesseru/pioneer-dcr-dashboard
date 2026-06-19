/* Pioneer DCR Hub — Phase 31 prototype: Service Worker V2 (DRAFT).
 *
 * STATUS: DRAFT. NOT registered by any page. Production sw.js is unchanged.
 * The filename includes ".draft" so a stray <script> or navigator call
 * can't accidentally activate it.
 *
 * What changes vs V1 (current sw.js, passthrough-only):
 *
 *   1. Shell precache — install-time cache of the static app shell so the
 *      DCR form opens offline. Versioned cache name so deploys bust
 *      predictably and old caches get reaped on activate.
 *
 *   2. Cache-first for the shell, network-first with cache fallback for
 *      everything else. NO caching of:
 *        - Firestore REST calls       (auth-tied, must be fresh)
 *        - Firebase Storage uploads   (one-shot, must hit the network)
 *        - Cloud Function endpoints   (idempotency handled server-side)
 *        - Authenticated HTML        (login.html, admin.html, ceo.html)
 *
 *   3. Background Sync — listens for the `dcr-submit-queue` sync tag and
 *      pings any open page via postMessage so the page's queue-worker
 *      runs processQueue(). We do NOT call processQueue inside the SW
 *      directly — it needs an ID token and Firebase Auth state that only
 *      live in the page context.
 *
 *   4. skipWaiting + claim — same as V1 so deploys pick up on next nav.
 *      Pages listen for "controllerchange" and prompt a refresh banner
 *      for the user instead of forcing a reload (avoid mid-DCR loss).
 *
 * iOS Safari < 16.4 fallback:
 *   Background Sync is not supported. The page should listen for `online`
 *   events itself and run processQueue() directly. The SW will still serve
 *   the shell from cache so the form opens offline.
 *
 * Roll-back path:
 *   `firebase deploy --only hosting` with the old sw.js. Active V2 caches
 *   self-delete on activate when SHELL_CACHE_VERSION changes.
 */

const SW_VERSION         = "20260618-phase31-draft-v1";
const SHELL_CACHE_PREFIX = "pioneer-shell-";
const SHELL_CACHE        = SHELL_CACHE_PREFIX + SW_VERSION;

const SHELL_ASSETS = [
  "/",
  "/work.html",
  "/index.html",
  "/app.js?v=20260618-upload-watchdog",
  "/staff-auth.js",
  "/firebase-config.js",
  "/submit-dcr-v1.js",
  "/dcr-form-config.js",
  "/styles.css",
  "/queue/queue-db.js",
  "/queue/queue-worker.js",
  "/queue/draft-migration.js"
];

// ---------- helpers ----------

function isNeverCacheUrl(url) {
  const u = new URL(url, self.location.origin);
  // Never cache cross-origin Google/Firebase backends.
  if (u.hostname.endsWith(".googleapis.com"))      return true;
  if (u.hostname.endsWith(".cloudfunctions.net"))  return true;
  if (u.hostname.endsWith(".run.app"))             return true;
  if (u.hostname.endsWith(".firebaseio.com"))      return true;
  if (u.hostname.endsWith(".firebasestorage.app")) return true;
  if (u.hostname.endsWith(".appspot.com"))         return true;
  // Same-origin auth-sensitive HTML.
  if (u.origin === self.location.origin) {
    if (u.pathname === "/login.html"  || u.pathname === "/login")  return true;
    if (u.pathname === "/admin.html"  || u.pathname === "/admin")  return true;
    if (u.pathname === "/ceo.html"    || u.pathname === "/ceo")    return true;
    if (u.pathname === "/manager.html"|| u.pathname === "/manager") return true;
  }
  return false;
}

function isShellAsset(url) {
  const u = new URL(url, self.location.origin);
  if (u.origin !== self.location.origin) return false;
  // Strip cache-bust query so cached entries match new requests.
  const bare = u.pathname;
  return SHELL_ASSETS.some(function (asset) {
    const aBare = asset.split("?")[0];
    return bare === aBare;
  });
}

// ---------- install ----------

self.addEventListener("install", function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(SHELL_CACHE);
    // Cache the bare paths (without ?v=) — fetch handler strips the
    // query when matching so a new cache-bust still hits the cache.
    await cache.addAll(SHELL_ASSETS.map(function (a) { return a.split("?")[0]; }));
    await self.skipWaiting();
  })());
});

// ---------- activate ----------

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    // Reap any old shell caches from prior deploys.
    const keys = await caches.keys();
    await Promise.all(keys.map(function (key) {
      if (key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE) {
        return caches.delete(key);
      }
      return null;
    }));
    await self.clients.claim();
  })());
});

// ---------- fetch ----------

self.addEventListener("fetch", function (event) {
  const req = event.request;

  // Never intercept POST/PUT/DELETE (uploads, function calls).
  if (req.method !== "GET") return;
  if (isNeverCacheUrl(req.url)) return;

  if (isShellAsset(req.url)) {
    // Cache-first for the shell — instant offline opens.
    event.respondWith((async function () {
      const cache  = await caches.open(SHELL_CACHE);
      const cached = await cache.match(stripQuery(req.url));
      if (cached) {
        // Background refresh — if online, fetch a fresh copy for next nav.
        // Failure is silent; the cached copy is good enough.
        fetch(req).then(function (res) {
          if (res && res.ok) cache.put(stripQuery(req.url), res.clone());
        }).catch(function () {});
        return cached;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(stripQuery(req.url), res.clone());
        return res;
      } catch (err) {
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }
    })());
    return;
  }

  // Default: passthrough. We deliberately do NOT cache arbitrary
  // same-origin GETs (e.g. /tech.html state-dependent reads) to avoid
  // stale-content bugs.
});

function stripQuery(urlStr) {
  const u = new URL(urlStr, self.location.origin);
  u.search = "";
  return u.pathname;
}

// ---------- background sync ----------

self.addEventListener("sync", function (event) {
  if (event.tag !== "dcr-submit-queue") return;
  event.waitUntil((async function () {
    // We can't process the queue here (no Firebase Auth in SW context),
    // so we ping every open client to drain the queue from the page.
    const clientList = await self.clients.matchAll({ includeUncontrolled: true });
    if (!clientList.length) {
      // No open tab — leave the queue as-is. When the user next opens the
      // app, the page-side `online` listener will call processQueue.
      return;
    }
    clientList.forEach(function (client) {
      try {
        client.postMessage({
          type:    "PIONEER_DRAIN_QUEUE",
          source:  "sw-sync",
          sw_ver:  SW_VERSION
        });
      } catch (_e) {}
    });
  })());
});

// ---------- messages ----------

self.addEventListener("message", function (event) {
  if (!event || !event.data) return;
  if (event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (event.data.type === "PING") {
    try { event.source && event.source.postMessage({ type: "PONG", sw_ver: SW_VERSION }); } catch (_e) {}
  }
});

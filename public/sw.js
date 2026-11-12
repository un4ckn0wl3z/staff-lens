// StaffLens service worker: offline after the first visit, and cross-origin isolation.
// Navigations: network first, cached page as fallback. Other same-origin GETs: cache first, then network.
// Every same-origin response gets COOP/COEP/CORP headers so the page is cross-origin isolated
// (GitHub Pages cannot set headers); that enables multi-threaded WASM for note recognition.
const CACHE = 'stafflens-v2';
const scope = self.registration.scope;
const CORE = ['', 'index.html', 'manifest.webmanifest', 'icon.svg', 'samples/aura-lee.musicxml', 'samples/chord-study.musicxml', 'soundfont/sonivox.sf2'].map((p) => new URL(p, scope).href);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => undefined))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isolate(res) {
  if (!res || res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(scope)) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return isolate(res);
        })
        .catch(() => caches.match(req).then((r) => isolate(r) || caches.match(new URL('index.html', scope).href).then(isolate))),
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return isolate(hit);
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return isolate(res);
      });
    }),
  );
});

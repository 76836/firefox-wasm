/*! COI + cache-first for heavy Firefox WASM assets (single SW). */
const ASSET_CACHE = 'ffwasm-assets-v2';
const HEAVY = /gecko\.wasm|chrome-assets|logo\.webp/;

let coepCredentialless = false;

if (typeof window === 'undefined') {
  self.addEventListener('install', (e) => {
    e.waitUntil((async () => {
      try {
        const c = await caches.open(ASSET_CACHE);
        for (const u of ['./gecko.wasm.zst', './chrome-assets.tar.zst', './chrome-assets.json', './logo.webp']) {
          try {
            const r = await fetch(u, { cache: 'reload' });
            if (r.ok) await c.put(u, r.clone());
          } catch (_) {}
        }
      } catch (_) {}
      self.skipWaiting();
    })());
  });

  self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('ffwasm-assets-') && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })());
  });

  self.addEventListener('message', (ev) => {
    if (!ev.data) return;
    if (ev.data.type === 'coepCredentialless') coepCredentialless = !!ev.data.value;
    if (ev.data === 'clear-asset-cache' || ev.data?.type === 'clear-asset-cache') {
      caches.delete(ASSET_CACHE).then(() => {
        ev.source?.postMessage({ type: 'asset-cache-cleared' });
      });
    }
  });

  self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

    const url = new URL(req.url);
    const sameOrigin = url.origin === self.location.origin;
    const heavy = sameOrigin && req.method === 'GET' && HEAVY.test(url.pathname);

    e.respondWith(
      (async () => {
        let res;
        if (heavy) {
          const c = await caches.open(ASSET_CACHE);
          const hit = await c.match(req, { ignoreSearch: true });
          if (hit) {
            res = hit;
          } else {
            res = await fetch(req);
            if (res.ok) await c.put(req, res.clone());
          }
        } else {
          res = await fetch(req);
        }
        if (res.status === 0) return res;
        const h = new Headers(res.headers);
        h.set(
          'Cross-Origin-Embedder-Policy',
          coepCredentialless ? 'credentialless' : 'require-corp'
        );
        h.set('Cross-Origin-Opener-Policy', 'same-origin');
        // Help browser keep heavy assets
        if (heavy && !h.has('Cache-Control')) {
          h.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: h
        });
      })().catch((err) => {
        console.error(err);
        return Response.error();
      })
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem('coiReloadedBySelf');
    window.sessionStorage.removeItem('coiReloadedBySelf');
    const coepDegrading = reloadedBySelf === 'coepdegrade';
    const ctrl = navigator.serviceWorker?.controller;
    if (!ctrl && !coepDegrading) {
      window.sessionStorage.setItem('coiReloadedBySelf', 'true');
      return navigator.serviceWorker
        .register(window.document.currentScript.src)
        .then(
          (reg) => {
            console.log('[COI] registered', reg);
            window.location.reload();
          },
          (err) => console.error('[COI] register failed', err)
        );
    }
    let maybeReload = false;
    if (ctrl && !window.crossOriginIsolated && !coepDegrading) {
      maybeReload = true;
      window.sessionStorage.setItem('coiReloadedBySelf', 'coepdegrade');
      ctrl.postMessage({ type: 'coepCredentialless', value: true });
      console.warn('[COI] not isolated; trying credentialless COEP');
    }
    if (maybeReload) setTimeout(() => window.location.reload(), 200);
    if (window.crossOriginIsolated) console.log('[COI] crossOriginIsolated OK');
  })();
}

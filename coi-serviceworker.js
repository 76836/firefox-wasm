/*! COI + asset cache. At most one isolation reload — never infinite. */
const ASSET_CACHE = "ffwasm-assets-v3";
const HEAVY = /gecko\.wasm|chrome-assets|logo\.webp|firefox-icon/;

let coepCredentialless = false;

if (typeof window === "undefined") {
  self.addEventListener("install", (e) => {
    e.waitUntil(
      (async () => {
        try {
          const c = await caches.open(ASSET_CACHE);
          for (const u of [
            "./gecko.wasm.zst",
            "./chrome-assets.tar.zst",
            "./chrome-assets.json",
            "./logo.webp",
            "./assets/firefox-icon.png",
          ]) {
            try {
              const r = await fetch(u, { cache: "reload" });
              if (r.ok) await c.put(u, r.clone());
            } catch (_) {}
          }
        } catch (_) {}
        self.skipWaiting();
      })()
    );
  });

  self.addEventListener("activate", (e) => {
    e.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k.startsWith("ffwasm-assets-") && k !== ASSET_CACHE)
            .map((k) => caches.delete(k))
        );
        await self.clients.claim();
      })()
    );
  });

  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "coepCredentialless") coepCredentialless = !!ev.data.value;
    if (ev.data === "clear-asset-cache" || ev.data?.type === "clear-asset-cache") {
      caches.delete(ASSET_CACHE);
    }
  });

  self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

    const url = new URL(req.url);
    const sameOrigin = url.origin === self.location.origin;
    const heavy = sameOrigin && req.method === "GET" && HEAVY.test(url.pathname);

    e.respondWith(
      (async () => {
        let res;
        if (heavy) {
          const c = await caches.open(ASSET_CACHE);
          const hit = await c.match(req, { ignoreSearch: true });
          if (hit) res = hit;
          else {
            res = await fetch(req);
            if (res.ok) await c.put(req, res.clone());
          }
        } else {
          res = await fetch(req);
        }
        if (res.status === 0) return res;
        const h = new Headers(res.headers);
        h.set(
          "Cross-Origin-Embedder-Policy",
          coepCredentialless ? "credentialless" : "require-corp"
        );
        h.set("Cross-Origin-Opener-Policy", "same-origin");
        if (heavy && !h.has("Cache-Control")) {
          h.set("Cache-Control", "public, max-age=31536000, immutable");
        }
        // Allow embedding only from same origin (WebDesk popup preferred)
        h.set("Cross-Origin-Resource-Policy", "same-origin");
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: h,
        });
      })().catch(() => Response.error())
    );
  });
} else {
  (() => {
    const KEY = "coiReloadedBySelf";
    const already = window.sessionStorage.getItem(KEY);
    const inIframe = window !== window.top;

    // Never reload more than once per tab session
    if (!window.crossOriginIsolated && !already) {
      window.sessionStorage.setItem(KEY, "1");
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .register(window.document.currentScript.src)
          .then((reg) => {
            // Prefer credentialless in iframes (slightly more permissive)
            if (inIframe && reg.active) {
              reg.active.postMessage({ type: "coepCredentialless", value: true });
            }
            console.log("[COI] registered, reloading once for isolation");
            window.location.reload();
          })
          .catch((err) => console.error("[COI] register failed", err));
      }
      return;
    }

    if (already) window.sessionStorage.removeItem(KEY);

    if (window.crossOriginIsolated) {
      console.log("[COI] crossOriginIsolated OK");
    } else {
      console.warn(
        "[COI] not isolated after reload." +
          (inIframe
            ? " Open Firefox in a top-level window (WebDesk uses popup for this app)."
            : " SharedArrayBuffer will fail.")
      );
    }
  })();
}

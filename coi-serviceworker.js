/*! coi-serviceworker - enables COOP/COEP for SharedArrayBuffer on static hosts */
let coepCredentialless = false;
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener("message", (ev) => {
    if (!ev.data) return;
    if (ev.data.type === "coepCredentialless") coepCredentialless = !!ev.data.value;
  });
  self.addEventListener("fetch", (e) => {
    const r = e.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
    e.respondWith(
      fetch(r)
        .then((res) => {
          if (res.status === 0) return res;
          const h = new Headers(res.headers);
          h.set("Cross-Origin-Embedder-Policy", coepCredentialless ? "credentialless" : "require-corp");
          h.set("Cross-Origin-Opener-Policy", "same-origin");
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
        })
        .catch((err) => console.error(err))
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const coepDegrading = reloadedBySelf === "coepdegrade";
    const ctrl = navigator.serviceWorker?.controller;
    if (!ctrl && !coepDegrading) {
      window.sessionStorage.setItem("coiReloadedBySelf", "true");
      return navigator.serviceWorker.register(window.document.currentScript.src).then(
        (reg) => { console.log("[COI] registered", reg); window.location.reload(); },
        (err) => console.error("[COI] register failed", err)
      );
    }
    let maybeReload = false;
    if (ctrl && !window.crossOriginIsolated && !coepDegrading) {
      maybeReload = true;
      window.sessionStorage.setItem("coiReloadedBySelf", "coepdegrade");
      ctrl.postMessage({ type: "coepCredentialless", value: true });
      console.warn("[COI] not isolated; trying credentialless COEP");
    }
    if (maybeReload) setTimeout(() => window.location.reload(), 200);
    if (window.crossOriginIsolated) console.log("[COI] crossOriginIsolated OK");
  })();
}

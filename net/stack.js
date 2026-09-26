/**
 * Firefox-WASM network control plane.
 *
 * Reality check (browser sandbox):
 *   Gecko can only open TCP via Wisp → WebSocket → a server that dials TCP.
 *   In-page Tailscale (@tailscale/connect) joins a tailnet but does NOT expose
 *   raw TCP dial, so it cannot replace Wisp for full browser networking.
 *
 * Modes:
 *   off     – no Module.wispUrl
 *   remote  – Module.wispUrl = user wss://…/  (THIS is how you get the internet)
 *   local   – in-page fake Wisp (Direct Sockets only; almost never enough)
 *
 * Full internet recipe:
 *   1. Run a Wisp server on a machine that can reach the internet
 *      (see net/wisp-server.mjs), ideally with Tailscale + exit node.
 *   2. net wisp wss://your-host:port/
 *   3. Launch Firefox.
 */
window.NetStack = (function () {
  const STORE = "ffwasm.net";

  function log(m) {
    console.log("[net]", m);
  }

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE) || "{}");
    } catch {
      return {};
    }
  }

  function save(o) {
    try {
      localStorage.setItem(STORE, JSON.stringify(o));
    } catch (_) {}
  }

  function normalizeWispUrl(url) {
    if (!url) return "";
    let u = String(url).trim();
    if (!u) return "";
    // Protocol wants trailing slash
    if (/^wss?:\/\//i.test(u) && !u.endsWith("/")) u += "/";
    return u;
  }

  function applyWispToDom(url) {
    const el = document.getElementById("opt-wisp");
    if (el) el.value = url || "";
    try {
      if (window.Module) window.Module.wispUrl = url || "";
    } catch (_) {}
    try {
      const o = JSON.parse(localStorage.getItem("chrome-demo-opts") || "{}");
      o.wisp = url || "";
      localStorage.setItem("chrome-demo-opts", JSON.stringify(o));
    } catch (_) {}
  }

  function mode() {
    return load().mode || "off";
  }

  function wispUrl() {
    return load().wisp || "";
  }

  function setMode(m) {
    const o = load();
    o.mode = m;
    save(o);
    if (m === "off") {
      applyWispToDom("");
      try {
        window.WispLocal?.disable?.();
      } catch (_) {}
    } else if (m === "local") {
      window.WispLocal?.enable?.();
      const u = "wss://wisp.local/ts";
      o.wisp = u;
      save(o);
      applyWispToDom(u);
    } else if (m === "remote") {
      try {
        window.WispLocal?.disable?.();
      } catch (_) {}
      applyWispToDom(normalizeWispUrl(o.wisp));
    }
    log("mode → " + m);
    return status();
  }

  function setWisp(url) {
    const o = load();
    o.wisp = normalizeWispUrl(url);
    o.mode = o.wisp ? "remote" : "off";
    save(o);
    try {
      window.WispLocal?.disable?.();
    } catch (_) {}
    applyWispToDom(o.wisp);
    log("wisp → " + (o.wisp || "(off)"));
    return status();
  }

  function status() {
    const o = load();
    const ts = window.FFTailscale?.status?.() || {};
    return {
      mode: o.mode || "off",
      wisp: o.wisp || "",
      moduleWisp: (typeof Module !== "undefined" && Module.wispUrl) || document.getElementById("opt-wisp")?.value || "",
      tailscale: ts.state || "n/a",
      tailscaleIp: ts.ip || null,
      tip:
        !o.wisp && o.mode !== "local"
          ? "No Wisp URL. Full internet needs a remote Wisp server: net wisp wss://host:port/"
          : o.mode === "local"
            ? "Local Wisp only works with Direct Sockets. Prefer remote Wisp for real internet."
            : "Remote Wisp set — launch Gecko; TCP goes through that server.",
    };
  }

  function boot() {
    const o = load();
    if (o.mode === "local") setMode("local");
    else if (o.wisp) {
      applyWispToDom(normalizeWispUrl(o.wisp));
      o.mode = "remote";
      save(o);
    }
  }

  return { mode, setMode, setWisp, wispUrl, status, boot, normalizeWispUrl };
})();

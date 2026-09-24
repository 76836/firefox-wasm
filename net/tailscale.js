/**
 * Tailscale integration scaffold for Firefox-WASM.
 *
 * WebVM uses CheerpX TUN + Tailscale Go WASM. Gecko-WASM uses Wisp (WebSocket).
 * Near-term: connect Tailscale IPN in-page, then point wispUrl at a Wisp server
 * reachable on the tailnet (or implement a JS Wisp server over Tailscale TCP).
 *
 * CLI: tailscale login | status | set wisp …
 */
window.FFTailscale = (function () {
  let ipn = null;
  let state = "idle";
  let lastIp = null;

  function log(msg) {
    console.log("[tailscale]", msg);
  }

  async function loadConnect() {
    // @tailscale/connect is large (~30MB wasm). Lazy-load only on demand.
    // unpkg ESM entry varies by version; try documented createIPN path.
    log("Tailscale WASM load is optional/heavy — use a tailnet Wisp server for now.");
    log("Set: set wisp wss://<machine-on-tailnet>:port");
    log("WebVM approach: Go WASM IPN + TUN. Here Wisp must carry TCP until a bridge exists.");
    state = "stub";
    return null;
  }

  async function login() {
    state = "connecting";
    await loadConnect();
    // Full IPN.login() wiring lands once pkg is vendored under net/vendor/
    state = "need-wisp";
    return {
      ok: false,
      message: "Vendored Tailscale WASM not in repo yet. Point wisp at a server on your tailnet."
    };
  }

  function status() {
    return { state, ip: lastIp, wisp: document.getElementById("opt-wisp")?.value || "" };
  }

  function applyWisp(url) {
    const el = document.getElementById("opt-wisp");
    if (el) el.value = url || "";
    state = url ? "wisp-set" : "idle";
    log("wisp → " + (url || "(off)"));
  }

  return { login, status, applyWisp, loadConnect };
})();

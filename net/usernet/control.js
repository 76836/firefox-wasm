/**
 * Step 6: Tailscale control plane (netmap, auth, exit node detection).
 * Uses @tailscale/connect via existing FFTailscale when present.
 */
(function () {
  function log(...a) {
    console.log("[usernet:control]", ...a);
  }

  async function login(opts) {
    if (!window.FFTailscale) throw new Error("FFTailscale not loaded");
    return window.FFTailscale.login(opts || {});
  }

  function status() {
    return window.FFTailscale?.status?.() || { state: "missing" };
  }

  function onChange(fn) {
    return window.FFTailscale?.onChange?.(fn);
  }

  /** Exit node from last netmap if FFTailscale exposes peers — best-effort */
  function hasExitNode() {
    const s = status();
    return !!(s.exitNode || s.peers);
  }

  window.UserNetControl = {
    login,
    status,
    onChange,
    hasExitNode,
  };
})();

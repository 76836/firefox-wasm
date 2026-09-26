/**
 * Tailscale for Firefox-WASM via @tailscale/connect (Go IPN in WASM).
 *
 * Gecko networking still speaks Wisp (WebSocket). After you join a tailnet:
 *   - HTTP to tailnet hosts works through IPN.fetch (for probes/tools)
 *   - Full browser TCP needs a Wisp server; set Module.wispUrl / "set wisp …"
 *     ideally on a machine in the same tailnet (or public Wisp)
 *
 * CLI: ts login | logout | status | wisp <url>
 * URL hash: #authKey=tskey-…&controlUrl=https://…
 */
window.FFTailscale = (function () {
  const CDN = "https://cdn.jsdelivr.net/npm/@tailscale/connect@1.102.3-3-tb31d8a75a-g5e651e16f";
  const WASM_URL = CDN + "/main.wasm";
  const PKG_URL = CDN + "/pkg.js";

  let ipn = null;
  let state = "idle";
  let lastIp = null;
  let netMap = null;
  let loginUrl = null;
  let loadPromise = null;
  const listeners = new Set();

  function log(msg) {
    console.log("[tailscale]", msg);
  }

  function emit() {
    const snap = status();
    listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch (_) {}
    });
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function parseHashConfig() {
    const h = (location.hash || "").replace(/^#/, "");
    const p = new URLSearchParams(h);
    return {
      authKey: p.get("authKey") || p.get("authkey") || undefined,
      controlURL: p.get("controlUrl") || p.get("controlURL") || undefined,
    };
  }

  const storage = {
    setState(id, value) {
      try {
        localStorage.setItem("ffwasm.ts." + id, value);
      } catch (_) {}
    },
    getState(id) {
      try {
        return localStorage.getItem("ffwasm.ts." + id) || "";
      } catch (_) {
        return "";
      }
    },
  };

  async function loadSdk() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      // pkg.js is ESM exporting createIPN
      const mod = await import(PKG_URL);
      if (typeof mod.createIPN !== "function") {
        throw new Error("createIPN missing from @tailscale/connect");
      }
      return mod;
    })();
    return loadPromise;
  }

  async function ensureIpn(extra = {}) {
    if (ipn) return ipn;
    state = "loading";
    emit();
    log("loading Tailscale WASM (~25MB first time)…");
    const mod = await loadSdk();
    const hashCfg = parseHashConfig();
    const cfg = {
      wasmURL: WASM_URL,
      hostname: extra.hostname || "firefox-wasm",
      stateStorage: storage,
      authKey: extra.authKey || hashCfg.authKey,
      controlURL: extra.controlURL || hashCfg.controlURL,
      panicHandler(err) {
        log("panic: " + err);
        state = "panic";
        emit();
      },
    };
    ipn = await mod.createIPN(cfg);
    ipn.run({
      notifyState(s) {
        state = s;
        log("state " + s);
        if (s === "Running") {
          // already have netmap maybe
        }
        if (s === "NeedsLogin") {
          // loginUrl comes via notifyBrowseToURL
        }
        emit();
      },
      notifyNetMap(netMapStr) {
        try {
          netMap = typeof netMapStr === "string" ? JSON.parse(netMapStr) : netMapStr;
          const addrs = netMap?.self?.addresses || [];
          lastIp = addrs[0] || lastIp;
          log("netmap self=" + (netMap?.self?.name || "?") + " ip=" + (lastIp || "?"));
        } catch (e) {
          log("netmap parse error " + e);
        }
        emit();
      },
      notifyBrowseToURL(url) {
        loginUrl = url;
        log("login URL ready");
        emit();
        try {
          window.open(url, "_blank", "noopener");
        } catch (_) {}
      },
      notifyPanicRecover(err) {
        log("recover: " + err);
      },
    });
    return ipn;
  }

  async function login(opts = {}) {
    try {
      const node = await ensureIpn(opts);
      if (state === "Running") {
        return { ok: true, state, ip: lastIp, message: "already running" };
      }
      // Auth key path: createIPN already has key; may auto-start
      if (opts.authKey || parseHashConfig().authKey) {
        state = "Starting";
        emit();
        return { ok: true, state, message: "auth key supplied — waiting for Running" };
      }
      node.login();
      state = "NeedsLogin";
      emit();
      return {
        ok: true,
        state,
        loginUrl,
        message: "complete login in the opened tab, then return here",
      };
    } catch (e) {
      state = "error";
      emit();
      return { ok: false, message: String(e.message || e) };
    }
  }

  function logout() {
    try {
      ipn?.logout?.();
    } catch (_) {}
    ipn = null;
    state = "idle";
    lastIp = null;
    netMap = null;
    loginUrl = null;
    emit();
    return { ok: true };
  }

  function status() {
    return {
      state,
      ip: lastIp,
      loginUrl,
      peers: netMap?.peers?.length ?? 0,
      self: netMap?.self?.name || null,
      wisp: document.getElementById("opt-wisp")?.value || "",
    };
  }

  function applyWisp(url) {
    const el = document.getElementById("opt-wisp");
    if (el) el.value = url || "";
    try {
      if (window.Module) window.Module.wispUrl = url || "";
    } catch (_) {}
    // Persist for chrome-demo opts
    try {
      const o = JSON.parse(localStorage.getItem("chrome-demo-opts") || "{}");
      o.wisp = url || "";
      localStorage.setItem("chrome-demo-opts", JSON.stringify(o));
    } catch (_) {}
    log("wisp → " + (url || "(off)"));
    emit();
  }

  /** HTTP via Tailscale userspace (works once Running). */
  async function fetchViaTs(url) {
    if (!ipn || state !== "Running") {
      throw new Error("Tailscale not Running");
    }
    return ipn.fetch(url);
  }

  // Auto-start if authKey in hash
  const boot = parseHashConfig();
  if (boot.authKey) {
    login({ authKey: boot.authKey, controlURL: boot.controlURL }).then((r) =>
      log("auto login: " + JSON.stringify(r))
    );
  }

  return {
    login,
    logout,
    status,
    applyWisp,
    fetchViaTs,
    onChange,
    ensureIpn,
  };
})();

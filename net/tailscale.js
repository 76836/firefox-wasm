/**
 * Tailscale control plane via @tailscale/connect (createIPN).
 * Keeps full netmap, detects exit nodes, notifies UserNet for seamless path.
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
  let exitPeer = null; // { name, addresses, nodeKey, machineKey, raw }
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
    // Seamless: when Running + exit node, arm UserNet
    if (state === "Running" && exitPeer && window.UserNet?.onTailscaleReady) {
      try {
        window.UserNet.onTailscaleReady(snap);
      } catch (e) {
        log("UserNet hook " + e);
      }
    }
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

  function b64ToBytes(b64) {
    if (!b64) return null;
    try {
      // Tailscale sometimes uses raw std or URL-safe base64
      let s = String(b64).replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (_) {
      return null;
    }
  }

  function pickExitPeer(map) {
    if (!map) return null;
    const peers = map.peers || map.Peers || [];
    if (!peers.length) return null;

    function norm(p) {
      const name =
        p.name || p.Name || p.Hostinfo?.Hostname || p.hostinfo?.Hostname || p.DNSName || p.dnsName;
      const addresses = p.addresses || p.Addresses || p.TailscaleIPs || p.tailscaleIPs || [];
      const nodeKey =
        p.nodeKey || p.NodeKey || p.node_key || p.PublicKey || p.publicKey || p.Key || p.key;
      const machineKey = p.machineKey || p.MachineKey || p.machine_key;
      const online = p.online ?? p.Online;
      const allowed =
        p.allowedIPs || p.AllowedIPs || p.allowed_ips || p.PrimaryRoutes || p.primaryRoutes || [];
      const isExit =
        !!(p.exitNode || p.ExitNode || p.exit_node) ||
        (Array.isArray(allowed) &&
          allowed.some((c) => String(c) === "0.0.0.0/0" || String(c) === "::/0"));
      return { name, addresses, nodeKey, machineKey, online, raw: p, isExit };
    }

    const normalized = peers.map(norm);
    const exit = normalized.find((p) => p.isExit);
    if (exit) {
      return {
        name: exit.name,
        addresses: exit.addresses,
        nodeKey: exit.nodeKey,
        machineKey: exit.machineKey,
        online: exit.online,
        raw: exit.raw,
      };
    }
    // Do not guess a random peer as exit — that misleads routing
    return null;
  }

  async function loadSdk() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const mod = await import(PKG_URL);
      if (typeof mod.createIPN !== "function") throw new Error("createIPN missing");
      return mod;
    })();
    return loadPromise;
  }

  async function ensureIpn(extra = {}) {
    if (ipn) return ipn;
    state = "loading";
    emit();
    log("loading Tailscale WASM…");
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
        emit();
      },
      notifyNetMap(netMapStr) {
        try {
          netMap = typeof netMapStr === "string" ? JSON.parse(netMapStr) : netMapStr;
          const addrs = netMap?.self?.addresses || netMap?.Self?.Addresses || [];
          lastIp = addrs[0] || lastIp;
          exitPeer = pickExitPeer(netMap);
          if (exitPeer) {
            log(
              "exit/peer " +
                (exitPeer.name || "?") +
                (exitPeer.notExit ? " (not exit)" : " (exit node)") +
                " key=" +
                String(exitPeer.nodeKey || "").slice(0, 12) +
                "…"
            );
          } else {
            log("netmap: no exit node peer yet");
          }
        } catch (e) {
          log("netmap parse " + e);
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
        return { ok: true, state, ip: lastIp, exitPeer, message: "already running" };
      }
      if (opts.authKey || parseHashConfig().authKey) {
        state = "Starting";
        emit();
        return { ok: true, state, message: "auth key — waiting for Running" };
      }
      node.login();
      state = "NeedsLogin";
      emit();
      return {
        ok: true,
        state,
        loginUrl,
        message: "complete login in the opened tab",
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
    exitPeer = null;
    loginUrl = null;
    emit();
    return { ok: true };
  }

  function status() {
    return {
      state,
      ip: lastIp,
      loginUrl,
      peers: netMap?.peers?.length ?? netMap?.Peers?.length ?? 0,
      self: netMap?.self?.name || netMap?.Self?.Name || null,
      exitPeer,
      exitNodeKeyBytes: exitPeer?.nodeKey ? b64ToBytes(exitPeer.nodeKey) : null,
      netMap,
      wisp: document.getElementById("opt-wisp")?.value || "",
    };
  }

  function applyWisp(url) {
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
    log("wisp → " + (url || "(off)"));
    emit();
  }

  async function fetchViaTs(url) {
    if (!ipn || state !== "Running") throw new Error("Tailscale not Running");
    return ipn.fetch(url);
  }

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
    b64ToBytes,
  };
})();

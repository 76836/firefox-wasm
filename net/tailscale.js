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
    let s = String(b64).trim();
    if (s.startsWith("nodekey:")) s = s.slice(8);
    if (s.startsWith("mkey:")) s = s.slice(5);
    // hex (64 chars for 32 bytes)
    if (/^[0-9a-fA-F]{64}$/.test(s)) {
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
      return out;
    }
    try {
      s = s.replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (_) {
      return null;
    }
  }


  function asPeerList(map) {
    if (!map || typeof map !== "object") return [];
    let peers = map.peers || map.Peers || map.peer || map.Peer || [];
    if (peers && typeof peers === "object" && !Array.isArray(peers)) {
      peers = Object.values(peers);
    }
    if (!Array.isArray(peers)) peers = [];
    // Some maps nest under NetworkMap / netMap
    if (!peers.length && map.NetworkMap) return asPeerList(map.NetworkMap);
    if (!peers.length && map.netMap) return asPeerList(map.netMap);
    return peers;
  }

  function peerFields(p) {
    if (!p || typeof p !== "object") return null;
    const name =
      p.name ||
      p.Name ||
      p.DNSName ||
      p.dnsName ||
      p.Hostinfo?.Hostname ||
      p.hostinfo?.Hostname ||
      p.ComputedName ||
      p.computedName ||
      null;
    const addresses =
      p.addresses ||
      p.Addresses ||
      p.Addresses ||
      p.TailscaleIPs ||
      p.tailscaleIPs ||
      p.Addresses ||
      [];
    const nodeKey =
      p.nodeKey ||
      p.NodeKey ||
      p.node_key ||
      p.Key ||
      p.key ||
      p.PublicKey ||
      p.publicKey ||
      null;
    const machineKey = p.machineKey || p.MachineKey || p.machine_key || null;
    const online = p.online ?? p.Online;
    const allowed =
      p.allowedIPs ||
      p.AllowedIPs ||
      p.allowed_ips ||
      p.PrimaryRoutes ||
      p.primaryRoutes ||
      p.Hostinfo?.RoutableIPs ||
      p.hostinfo?.RoutableIPs ||
      [];
    const allowedList = Array.isArray(allowed) ? allowed.map(String) : [];
    const caps = p.CapMap || p.capMap || p.Capabilities || p.capabilities || {};
    const isExit =
      !!(p.exitNode || p.ExitNode || p.exit_node || p.IsExitNode || p.isExitNode) ||
      allowedList.some((c) => c === "0.0.0.0/0" || c === "::/0") ||
      !!(caps["exit-node"] || caps["https://tailscale.com/cap/exit-node"]);
    return {
      name: name || "(unnamed)",
      addresses: Array.isArray(addresses) ? addresses : [],
      nodeKey,
      machineKey,
      online,
      isExit,
      allowedIPs: allowedList,
      fieldNames: Object.keys(p),
      raw: p,
    };
  }

  function pickExitPeer(map) {
    const list = asPeerList(map).map(peerFields).filter(Boolean);
    const exits = list.filter((p) => p.isExit);
    if (exits.length) {
      // Prefer online exit if marked
      const online = exits.find((p) => p.online !== false);
      return online || exits[0];
    }
    return null;
  }

  function summarizeNetMap(map) {
    const list = asPeerList(map).map(peerFields).filter(Boolean);
    const topKeys = map && typeof map === "object" ? Object.keys(map) : [];
    return {
      topKeys,
      peerCount: list.length,
      exitCount: list.filter((p) => p.isExit).length,
      peers: list.map((p) => ({
        name: p.name,
        online: p.online,
        isExit: p.isExit,
        addresses: p.addresses,
        hasNodeKey: !!p.nodeKey,
        nodeKeyPrefix: p.nodeKey ? String(p.nodeKey).slice(0, 12) + "…" : null,
        fields: p.fieldNames,
        allowedIPs: p.allowedIPs.slice(0, 8),
      })),
    };
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
          let parsed = typeof netMapStr === "string" ? JSON.parse(netMapStr) : netMapStr;
          // Some builds wrap the map
          if (parsed && parsed.NetworkMap && !parsed.peers && !parsed.Peers) {
            parsed = parsed.NetworkMap;
          }
          netMap = parsed;
          const self =
            netMap?.self || netMap?.Self || netMap?.SelfNode || netMap?.selfNode || {};
          const addrs =
            self.addresses || self.Addresses || self.Addresses || self.TailscaleIPs || [];
          lastIp = (Array.isArray(addrs) && addrs[0]) || lastIp;
          exitPeer = pickExitPeer(netMap);
          const sum = summarizeNetMap(netMap);
          log(
            "netmap peers=" +
              sum.peerCount +
              " exits=" +
              sum.exitCount +
              " keys=[" +
              sum.topKeys.slice(0, 12).join(",") +
              "]"
          );
          if (exitPeer) {
            log(
              "exit node " +
                (exitPeer.name || "?") +
                " key=" +
                String(exitPeer.nodeKey || "").slice(0, 12) +
                "…"
            );
          } else if (sum.peerCount === 0) {
            log("netmap has no peers yet (waiting for full map)");
          } else {
            log(
              "no exit-flagged peer — run: ts peers  (allowedIPs/exit may be missing from Connect map)"
            );
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
    const sum = netMap ? summarizeNetMap(netMap) : { peerCount: 0, exitCount: 0, peers: [], topKeys: [] };
    return {
      state,
      ip: lastIp,
      loginUrl,
      peers: sum.peerCount,
      exits: sum.exitCount,
      self: netMap?.self?.name || netMap?.Self?.Name || netMap?.SelfNode?.Name || null,
      exitPeer: exitPeer
        ? {
            name: exitPeer.name,
            addresses: exitPeer.addresses,
            nodeKey: exitPeer.nodeKey,
            online: exitPeer.online,
            isExit: exitPeer.isExit !== false,
          }
        : null,
      exitNodeKeyBytes: exitPeer?.nodeKey ? b64ToBytes(exitPeer.nodeKey) : null,
      peerList: sum.peers,
      netMapKeys: sum.topKeys,
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
    summarizeNetMap: () => (netMap ? summarizeNetMap(netMap) : null),
    getNetMap: () => netMap,
  };
})();

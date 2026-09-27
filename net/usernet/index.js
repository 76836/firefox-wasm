/**
 * UserNet orchestrator — steps 1–6
 * dial() uses socket (1) → tcpip (2). TUN → WG (4) → DERP (5).
 * Control (6) supplies exit-node peer key when available.
 */
(function () {
  function log(...a) {
    console.log("[usernet]", ...a);
  }

  let derp = null;
  let wg = null;
  let started = false;
  let kp = null;

  async function start() {
    if (started) return status();
    started = true;
    await window.UserNetTcpip.ensure();
    await window.UserNetWG.loadCrypto().catch((e) => log("wg crypto", e.message || e));

    window.UserNetTcpip.onIpPacket(async (pkt) => {
      if (wg) await wg.sendIpPacket(pkt);
    });
    log("layers 1–2 ready (socket+tcpip)");
    return status();
  }

  /**
   * peerPublicKey: Uint8Array(32) from netmap exit node when known
   */
  async function enableInternetPath(peerPublicKey) {
    await start();
    try {
      await window.UserNetControl.login();
    } catch (e) {
      log("control", e.message || e);
    }

    kp = await window.UserNetWG.generateKeyPair();

    const map = await window.UserNetDerp.fetchDefaultDerpMap();
    const url = window.UserNetDerp.pickDerpWsUrl(map);
    derp = new window.UserNetDerp.DerpClient(url);
    try {
      await derp.connect();
      log("DERP up", url);
    } catch (e) {
      log("DERP", e.message || e);
    }

    let peerKey = peerPublicKey;
    if (typeof peerKey === "string" && peerKey.length >= 64) {
      peerKey = hexToBytes(peerKey);
    }

    wg = new window.UserNetWG.WireGuardSession({
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      peerPublicKey: peerKey || null,
      sendOuter: (msg) => {
        if (!derp || !peerKey) {
          log("outer send", msg.length, "b (need DERP+peer)");
          return;
        }
        derp.sendPacket(peerKey, msg);
      },
    });
    wg.onIpPacket((ip) => window.UserNetTcpip.injectIpPacket(ip));
    if (derp) {
      derp.on("packet", (payload) => {
        const body = payload.length > 32 ? payload.subarray(32) : payload;
        wg.handleIncoming(body);
      });
    }
    await wg.handshake();
    return status();
  }

  function hexToBytes(hex) {
    const h = hex.replace(/[^0-9a-fA-F]/g, "");
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }

  async function dial(host, port) {
    await start();
    if (window.UserNetSocket?.connect) {
      return window.UserNetSocket.connect(host, port);
    }
    return window.UserNetTcpip.connectTcp(host, port);
  }

  function setExitPeerKey(key) {
    return enableInternetPath(key);
  }

  function status() {
    return {
      started,
      socket: !!window.UserNetSocket,
      tcpip: !!window.UserNetTcpip?.getStack?.(),
      tun: !!window.UserNetTcpip?.getTun?.(),
      wgReady: !!(wg && wg.ready),
      wgPeer: !!(wg && wg.peerPublicKey),
      derp: !!(derp?.ws && derp.ws.readyState === 1),
      control: window.UserNetControl?.status?.() || null,
      tip: wg?.ready
        ? "WG transport keys up — traffic can flow if DERP peer path works"
        : "Set exit node WG public key: usernet peer <hex64> (from Tailscale machine keys)",
    };
  }

  window.UserNet = {
    start,
    enableInternetPath,
    setExitPeerKey,
    dial,
    status,
  };
})();

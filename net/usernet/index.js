/**
 * UserNet — steps 2–6 orchestrator for Firefox-WASM.
 *
 * dial(host, port) → duplex streams for local Wisp server.
 *
 * Pipeline:
 *   dial → tcpip.connectTcp → (IP on TUN) → WG → DERP → peers/exit
 *
 * Until WG Noise_IK is complete, dial uses tcpip only (works for stack-local
 * targets). enableInternetPath() connects DERP + hooks TUN pump.
 */
(function () {
  function log(...a) {
    console.log("[usernet]", ...a);
  }

  let derp = null;
  let wg = null;
  let started = false;
  let internetPath = false;

  async function start() {
    if (started) return status();
    started = true;
    await window.UserNetTcpip.ensure();
    // TUN → (future WG)
    window.UserNetTcpip.onIpPacket(async (pkt) => {
      if (wg) await wg.sendIpPacket(pkt);
    });
    log("tcpip layer up");
    return status();
  }

  async function enableInternetPath() {
    await start();
    // Control plane
    try {
      await window.UserNetControl.login();
    } catch (e) {
      log("control login", e.message || e);
    }

    // DERP
    const map = await window.UserNetDerp.fetchDefaultDerpMap();
    const url = window.UserNetDerp.pickDerpWsUrl(map);
    derp = new window.UserNetDerp.DerpClient(url);
    try {
      await derp.connect();
      log("DERP connected", url);
    } catch (e) {
      log("DERP failed", e.message || e, "— continue without relay");
    }

    // WG session (stub keys until Noise_IK)
    const kp = await window.UserNetWG.generateKeyPair();
    wg = new window.UserNetWG.WireGuardSession({
      ...kp,
      peerPublicKey: null,
      sendRaw: (pkt) => {
        // Without peer key, cannot SendPacket yet
        log("egress IP packet", pkt.length, "bytes (needs peer + WG)");
      },
    });
    if (derp) {
      derp.on("packet", (payload) => {
        // [32 src][packet]
        const body = payload.length > 32 ? payload.subarray(32) : payload;
        wg.handleIncoming(body).then(() => {
          window.UserNetTcpip.injectIpPacket(body);
        });
      });
    }
    await wg.handshake();
    internetPath = true;
    log("internet path partially armed (WG crypto still TODO)");
    return status();
  }

  async function dial(host, port) {
    await start();
    log("dial", host + ":" + port);
    return window.UserNetTcpip.connectTcp(host, port);
  }

  function status() {
    return {
      started,
      internetPath,
      tcpip: !!window.UserNetTcpip?.getStack?.(),
      tun: !!window.UserNetTcpip?.getTun?.(),
      derp: !!(derp && derp.ws && derp.ws.readyState === 1),
      wg: !!(wg && wg.ready),
      control: window.UserNetControl?.status?.() || null,
      note:
        "tcpip+TUN live; DERP connect attempted; WireGuard Noise_IK + peer from netmap still TODO for public internet",
    };
  }

  window.UserNet = {
    start,
    enableInternetPath,
    dial,
    status,
  };
})();

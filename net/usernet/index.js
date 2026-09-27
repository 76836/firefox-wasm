/**
 * Seamless UserNet: on Tailscale Running + exit node → auto DERP + WG peer.
 */
(function () {
  function log(...a) {
    console.log("[usernet]", ...a);
  }

  let derp = null;
  let wg = null;
  let started = false;
  let arming = null;
  let lastExitKey = null;

  async function start() {
    if (started) return status();
    started = true;
    await window.UserNetTcpip.ensure();
    try {
      await window.UserNetWG.loadCrypto();
    } catch (e) {
      log("wg crypto", e.message || e);
    }
    window.UserNetTcpip.onIpPacket(async (pkt) => {
      if (wg) await wg.sendIpPacket(pkt);
    });
    // Local wisp for Gecko
    try {
      window.WispLocal?.enable?.();
    } catch (_) {}
    log("stack ready");
    return status();
  }

  function keyFromStatus(st) {
    if (st.exitNodeKeyBytes && st.exitNodeKeyBytes.length === 32) return st.exitNodeKeyBytes;
    if (st.exitPeer?.nodeKey && window.FFTailscale?.b64ToBytes) {
      const b = window.FFTailscale.b64ToBytes(st.exitPeer.nodeKey);
      if (b && b.length >= 32) return b.subarray(0, 32);
    }
    return null;
  }

  async function armWithExit(st) {
    const peerKey = keyFromStatus(st || window.FFTailscale?.status?.() || {});
    if (!peerKey) {
      log("no exit node key in netmap yet — enable exit node on phone + approve");
      return status();
    }
    const keyHex = [...peerKey].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (lastExitKey === keyHex && wg) return status();
    lastExitKey = keyHex;

    await start();

    const nacl = await window.UserNetDerp.loadNacl();
    const boxKp = nacl.box.keyPair();
    // Align WG identity with a noble keypair
    const wgKp = await window.UserNetWG.generateKeyPair();

    const map = await window.UserNetDerp.fetchDefaultDerpMap();
    const url = window.UserNetDerp.pickDerpWsUrl(map);
    if (derp) try { derp.close(); } catch (_) {}
    derp = new window.UserNetDerp.DerpClient(url, {
      publicKey: boxKp.publicKey,
      privateKey: boxKp.secretKey,
      secretKey: boxKp.secretKey,
    });
    try {
      await derp.connect();
    } catch (e) {
      log("DERP", e.message || e);
    }

    wg = new window.UserNetWG.WireGuardSession({
      privateKey: wgKp.privateKey,
      publicKey: wgKp.publicKey,
      peerPublicKey: peerKey,
      sendOuter: (msg) => derp?.sendPacket(peerKey, msg),
    });
    wg.onIpPacket((ip) => window.UserNetTcpip.injectIpPacket(ip));
    derp?.on("packet", (payload) => {
      const body = payload.length > 32 ? payload.subarray(32) : payload;
      wg.handleIncoming(body);
    });
    await wg.handshake();
    log("armed for exit peer", st?.exitPeer?.name || keyHex.slice(0, 16));
    return status();
  }

  /** Called from FFTailscale when Running + exit peer known */
  function onTailscaleReady(st) {
    if (arming) return arming;
    arming = armWithExit(st)
      .catch((e) => log("arm failed", e.message || e))
      .finally(() => {
        arming = null;
      });
    return arming;
  }

  async function enableInternetPath() {
    await window.UserNetControl.login();
    // Wait briefly for netmap
    for (let i = 0; i < 40; i++) {
      const st = window.FFTailscale?.status?.();
      if (st?.state === "Running" && keyFromStatus(st)) {
        return armWithExit(st);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    log("timeout waiting for Running+exit — check phone exit node");
    return armWithExit(window.FFTailscale?.status?.());
  }

  async function dial(host, port) {
    await start();
    if (window.UserNetSocket?.connect) return window.UserNetSocket.connect(host, port);
    return window.UserNetTcpip.connectTcp(host, port);
  }

  function status() {
    const ts = window.FFTailscale?.status?.() || {};
    return {
      started,
      tcpip: !!window.UserNetTcpip?.getStack?.(),
      tun: !!window.UserNetTcpip?.getTun?.(),
      wgReady: !!(wg && wg.ready),
      derp: !!(derp?.loggedIn || (derp?.ws && derp.ws.readyState === 1)),
      exitPeer: ts.exitPeer || null,
      tailscale: ts.state,
      tip:
        ts.state === "Running" && ts.exitPeer && !ts.exitPeer.notExit
          ? wg?.ready
            ? "Exit node path armed"
            : "Exit node seen — finishing handshake…"
          : "Login + enable exit node on phone (approve in admin)",
    };
  }

  window.UserNet = {
    start,
    enableInternetPath,
    onTailscaleReady,
    setExitPeerKey: (hex) => {
      const b = new Uint8Array(hex.length / 2);
      for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
      return armWithExit({ exitNodeKeyBytes: b, exitPeer: { name: "manual" } });
    },
    dial,
    status,
  };
})();

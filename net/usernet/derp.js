/**
 * Step 5: DERP client — Tailscale's relay protocol over WebSocket/HTTPS.
 * Spec: https://github.com/tailscale/tailscale/tree/main/derp
 *
 * Frame layout (simplified v1-style):
 *   [type u8][length u32 BE][payload…]
 *
 * Public default map: https://controlplane.tailscale.com/derpmap/default
 * This client can connect, read server key frames, and send/recv packet frames
 * once keys/peers are supplied by the control layer.
 */
(function () {
  // Common frame types (from Tailscale derp package)
  const Frame = {
    ServerKey: 1,
    ClientInfo: 2,
    ServerInfo: 3,
    SendPacket: 4,
    RecvPacket: 5,
    KeepAlive: 6,
    NotePreferred: 7,
    PeerGone: 8,
    PeerPresent: 9,
    WatchConnectionChanges: 10,
    ClosePeer: 11,
    ServerRestarting: 12,
  };

  function log(...a) {
    console.log("[usernet:derp]", ...a);
  }

  function encodeFrame(type, payload) {
    const p = payload ? new Uint8Array(payload) : new Uint8Array(0);
    const out = new Uint8Array(5 + p.length);
    out[0] = type;
    const dv = new DataView(out.buffer);
    dv.setUint32(1, p.length, false); // BE
    out.set(p, 5);
    return out;
  }

  function parseFrames(buf, onFrame) {
    let u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    while (u8.length >= 5) {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const type = u8[0];
      const len = dv.getUint32(1, false);
      if (u8.length < 5 + len) break;
      const payload = u8.subarray(5, 5 + len);
      onFrame(type, payload);
      u8 = u8.subarray(5 + len);
    }
    return u8; // remainder
  }

  class DerpClient {
    constructor(url) {
      this.url = url;
      this.ws = null;
      this.serverKey = null;
      this.handlers = { packet: new Set(), open: new Set(), close: new Set() };
      this._remain = new Uint8Array(0);
    }

    on(ev, fn) {
      this.handlers[ev]?.add(fn);
      return () => this.handlers[ev]?.delete(fn);
    }

    async connect() {
      log("connect", this.url);
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      await new Promise((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = (e) => rej(e);
      });
      ws.onmessage = (ev) => {
        const chunk = new Uint8Array(ev.data);
        const merged = new Uint8Array(this._remain.length + chunk.length);
        merged.set(this._remain);
        merged.set(chunk, this._remain.length);
        this._remain = parseFrames(merged, (type, payload) => this._onFrame(type, payload));
      };
      ws.onclose = () => {
        for (const h of this.handlers.close) h();
      };
      for (const h of this.handlers.open) h();
      log("ws open");
    }

    _onFrame(type, payload) {
      if (type === Frame.ServerKey) {
        this.serverKey = payload;
        log("ServerKey", payload.length, "bytes");
      } else if (type === Frame.RecvPacket) {
        // payload: [32-byte src key][packet…]
        for (const h of this.handlers.packet) h(payload);
      } else if (type === Frame.KeepAlive) {
        this.sendFrame(Frame.KeepAlive, null);
      } else {
        log("frame", type, payload.length);
      }
    }

    sendFrame(type, payload) {
      if (!this.ws || this.ws.readyState !== 1) return;
      this.ws.send(encodeFrame(type, payload));
    }

    /** Send packet to 32-byte public key destination */
    sendPacket(dstKey32, packet) {
      const p = new Uint8Array(32 + packet.length);
      p.set(dstKey32, 0);
      p.set(packet, 32);
      this.sendFrame(Frame.SendPacket, p);
    }

    close() {
      try {
        this.ws?.close();
      } catch (_) {}
    }
  }

  async function fetchDefaultDerpMap() {
    const urls = [
      "https://controlplane.tailscale.com/derpmap/default",
      "https://login.tailscale.com/derpmap/default",
    ];
    for (const u of urls) {
      try {
        const r = await fetch(u, { mode: "cors" });
        if (r.ok) return await r.json();
      } catch (_) {}
    }
    return null;
  }

  function pickDerpWsUrl(map) {
    if (!map?.Regions) return "wss://derp.tailscale.com/derp";
    const regions = Object.values(map.Regions);
    const r = regions[0];
    const node = r?.Nodes?.[0];
    if (!node) return "wss://derp.tailscale.com/derp";
    const host = node.HostName || node.IPv4;
    return `wss://${host}/derp`;
  }

  window.UserNetDerp = {
    Frame,
    DerpClient,
    fetchDefaultDerpMap,
    pickDerpWsUrl,
    encodeFrame,
  };
})();

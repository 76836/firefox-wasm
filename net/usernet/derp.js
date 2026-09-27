/**
 * DERP client with proper ServerKey → ClientInfo login (nacl box).
 */
(function () {
  const Frame = {
    ServerKey: 0x01,
    ClientInfo: 0x02,
    ServerInfo: 0x03,
    SendPacket: 0x04,
    RecvPacket: 0x05,
    KeepAlive: 0x06,
    NotePreferred: 0x07,
    PeerGone: 0x08,
    PeerPresent: 0x09,
    Ping: 0x0a,
    Pong: 0x0b,
  };

  const MAGIC = new TextEncoder().encode("DERP🔑");

  function log(...a) {
    console.log("[usernet:derp]", ...a);
  }

  function encodeFrame(type, payload) {
    const p = payload ? new Uint8Array(payload) : new Uint8Array(0);
    const out = new Uint8Array(5 + p.length);
    out[0] = type;
    new DataView(out.buffer).setUint32(1, p.length, false);
    out.set(p, 5);
    return out;
  }

  function parseFrames(buf, onFrame) {
    let u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    while (u8.length >= 5) {
      const len = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(1, false);
      if (u8.length < 5 + len) break;
      onFrame(u8[0], u8.subarray(5, 5 + len));
      u8 = u8.subarray(5 + len);
    }
    return u8;
  }

  let naclPromise = null;
  function loadNacl() {
    if (naclPromise) return naclPromise;
    naclPromise = import("https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm").then((m) => {
      return m.default || m.nacl || m;
    });
    return naclPromise;
  }

  class DerpClient {
    constructor(url, keyPair) {
      this.url = url;
      this.keyPair = keyPair; // { publicKey: Uint8Array(32), privateKey: Uint8Array(32) } nacl box keys
      this.ws = null;
      this.serverKey = null; // 32 bytes
      this.loggedIn = false;
      this.handlers = { packet: new Set(), open: new Set(), close: new Set(), info: new Set() };
      this._remain = new Uint8Array(0);
    }

    on(ev, fn) {
      this.handlers[ev]?.add(fn);
      return () => this.handlers[ev]?.delete(fn);
    }

    async connect() {
      const nacl = await loadNacl();
      if (!this.keyPair) {
        this.keyPair = nacl.box.keyPair();
      }
      log("connect", this.url);
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      await new Promise((res, rej) => {
        ws.onopen = () => res();
        ws.onerror = (e) => rej(new Error("DERP ws error"));
        setTimeout(() => rej(new Error("DERP connect timeout")), 15000);
      });
      ws.onmessage = (ev) => {
        const chunk = new Uint8Array(ev.data);
        const merged = new Uint8Array(this._remain.length + chunk.length);
        merged.set(this._remain);
        merged.set(chunk, this._remain.length);
        this._remain = parseFrames(merged, (type, payload) => this._onFrame(nacl, type, payload));
      };
      ws.onclose = () => {
        this.loggedIn = false;
        for (const h of this.handlers.close) h();
      };
      for (const h of this.handlers.open) h();
    }

    async _onFrame(nacl, type, payload) {
      if (type === Frame.ServerKey) {
        // magic(8) + server public key(32)
        if (payload.length >= 40) {
          this.serverKey = payload.subarray(8, 40);
        } else if (payload.length >= 32) {
          this.serverKey = payload.subarray(payload.length - 32);
        }
        log("ServerKey ok");
        await this._sendClientInfo(nacl);
        return;
      }
      if (type === Frame.ServerInfo) {
        this.loggedIn = true;
        log("DERP logged in");
        for (const h of this.handlers.info) h(payload);
        return;
      }
      if (type === Frame.RecvPacket) {
        for (const h of this.handlers.packet) h(payload);
        return;
      }
      if (type === Frame.KeepAlive) {
        this.sendFrame(Frame.KeepAlive, null);
        return;
      }
      if (type === Frame.Ping) {
        this.sendFrame(Frame.Pong, payload);
      }
    }

    async _sendClientInfo(nacl) {
      if (!this.serverKey || !this.keyPair) return;
      const info = new TextEncoder().encode(JSON.stringify({ version: 2 }));
      const nonce = nacl.randomBytes(24);
      // nacl.box(msg, nonce, theirPub, mySecret)
      const boxed = nacl.box(info, nonce, this.serverKey, this.keyPair.secretKey || this.keyPair.privateKey);
      const pub = this.keyPair.publicKey;
      const payload = new Uint8Array(32 + 24 + boxed.length);
      payload.set(pub, 0);
      payload.set(nonce, 32);
      payload.set(boxed, 56);
      this.sendFrame(Frame.ClientInfo, payload);
      log("ClientInfo sent");
    }

    sendFrame(type, payload) {
      if (!this.ws || this.ws.readyState !== 1) return;
      this.ws.send(encodeFrame(type, payload));
    }

    sendPacket(dstKey32, packet) {
      if (!this.loggedIn) {
        log("sendPacket before login");
      }
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
    for (const u of [
      "https://controlplane.tailscale.com/derpmap/default",
      "https://login.tailscale.com/derpmap/default",
    ]) {
      try {
        const r = await fetch(u, { mode: "cors" });
        if (r.ok) return await r.json();
      } catch (_) {}
    }
    return null;
  }

  function pickDerpWsUrl(map) {
    try {
      const regions = Object.values(map?.Regions || map?.regions || {});
      for (const r of regions) {
        for (const node of r.Nodes || r.nodes || []) {
          const host = node.HostName || node.hostname || node.IPv4;
          if (host) return `wss://${host}/derp`;
        }
      }
    } catch (_) {}
    return "wss://derp.tailscale.com/derp";
  }

  window.UserNetDerp = {
    Frame,
    DerpClient,
    fetchDefaultDerpMap,
    pickDerpWsUrl,
    loadNacl,
  };
})();

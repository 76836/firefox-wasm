/**
 * Step 4: WireGuard-shaped tunnel API.
 *
 * Full Noise_IK + WG data path is non-trivial; this module provides:
 *  - keypair helpers (X25519 via WebCrypto when available, else stub)
 *  - packet envelope API the TUN pump calls
 *  - pluggable backend: 'null' | 'derp' | future 'wasm'
 *
 * Spec: https://www.wireguard.com/protocol/
 */
(function () {
  function log(...a) {
    console.log("[usernet:wg]", ...a);
  }

  async function generateKeyPair() {
    // Prefer WebCrypto X25519 when available (newer Chrome)
    try {
      if (crypto.subtle?.generateKey) {
        const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, [
          "deriveBits",
        ]);
        const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
        return { publicKey: pub, privateKey: kp.privateKey, algo: "x25519-webcrypto" };
      }
    } catch (_) {}
    // Ephemeral random placeholder (NOT interoperable with real WG yet)
    const publicKey = crypto.getRandomValues(new Uint8Array(32));
    const privateKey = crypto.getRandomValues(new Uint8Array(32));
    log("using placeholder keys — real Noise_IK handshake not yet active");
    return { publicKey, privateKey, algo: "placeholder" };
  }

  class WireGuardSession {
    constructor({ privateKey, publicKey, peerPublicKey, sendRaw }) {
      this.privateKey = privateKey;
      this.publicKey = publicKey;
      this.peerPublicKey = peerPublicKey;
      this.sendRaw = sendRaw; // (u8) => void  — outer transport (DERP)
      this.recvHandlers = new Set();
      this.ready = false;
    }

    onPacket(fn) {
      this.recvHandlers.add(fn);
      return () => this.recvHandlers.delete(fn);
    }

    /** Outbound IP packet from TUN → encrypt → transport */
    async sendIpPacket(ipPacket) {
      // TODO: real WG transport data message
      // For now pass-through marker so the pipeline is testable end-to-end
      if (this.sendRaw) this.sendRaw(ipPacket);
    }

    /** Inbound from DERP → decrypt → IP */
    async handleIncoming(blob) {
      // TODO: decrypt WG data packet
      for (const h of this.recvHandlers) h(blob);
    }

    async handshake() {
      // TODO: Noise_IK initiation + response
      this.ready = this.algo !== "blocked";
      log("handshake stub — peer", this.peerPublicKey && this.peerPublicKey.length);
      return this.ready;
    }
  }

  window.UserNetWG = {
    generateKeyPair,
    WireGuardSession,
  };
})();

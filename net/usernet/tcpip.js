/**
 * Step 2–3: userspace TCP/IP + virtual TUN (lwIP via tcpip.js WASM).
 * Spec role: RFC 793 TCP + IP routing on a virtual interface.
 */
(function () {
  const TCPIP_ESM = "https://cdn.jsdelivr.net/npm/tcpip@0.4.0/+esm";

  let stack = null;
  let tun = null;
  let ready = null;
  const packetHandlers = new Set();

  function log(...a) {
    console.log("[usernet:tcpip]", ...a);
  }

  async function ensure() {
    if (stack) return stack;
    if (ready) return ready;
    ready = (async () => {
      log("loading tcpip.js WASM…");
      const mod = await import(TCPIP_ESM);
      const createStack = mod.createStack || mod.default?.createStack;
      if (!createStack) throw new Error("tcpip createStack missing");
      stack = await createStack({ initializeLoopback: true });
      // TUN for L3 packet I/O (step 3)
      if (typeof stack.createTunInterface === "function") {
        tun = await stack.createTunInterface({ ip: "100.64.0.1/10" });
      } else if (stack.interfaces?.createTun) {
        tun = await stack.interfaces.createTun({ ip: "100.64.0.1/10" });
      }
      if (tun?.readable) {
        // Drain TUN → transport hooks (must read or stack stalls)
        (async () => {
          try {
            const reader = tun.readable.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) {
                for (const h of packetHandlers) {
                  try {
                    h(value);
                  } catch (_) {}
                }
              }
            }
          } catch (e) {
            log("tun read ended", e.message || e);
          }
        })();
      }
      log("stack ready", tun ? "+tun" : "no-tun");
      return stack;
    })();
    return ready;
  }

  function onIpPacket(fn) {
    packetHandlers.add(fn);
    return () => packetHandlers.delete(fn);
  }

  async function injectIpPacket(u8) {
    await ensure();
    if (!tun?.writable) return false;
    const w = tun.writable.getWriter();
    try {
      await w.write(u8);
      return true;
    } finally {
      w.releaseLock();
    }
  }

  /**
   * Outbound TCP (step 2 API). Host can be dotted IP or name if stack DNS works.
   * Without a TUN transport to the internet, only on-stack / loopback targets work.
   */
  async function connectTcp(host, port, opts = {}) {
    const s = await ensure();
    const connect =
      s.connectTcp ||
      s.tcp?.connect ||
      (s.tcp && s.tcp.connect.bind(s.tcp));
    if (!connect) throw new Error("stack has no connectTcp");
    const conn = await connect.call(s.tcp || s, { host, port, ...opts });
    return {
      readable: conn.readable || conn,
      writable: conn.writable,
      close: () => {
        try {
          conn.close?.();
        } catch (_) {}
      },
      raw: conn,
    };
  }

  window.UserNetTcpip = {
    ensure,
    connectTcp,
    onIpPacket,
    injectIpPacket,
    getTun: () => tun,
    getStack: () => stack,
  };
})();

/**
 * Step 2–3: userspace TCP/IP + TUN (tcpip.js / lwIP WASM).
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
      log("loading tcpip.js…");
      const mod = await import(/* webpackIgnore: true */ TCPIP_ESM);
      const createStack = mod.createStack || mod.default?.createStack;
      if (!createStack) throw new Error("tcpip: createStack missing");

      stack = await createStack({
        initializeLoopback: true,
        // DNS inside stack is useless without egress; we resolve via DoH in socket.js
      });

      const createTun =
        stack.createTunInterface?.bind(stack) ||
        stack.interfaces?.createTun?.bind(stack.interfaces);

      if (createTun) {
        try {
          // CGNAT-ish range Tailscale-style
          tun = await createTun({ ip: "100.64.0.2/10" });
          log("TUN 100.64.0.2/10");
        } catch (e) {
          log("TUN create failed", e.message || e);
        }
      }

      if (tun?.readable) {
        (async () => {
          try {
            const reader = tun.readable.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value?.byteLength) continue;
              for (const h of packetHandlers) {
                try {
                  h(value);
                } catch (err) {
                  log("pkt handler", err.message || err);
                }
              }
            }
          } catch (e) {
            log("tun reader end", e.message || e);
          }
        })();
      }

      log("stack ready");
      return stack;
    })().catch((e) => {
      ready = null;
      throw e;
    });
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
      await w.write(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
      return true;
    } catch (e) {
      log("inject fail", e.message || e);
      return false;
    } finally {
      try {
        w.releaseLock();
      } catch (_) {}
    }
  }

  async function connectTcp(host, port) {
    const s = await ensure();
    let connectFn = null;
    if (typeof s.connectTcp === "function") connectFn = s.connectTcp.bind(s);
    else if (s.tcp && typeof s.tcp.connect === "function")
      connectFn = s.tcp.connect.bind(s.tcp);

    if (!connectFn) throw new Error("tcpip: no connectTcp on stack");

    const conn = await connectFn({ host: String(host), port: port | 0 });
    const readable = conn.readable || conn;
    const writable = conn.writable;
    if (!writable) throw new Error("tcpip: connection missing writable");

    return {
      readable,
      writable,
      close: () => {
        try {
          conn.close?.();
        } catch (_) {}
        try {
          writable.getWriter?.().close?.();
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

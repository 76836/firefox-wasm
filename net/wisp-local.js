/**
 * In-page Wisp server for Gecko-WASM.
 *
 * Upstream WISP client always does: new WebSocket(Module.wispUrl)
 * We cannot patch the closed-over WISP object, so we:
 *   1) Set Module.wispUrl = "wss://wisp.local/ts"
 *   2) Intercept WebSocket construction for that host
 *   3) Speak Wisp frames in-process and dial outbound TCP
 *
 * Dial order:
 *   a) Direct Sockets TCPSocket (if available)
 *   b) Probe Tailscale IPN for a dial-like method
 *   c) Else error the stream (ECONNREFUSED / 111)
 *
 * Protocol (client → server), from gecko index-D39giZCc.js:
 *   frame = [type u8][streamId u32 le][payload…]
 *   type 1 CONNECT payload: [1 u8][port u16 le][host utf8]
 *   type 2 DATA
 *   type 4 CLOSE  (client may send 6-byte frame with reason u8)
 * Server → client: type 2 data, type 4 eof
 */
(function () {
  const MAGIC_HOST = "wisp.local";
  const MAGIC_URLS = new Set([
    "wss://wisp.local/ts",
    "ws://wisp.local/ts",
    "wss://wisp.local/",
    "ws://wisp.local/",
  ]);

  const streams = new Map(); // id -> { cancel, writer? }
  let installed = false;
  let OrigWebSocket = null;

  function log(...a) {
    console.log("[wisp-local]", ...a);
  }

  function isMagic(url) {
    try {
      const u = String(url);
      if (MAGIC_URLS.has(u)) return true;
      return u.includes("wisp.local");
    } catch {
      return false;
    }
  }

  /** Deliver bytes from remote → gecko (server DATA frame path). */
  function deliverToGecko(ws, streamId, bytes) {
    if (!bytes || !bytes.length) return;
    const out = new Uint8Array(5 + bytes.length);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, 2);
    dv.setUint32(1, streamId >>> 0, true);
    out.set(bytes, 5);
    ws._emitMessage(out);
  }

  function deliverEof(ws, streamId) {
    const out = new Uint8Array(5);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, 4);
    dv.setUint32(1, streamId >>> 0, true);
    ws._emitMessage(out);
  }

  async function dialTcp(host, port) {
    // 1) Direct Sockets API (Chrome IWA / experimental)
    try {
      const TCPSocket = globalThis.TCPSocket || globalThis.TCPSocket;
      if (typeof TCPSocket === "function") {
        const sock = new TCPSocket(host, port, { noDelay: true });
        const opened = await sock.opened;
        log("dial DirectSocket", host, port);
        return {
          readable: opened.readable || sock.readable,
          writable: opened.writable || sock.writable,
          close: () => {
            try {
              sock.close?.();
            } catch (_) {}
          },
        };
      }
    } catch (e) {
      log("DirectSocket fail", host, port, e.message || e);
    }

    // 2) Probe Tailscale IPN for anything dial-like
    try {
      const ipn = window.FFTailscale && (await window.FFTailscale.ensureIpn?.());
      if (ipn) {
        const candidates = ["dial", "dialTCP", "connect", "openConnection", "tcpConnect"];
        for (const name of candidates) {
          if (typeof ipn[name] === "function") {
            log("ipn." + name, host, port);
            const conn = await ipn[name](host, port);
            if (conn && (conn.readable || conn.read)) {
              return normalizeIpnConn(conn);
            }
          }
        }
      }
    } catch (e) {
      log("ipn dial probe", e.message || e);
    }

    // 3) chrome.sockets.tcp (Chrome apps — rare)
    try {
      const cst = globalThis.chrome?.sockets?.tcp;
      if (cst?.create) {
        const conn = await chromeTcpConnect(cst, host, port);
        if (conn) return conn;
      }
    } catch (e) {
      log("chrome.sockets", e.message || e);
    }

    throw new Error("no TCP dialer (need Direct Sockets or IPN.dial)");
  }

  function normalizeIpnConn(conn) {
    if (conn.readable && conn.writable) {
      return {
        readable: conn.readable,
        writable: conn.writable,
        close: () => conn.close?.(),
      };
    }
    // callback style
    return null;
  }

  function chromeTcpConnect(cst, host, port) {
    return new Promise((resolve, reject) => {
      cst.create({}, (createInfo) => {
        const id = createInfo.socketId;
        cst.connect(id, host, port, (result) => {
          if (result < 0) {
            reject(new Error("chrome.tcp connect " + result));
            return;
          }
          const queue = [];
          let pending = null;
          const onRecv = (info) => {
            if (info.socketId !== id) return;
            const u8 = new Uint8Array(info.data);
            if (pending) {
              const p = pending;
              pending = null;
              p(u8);
            } else queue.push(u8);
          };
          chrome.sockets.tcp.onReceive.addListener(onRecv);
          const readable = new ReadableStream({
            pull(controller) {
              if (queue.length) {
                controller.enqueue(queue.shift());
                return;
              }
              return new Promise((r) => {
                pending = (u8) => {
                  controller.enqueue(u8);
                  r();
                };
              });
            },
            cancel() {
              chrome.sockets.tcp.onReceive.removeListener(onRecv);
              cst.close(id);
            },
          });
          const writable = new WritableStream({
            write(chunk) {
              return new Promise((res, rej) => {
                cst.send(id, chunk.buffer, (s) => (s < 0 ? rej() : res()));
              });
            },
            close() {
              cst.close(id);
            },
          });
          resolve({
            readable,
            writable,
            close: () => {
              try {
                chrome.sockets.tcp.onReceive.removeListener(onRecv);
                cst.close(id);
              } catch (_) {}
            },
          });
        });
      });
    });
  }

  async function handleConnect(ws, streamId, host, port) {
    log("CONNECT", streamId, host + ":" + port);
    try {
      const tcp = await dialTcp(host, port);
      const reader = tcp.readable.getReader();
      const writer = tcp.writable.getWriter();
      let cancelled = false;
      streams.set(streamId, {
        cancel() {
          cancelled = true;
          try {
            reader.cancel();
          } catch (_) {}
          try {
            writer.close();
          } catch (_) {}
          try {
            tcp.close?.();
          } catch (_) {}
        },
        writer,
      });

      // remote → gecko
      (async () => {
        try {
          while (!cancelled) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.byteLength) deliverToGecko(ws, streamId, value);
          }
        } catch (e) {
          log("read err", streamId, e.message || e);
        } finally {
          deliverEof(ws, streamId);
          streams.delete(streamId);
        }
      })();
    } catch (e) {
      log("CONNECT fail", host, port, e.message || e);
      deliverEof(ws, streamId);
      streams.delete(streamId);
    }
  }

  function onClientFrame(ws, data) {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (u8.length < 5) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const type = dv.getUint8(0);
    const id = dv.getUint32(1, true);

    if (type === 1) {
      // CONNECT: payload after 5-byte header
      const payload = u8.subarray(5);
      if (payload.length < 3) return;
      const pdv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      // first byte often 1 (tcp)
      const port = pdv.getUint16(1, true);
      const host = new TextDecoder().decode(payload.subarray(3));
      handleConnect(ws, id, host, port);
      return;
    }
    if (type === 2) {
      const st = streams.get(id);
      if (!st?.writer) return;
      const chunk = u8.subarray(5);
      st.writer.write(chunk).catch((e) => log("write err", id, e.message || e));
      return;
    }
    if (type === 4) {
      const st = streams.get(id);
      if (st) {
        st.cancel();
        streams.delete(id);
      }
    }
  }

  function createFakeWebSocket(url) {
    const listeners = { open: [], message: [], close: [], error: [] };
    const ws = {
      url: String(url),
      readyState: 0, // CONNECTING
      bufferedAmount: 0,
      protocol: "",
      extensions: "",
      binaryType: "arraybuffer",
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      addEventListener(type, fn) {
        (listeners[type] || (listeners[type] = [])).push(fn);
      },
      removeEventListener(type, fn) {
        const a = listeners[type];
        if (!a) return;
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      },
      _emit(type, event) {
        const a = listeners[type] || [];
        a.forEach((fn) => {
          try {
            fn(event);
          } catch (_) {}
        });
        const h = ws["on" + type];
        if (typeof h === "function") {
          try {
            h(event);
          } catch (_) {}
        }
      },
      _emitMessage(u8) {
        const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
        ws._emit("message", { data: buf });
      },
      send(data) {
        if (ws.readyState !== 1) return;
        let u8;
        if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
        else if (data instanceof Uint8Array) u8 = data;
        else if (ArrayBuffer.isView(data))
          u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        else return;
        onClientFrame(ws, u8);
      },
      close() {
        if (ws.readyState === 3) return;
        ws.readyState = 3;
        streams.forEach((st, id) => {
          try {
            st.cancel();
          } catch (_) {}
        });
        streams.clear();
        ws._emit("close", { code: 1000, reason: "" });
      },
    };

    // open async (match real WS)
    queueMicrotask(() => {
      ws.readyState = 1; // OPEN
      ws._emit("open", {});
    });
    return ws;
  }

  function installWebSocketHook() {
    if (installed) return;
    installed = true;
    OrigWebSocket = globalThis.WebSocket;
    function HookedWebSocket(url, protocols) {
      if (isMagic(url)) {
        log("intercept", url);
        return createFakeWebSocket(url);
      }
      if (protocols === undefined) return new OrigWebSocket(url);
      return new OrigWebSocket(url, protocols);
    }
    HookedWebSocket.prototype = OrigWebSocket.prototype;
    HookedWebSocket.CONNECTING = 0;
    HookedWebSocket.OPEN = 1;
    HookedWebSocket.CLOSING = 2;
    HookedWebSocket.CLOSED = 3;
    globalThis.WebSocket = HookedWebSocket;
    log("WebSocket hook installed");
  }

  function enableForModule() {
    installWebSocketHook();
    const url = "wss://wisp.local/ts";
    try {
      if (window.Module) window.Module.wispUrl = url;
    } catch (_) {}
    const el = document.getElementById("opt-wisp");
    if (el) el.value = url;
    try {
      const o = JSON.parse(localStorage.getItem("chrome-demo-opts") || "{}");
      o.wisp = url;
      localStorage.setItem("chrome-demo-opts", JSON.stringify(o));
    } catch (_) {}
    log("Module.wispUrl →", url);
    return url;
  }

  function disable() {
    if (OrigWebSocket) globalThis.WebSocket = OrigWebSocket;
    installed = false;
  }

  window.WispLocal = {
    install: installWebSocketHook,
    enable: enableForModule,
    disable,
    MAGIC_URLS,
  };

  // Auto-hook early so first WebSocket construct is caught
  installWebSocketHook();
})();

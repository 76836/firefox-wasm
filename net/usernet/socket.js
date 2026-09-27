/**
 * Step 1 — Socket API
 * Bidirectional byte streams for Gecko/Wisp: connect, read, write, close.
 * Resolves hostnames via browser DoH so TCP layer can dial by IP.
 */
(function () {
  function log(...a) {
    console.log("[usernet:sock]", ...a);
  }

  async function resolveHost(host) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
    // Browser DoH (does not need our TUN)
    try {
      const url =
        "https://cloudflare-dns.com/dns-query?name=" +
        encodeURIComponent(host) +
        "&type=A";
      const r = await fetch(url, { headers: { Accept: "application/dns-json" } });
      const j = await r.json();
      const a = (j.Answer || []).find((x) => x.type === 1);
      if (a?.data) {
        log("DoH", host, "→", a.data);
        return a.data;
      }
    } catch (e) {
      log("DoH fail", host, e.message || e);
    }
    return host;
  }

  /**
   * @returns {Promise<{readable:ReadableStream, writable:WritableStream, close:Function}>}
   */
  async function connect(host, port) {
    const ip = await resolveHost(host);
    if (!window.UserNetTcpip?.connectTcp) {
      throw new Error("tcpip layer not loaded");
    }
    const conn = await window.UserNetTcpip.connectTcp(ip, port | 0);
    log("connected", host, ip + ":" + port);
    return conn;
  }

  window.UserNetSocket = { connect, resolveHost };
})();

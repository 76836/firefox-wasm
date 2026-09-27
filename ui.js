/**
 * ui.js — CLI + polished splash. Talks only to GeckoHost.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const polished =
    params.get("mode") === "polished" || params.get("polished") === "1";

  const $ = (id) => document.getElementById(id);
  const term = $("term");
  const out = $("term-out");
  const input = $("term-in");
  const polish = $("polish");
  const polishFill = $("polish-fill");
  const fabs = $("fabs");
  const kbCap = $("kb-capture");

  function log(msg, cls) {
    if (polished) return; // silent polished
    if (!out) return;
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = msg;
    out.appendChild(d);
    while (out.childElementCount > 150) out.firstChild.remove();
    out.scrollTop = out.scrollHeight;
  }

  function setProgress(pct) {
    if (!polished || !polishFill || pct == null) return;
    polishFill.style.width = Math.round(Math.min(1, Math.max(0, pct)) * 100) + "%";
  }

  function hideChrome() {
    term?.classList.add("hide");
    fabs?.classList.add("hide");
    polish?.classList.add("hide");
    kbCap?.classList.remove("on");
    try {
      $("screen")?.focus();
    } catch (_) {}
  }

  function showTerm(show) {
    if (polished || !term) return;
    term.classList.toggle("hide", !show);
    if (show) setTimeout(() => input?.focus(), 30);
  }

  function isolationOk() {
    return !!window.crossOriginIsolated;
  }

  function showIsolationHelp() {
    if (document.getElementById("coi-banner")) return;
    const inIframe = window !== window.top;
    const b = document.createElement("div");
    b.id = "coi-banner";
    b.className = "coi-banner";
    b.innerHTML = inIframe
      ? "Firefox needs a top-level window for SharedArrayBuffer. Open it outside this iframe (WebDesk should use a popup)."
      : "Page is not cross-origin isolated. Hard-refresh once. If it keeps failing, clear site data for this origin.";
    document.body.appendChild(b);
  }

  async function doLaunch() {
    if (!isolationOk()) {
      log("not crossOriginIsolated — cannot load Gecko workers", "e");
      showIsolationHelp();
      return;
    }
    if (window.WebDeskFS) {
      try {
        const r = await window.WebDeskFS.syncToOpfs((m) => console.log("[WebDeskFS]", m));
        console.log("[WebDeskFS] pre-launch", r);
      } catch (e) {
        console.warn("[WebDeskFS] pre-launch failed", e);
      }
    }
    setProgress(0.55);
    const ok = await window.GeckoHost.launch({ gpu: true, jit: false });
    if (!ok) log("launch refused", "e");
  }

  function bind() {
    const H = window.GeckoHost;
    if (!H) {
      log("GeckoHost missing", "e");
      return;
    }
    H.on(H.EV.progress, (e) => {
      const p = e.detail || {};
      if (p.message) log(p.message, "dim");
      if (p.percent != null) setProgress(p.percent);
    });
    H.on(H.EV.ready, () => {
      log("ready", "ok");
      setProgress(0.85);
      $("btn-launch")?.classList.remove("hide");
      if (polished || localStorage.getItem("ffwasm.autostart") === "1") {
        doLaunch();
      }
    });
    H.on(H.EV.booted, () => {
      log("firefox up", "ok");
      setProgress(1);
      hideChrome();
      H.sizeCanvas();
    });
    H.on(H.EV.error, (e) => {
      log((e.detail && e.detail.message) || "error", "e");
    });
  }

  function runCmd(line) {
    const s = (line || "").trim();
    if (!s) return;
    const parts =
      s.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, "")) || [];
    const c = (parts[0] || "").toLowerCase();
    const H = window.GeckoHost;

    if (c === "help" || c === "?") {
      log("Firefox-WASM CLI", "ok");
      log("  version          show build commit", "dim");
      log("  login | ts login open Tailscale login (use an exit node on your tailnet)", "dim");
      log("  ts status        Tailscale + exit node state", "dim");
      log("  online           login + auto-arm exit node path", "dim");
      log("  status           short network / stack summary", "dim");
      log("  launch           start Firefox", "dim");
      log("  usernet status   detailed UserNet (tcpip/wg/derp)", "dim");
      log("  net wisp <url>   remote Wisp (optional)", "dim");
      log("  sync             WebDesk files → OPFS", "dim");
      log("  set gpu|jit|wisp|autostart …", "dim");
      return;
    }
    if (c === "clear") {
      if (out) out.innerHTML = "";
      return;
    }
    if (c === "status") {
      const v = H.viewport();
      log(
        "ready=" +
          H.isReady() +
          " jspi=" +
          H.jspiOk() +
          " coi=" +
          isolationOk() +
          " " +
          v.w +
          "x" +
          v.h
      );
      return;
    }
    if (c === "launch" || c === "start" || c === "run") return doLaunch();



    if (c === "version" || c === "ver" || c === "commit") {
      const v = window.FF_VERSION || {};
      log("commit " + (v.short || "?") + "  " + (v.commit || ""), "ok");
      log("built  " + (v.date || "?"), "dim");
      return;
    }

    if (c === "login" || c === "ts login") {
      const T = window.FFTailscale;
      if (!T) {
        log("Tailscale module missing (net/tailscale.js)", "e");
        return;
      }
      log("Opening Tailscale login…", "dim");
      log("Finish sign-in in the popup, then come back here.", "dim");
      T.login().then((r) => {
        if (!r || !r.ok) {
          log("login failed: " + (r && r.message ? r.message : "unknown"), "e");
          return;
        }
        log(r.message || "login started", "ok");
        if (r.loginUrl) log("url " + r.loginUrl, "dim");
        // poll status a few times
        let n = 0;
        const iv = setInterval(() => {
          n++;
          const s = T.status();
          log("ts " + s.state + (s.ip ? "  ip " + s.ip : "") + (s.exitPeer ? "  exit " + (s.exitPeer.name || "yes") : ""), "dim");
          if (s.state === "Running" || n >= 30) clearInterval(iv);
          if (s.state === "Running" && s.exitPeer && !s.exitPeer.notExit) {
            log("Exit node seen — arming UserNet…", "ok");
            window.UserNet?.onTailscaleReady?.(s);
          }
        }, 2000);
      }).catch((e) => log(String(e.message || e), "e"));
      return;
    }

    if (c === "ts" || c.startsWith("ts ")) {
      const sub = c === "ts" ? "status" : c.slice(3).trim();
      const T = window.FFTailscale;
      if (!T) {
        log("Tailscale module missing", "e");
        return;
      }
      if (sub === "login") {
        log("Opening Tailscale login…", "dim");
        T.login().then((r) => {
          if (!r?.ok) log("login failed: " + (r?.message || "unknown"), "e");
          else {
            log(r.message || "ok", "ok");
            if (r.loginUrl) log(r.loginUrl, "dim");
          }
        }).catch((e) => log(String(e.message || e), "e"));
        return;
      }
      if (sub === "logout") {
        log(JSON.stringify(T.logout()), "dim");
        return;
      }
      if (sub === "status" || sub === "") {
        const s = T.status();
        log("Tailscale: " + s.state, s.state === "Running" ? "ok" : "dim");
        if (s.ip) log("  IP      " + s.ip, "dim");
        if (s.self) log("  self    " + s.self, "dim");
        log("  peers   " + (s.peers || 0), "dim");
        if (s.exitPeer) {
          log(
            "  exit    " +
              (s.exitPeer.name || "?") +
              (s.exitPeer.notExit ? " (peer, not exit)" : "") +
              (s.exitPeer.online === false ? " offline" : ""),
            "ok"
          );
        } else {
          log("  exit    (none — advertise an exit node and approve it in admin)", "w");
        }
        if (s.loginUrl && s.state !== "Running") log("  login   " + s.loginUrl, "dim");
        return;
      }
      if (sub.startsWith("wisp ")) {
        T.applyWisp(sub.slice(5).trim());
        log("wisp set", "ok");
        return;
      }
      log("ts login | status | logout | wisp <url>", "dim");
      return;
    }

    if (c === "online") {
      log("Login + arm exit-node path…", "dim");
      const U = window.UserNet;
      if (!U) {
        log("UserNet missing", "e");
        return;
      }
      U.enableInternetPath().then((s) => {
        log("Tailscale: " + (s.tailscale || "?"), "dim");
        log("Exit: " + (s.exitPeer && s.exitPeer.name ? s.exitPeer.name : "none"), s.exitPeer ? "ok" : "w");
        log("DERP: " + (s.derp ? "up" : "down") + "  WG: " + (s.wgReady ? "ready" : "pending"), "dim");
        log(s.tip || "", "dim");
      }).catch((e) => log(String(e.message || e), "e"));
      return;
    }

    if (c === "status") {
      const T = window.FFTailscale?.status?.() || {};
      const U = window.UserNet?.status?.() || {};
      const v = window.FF_VERSION || {};
      log("build   " + (v.label || v.short || "?"), "ok");
      log("ts      " + (T.state || "n/a") + (T.ip ? "  " + T.ip : ""), "dim");
      log(
        "exit    " +
          (T.exitPeer ? T.exitPeer.name || "yes" : "none") +
          (T.exitPeer && T.exitPeer.notExit ? " (not exit flag)" : ""),
        "dim"
      );
      log(
        "stack   tcpip=" +
          !!U.tcpip +
          " tun=" +
          !!U.tun +
          " derp=" +
          !!U.derp +
          " wg=" +
          !!U.wgReady,
        "dim"
      );
      if (U.tip) log(U.tip, "dim");
      return;
    }

    if (c === "usernet" || c.startsWith("usernet ")) {
      const sub = c === "usernet" ? "status" : c.slice(8).trim();
      const U = window.UserNet;
      if (!U) { log("UserNet missing", "e"); return; }
      if (sub === "status" || sub === "") {
        log(JSON.stringify(U.status()), "dim");
        return;
      }
      if (sub === "start") {
        U.start().then((s) => log(JSON.stringify(s), "ok"));
        return;
      }
      if (sub === "online" || sub === "internet") {
        log("seamless: login + auto exit node…", "dim");
        U.enableInternetPath().then((s) => log(JSON.stringify(s), "ok"));
        return;
      }
      if (sub.startsWith("peer ")) {
        const hex = sub.slice(5).trim();
        log("exit peer key…", "dim");
        U.setExitPeerKey(hex).then((s) => log(JSON.stringify(s), "ok"));
        return;
      }
      log("usernet status|start|online|peer <hex64>", "dim");
      return;
    }
    if (c === "net" || c.startsWith("net ")) {
      const sub = c === "net" ? "status" : c.slice(4).trim();
      const N = window.NetStack;
      if (!N) { log("NetStack missing", "e"); return; }
      if (sub === "status" || sub === "") {
        log(JSON.stringify(N.status(), null, 0), "dim");
        return;
      }
      if (sub.startsWith("wisp ")) {
        log(JSON.stringify(N.setWisp(sub.slice(5).trim())), "ok");
        return;
      }
      if (sub.startsWith("mode ")) {
        log(JSON.stringify(N.setMode(sub.slice(5).trim())), "ok");
        return;
      }
      log("net status | wisp wss://host:port/ | mode off|remote|local", "dim");
      return;
    }
    if (c === "sync") {
      window.WebDeskFS?.syncAll((m) => log(m, "dim")).then((r) =>
        log("synced opfs=" + (r?.opfs?.files||0) + " memfs=" + (r?.memfs?.files||0), "ok")
      );
      return;
    }
    if (c === "set") {
      const k = (parts[1] || "").toLowerCase();
      const v = parts.slice(2).join(" ").trim();
      const on = /^(1|on|true|yes)$/i.test(v);
      if (k === "gpu") {
        H.setGpu(on);
        log("gpu " + (on ? "on" : "off"));
      } else if (k === "jit") {
        H.setJit(on);
        log("jit " + (on ? "on" : "off"));
      } else if (k === "wisp") {
        H.setWisp(!v || /^off$/i.test(v) ? "" : v);
        log("wisp " + (v || "off"));
      } else if (k === "autostart") {
        localStorage.setItem("ffwasm.autostart", on ? "1" : "0");
        log("autostart " + (on ? "on" : "off"));
      } else log("set gpu|jit|wisp|autostart");
      return;
    }
    log("unknown: " + c + "  (try help)", "w");
  }

  function setupUi() {
    if (polished) {
      term?.classList.add("hide");
      fabs?.classList.add("hide");
      polish?.classList.remove("hide");
      setProgress(0.08);
    } else {
      polish?.classList.add("hide");
      const v = window.FF_VERSION || {};
      log("firefox-wasm  " + (v.label || v.short || "dev"), "ok");
      log("type help · login · online · status · launch", "dim");
      showTerm(true);
    }

    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = input.value;
        input.value = "";
        runCmd(v);
      }
    });
    $("btn-term")?.addEventListener("click", () =>
      showTerm(term?.classList.contains("hide"))
    );
    $("btn-launch")?.addEventListener("click", () => doLaunch());
    $("btn-kb")?.addEventListener("click", () => {
      kbCap?.classList.toggle("on");
      if (kbCap?.classList.contains("on")) kbCap.focus();
      else {
        kbCap?.blur();
        try {
          $("screen")?.focus();
        } catch (_) {}
      }
    });

    if (!isolationOk() && window !== window.top) {
      showIsolationHelp();
    }
  }

  function start() {
    if (!window.GeckoHost) {
      console.error("GeckoHost not loaded");
      return;
    }
    window.GeckoHost?.on?.(window.GeckoHost.EV?.booted || "gecko:booted", () => {
      window.WebDeskFS?.injectIntoModuleFs?.((m) => console.log("[WebDeskFS]", m)).then((r) =>
        console.log("[WebDeskFS] post-boot", r)
      );
    });
    window.NetStack?.boot?.();
    window.GeckoHost.init();
    bind();
    setupUi();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

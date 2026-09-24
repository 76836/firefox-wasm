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
      setProgress(0.35);
      try {
        await window.WebDeskFS.syncToOpfs(() => {});
      } catch (_) {}
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

    if (c === "help") {
      log("launch · status · sync · set gpu|jit|wisp|autostart");
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
    if (c === "sync") {
      window.WebDeskFS?.syncToOpfs((m) => log(m, "dim")).then((r) =>
        log("synced " + (r?.files || 0), "ok")
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
    log("?", "w");
  }

  function setupUi() {
    if (polished) {
      term?.classList.add("hide");
      fabs?.classList.add("hide");
      polish?.classList.remove("hide");
      setProgress(0.08);
    } else {
      polish?.classList.add("hide");
      log("firefox-wasm");
      log("type help", "dim");
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

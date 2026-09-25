/**
 * gecko-host.js — stable Firefox-WASM boot API
 *
 * Owns: required upstream DOM, viewport, readiness, launch.
 * Upstream module (assets/index-*.js) binds to fixed element IDs.
 * UI layers should only call GeckoHost.* and listen to events.
 */
(function (global) {
  "use strict";

  const EV = {
    progress: "gecko:progress",
    ready: "gecko:ready",
    launch: "gecko:launch",
    booted: "gecko:booted",
    error: "gecko:error",
  };

  // Native viewport — never override window.innerWidth (that caused stack overflow)
  function viewport() {
    const w = Math.max(1, window.innerWidth | 0);
    const h = Math.max(1, window.innerHeight | 0);
    return { w, h };
  }

  function el(id) {
    return document.getElementById(id);
  }

  function ensureUpstreamDom() {
    // Upstream requires these IDs. Create if missing so HTML can stay minimal.
    let splash = el("splash");
    if (!splash) {
      splash = document.createElement("section");
      splash.id = "splash";
      splash.setAttribute("aria-hidden", "true");
      splash.style.cssText =
        "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);opacity:0;pointer-events:none";
      splash.innerHTML = `
        <div id="splash-shell" class="stage">
          <div id="stage-card" class="stage">
            <div class="progress-track"><div id="progress-fill"></div></div>
            <span id="progress-phase"></span>
            <span id="progress-percent"></span>
            <p id="splash-status"></p>
          </div>
          <button id="start-btn" type="button">Launch</button>
          <p id="jspi-note" hidden></p>
          <details class="advanced"><summary></summary>
            <input type="checkbox" id="opt-gpu" checked />
            <input type="checkbox" id="opt-jit" />
            <input type="text" id="opt-wisp" value="" />
          </details>
          <div id="console-output"></div>
        </div>`;
      document.body.appendChild(splash);
    }
    if (!el("screen")) {
      const c = document.createElement("canvas");
      c.id = "screen";
      c.width = 1;
      c.height = 1;
      c.tabIndex = 0;
      document.body.insertBefore(c, document.body.firstChild);
    }
  }

  function sizeCanvas() {
    const canvas = el("screen");
    if (!canvas) return viewport();
    const { w, h } = viewport();
    // 1 CSS px = 1 buffer px — no stretch
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    return { w, h };
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (_) {}
  }

  function jspiOk() {
    return (
      typeof WebAssembly.Suspending === "function" &&
      typeof WebAssembly.promising === "function"
    );
  }

  let ready = false;
  let booted = false;
  let watching = false;

  function readProgress() {
    const st = el("splash-status")?.textContent?.trim() || "";
    const ph = el("progress-phase")?.textContent?.trim() || "";
    const pc = el("progress-percent")?.textContent?.trim() || "";
    const msg = [ph, pc, st].filter(Boolean).join(" ");
    let percent = null;
    const m = /(\d+)\s*%/.exec(pc || msg);
    if (m) percent = +m[1] / 100;
    return { message: msg, percent, status: st, phase: ph };
  }

  function watchUpstream() {
    if (watching) return;
    watching = true;
    let last = "";

    // Progress from upstream Be() writing splash nodes
    setInterval(() => {
      const p = readProgress();
      if (p.message && p.message !== last) {
        last = p.message;
        emit(EV.progress, p);
      }
      const btn = el("start-btn");
      if (btn && !btn.disabled && !ready) {
        ready = true;
        emit(EV.ready, { jspi: jspiOk() });
      }
      const note = el("jspi-note");
      if (note && !note.hidden && note.textContent && !note.dataset.emitted) {
        note.dataset.emitted = "1";
        emit(EV.error, { message: note.textContent });
      }
    }, 200);

    // Boot / error from console
    const hook = (fn) =>
      function (...args) {
        try {
          fn.apply(console, args);
        } catch (_) {}
        const s = args.map(String).join(" ");
        if (/front-end booted/i.test(s)) {
          booted = true;
          emit(EV.booted, {});
          try { softenSessionStore(); } catch (_) {}
          sizeCanvas();
          try {
            window.dispatchEvent(new Event("resize"));
          } catch (_) {}
        }
        if (/startup failed/i.test(s)) {
          emit(EV.error, { message: s });
        }
        if (/chrome assets ready/i.test(s) && !ready) {
          // button enable is authoritative; this is informational
          emit(EV.progress, { message: "assets ready", percent: 0.7 });
        }
      };
    console.log = hook(console.log.bind(console));
    console.warn = hook(console.warn.bind(console));
    console.error = hook(console.error.bind(console));
    // Upstream rebinds console after load
    setTimeout(() => {
      console.log = hook(console.log.bind(console));
      console.warn = hook(console.warn.bind(console));
      console.error = hook(console.error.bind(console));
    }, 500);
  }

  /**
   * @param {{ gpu?: boolean, jit?: boolean, wisp?: string }} [opts]
   */
  async function launch(opts) {
    opts = opts || {};
    const btn = el("start-btn");
    if (!btn) {
      emit(EV.error, { message: "start-btn missing" });
      return false;
    }
    if (!ready && btn.disabled) {
      emit(EV.error, { message: "assets not ready" });
      return false;
    }
    if (!window.crossOriginIsolated) {
      emit(EV.error, {
        message:
          "Not crossOriginIsolated — SharedArrayBuffer blocked. Open as a top-level window (not an iframe).",
      });
      return false;
    }
    if (!jspiOk()) {
      emit(EV.error, {
        message:
          "WebAssembly JSPI required. Chrome/Edge recent, or Firefox about:config javascript.options.wasm_js_promise_integration",
      });
      return false;
    }

    if (typeof opts.gpu === "boolean" && el("opt-gpu")) el("opt-gpu").checked = opts.gpu;
    if (typeof opts.jit === "boolean" && el("opt-jit")) el("opt-jit").checked = opts.jit;
    if (typeof opts.wisp === "string" && el("opt-wisp")) el("opt-wisp").value = opts.wisp;

    // Clear poisoned wisp strings
    const wispEl = el("opt-wisp");
    if (wispEl && /not authorized|github\.io/i.test(wispEl.value) && !/^wss?:/i.test(wispEl.value)) {
      wispEl.value = "";
    }

    // OPFS mount is opt-in only (?opfs=1). Forcing it collides with SessionStore
    // profile I/O and has been observed to trip wasm "unreachable" freezes.
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("opfs") === "1" || opts.opfs === true) {
        u.searchParams.set("env.GECKO_OPFS_MOUNT", "1");
      } else {
        u.searchParams.delete("env.GECKO_OPFS_MOUNT");
      }
      history.replaceState(null, "", u.pathname + u.search + u.hash);
    } catch (_) {}

    sizeCanvas();
    emit(EV.launch, { ...viewport() });
    btn.disabled = false;
    btn.click();
    setTimeout(sizeCanvas, 400);
    setTimeout(() => {
      sizeCanvas();
      try {
        window.dispatchEvent(new Event("resize"));
      } catch (_) {}
    }, 1500);
    return true;
  }

  function setGpu(on) {
    if (el("opt-gpu")) el("opt-gpu").checked = !!on;
  }
  function setJit(on) {
    if (el("opt-jit")) el("opt-jit").checked = !!on;
  }
  function setWisp(url) {
    if (el("opt-wisp")) el("opt-wisp").value = url || "";
  }


  /** Soften SessionStore after front-end is up (best-effort). */
  function softenSessionStore() {
    try {
      // Upstream chrome-demo sometimes exposes eval helpers on window
      const ev =
        window.evalChrome ||
        window.chromeEval ||
        (window.Module && window.Module.evalChrome);
      if (typeof ev !== "function") return false;
      ev(`(() => {
        try {
          const p = Services.prefs;
          p.setBoolPref("browser.sessionstore.resume_from_crash", false);
          p.setIntPref("browser.sessionstore.interval", 600000);
          p.setIntPref("browser.sessionstore.max_tabs_undo", 5);
          p.setIntPref("browser.sessionstore.max_windows_undo", 2);
          p.setBoolPref("browser.sessionstore.restore_on_demand", true);
          return "sessionstore-softened";
        } catch (e) { return String(e); }
      })()`);
      return true;
    } catch (_) {
      return false;
    }
  }

  function init() {
    ensureUpstreamDom();
    sizeCanvas();
    window.addEventListener("resize", sizeCanvas);
    watchUpstream();

    // scrub bad localStorage from puter demo
    try {
      const o = JSON.parse(localStorage.getItem("chrome-demo-opts") || "{}");
      if (o.wisp && /not authorized|puter\.work|github\.io/i.test(String(o.wisp))) {
        o.wisp = "";
        localStorage.setItem("chrome-demo-opts", JSON.stringify(o));
      }
    } catch (_) {}
  }

  const api = {
    EV,
    init,
    launch,
    sizeCanvas,
    viewport,
    jspiOk,
    isReady: () => ready,
    isBooted: () => booted,
    softenSessionStore,
    setGpu,
    setJit,
    setWisp,
    on(event, fn) {
      window.addEventListener(event, fn);
      return () => window.removeEventListener(event, fn);
    },
  };

  global.GeckoHost = api;
})(window);

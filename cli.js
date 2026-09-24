/** Minimal Firefox WASM CLI — progress + launch. Autostart default off. */
(function () {
  const out = document.getElementById("term-out");
  const input = document.getElementById("term-in");
  const term = document.getElementById("term");
  let ready = false;
  let lastProg = "";

  function line(t, cls) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = t;
    out.appendChild(d);
    out.scrollTop = out.scrollHeight;
  }

  // intercept console (before & after upstream rebinds — use interval mirror of status nodes)
  const raw = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  function pipe(fn, cls) {
    return (...a) => {
      fn(...a);
      const s = a.map(String).join(" ");
      if (/startup failed|Error|error|failed/i.test(s) && !/options\.wasm/i.test(s))
        line(s, "e");
      else if (/chrome assets ready|front-end booted|init done/i.test(s))
        line(s, "ok");
      else if (/\[gecko\]|\[chrome-demo\]/i.test(s))
        line(s, "dim");
    };
  }
  console.log = pipe(raw.log);
  console.warn = pipe(raw.warn, "w");
  console.error = pipe(raw.error, "e");

  // Re-hook after upstream module overwrites console
  setTimeout(() => {
    const Vlog = console.log;
    const Vwarn = console.warn;
    const Verr = console.error;
    console.log = pipe(Vlog.bind(console));
    console.warn = pipe(Vwarn.bind(console));
    console.error = pipe(Verr.bind(console));
  }, 0);
  setTimeout(() => {
    const Vlog = console.log;
    const Vwarn = console.warn;
    const Verr = console.error;
    console.log = pipe(Vlog.bind(console));
    console.warn = pipe(Vwarn.bind(console));
    console.error = pipe(Verr.bind(console));
  }, 500);

  function status() {
    const jspi = typeof WebAssembly.Suspending === "function" &&
      typeof WebAssembly.promising === "function";
    line("jspi " + (jspi ? "ok" : "MISSING") +
      " · coi " + !!crossOriginIsolated +
      " · assets " + (ready ? "ready" : "…") +
      " · gpu " + (gpuOn() ? "on" : "off") +
      " · jit " + (jitOn() ? "on" : "off"));
  }

  function gpuOn() { return !!document.getElementById("opt-gpu")?.checked; }
  function jitOn() { return !!document.getElementById("opt-jit")?.checked; }

  function help() {
    line("launch  set gpu|jit|wisp|autostart|env  status  clear");
  }

  function launch() {
    const btn = document.getElementById("start-btn");
    if (!btn) return line("no start-btn", "e");
    if (!ready && btn.disabled) return line("still loading — wait", "w");
    const jspi = typeof WebAssembly.Suspending === "function" &&
      typeof WebAssembly.promising === "function";
    if (!jspi) {
      line("JSPI required", "e");
      const n = document.getElementById("jspi-note");
      if (n?.textContent) line(n.textContent, "e");
      return;
    }
    line("launching…");
    btn.disabled = false;
    btn.click();
  }

  function setCmd(args) {
    const k = (args[0] || "").toLowerCase();
    const v = args.slice(1).join(" ").trim();
    if (k === "gpu") {
      document.getElementById("opt-gpu").checked = /^(1|on|true|yes)$/i.test(v);
      line("gpu " + (gpuOn() ? "on" : "off"));
    } else if (k === "jit") {
      document.getElementById("opt-jit").checked = /^(1|on|true|yes)$/i.test(v);
      line("jit " + (jitOn() ? "on" : "off"));
    } else if (k === "wisp") {
      document.getElementById("opt-wisp").value = /^(off|none)?$/i.test(v) ? "" : v;
      line("wisp " + (document.getElementById("opt-wisp").value || "off"));
    } else if (k === "autostart") {
      localStorage.setItem("ffwasm.autostart", /^(1|on|true|yes)$/i.test(v) ? "1" : "0");
      line("autostart " + localStorage.getItem("ffwasm.autostart"));
    } else if (k === "env") {
      const u = new URL(location.href);
      if (v.endsWith("-") && !v.includes("=")) {
        u.searchParams.delete("env." + v.slice(0, -1));
      } else {
        const i = v.indexOf("=");
        if (i < 1) return line("set env KEY=VAL", "w");
        u.searchParams.set("env." + v.slice(0, i), v.slice(i + 1));
      }
      history.replaceState(null, "", u.pathname + u.search + u.hash);
      line("env updated");
    } else {
      line("set gpu|jit|wisp|autostart|env", "w");
    }
  }

  function run(s) {
    s = s.trim();
    if (!s) return;
    line("$ " + s, "dim");
    const p = s.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, "")) || [];
    const c = (p[0] || "").toLowerCase();
    if (c === "help" || c === "?") help();
    else if (c === "clear") out.innerHTML = "";
    else if (c === "status") status();
    else if (c === "launch" || c === "run" || c === "start") launch();
    else if (c === "set") setCmd(p.slice(1));
    else line("unknown — help", "w");
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = input.value;
      input.value = "";
      run(v);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "`" && e.target !== input) {
      term.classList.toggle("hide");
      e.preventDefault();
    }
  });

  // Progress from upstream Be() → #splash-status / #progress-*
  function tickProgress() {
    const st = document.getElementById("splash-status")?.textContent?.trim() || "";
    const ph = document.getElementById("progress-phase")?.textContent?.trim() || "";
    const pc = document.getElementById("progress-percent")?.textContent?.trim() || "";
    const msg = [ph, pc, st].filter(Boolean).join(" · ");
    if (msg && msg !== lastProg) {
      lastProg = msg;
      line(msg);
    }
    const btn = document.getElementById("start-btn");
    if (btn && !btn.disabled && !ready) {
      ready = true;
      line("ready — type launch", "ok");
      if (localStorage.getItem("ffwasm.autostart") === "1") launch();
    }
    const note = document.getElementById("jspi-note");
    if (note && !note.hidden && note.textContent && !note.dataset.shown) {
      note.dataset.shown = "1";
      line(note.textContent, "e");
    }
  }
  setInterval(tickProgress, 200);

  // Stall detection
  let lastChange = Date.now();
  let lastSnap = "";
  setInterval(() => {
    if (ready) return;
    const snap = (document.getElementById("splash-status")?.textContent || "") +
      (document.getElementById("progress-percent")?.textContent || "") +
      String(document.getElementById("start-btn")?.disabled);
    if (snap !== lastSnap) {
      lastSnap = snap;
      lastChange = Date.now();
    } else if (Date.now() - lastChange > 45000) {
      line("stalled 45s — check network for gecko.wasm.zst / chrome-assets, JSPI, COI", "e");
      lastChange = Date.now(); // avoid spam every tick
    }
  }, 5000);

  // Own fetch progress for the two big files (upstream doesn't always surface %)
  async function probe(url, label) {
    try {
      line("fetch " + label + "…", "dim");
      const t0 = performance.now();
      const r = await fetch(url, { method: "HEAD" });
      if (!r.ok) {
        line(label + " HEAD " + r.status, "e");
        return;
      }
      const len = r.headers.get("content-length");
      line(label + " ok" + (len ? " (" + Math.round(+len / 1e6) + " MB)" : "") +
        " " + Math.round(performance.now() - t0) + "ms", "dim");
    } catch (e) {
      line(label + " " + e, "e");
    }
  }
  probe("./gecko.wasm.zst", "gecko.wasm.zst");
  probe("./chrome-assets.tar.zst", "chrome-assets.tar.zst");
  probe("./chrome-assets.json", "chrome-assets.json");

  line("firefox-wasm · help");
  status();
  input.focus();

  window.addEventListener("error", (e) => line(String(e.message || e), "e"));
  window.addEventListener("unhandledrejection", (e) => line(String(e.reason || e), "e"));
})();

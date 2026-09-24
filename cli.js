/** Black-screen CLI. Progress only. help on demand. Mobile FABs. */
(function () {
  const out = document.getElementById("term-out");
  const input = document.getElementById("term-in");
  const term = document.getElementById("term");
  const btnTerm = document.getElementById("btn-term");
  const btnLaunch = document.getElementById("btn-launch");
  let ready = false;
  let lastProg = "";

  function line(t, cls) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = t;
    out.appendChild(d);
    while (out.childElementCount > 200) out.firstChild.remove();
    out.scrollTop = out.scrollHeight;
  }

  function showTerm(on) {
    term.classList.toggle("hide", !on);
    if (on) setTimeout(() => input.focus(), 50);
  }

  function hideTermShowFf() {
    showTerm(false);
    btnLaunch.classList.add("hide");
    try {
      document.getElementById("screen")?.focus();
    } catch (_) {}
  }

  // console pipe (re-bind after upstream)
  function pipe(fn) {
    return (...a) => {
      try { fn(...a); } catch (_) {}
      const s = a.map(String).join(" ");
      if (/startup failed|Error:|failed to/i.test(s)) line(s, "e");
      else if (/chrome assets ready/i.test(s)) line("assets ready", "ok");
      else if (/front-end booted/i.test(s)) {
        line("firefox up", "ok");
        hideTermShowFf();
      } else if (/init done/i.test(s)) line("init done", "dim");
      else if (/\[gecko\]/i.test(s)) line(s.replace(/^\[.*?\]\s*/, ""), "dim");
    };
  }
  const raw = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  console.log = pipe(raw.log);
  console.warn = pipe(raw.warn);
  console.error = pipe(raw.error);
  [0, 300, 1000].forEach((ms) => setTimeout(() => {
    console.log = pipe(console.log.bind(console));
    console.warn = pipe(console.warn.bind(console));
    console.error = pipe(console.error.bind(console));
  }, ms));

  function gpu() { return !!document.getElementById("opt-gpu")?.checked; }
  function jit() { return !!document.getElementById("opt-jit")?.checked; }

  function help() {
    line("launch · status · clear");
    line("set gpu|jit on/off");
    line("set wisp url|off");
    line("set autostart on/off");
    line("set env KEY=VAL");
  }

  function launch() {
    const btn = document.getElementById("start-btn");
    if (!btn) return line("no start-btn", "e");
    if (!ready && btn.disabled) return line("not ready", "w");
    const jspi = typeof WebAssembly.Suspending === "function" &&
      typeof WebAssembly.promising === "function";
    if (!jspi) {
      line("JSPI missing", "e");
      const n = document.getElementById("jspi-note");
      if (n?.textContent) line(n.textContent, "e");
      return;
    }
    // clear bad wisp leftovers
    const w = document.getElementById("opt-wisp");
    if (w && /not authorized|http/i.test(w.value) && !/^wss?:/i.test(w.value)) {
      w.value = "";
    }
    line("launching…");
    btn.disabled = false;
    btn.click();
  }

  function run(s) {
    s = (s || "").trim();
    if (!s) return;
    const p = s.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, "")) || [];
    const c = (p[0] || "").toLowerCase();
    if (c === "help" || c === "?") return help();
    if (c === "clear") { out.innerHTML = ""; return; }
    if (c === "status") {
      line("jspi " + (typeof WebAssembly.Suspending === "function" ? "ok" : "no") +
        " coi " + !!crossOriginIsolated +
        " ready " + ready +
        " gpu " + (gpu() ? "on" : "off") +
        " jit " + (jit() ? "on" : "off"));
      return;
    }
    if (c === "launch" || c === "run" || c === "start") return launch();
    if (c === "set") {
      const k = (p[1] || "").toLowerCase();
      const v = p.slice(2).join(" ").trim();
      if (k === "gpu") {
        document.getElementById("opt-gpu").checked = /^(1|on|true|yes)$/i.test(v);
        return line("gpu " + (gpu() ? "on" : "off"));
      }
      if (k === "jit") {
        document.getElementById("opt-jit").checked = /^(1|on|true|yes)$/i.test(v);
        return line("jit " + (jit() ? "on" : "off"));
      }
      if (k === "wisp") {
        document.getElementById("opt-wisp").value = !v || /^off$/i.test(v) ? "" : v;
        return line("wisp " + (document.getElementById("opt-wisp").value || "off"));
      }
      if (k === "autostart") {
        localStorage.setItem("ffwasm.autostart", /^(1|on|true|yes)$/i.test(v) ? "1" : "0");
        return line("autostart " + localStorage.getItem("ffwasm.autostart"));
      }
      if (k === "env") {
        const u = new URL(location.href);
        if (v.endsWith("-") && !v.includes("=")) u.searchParams.delete("env." + v.slice(0, -1));
        else {
          const i = v.indexOf("=");
          if (i < 1) return line("set env KEY=VAL", "w");
          u.searchParams.set("env." + v.slice(0, i), v.slice(i + 1));
        }
        history.replaceState(null, "", u.pathname + u.search + u.hash);
        return line("env ok");
      }
      return line("set gpu|jit|wisp|autostart|env", "w");
    }
    line("?", "w");
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = input.value;
      input.value = "";
      run(v);
    }
  });

  btnTerm.addEventListener("click", () => {
    const open = term.classList.contains("hide");
    showTerm(open);
  });
  btnLaunch.addEventListener("click", () => launch());

  // progress from upstream Be()
  setInterval(() => {
    const st = document.getElementById("splash-status")?.textContent?.trim() || "";
    const ph = document.getElementById("progress-phase")?.textContent?.trim() || "";
    const pc = document.getElementById("progress-percent")?.textContent?.trim() || "";
    const msg = [ph, pc, st].filter(Boolean).join(" ");
    if (msg && msg !== lastProg) {
      lastProg = msg;
      line(msg, "dim");
    }
    const btn = document.getElementById("start-btn");
    if (btn && !btn.disabled && !ready) {
      ready = true;
      line("ready", "ok");
      btnLaunch.classList.remove("hide");
      if (localStorage.getItem("ffwasm.autostart") === "1") launch();
    }
    const note = document.getElementById("jspi-note");
    if (note && !note.hidden && note.textContent && !note.dataset.shown) {
      note.dataset.shown = "1";
      line(note.textContent, "e");
    }
  }, 200);

  let lastChange = Date.now(), lastSnap = "";
  setInterval(() => {
    if (ready) return;
    const snap = (document.getElementById("splash-status")?.textContent || "") +
      String(document.getElementById("start-btn")?.disabled);
    if (snap !== lastSnap) { lastSnap = snap; lastChange = Date.now(); }
    else if (Date.now() - lastChange > 45000) {
      line("stalled — check assets / JSPI / COI", "e");
      lastChange = Date.now();
    }
  }, 5000);

  window.addEventListener("error", (e) => line(String(e.message || e), "e"));
  window.addEventListener("unhandledrejection", (e) => line(String(e.reason || e), "e"));

  // clear poisoned localStorage wisp from puter
  try {
    const o = JSON.parse(localStorage.getItem("chrome-demo-opts") || "{}");
    if (o.wisp && /not authorized|puter\.work|github\.io/i.test(String(o.wisp))) {
      o.wisp = "";
      localStorage.setItem("chrome-demo-opts", JSON.stringify(o));
    }
  } catch (_) {}
  const wispEl = document.getElementById("opt-wisp");
  if (wispEl) wispEl.value = "";

  line("firefox-wasm");
  line("type help · or ▶ when ready", "dim");
  showTerm(true);
  input.focus();
})();

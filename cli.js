/**
 * Firefox WASM static CLI — drives hidden upstream controls + surfaces logs.
 * Autostart default: OFF (localStorage key ffwasm.autostart).
 */
(function () {
  const LS = {
    autostart: "ffwasm.autostart",
    verbosity: "ffwasm.verbosity",
    gpu: "ffwasm.gpu",
    jit: "ffwasm.jit",
    wisp: "ffwasm.wisp",
    env: "ffwasm.env"
  };

  const LEVEL = { quiet: 0, normal: 1, verbose: 2, debug: 3 };
  let verbosity = LEVEL[localStorage.getItem(LS.verbosity) || "normal"] ?? 1;
  let launched = false;
  let assetsReady = false;

  const out = document.getElementById("term-out");
  const input = document.getElementById("term-in");
  const term = document.getElementById("term");
  const badge = document.getElementById("term-ready");
  const hist = [];
  let histIdx = -1;

  function ts() {
    return new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function writeln(text, cls, minLevel) {
    if (minLevel != null && verbosity < minLevel) return;
    const line = document.createElement("div");
    line.className = "line" + (cls ? " " + cls : "");
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  }

  function banner() {
    writeln("Firefox WASM static console", "sys");
    writeln("Type 'help' for commands. Autostart is OFF unless you enable it.", "dim");
    writeln("", "dim");
  }

  // --- console interception ---
  const raw = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console)
  };

  function classify(args) {
    const s = args.map(String).join(" ");
    if (/\[gecko\]/i.test(s)) return { cls: "gecko", level: LEVEL.verbose };
    if (/startup failed|error|Error|failed/i.test(s)) return { cls: "err", level: LEVEL.normal };
    if (/warn/i.test(s)) return { cls: "warn", level: LEVEL.normal };
    if (/chrome assets ready|front-end booted|init done/i.test(s)) return { cls: "ok", level: LEVEL.normal };
    if (/\[chrome-demo\]/i.test(s)) return { cls: "sys", level: LEVEL.verbose };
    return { cls: "dim", level: LEVEL.debug };
  }

  function hook(method, defaultCls) {
    console[method] = function (...args) {
      raw[method](...args);
      try {
        const { cls, level } = classify(args);
        writeln("[" + ts() + "] " + args.map(String).join(" "), cls || defaultCls, level);
        if (/chrome assets ready/i.test(args.join(" "))) onAssetsReady();
        if (/front-end booted/i.test(args.join(" "))) onBooted();
        if (/startup failed/i.test(args.join(" "))) onBootFail(args.join(" "));
      } catch (_) {}
    };
  }
  hook("log", "dim");
  hook("info", "sys");
  hook("warn", "warn");
  hook("error", "err");
  hook("debug", "dim");

  // --- upstream DOM helpers ---
  function el(id) {
    return document.getElementById(id);
  }

  function loadPrefs() {
    const gpu = localStorage.getItem(LS.gpu);
    const jit = localStorage.getItem(LS.jit);
    const wisp = localStorage.getItem(LS.wisp);
    if (gpu != null && el("opt-gpu")) el("opt-gpu").checked = gpu === "1" || gpu === "true";
    if (jit != null && el("opt-jit")) el("opt-jit").checked = jit === "1" || jit === "true";
    if (wisp != null && el("opt-wisp")) el("opt-wisp").value = wisp;
  }

  function savePrefs() {
    if (el("opt-gpu")) localStorage.setItem(LS.gpu, el("opt-gpu").checked ? "1" : "0");
    if (el("opt-jit")) localStorage.setItem(LS.jit, el("opt-jit").checked ? "1" : "0");
    if (el("opt-wisp")) localStorage.setItem(LS.wisp, el("opt-wisp").value || "");
  }

  function getEnvMap() {
    try {
      return JSON.parse(localStorage.getItem(LS.env) || "{}") || {};
    } catch {
      return {};
    }
  }

  function setEnvMap(m) {
    localStorage.setItem(LS.env, JSON.stringify(m));
  }

  /** Apply custom env.* into the page URL so upstream RA() picks them up */
  function applyEnvToUrl() {
    const m = getEnvMap();
    const u = new URL(location.href);
    [...u.searchParams.keys()].forEach((k) => {
      if (k.startsWith("env.")) u.searchParams.delete(k);
    });
    Object.entries(m).forEach(([k, v]) => u.searchParams.set("env." + k, String(v)));
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  }

  function statusLines() {
    const jspi =
      typeof WebAssembly.Suspending === "function" &&
      typeof WebAssembly.promising === "function";
    const lines = [
      "JSPI:            " + (jspi ? "yes" : "NO (required)"),
      "crossOriginIsolated: " + !!window.crossOriginIsolated,
      "SharedArrayBuffer:   " + (typeof SharedArrayBuffer !== "undefined"),
      "assets:         " + (assetsReady ? "ready" : "loading"),
      "launched:       " + launched,
      "gpu:            " + (el("opt-gpu")?.checked ? "on" : "off"),
      "jit:            " + (el("opt-jit")?.checked ? "on" : "off"),
      "wisp:           " + (el("opt-wisp")?.value || "(empty — no network)"),
      "verbosity:      " + (Object.entries(LEVEL).find(([, v]) => v === verbosity)?.[0] || verbosity),
      "autostart:      " + (localStorage.getItem(LS.autostart) === "1" ? "on" : "off")
    ];
    const env = getEnvMap();
    const keys = Object.keys(env);
    if (keys.length) lines.push("env:            " + keys.map((k) => k + "=" + env[k]).join(", "));
    else lines.push("env:            (none)");
    return lines;
  }

  function help() {
    [
      "Commands:",
      "  help                         Show this help",
      "  status                       Runtime / feature status",
      "  clear                        Clear terminal",
      "  launch | run | start         Boot Firefox WASM",
      "  set gpu on|off               GPU / WebGL path",
      "  set jit on|off               Experimental JS→WASM JIT",
      "  set wisp <url|off>           Wisp proxy (off = empty)",
      "  set env KEY=VALUE            Extra env for Gecko (env.KEY)",
      "  set env KEY-                 Remove env KEY",
      "  set verbosity quiet|normal|verbose|debug",
      "  set autostart on|off         Auto launch when assets ready",
      "  get                          Show current flags",
      "",
      "Keys:  `  toggle terminal   Esc  expand terminal"
    ].forEach((l) => writeln(l, "dim"));
  }

  function onAssetsReady() {
    assetsReady = true;
    badge.textContent = "assets ready";
    badge.classList.add("ready");
    badge.classList.remove("error");
    writeln("Chrome assets ready. Type 'launch' to start.", "ok", LEVEL.normal);
    if (localStorage.getItem(LS.autostart) === "1") {
      writeln("autostart on — launching…", "sys");
      doLaunch();
    }
  }

  function onBooted() {
    launched = true;
    writeln("Firefox front-end booted.", "ok");
    badge.textContent = "running";
    // keep terminal available but minimized so canvas is usable
    term.classList.add("minimized");
    writeln("Terminal minimized. Press ` to toggle.", "dim");
  }

  function onBootFail(msg) {
    badge.textContent = "error";
    badge.classList.add("error");
    badge.classList.remove("ready");
    writeln("Boot failed: " + msg, "err");
    term.classList.remove("minimized", "hidden-term");
  }

  function pollStartBtn() {
    const btn = el("start-btn");
    if (!btn) return;
    // Upstream enables the button when assets are ready (and JSPI ok)
    if (!btn.disabled && !assetsReady) {
      // button enabled = ready path in upstream
      onAssetsReady();
    }
    if (btn.disabled && el("jspi-note") && !el("jspi-note").hidden) {
      badge.textContent = "JSPI missing";
      badge.classList.add("error");
    }
  }

  function doLaunch() {
    const btn = el("start-btn");
    if (!btn) {
      writeln("start-btn missing — upstream JS not loaded?", "err");
      return;
    }
    if (!assetsReady && btn.disabled) {
      writeln("Assets still loading — wait until badge says ready.", "warn");
      return;
    }
    const jspi =
      typeof WebAssembly.Suspending === "function" &&
      typeof WebAssembly.promising === "function";
    if (!jspi) {
      writeln("WebAssembly JSPI is required and not available in this browser.", "err");
      const note = el("jspi-note");
      if (note && note.textContent) writeln(note.textContent, "warn");
      return;
    }
    if (!window.crossOriginIsolated) {
      writeln("Warning: crossOriginIsolated=false — SharedArrayBuffer may fail. COI worker should reload once.", "warn");
    }
    savePrefs();
    applyEnvToUrl();
    writeln("Launching… gpu=" + (el("opt-gpu")?.checked ? "on" : "off") +
      " jit=" + (el("opt-jit")?.checked ? "on" : "off") +
      " wisp=" + (el("opt-wisp")?.value || "off"), "sys");
    try {
      btn.disabled = false;
      btn.click();
    } catch (e) {
      writeln(String(e), "err");
    }
  }

  function run(line) {
    const rawLine = line.trim();
    if (!rawLine) return;
    writeln("$ " + rawLine, "cmd", LEVEL.quiet);
    hist.push(rawLine);
    histIdx = hist.length;
    const parts = rawLine.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, "")) || [];
    const cmd = (parts[0] || "").toLowerCase();
    const args = parts.slice(1);

    if (cmd === "help" || cmd === "?") return help();
    if (cmd === "clear" || cmd === "cls") {
      out.innerHTML = "";
      return;
    }
    if (cmd === "status") {
      statusLines().forEach((l) => writeln(l, "dim"));
      return;
    }
    if (cmd === "get") {
      statusLines().forEach((l) => writeln(l, "dim"));
      return;
    }
    if (cmd === "launch" || cmd === "run" || cmd === "start") {
      doLaunch();
      return;
    }
    if (cmd === "set") {
      if (!args.length) {
        writeln("usage: set gpu|jit|wisp|env|verbosity|autostart …", "warn");
        return;
      }
      const key = args[0].toLowerCase();
      const val = args.slice(1).join(" ").trim();
      if (key === "gpu") {
        const on = /^(1|on|true|yes)$/i.test(val);
        if (el("opt-gpu")) el("opt-gpu").checked = on;
        savePrefs();
        writeln("gpu = " + (on ? "on" : "off"), "ok");
        return;
      }
      if (key === "jit") {
        const on = /^(1|on|true|yes)$/i.test(val);
        if (el("opt-jit")) el("opt-jit").checked = on;
        savePrefs();
        writeln("jit = " + (on ? "on" : "off"), "ok");
        return;
      }
      if (key === "wisp") {
        const v = !val || /^(off|none|null)$/i.test(val) ? "" : val;
        if (el("opt-wisp")) el("opt-wisp").value = v;
        savePrefs();
        writeln("wisp = " + (v || "(empty)"), "ok");
        return;
      }
      if (key === "verbosity" || key === "verbose") {
        const name = (val || "normal").toLowerCase();
        if (!(name in LEVEL)) {
          writeln("verbosity: quiet | normal | verbose | debug", "warn");
          return;
        }
        verbosity = LEVEL[name];
        localStorage.setItem(LS.verbosity, name);
        writeln("verbosity = " + name, "ok");
        return;
      }
      if (key === "autostart") {
        const on = /^(1|on|true|yes)$/i.test(val);
        localStorage.setItem(LS.autostart, on ? "1" : "0");
        writeln("autostart = " + (on ? "on" : "off"), "ok");
        return;
      }
      if (key === "env") {
        if (!val) {
          writeln("usage: set env KEY=VALUE | set env KEY-", "warn");
          return;
        }
        const m = getEnvMap();
        if (val.endsWith("-") && !val.includes("=")) {
          const k = val.slice(0, -1);
          delete m[k];
          setEnvMap(m);
          writeln("env removed " + k, "ok");
          return;
        }
        const eq = val.indexOf("=");
        if (eq < 1) {
          writeln("usage: set env KEY=VALUE", "warn");
          return;
        }
        const k = val.slice(0, eq).trim();
        const v = val.slice(eq + 1).trim();
        m[k] = v;
        setEnvMap(m);
        writeln("env." + k + " = " + v, "ok");
        return;
      }
      writeln("unknown set target: " + key, "warn");
      return;
    }
    writeln("unknown command: " + cmd + " (try help)", "warn");
  }

  // input handlers
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = input.value;
      input.value = "";
      run(v);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      if (histIdx > 0) {
        histIdx--;
        input.value = hist[histIdx] || "";
      }
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      if (histIdx < hist.length - 1) {
        histIdx++;
        input.value = hist[histIdx] || "";
      } else {
        histIdx = hist.length;
        input.value = "";
      }
      e.preventDefault();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "`" && !e.ctrlKey && !e.metaKey && e.target !== input) {
      term.classList.toggle("hidden-term");
      if (!term.classList.contains("hidden-term")) {
        term.classList.remove("minimized");
        input.focus();
      }
      e.preventDefault();
    }
    if (e.key === "Escape") {
      term.classList.remove("hidden-term");
      term.classList.remove("minimized");
      input.focus();
    }
  });

  // boot CLI
  loadPrefs();
  banner();
  statusLines().forEach((l) => writeln(l, "dim", LEVEL.verbose));
  help();
  input.focus();

  // poll upstream readiness (button enable / logs)
  setInterval(pollStartBtn, 250);

  // Observe jspi note becoming visible
  const note = el("jspi-note");
  if (note) {
    const mo = new MutationObserver(() => {
      if (!note.hidden && note.textContent) {
        writeln(note.textContent, "err", LEVEL.normal);
        badge.textContent = "JSPI missing";
        badge.classList.add("error");
      }
    });
    mo.observe(note, { attributes: true, childList: true, subtree: true });
  }
})();

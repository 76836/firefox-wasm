(function () {
  const params = new URLSearchParams(location.search);
  const polished = params.get("mode") === "polished" || params.get("polished") === "1";

  const out = document.getElementById("term-out");
  const input = document.getElementById("term-in");
  const term = document.getElementById("term");
  const polish = document.getElementById("polish");
  const polishStatus = document.getElementById("polish-status");
  const polishFill = document.getElementById("polish-fill");
  const fabs = document.getElementById("fabs");
  const btnTerm = document.getElementById("btn-term");
  const btnKb = document.getElementById("btn-kb");
  const btnLaunch = document.getElementById("btn-launch");
  const fileInput = document.getElementById("file-upload");
  const screen = document.getElementById("screen");
  const kbCap = document.getElementById("kb-capture");

  let ready = false;
  let lastProg = "";
  let lowres = localStorage.getItem("ffwasm.lowres") === "1";
  let kbOn = false;

  function line(t, cls) {
    if (polished) {
      if (polishStatus) polishStatus.textContent = t;
      return;
    }
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = t;
    out.appendChild(d);
    while (out.childElementCount > 200) out.firstChild.remove();
    out.scrollTop = out.scrollHeight;
  }

  function setPolishProgress(pct, msg) {
    if (!polished) return;
    if (msg) polishStatus.textContent = msg;
    if (pct != null && polishFill) polishFill.style.width = Math.round(pct * 100) + "%";
  }

  /** Simple math only: innerWidth × innerHeight. lowres = half, no CSS stretch. */
  function size() {
    const sw = window.innerWidth;
    const sh = window.innerHeight;
    if (lowres) {
      return { w: Math.max(1, Math.floor(sw / 2)), h: Math.max(1, Math.floor(sh / 2)) };
    }
    return { w: Math.max(1, sw), h: Math.max(1, sh) };
  }

  function applyCanvasBox() {
    const { w, h } = size();
    // Buffer + CSS identical → no stretch, touch aligns
    screen.width = w;
    screen.height = h;
    screen.style.width = w + "px";
    screen.style.height = h + "px";
  }

  // Gecko reads window.innerWidth/Height at launch + resize listener
  let override = false;
  function enableSizeOverride() {
    if (override) return;
    override = true;
    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        get() { return size().w; }
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        get() { return size().h; }
      });
    } catch (_) {}
  }

  function fixViewport() {
    enableSizeOverride();
    applyCanvasBox();
    window.dispatchEvent(new Event("resize"));
  }

  window.addEventListener("resize", () => {
    applyCanvasBox();
  });

  function showTerm(on) {
    if (polished) return;
    term.classList.toggle("hide", !on);
    if (on) setTimeout(() => input.focus(), 50);
  }

  function hideChrome() {
    term.classList.add("hide");
    fabs.classList.add("hide");
    polish?.classList.add("hide");
    kbCap.classList.remove("on");
    try { screen.focus(); } catch (_) {}
  }

  // console
  function pipe(fn) {
    return (...a) => {
      try { fn(...a); } catch (_) {}
      const s = a.map(String).join(" ");
      if (/startup failed|Error:|failed to/i.test(s)) line(s, "e");
      else if (/chrome assets ready/i.test(s)) {
        line("assets ready", "ok");
        setPolishProgress(0.7, "Assets ready");
      } else if (/front-end booted/i.test(s)) {
        line("firefox up", "ok");
        setPolishProgress(1, "Ready");
        hideChrome();
        fixViewport();
      } else if (/init done/i.test(s)) {
        line("init done", "dim");
        setPolishProgress(0.85, "Init done");
      }
    };
  }
  const raw = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  console.log = pipe(raw.log);
  console.warn = pipe(raw.warn);
  console.error = pipe(raw.error);
  [0, 400, 1200].forEach((ms) => setTimeout(() => {
    console.log = pipe(console.log.bind(console));
    console.warn = pipe(console.warn.bind(console));
    console.error = pipe(console.error.bind(console));
  }, ms));

  function help() {
    line("launch status clear upload ls cache");
    line("set gpu|jit|lowres|wisp|autostart|env");
    line("sync   WebDesk Files → OPFS");
    line("tailscale status|login|wisp <url>");
  }

  async function syncWebdesk() {
    if (!window.WebDeskFS) return line("webdesk-fs missing", "e");
    line("syncing WebDesk Files…");
    const r = await window.WebDeskFS.syncToOpfs((m) => line(m, "dim"));
    line("synced " + r.files + " files", "ok");
  }

  async function launch() {
    const btn = document.getElementById("start-btn");
    if (!btn) return line("no start-btn", "e");
    if (!ready && btn.disabled) return line("not ready", "w");
    const jspi = typeof WebAssembly.Suspending === "function" &&
      typeof WebAssembly.promising === "function";
    if (!jspi) return line("JSPI missing", "e");

    setPolishProgress(0.4, "Syncing files…");
    try { await syncWebdesk(); } catch (e) { line(String(e), "w"); }

    const u = new URL(location.href);
    u.searchParams.set("env.GECKO_OPFS_MOUNT", "1");
    history.replaceState(null, "", u.pathname + u.search + u.hash);

    fixViewport();
    setPolishProgress(0.55, "Launching…");
    line("launching" + (lowres ? " lowres " + size().w + "x" + size().h : "") + "…");
    btn.disabled = false;
    btn.click();
    setTimeout(fixViewport, 400);
    setTimeout(fixViewport, 1500);
  }

  function toggleKb() {
    kbOn = !kbOn;
    kbCap.classList.toggle("on", kbOn);
    if (kbOn) {
      kbCap.focus();
    } else {
      kbCap.blur();
      try { screen.focus(); } catch (_) {}
    }
  }

  // Forward soft-keyboard keys toward the canvas-focused document
  kbCap.addEventListener("keydown", (e) => {
    // Let gecko hear keys on window; prevent bubbling loops
    if (e.key === "Escape") { toggleKb(); return; }
  });

  function run(s) {
    s = (s || "").trim();
    if (!s) return;
    const p = s.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, "")) || [];
    const c = (p[0] || "").toLowerCase();
    if (c === "help") return help();
    if (c === "clear") { out.innerHTML = ""; return; }
    if (c === "status") {
      const { w, h } = size();
      line("vp " + w + "x" + h + " lowres " + (lowres ? "on" : "off") +
        " ready " + ready + " coi " + !!crossOriginIsolated);
      return;
    }
    if (c === "launch" || c === "start" || c === "run") return launch();
    if (c === "sync") return syncWebdesk();
    if (c === "upload") { fileInput.click(); return; }
    if (c === "ls") return listOpfs();
    if (c === "cache") return cacheStatus();
    if (c === "clearcache") return clearCache();
    if (c === "tailscale" || c === "ts") return tsCmd(p.slice(1));
    if (c === "set") return setCmd(p.slice(1));
    line("?", "w");
  }

  function setCmd(args) {
    const k = (args[0] || "").toLowerCase();
    const v = args.slice(1).join(" ").trim();
    if (k === "gpu") {
      document.getElementById("opt-gpu").checked = /^(1|on|true|yes)$/i.test(v);
      return line("gpu " + (document.getElementById("opt-gpu").checked ? "on" : "off"));
    }
    if (k === "jit") {
      document.getElementById("opt-jit").checked = /^(1|on|true|yes)$/i.test(v);
      return line("jit " + (document.getElementById("opt-jit").checked ? "on" : "off"));
    }
    if (k === "lowres") {
      lowres = /^(1|on|true|yes)$/i.test(v);
      localStorage.setItem("ffwasm.lowres", lowres ? "1" : "0");
      fixViewport();
      return line("lowres " + (lowres ? "on" : "off") + " → " + size().w + "x" + size().h);
    }
    if (k === "wisp") {
      const url = !v || /^off$/i.test(v) ? "" : v;
      document.getElementById("opt-wisp").value = url;
      window.FFTailscale?.applyWisp(url);
      return line("wisp " + (url || "off"));
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
    line("set gpu|jit|lowres|wisp|autostart|env", "w");
  }

  async function tsCmd(args) {
    const sub = (args[0] || "status").toLowerCase();
    if (sub === "status") {
      const st = window.FFTailscale?.status() || {};
      line(JSON.stringify(st));
      return;
    }
    if (sub === "login") {
      line("tailscale login…");
      const r = await window.FFTailscale.login();
      line(r.message || JSON.stringify(r), r.ok ? "ok" : "w");
      return;
    }
    if (sub === "wisp") {
      const url = args.slice(1).join(" ").trim();
      window.FFTailscale.applyWisp(url);
      line("wisp " + (url || "off"));
      return;
    }
    line("tailscale status|login|wisp <url>", "w");
  }

  async function listOpfs() {
    if (!navigator.storage?.getDirectory) return line("no OPFS", "e");
    const root = await navigator.storage.getDirectory();
    async function walk(dir, prefix) {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "file") line(prefix + name, "dim");
        else {
          line(prefix + name + "/", "dim");
          await walk(handle, prefix + name + "/");
        }
      }
    }
    try {
      await walk(await root.getDirectoryHandle("webdesk"), "webdesk/");
    } catch { line("(no webdesk/ yet — run sync)"); }
  }

  async function cacheStatus() {
    if (!("caches" in window)) return line("no Cache API", "w");
    for (const k of await caches.keys()) {
      if (!k.startsWith("ffwasm")) continue;
      const c = await caches.open(k);
      line(k);
      for (const r of await c.keys()) line("  " + r.url.split("/").pop(), "dim");
    }
  }
  async function clearCache() {
    for (const k of await caches.keys()) {
      if (k.startsWith("ffwasm")) await caches.delete(k);
    }
    line("cleared", "ok");
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = input.value;
      input.value = "";
      run(v);
    }
  });
  btnTerm?.addEventListener("click", () => showTerm(term.classList.contains("hide")));
  btnKb?.addEventListener("click", () => toggleKb());
  btnLaunch?.addEventListener("click", () => launch());
  fileInput?.addEventListener("change", async () => {
    if (!fileInput.files?.length) return;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("uploads", { create: true });
    for (const file of fileInput.files) {
      const fh = await dir.getFileHandle(file.name, { create: true });
      const w = await fh.createWritable();
      await w.write(file);
      await w.close();
      line("uploaded " + file.name, "ok");
    }
  });

  setInterval(() => {
    const st = document.getElementById("splash-status")?.textContent?.trim() || "";
    const ph = document.getElementById("progress-phase")?.textContent?.trim() || "";
    const pc = document.getElementById("progress-percent")?.textContent?.trim() || "";
    const msg = [ph, pc, st].filter(Boolean).join(" ");
    if (msg && msg !== lastProg) {
      lastProg = msg;
      line(msg, "dim");
      const m = /(\d+)\s*%/.exec(pc || msg);
      if (m) setPolishProgress(+m[1] / 100, msg);
    }
    const btn = document.getElementById("start-btn");
    if (btn && !btn.disabled && !ready) {
      ready = true;
      line("ready", "ok");
      setPolishProgress(0.75, "Ready to launch");
      btnLaunch?.classList.remove("hide");
      if (polished || localStorage.getItem("ffwasm.autostart") === "1") {
        launch();
      }
    }
  }, 200);

  // mode setup
  enableSizeOverride();
  applyCanvasBox();
  if (polished) {
    term.classList.add("hide");
    fabs.classList.add("hide");
    polish.classList.remove("hide");
    setPolishProgress(0.05, "Loading…");
    // auto sync quietly
    window.WebDeskFS?.syncToOpfs(() => {}).catch(() => {});
  } else {
    polish.classList.add("hide");
    line("firefox-wasm");
    line("type help", "dim");
    showTerm(true);
    input.focus();
  }
})();

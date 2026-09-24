/** Firefox WASM CLI: progress, cache, lowres, upload, mobile viewport. */
(function () {
  const out = document.getElementById("term-out");
  const input = document.getElementById("term-in");
  const term = document.getElementById("term");
  const btnTerm = document.getElementById("btn-term");
  const btnLaunch = document.getElementById("btn-launch");
  const fileInput = document.getElementById("file-upload");
  const screen = document.getElementById("screen");

  let ready = false;
  let lastProg = "";
  let lowres = localStorage.getItem("ffwasm.lowres") === "1";

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
    fixViewport(true);
    try { screen?.focus(); } catch (_) {}
  }

  /** CSS-pixel viewport (visualViewport on mobile — fixes squish / touch skew). */
  function vp() {
    const vv = window.visualViewport;
    let w = Math.round(vv?.width || window.innerWidth);
    let h = Math.round(vv?.height || window.innerHeight);
    // Avoid 0 during rotate
    w = Math.max(w, 1);
    h = Math.max(h, 1);
    if (lowres) {
      w = Math.max(1, Math.round(w * 0.5));
      h = Math.max(1, Math.round(h * 0.5));
    }
    return { w, h };
  }

  /**
   * Keep Gecko canvas buffer aligned with on-screen box.
   * Upstream listens to window resize → A.resize(innerWidth, innerHeight).
   * We temporarily override innerWidth/Height getters during that path.
   */
  let overrideOn = false;
  const _iw = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const _ih = Object.getOwnPropertyDescriptor(window, "innerHeight");
  function enableVpOverride() {
    if (overrideOn) return;
    overrideOn = true;
    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        get() { return vp().w; }
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        get() { return vp().h; }
      });
    } catch (_) {}
  }
  function fixViewport(force) {
    enableVpOverride();
    const { w, h } = vp();
    // Match CSS box to same aspect as buffer when lowres (no stretch)
    if (lowres) {
      screen.classList.add("lowres");
      // Center letterbox: CSS stays full; buffer is half — Gecko maps via resize
      // Touch: override makes resize use half; CSS full causes stretch.
      // Better: set CSS to half size centered so 1:1 CSS px ↔ buffer px
      screen.style.width = w + "px";
      screen.style.height = h + "px";
      screen.style.left = "50%";
      screen.style.top = "50%";
      screen.style.transform = "translate(-50%,-50%) scale(2)";
      screen.style.transformOrigin = "center center";
    } else {
      screen.classList.remove("lowres");
      screen.style.width = "100%";
      screen.style.height = "100%";
      screen.style.left = "0";
      screen.style.top = "0";
      screen.style.transform = "";
    }
    if (force) {
      window.dispatchEvent(new Event("resize"));
    }
  }

  // visualViewport fires on mobile chrome show/hide
  window.visualViewport?.addEventListener("resize", () => fixViewport(true));
  window.visualViewport?.addEventListener("scroll", () => fixViewport(true));
  window.addEventListener("orientationchange", () => setTimeout(() => fixViewport(true), 300));
  enableVpOverride();

  // console pipe
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
    line("launch · status · clear · cache");
    line("set gpu|jit|lowres|autostart|wisp|env …");
    line("upload   (pick files → OPFS /uploads)");
    line("ls       list uploaded OPFS files");
  }

  async function ensureAssetSw() {
    // Caching is merged into coi-serviceworker.js (one SW per scope).
    if (navigator.serviceWorker?.controller) line("sw active (coi+cache)", "dim");
  }

  async function cacheStatus() {
    if (!("caches" in window)) return line("no Cache API", "w");
    const keys = await caches.keys();
    const ours = keys.filter((k) => k.startsWith("ffwasm-assets"));
    line("caches: " + (ours.join(", ") || "(none)"));
    for (const k of ours) {
      const c = await caches.open(k);
      const reqs = await c.keys();
      for (const r of reqs) {
        const res = await c.match(r);
        const n = res?.headers.get("content-length");
        line("  " + r.url.split("/").pop() + (n ? " " + Math.round(+n / 1e6) + "MB" : ""), "dim");
      }
    }
  }

  async function clearCache() {
    const keys = await caches.keys();
    for (const k of keys) {
      if (k.startsWith("ffwasm-assets") || k.includes("coi")) await caches.delete(k);
    }
    // notify asset sw
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.active?.postMessage("clear-asset-cache");
    line("caches cleared — reload to redownload", "ok");
  }

  /** Prefetch into Cache API (and SW) so first launch still benefits */
  async function warmCache() {
    const files = ["./gecko.wasm.zst", "./chrome-assets.tar.zst", "./chrome-assets.json"];
    if (!("caches" in window)) return;
    const c = await caches.open("ffwasm-assets-v2");
    for (const f of files) {
      try {
        const hit = await c.match(f);
        if (hit) {
          line("cached " + f.replace("./", ""), "dim");
          continue;
        }
        line("download " + f.replace("./", "") + "…", "dim");
        const res = await fetch(f);
        if (!res.ok) { line(f + " " + res.status, "e"); continue; }
        await c.put(f, res.clone());
        const len = res.headers.get("content-length");
        line("stored " + f.replace("./", "") + (len ? " (" + Math.round(+len / 1e6) + "MB)" : ""), "ok");
      } catch (e) {
        line(String(e), "e");
      }
    }
  }

  async function uploadFiles(fileList) {
    if (!navigator.storage?.getDirectory) {
      line("OPFS not available", "e");
      return;
    }
    const root = await navigator.storage.getDirectory();
    const uploads = await root.getDirectoryHandle("uploads", { create: true });
    // Also mirror into profile/downloads-style paths gecko may scan
    let profile;
    try {
      profile = await root.getDirectoryHandle("profile", { create: true });
    } catch (_) {}
    for (const file of fileList) {
      try {
        const fh = await uploads.getFileHandle(file.name, { create: true });
        const w = await fh.createWritable();
        await w.write(file);
        await w.close();
        if (profile) {
          const dl = await profile.getDirectoryHandle("downloads", { create: true });
          const fh2 = await dl.getFileHandle(file.name, { create: true });
          const w2 = await fh2.createWritable();
          await w2.write(file);
          await w2.close();
        }
        line("uploaded " + file.name + " (" + Math.round(file.size / 1024) + "KB)", "ok");
      } catch (e) {
        line(file.name + " " + e, "e");
      }
    }
    line("paths: OPFS/uploads and OPFS/profile/downloads", "dim");
    line("open file:///uploads/… or browse profile after launch", "dim");
  }

  async function listUploads() {
    if (!navigator.storage?.getDirectory) return line("no OPFS", "e");
    const root = await navigator.storage.getDirectory();
    async function walk(dir, prefix) {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "file") {
          const f = await handle.getFile();
          line(prefix + name + "  " + Math.round(f.size / 1024) + "KB", "dim");
        } else {
          line(prefix + name + "/", "dim");
          await walk(handle, prefix + name + "/");
        }
      }
    }
    try {
      const u = await root.getDirectoryHandle("uploads");
      line("uploads/");
      await walk(u, "  ");
    } catch {
      line("(no uploads yet)");
    }
  }

  function launch() {
    const btn = document.getElementById("start-btn");
    if (!btn) return line("no start-btn", "e");
    if (!ready && btn.disabled) return line("not ready", "w");
    const jspi = typeof WebAssembly.Suspending === "function" &&
      typeof WebAssembly.promising === "function";
    if (!jspi) {
      line("JSPI missing", "e");
      return;
    }
    const w = document.getElementById("opt-wisp");
    if (w && /not authorized|github\.io/i.test(w.value) && !/^wss?:/i.test(w.value)) w.value = "";
    // Enable OPFS mount for uploaded files
    const u = new URL(location.href);
    u.searchParams.set("env.GECKO_OPFS_MOUNT", "1");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
    fixViewport(false);
    line("launching" + (lowres ? " (lowres)" : "") + "…");
    btn.disabled = false;
    btn.click();
    // After module starts, keep viewport override + refresh size
    setTimeout(() => fixViewport(true), 500);
    setTimeout(() => fixViewport(true), 2000);
  }

  function run(s) {
    s = (s || "").trim();
    if (!s) return;
    const p = s.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((x) => x.replace(/^"|"$/g, "")) || [];
    const c = (p[0] || "").toLowerCase();
    if (c === "help" || c === "?") return help();
    if (c === "clear") { out.innerHTML = ""; return; }
    if (c === "status") {
      const { w, h } = vp();
      line("jspi " + (typeof WebAssembly.Suspending === "function" ? "ok" : "no") +
        " coi " + !!crossOriginIsolated +
        " ready " + ready);
      line("gpu " + (gpu() ? "on" : "off") + " jit " + (jit() ? "on" : "off") +
        " lowres " + (lowres ? "on" : "off") + " vp " + w + "x" + h);
      return;
    }
    if (c === "launch" || c === "run" || c === "start") return launch();
    if (c === "cache") return cacheStatus();
    if (c === "clearcache") return clearCache();
    if (c === "upload") {
      fileInput?.click();
      return;
    }
    if (c === "ls") return listUploads();
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
      if (k === "lowres") {
        lowres = /^(1|on|true|yes)$/i.test(v);
        localStorage.setItem("ffwasm.lowres", lowres ? "1" : "0");
        fixViewport(true);
        return line("lowres " + (lowres ? "on" : "off"));
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
      return line("set gpu|jit|lowres|wisp|autostart|env", "w");
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
  btnTerm?.addEventListener("click", () => showTerm(term.classList.contains("hide")));
  btnLaunch?.addEventListener("click", () => launch());
  fileInput?.addEventListener("change", () => {
    if (fileInput.files?.length) uploadFiles([...fileInput.files]);
    fileInput.value = "";
  });

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
      btnLaunch?.classList.remove("hide");
      if (localStorage.getItem("ffwasm.autostart") === "1") launch();
    }
  }, 200);

  window.addEventListener("error", (e) => line(String(e.message || e), "e"));
  window.addEventListener("unhandledrejection", (e) => line(String(e.reason || e), "e"));

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
  line("type help", "dim");
  showTerm(true);
  ensureAssetSw().then(() => warmCache());
  input.focus();
})();

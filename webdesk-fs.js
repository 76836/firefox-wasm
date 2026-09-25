/**
 * Sync WebDesk Files → OPFS sandbox + optional Module.FS.
 * IMPORTANT: never write under profile/ or sessionstore paths — that races
 * SessionStore and can freeze the gecko-wasm pthread with "unreachable".
 */
window.WebDeskFS = (function () {
  function getDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("WebDeskFiles", 1);
      r.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("fs")) db.createObjectStore("fs");
      };
      r.onsuccess = (e) => res(e.target.result);
      r.onerror = () => rej(r.error);
    });
  }

  async function loadTree() {
    try {
      const db = await getDB();
      const tx = db.transaction("fs", "readonly");
      const req = tx.objectStore("fs").get("data");
      return await new Promise((res) => {
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => res(null);
      });
    } catch (e) {
      console.warn("[WebDeskFS] loadTree", e);
      return null;
    }
  }

  function safeName(name) {
    return String(name || "file")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 180) || "file";
  }

  function dataUrlToBytes(dataUrl) {
    if (dataUrl == null) return null;
    if (dataUrl instanceof ArrayBuffer) return new Uint8Array(dataUrl);
    if (dataUrl instanceof Uint8Array) return dataUrl;
    if (typeof dataUrl !== "string") return null;
    if (!dataUrl.startsWith("data:")) {
      return new TextEncoder().encode(dataUrl);
    }
    const i = dataUrl.indexOf(",");
    if (i < 0) return null;
    const meta = dataUrl.slice(0, i);
    const data = dataUrl.slice(i + 1);
    try {
      if (/;base64/i.test(meta)) {
        const bin = atob(data);
        const out = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
        return out;
      }
      return new TextEncoder().encode(decodeURIComponent(data));
    } catch {
      return null;
    }
  }

  function fileBytes(node) {
    if (!node || node.type !== "file") return null;
    if (node.content != null && node.content !== "") {
      return dataUrlToBytes(node.content);
    }
    if (node.isLegacy && node.name) {
      try {
        const raw = localStorage.getItem(node.name);
        if (raw != null) return dataUrlToBytes(raw);
      } catch (_) {}
    }
    return null;
  }

  async function ensureDir(root, parts) {
    let dir = root;
    for (const p of parts) {
      if (!p) continue;
      dir = await dir.getDirectoryHandle(p, { create: true });
    }
    return dir;
  }

  async function writeOpfsFile(dir, name, bytes) {
    const fh = await dir.getFileHandle(safeName(name), { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }

  function collectFiles(tree) {
    const out = [];
    if (!tree || typeof tree !== "object") return out;

    function pathOf(id) {
      const parts = [];
      let n = tree[id];
      let guard = 0;
      while (n && n.id !== "root" && guard++ < 64) {
        if (n.name && n.id !== "home") parts.unshift(safeName(n.name));
        else if (n.id === "home") parts.unshift("home");
        n = tree[n.parentId];
      }
      return parts;
    }

    for (const id of Object.keys(tree)) {
      if (id === "root") continue;
      const node = tree[id];
      if (!node || node.type !== "file" || node.trash) continue;
      const bytes = fileBytes(node);
      if (!bytes || !bytes.length) continue;
      const folderParts = pathOf(node.parentId || "root");
      const name = safeName(
        node.isLegacy ? (node.name || "").split("/").pop() : node.name || id
      );
      out.push({ name, bytes, folderParts, id });
    }
    return out;
  }

  /** OPFS only under webdesk-files/ — isolated from Gecko profile */
  async function syncToOpfs(log = () => {}) {
    if (!navigator.storage?.getDirectory) {
      log("OPFS unavailable");
      return { files: 0, reason: "no-opfs" };
    }
    const tree = await loadTree();
    if (!tree || !tree.root) {
      log("no WebDesk Files data");
      return { files: 0, reason: "no-tree" };
    }
    const files = collectFiles(tree);
    if (!files.length) {
      log("no file payloads to sync");
      return { files: 0, reason: "no-files" };
    }

    const root = await navigator.storage.getDirectory();
    // Sandbox only — do NOT write profile/, sessionstore*, or home/web_user
    const base = await ensureDir(root, ["webdesk-files"]);

    let count = 0;
    for (const f of files) {
      try {
        const dir = await ensureDir(base, f.folderParts);
        await writeOpfsFile(dir, f.name, f.bytes);
        count++;
        log("sync webdesk-files/" + [...f.folderParts, f.name].join("/"));
      } catch (e) {
        log("fail " + f.name + ": " + (e.message || e));
      }
    }
    log("WebDesk sync done (" + count + " → OPFS/webdesk-files)");
    return { files: count };
  }

  function injectIntoModuleFs(log = () => {}) {
    return (async () => {
      const Mod = window.Module || window.FirefoxModule || null;
      const FS = Mod && (Mod.FS || Mod.fs);
      if (!FS || typeof FS.writeFile !== "function") {
        log("Module.FS not available (skip memfs inject)");
        return { files: 0, reason: "no-module-fs" };
      }
      const tree = await loadTree();
      const files = collectFiles(tree || {});
      const mk = (p) => {
        try {
          FS.mkdirTree(p);
        } catch (_) {
          const parts = p.split("/").filter(Boolean);
          let cur = "";
          for (const part of parts) {
            cur += "/" + part;
            try {
              FS.mkdir(cur);
            } catch (_) {}
          }
        }
      };
      // Only under a dedicated tree — avoid profile/sessionstore
      mk("/webdesk-files");
      let count = 0;
      for (const f of files) {
        try {
          const rel = ["webdesk-files", ...f.folderParts].join("/");
          mk("/" + rel);
          FS.writeFile("/" + rel + "/" + f.name, f.bytes);
          count++;
          log("FS /" + rel + "/" + f.name);
        } catch (e) {
          log("FS fail " + f.name + ": " + (e.message || e));
        }
      }
      log("Module.FS inject done (" + count + ")");
      return { files: count };
    })();
  }

  async function syncAll(log = () => {}) {
    const a = await syncToOpfs(log);
    // Delay memfs inject so SessionStore can finish its first read
    await new Promise((r) => setTimeout(r, 1500));
    const b = await injectIntoModuleFs(log);
    return { opfs: a, memfs: b, files: (a.files || 0) + (b.files || 0) };
  }

  /**
   * One-time cleanup of OPFS dirs we used to write that can poison the profile.
   */
  async function scrubLegacyOpfs(log = () => {}) {
    if (!navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();
    for (const name of ["profile", "Downloads"]) {
      try {
        // Best-effort: remove only if empty-ish; ignore errors
        await root.removeEntry(name, { recursive: true });
        log("scrubbed OPFS/" + name);
      } catch (_) {}
    }
  }

  return { loadTree, collectFiles, syncToOpfs, injectIntoModuleFs, syncAll, scrubLegacyOpfs };
})();

/**
 * Sync WebDesk Files (IndexedDB "WebDeskFiles") into:
 *  1) Browser OPFS under webdesk/ and home/web_user/Downloads|WebDesk
 *  2) Emscripten/Gecko FS (Module.FS) when available after boot
 *
 * WebDesk stores: objectStore("fs").get("data") → tree of nodes
 *   { root: { children: [...] }, home: {...}, f_xxx: { type:"file", name, content: dataUrl } }
 * Legacy files: isLegacy true → payload in localStorage under item.name path.
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
    // Legacy: payload lived in localStorage under path-like name
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

  /** Collect every file node with resolved bytes + relative path from home/root */
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
      const name = safeName(node.isLegacy ? (node.name || "").split("/").pop() : node.name || id);
      out.push({ name, bytes, folderParts, id });
    }
    return out;
  }

  async function syncToOpfs(log = () => {}) {
    if (!navigator.storage?.getDirectory) {
      log("OPFS unavailable in this browser");
      return { files: 0, reason: "no-opfs" };
    }

    const tree = await loadTree();
    if (!tree || !tree.root) {
      log("no WebDesk Files data in IndexedDB (WebDeskFiles)");
      return { files: 0, reason: "no-tree" };
    }

    const files = collectFiles(tree);
    if (!files.length) {
      log("WebDesk tree has no file payloads (empty or legacy-only without localStorage)");
      return { files: 0, reason: "no-files", treeKeys: Object.keys(tree).length };
    }

    const root = await navigator.storage.getDirectory();
    const webdesk = await ensureDir(root, ["webdesk"]);
    const downloads = await ensureDir(root, ["home", "web_user", "Downloads"]);
    const webdeskHome = await ensureDir(root, ["home", "web_user", "WebDesk"]);
    // also flat downloads alias some builds look for
    const downloadsAlt = await ensureDir(root, ["Downloads"]);

    let count = 0;
    for (const f of files) {
      try {
        // Mirror full folder structure under OPFS/webdesk
        const dir = await ensureDir(webdesk, f.folderParts);
        await writeOpfsFile(dir, f.name, f.bytes);

        // Always also drop a copy in Downloads + WebDesk for easy find
        await writeOpfsFile(downloads, f.name, f.bytes);
        await writeOpfsFile(downloadsAlt, f.name, f.bytes);
        const wd = await ensureDir(webdeskHome, f.folderParts);
        await writeOpfsFile(wd, f.name, f.bytes);

        count++;
        log("sync " + [...f.folderParts, f.name].join("/"));
      } catch (e) {
        log("fail " + f.name + ": " + (e.message || e));
      }
    }

    log("WebDesk sync done (" + count + " files → OPFS webdesk + Downloads)");
    return { files: count };
  }

  /** Inject into Gecko/Emscripten FS if Module.FS is exposed */
  function injectIntoModuleFs(log = () => {}) {
    return (async () => {
      const Mod =
        window.Module ||
        window.FirefoxModule ||
        window.geckoModule ||
        null;
      const FS = Mod && (Mod.FS || Mod.fs);
      if (!FS || typeof FS.writeFile !== "function") {
        log("Module.FS not available yet");
        return { files: 0, reason: "no-module-fs" };
      }

      const tree = await loadTree();
      const files = collectFiles(tree || {});
      const mk = (p) => {
        try {
          FS.mkdirTree(p);
        } catch (_) {
          try {
            const parts = p.split("/").filter(Boolean);
            let cur = "";
            for (const part of parts) {
              cur += "/" + part;
              try {
                FS.mkdir(cur);
              } catch (_) {}
            }
          } catch (_) {}
        }
      };

      mk("/home/web_user/Downloads");
      mk("/home/web_user/WebDesk");
      mk("/Downloads");

      let count = 0;
      for (const f of files) {
        try {
          const rel = ["home", "web_user", "WebDesk", ...f.folderParts].join("/");
          mk("/" + rel);
          const path1 = "/" + rel + "/" + f.name;
          const path2 = "/home/web_user/Downloads/" + f.name;
          const path3 = "/Downloads/" + f.name;
          FS.writeFile(path1, f.bytes);
          FS.writeFile(path2, f.bytes);
          FS.writeFile(path3, f.bytes);
          count++;
          log("FS " + path2);
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
    const b = await injectIntoModuleFs(log);
    return { opfs: a, memfs: b, files: (a.files || 0) + (b.files || 0) };
  }

  return { loadTree, collectFiles, syncToOpfs, injectIntoModuleFs, syncAll };
})();

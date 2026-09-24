/** Sync WebDesk Files (IndexedDB WebDeskFiles) into OPFS for Gecko. */
window.WebDeskFS = (function () {
  function getDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("WebDeskFiles", 1);
      r.onupgradeneeded = (e) => e.target.result.createObjectStore("fs");
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
    } catch {
      return null;
    }
  }

  function dataUrlToBytes(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") return null;
    if (!dataUrl.startsWith("data:")) {
      return new TextEncoder().encode(dataUrl);
    }
    const i = dataUrl.indexOf(",");
    if (i < 0) return null;
    const meta = dataUrl.slice(0, i);
    const data = dataUrl.slice(i + 1);
    if (/;base64/i.test(meta)) {
      const bin = atob(data);
      const out = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(data));
  }

  async function writeFile(dir, name, bytes) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
  }

  async function syncToOpfs(log = () => {}) {
    if (!navigator.storage?.getDirectory) {
      log("OPFS unavailable");
      return { files: 0 };
    }
    const tree = await loadTree();
    if (!tree || !tree.root) {
      log("no WebDesk Files data");
      return { files: 0 };
    }
    const root = await navigator.storage.getDirectory();
    const webdesk = await root.getDirectoryHandle("webdesk", { create: true });
    // also profile/downloads for Finder-ish access
    let downloads;
    try {
      const profile = await root.getDirectoryHandle("profile", { create: true });
      downloads = await profile.getDirectoryHandle("downloads", { create: true });
    } catch (_) {}

    let count = 0;
    async function walk(nodeId, dir, path) {
      const node = tree[nodeId];
      if (!node) return;
      if (node.type === "folder") {
        for (const cid of node.children || []) {
          const child = tree[cid];
          if (!child) continue;
          if (child.type === "folder") {
            const sub = await dir.getDirectoryHandle(child.name || cid, { create: true });
            await walk(cid, sub, path + "/" + (child.name || cid));
          } else if (child.type === "file") {
            const bytes = dataUrlToBytes(child.content);
            if (!bytes) continue;
            const name = child.name || cid;
            await writeFile(dir, name, bytes);
            if (downloads) {
              try { await writeFile(downloads, name, bytes); } catch (_) {}
            }
            count++;
            log("sync " + path + "/" + name);
          }
        }
      }
    }

    // start from root children (often includes home)
    for (const cid of tree.root.children || []) {
      const child = tree[cid];
      if (!child) continue;
      if (child.type === "folder") {
        const sub = await webdesk.getDirectoryHandle(child.name || cid, { create: true });
        await walk(cid, sub, "/webdesk/" + (child.name || cid));
      } else if (child.type === "file") {
        const bytes = dataUrlToBytes(child.content);
        if (bytes) {
          await writeFile(webdesk, child.name || cid, bytes);
          count++;
        }
      }
    }
    log("WebDesk sync done (" + count + " files → OPFS/webdesk)");
    return { files: count };
  }

  return { loadTree, syncToOpfs };
})();

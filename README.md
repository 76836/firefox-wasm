# Firefox WASM (static)

Self-hosted [Puter Firefox-in-WASM](https://developer.puter.com/labs/firefox-wasm/) with a minimal CLI.

**Live:** https://76836.github.io/firefox-wasm/

## CLI

| Command | Meaning |
|---------|---------|
| `help` | Commands |
| `launch` | Boot Firefox |
| `status` | JSPI / COI / viewport / flags |
| `set lowres on\|off` | Half-res canvas (faster, letterboxed×2) |
| `set gpu\|jit on\|off` | Runtime flags |
| `upload` | Put files in OPFS (`/uploads`, `profile/downloads`) |
| `ls` | List OPFS uploads |
| `cache` / `clearcache` | Asset cache status / wipe |

Mobile: **▶** launch, **`>_`** toggle terminal.

## Caching

- Upstream fetches used `cache: "no-store"` — patched to `force-cache`.
- `asset-cache-sw.js` cache-first for `gecko.wasm.zst` + `chrome-assets.*`.
- First visit still downloads once; later loads should hit Cache API.

Uncompressed persistence of the in-memory chrome FS is not exposed by upstream; caching the compressed blobs is the durable win.

## Networking / Tailscale (research)

Firefox-WASM talks to the network through **Wisp** (WebSocket proxy), not raw sockets.

[WebVM](https://webvm.io) (Leaning Technologies) added Tailscale by:

1. Compiling the official Tailscale client to **Go WASM** (~15–16MB).
2. Implementing a custom **TUN** device over a JS `MessageChannel`.
3. Optionally using an **exit node** for public internet; `#authKey=` / `#controlUrl=` for headscale.

That works because CheerpX exposes a virtual network interface. Gecko-in-WASM does **not** expose an equivalent TUN API today — only Wisp.

Practical paths for this project later:

1. **Wisp server on a Tailscale machine** (or exit node) — point `set wisp wss://…` at it; Firefox keeps using Wisp.
2. **Embed Tailscale WASM + bridge** — large effort: map Tailscale packets into whatever socket layer the emscripten Gecko build uses (not documented/public).
3. **Same-origin service worker proxy** — limited; cannot open arbitrary TCP.

So: Tailscale-as-Wisp-backend is the realistic next step; full in-browser Tailscale like WebVM needs engine-level work.

## License

Upstream MPL-2.0 (Mozilla / HeyPuter). Packaging for local tinkering.

# Firefox WASM (static)

Static mirror of [Puter Firefox-in-WASM](https://developer.puter.com/labs/firefox-wasm/) for self-hosting on GitHub Pages.

- **No setup screen** — auto-launches with GPU on, JIT off, empty Wisp (no networking yet)
- **SharedArrayBuffer** via `coi-serviceworker.js` (COOP/COEP)
- Assets: `gecko.wasm.zst` (~34MB) + `chrome-assets.tar.zst` (~18MB)

## Open

https://76836.github.io/firefox-wasm/

## License

Upstream is MPL-2.0 (Mozilla / HeyPuter firefox-wasm). This packaging is for local tinkering.

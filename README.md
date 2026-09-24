# Firefox (static WASM)

https://76836.github.io/firefox-wasm/

## Architecture

| File | Role |
|------|------|
| **`gecko-host.js`** | **Stable.** Boot API, viewport, upstream DOM, launch. Edit rarely. |
| `ui.js` | CLI + polished splash. Safe to rewrite. |
| `assets/index-*.js` | Upstream Puter/Gecko engine (patched: no Puter Wisp fetch, HTTP cache). |
| `webdesk-fs.js` | Optional WebDesk Files → OPFS sync |
| `coi-serviceworker.js` | SharedArrayBuffer + asset cache |

```js
GeckoHost.init()
GeckoHost.launch({ gpu, jit, wisp })
GeckoHost.on(GeckoHost.EV.ready, ...)
GeckoHost.on(GeckoHost.EV.booted, ...)
GeckoHost.on(GeckoHost.EV.progress, ...)
GeckoHost.on(GeckoHost.EV.error, ...)
```

## Modes

- `/` — debug terminal (`launch`, `help`)
- `/?mode=polished` — splash only, auto-launch (App Center)

## License

Upstream MPL-2.0 (Mozilla / HeyPuter).

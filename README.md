# Firefox WASM (static)

Self-hosted [Puter Firefox-in-WASM](https://developer.puter.com/labs/firefox-wasm/) with a **CLI terminal** instead of the splash/setup UI.

## Open

https://76836.github.io/firefox-wasm/

## CLI

| Command | Meaning |
|---------|---------|
| `help` | Commands |
| `status` / `get` | JSPI, isolation, flags |
| `set gpu on\|off` | GPU path |
| `set jit on\|off` | Experimental JIT |
| `set wisp <url\|off>` | Network proxy (default empty) |
| `set env KEY=VALUE` | Passed as `?env.KEY=` to Gecko |
| `set verbosity quiet\|normal\|verbose\|debug` | Log detail |
| `set autostart on\|off` | Auto `launch` when assets ready (**default off**) |
| `launch` | Boot Firefox |

`` ` `` toggles the terminal; Esc expands it.

## Notes

- First visit may reload once (`coi-serviceworker` for `SharedArrayBuffer`).
- Needs **WebAssembly JSPI** (Chrome/Edge recent; Firefox needs `javascript.options.wasm_js_promise_integration`).
- ~52MB assets (`gecko.wasm.zst` + `chrome-assets.tar.zst`).

## License

Upstream MPL-2.0 (Mozilla / HeyPuter). Packaging for local tinkering.

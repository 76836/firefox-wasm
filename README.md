# Firefox (static WASM)

https://76836.github.io/firefox-wasm/

## Modes

| URL | Behavior |
|-----|----------|
| `/?mode=polished` | App-center mode: logo splash, no terminal/FABs, auto-launch |
| `/` | Debug CLI |

## CLI (debug)

`launch` · `sync` (WebDesk Files → OPFS) · `set lowres on\|off` · `tailscale status` · `set wisp wss://…`

Viewport: `innerWidth` × `innerHeight` only. Lowres uses half size for **both** buffer and CSS (centered, no stretch).

## WebDesk

Files app data (`IndexedDB WebDeskFiles`) is mirrored into OPFS `webdesk/` on launch.

## Tailscale

Gecko uses **Wisp**, not a TUN. WebVM’s Tailscale stack does not drop in directly. Scaffold is in `net/tailscale.js`. Near-term: run a Wisp server on a tailnet machine and `set wisp wss://…`.

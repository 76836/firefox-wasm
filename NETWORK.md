# Networking (Firefox-WASM)

## How internet works here

The browser **cannot** open arbitrary TCP. Gecko-WASM sends every socket through **Wisp** (multiplexed TCP over one WebSocket) to a **server** that dials the real network.

```
Gecko ──Wisp frames──► WebSocket ──► Wisp server ──TCP──► Internet
```

Tailscale in the page can join your **tailnet** (login, MagicDNS names, `ipn.fetch` for HTTP probes). It does **not** replace Wisp: `@tailscale/connect` has no public TCP dial API.

## Full internet (recommended)

On any machine that can reach the public internet (VPS, or PC with Tailscale **exit node**):

```bash
cd net
npm i
node wisp-server.mjs --port 8080
```

TLS (required if the Firefox page is HTTPS): put Caddy/nginx in front for `wss://`.

In the Firefox-WASM terminal:

```text
net wisp wss://YOUR_HOST:8080/
launch
```

Check:

```text
net status
```

## Modes

| Mode | Command | Meaning |
|------|---------|---------|
| off | `net mode off` | No sockets |
| remote | `net wisp wss://…/` | Real internet via your Wisp server |
| local | `net mode local` | In-page Wisp; needs Direct Sockets (rare) |

## Tailscale + private services

1. `ts login` (or `#authKey=…`)
2. Run `wisp-server.mjs` on a **tailnet** machine
3. `net wisp wss://100.x.x.x:8080/` only works if **your OS** can open that WebSocket (device on Tailscale or public WSS). In-page Tailscale does not tunnel the browser’s WebSocket API.

## Why not “all Tailscale like WebVM”?

WebVM uses CheerpX + TUN + lwIP + a custom Tailscale WASM that moves **IP packets**. Gecko-WASM only implements **Wisp**. Different stack; full TUN would mean rebuilding the networking layer inside Gecko.

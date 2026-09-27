# UserNet

| Step | Module | Status |
|------|--------|--------|
| 1 Socket | `socket.js` | **Done** — DoH + `connect()` |
| 2 TCP/IP | `tcpip.js` | **Done** — tcpip.js/lwIP |
| 3 TUN | `tcpip.js` | **Done** |
| 4 WireGuard | `wireguard.js` | **Crypto path** — X25519, ChaCha20-Poly1305, BLAKE2s, initiation msg |
| 5 DERP | `derp.js` | Connect + SendPacket |
| 6 Control | `control.js` | Tailscale Connect login |

## Exit node (your phone)

1. `ts login` / `usernet online`
2. On phone: Tailscale admin → machine → **WireGuard public key** (or `tailscale status --json`)
3. `usernet peer <64-char-hex-public-key>`
4. Ensure phone is advertised as **exit node** and approved

Handshake response from the phone over DERP is required before `wgReady: true`.

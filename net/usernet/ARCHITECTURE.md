# UserNet — steps 2–6

| Step | Module | Status |
|------|--------|--------|
| 2 TCP/IP | `tcpip.js` → tcpip.js (lwIP WASM) | **Working** |
| 3 TUN | same, `createTunInterface` | **Working** |
| 4 WireGuard | `wireguard.js` | **Stub** (keys; Noise_IK TODO) |
| 5 DERP | `derp.js` | **Connect + frames** (auth/peer TODO) |
| 6 Control | `control.js` → FFTailscale Connect | **Login/netmap** |

## CLI

```
usernet start     # load tcpip + TUN
usernet online    # login + DERP + WG stub
usernet status
```

Local Wisp dials via `UserNet.dial` first.

## What’s left for public internet

1. Noise_IK handshake interoperable with Tailscale peers  
2. Map netmap peer keys → WG sessions  
3. Prefer exit node peer for default route  
4. DERP ClientInfo with real node key after control plane auth  

Until then: architecture is live; egress IP packets are logged but not yet accepted by the tailnet.

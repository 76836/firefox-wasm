# UserNet

| Step | Module | Status |
|------|--------|--------|
| 1 Socket | `socket.js` | DoH + `connect()` |
| 2 TCP/IP | `tcpip.js` | tcpip.js / lwIP |
| 3 TUN | `tcpip.js` | virtual TUN |
| 4 WireGuard | `wireguard.js` | X25519 / ChaCha / BLAKE2s path |
| 5 DERP | `derp.js` | Connect + ClientInfo |
| 6 Control | `control.js` + `tailscale.js` | Connect IPN login / netmap |

## Exit node

1. `login` or `online`
2. On some tailnet machine: advertise **exit node**, approve in admin
3. Netmap should list that peer with exit flag; UserNet arms automatically
4. Optional: `usernet peer <hex>` if netmap omits the key

CLI never assumes which device is the exit node.

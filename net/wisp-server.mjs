#!/usr/bin/env node
/**
 * Minimal Wisp v1 TCP server for Firefox-WASM.
 *
 *   npm i ws
 *   node net/wisp-server.mjs [--port 8080] [--host 0.0.0.0]
 *
 * Then in the browser CLI:
 *   net wisp wss://YOUR_HOST:8080/
 *
 * For public internet from a private machine: enable Tailscale exit node
 * on this host, or run this on a VPS with a normal public IP + TLS (caddy).
 *
 * Protocol: https://github.com/MercuryWorkshop/wisp-protocol (v1)
 */
import http from "node:http";
import net from "node:net";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
let host = "0.0.0.0";
let port = 8080;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = Number(args[++i]);
  if (args[i] === "--host") host = args[++i];
}

const CLOSE = {
  ok: 0x02,
  network: 0x41,
  unreachable: 0x42,
  refused: 0x44,
};

function frame(type, streamId, payload) {
  const p = payload ? Buffer.from(payload) : Buffer.alloc(0);
  const buf = Buffer.alloc(5 + p.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32LE(streamId >>> 0, 1);
  if (p.length) p.copy(buf, 5);
  return buf;
}

function handleConnection(ws) {
  const sockets = new Map();

  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 5) return;
    const type = buf.readUInt8(0);
    const id = buf.readUInt32LE(1);
    const payload = buf.subarray(5);

    if (type === 0x01) {
      // CONNECT: streamType u8, port u16 le, host utf8
      if (payload.length < 3) return;
      const streamType = payload.readUInt8(0);
      const destPort = payload.readUInt16LE(1);
      const hostname = payload.subarray(3).toString("utf8");
      if (streamType !== 0x01) {
        // UDP not implemented in this minimal server
        ws.send(frame(0x04, id, Buffer.from([CLOSE.network])));
        return;
      }
      const sock = net.connect({ host: hostname, port: destPort }, () => {
        // client already treats CONNECT as open; just pipe
      });
      sockets.set(id, sock);
      sock.on("data", (chunk) => {
        if (ws.readyState === 1) ws.send(frame(0x02, id, chunk));
      });
      sock.on("close", () => {
        sockets.delete(id);
        if (ws.readyState === 1) ws.send(frame(0x04, id, Buffer.from([CLOSE.ok])));
      });
      sock.on("error", () => {
        sockets.delete(id);
        if (ws.readyState === 1) ws.send(frame(0x04, id, Buffer.from([CLOSE.refused])));
      });
      return;
    }

    if (type === 0x02) {
      const sock = sockets.get(id);
      if (sock && !sock.destroyed) sock.write(payload);
      return;
    }

    if (type === 0x04) {
      const sock = sockets.get(id);
      if (sock) {
        sock.destroy();
        sockets.delete(id);
      }
    }
  });

  ws.on("close", () => {
    for (const s of sockets.values()) s.destroy();
    sockets.clear();
  });
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("wisp-server for firefox-wasm — connect via WebSocket path /\n");
});

const wss = new WebSocketServer({ server, path: "/" });
wss.on("connection", handleConnection);

server.listen(port, host, () => {
  console.log(`[wisp-server] listening ws://${host}:${port}/`);
  console.log(`[wisp-server] browser: net wisp ws://YOUR_IP:${port}/`);
  console.log(`[wisp-server] (use wss:// behind caddy/nginx for HTTPS pages)`);
});

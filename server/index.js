'use strict';
// One Node process: serves the web pages, the QR endpoint and the WebSocket server.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./rooms');
const { attachWebSocket } = require('./ws-handler');
const { getLanAddresses } = require('./lan');

let QRCode = null;
try { QRCode = require('qrcode'); } catch (_) { /* QR endpoint will report 501 */ }

function loadTls() {
  const dir = path.join(__dirname, '..', 'certs');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  return null;
}

function start(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || 3000);
  const forceHttp = process.argv.includes('--http') || process.env.NO_TLS === '1';
  const tls = (opts.tls === false || forceHttp) ? null : loadTls();
  const lanIp = process.env.HOST_IP || (getLanAddresses()[0] || {}).address || null;
  const rooms = new RoomManager({ hostGraceMs: opts.hostGraceMs, maxControllers: opts.maxControllers });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true); // so tunnels (ngrok/cloudflared) report https correctly
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  let actualPort = port;

  // The URL the PHONE should open. If the laptop browser used "localhost",
  // swap in the laptop's LAN IP (localhost on a phone would mean the phone itself).
  function baseUrl(req) {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
    const host = req.headers.host || '';
    const hostname = host.replace(/:\d+$/, '');
    if (['localhost', '127.0.0.1', '[::1]'].includes(hostname) && lanIp) {
      return `${req.protocol}://${lanIp}:${actualPort}`;
    }
    return `${req.protocol}://${host}`;
  }

  function roomFromParam(req, res) {
    const id = rooms.normalize(req.params.room);
    const room = rooms.isValidId(id) ? rooms.get(id) : null;
    if (!room) { res.status(404).json({ error: 'Room not found' }); return null; }
    return room;
  }

  app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));

  app.get('/api/link/:room', (req, res) => {
    const room = roomFromParam(req, res);
    if (!room) return;
    const url = `${baseUrl(req)}/controller.html?room=${room.id}`;
    res.set('Cache-Control', 'no-store').json({ url, secure: url.startsWith('https://') });
  });

  app.get('/api/qr/:room', async (req, res) => {
    const room = roomFromParam(req, res);
    if (!room) return;
    if (!QRCode) return res.status(501).json({ error: 'qrcode package not installed' });
    try {
      const url = `${baseUrl(req)}/controller.html?room=${room.id}`;
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, errorCorrectionLevel: 'M',
        color: { dark: '#0b0a1f', light: '#ffffff' },
      });
      res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).send(svg);
    } catch (e) {
      res.status(500).json({ error: 'QR generation failed' });
    }
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));

  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
  attachWebSocket(wss, rooms, { heartbeatMs: opts.heartbeatMs, sweepMs: opts.sweepMs });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      actualPort = server.address().port;
      resolve({
        server, wss, rooms, port: actualPort, secure: !!tls, lanIp,
        close: () => new Promise((r) => {
          for (const c of wss.clients) c.terminate();
          wss.close(); server.close(() => r());
        }),
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port, secure, lanIp }) => {
    const proto = secure ? 'https' : 'http';
    console.log('\n  Anything But a Game Controller');
    console.log('  ------------------------------');
    console.log(`  Open on your LAPTOP : ${proto}://localhost:${port}`);
    if (lanIp) console.log(`  Phone will connect to: ${proto}://${lanIp}:${port}`);
    const others = getLanAddresses().filter((a) => a.address !== lanIp);
    if (others.length) console.log('  Other addresses      : ' + others.map((a) => a.address).join(', ') + '  (set HOST_IP=... to pick one)');
    if (!lanIp) console.log('  (No LAN address found - are you connected to Wi-Fi?)');
    if (!secure) {
      console.log('\n  WARNING: running on plain http. Most phones BLOCK motion sensors on http pages.');
      console.log('  Fix: run "npm run cert", then restart  (see README: "HTTPS & sensor permissions").');
    }
    if (!QRCode) console.log('\n  NOTE: "qrcode" package missing - run "npm install". Room code still works.');
    console.log('');
  }).catch((e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port is already in use. Try: PORT=3001 npm start` : e);
    process.exit(1);
  });
}

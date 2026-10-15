'use strict';
// WebSocket message handling. Everything the phone/laptop send is validated here
// and re-built from a whitelist of fields before being forwarded.
const WebSocket = require('ws');

const FX_TYPES = new Set(['crash', 'jump', 'start', 'nice']);
const GAME_STATES = new Set(['idle', 'playing', 'paused', 'over']);
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const MAX_MSGS_PER_SEC = 200; // phone sends ~40/s, so this is generous

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function attachWebSocket(wss, rooms, opts = {}) {
  const heartbeatMs = opts.heartbeatMs ?? 15000;
  const sweepMs = opts.sweepMs ?? 10000;

  const toControllers = (room, obj) => {
    for (const ws of room.controllers.values()) send(ws, obj);
  };

  function becomeHost(ws, room) {
    if (room.host && room.host !== ws) {
      const old = room.host;
      old.role = null; old.roomId = null; // so its close event does nothing
      old.close(4001, 'replaced');
    }
    room.host = ws;
    room.hostLeftAt = null;
    ws.role = 'host';
    ws.roomId = room.id;
    clearTimeout(ws.joinTimer);
  }

  const handlers = {
    ping(ws, m) {
      if (isNum(m.ts)) send(ws, { t: 'pong', ts: m.ts });
    },

    // ---- laptop ----
    'host:create'(ws, m) {
      if (ws.role) return;
      // "resume" lets the laptop page keep its room after a refresh/reconnect.
      let room = null;
      let resumed = false;
      if (m.room && m.token) {
        const r = rooms.get(m.room);
        if (r && typeof m.token === 'string' && m.token === r.hostToken) { room = r; resumed = true; }
      }
      if (!room) room = rooms.create();
      if (!room) return send(ws, { t: 'error', code: 'SERVER_FULL', message: 'Server is busy. Try again soon.' });
      becomeHost(ws, room);
      send(ws, { t: 'room:created', room: room.id, token: room.hostToken, resumed,
                 players: [...room.controllers.keys()] });
      toControllers(room, { t: 'host:status', online: true });
    },

    // ---- phone ----
    'ctl:join'(ws, m) {
      if (ws.role) return;
      const id = rooms.normalize(m.room);
      if (!rooms.isValidId(id) || typeof m.playerId !== 'string' || !PLAYER_ID_RE.test(m.playerId)) {
        return send(ws, { t: 'error', code: 'BAD_REQUEST', message: 'Invalid room code.' });
      }
      const room = rooms.get(id);
      if (!room) return send(ws, { t: 'error', code: 'ROOM_NOT_FOUND', message: 'This room does not exist (anymore).' });

      const existing = room.controllers.get(m.playerId);
      if (existing && existing !== ws) {
        // Same phone reconnecting: replace its stale socket.
        existing.role = null; existing.roomId = null;
        existing.close(4001, 'replaced');
        room.controllers.delete(m.playerId);
      } else if (!existing && room.controllers.size >= rooms.maxControllers) {
        return send(ws, { t: 'error', code: 'ROOM_FULL', message: 'Another phone is already connected to this game.' });
      }
      room.controllers.set(m.playerId, ws);
      ws.role = 'controller';
      ws.roomId = room.id;
      ws.playerId = m.playerId;
      clearTimeout(ws.joinTimer);
      send(ws, { t: 'joined', room: room.id, playerId: m.playerId, hostOnline: !!room.host });
      send(room.host, { t: 'ctl:joined', p: m.playerId });
    },

    // steering stream: { t:'in', seq, x:-1..1, ts }
    in(ws, m) {
      if (ws.role !== 'controller') return;
      const room = rooms.get(ws.roomId);
      if (!room || !room.host) return;
      if (!Number.isInteger(m.seq) || !isNum(m.x)) return;
      const x = Math.max(-1, Math.min(1, m.x));
      send(room.host, { t: 'in', p: ws.playerId, seq: m.seq, x: Math.round(x * 1000) / 1000, ts: isNum(m.ts) ? m.ts : 0 });
    },

    jump(ws, m) {
      if (ws.role !== 'controller') return;
      const room = rooms.get(ws.roomId);
      if (!room || !room.host || !Number.isInteger(m.seq)) return;
      send(room.host, { t: 'jump', p: ws.playerId, seq: m.seq, ts: isNum(m.ts) ? m.ts : 0 });
    },

    // latency probe laptop -> phone -> laptop
    'e2e:ping'(ws, m) {
      if (ws.role !== 'host' || !isNum(m.ts)) return;
      const room = rooms.get(ws.roomId);
      if (room) toControllers(room, { t: 'e2e:ping', ts: m.ts });
    },
    'e2e:pong'(ws, m) {
      if (ws.role !== 'controller' || !isNum(m.ts)) return;
      const room = rooms.get(ws.roomId);
      if (room) send(room.host, { t: 'e2e:pong', p: ws.playerId, ts: m.ts });
    },

    // laptop -> phone feedback (vibration) and game status
    fx(ws, m) {
      if (ws.role !== 'host' || !FX_TYPES.has(m.type)) return;
      const room = rooms.get(ws.roomId);
      if (room) toControllers(room, { t: 'fx', type: m.type });
    },
    game(ws, m) {
      if (ws.role !== 'host' || !GAME_STATES.has(m.state)) return;
      const room = rooms.get(ws.roomId);
      if (!room) return;
      toControllers(room, {
        t: 'game', state: m.state,
        score: isNum(m.score) ? Math.max(0, Math.floor(m.score)) : 0,
        lat: isNum(m.lat) ? Math.round(m.lat) : null,
      });
    },
  };

  function onClose(ws) {
    clearTimeout(ws.joinTimer);
    const room = ws.roomId && rooms.rooms.get(ws.roomId);
    if (!room) return;
    if (ws.role === 'host' && room.host === ws) {
      room.host = null;
      room.hostLeftAt = Date.now();
      toControllers(room, { t: 'host:status', online: false });
    } else if (ws.role === 'controller' && room.controllers.get(ws.playerId) === ws) {
      room.controllers.delete(ws.playerId);
      send(room.host, { t: 'ctl:left', p: ws.playerId });
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.role = null;
    ws.roomId = null;
    ws.bucket = { t: Date.now(), n: 0 };
    // Sockets that never say who they are get dropped.
    ws.joinTimer = setTimeout(() => { if (!ws.role) ws.terminate(); }, 10000);

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      if (isBinary) return;
      const now = Date.now();
      if (now - ws.bucket.t >= 1000) { ws.bucket.t = now; ws.bucket.n = 0; }
      if (++ws.bucket.n > MAX_MSGS_PER_SEC) return; // flood protection
      let m;
      try { m = JSON.parse(data.toString()); } catch (_) { return; }
      if (!m || typeof m.t !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, m.t)) return;
      handlers[m.t](ws, m);
    });
    ws.on('close', () => onClose(ws));
    ws.on('error', () => {});
  });

  // Heartbeat: detect dead connections (phone walked out of Wi-Fi, laptop lid closed...).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, heartbeatMs);

  // Sweeper: delete rooms whose laptop never came back.
  const sweeper = setInterval(() => {
    for (const room of rooms.sweep()) {
      toControllers(room, { t: 'room:closed' });
      for (const ws of room.controllers.values()) ws.close(4002, 'room closed');
    }
  }, sweepMs);

  const stop = () => { clearInterval(heartbeat); clearInterval(sweeper); };
  heartbeat.unref(); sweeper.unref();
  wss.on('close', stop);
  return { stop };
}

module.exports = { attachWebSocket };

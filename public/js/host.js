// Laptop page logic: connects to the server, creates the room, shows QR + status,
// receives phone input and feeds it into the game.
(function () {
  'use strict';
  const { clamp, storage, wsUrl, ReconnectingSocket } = window.AMGC;
  const $ = (id) => document.getElementById(id);

  const STALE_MS = 600;          // phone input older than this is ignored (steering returns to 0)
  const RESTART_LOCKOUT_MS = 900; // after a crash, ignore shakes briefly so you don't restart by accident

  const game = new Game($('game'), { onEvent });

  let net = 'connecting';        // connecting | open | reconnecting
  let room = null, token = null;
  let phone = false;             // is a phone paired right now?
  let phoneEver = false;         // was a phone ever paired in this game session?
  let lastSeq = -1, phoneSteer = 0, lastInputAt = 0;
  let kbLeft = false, kbRight = false;
  let lat = null;                // smoothed one-way latency estimate (ms)
  let overAt = 0;

  // ---------- networking ----------
  const sock = new ReconnectingSocket({
    url: wsUrl(),
    onStatus(s) {
      net = s;
      if (s !== 'open') { phone = false; lat = null; }
      refresh();
    },
    onOpen() {
      // Resume the previous room after a refresh/reconnect if we have one.
      const r = storage.session.get('room'), t = storage.session.get('token');
      sock.send(r && t ? { t: 'host:create', room: r, token: t } : { t: 'host:create' });
    },
    onMessage: onServerMessage,
  });

  function onServerMessage(m) {
    switch (m.t) {
      case 'room:created':
        room = m.room; token = m.token;
        storage.session.set('room', room); storage.session.set('token', token);
        phone = Array.isArray(m.players) && m.players.length > 0;
        if (phone) phoneEver = true;
        lastSeq = -1;
        showRoom();
        break;
      case 'ctl:joined':
        phone = true; phoneEver = true; lastSeq = -1; phoneSteer = 0;
        break;
      case 'ctl:left':
        phone = false; lat = null; phoneSteer = 0;
        break;
      case 'in':
        if (!Number.isInteger(m.seq) || m.seq <= lastSeq) return;   // stale / duplicate
        lastSeq = m.seq;
        phoneSteer = Number.isFinite(m.x) ? clamp(m.x, -1, 1) : 0;
        lastInputAt = performance.now();
        return;
      case 'jump':
        if (!Number.isInteger(m.seq) || m.seq <= lastSeq) return;
        lastSeq = m.seq;
        primaryAction();
        return;
      case 'e2e:pong': {
        const oneWay = (performance.now() - m.ts) / 2;   // round trip / 2
        if (oneWay >= 0 && oneWay < 5000) lat = lat == null ? oneWay : lat * 0.7 + oneWay * 0.3;
        return;
      }
      case 'error':
        setStatus('bad', m.message || 'Server error');
        return;
    }
    refresh();
  }

  // ---------- QR / room ----------
  function showRoom() {
    $('roomCode').textContent = room;
    const img = $('qrImg'), fb = $('qrFallback');
    img.hidden = true; fb.hidden = false; fb.textContent = 'Creating QR code…';
    img.onload = () => { img.hidden = false; fb.hidden = true; };
    img.onerror = () => { img.hidden = true; fb.hidden = false; fb.textContent = 'QR unavailable. Open the link below on your phone, or type the room code.'; };
    img.src = `/api/qr/${room}?t=${Date.now()}`;
    fetch(`/api/link/${room}`).then((r) => r.json()).then((j) => {
      $('linkText').textContent = j.url;
      $('httpsWarn').hidden = !!j.secure;
    }).catch(() => {});
  }

  // ---------- game actions ----------
  function primaryAction() {
    const now = performance.now();
    if (game.state === 'playing') game.jump();
    else if (game.state === 'paused') { game.pause(false); }
    else if (game.state === 'over') { if (now - overAt > RESTART_LOCKOUT_MS) game.start(); }
    else game.start();
    refresh();
  }

  function onEvent(name) {
    if (name === 'crash') overAt = performance.now();
    if (['crash', 'jump', 'start', 'nice'].includes(name)) sock.send({ t: 'fx', type: name });
    refresh();
  }

  // ---------- status + overlay ----------
  function setStatus(kind, text) {
    $('statusDot').className = 'dot ' + kind;
    $('statusText').textContent = text;
  }

  function refresh() {
    // Pause automatically if the controller was in use and we lost it.
    if (game.state === 'playing' && phoneEver && (!phone || net !== 'open')) game.pause(true);

    if (net !== 'open') setStatus('bad', net === 'connecting' ? 'Connecting to server…' : 'Server connection lost. Reconnecting…');
    else if (!phone) setStatus('warn', phoneEver ? 'Phone disconnected. Waiting for it to reconnect…' : 'Waiting for phone. Scan the QR code');
    else setStatus('ok', game.state === 'playing' ? 'Phone connected. Playing' : 'Phone connected');
    $('pairCard').classList.toggle('connected', phone);

    const s = game.state;
    if (s === 'playing') game.overlay = null;
    else if (s === 'paused') {
      game.overlay = phone && net === 'open'
        ? { title: 'Controller is back', lines: ['Shake your phone to resume'] }
        : { title: 'Controller disconnected', lines: ['Game paused. Reconnecting…'] };
    } else if (s === 'over') {
      game.overlay = { title: 'CRASH!', lines: [`Score ${Math.floor(game.score)}   ·   Best ${game.best}`, phone ? 'Shake your phone to restart' : 'Press SPACE or Restart'] };
    } else {
      game.overlay = phone
        ? { title: 'Ready!', lines: ['Shake your phone to start', 'Tilt to steer'] }
        : { title: 'Scan the QR code', lines: ['Pair your phone to play', '(SPACE starts with keyboard)'] };
    }
  }

  // ---------- keyboard fallback ----------
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') kbLeft = true;
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') kbRight = true;
    else if (e.code === 'Space') { e.preventDefault(); primaryAction(); }
    else if (e.code === 'KeyR') { game.start(); refresh(); }
  });
  addEventListener('keyup', (e) => {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') kbLeft = false;
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') kbRight = false;
  });
  $('restartBtn').addEventListener('click', (e) => { game.start(); e.currentTarget.blur(); refresh(); });

  // ---------- timers ----------
  setInterval(() => {                        // latency probe through the phone
    if (phone && sock.isOpen) sock.send({ t: 'e2e:ping', ts: performance.now() });
  }, 1000);
  setInterval(() => {                        // tell the phone what the game is doing
    if (phone) sock.send({ t: 'game', state: game.state, score: game.score, lat });
  }, 1000);

  // ---------- main loop ----------
  let last = performance.now(), prevState = game.state, shownScore = -1, shownBest = -1, shownLat = '';
  function frame(now) {
    const dt = (now - last) / 1000; last = now;
    const phoneAxis = now - lastInputAt > STALE_MS ? 0 : phoneSteer;   // ignore stale input
    game.setSteer(clamp(phoneAxis + (kbRight ? 1 : 0) - (kbLeft ? 1 : 0), -1, 1));
    game.update(dt);
    game.render();

    if (game.state !== prevState) {
      prevState = game.state; refresh();
      if (phone) sock.send({ t: 'game', state: game.state, score: game.score, lat });
    }
    const sc = Math.floor(game.score);
    if (sc !== shownScore) { shownScore = sc; $('scoreEl').textContent = sc; }
    if (game.best !== shownBest) { shownBest = game.best; $('bestEl').textContent = game.best; }
    const txt = lat == null ? '--' : Math.round(lat) + ' ms';
    if (txt !== shownLat) {
      shownLat = txt;
      const el = $('latEl'); el.textContent = txt;
      el.className = 'v ' + (lat == null ? '' : lat < 40 ? 'good' : lat < 100 ? 'mid' : 'slow');
    }
    requestAnimationFrame(frame);
  }
  refresh();
  requestAnimationFrame(frame);

  addEventListener('pagehide', () => sock.stop());
})();

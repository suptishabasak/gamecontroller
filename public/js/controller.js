// Phone page logic: joins the room, streams steering at ~40 Hz, sends jump events.
(function () {
  'use strict';
  const { clamp, storage, randomId, wsUrl, ReconnectingSocket } = window.AMGC;
  const $ = (id) => document.getElementById(id);

  const SEND_INTERVAL_MS = 25;   // 40 updates/second
  const KEEPALIVE_MS = 150;      // resend even if unchanged, so the game knows we're alive
  const MIN_DELTA = 0.004;       // don't send tiny changes

  // ---------- identity / room ----------
  const normalize = (s) => String(s || '').trim().toUpperCase();
  let room = normalize(new URLSearchParams(location.search).get('room'));
  let playerId = storage.session.get('pid');
  if (!playerId) { playerId = 'p-' + randomId(12); storage.session.set('pid', playerId); }

  // ---------- motion ----------
  const motion = new MotionController({ onShake });
  const savedSens = Number(storage.local.get('sens')); if (savedSens) { motion.setSensitivity(savedSens); $('sens').value = motion.sensitivity; }
  const savedShake = Number(storage.local.get('shake')); if (savedShake) { motion.setShakeThreshold(savedShake); $('shake').value = motion.shakeThreshold; }
  const savedBase = storage.local.get('baseline'); if (savedBase !== null && savedBase !== '') motion.setBaseline(Number(savedBase));
  $('sensVal').textContent = motion.sensitivity.toFixed(1);
  $('shakeVal').textContent = motion.shakeThreshold;

  let seq = 0;
  let joined = false, everJoined = false, hostOnline = false, sock = null;
  let padSteer = 0, usePad = false;
  let serverRtt = null, gameLat = null;

  // ---------- connection ----------
  function setConn(kind, text) { $('dot').className = 'dot ' + kind; $('connText').textContent = text; }

  function updateConn() {
    if (!sock) return;
    if (!joined) setConn('warn', everJoined ? 'Reconnecting…' : sock.isOpen ? 'Joining…' : 'Connecting…');
    else if (!sock.isOpen) setConn('warn', 'Reconnecting…');
    else if (!hostOnline) setConn('warn', 'Game screen offline. Waiting…');
    else setConn('ok', 'Connected to game');
  }

  function showError(msg) {
    $('errorText').textContent = msg;
    $('errorCard').hidden = false;
    $('joinCard').hidden = false;
    setConn('bad', 'Not connected');
  }

  function fatal(msg) {            // stop retrying: the room is gone or unusable
    if (sock) { sock.stop(); sock = null; }
    joined = false; everJoined = false; hostOnline = false;
    showError(msg);
  }

  function connect() {
    if (sock) { sock.stop(); sock = null; }
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(room)) { $('joinCard').hidden = false; setConn('bad', 'Enter a room code'); return; }
    $('errorCard').hidden = true; $('joinCard').hidden = true;
    $('roomTag').textContent = 'ROOM ' + room;
    joined = false;
    sock = new ReconnectingSocket({
      url: wsUrl(),
      onStatus(s) { if (s !== 'open') joined = false; updateConn(); },
      onOpen() { sock.send({ t: 'ctl:join', room, playerId }); },
      onRtt(ms) { serverRtt = serverRtt == null ? ms : serverRtt * 0.7 + ms * 0.3; },
      onMessage,
    });
    updateConn();
  }

  function onMessage(m) {
    switch (m.t) {
      case 'joined': joined = true; everJoined = true; hostOnline = !!m.hostOnline; break;
      case 'host:status': hostOnline = !!m.online; break;
      case 'e2e:ping': if (sock) sock.send({ t: 'e2e:pong', ts: m.ts }); return;
      case 'fx': vibrate(m.type); return;
      case 'game':
        gameLat = m.lat;
        $('gameState').textContent = 'game: ' + m.state + (m.state === 'playing' ? ' · ' + m.score : '');
        return;
      case 'room:closed': fatal('The game session ended. Refresh the game on your laptop and scan the new QR code.'); return;
      case 'error':
        if (m.code === 'ROOM_NOT_FOUND') fatal('That room does not exist (anymore). Refresh the game page on your laptop and scan the new QR code, or enter the new code below.');
        else if (m.code === 'ROOM_FULL') fatal('Another phone is already controlling this game. Disconnect it first, then try again.');
        else fatal(m.message || 'Could not join this room.');
        return;
    }
    updateConn();
  }

  $('joinBtn').addEventListener('click', () => { room = normalize($('roomInput').value); connect(); });
  $('roomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });
  $('retryBtn').addEventListener('click', connect);

  // ---------- sensors UI ----------
  function sensorFallback(msg) {
    $('sensorMsg').textContent = msg;
    $('enableBtn').textContent = 'Try again';
    usePad = true; $('pad').hidden = false;
    $('calBtn').disabled = true;
  }

  $('enableBtn').addEventListener('click', async () => {
    $('enableBtn').disabled = true;
    if (!MotionController.secureContext) {
      $('sensorMsg').textContent = 'This page is not HTTPS, so your browser may block motion sensors. Trying anyway…';
    }
    const result = await motion.requestPermission();
    $('enableBtn').disabled = false;
    if (result === 'unsupported') return sensorFallback('This browser has no motion sensors. Use the touch pad below to steer.');
    if (result === 'denied') return sensorFallback('Motion access was denied. On iPhone: close this tab, reopen the link and tap Allow. (Settings → Safari → Motion & Orientation Access). You can steer with the touch pad meanwhile.');
    motion.start();
    $('sensorMsg').textContent = 'Checking sensors…';
    setTimeout(() => {
      if (!motion.gotOrientation) {
        motion.stop();
        sensorFallback(MotionController.secureContext
          ? 'No sensor data received. Your device may not have a gyroscope. Use the touch pad to steer.'
          : 'No sensor data: browsers only allow motion sensors on HTTPS pages. See the README ("HTTPS & sensor permissions"). Use the touch pad meanwhile.');
        return;
      }
      usePad = false; $('pad').hidden = true;
      $('sensorCard').hidden = true;
      $('calBtn').disabled = false;
      if (!motion.gotMotion) $('calMsg').textContent = 'Tilt works, but shake detection is unavailable on this device. Use the JUMP button.';
    }, 1500);
  });

  // ---------- calibration ----------
  $('calBtn').addEventListener('click', async () => {
    const btn = $('calBtn');
    btn.disabled = true; btn.classList.remove('done');
    $('calMsg').textContent = 'Hold still…';
    try {
      const base = await motion.calibrate(500);
      storage.local.set('baseline', base);
      btn.textContent = 'RECALIBRATE'; btn.classList.add('done');
      $('calMsg').textContent = 'Calibrated. This position is now "straight".';
    } catch (e) {
      $('calMsg').textContent = 'Calibration failed: ' + e.message;
    }
    btn.disabled = false;
  });
  if (motion.calibrated) { $('calBtn').textContent = 'RECALIBRATE'; $('calMsg').textContent = 'Using your saved neutral position. Recalibrate if it feels off.'; }

  // ---------- settings ----------
  $('sens').addEventListener('input', (e) => { motion.setSensitivity(e.target.value); $('sensVal').textContent = motion.sensitivity.toFixed(1); storage.local.set('sens', motion.sensitivity); });
  $('shake').addEventListener('input', (e) => { motion.setShakeThreshold(e.target.value); $('shakeVal').textContent = motion.shakeThreshold; storage.local.set('shake', motion.shakeThreshold); });

  // ---------- jump ----------
  function sendJump() {
    if (sock) sock.send({ t: 'jump', seq: ++seq, ts: Date.now() });
    const f = $('flash'); f.classList.add('show'); setTimeout(() => f.classList.remove('show'), 120);
  }
  function onShake() { sendJump(); }
  $('jumpBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); sendJump(); });

  // ---------- touch pad fallback ----------
  const pad = $('pad');
  const padMove = (e) => { const r = pad.getBoundingClientRect(); const v = ((e.clientX - r.left) / r.width) * 2 - 1; padSteer = Math.abs(v) < 0.08 ? 0 : clamp(v, -1, 1); };
  pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); padMove(e); });
  pad.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') padMove(e); });
  const padEnd = () => { padSteer = 0; };
  pad.addEventListener('pointerup', padEnd); pad.addEventListener('pointercancel', padEnd);

  // ---------- streaming loop (40 Hz, only when needed) ----------
  const currentSteer = () => (usePad ? padSteer : motion.active ? motion.steer : 0);
  let lastSent = 0, lastSentAt = 0;
  const sendTimer = setInterval(() => {
    if (!sock || !joined) return;
    const x = currentSteer();
    const now = performance.now();
    if (Math.abs(x - lastSent) < MIN_DELTA && now - lastSentAt < KEEPALIVE_MS) return;
    if (sock.send({ t: 'in', seq: ++seq, x: Math.round(x * 1000) / 1000, ts: Date.now() })) { lastSent = x; lastSentAt = now; }
  }, SEND_INTERVAL_MS);

  // ---------- drawing (separate from sending, throttled by the browser) ----------
  const knob = $('knob'), track = $('track');
  function draw() {
    const x = currentSteer();
    const half = (track.clientWidth - 28) / 2;
    knob.style.transform = `translateX(${(x * half).toFixed(1)}px)`;
    const lbl = $('steerLabel');
    if (x < -0.05) { lbl.textContent = '◀ LEFT'; lbl.className = 'steer-label left'; }
    else if (x > 0.05) { lbl.textContent = 'RIGHT ▶'; lbl.className = 'steer-label right'; }
    else { lbl.textContent = 'CENTER'; lbl.className = 'steer-label'; }
    $('tiltDeg').textContent = (motion.active ? motion.tiltDeg : 0).toFixed(0) + '°';
    $('shakeMeter').textContent = 'shake ' + motion.shakeLevel.toFixed(0);
    const max = Math.max(motion.deadZoneDeg + 5, motion.maxTiltDeg / motion.sensitivity);
    $('deadzone').style.width = (motion.deadZoneDeg / max * 100).toFixed(1) + '%';
    const ms = gameLat != null ? gameLat : serverRtt != null ? serverRtt / 2 : null;
    $('latTag').textContent = ms == null ? '-- ms' : '~' + Math.round(ms) + ' ms';
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  // ---------- extras: vibration + keep screen awake ----------
  function vibrate(type) {
    if (!navigator.vibrate) return;   // not supported on iPhone Safari
    navigator.vibrate(type === 'crash' ? [180, 60, 120] : type === 'jump' ? 25 : type === 'nice' ? [20, 40, 20] : 40);
  }
  let wake = null;
  async function keepAwake() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wake = await navigator.wakeLock.request('screen'); } catch (_) {} }
  document.addEventListener('visibilitychange', keepAwake);
  keepAwake();

  // ---------- cleanup ----------
  addEventListener('pagehide', () => {
    clearInterval(sendTimer); motion.stop(); if (sock) sock.stop();
    document.removeEventListener('visibilitychange', keepAwake);
    try { if (wake) wake.release(); } catch (_) {}
  });

  connect();
})();

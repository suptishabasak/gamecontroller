// Shared helpers for both pages: storage, ids, and a WebSocket that reconnects by itself.
(function () {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const noop = () => {};

  function store(kind) {
    let s = null;
    try { s = window[kind]; } catch (_) { /* blocked (private mode) */ }
    return {
      get(k) { try { return s ? s.getItem('amgc.' + k) : null; } catch (_) { return null; } },
      set(k, v) { try { if (s) s.setItem('amgc.' + k, String(v)); } catch (_) {} },
      remove(k) { try { if (s) s.removeItem('amgc.' + k); } catch (_) {} },
    };
  }
  const storage = { local: store('localStorage'), session: store('sessionStorage') };

  function randomId(len = 12) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(len);
    (window.crypto || { getRandomValues: (a) => a.map(() => Math.random() * 256) }).getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  // Reconnects with exponential backoff, wakes up when the tab becomes visible/online,
  // and sends its own heartbeat so a silently dead connection is noticed within ~6s.
  class ReconnectingSocket {
    constructor(o) {
      this.url = o.url;
      this.onOpen = o.onOpen || noop;
      this.onMessage = o.onMessage || noop;
      this.onStatus = o.onStatus || noop;   // 'connecting' | 'open' | 'reconnecting'
      this.onRtt = o.onRtt || noop;         // round trip to the SERVER in ms
      this.heartbeatMs = o.heartbeatMs || 2000;
      this.ws = null; this.retry = 0; this.timer = null; this.stopped = false;
      this.lastRx = 0;

      this._wake = () => {
        if (this.stopped || document.visibilityState !== 'visible') return;
        if (!this.ws || this.ws.readyState === WebSocket.CLOSED) { clearTimeout(this.timer); this._open(); }
      };
      document.addEventListener('visibilitychange', this._wake);
      window.addEventListener('online', this._wake);

      this._hb = setInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (performance.now() - this.lastRx > this.heartbeatMs * 3) { this._drop(); return; }
        this.send({ t: 'ping', ts: performance.now() });
      }, this.heartbeatMs);

      this._open();
    }

    _open() {
      if (this.stopped) return;
      this.onStatus(this.retry ? 'reconnecting' : 'connecting');
      let ws;
      try { ws = new WebSocket(this.url); } catch (_) { this._schedule(); return; }
      this.ws = ws;
      ws.onopen = () => {
        if (ws !== this.ws) return;
        this.retry = 0; this.lastRx = performance.now();
        this.onStatus('open'); this.onOpen();
      };
      ws.onmessage = (ev) => {
        if (ws !== this.ws) return;
        this.lastRx = performance.now();
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (!m || typeof m.t !== 'string') return;
        if (m.t === 'pong') { if (typeof m.ts === 'number') this.onRtt(performance.now() - m.ts); return; }
        this.onMessage(m);
      };
      ws.onclose = () => {
        if (ws !== this.ws || this.stopped) return;
        this.onStatus('reconnecting'); this._schedule();
      };
      ws.onerror = noop;
    }

    _drop() { // connection looks dead: abandon it and reconnect now
      const old = this.ws; this.ws = null;
      if (old) { old.onopen = old.onmessage = old.onclose = null; try { old.close(); } catch (_) {} }
      this.onStatus('reconnecting'); this._schedule(150);
    }

    _schedule(delay) {
      clearTimeout(this.timer);
      const d = delay ?? Math.min(4000, 300 * 2 ** this.retry) + Math.random() * 200;
      this.retry++;
      this.timer = setTimeout(() => this._open(), d);
    }

    get isOpen() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }

    send(obj) {
      if (!this.isOpen) return false;
      this.ws.send(JSON.stringify(obj));
      return true;
    }

    stop() { // remove every listener/timer so nothing leaks
      this.stopped = true;
      clearTimeout(this.timer); clearInterval(this._hb);
      document.removeEventListener('visibilitychange', this._wake);
      window.removeEventListener('online', this._wake);
      if (this.ws) { this.ws.onopen = this.ws.onmessage = this.ws.onclose = null; try { this.ws.close(); } catch (_) {} }
      this.ws = null;
    }
  }

  window.AMGC = { clamp, storage, randomId, wsUrl, ReconnectingSocket };
})();

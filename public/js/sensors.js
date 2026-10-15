// Phone motion logic: permission, tilt -> steering, calibration, dead zone, shake detection.
(function (global) {
  'use strict';
  const D2R = Math.PI / 180;
  const GRAVITY = 9.81;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class MotionController {
    constructor(opts = {}) {
      this.onShake = opts.onShake || function () {};
      // Tunables
      this.deadZoneDeg = 3;        // ignore tiny wobble around neutral
      this.maxTiltDeg = 25;        // tilt that gives full steering at sensitivity 1.0
      this.sensitivity = 1;        // 0.5 (gentle) .. 2 (twitchy)
      this.shakeThreshold = 14;    // m/s^2 of "extra" acceleration that counts as a shake
      this.shakeCooldownMs = 600;  // minimum time between two jumps
      // State
      this.baseline = 0; this.calibrated = false;
      this.rawTilt = null;         // smoothed side tilt in degrees (+ = right side down)
      this.shakeLevel = 0; this.gyro = 0;
      this.active = false; this.gotOrientation = false; this.gotMotion = false;
      this._armed = true; this._lastShake = 0; this._calSamples = null;
      this._onOrient = this._onOrient.bind(this);
      this._onMotion = this._onMotion.bind(this);
    }

    static get secureContext() { return global.isSecureContext !== false; }

    // Must be called from a tap handler (iOS only shows the prompt after a user gesture).
    async requestPermission() {
      const hasAny = 'DeviceOrientationEvent' in global || 'DeviceMotionEvent' in global;
      if (!hasAny) return 'unsupported';
      const needs = (C) => typeof C !== 'undefined' && typeof C.requestPermission === 'function';
      const reqs = [];
      try {
        if (needs(global.DeviceOrientationEvent)) reqs.push(global.DeviceOrientationEvent.requestPermission());
        if (needs(global.DeviceMotionEvent)) reqs.push(global.DeviceMotionEvent.requestPermission());
        if (!reqs.length) return 'granted';               // Android / desktop: no prompt needed
        const res = await Promise.all(reqs);
        return res.every((r) => r === 'granted') ? 'granted' : 'denied';
      } catch (_) { return 'denied'; }
    }

    start() {
      if (this.active) return;
      global.addEventListener('deviceorientation', this._onOrient);
      global.addEventListener('devicemotion', this._onMotion);
      this.active = true;
    }

    stop() {   // always remove listeners when leaving
      global.removeEventListener('deviceorientation', this._onOrient);
      global.removeEventListener('devicemotion', this._onMotion);
      this.active = false;
    }

    // Side tilt = how much gravity pulls along the phone's x axis (left/right edge).
    // From the W3C orientation angles: gravityX = cos(beta) * sin(gamma).
    // Unlike raw "gamma", this works whether the phone is held flat OR upright.
    _onOrient(e) {
      if (e.beta == null || e.gamma == null) return;
      this.gotOrientation = true;
      const s = Math.cos(e.beta * D2R) * Math.sin(e.gamma * D2R);
      const deg = Math.asin(clamp(s, -1, 1)) / D2R;
      if (this._calSamples) this._calSamples.push(deg);
      this.rawTilt = this.rawTilt == null ? deg : this.rawTilt + (deg - this.rawTilt) * 0.5; // light low-pass
    }

    _onMotion(e) {
      const r = e.rotationRate;                     // gyroscope, deg/s
      if (r) this.gyro = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);

      // "extra" acceleration beyond gravity. A tilt doesn't change it, a shake does.
      let dev;
      const lin = e.acceleration, g = e.accelerationIncludingGravity;
      if (lin && lin.x != null && lin.y != null && lin.z != null) dev = Math.hypot(lin.x, lin.y, lin.z);
      else if (g && g.x != null && g.y != null && g.z != null) dev = Math.abs(Math.hypot(g.x, g.y, g.z) - GRAVITY);
      else return;
      this.gotMotion = true;
      this.shakeLevel = dev;

      const now = performance.now();
      if (this._armed && dev > this.shakeThreshold && now - this._lastShake > this.shakeCooldownMs) {
        this._armed = false; this._lastShake = now;
        this.onShake(dev);
      } else if (!this._armed && dev < this.shakeThreshold * 0.4) {
        this._armed = true;   // re-arm only after the shaking has calmed down: one shake = one jump
      }
    }

    // Hold the phone in your favourite neutral pose, then call this (averages ~0.5s of samples).
    calibrate(ms = 500) {
      return new Promise((resolve, reject) => {
        if (!this.gotOrientation) return reject(new Error('No orientation data yet'));
        this._calSamples = [];
        setTimeout(() => {
          const s = this._calSamples; this._calSamples = null;
          if (!s || !s.length) return reject(new Error('No samples collected'));
          this.setBaseline(s.reduce((a, b) => a + b, 0) / s.length);
          resolve(this.baseline);
        }, ms);
      });
    }

    setBaseline(deg) {
      if (Number.isFinite(deg)) { this.baseline = deg; this.calibrated = true; }
    }
    setSensitivity(v) { this.sensitivity = clamp(Number(v) || 1, 0.5, 2); }
    setShakeThreshold(v) { this.shakeThreshold = clamp(Number(v) || 14, 6, 30); }

    // degrees away from the calibrated neutral
    get tiltDeg() { return this.rawTilt == null ? 0 : this.rawTilt - this.baseline; }

    // Normalised steering in [-1, 1] with dead zone applied.
    get steer() {
      if (this.rawTilt == null) return 0;
      const d = this.tiltDeg, a = Math.abs(d);
      if (a < this.deadZoneDeg) return 0;
      const max = Math.max(this.deadZoneDeg + 5, this.maxTiltDeg / this.sensitivity);
      return Math.sign(d) * Math.min(1, (a - this.deadZoneDeg) / (max - this.deadZoneDeg));
    }
  }

  global.MotionController = MotionController;
})(window);

// The game: physics + drawing only. It knows nothing about phones or WebSockets.
// Top-down night road. Dodge red/grey obstacles, JUMP over orange barriers.
(function (global) {
  'use strict';
  const { clamp, storage } = global.AMGC;

  const W = 480, H = 720;
  const ROAD_L = 60, ROAD_R = 420;
  const CAR_W = 38, CAR_H = 66;
  const JUMP_DUR = 0.75;          // seconds in the air
  const MAX_STEER_SPEED = 460;    // px/s at full tilt
  const rand = (a, b) => a + Math.random() * (b - a);

  class Game {
    constructor(canvas, handlers = {}) {
      canvas.width = W; canvas.height = H;
      this.ctx = canvas.getContext('2d');
      this.handlers = handlers;
      this.best = Number(storage.local.get('best')) || 0;
      this.overlay = null;           // {title, lines[]} drawn on top of the canvas
      this.t = 0; this.scroll = 0;
      this.steerTarget = 0;
      this.reset();
      this.state = 'idle';           // idle | playing | paused | over
    }

    emit(name, data) { if (this.handlers.onEvent) this.handlers.onEvent(name, data); }

    reset() {
      this.car = { x: W / 2, y: H - 130, air: 0, tilt: 0 };
      this.obstacles = []; this.particles = []; this.floaters = [];
      this.speed = 260; this.elapsed = 0; this.score = 0;
      this.steer = 0; this.spawnIn = 1.0; this.exhaustIn = 0;
      this.shake = 0; this.flash = 0;
    }

    start() { this.reset(); this.state = 'playing'; this.emit('start'); }

    pause(on) {
      if (on && this.state === 'playing') this.state = 'paused';
      else if (!on && this.state === 'paused') this.state = 'playing';
    }

    setSteer(v) { this.steerTarget = clamp(v, -1, 1); }

    jump() {
      if (this.state !== 'playing' || this.car.air > 0) return false;
      this.car.air = JUMP_DUR;
      this.burst(this.car.x, this.car.y + 20, 8, '#7df9ff', 120);
      this.emit('jump');
      return true;
    }

    // ---------- update ----------
    update(dt) {
      dt = Math.min(dt, 0.05);       // avoid huge jumps after a tab was in background
      this.t += dt;
      const scrollSpeed = this.state === 'playing' ? this.speed : this.state === 'over' ? 0 : 120;
      this.scroll += scrollSpeed * dt;
      if (this.state === 'playing') this.updatePlaying(dt);
      this.updateFx(dt);
    }

    updatePlaying(dt) {
      this.elapsed += dt;
      this.speed = Math.min(260 + this.elapsed * 11, 640);   // difficulty ramps up

      // Smooth the steering a little (removes jitter, adds only ~50ms of lag).
      const k = 1 - Math.exp(-dt / 0.05);
      this.steer += (this.steerTarget - this.steer) * k;

      const c = this.car;
      c.x = clamp(c.x + this.steer * MAX_STEER_SPEED * dt, ROAD_L + CAR_W / 2 + 6, ROAD_R - CAR_W / 2 - 6);
      c.tilt = this.steer * 0.18;
      if (c.air > 0) c.air = Math.max(0, c.air - dt);

      this.spawnIn -= dt;
      if (this.spawnIn <= 0) {
        this.spawn();
        const gap = Math.max(280, 470 - this.elapsed * 3.2) + rand(0, 120); // px between obstacles
        this.spawnIn = gap / this.speed;
      }

      this.exhaustIn -= dt;
      if (this.exhaustIn <= 0 && c.air <= 0) {
        this.exhaustIn = 0.04;
        this.particles.push({ x: c.x + rand(-6, 6), y: c.y + CAR_H / 2, vx: rand(-20, 20), vy: rand(60, 140),
          life: 0.35, max: 0.35, color: '#ff3df2', size: rand(2, 4) });
      }

      // collisions
      const cl = c.x - CAR_W / 2 + 5, cr = c.x + CAR_W / 2 - 5;
      const ct = c.y - CAR_H / 2 + 6, cb = c.y + CAR_H / 2 - 6;
      const lift = Math.sin(Math.PI * (1 - c.air / JUMP_DUR));
      const airborne = c.air > 0 && lift > 0.35;
      for (const o of this.obstacles) {
        o.y += this.speed * dt;
        const hit = cr > o.x + 3 && cl < o.x + o.w - 3 && cb > o.y + 3 && ct < o.y + o.h - 3;
        if (o.type === 'barrier') {
          if (hit) { if (airborne) o.jumped = true; else return this.crash(); }
          if (o.jumped && !o.awarded && o.y > c.y + CAR_H / 2) {
            o.awarded = true; this.score += 25;
            this.floaters.push({ text: 'NICE JUMP +25', x: c.x, y: c.y - 50, life: 1 });
            this.emit('nice');
          }
        } else if (hit) return this.crash();
      }
      this.obstacles = this.obstacles.filter((o) => o.y < H + 60);
      this.score += this.speed * dt * 0.04;
    }

    spawn() {
      const r = Math.random();
      const y = -80;
      if (r < 0.40) {                                   // single rock
        const w = rand(48, 68);
        this.obstacles.push({ type: 'rock', x: rand(ROAD_L + 8, ROAD_R - 8 - w), y, w, h: 46,
          pts: Array.from({ length: 8 }, () => rand(0.75, 1)) });
      } else if (r < 0.72) {                            // jumpable barrier
        const w = rand(140, 240);
        this.obstacles.push({ type: 'barrier', x: rand(ROAD_L + 8, ROAD_R - 8 - w), y, w, h: 26 });
      } else {                                          // wall with a gap
        const gap = 118, gx = rand(ROAD_L + 14, ROAD_R - 14 - gap);
        this.obstacles.push({ type: 'block', x: ROAD_L + 4, y, w: gx - (ROAD_L + 4), h: 40 });
        this.obstacles.push({ type: 'block', x: gx + gap, y, w: ROAD_R - 4 - (gx + gap), h: 40 });
      }
    }

    crash() {
      this.state = 'over';
      this.shake = 0.5; this.flash = 1;
      this.burst(this.car.x, this.car.y, 40, '#ff6a3d', 360);
      this.burst(this.car.x, this.car.y, 20, '#ffe14d', 260);
      const s = Math.floor(this.score);
      if (s > this.best) { this.best = s; storage.local.set('best', s); }
      this.emit('crash', { score: s });
    }

    burst(x, y, n, color, speed) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, v = rand(0.2, 1) * speed;
        this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.3, 0.8), max: 0.8, color, size: rand(2, 5) });
      }
    }

    updateFx(dt) {
      for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; }
      this.particles = this.particles.filter((p) => p.life > 0);
      for (const f of this.floaters) { f.y -= 40 * dt; f.life -= dt; }
      this.floaters = this.floaters.filter((f) => f.life > 0);
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
      if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.5);
    }

    // ---------- drawing ----------
    render() {
      const ctx = this.ctx;
      ctx.save();
      if (this.shake > 0) ctx.translate(rand(-1, 1) * this.shake * 18, rand(-1, 1) * this.shake * 18);
      this.drawBackground(ctx);
      for (const o of this.obstacles) this.drawObstacle(ctx, o);
      this.drawCar(ctx);
      this.drawParticles(ctx);
      ctx.restore();
      this.drawHud(ctx);
      if (this.flash > 0) { ctx.fillStyle = `rgba(255,60,60,${this.flash * 0.45})`; ctx.fillRect(0, 0, W, H); }
      if (this.overlay) this.drawOverlay(ctx);
    }

    drawBackground(ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#120a2e'); g.addColorStop(1, '#07061a');
      ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);

      // glowing grid on the grass
      ctx.strokeStyle = 'rgba(255,61,242,0.13)'; ctx.lineWidth = 1;
      const off = this.scroll % 60;
      for (let y = -60 + off; y < H + 60; y += 60) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ROAD_L, y); ctx.moveTo(ROAD_R, y); ctx.lineTo(W, y); ctx.stroke();
      }
      for (let x = 0; x <= ROAD_L; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let x = ROAD_R; x <= W; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }

      // road
      ctx.fillStyle = '#17153a'; ctx.fillRect(ROAD_L, -20, ROAD_R - ROAD_L, H + 40);
      ctx.save();
      ctx.shadowColor = '#22e4ff'; ctx.shadowBlur = 14; ctx.fillStyle = '#22e4ff';
      ctx.fillRect(ROAD_L - 3, -20, 4, H + 40); ctx.fillRect(ROAD_R - 1, -20, 4, H + 40);
      ctx.restore();

      // lane dashes
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      const d = this.scroll % 80;
      for (const x of [ROAD_L + 120, ROAD_L + 240]) {
        for (let y = -80 + d; y < H + 80; y += 80) ctx.fillRect(x - 2, y, 4, 40);
      }
      // street posts
      const pd = this.scroll % 140;
      for (let y = -140 + pd; y < H + 140; y += 140) {
        for (const x of [30, W - 30]) {
          ctx.save(); ctx.shadowColor = '#ffb020'; ctx.shadowBlur = 16; ctx.fillStyle = '#ffd36b';
          ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.restore();
        }
      }
      // speed streaks
      if (this.state === 'playing' && this.speed > 420) {
        ctx.fillStyle = 'rgba(125,249,255,0.12)';
        for (let i = 0; i < 6; i++) {
          const x = ROAD_L + ((i * 97 + Math.floor(this.t * 5) * 31) % (ROAD_R - ROAD_L));
          ctx.fillRect(x, ((this.t * 900 + i * 170) % (H + 100)) - 50, 2, 70);
        }
      }
    }

    drawObstacle(ctx, o) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(o.x + 4, o.y + 6, o.w, o.h);   // shadow
      if (o.type === 'rock') {
        ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
        ctx.beginPath();
        o.pts.forEach((r, i) => {
          const a = (i / o.pts.length) * Math.PI * 2;
          const px = Math.cos(a) * (o.w / 2) * r, py = Math.sin(a) * (o.h / 2) * r;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        });
        ctx.closePath();
        ctx.fillStyle = '#4a4668'; ctx.fill();
        ctx.shadowColor = '#ff3d6e'; ctx.shadowBlur = 10; ctx.strokeStyle = '#ff3d6e'; ctx.lineWidth = 2; ctx.stroke();
      } else if (o.type === 'block') {
        ctx.fillStyle = '#3a1230'; ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.shadowColor = '#ff3d6e'; ctx.shadowBlur = 10; ctx.strokeStyle = '#ff3d6e'; ctx.lineWidth = 2;
        ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
        ctx.shadowBlur = 0; ctx.beginPath(); ctx.rect(o.x, o.y, o.w, o.h); ctx.clip();
        ctx.strokeStyle = 'rgba(255,61,110,0.35)';
        for (let x = o.x - o.h; x < o.x + o.w; x += 16) { ctx.beginPath(); ctx.moveTo(x, o.y + o.h); ctx.lineTo(x + o.h, o.y); ctx.stroke(); }
      } else { // barrier: orange/black stripes, jumpable
        ctx.fillStyle = '#ffb020'; ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.save(); ctx.beginPath(); ctx.rect(o.x, o.y, o.w, o.h); ctx.clip();
        ctx.fillStyle = '#1a1030';
        for (let x = o.x - o.h; x < o.x + o.w; x += 28) {
          ctx.beginPath(); ctx.moveTo(x, o.y + o.h); ctx.lineTo(x + 14, o.y + o.h); ctx.lineTo(x + 14 + o.h, o.y); ctx.lineTo(x + o.h, o.y); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
        ctx.shadowColor = '#ffb020'; ctx.shadowBlur = 12; ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2; ctx.strokeRect(o.x, o.y, o.w, o.h);
      }
      ctx.restore();
    }

    drawCar(ctx) {
      const c = this.car;
      const lift = c.air > 0 ? Math.sin(Math.PI * (1 - c.air / JUMP_DUR)) : 0;
      if (this.state === 'over') return;
      // ground shadow
      ctx.save(); ctx.fillStyle = `rgba(0,0,0,${0.4 - lift * 0.2})`;
      ctx.beginPath(); ctx.ellipse(c.x + lift * 14, c.y + 6 + lift * 22, CAR_W * 0.6, CAR_H * 0.45, 0, 0, 7); ctx.fill(); ctx.restore();

      ctx.save();
      ctx.translate(c.x, c.y - lift * 26);
      ctx.rotate(c.tilt);
      const s = 1 + lift * 0.3; ctx.scale(s, s);
      // headlight beams
      const beam = ctx.createLinearGradient(0, -CAR_H / 2, 0, -CAR_H / 2 - 120);
      beam.addColorStop(0, 'rgba(255,248,200,0.35)'); beam.addColorStop(1, 'rgba(255,248,200,0)');
      ctx.fillStyle = beam; ctx.beginPath();
      ctx.moveTo(-14, -CAR_H / 2); ctx.lineTo(-40, -CAR_H / 2 - 120); ctx.lineTo(40, -CAR_H / 2 - 120); ctx.lineTo(14, -CAR_H / 2); ctx.fill();
      // wheels
      ctx.fillStyle = '#0a0a14';
      for (const [wx, wy] of [[-CAR_W / 2 - 3, -20], [CAR_W / 2 - 3, -20], [-CAR_W / 2 - 3, 16], [CAR_W / 2 - 3, 16]]) ctx.fillRect(wx, wy, 6, 18);
      // body
      const body = ctx.createLinearGradient(-CAR_W / 2, 0, CAR_W / 2, 0);
      body.addColorStop(0, '#16c6e8'); body.addColorStop(0.5, '#7df9ff'); body.addColorStop(1, '#16c6e8');
      ctx.shadowColor = '#22e4ff'; ctx.shadowBlur = 16; ctx.fillStyle = body;
      ctx.beginPath(); ctx.roundRect(-CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H, 11); ctx.fill();
      ctx.shadowBlur = 0;
      // stripe, windshield, rear window
      ctx.fillStyle = '#ff3df2'; ctx.fillRect(-3, -CAR_H / 2 + 4, 6, CAR_H - 8);
      ctx.fillStyle = '#10102a';
      ctx.beginPath(); ctx.roundRect(-CAR_W / 2 + 5, -14, CAR_W - 10, 18, 5); ctx.fill();
      ctx.beginPath(); ctx.roundRect(-CAR_W / 2 + 7, 14, CAR_W - 14, 10, 4); ctx.fill();
      // lights
      ctx.fillStyle = '#fff8c8'; ctx.fillRect(-CAR_W / 2 + 3, -CAR_H / 2 + 1, 8, 4); ctx.fillRect(CAR_W / 2 - 11, -CAR_H / 2 + 1, 8, 4);
      ctx.fillStyle = '#ff2a4d'; ctx.fillRect(-CAR_W / 2 + 3, CAR_H / 2 - 5, 8, 4); ctx.fillRect(CAR_W / 2 - 11, CAR_H / 2 - 5, 8, 4);
      ctx.restore();
    }

    drawParticles(ctx) {
      for (const p of this.particles) {
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
        ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.size, p.size);
      }
      ctx.globalAlpha = 1;
      ctx.font = 'bold 16px system-ui, sans-serif'; ctx.textAlign = 'center';
      for (const f of this.floaters) {
        ctx.globalAlpha = clamp(f.life, 0, 1); ctx.fillStyle = '#ffe14d'; ctx.fillText(f.text, f.x, f.y);
      }
      ctx.globalAlpha = 1;
    }

    drawHud(ctx) {
      ctx.save();
      ctx.font = '800 26px ui-monospace, Menlo, Consolas, monospace';
      ctx.shadowColor = '#22e4ff'; ctx.shadowBlur = 10; ctx.fillStyle = '#fff';
      ctx.textAlign = 'left'; ctx.fillText(String(Math.floor(this.score)).padStart(5, '0'), 18, 38);
      ctx.shadowBlur = 0; ctx.font = '600 12px system-ui, sans-serif'; ctx.fillStyle = '#9aa0d0';
      ctx.fillText('SCORE', 18, 54);
      ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = '700 16px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillText(`${Math.round(this.speed * 0.35)} km/h`, W - 18, 36);
      ctx.fillStyle = '#9aa0d0'; ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillText(`BEST ${this.best}`, W - 18, 54);
      ctx.restore();
    }

    drawOverlay(ctx) {
      const { title, lines = [] } = this.overlay;
      ctx.save();
      ctx.fillStyle = 'rgba(7,6,26,0.68)'; ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.shadowColor = '#ff3df2'; ctx.shadowBlur = 18; ctx.fillStyle = '#fff';
      ctx.font = '800 38px system-ui, sans-serif'; ctx.fillText(title, W / 2, H / 2 - 30);
      ctx.shadowBlur = 0; ctx.fillStyle = '#c9ccf5'; ctx.font = '500 18px system-ui, sans-serif';
      lines.forEach((l, i) => ctx.fillText(l, W / 2, H / 2 + 12 + i * 28));
      ctx.restore();
    }
  }

  global.Game = Game;
})(window);

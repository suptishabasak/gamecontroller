'use strict';
// Integration test of pairing + routing. Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { start } = require('../server/index');

class Client {
  constructor(port) {
    this.msgs = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
    this.opened = new Promise((r) => this.ws.on('open', r));
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  next(pred, ms = 1500) {
    const hit = this.msgs.findIndex(pred);
    if (hit >= 0) return Promise.resolve(this.msgs.splice(hit, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      this.waiters.push((m) => { if (pred(m)) { clearTimeout(t); this.msgs.splice(this.msgs.indexOf(m), 1); resolve(m); return true; } return false; });
    });
  }
  type(t, ms) { return this.next((m) => m.t === t, ms); }
  close() { this.ws.close(); }
}

async function setup(opts = {}) {
  const srv = await start({ port: 0, tls: false, ...opts });
  const host = new Client(srv.port); await host.opened;
  host.send({ t: 'host:create' });
  const created = await host.type('room:created');
  return { srv, host, created };
}
async function phone(srv, room, playerId = 'phone-abc123') {
  const p = new Client(srv.port); await p.opened;
  p.send({ t: 'ctl:join', room, playerId });
  return p;
}

test('pair, stream input, clamp, drop invalid, jump', async () => {
  const { srv, host, created } = await setup();
  assert.match(created.room, /^[A-HJ-NP-Z2-9]{4}$/);
  const p = await phone(srv, created.room.toLowerCase()); // lower-case is normalised
  assert.equal((await p.type('joined')).hostOnline, true);
  assert.equal((await host.type('ctl:joined')).p, 'phone-abc123');

  p.send({ t: 'in', seq: 1, x: 5, ts: 1 });          // clamped to 1
  p.send({ t: 'in', seq: 2, x: 'evil', ts: 1 });     // dropped
  p.send({ t: 'in', seq: 3, x: NaN, ts: 1 });        // JSON turns NaN into null -> dropped
  p.send({ t: 'in', seq: 4, x: -0.5, ts: 2 });
  assert.equal((await host.type('in')).x, 1);
  assert.equal((await host.type('in')).seq, 4);
  p.send({ t: 'jump', seq: 5, ts: 3 });
  assert.equal((await host.type('jump')).seq, 5);

  // latency probe round trip
  host.send({ t: 'e2e:ping', ts: 123 });
  assert.equal((await p.type('e2e:ping')).ts, 123);
  p.send({ t: 'e2e:pong', ts: 123 });
  assert.equal((await host.type('e2e:pong')).ts, 123);

  // server RTT probe
  p.send({ t: 'ping', ts: 77 });
  assert.equal((await p.type('pong')).ts, 77);
  await srv.close();
});

test('unknown / malformed rooms are rejected', async () => {
  const { srv } = await setup();
  const p = await phone(srv, 'ZZZZ');
  assert.equal((await p.type('error')).code, 'ROOM_NOT_FOUND');
  const q = await phone(srv, 'bad!');
  assert.equal((await q.type('error')).code, 'BAD_REQUEST');
  await srv.close();
});

test('second phone is refused, same phone may reconnect', async () => {
  const { srv, host, created } = await setup();
  const a = await phone(srv, created.room, 'phone-aaaaaa'); await a.type('joined');
  const b = await phone(srv, created.room, 'phone-bbbbbb');
  assert.equal((await b.type('error')).code, 'ROOM_FULL');
  const a2 = await phone(srv, created.room, 'phone-aaaaaa');
  await a2.type('joined');
  a2.send({ t: 'in', seq: 1, x: 0.2, ts: 0 });
  assert.equal((await host.type('in')).x, 0.2);
  await srv.close();
});

test('phone input cannot reach another room', async () => {
  const { srv, host: h1, created: c1 } = await setup();
  const h2 = new Client(srv.port); await h2.opened; h2.send({ t: 'host:create' });
  await h2.type('room:created');
  const p = await phone(srv, c1.room); await p.type('joined');
  p.send({ t: 'in', seq: 1, x: 1, ts: 0 });
  await h1.type('in');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!h2.msgs.some((m) => m.t === 'in'), 'other room must not receive input');
  await srv.close();
});

test('host resume keeps the room; phones are told about host status', async () => {
  const { srv, host, created } = await setup();
  const p = await phone(srv, created.room); await p.type('joined');
  host.close();
  assert.equal((await p.type('host:status')).online, false);
  const h2 = new Client(srv.port); await h2.opened;
  h2.send({ t: 'host:create', room: created.room, token: created.token });
  const r = await h2.type('room:created');
  assert.equal(r.room, created.room); assert.equal(r.resumed, true); assert.equal(r.players.length, 1);
  assert.equal((await p.type('host:status')).online, true);
  // wrong token must NOT hijack the room
  const h3 = new Client(srv.port); await h3.opened;
  h3.send({ t: 'host:create', room: created.room, token: 'nope' });
  assert.notEqual((await h3.type('room:created')).room, created.room);
  await srv.close();
});

test('abandoned rooms are removed and phones are notified', async () => {
  const srv = await start({ port: 0, tls: false, hostGraceMs: 150, sweepMs: 50 });
  const host = new Client(srv.port); await host.opened; host.send({ t: 'host:create' });
  const { room } = await host.type('room:created');
  const p = await phone(srv, room); await p.type('joined');
  host.close();
  await p.type('room:closed', 2000);
  assert.equal(srv.rooms.rooms.size, 0);
  const late = await phone(srv, room);
  assert.equal((await late.type('error')).code, 'ROOM_NOT_FOUND');
  await srv.close();
});

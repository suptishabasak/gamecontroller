'use strict';
// Room management: one "room" = one game session (1 laptop + up to N phones).
const crypto = require('crypto');

// No 0/O or 1/I so codes are easy to read and type.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_RE = /^[A-HJ-NP-Z2-9]{4}$/;

function makeRoomId() {
  let id = '';
  for (let i = 0; i < 4; i++) id += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return id;
}

class RoomManager {
  constructor(opts = {}) {
    this.rooms = new Map();
    this.maxRooms = opts.maxRooms ?? 200;
    this.maxControllers = opts.maxControllers ?? 1; // 1 phone per game for now
    this.hostGraceMs = opts.hostGraceMs ?? 60000;   // how long a room survives without its laptop
  }

  normalize(id) {
    return typeof id === 'string' ? id.trim().toUpperCase() : '';
  }

  isValidId(id) {
    return ROOM_RE.test(id);
  }

  create() {
    if (this.rooms.size >= this.maxRooms) return null;
    let id;
    do { id = makeRoomId(); } while (this.rooms.has(id));
    const room = {
      id,
      hostToken: crypto.randomBytes(16).toString('hex'), // proves "I'm the original laptop" on resume
      host: null,                 // WebSocket of the laptop
      controllers: new Map(),     // playerId -> WebSocket of a phone
      createdAt: Date.now(),
      hostLeftAt: Date.now(),
    };
    this.rooms.set(id, room);
    return room;
  }

  get(id) {
    return this.rooms.get(this.normalize(id));
  }

  delete(id) {
    this.rooms.delete(id);
  }

  // Remove rooms whose laptop has been gone longer than the grace period.
  sweep(now = Date.now()) {
    const expired = [];
    for (const room of this.rooms.values()) {
      if (!room.host && now - room.hostLeftAt > this.hostGraceMs) expired.push(room);
    }
    for (const room of expired) this.rooms.delete(room.id);
    return expired;
  }
}

module.exports = { RoomManager, ROOM_RE };

# Anything But a Game Controller

Turn your **phone into a real-time motion controller** for a browser game on your laptop.
Scan a QR code, calibrate, **tilt to steer**, **shake to jump**.

* Phone = responsive web app (DeviceOrientation + DeviceMotion = gyroscope + accelerometer)
* Laptop = HTML5 Canvas game (neon night-road dodger)
* Server = one Node.js process (Express + `ws` WebSockets), no database, no framework

---

## 1. Quick start

Requirements: **Node.js 18+** and a phone + laptop on the **same Wi-Fi**.

```bash
npm install          # express, ws, qrcode
npm run cert         # one-time: creates a self-signed HTTPS cert (needed for phone sensors, see §3)
npm start
```

1. On the laptop open **https://localhost:3000** (accept the browser's one-time certificate warning).
2. Scan the QR code with your phone camera (accept the certificate warning on the phone too).
3. Tap **Enable motion sensors** (iPhone shows a permission prompt, tap *Allow*).
4. Hold the phone the way you like and tap **CALIBRATE**.
5. **Shake** the phone to start. Tilt to steer, shake to jump. Orange barriers can be jumped, red/grey obstacles must be dodged.

Keyboard fallback on the laptop: `← →` / `A D` steer, `Space` jump/start, `R` restart.

`npm test` runs the automated server/protocol tests.

---

## 2. Architecture

```
 ┌──────────────────────┐     WebSocket (wss://…/ws)      ┌─────────────────────────┐
 │  PHONE  controller   │ ──── in {seq,x,ts}  @40 Hz ───▶ │                         │
 │  controller.html     │ ──── jump {seq,ts} ───────────▶ │   Node.js server        │
 │  sensors.js (tilt,   │ ◀─── fx / game / e2e:ping ───── │   ├ Express: static     │
 │  calibration, shake) │                                 │   │   files + /api/qr   │
 └──────────────────────┘                                 │   ├ rooms.js            │
                                                          │   │   (room registry)   │
 ┌──────────────────────┐                                 │   └ ws-handler.js       │
 │  LAPTOP  game        │ ◀─── in / jump (routed) ─────── │      (validate+route)   │
 │  index.html          │ ──── e2e:ping, fx, game ──────▶ │                         │
 │  game.js (Canvas)    │                                 └─────────────────────────┘
 │  host.js (network+UI)│
 └──────────────────────┘
```

A **room** = one game session: `{ id, hostToken, host (laptop socket), controllers (Map playerId → phone socket) }`.
The server only forwards a phone's messages to **the host of that phone's own room**, so a phone can never steer another session.

### Folder structure

```
anything-but-a-game-controller/
├─ package.json            dependencies + scripts
├─ .gitignore
├─ README.md
├─ server/
│  ├─ index.js             HTTP(S) server, static files, /api/qr, /api/link, starts WebSocket server
│  ├─ rooms.js             room codes, create/get/sweep abandoned rooms
│  ├─ ws-handler.js        message validation + routing, heartbeat, rate limit
│  └─ lan.js               finds the laptop's Wi-Fi IP for the QR code
├─ scripts/make-cert.js    creates certs/key.pem + certs/cert.pem (needs openssl)
├─ public/
│  ├─ index.html           laptop game page          ┐
│  ├─ css/game.css                                    │ laptop
│  ├─ js/game.js           physics + drawing          │
│  ├─ js/host.js           network, QR, status, loop  ┘
│  ├─ controller.html      phone page                ┐
│  ├─ css/controller.css                              │ phone
│  ├─ js/sensors.js        permission, tilt, calibration, shake
│  ├─ js/controller.js     network, UI, streaming loop┘
│  └─ js/common.js         auto-reconnecting WebSocket + storage helpers (both pages)
└─ test/protocol.test.js   automated pairing/routing tests
```

### Message protocol (JSON, deliberately tiny)

| Direction | Message | Purpose |
|---|---|---|
| laptop → server | `host:create {room?, token?}` | create a room, or resume the previous one after refresh |
| server → laptop | `room:created {room, token, resumed, players}` | room code + secret token |
| phone → server | `ctl:join {room, playerId}` | join a room (validated) |
| server → phone | `joined` / `error {code}` | `ROOM_NOT_FOUND`, `ROOM_FULL`, `BAD_REQUEST` |
| phone → laptop | `in {seq, x, ts}` | steering `x ∈ [-1, 1]` ~40×/s |
| phone → laptop | `jump {seq, ts}` | one message per shake |
| laptop ↔ phone | `e2e:ping` / `e2e:pong {ts}` | latency probe through the server |
| laptop → phone | `fx`, `game {state, score, lat}` | vibration cue, status display |
| both ↔ server | `ping` / `pong {ts}` | heartbeat + server round-trip time |

---

## 3. HTTPS & sensor permissions (important)

Browsers only expose motion sensors on **secure contexts**:

* **iOS Safari**: needs HTTPS *and* an explicit permission tap (`DeviceMotionEvent.requestPermission()`, called from the *Enable* button).
* **Android Chrome**: DeviceOrientation/DeviceMotion are blocked on plain `http://192.168.x.x`.
* `http://localhost` counts as secure, but that only helps the laptop, not the phone.

So for a real phone test you need HTTPS. Pick **one**:

**A. Self-signed certificate (default, free, local)**
```bash
npm run cert     # uses openssl, includes localhost + your LAN IP
npm start        # server detects certs/ and switches to https + wss automatically
```
Accept the certificate warning once on laptop and phone. If your laptop has several network adapters, pick the right one with `HOST_IP=192.168.1.23 npm run cert` and `HOST_IP=192.168.1.23 npm start`.
No `openssl` (Windows)? Git for Windows ships one (`C:\Program Files\Git\usr\bin\openssl.exe`), or install [mkcert](https://github.com/FiloSottile/mkcert): `mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 127.0.0.1 <LAN-IP>` (mkcert certs can also be trusted on the phone without warnings).

**B. HTTPS tunnel (no certificate warnings, works even on guest Wi-Fi)**
```bash
npm start                                   # plain http is fine here
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```
Open the **https://…trycloudflare.com** URL **on the laptop**; the QR code then points to the same public https address. Tunnels add some latency.

**C. Android-only dev shortcut**: in Chrome open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://<LAN-IP>:3000`, relaunch.

If sensors are unavailable or denied the phone page tells you why and shows a **touch pad** so steering still works.

---

## 4. How the pieces work

### Pairing
1. Laptop page connects and sends `host:create`; server makes a **4-character room code** (alphabet without `0 O 1 I`, 32⁴ ≈ 1 M codes) and a secret `hostToken`.
2. Laptop shows the code and a **QR code** of `https://<laptop-LAN-IP>:3000/controller.html?room=ABCD`. (Server swaps `localhost` for your LAN IP automatically; override with `PUBLIC_URL`.)
3. Phone opens the link and sends `ctl:join`. The server validates the code format, checks the room exists, and refuses a second phone (`ROOM_FULL`) unless it is the *same* phone reconnecting (same `playerId`).
4. If the code is wrong or the room expired, the phone shows a clear error and a box to type a new code.
5. Refreshing the laptop page resumes the same room (token stored in `sessionStorage`).

### Tilt → steering
`sensors.js` computes the **sideways pull of gravity** along the phone's x-axis from the standard orientation angles: `sin(tilt) = cos(beta)·sin(gamma)`. This works whether the phone is held flat, tilted back or upright (plain `gamma` becomes unreliable when upright). Steps: light low-pass → subtract the **calibrated neutral** → **dead zone** (3°) → scale by sensitivity (full steering at 25° / sensitivity) → clamp to `[-1, 1]`.
Note: if you hold the phone tilted far back, twisting it needs a bit more angle than holding it flat. Raise the sensitivity slider if you like.

### Shake → jump
Uses acceleration *without* gravity from `devicemotion` (falls back to `|accelerationIncludingGravity| − 9.81`). Tilting does not change it; shaking does. A jump fires when it exceeds the **threshold** (default 14 m/s², slider on the phone). It then **disarms** until the motion calms below 40 % of the threshold and a 600 ms cooldown has passed, so **one shake = one jump**. The gyroscope rate is read too (used by the browser's fused orientation).

### Calibration
**CALIBRATE** averages ~0.5 s of tilt samples while you hold the phone still and saves this as the neutral position (also in `localStorage`). Tap **RECALIBRATE** any time.

### Latency approach (honest version)
* Phone sends only `{seq, x, ts}` at 40 Hz (and only when the value changed, plus a 150 ms keep-alive). Jumps are sent immediately as separate messages.
* `TCP_NODELAY`-style behaviour is the browser/`ws` default for small frames; there is no batching.
* The laptop **measures** a probe round trip *laptop → server → phone → server → laptop* every second and shows **round-trip ÷ 2** as an *approximate* one-way delay. The two devices' clocks are not synchronised, so exact one-way time cannot be measured; the real input-to-screen delay also includes sensor sampling (~16 ms), phone and monitor rendering, and the game's smoothing.
* The game applies a ~50 ms exponential smoothing to steering to hide jitter. That is a deliberate trade-off between smoothness and responsiveness.
* **There is no "zero latency."** On a good local Wi-Fi expect roughly 5–30 ms network delay, plus ~50–100 ms for sensors, smoothing and display. Congested Wi-Fi or tunnels will be worse.

### Reliability
* Both pages use a **reconnecting socket** (exponential backoff, wakes immediately when the tab becomes visible or the network returns).
* **Heartbeats**: clients ping every 2 s and drop/reconnect if the server is silent for 6 s; the server pings every 15 s and terminates dead sockets.
* If the controller drops during play the game **pauses**; when it returns, shake to resume.
* Input is validated on the server (finite numbers, clamped to ±1, integer `seq`, message size ≤ 1 KB, ≤ 200 msg/s per socket). Unknown message types are ignored. The game ignores out-of-order `seq` values and treats input older than 600 ms as "stale" (steering → 0).
* Rooms whose laptop is gone for 60 s are deleted and phones are told (`room:closed`). Sockets that never identify themselves are closed after 10 s. Max 200 rooms.
* Page listeners, timers and sockets are removed on `pagehide`.

---

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| QR opens a page but "No sensor data" | You're on `http`. Use HTTPS (§3). |
| Phone can't open the link at all | Different Wi-Fi? Guest/"client isolation" network? Laptop firewall blocking port 3000? Try a phone hotspot, or use a tunnel. |
| QR points to the wrong IP | Several adapters (VPN, VirtualBox, WSL). Start with `HOST_IP=<your Wi-Fi IP> npm start`. |
| iPhone: no permission prompt / denied | Reload the page and tap *Enable* again; check *Settings → Safari → Motion & Orientation Access*. |
| "Room does not exist" | The laptop server restarted or the room expired. Reload the game page, scan the new QR code. |
| "Another phone is already controlling" | Close the other phone's tab, or wait ~30 s for its dead connection to be cleaned up. |
| Steering drifts | Tap **Recalibrate** while holding still. |
| Jumps trigger too easily / not at all | Move the **Shake strength** slider (higher = harder shake needed). |
| Controls feel laggy | Check the latency number. Move closer to the router, use 5 GHz Wi-Fi, avoid tunnels. |
| Certificate warning on every load | Normal for self-signed certs; use mkcert or a tunnel to avoid it. |
| `EADDRINUSE` | `PORT=3001 npm start` |
| QR image missing | Run `npm install` (the `qrcode` package). Room code + link still work. |

---

## 6. Testing checklist

- [ ] `npm install && npm test` → all tests pass
- [ ] `npm start`, laptop shows room code + QR; status says *Waiting for phone*
- [ ] Scan QR on phone → both devices show **connected**
- [ ] Enable sensors → knob moves when tilting; label shows LEFT/CENTER/RIGHT
- [ ] Calibrate in a tilted pose → that pose now reads CENTER; small wobble inside dead zone does nothing
- [ ] Shake → game starts; later shake → exactly one jump per shake
- [ ] Jump button works; clears orange barriers; red/grey obstacles still crash you
- [ ] Crash → overlay, vibration (Android); shake or Restart button restarts after ~1 s
- [ ] Difficulty visibly increases (faster, denser)
- [ ] Latency indicator shows a number on both screens
- [ ] Toggle phone Wi-Fi off/on → phone says *Reconnecting…*, game pauses, resumes after shake
- [ ] Refresh laptop page → same room code, phone stays paired
- [ ] Open `controller.html?room=ZZZZ` → clear "room does not exist" message
- [ ] Second phone on same room → "already controlling" message
- [ ] Deny sensor permission → message + touch pad fallback works
- [ ] Keyboard fallback works

---

## 7. Demo script & recording the screen capture

**Setup (before recording):** `npm run cert && npm start`, laptop on Wi-Fi, phone on same Wi-Fi, phone notifications off, screen auto-lock off, laptop at 100 % zoom.

**How to record "the phone controlling the game":** you need *both* the laptop screen and the phone in view.
* Easiest: record the laptop screen (OBS, Windows `Win+G`, macOS `Cmd+Shift+5`) **while filming your hands holding the phone with a second device/camera**, or
* Use OBS with two sources: laptop display capture + phone camera/hand-cam; or
* Record the phone screen too (Android screen recorder / iOS control-centre recorder) and put the two clips side by side in any editor.

**Script (~90 seconds):**
1. (0:00) "This turns a phone into a motion controller." Show the laptop: QR code, room code, *Waiting for phone*.
2. (0:10) Scan the QR code. Show both screens turning green / *connected*.
3. (0:20) Tap *Enable motion sensors*, then hold the phone and tap **Calibrate**. Show the tilt gauge moving and the dead zone.
4. (0:35) **Shake** to start. Tilt left/right to dodge; jump over an orange barrier with a shake. Point at the latency badge.
5. (1:00) Crash → game over → shake to restart.
6. (1:10) Show reliability: toggle phone Wi-Fi off/on, game pauses, reconnects, shake to resume.
7. (1:25) Show the repo, README and `npm test` passing.

---

## 8. Known limitations & future improvements

**Limitations**
* One phone per game (server and protocol are keyed by `playerId`, so multi-phone is a game-side change, not a protocol change).
* Portrait phone orientation only (landscape "steering wheel" mode isn't implemented).
* Self-signed HTTPS needs a one-time warning accepted on both devices; behaviour of `wss://` with self-signed certs can vary between browsers, so a tunnel or mkcert is the fallback.
* Vibration feedback works on Android only (iOS Safari has no Vibration API).
* Latency is *estimated* (RTT/2), not measured one-way; the laptop and phone clocks aren't synchronised.
* Room codes are short for convenience; there is no authentication (not intended for the public internet).
* Sensor quality and `devicemotion` rates vary by phone (some Android devices deliver 20–60 Hz).

**Ideas**
* Local multiplayer (2–4 phones, one car each), landscape steering-wheel mode, on-screen buttons
* Clock-sync handshake for true one-way latency; WebRTC DataChannel for lower latency
* Sound effects, power-ups, leaderboards, installable PWA, optional shake-to-boost

---

## 9. What was verified

* Server pairing, routing, validation, resume and cleanup: **automated tests** (`npm test`).
* Laptop page + phone page in a headless browser with **simulated** sensor events: pairing, calibration, tilt both ways, shake-to-start, jump button, latency readout, refresh-resume, forced-disconnect reconnect, bad-room error.
* **Not verified in the build environment:** a physical phone's real sensors, iOS permission prompt, the QR image (needs `npm install` for the `qrcode` package) and a real Wi-Fi network. Please run the checklist above on your devices.

import React, { useEffect, useRef, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, Pressable, StyleSheet, StatusBar, Platform } from 'react-native';
import { Accelerometer } from 'expo-sensors';

const PLAYER_ID = `rn_${Math.random().toString(36).slice(2, 13)}`;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export default function App() {
  const [server, setServer] = useState('192.168.1.10:3000');
  const [room, setRoom] = useState('');
  const [status, setStatus] = useState('Enter your laptop address and room code');
  const [connected, setConnected] = useState(false);
  const [sensorReady, setSensorReady] = useState(false);
  const [tilt, setTilt] = useState(0);
  const [gameState, setGameState] = useState('waiting');
  const [score, setScore] = useState(0);
  const socket = useRef(null);
  const seq = useRef(0);
  const neutral = useRef(0);
  const latestTilt = useRef(0);
  const lastSent = useRef(0);
  const lastJump = useRef(0);
  const lastAccel = useRef(null);
  const jumpArmed = useRef(true);
  const active = useRef(false);

  useEffect(() => {
    let subscription;
    let mounted = true;
    Accelerometer.setUpdateInterval(40);
    subscription = Accelerometer.addListener(({ x, y, z }) => {
      // In a portrait-held phone, x is a useful gravity-based left/right tilt signal.
      const raw = clamp(x * 1.8, -1, 1);
      latestTilt.current = raw;
      if (mounted) setTilt(raw);
      const now = Date.now();
      const prev = lastAccel.current;
      if (prev) {
        const delta = Math.sqrt((x-prev.x)**2 + (y-prev.y)**2 + (z-prev.z)**2) * 9.81;
        if (delta > 14 && jumpArmed.current && now-lastJump.current > 650) {
          jumpArmed.current = false;
          lastJump.current = now;
          send({ t: 'jump', seq: ++seq.current, ts: now });
          if (mounted) setStatus('Jump sent!');
        }
        if (delta < 4.5) jumpArmed.current = true;
      }
      lastAccel.current = { x, y, z };
      if (active.current && socket.current?.readyState === 1 && now-lastSent.current >= 40) {
        lastSent.current = now;
        send({ t: 'in', seq: ++seq.current, x: clamp((raw-neutral.current)*1.5, -1, 1), ts: now });
      }
    });
    return () => { mounted = false; subscription?.remove(); socket.current?.close(); };
  }, []);

  function send(payload) {
    if (socket.current?.readyState === 1) socket.current.send(JSON.stringify(payload));
  }

  function connect() {
    const raw = server.trim();
    const wantsSecure = /^(https|wss):\/\//i.test(raw);
    const host = raw.replace(/^(https?|wss?):\/\//i, '').replace(/\/.*$/, '');
    const code = room.trim().toUpperCase();
    if (!host || !/^[A-HJ-NP-Z2-9]{4}$/.test(code)) {
      setStatus('Enter the laptop IP:port and the 4-character room code.'); return;
    }
    socket.current?.close();
    setConnected(false); active.current = false;
    attempt(wantsSecure ? 'wss' : 'ws', host, code, !wantsSecure);
  }

  // Tries ws:// first (plain HTTP server). If that fails and fallback is allowed,
  // tries wss:// once (HTTPS server) before giving up with a helpful message.
  function attempt(scheme, host, code, allowFallback) {
    setStatus(`Connecting (${scheme}://${host})…`);
    let ws;
    try { ws = new WebSocket(`${scheme}://${host}/ws`); }
    catch (e) { setStatus(`Invalid address: ${e.message}`); return; }
    socket.current = ws;
    let opened = false;
    let failed = false;
    const fail = (why) => {
      if (failed || socket.current !== ws) return;
      failed = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (allowFallback) { attempt('wss', host, code, false); return; }
      setConnected(false); active.current = false;
      setStatus(
        `Could not connect${why ? ` (${why})` : ''}. Check: same Wi-Fi, correct IP:port, ` +
        `firewall allows the port. If your server runs HTTPS with a self-signed certificate, ` +
        `restart it with "npm run start:http" – the app can't trust self-signed certs.`
      );
    };
    const timer = setTimeout(() => { if (!opened) fail('timeout'); }, 6000);
    ws.onopen = () => {
      opened = true; clearTimeout(timer);
      ws.send(JSON.stringify({ t: 'ctl:join', room: code, playerId: PLAYER_ID }));
    };
    ws.onmessage = (event) => {
      if (socket.current !== ws) return;
      let m; try { m = JSON.parse(event.data); } catch { return; }
      if (m.t === 'joined') {
        setConnected(true); active.current = true;
        setStatus(m.hostOnline ? 'Connected — tilt to steer, shake to jump' : 'Paired; open the game on your laptop');
      } else if (m.t === 'error') {
        setConnected(false); active.current = false;
        setStatus(m.message || `Connection error: ${m.code}`);
      } else if (m.t === 'host:status') setStatus(m.online ? 'Laptop connected' : 'Laptop disconnected — reopen the game');
      else if (m.t === 'game') { setGameState(m.state || 'waiting'); setScore(m.score || 0); }
      else if (m.t === 'fx' && m.type === 'jump') setStatus('Nice jump!');
      else if (m.t === 'room:closed') { setConnected(false); active.current = false; setStatus('Game room closed. Reconnect with a new code.'); }
    };
    ws.onerror = (e) => { if (!opened) fail(e && e.message); };
    ws.onclose = () => {
      if (!opened) { fail(); return; }
      if (socket.current === ws) { setConnected(false); active.current = false; setStatus('Disconnected. Tap Connect to rejoin.'); }
    };
  }

  function calibrate() { neutral.current = latestTilt.current; setStatus('Calibrated — hold the phone comfortably.'); }
  function jump() { lastJump.current = Date.now(); send({ t: 'jump', seq: ++seq.current, ts: Date.now() }); setStatus('Jump sent!'); }
  function steer(value) { send({ t: 'in', seq: ++seq.current, x: clamp(value, -1, 1), ts: Date.now() }); }

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#0b0a1f" />
      <View style={s.container}>
        <Text style={s.kicker}>MOTION CONTROLLER</Text>
        <Text style={s.title}>Anything But a{ '\n' }Game Controller</Text>
        <Text style={s.subtitle}>Your phone becomes the steering wheel.</Text>
        <View style={s.panel}>
          <Text style={s.label}>LAPTOP SERVER ADDRESS</Text>
          <TextInput value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} placeholder="192.168.1.10:3000" placeholderTextColor="#77758f" style={s.input} />
          <Text style={s.label}>4-CHARACTER ROOM CODE</Text>
          <TextInput value={room} onChangeText={v => setRoom(v.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0,4))} autoCapitalize="characters" autoCorrect={false} maxLength={4} placeholder="ABCD" placeholderTextColor="#77758f" style={[s.input, s.roomInput]} />
          <Pressable onPress={connect} style={[s.primary, connected && s.connected]}><Text style={s.primaryText}>{connected ? 'RECONNECT' : 'CONNECT TO GAME'}</Text></Pressable>
          <Text style={s.status}>{status}</Text>
          <View style={s.statusRow}><View style={[s.dot, connected ? s.dotOn : null]} /><Text style={s.small}>{connected ? 'CONNECTED' : 'NOT CONNECTED'}</Text><Text style={s.small}> {`•  ${gameState.toUpperCase()}  •  SCORE ${score}`}</Text></View>
        </View>
        <View style={s.panel}>
          <View style={s.row}><Text style={s.section}>TILT STEERING</Text><Text style={s.value}>{Math.round(tilt * 100)}%</Text></View>
          <View style={s.meter}><View style={s.centerLine}/><View style={[s.meterDot, { left: `${clamp((tilt + 1) * 50, 3, 97)}%` }]} /></View>
          <Text style={s.hint}>Tilt left or right to steer. Tap calibrate while holding the phone in your normal position.</Text>
          <Pressable onPress={calibrate} style={s.secondary}><Text style={s.secondaryText}>CALIBRATE NEUTRAL POSITION</Text></Pressable>
          <Pressable onPress={jump} style={s.jump}><Text style={s.jumpText}>SHAKE OR TAP TO JUMP</Text></Pressable>
          <View style={s.rowButtons}>
            <Pressable onPress={() => steer(-1)} onPressOut={() => steer(0)} style={s.direction}><Text style={s.directionText}>◀ LEFT</Text></Pressable>
            <Pressable onPress={() => steer(1)} onPressOut={() => steer(0)} style={s.direction}><Text style={s.directionText}>RIGHT ▶</Text></Pressable>
          </View>
        </View>
        <Text style={s.footer}>Keep your phone and laptop on the same Wi-Fi. Enter the room code shown on the laptop game.</Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#0b0a1f'}, container:{flex:1,paddingHorizontal:20,paddingTop:18,paddingBottom:12}, kicker:{color:'#a89cff',fontSize:11,fontWeight:'800',letterSpacing:3}, title:{color:'#fff',fontSize:30,fontWeight:'900',lineHeight:34,marginTop:8}, subtitle:{color:'#aaa8c2',fontSize:13,marginTop:7,marginBottom:16}, panel:{backgroundColor:'#17152f',borderColor:'#302b55',borderWidth:1,borderRadius:18,padding:16,marginBottom:13}, label:{color:'#a8a5c5',fontSize:10,fontWeight:'800',letterSpacing:1.3,marginBottom:7,marginTop:4}, input:{backgroundColor:'#0f0e24',borderColor:'#39345f',borderWidth:1,borderRadius:10,color:'#fff',paddingHorizontal:12,paddingVertical:11,fontSize:14,marginBottom:12}, roomInput:{letterSpacing:8,fontWeight:'900',fontSize:20}, primary:{backgroundColor:'#8b5cf6',borderRadius:11,padding:14,alignItems:'center',marginTop:2}, connected:{backgroundColor:'#168b6a'},primaryText:{color:'#fff',fontWeight:'900',letterSpacing:1,fontSize:12},status:{color:'#ddd9f7',fontSize:12,lineHeight:17,marginTop:11},statusRow:{flexDirection:'row',alignItems:'center',marginTop:10,flexWrap:'wrap'},dot:{width:8,height:8,borderRadius:4,backgroundColor:'#77758f',marginRight:7},dotOn:{backgroundColor:'#39dba6'},small:{fontSize:9,fontWeight:'800',letterSpacing:.7,color:'#aaa8c2'},row:{flexDirection:'row',alignItems:'center',justifyContent:'space-between'},section:{color:'#fff',fontWeight:'900',fontSize:12,letterSpacing:1},value:{color:'#c4b5fd',fontWeight:'800',fontSize:12},meter:{height:24,backgroundColor:'#0f0e24',borderRadius:12,marginTop:12,marginBottom:9,justifyContent:'center',position:'relative',overflow:'hidden'},centerLine:{position:'absolute',left:'50%',top:0,bottom:0,width:2,backgroundColor:'#575174'},meterDot:{position:'absolute',width:14,height:14,borderRadius:7,backgroundColor:'#a78bfa',marginLeft:-7,borderWidth:2,borderColor:'#fff'},hint:{color:'#aaa8c2',fontSize:11,lineHeight:16,marginBottom:12},secondary:{borderWidth:1,borderColor:'#6e61a7',borderRadius:10,padding:12,alignItems:'center'},secondaryText:{color:'#d7ceff',fontSize:10,fontWeight:'900',letterSpacing:.7},jump:{backgroundColor:'#f97316',borderRadius:12,padding:16,alignItems:'center',marginTop:10},jumpText:{color:'#fff',fontSize:13,fontWeight:'900',letterSpacing:.8},rowButtons:{flexDirection:'row',gap:10,marginTop:10},direction:{flex:1,backgroundColor:'#252143',borderColor:'#49416f',borderWidth:1,borderRadius:10,padding:13,alignItems:'center'},directionText:{color:'#fff',fontSize:11,fontWeight:'900'},footer:{color:'#77758f',fontSize:10,lineHeight:15,textAlign:'center',paddingHorizontal:8,marginTop:'auto',paddingTop:2}
});

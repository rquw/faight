const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game, DT, mapPreview } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url === '/version') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' });
    return res.end(require('../package.json').version);
  }
  const file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    // sounds never change: let the browser keep them instead of re-downloading every visit
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.mp3' ? 'public, max-age=2592000, immutable' : 'no-cache' });
    res.end(data);
  });
});

const rooms = new Map();
// The only limit is how many people share one room - that is what costs bandwidth and makes it laggy.
// Anyone can always open another room; ROOM_SAFETY only exists so nobody can spam thousands of them.
const MAX_PLAYERS = 20, ROOM_SAFETY = 60;
// one game per device: the browser sends a random id it stores locally, so a second tab on the same
// machine is turned away. (The public IP is useless for this - a whole school shares one.)
const devices = new Map();   // device id -> ws

function deviceBusy(dev, ws) {
  if (!dev) return false;
  const other = devices.get(dev);
  if (other && other !== ws && other.readyState === 1) return true;
  if (other && other !== ws) devices.delete(dev);   // stale socket
  return false;
}

function roomCards() {
  return [...rooms.values()].filter(g => g.players.size > 0).map(g => ({
    code: g.code, map: g.mapDef ? g.mapDef.name : '', max: MAX_PLAYERS,
    players: [...g.players.values()].map(p => [p.name, p.color, p.score]),
  }));
}

function newCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

// no per-message compression: on a small instance the CPU it costs is worth more than the bytes,
// and Nagle off so a finished snapshot goes out immediately instead of waiting for a full segment
server.noDelay = true;
server.on('connection', (socket) => socket.setNoDelay(true));
const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on('connection', (ws) => {
  let room = null, player = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'i' && player) return room.input(player, msg);
    if (msg.t === 'dev' && player && process.env.FAIGHT_DEV) {
      const i = require('./maps').findIndex(m => m.name === msg.map);
      room.forceMap = i >= 0 ? i : null;
      return room.startRound();
    }
    if (msg.t === 'queue' && player) return room.queueMap(player, msg.map);
    if (msg.t === 'chat' && player) return room.chat(player, msg.text);
    if (msg.t === 'bot' && player && player.name.toLowerCase() === 'fabiolul') {
      if (room.players.size < MAX_PLAYERS) room.addBot();
      return;
    }
    if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', c: msg.c }));
    if (msg.t === 'preview') {
      const data = mapPreview(String(msg.map || ''));
      if (data) ws.send(JSON.stringify({ t: 'preview', data }));
      return;
    }
    if (msg.t === 'rooms') return ws.send(JSON.stringify({ t: 'rooms', list: roomCards(), cap: MAX_PLAYERS }));
    if ((msg.t === 'create' || msg.t === 'join') && !player) {
      const dev = String(msg.dev || '').slice(0, 40);
      if (deviceBusy(dev, ws)) return ws.send(JSON.stringify({ t: 'err', m: "You're already in a game in another tab" }));
      if (msg.t === 'create') {
        if (rooms.size >= ROOM_SAFETY) return ws.send(JSON.stringify({ t: 'err', m: 'Too many rooms right now - join one from the list' }));
        const code = newCode();
        if (!code) return ws.send(JSON.stringify({ t: 'err', m: 'Server full' }));
        room = new Game(code);
        rooms.set(code, room);
      } else {
        room = rooms.get(String(msg.code || '').trim());
        if (!room) return ws.send(JSON.stringify({ t: 'err', m: 'Room not found' }));
        if (room.players.size >= MAX_PLAYERS) {
          room = null;
          return ws.send(JSON.stringify({ t: 'err', m: 'That room is full (' + MAX_PLAYERS + ' players) - join another one or make your own' }));
        }
      }
      const want = String(msg.name || 'Stick').slice(0, 14).trim() || 'Stick';
      if ([...room.players.values()].some(p => p.name.toLowerCase() === want.toLowerCase())) {
        const full = room;
        room = null;
        return ws.send(JSON.stringify({ t: 'err', m: '"' + want + '" is already taken in room ' + full.code + ' - pick another name' }));
      }
      if (dev) { devices.set(dev, ws); ws.dev = dev; }
      player = room.addPlayer(ws, want);
    }
  });
  ws.on('close', () => {
    if (ws.dev && devices.get(ws.dev) === ws) devices.delete(ws.dev);
    if (room && player) {
      room.removePlayer(player);
      if (room.players.size === 0) room.emptySince = Date.now();
    }
  });
});

// keep connections alive through proxies
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

// fixed-step game loop
let last = performance.now(), acc = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + (now - last) / 1000, 0.25);
  last = now;
  while (acc >= DT) {
    acc -= DT;
    for (const [code, g] of rooms) {
      if (g.players.size === 0 || ![...g.players.values()].some(p => !p.bot)) {
        if (Date.now() - g.emptySince > 60000) rooms.delete(code);   // kept a minute so people can come back
        continue;
      }
      try { g.tick(); } catch (e) { console.error('tick error', code, e); g.startRound(); }
    }
  }
}, 1000 / 120);

server.listen(PORT, () => {
  console.log('faight on http://localhost:' + PORT);
  // playing in the same room? this address has a ping of 2 ms instead of 60
  for (const list of Object.values(require('os').networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log('  same wifi:  http://' + i.address + ':' + PORT);
  }
});

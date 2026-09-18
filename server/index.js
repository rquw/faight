const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game, DT, mapPreview } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const rooms = new Map();
const MAX_ROOMS = 5, MAX_PLAYERS = 20, MAX_PUBLIC = 4;   // at least one slot stays open for a private room
const waiting = [];                                      // sockets queued for a free room

const publicCount = () => [...rooms.values()].filter(r => r.isPublic).length;

function roomCards() {
  return [...rooms.values()].filter(g => g.players.size > 0).map(g => ({
    rid: g.rid, code: g.isPublic ? g.code : null, pub: !!g.isPublic,
    map: g.mapDef ? g.mapDef.name : '', max: MAX_PLAYERS,
    players: [...g.players.values()].map(p => [p.name, p.color, p.score]),
  }));
}

function sendQueue() {
  waiting.forEach((w, i) => {
    if (w.ws.readyState === 1) w.ws.send(JSON.stringify({ t: 'queue', pos: i + 1, of: Math.max(waiting.length, MAX_ROOMS), rooms: MAX_ROOMS }));
  });
}

// a room died: let the next one in line create theirs
function pumpQueue() {
  while (waiting.length && rooms.size < MAX_ROOMS) {
    const w = waiting.shift();
    if (w.ws.readyState !== 1) continue;
    w.ws.send(JSON.stringify({ t: 'queueReady' }));
  }
  sendQueue();
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
    if (msg.t === 'rooms') return ws.send(JSON.stringify({ t: 'rooms', list: roomCards(), max: MAX_ROOMS, cap: MAX_PLAYERS }));
    if ((msg.t === 'create' || msg.t === 'join') && !player) {
      if (msg.t === 'create') {
        const wantPublic = msg.vis !== 'private';
        if (rooms.size >= MAX_ROOMS) {
          if (!waiting.some(w => w.ws === ws)) waiting.push({ ws, vis: msg.vis, name: msg.name });
          return sendQueue();
        }
        if (wantPublic && publicCount() >= MAX_PUBLIC) {
          return ws.send(JSON.stringify({ t: 'err', m: 'All ' + MAX_PUBLIC + ' public rooms are taken - make a private one' }));
        }
        const code = newCode();
        if (!code) return ws.send(JSON.stringify({ t: 'err', m: 'Server full' }));
        room = new Game(code);
        room.isPublic = wantPublic;
        room.rid = Math.random().toString(36).slice(2, 8);
        room.knocks = new Map();
        rooms.set(code, room);
      } else {
        room = rooms.get(String(msg.code || '').trim());
        if (!room) return ws.send(JSON.stringify({ t: 'err', m: 'Room not found' }));
        if (room.players.size >= MAX_PLAYERS) { room = null; return ws.send(JSON.stringify({ t: 'err', m: 'Room is full (' + MAX_PLAYERS + '/' + MAX_PLAYERS + ')' })); }
        if (!room.isPublic && room.players.size && !(room.invites && room.invites.has(ws))) {
          room = null;
          return ws.send(JSON.stringify({ t: 'err', m: 'This room is private - ask the host to let you in' }));
        }
      }
      const i = waiting.findIndex(w => w.ws === ws);
      if (i >= 0) { waiting.splice(i, 1); sendQueue(); }
      player = room.addPlayer(ws, msg.name);
    }
    // knocking on a private room: the host gets a request they can accept or turn down
    if (msg.t === 'knock' && !player) {
      const g = [...rooms.values()].find(r => r.rid === msg.rid);
      if (!g) return ws.send(JSON.stringify({ t: 'err', m: 'Room not found' }));
      if (g.players.size >= MAX_PLAYERS) return ws.send(JSON.stringify({ t: 'err', m: 'Room is full (' + MAX_PLAYERS + '/' + MAX_PLAYERS + ')' }));
      const host = g.players.get(g.hostId);
      if (!host) return ws.send(JSON.stringify({ t: 'err', m: 'Room not found' }));
      const kid = String(g.nextKnock = (g.nextKnock || 0) + 1);
      const who = String(msg.name || 'Stick').slice(0, 14);
      g.knocks.set(kid, { ws, name: who });
      host.ws.send(JSON.stringify({ t: 'knock', id: kid, name: who }));
      return ws.send(JSON.stringify({ t: 'knocked' }));
    }
    if (msg.t === 'knockAnswer' && player && room && player.id === room.hostId) {
      const k = room.knocks && room.knocks.get(String(msg.id));
      if (!k) return;
      room.knocks.delete(String(msg.id));
      if (k.ws.readyState !== 1) return;
      if (msg.ok) {
        (room.invites = room.invites || new Set()).add(k.ws);
        k.ws.send(JSON.stringify({ t: 'invite', code: room.code }));
      } else k.ws.send(JSON.stringify({ t: 'knockDenied' }));
      return;
    }
  });
  ws.on('close', () => {
    const i = waiting.findIndex(w => w.ws === ws);
    if (i >= 0) { waiting.splice(i, 1); sendQueue(); }
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
        // empty rooms are kept a minute so people can come back - unless somebody is queued
        if (Date.now() - g.emptySince > (waiting.length ? 8000 : 60000)) { rooms.delete(code); pumpQueue(); }
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

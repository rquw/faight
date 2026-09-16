const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game, DT } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/health') { res.writeHead(200); return res.end('ok'); }
  const file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const rooms = new Map();

function newCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

const wss = new WebSocketServer({ server });
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
    if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', c: msg.c }));
    if ((msg.t === 'create' || msg.t === 'join') && !player) {
      if (msg.t === 'create') {
        const code = newCode();
        if (!code) return ws.send(JSON.stringify({ t: 'err', m: 'Server voll' }));
        room = new Game(code);
        rooms.set(code, room);
      } else {
        room = rooms.get(String(msg.code || '').trim());
        if (!room) return ws.send(JSON.stringify({ t: 'err', m: 'Raum nicht gefunden' }));
      }
      player = room.addPlayer(ws, msg.name);
    }
  });
  ws.on('close', () => {
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
      if (g.players.size === 0) {
        if (Date.now() - g.emptySince > 60000) rooms.delete(code);
        continue;
      }
      try { g.tick(); } catch (e) { console.error('tick error', code, e); g.startRound(); }
    }
  }
}, 1000 / 120);

server.listen(PORT, () => console.log('faight on http://localhost:' + PORT));

// Test bots: node tools/bots.js <code> [count] [url]
const WebSocket = require('ws');
const protocol = require('../public/protocol');
const code = process.argv[2], count = +process.argv[3] || 1, url = process.argv[4] || 'ws://localhost:3000';
const names = ['Bob', 'Kevin', 'Sepp', 'Hans', 'Uschi', 'Gerti', 'Franz', 'Moni'];
for (let n = 0; n < count; n++) {
  const ws = new WebSocket(url);
  let me = 0, target = { x: 10, y: 5 }, self = null;
  const inp = { t: 'i', l: 0, r: 0, d: 0, j: 0, s: 0, th: 0, ax: 0, ay: 0 };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', code, name: names[n % names.length] + 'Bot' })));
  ws.on('message', (raw, isBinary) => {
    const m = isBinary ? Object.assign({ t: 's' }, protocol.decode(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))) : JSON.parse(raw);
    if (m.t === 'joined') { me = m.id; if (n === 0 && process.env.MAP) { const list = process.env.MAP.split(','); let k = 0; const next = () => { ws.send(JSON.stringify({ t: 'dev', map: list[k++ % list.length] })); }; setTimeout(next, 800); if (list.length > 1) setInterval(next, +process.env.EVERY || 8000); } }
    if (m.t !== 's') return;
    const others = m.P.filter(p => p[0] !== me && p[1]);
    self = m.P.find(p => p[0] === me);
    if (others.length) target = { x: others[0][9] / 100, y: others[0][10] / 100 };
  });
  setInterval(() => {
    if (ws.readyState !== 1 || !self) return;
    const sx = self[9] / 100;
    const dx = target.x - sx;
    inp.r = dx > 3 && Math.random() > 0.2 ? 1 : 0;
    inp.l = dx < -3 && Math.random() > 0.2 ? 1 : 0;
    inp.j = Math.random() < 0.08 ? 1 : 0;
    inp.s = Math.abs(dx) < 14 && Math.random() < 0.5 ? 1 : 0;
    inp.ax = target.x; inp.ay = target.y + 0.3;
    ws.send(JSON.stringify(inp));
  }, 100);
}

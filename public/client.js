(() => {
'use strict';
const WEAPONS = ['pistol', 'ar', 'shotgun', 'sniper', 'rpg', 'minigun', 'grenade'];
const WNAME = { pistol: 'Pistole', ar: 'Sturmgewehr', shotgun: 'Schrotflinte', sniper: 'Sniper', rpg: 'Raketenwerfer', minigun: 'Minigun', grenade: 'Granaten' };
const DIM = { torsoHH: 0.42, headR: 0.25, uArmHH: 0.2, lArmHH: 0.19, uLegHH: 0.25, lLegHH: 0.25 };
const LIMB_HH = [DIM.torsoHH, 0, DIM.uArmHH, DIM.lArmHH, DIM.uArmHH, DIM.lArmHH, DIM.uLegHH, DIM.lLegHH, DIM.uLegHH, DIM.lLegHH];
const INTERP = 0.12;

const $ = (id) => document.getElementById(id);
const cv = $('c'), ctx = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;

// ---------------------------------------------------------------- state
let ws = null, myId = 0, roomCode = '';
const roster = new Map();
let map = null;
let snaps = [];
let clockOffset = null;
let particles = [], tracers = [], texts = [], flashes = [];
let pendingEvents = [];
let shake = 0;
let banner = null;
let lastPlayers = new Map();
let muted = false;
let ping = 0;

// ---------------------------------------------------------------- menu
const nameIn = $('name'), codeIn = $('code');
try { nameIn.value = localStorage.getItem('faight-name') || ''; } catch {}
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) codeIn.value = urlCode;
codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.replace(/\D/g, '').slice(0, 4); });

function go(kind) {
  const name = nameIn.value.trim() || 'Stick' + Math.floor(Math.random() * 99);
  try { localStorage.setItem('faight-name', name); } catch {}
  if (kind === 'join' && codeIn.value.length !== 4) { $('err').textContent = '4-stelligen Code eingeben'; return; }
  audio();
  connect(() => ws.send(JSON.stringify(kind === 'create' ? { t: 'create', name } : { t: 'join', name, code: codeIn.value })));
}
$('create').onclick = () => go('create');
$('join').onclick = () => go('join');
codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go('join'); });
nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') codeIn.value.length === 4 ? go('join') : go('create'); });
$('copy').onclick = () => {
  const link = location.origin + location.pathname + '?code=' + roomCode;
  navigator.clipboard && navigator.clipboard.writeText(link);
  $('copy').textContent = '✓'; setTimeout(() => $('copy').textContent = '🔗', 1200);
};
$('mute').onclick = () => { muted = !muted; $('mute').textContent = muted ? '🔇' : '🔊'; };

function connect(onOpen, attempt = 0) {
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); }
  $('err').textContent = attempt ? `Server wacht auf… (${attempt * 3}s, kann bis zu 1 Min dauern)` : 'Verbinde…';
  const sock = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  let opened = false;
  sock.onopen = () => { opened = true; $('err').textContent = ''; onOpen(); };
  sock.onclose = () => {
    if (!opened) {
      if (attempt < 25) setTimeout(() => connect(onOpen, attempt + 1), 3000);
      else $('err').textContent = 'Server nicht erreichbar';
      return;
    }
    if (myId) { $('menu').hidden = false; $('hud').hidden = true; $('err').textContent = 'Verbindung verloren'; myId = 0; map = null; }
  };
  sock.onmessage = (ev) => onMessage(JSON.parse(ev.data));
}

setInterval(() => { if (ws && ws.readyState === 1 && myId) ws.send(JSON.stringify({ t: 'ping', c: performance.now() })); }, 2000);

function onMessage(m) {
  switch (m.t) {
    case 'err': $('err').textContent = m.m; break;
    case 'joined':
      myId = m.id; roomCode = m.code;
      $('roomcode').textContent = m.code;
      $('menu').hidden = true; $('hud').hidden = false;
      history.replaceState(null, '', '?code=' + m.code);
      break;
    case 'roster': {
      const old = new Map([...roster].map(([id, r]) => [id, r.score]));
      roster.clear();
      for (const [id, name, color, score] of m.list) roster.set(id, { name, color, score, bump: old.has(id) && old.get(id) < score });
      renderScores();
      break;
    }
    case 'map':
      map = m;
      map.shapeById = new Map(m.shapes.map(s => [s.id, s]));
      map.deco = makeDeco(m);
      snaps = []; clockOffset = null; pendingEvents = []; particles = []; tracers = [];
      banner = { text: m.name, sub: m.playing.includes(myId) ? '' : 'Du schaust zu – nächste Runde bist du dabei', t: 0, life: 2.2, kind: 'map' };
      sfx('start');
      break;
    case 's': onSnap(m); break;
    case 'pong': ping = Math.round(performance.now() - m.c); $('ping').textContent = ping + ' ms'; break;
  }
}

function renderScores() {
  const el = $('scores');
  el.innerHTML = '';
  [...roster.entries()].sort((a, b) => b[1].score - a[1].score).forEach(([id, r]) => {
    const d = document.createElement('div');
    d.className = 'score' + (id === myId ? ' me' : '');
    d.innerHTML = `<i style="background:${r.color}"></i><span></span><em>${r.score}</em>`;
    d.querySelector('span').textContent = r.name;
    el.appendChild(d);
  });
}

function feed(html) {
  const d = document.createElement('div');
  d.className = 'kill';
  d.innerHTML = html;
  $('feed').prepend(d);
  setTimeout(() => d.remove(), 5000);
  while ($('feed').children.length > 6) $('feed').lastChild.remove();
}
const esc = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const tag = (id) => { const r = roster.get(id); return r ? `<span style="color:${r.color}">${esc(r.name)}</span>` : '???'; };

// ---------------------------------------------------------------- snapshots
function onSnap(s) {
  const now = performance.now() / 1000;
  const t = s.tm / 1000;
  if (clockOffset === null || snaps.length === 0) clockOffset = t - now;
  else clockOffset += ((t - now) - clockOffset) * 0.05;
  if (t - now > clockOffset + 0.05) clockOffset = t - now; // server ahead: catch up
  const snap = { t, P: new Map(), O: new Map(), I: new Map(), R: new Map(), fz: s.fz, wd: s.wd };
  for (const p of s.P) snap.P.set(p[0], p);
  for (const o of s.O) snap.O.set(o[0], o);
  for (const i of s.I) snap.I.set(i[0], i);
  for (const r of s.R) snap.R.set(r[0], r);
  snaps.push(snap);
  if (snaps.length > 30) snaps.shift();
  for (const e of s.e) pendingEvents.push({ t, e });
}

const lerp = (a, b, k) => a + (b - a) * k;
const lerpA = (a, b, k) => { let d = b - a; d -= Math.PI * 2 * Math.round(d / (Math.PI * 2)); return a + d * k; };

function sample() {
  if (!snaps.length) return null;
  const rt = performance.now() / 1000 + clockOffset - INTERP;
  let a = snaps[0], b = snaps[0];
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].t <= rt) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
  }
  const k = b.t > a.t ? Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t))) : 0;
  return { a, b, k, rt };
}

// ---------------------------------------------------------------- input
const keys = { l: 0, r: 0, d: 0, j: 0, s: 0, th: 0 };
let mouseX = 0, mouseY = 0;
const KEYMAP = { KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r', KeyS: 'd', ArrowDown: 'd', Space: 'j', KeyW: 'j', ArrowUp: 'j', KeyQ: 'th', KeyF: 'th' };
addEventListener('keydown', (e) => {
  if (!myId || e.target.tagName === 'INPUT') return;
  const k = KEYMAP[e.code];
  if (k) { e.preventDefault(); if (!keys[k]) { keys[k] = 1; sendInput(); } }
});
addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (k && keys[k]) { keys[k] = 0; sendInput(); }
});
addEventListener('blur', () => { for (const k in keys) keys[k] = 0; sendInput(); });
cv.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
cv.addEventListener('mousedown', (e) => {
  audio();
  if (e.button === 0) keys.s = 1; else if (e.button === 2) keys.th = 1;
  sendInput();
});
addEventListener('mouseup', (e) => { if (e.button === 0) keys.s = 0; else if (e.button === 2) keys.th = 0; sendInput(); });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

let lastSent = '';
function sendInput(force) {
  if (!ws || ws.readyState !== 1 || !myId || !map) return;
  const w = screenToWorld(mouseX, mouseY);
  const msg = { t: 'i', l: keys.l, r: keys.r, d: keys.d, j: keys.j, s: keys.s, th: keys.th, ax: Math.round(w.x * 100) / 100, ay: Math.round(w.y * 100) / 100 };
  const str = JSON.stringify(msg);
  if (!force && str === lastSent) return;
  lastSent = str;
  ws.send(str);
}
setInterval(() => sendInput(), 33);

// ---------------------------------------------------------------- camera
let cam = { s: 20, ox: 0, oy: 0 };
function updateCam() {
  if (!map) return;
  const mx = 1.5, top = 2.5;
  const vw = map.W + mx * 2, vh = map.H + top + 1;
  const s = Math.min(W / vw, H / vh);
  cam.s = s;
  cam.ox = (W - map.W * s) / 2;
  cam.oy = H - (H - vh * s) / 2 - 1 * s;
}
const sx = (x) => cam.ox + x * cam.s;
const sy = (y) => cam.oy - y * cam.s;
function screenToWorld(x, y) { return { x: (x - cam.ox) / cam.s, y: (cam.oy - y) / cam.s }; }

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- events -> effects
function processEvents(rt) {
  while (pendingEvents.length && pendingEvents[0].t <= rt + 0.02) {
    handleEvent(pendingEvents.shift().e);
  }
  if (pendingEvents.length > 400) pendingEvents.splice(0, pendingEvents.length - 400);
}

function colorOf(id) { const r = roster.get(id) || lastPlayers.get(id); return r ? r.color : '#fff'; }

function burst(x, y, n, color, speed = 6, size = 0.12, life = 0.6, grav = 1) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: life * (0.5 + Math.random()), max: life, color, size: size * (0.5 + Math.random()), g: grav });
  }
}

function handleEvent(e) {
  switch (e[0]) {
    case 'shot': {
      const [, x1, y1, x2, y2, w] = e;
      const type = WEAPONS[w];
      tracers.push({ x1, y1, x2, y2, life: type === 'sniper' ? 0.35 : 0.09, max: type === 'sniper' ? 0.35 : 0.09, w: type === 'sniper' ? 0.12 : type === 'minigun' ? 0.04 : 0.06 });
      flashes.push({ x: x1, y: y1, r: type === 'shotgun' || type === 'sniper' ? 0.6 : 0.35, life: 0.05 });
      if (!e.snd) sfx(type);
      if (type === 'shotgun') e.snd = 1;
      if (type === 'sniper') shake = Math.max(shake, 0.25);
      break;
    }
    case 'hit': {
      const [, x, y, id, kind] = e;
      const c = colorOf(id);
      burst(x, y, kind === 1 ? 22 : kind === 2 ? 8 : 10, c, kind === 1 ? 9 : 5, 0.13, 0.7);
      burst(x, y, 4, '#fff', 3, 0.08, 0.2, 0);
      if (kind === 1) { texts.push({ x, y: y + 0.6, text: 'KOPFTREFFER', color: '#fff', life: 0.9 }); sfx('head'); }
      else if (kind === 2) sfx('punchhit');
      else sfx('hit');
      break;
    }
    case 'punch': sfx('whoosh'); break;
    case 'spark': burst(e[1], e[2], 5, '#ffd36b', 5, 0.07, 0.25, 0.5); break;
    case 'boom': {
      const [, x, y, R] = e;
      flashes.push({ x, y, r: R * 1.2, life: 0.12, boom: true });
      burst(x, y, 30, '#ff9d2e', 14, 0.28, 0.5, -0.2);
      burst(x, y, 18, '#555', 6, 0.45, 1.2, -0.3);
      burst(x, y, 12, '#ffe066', 18, 0.12, 0.35, 1);
      shake = Math.max(shake, 0.9);
      sfx('boom');
      break;
    }
    case 'rocket': sfx('rocket'); break;
    case 'toss': sfx('toss'); break;
    case 'throw': sfx('toss'); break;
    case 'jump': burst(e[1], e[2], 4, '#0003', 2, 0.15, 0.3, 0); sfx('jump'); break;
    case 'bounce': burst(e[1], e[2], 10, '#ff4fa3', 6, 0.12, 0.4); sfx('boing'); break;
    case 'bonk': texts.push({ x: e[1], y: e[2] + 0.8, text: 'BONK!', color: '#ffd000', life: 0.9 }); burst(e[1], e[2], 8, colorOf(e[3]), 5); sfx('bonk'); break;
    case 'pick': {
      if (e[1] === myId) texts.push({ follow: e[1], text: WNAME[WEAPONS[e[2]]], color: '#fff', life: 1.1 });
      sfx('pick');
      break;
    }
    case 'drop': sfx('drop'); break;
    case 'die': {
      const [, id, killer, x, y] = e;
      burst(x, y, 30, colorOf(id), 10, 0.16, 1.0);
      shake = Math.max(shake, 0.4);
      sfx('die');
      if (killer && killer !== id) feed(`${tag(killer)} 💥 ${tag(id)}`);
      else feed(`${tag(id)} ${['ist verunglückt', 'hat sich selbst erledigt', 'war zu mutig', 'hat Physik unterschätzt'][Math.floor(Math.random() * 4)]}`);
      break;
    }
    case 'fall': texts.push({ x: e[2], y: Math.max(e[3], 1), text: ['BYE!', 'TSCHÜSS', 'weg ist er', 'AAAAA'][Math.floor(Math.random() * 4)], color: colorOf(e[1]), life: 1.2 }); sfx('fall'); break;
    case 'hz':
      burst(e[2], e[3], 30, e[1] === 'lava' ? '#ff7a1a' : '#ccc', 10, 0.18, 0.9);
      texts.push({ x: e[2], y: e[3] + 1, text: e[1] === 'lava' ? 'HEISS!' : e[1] === 'saw' ? 'ZACK!' : 'AUA!', color: '#fff', life: 1 });
      sfx(e[1] === 'lava' ? 'sizzle' : 'die');
      break;
    case 'crack': burst(e[1], e[2], 20, '#9a6a3c', 7, 0.18, 0.8); sfx('crack'); shake = Math.max(shake, 0.3); break;
    case 'add': if (map) { map.shapes.push(e[1]); map.shapeById.set(e[1].id, e[1]); } break;
    case 'rm': if (map) { map.shapeById.delete(e[1]); map.shapes = map.shapes.filter(s => s.id !== e[1]); } break;
    case 'win': {
      const r = roster.get(e[1]);
      banner = r ? { text: r.name + ' gewinnt!', color: r.color, t: 0, life: 2.4, kind: 'win' } : { text: 'Unentschieden', t: 0, life: 2.4, kind: 'win', color: '#fff' };
      sfx('win');
      if (r) for (let i = 0; i < 60; i++) {
        particles.push({ x: map.W * Math.random(), y: map.H + 1, vx: (Math.random() - 0.5) * 4, vy: -Math.random() * 4, life: 2.5, max: 2.5, color: ['#f7c325', '#ff4b4b', '#3d8bff', '#39d05c', r.color][i % 5], size: 0.2, g: 0.15, confetti: true, rot: Math.random() * 6 });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- drawing helpers
function hash(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function rng(seed) { return () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) + 1 >>> 0) / 4294967296); }
function makeDeco(m) {
  const r = rng(hash(m.name) + Math.round(m.W));
  const shapes = [];
  if (m.dark) for (let i = 0; i < 90; i++) shapes.push({ t: 'star', x: r() * m.W, y: r() * m.H * 1.2, s: r() * 0.08 + 0.03 });
  for (let i = 0; i < 7; i++) shapes.push({ t: 'blob', x: r() * m.W, y: m.H * (0.3 + r() * 0.8), s: 2 + r() * 5, a: 0.025 + r() * 0.035 });
  return shapes;
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

function drawProp(s, x, y, a, time) {
  ctx.save();
  ctx.translate(sx(x), sy(y));
  ctx.rotate(-a);
  const S = cam.s;
  if (s.s === 'c') {
    const r = s.r * S;
    if (s.hz === 'saw') {
      ctx.rotate(-time * 12);
      ctx.fillStyle = '#c0c6cc';
      ctx.beginPath();
      const teeth = 14;
      for (let i = 0; i <= teeth * 2; i++) {
        const ang = (i / (teeth * 2)) * Math.PI * 2, rr = i % 2 ? r * 0.78 : r;
        ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
      }
      ctx.fill();
      ctx.fillStyle = '#6b7788';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.25, 0, 7); ctx.fill();
    } else {
      ctx.fillStyle = s.c;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
      ctx.fillStyle = '#0002';
      ctx.beginPath(); ctx.arc(r * 0.3, r * 0.2, r * 0.25, 0, 7); ctx.arc(-r * 0.35, -r * 0.3, r * 0.15, 0, 7); ctx.fill();
    }
    ctx.restore();
    return;
  }
  const w = s.w * S, h = s.h * S;
  if (s.hz === 'lava') {
    ctx.fillStyle = '#ff5a1f';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = '#ffb21f';
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2 + 6);
    for (let i = 0; i <= 80; i++) {
      const px = -w / 2 + (i / 80) * w;
      ctx.lineTo(px, -h / 2 + Math.sin(i * 0.9 + time * 3) * 0.12 * S);
    }
    ctx.lineTo(w / 2, -h / 2 + 0.4 * S); ctx.lineTo(-w / 2, -h / 2 + 0.4 * S);
    ctx.fill();
  } else if (s.hz === 'spike') {
    ctx.fillStyle = '#444';
    ctx.fillRect(-w / 2, 0, w, h / 2);
    ctx.fillStyle = '#cfd4da';
    const n = Math.max(2, Math.round(s.w / 0.5));
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + (i / n) * w;
      ctx.moveTo(x0, 0); ctx.lineTo(x0 + w / n / 2, -h / 2 - 0.35 * S); ctx.lineTo(x0 + w / n, 0);
    }
    ctx.fill();
  } else {
    ctx.fillStyle = s.c;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    if (s.cr) {
      ctx.strokeStyle = '#7a5023';
      ctx.lineWidth = Math.max(1, 0.08 * S);
      ctx.strokeRect(-w / 2 + ctx.lineWidth / 2, -h / 2 + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
      ctx.beginPath(); ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(w / 2, h / 2); ctx.moveTo(w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2); ctx.stroke();
    } else {
      ctx.fillStyle = s.ice ? '#ffffff88' : s.bo ? '#ffffff55' : '#ffffff1a';
      ctx.fillRect(-w / 2, -h / 2, w, Math.min(h, 0.14 * S));
      ctx.fillStyle = '#0000002a';
      ctx.fillRect(-w / 2, h / 2 - Math.min(h * 0.4, 0.14 * S), w, Math.min(h * 0.4, 0.14 * S));
      if (s.bo) {
        ctx.fillStyle = '#fff';
        for (let i = 0; i < 3; i++) ctx.fillRect(-w / 2 + (i + 0.3) * w / 3, -h / 2, w / 12, h);
      }
    }
  }
  ctx.restore();
}

// guns are drawn in meters, pointing along +x from the hand
function drawGun(type, spin) {
  const g = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  const dark = '#232323', mid = '#4a4a4a';
  switch (type) {
    case 'pistol': g(-0.06, -0.02, 0.38, 0.12, dark); g(-0.04, -0.14, 0.09, 0.14, mid); break;
    case 'ar': g(-0.28, -0.04, 0.9, 0.12, dark); g(0.05, -0.2, 0.08, 0.18, mid); g(-0.4, -0.08, 0.14, 0.14, '#6b4a2b'); g(0.6, -0.01, 0.16, 0.05, dark); break;
    case 'shotgun': g(-0.3, -0.05, 0.95, 0.14, '#3b2a1d'); g(0.1, -0.08, 0.3, 0.08, '#6b4a2b'); g(-0.42, -0.1, 0.16, 0.16, '#6b4a2b'); break;
    case 'sniper': g(-0.35, -0.04, 1.35, 0.08, dark); g(-0.05, 0.05, 0.35, 0.08, '#111'); g(-0.47, -0.1, 0.16, 0.14, '#2d4a2b'); break;
    case 'rpg': g(-0.45, -0.1, 1.05, 0.2, '#3d5a2a'); ctx.fillStyle = '#9a3a2a'; ctx.beginPath(); ctx.moveTo(0.6, -0.1); ctx.lineTo(0.85, 0); ctx.lineTo(0.6, 0.1); ctx.fill(); g(-0.05, -0.22, 0.08, 0.14, mid); break;
    case 'minigun': {
      g(-0.3, -0.12, 0.4, 0.26, '#555');
      const off = (spin || 0) % 0.1;
      for (let i = 0; i < 3; i++) g(0.1, -0.09 + ((i * 0.08 + off) % 0.24), 0.75, 0.04, i === 1 ? '#222' : '#333');
      g(-0.05, -0.24, 0.1, 0.14, mid);
      break;
    }
    case 'grenade': ctx.fillStyle = '#3d5a2a'; ctx.beginPath(); ctx.arc(0.05, 0, 0.14, 0, 7); ctx.fill(); g(0, 0.1, 0.1, 0.06, '#888'); break;
  }
}

function limbEnds(x, y, a, hh) {
  const s = Math.sin(a), c = Math.cos(a);
  return [x - s * hh, y + c * hh, x + s * hh, y - c * hh];
}

function drawPlayer(p, time) {
  const [id, alive, hp, aim100, wIdx, ammo, stunned, spin] = p;
  const r = roster.get(id) || lastPlayers.get(id) || { name: '?', color: '#fff' };
  const color = r.color;
  const parts = [];
  for (let i = 0; i < 10; i++) parts.push([p[8 + i * 3] / 100, p[9 + i * 3] / 100, p[10 + i * 3] / 100]);
  const S = cam.s;
  const aim = aim100 / 100;
  ctx.lineCap = 'round';
  const seg = (i, col, width) => {
    const [x, y, a] = parts[i];
    const [x1, y1, x2, y2] = limbEnds(x, y, a, LIMB_HH[i]);
    ctx.strokeStyle = col;
    ctx.lineWidth = width * S;
    ctx.beginPath(); ctx.moveTo(sx(x1), sy(y1)); ctx.lineTo(sx(x2), sy(y2)); ctx.stroke();
  };
  const back = shade(color, -45);
  const outline = '#00000055';
  // outline pass for readability on any background
  for (const i of [8, 9, 4, 5, 0, 6, 7, 2, 3]) seg(i, outline, 0.26);
  seg(8, back, 0.17); seg(9, back, 0.17); seg(4, back, 0.15); seg(5, back, 0.15);
  seg(0, color, 0.24);
  seg(6, color, 0.17); seg(7, color, 0.17);
  // head
  const [hx, hy] = parts[1];
  ctx.fillStyle = outline;
  ctx.beginPath(); ctx.arc(sx(hx), sy(hy), (DIM.headR + 0.045) * S, 0, 7); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(sx(hx), sy(hy), DIM.headR * S, 0, 7); ctx.fill();
  // face
  const face = Math.cos(aim) >= 0 ? 1 : -1;
  ctx.fillStyle = '#111';
  if (!alive) {
    ctx.strokeStyle = '#111'; ctx.lineWidth = 0.04 * S;
    for (const ox of [-0.05, 0.1]) {
      const ex = sx(hx + ox * face), ey = sy(hy + 0.04), d = 0.045 * S;
      ctx.beginPath(); ctx.moveTo(ex - d, ey - d); ctx.lineTo(ex + d, ey + d); ctx.moveTo(ex + d, ey - d); ctx.lineTo(ex - d, ey + d); ctx.stroke();
    }
  } else if (stunned) {
    ctx.strokeStyle = '#111'; ctx.lineWidth = 0.03 * S;
    for (const ox of [-0.04, 0.11]) { ctx.beginPath(); ctx.arc(sx(hx + ox * face), sy(hy + 0.04), 0.04 * S, time * 10, time * 10 + 4.5); ctx.stroke(); }
    for (let i = 0; i < 3; i++) {
      const a = time * 4 + i * 2.1;
      ctx.fillStyle = '#ffd000';
      ctx.beginPath(); ctx.arc(sx(hx + Math.cos(a) * 0.35), sy(hy + 0.35 + Math.sin(a) * 0.08), 0.05 * S, 0, 7); ctx.fill();
    }
  } else {
    const lx = Math.cos(aim) * 0.05, ly = Math.sin(aim) * 0.05;
    for (const ox of [-0.02, 0.12]) { ctx.beginPath(); ctx.arc(sx(hx + ox * face + lx), sy(hy + 0.04 + ly), 0.035 * S, 0, 7); ctx.fill(); }
  }
  // front arm + gun
  seg(2, color, 0.15); seg(3, color, 0.15);
  if (wIdx >= 0) {
    const [x, y, a] = parts[3];
    const [, , hx2, hy2] = limbEnds(x, y, a, LIMB_HH[3]);
    ctx.save();
    ctx.translate(sx(hx2), sy(hy2));
    ctx.rotate(-aim);
    if (Math.cos(aim) < 0) ctx.scale(1, -1);
    ctx.scale(S, -S);
    drawGun(WEAPONS[wIdx], spin ? time * 3 : 0);
    ctx.restore();
  }
  // name + hp
  if (alive) {
    const tx = sx(hx), ty = sy(hy + 0.55);
    const bw = 1.1 * S, bh = Math.max(3, 0.12 * S);
    ctx.fillStyle = '#0008'; ctx.fillRect(tx - bw / 2 - 1, ty - 1, bw + 2, bh + 2);
    ctx.fillStyle = hp > 50 ? '#39d05c' : hp > 25 ? '#f7c325' : '#ff4b4b';
    ctx.fillRect(tx - bw / 2, ty, bw * hp / 100, bh);
    ctx.font = `800 ${Math.max(10, 0.38 * S)}px "Trebuchet MS", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#0009';
    ctx.fillText(r.name, tx + 1, ty - 4 + 1);
    ctx.fillStyle = id === myId ? '#fff' : color;
    ctx.fillText(r.name, tx, ty - 4);
    if (id === myId && wIdx >= 0) {
      ctx.font = `700 ${Math.max(9, 0.3 * S)}px "Trebuchet MS", sans-serif`;
      ctx.fillStyle = ammo > 0 ? '#fff' : '#ff4b4b';
      ctx.fillText(ammo > 0 ? ammo + ' ●' : 'LEER – klick zum Werfen', tx, sy(parts[0][1] - 1.7));
    }
  }
  return { hx, hy };
}

// ---------------------------------------------------------------- main render
let lastFrame = performance.now();
const headPos = new Map();

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  const dt = Math.min(0.05, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  const time = nowMs / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!map) {
    ctx.fillStyle = '#1b1b1f'; ctx.fillRect(0, 0, W, H);
    drawMenuBg(time);
    return;
  }
  updateCam();
  const smp = sample();
  if (smp) processEvents(smp.rt);

  // shake
  shake = Math.max(0, shake - dt * 2.5);
  const sh = shake * shake * 0.5 * cam.s;
  ctx.setTransform(dpr, 0, 0, dpr, (Math.random() - 0.5) * sh * dpr, (Math.random() - 0.5) * sh * dpr);

  // background
  ctx.fillStyle = map.bg;
  ctx.fillRect(-50, -50, W + 100, H + 100);
  for (const d of map.deco) {
    if (d.t === 'star') { ctx.fillStyle = '#fff' + (Math.sin(time * 2 + d.x) > 0.6 ? 'c' : '6'); ctx.fillRect(sx(d.x), sy(d.y), d.s * cam.s, d.s * cam.s); }
    else { ctx.fillStyle = map.dark ? `rgba(255,255,255,${d.a * 0.4})` : `rgba(0,0,0,${d.a * 0.5})`; ctx.beginPath(); ctx.arc(sx(d.x + Math.sin(time * 0.05 + d.y) * 1.5), sy(d.y), d.s * cam.s, 0, 7); ctx.fill(); }
  }

  const A = smp && smp.a, B = smp && smp.b, k = smp ? smp.k : 0;

  // wind streaks
  if (B && B.wd) {
    ctx.strokeStyle = '#ffffff55'; ctx.lineWidth = 2;
    const dir = Math.sign(B.wd);
    for (let i = 0; i < 40; i++) {
      const y = ((i * 7.3) % map.H) + 1;
      const x = (((i * 13.7 + time * 25 * dir) % (map.W + 10)) + map.W + 10) % (map.W + 10) - 5;
      ctx.beginPath(); ctx.moveTo(sx(x), sy(y)); ctx.lineTo(sx(x - dir * 2), sy(y)); ctx.stroke();
    }
  }

  // props
  const propPos = new Map();
  for (const s of map.shapes) {
    let x = s.x, y = s.y, a = s.a;
    if (s.k !== 0 && A) {
      const oa = A.O.get(s.id), ob = B.O.get(s.id) || oa;
      if (oa) { x = lerp(oa[1], ob[1], k) / 100; y = lerp(oa[2], ob[2], k) / 100; a = lerpA(oa[3] / 100, ob[3] / 100, k); }
    }
    propPos.set(s.id, [x, y, a]);
  }
  // ropes
  ctx.strokeStyle = '#5a4a3a'; ctx.lineWidth = Math.max(1.5, 0.06 * cam.s);
  for (const [ax, ay, id, lx, ly] of map.ropes) {
    const p = propPos.get(id);
    if (!p) continue;
    const c = Math.cos(p[2]), s = Math.sin(p[2]);
    ctx.beginPath(); ctx.moveTo(sx(ax), sy(ay)); ctx.lineTo(sx(p[0] + lx * c - ly * s), sy(p[1] + lx * s + ly * c)); ctx.stroke();
  }
  for (const s of map.shapes) { const p = propPos.get(s.id); if (s.hz !== 'lava') drawProp(s, p[0], p[1], p[2], time); }

  if (A) {
    // items
    for (const [id, ia] of B.I) {
      const ib = ia, iaa = A.I.get(id) || ib;
      const x = lerp(iaa[2], ib[2], k) / 100, y = lerp(iaa[3], ib[3], k) / 100, a = lerpA(iaa[4] / 100, ib[4] / 100, k);
      const state = ib[5];
      if (state === 2 && Math.sin(time * 20) > 0) continue;
      if (state) {
        ctx.fillStyle = '#fff5';
        ctx.beginPath(); ctx.arc(sx(x), sy(y), (0.65 + Math.sin(time * 5) * 0.08) * cam.s, 0, 7); ctx.fill();
      }
      ctx.save();
      ctx.translate(sx(x), sy(y)); ctx.rotate(-a); ctx.scale(cam.s, -cam.s);
      ctx.translate(-0.15, 0);
      if (!state) ctx.globalAlpha = 0.5;
      drawGun(WEAPONS[ib[1]]);
      ctx.restore();
    }
    // projectiles
    for (const [id, rb] of B.R) {
      const ra = A.R.get(id) || rb;
      const x = lerp(ra[2], rb[2], k) / 100, y = lerp(ra[3], rb[3], k) / 100, a = lerpA(ra[4] / 100, rb[4] / 100, k);
      ctx.save(); ctx.translate(sx(x), sy(y)); ctx.rotate(-a);
      if (rb[1] === 0) {
        ctx.fillStyle = '#556b2f'; ctx.fillRect(-0.25 * cam.s, -0.08 * cam.s, 0.4 * cam.s, 0.16 * cam.s);
        ctx.fillStyle = '#b33'; ctx.beginPath(); ctx.moveTo(0.15 * cam.s, -0.08 * cam.s); ctx.lineTo(0.3 * cam.s, 0); ctx.lineTo(0.15 * cam.s, 0.08 * cam.s); ctx.fill();
        particles.push({ x: x - Math.cos(a) * 0.3, y: y - Math.sin(a) * 0.3, vx: (Math.random() - 0.5), vy: (Math.random() - 0.5), life: 0.4, max: 0.4, color: Math.random() > 0.5 ? '#ffb21f' : '#777', size: 0.2, g: -0.2 });
      } else {
        ctx.fillStyle = '#3d5a2a'; ctx.beginPath(); ctx.arc(0, 0, 0.17 * cam.s, 0, 7); ctx.fill();
        if (Math.sin(time * (30 - rb[5])) > 0) { ctx.fillStyle = '#f33'; ctx.beginPath(); ctx.arc(0, 0.1 * cam.s, 0.05 * cam.s, 0, 7); ctx.fill(); }
      }
      ctx.restore();
    }

    // players (dead first)
    const list = [...B.P.values()].map(pb => {
      const pa = A.P.get(pb[0]);
      if (!pa) return pb;
      const out = pb.slice();
      out[3] = Math.round(lerpA(pa[3] / 100, pb[3] / 100, k) * 100);
      for (let i = 0; i < 10; i++) {
        const o = 8 + i * 3;
        out[o] = lerp(pa[o], pb[o], k); out[o + 1] = lerp(pa[o + 1], pb[o + 1], k);
        out[o + 2] = lerpA(pa[o + 2] / 100, pb[o + 2] / 100, k) * 100;
      }
      return out;
    }).sort((a, b) => a[1] - b[1] || (a[0] === myId) - (b[0] === myId));
    for (const p of list) {
      const hp = drawPlayer(p, time);
      headPos.set(p[0], hp);
      const r = roster.get(p[0]);
      if (r) lastPlayers.set(p[0], r);
    }
  }

  // lava drawn over players so they sink in
  for (const s of map.shapes) if (s.hz === 'lava') { const p = propPos.get(s.id); drawProp(s, p[0], p[1], p[2], time); }

  // tracers
  for (const t of tracers) {
    t.life -= dt;
    ctx.strokeStyle = `rgba(255,240,180,${Math.max(0, t.life / t.max)})`;
    ctx.lineWidth = t.w * cam.s;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx(t.x1), sy(t.y1)); ctx.lineTo(sx(t.x2), sy(t.y2)); ctx.stroke();
  }
  tracers = tracers.filter(t => t.life > 0);
  for (const f of flashes) {
    f.life -= dt;
    ctx.fillStyle = f.boom ? `rgba(255,230,150,${Math.max(0, f.life * 6)})` : '#fff6b0';
    ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), f.r * cam.s * (f.boom ? 1.4 - f.life * 3 : 1), 0, 7); ctx.fill();
  }
  flashes = flashes.filter(f => f.life > 0);

  // particles
  for (const p of particles) {
    p.life -= dt;
    p.vy -= 25 * p.g * dt;
    if (p.confetti) { p.vx *= 0.98; p.vy = Math.max(p.vy, -3); p.rot += dt * 5; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    const al = Math.max(0, Math.min(1, p.life / p.max * 1.5));
    ctx.globalAlpha = al;
    ctx.fillStyle = p.color;
    const s = p.size * cam.s;
    if (p.confetti) { ctx.save(); ctx.translate(sx(p.x), sy(p.y)); ctx.rotate(p.rot); ctx.fillRect(-s / 2, -s / 4, s, s / 2); ctx.restore(); }
    else ctx.fillRect(sx(p.x) - s / 2, sy(p.y) - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  particles = particles.filter(p => p.life > 0);
  if (particles.length > 1500) particles.splice(0, particles.length - 1500);

  // floating texts
  ctx.textAlign = 'center';
  for (const t of texts) {
    t.life -= dt;
    let x = t.x, y = t.y;
    if (t.follow) { const h = headPos.get(t.follow); if (!h) { t.life = 0; continue; } x = h.hx; y = h.hy + 1.3; }
    else t.y += dt * 1.2;
    ctx.globalAlpha = Math.min(1, t.life * 3);
    ctx.font = `900 ${Math.max(12, 0.55 * cam.s)}px "Trebuchet MS", sans-serif`;
    ctx.fillStyle = '#000a'; ctx.fillText(t.text, sx(x) + 2, sy(y) + 2);
    ctx.fillStyle = t.color; ctx.fillText(t.text, sx(x), sy(y));
  }
  ctx.globalAlpha = 1;
  texts = texts.filter(t => t.life > 0);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // banner
  if (banner) {
    banner.t += dt;
    const p = banner.t / banner.life;
    if (p >= 1) banner = null;
    else {
      const pop = Math.min(1, banner.t * 6);
      const scale = 0.6 + 0.4 * (1 - Math.pow(1 - pop, 3)) + (banner.kind === 'win' ? Math.sin(banner.t * 8) * 0.03 : 0);
      ctx.save();
      ctx.globalAlpha = p > 0.8 ? (1 - p) * 5 : 1;
      ctx.translate(W / 2, H * 0.4);
      ctx.scale(scale, scale);
      ctx.rotate(-0.04);
      ctx.textAlign = 'center';
      const fs = Math.min(W / 9, 110);
      ctx.font = `900 ${fs}px "Trebuchet MS", sans-serif`;
      ctx.lineWidth = fs / 7; ctx.strokeStyle = '#111'; ctx.lineJoin = 'round';
      ctx.strokeText(banner.text, 0, 0);
      ctx.fillStyle = banner.color || '#fff';
      ctx.fillText(banner.text, 0, 0);
      if (banner.sub) { ctx.font = `700 ${fs / 3.5}px "Trebuchet MS", sans-serif`; ctx.lineWidth = fs / 20; ctx.strokeText(banner.sub, 0, fs * 0.6); ctx.fillStyle = '#fff'; ctx.fillText(banner.sub, 0, fs * 0.6); }
      ctx.restore();
    }
  }
  if (B && B.fz && (!banner || banner.kind !== 'win')) {
    ctx.textAlign = 'center';
    ctx.font = `900 ${Math.min(W / 16, 60)}px "Trebuchet MS", sans-serif`;
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#111'; ctx.lineWidth = 8;
    ctx.strokeText('BEREIT…', W / 2, H * 0.58); ctx.fillText('BEREIT…', W / 2, H * 0.58);
  }

  // crosshair
  if (myId) {
    ctx.strokeStyle = '#111'; ctx.lineWidth = 4;
    const cross = () => { ctx.beginPath(); ctx.arc(mouseX, mouseY, 9, 0, 7); ctx.moveTo(mouseX - 15, mouseY); ctx.lineTo(mouseX - 5, mouseY); ctx.moveTo(mouseX + 5, mouseY); ctx.lineTo(mouseX + 15, mouseY); ctx.moveTo(mouseX, mouseY - 15); ctx.lineTo(mouseX, mouseY - 5); ctx.moveTo(mouseX, mouseY + 5); ctx.lineTo(mouseX, mouseY + 15); ctx.stroke(); };
    cross(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; cross();
  }
}

// little ragdoll parade behind the menu
function drawMenuBg(time) {
  ctx.strokeStyle = '#ffffff10'; ctx.lineWidth = 14; ctx.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    const x = ((i * 260 + time * 60) % (W + 300)) - 150, y = H * 0.85 + Math.sin(time * 3 + i) * 10;
    const sw = Math.sin(time * 8 + i) * 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y - 60); ctx.lineTo(x, y);
    ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(sw) * 40, y + 45);
    ctx.moveTo(x, y); ctx.lineTo(x - Math.sin(sw) * 40, y + 45);
    ctx.moveTo(x, y - 50); ctx.lineTo(x + 35, y - 30 - sw * 20);
    ctx.moveTo(x, y - 50); ctx.lineTo(x - 35, y - 30 + sw * 20);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y - 80, 16, 0, 7); ctx.stroke();
  }
}

requestAnimationFrame(frame);

// ---------------------------------------------------------------- audio (all synthesized)
let AC = null, master = null, noiseBuf = null;
function audio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain(); master.gain.value = 0.45; master.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { AC = null; }
}
function noise(dur, freq, q, vol, type = 'lowpass', sweep) {
  const t = AC.currentTime;
  const src = AC.createBufferSource(); src.buffer = noiseBuf;
  const f = AC.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
  const g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t, Math.random() * 0.5); src.stop(t + dur);
}
function tone(f0, f1, dur, vol, type = 'square') {
  const t = AC.currentTime;
  const o = AC.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur);
}
const sfxLast = {};
function sfx(name) {
  if (!AC || muted) return;
  const now = performance.now();
  if (now - (sfxLast[name] || 0) < 35) return;
  sfxLast[name] = now;
  const R = () => 0.9 + Math.random() * 0.2;
  switch (name) {
    case 'pistol': noise(0.12, 3000 * R(), 1, 0.5); tone(300, 60, 0.08, 0.2); break;
    case 'ar': noise(0.09, 2500 * R(), 1, 0.4); tone(220, 50, 0.06, 0.15); break;
    case 'minigun': noise(0.06, 3500 * R(), 1, 0.25); break;
    case 'shotgun': noise(0.35, 1800, 0.7, 0.9, 'lowpass', 200); tone(120, 40, 0.2, 0.4); break;
    case 'sniper': noise(0.5, 5000, 0.5, 0.8, 'lowpass', 300); tone(500, 40, 0.3, 0.3, 'sawtooth'); break;
    case 'rocket': noise(0.6, 800, 1, 0.5, 'bandpass', 2500); break;
    case 'boom': noise(1.0, 900, 0.8, 1.2, 'lowpass', 40); tone(90, 25, 0.6, 0.7, 'sine'); break;
    case 'toss': noise(0.15, 1200, 2, 0.2, 'bandpass', 400); break;
    case 'whoosh': noise(0.12, 600, 3, 0.25, 'bandpass', 2000); break;
    case 'punchhit': noise(0.1, 500, 1, 0.8); tone(160 * R(), 50, 0.12, 0.5, 'sine'); break;
    case 'hit': noise(0.07, 1200 * R(), 2, 0.4, 'bandpass'); tone(200 * R(), 90, 0.06, 0.2, 'triangle'); break;
    case 'head': tone(900, 300, 0.15, 0.25, 'square'); noise(0.1, 2000, 2, 0.5, 'bandpass'); break;
    case 'jump': tone(260 * R(), 520, 0.1, 0.06, 'triangle'); break;
    case 'boing': tone(150, 700, 0.25, 0.3, 'sine'); tone(300, 90, 0.3, 0.12, 'triangle'); break;
    case 'bonk': tone(700, 180, 0.18, 0.35, 'square'); break;
    case 'pick': tone(500, 1000, 0.08, 0.15, 'square'); setTimeout(() => AC && tone(800, 1300, 0.08, 0.12, 'square'), 70); break;
    case 'drop': tone(1200, 600, 0.2, 0.06, 'sine'); break;
    case 'die': tone(400 * R(), 60, 0.5, 0.3, 'sawtooth'); noise(0.3, 800, 1, 0.5); break;
    case 'fall': tone(900, 100, 0.9, 0.2, 'sine'); break;
    case 'sizzle': noise(0.8, 4000, 0.5, 0.6, 'highpass', 1500); break;
    case 'crack': noise(0.4, 400, 1, 0.9); tone(120, 50, 0.3, 0.4, 'square'); break;
    case 'start': [392, 523, 659].forEach((f, i) => setTimeout(() => AC && tone(f, f, 0.14, 0.12, 'square'), i * 110)); break;
    case 'win': [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => AC && tone(f, f * 1.01, 0.22, 0.15, 'square'), i * 130)); break;
  }
}
})();

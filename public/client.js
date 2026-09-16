(() => {
'use strict';
const WEAPONS = ['pistol', 'ar', 'shotgun', 'sniper', 'rpg', 'minigun', 'grenade'];
// half lengths per body: hip, chest, head, ua0, la0, ua1, la1, ul0, ll0, ul1, ll1
const HH = [0.17, 0.2, 0, 0.17, 0.16, 0.17, 0.16, 0.23, 0.23, 0.23, 0.23];
const HEAD_R = 0.27, LW = 0.2;
let INTERP = 0.1, snapGap = 1 / 30, lastSnapAt = 0;
const KICK = { pistol: 2.2, ar: 1.1, shotgun: 6, sniper: 9, rpg: 6, minigun: 0.7, grenade: 0.5 };

const $ = (id) => document.getElementById(id);
const cv = $('c');
let ctx = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;

// ---------------------------------------------------------------- state
let ws = null, myId = 0, roomCode = '';
const roster = new Map();
const colorCache = new Map();
let map = null, mapT = 0;
let snaps = [];
let clockOffset = null;
let pendingEvents = [];
let particles = [], rings = [], flashes = [], bullets = new Map();
let banner = null, fade = 0;
const hitFlash = new Map();
let muted = false;

// ---------------------------------------------------------------- menu
const nameIn = $('name'), codeIn = $('code');
try { nameIn.value = localStorage.getItem('faight-name') || ''; } catch {}
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) codeIn.value = urlCode;
codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.replace(/\D/g, '').slice(0, 4); });

function go(kind) {
  const name = nameIn.value.trim() || 'Stick' + Math.floor(Math.random() * 99);
  try { localStorage.setItem('faight-name', name); } catch {}
  if (kind === 'join' && codeIn.value.length !== 4) { $('err').textContent = 'Code hat 4 Ziffern'; return; }
  audio();
  connect(() => ws.send(JSON.stringify(kind === 'create' ? { t: 'create', name } : { t: 'join', name, code: codeIn.value })));
}
$('create').onclick = () => go('create');
$('join').onclick = () => go('join');
codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go('join'); });
nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') codeIn.value.length === 4 ? go('join') : go('create'); });
$('copy').onclick = () => {
  navigator.clipboard && navigator.clipboard.writeText(location.origin + location.pathname + '?code=' + roomCode);
  $('copy').textContent = 'Kopiert'; setTimeout(() => $('copy').textContent = 'Link', 1200);
};
$('mute').onclick = () => { muted = !muted; $('mute').textContent = muted ? 'Ton aus' : 'Ton an'; };

function connect(onOpen, attempt = 0) {
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); }
  $('err').textContent = attempt ? `Server startet… (${attempt * 3}s)` : '';
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

function onMessage(m) {
  switch (m.t) {
    case 'err': $('err').textContent = m.m; break;
    case 'joined':
      myId = m.id; roomCode = m.code;
      $('roomcode').textContent = m.code;
      $('menu').hidden = true; $('hud').hidden = false;
      history.replaceState(null, '', '?code=' + m.code + location.hash);
      break;
    case 'roster':
      roster.clear();
      for (const [id, name, color, score] of m.list) { roster.set(id, { name, color, score }); colorCache.set(id, color); }
      renderScores();
      break;
    case 'map':
      map = m;
      map.deco = makeDeco(m);
      mapSerial++;
      mapT = 0;
      snaps = []; clockOffset = null; pendingEvents = []; particles = []; rings = []; flashes = []; bullets.clear();
      fade = 1;
      banner = null;
      break;
    case 's': onSnap(m); break;
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

// ---------------------------------------------------------------- snapshots
function onSnap(s) {
  const now = performance.now() / 1000;
  if (lastSnapAt) snapGap += (Math.min(0.2, now - lastSnapAt) - snapGap) * 0.1;
  lastSnapAt = now;
  INTERP = Math.max(0.04, Math.min(0.14, snapGap * 2.2));
  const t = s.tm / 1000;
  if (clockOffset === null || !snaps.length) clockOffset = t - now;
  else clockOffset += ((t - now) - clockOffset) * 0.05;
  if (t - now > clockOffset + 0.06) clockOffset = t - now;
  const snap = { t, P: new Map(), O: new Map(), I: new Map(), R: new Map(), wd: s.wd };
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
let mouseX = innerWidth / 2, mouseY = innerHeight / 2;
const KEYMAP = { KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r', KeyS: 'd', ArrowDown: 'd', Space: 'j', KeyW: 'j', ArrowUp: 'j', KeyQ: 'th', KeyF: 'th' };
addEventListener('keydown', (e) => {
  if (!myId || e.target.tagName === 'INPUT') return;
  const k = KEYMAP[e.code];
  if (k) { e.preventDefault(); if (!keys[k]) { keys[k] = 1; sendInput(); } }
});
addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k && keys[k]) { keys[k] = 0; sendInput(); } });
addEventListener('blur', () => { for (const k in keys) keys[k] = 0; sendInput(); });
addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
cv.addEventListener('mousedown', (e) => {
  audio();
  if (e.button === 0) keys.s = 1; else if (e.button === 2) keys.th = 1;
  sendInput();
});
addEventListener('mouseup', (e) => { if (e.button === 0) keys.s = 0; else if (e.button === 2) keys.th = 0; sendInput(); });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

let lastSent = '';
function sendInput() {
  if (!ws || ws.readyState !== 1 || !myId || !map) return;
  const w = screenToWorld(mouseX, mouseY);
  const str = JSON.stringify({ t: 'i', l: keys.l, r: keys.r, d: keys.d, j: keys.j, s: keys.s, th: keys.th, ax: Math.round(w.x * 100) / 100, ay: Math.round(w.y * 100) / 100 });
  if (str === lastSent) return;
  lastSent = str;
  ws.send(str);
}
setInterval(sendInput, 33);

// ---------------------------------------------------------------- camera: always the whole map, springy shake
const cam = { cx: 0, cy: 0, s: 20, ox: 0, oy: 0, vx: 0, vy: 0, rot: 0, vr: 0 };
function kick(dx, dy, mag) { cam.vx += dx * mag; cam.vy += dy * mag; }
function kickRot(mag) { cam.vr += (Math.random() - 0.5) * mag; }

function updateCam(dt) {
  cam.s = Math.min(W / (map.W + 2), H / (map.H + 2.5));
  cam.cx = map.W / 2;
  cam.cy = map.H / 2 + 0.25;
  cam.vx += (-260 * cam.ox - 13 * cam.vx) * dt; cam.vy += (-260 * cam.oy - 13 * cam.vy) * dt;
  cam.ox += cam.vx * dt; cam.oy += cam.vy * dt;
  cam.vr += (-300 * cam.rot - 14 * cam.vr) * dt; cam.rot += cam.vr * dt;
}
const sx = (x) => W / 2 + (x - cam.cx) * cam.s;
const sy = (y) => H / 2 - (y - cam.cy) * cam.s;
function screenToWorld(x, y) { return { x: cam.cx + (x - W / 2) / cam.s, y: cam.cy - (y - H / 2) / cam.s }; }

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- colors
function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function mix(a, b, t) {
  const A = hexRgb(a), B = hexRgb(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`;
}
function shade(hex, amt) {
  const [r, g, b] = hexRgb(hex);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
const colorOf = (id) => colorCache.get(id) || '#dddddd';

// ---------------------------------------------------------------- effects
function spawnParticles(x, y, n, o) {
  for (let i = 0; i < n; i++) {
    const a = o.dir != null ? o.dir + (Math.random() - 0.5) * (o.spread || 1) : Math.random() * Math.PI * 2;
    const v = (o.speed || 5) * (0.3 + Math.random() * 0.9);
    particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: (o.life || 0.5) * (0.5 + Math.random() * 0.7), max: o.life || 0.5,
      color: o.color, size: (o.size || 0.1) * (0.5 + Math.random()), g: o.g != null ? o.g : 1, drag: o.drag || 0, kind: o.kind || 'sq', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 20,
    });
  }
}

function processEvents(rt) {
  while (pendingEvents.length && pendingEvents[0].t <= rt + 0.017) handleEvent(pendingEvents.shift().e, rt - pendingEvents.length * 0);
  if (pendingEvents.length > 600) pendingEvents.splice(0, pendingEvents.length - 600);
}

let lastPlayers = new Map();
function handleEvent(e) {
  switch (e[0]) {
    case 'fire': {
      const [, id, w, x, y, a100] = e;
      const a = a100 / 100, type = WEAPONS[w];
      const big = type === 'shotgun' || type === 'sniper' || type === 'rpg';
      flashes.push({ x, y, a, life: 0.06, max: 0.06, size: big ? 1 : 0.6 });
      spawnParticles(x, y, big ? 8 : 3, { dir: a, spread: 0.5, speed: big ? 10 : 6, life: 0.12, size: 0.07, color: '#fff3c0', g: 0 });
      if (type !== 'rpg' && type !== 'grenade') {
        spawnParticles(x - Math.cos(a) * 0.5, y - Math.sin(a) * 0.5, 1, { dir: a + Math.PI / 2 * (Math.cos(a) > 0 ? 1 : -1) + Math.PI, spread: 0.6, speed: 4, life: 1.2, size: 0.08, color: '#b8913a', g: 1.2, kind: 'shell' });
      }
      kick(-Math.cos(a), Math.sin(a), KICK[type] * 0.02 * (id === myId ? 1.4 : 0.6));
      if (big) kickRot(type === 'sniper' ? 0.08 : 0.04);
      sfx(type);
      break;
    }
    case 'b': {
      const [, id, x, y, vx, vy, w, life] = e;
      bullets.set(id, { x, y, vx, vy, life, w: WEAPONS[w], trail: [] });
      break;
    }
    case 'bh': {
      const [, id, x, y, victim] = e;
      const b = bullets.get(id);
      bullets.delete(id);
      const dir = b ? Math.atan2(b.vy, b.vx) : 0;
      if (victim > 0) {
        hitFlash.set(victim, 0.08);
        spawnParticles(x, y, 10, { dir, spread: 1.2, speed: 7, life: 0.5, size: 0.1, color: colorOf(victim), g: 1 });
        spawnParticles(x, y, 4, { dir, spread: 0.6, speed: 10, life: 0.15, size: 0.06, color: '#ffffff', g: 0 });
        sfx('hit');
      } else {
        spawnParticles(x, y, 5, { dir: dir + Math.PI, spread: 1.6, speed: 6, life: 0.2, size: 0.06, color: '#ffe9a8', g: 0.5 });
        spawnParticles(x, y, 3, { dir: dir + Math.PI, spread: 1.2, speed: 1.5, life: 0.6, size: 0.25, color: 'rgba(90,90,90,0.25)', g: -0.05, drag: 2, kind: 'puff' });
        sfx('ric');
      }
      break;
    }
    case 'punch': sfx('whoosh'); break;
    case 'ph': {
      const [, x, y, id, a100] = e;
      const a = a100 / 100;
      hitFlash.set(id, 0.1);
      rings.push({ x, y, r: 0.2, grow: 7, life: 0.18, max: 0.18, w: 0.12 });
      spawnParticles(x, y, 6, { dir: a, spread: 1, speed: 8, life: 0.2, size: 0.07, color: '#ffffff', g: 0 });
      kick(Math.cos(a), -Math.sin(a), 0.1);
      sfx('punchhit');
      break;
    }
    case 'boom': {
      const [, x, y, R] = e;
      flashes.push({ x, y, a: 0, life: 0.1, max: 0.1, size: R * 1.4, boom: true });
      rings.push({ x, y, r: 0.5, grow: R * 5, life: 0.3, max: 0.3, w: 0.35 });
      spawnParticles(x, y, 26, { speed: 12, life: 0.45, size: 0.45, color: '#ffb347', g: -0.1, drag: 4, kind: 'puff' });
      spawnParticles(x, y, 20, { speed: 6, life: 1.6, size: 0.9, color: 'rgba(110,110,110,0.32)', g: -0.25, drag: 2.5, kind: 'puff' });
      spawnParticles(x, y, 16, { speed: 20, life: 0.6, size: 0.1, color: '#ffe38a', g: 1 });
      const a = Math.random() * Math.PI * 2;
      kick(Math.cos(a), Math.sin(a), 0.9);
      kickRot(0.25);
      sfx('boom');
      break;
    }
    case 'jump': spawnParticles(e[1], e[2], 4, { dir: Math.PI / 2, spread: 2.5, speed: 1.5, life: 0.35, size: 0.18, color: 'rgba(40,40,40,0.25)', g: 0, drag: 3, kind: 'puff' }); break;
    case 'bounce': spawnParticles(e[1], e[2], 6, { dir: Math.PI / 2, spread: 2, speed: 5, life: 0.3, size: 0.1, color: '#ffffff', g: 0.5 }); sfx('thud'); break;
    case 'thud': hitFlash.set(e[3], 0.08); spawnParticles(e[1], e[2], 6, { speed: 4, life: 0.4, size: 0.1, color: colorOf(e[3]) }); sfx('thud'); break;
    case 'pick': sfx('pick'); break;
    case 'die': {
      const [, id, x, y] = e;
      spawnParticles(x, y, 18, { speed: 8, life: 0.8, size: 0.13, color: colorOf(id) });
      kick((Math.random() - 0.5), (Math.random() - 0.5), 0.35);
      sfx('die');
      break;
    }
    case 'hz':
      spawnParticles(e[2], e[3], 24, e[1] === 'lava'
        ? { dir: Math.PI / 2, spread: 1.5, speed: 7, life: 1.2, size: 0.5, color: 'rgba(60,60,60,0.5)', g: -0.3, drag: 2, kind: 'puff' }
        : { speed: 9, life: 0.4, size: 0.08, color: '#ffe38a', g: 0.8 });
      sfx(e[1] === 'lava' ? 'sizzle' : 'saw');
      break;
    case 'crack': spawnParticles(e[1], e[2], 18, { speed: 6, life: 1, size: 0.18, color: '#4a3a2c', g: 1.2 }); kick(0, 1, 0.25); sfx('crack'); break;
    case 'add': if (map) { map.shapes.push(e[1]); if (e[1].k === 0) levelVersion++; } break;
    case 'rm': if (map) { if (map.shapes.some(s => s.id === e[1] && s.k === 0)) levelVersion++; map.shapes = map.shapes.filter(s => s.id !== e[1]); } break;
    case 'win': {
      const r = roster.get(e[1]);
      banner = { name: r ? r.name : '', color: r ? r.color : '#dddddd', draw: !r, t: 0 };
      sfx('win');
      break;
    }
  }
}

// ---------------------------------------------------------------- background
function hash(str) { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function rng(seed) { return () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) + 1 >>> 0) / 4294967296); }
function makeDeco(m) {
  const r = rng(hash(m.name));
  const layers = [];
  for (const [depth, count] of [[0.25, 16], [0.5, 12]]) {
    const shapes = [];
    for (let i = 0; i < count; i++) {
      const w = 3 + r() * 9, h = 4 + r() * m.H * (depth < 0.4 ? 0.9 : 0.6);
      shapes.push({ x: -20 + r() * (m.W + 40), w, h, cap: r() < 0.3 });
    }
    layers.push({ depth, shapes });
  }
  const stars = [];
  if (m.dark) for (let i = 0; i < 120; i++) stars.push({ x: r(), y: r(), s: r() * 1.5 + 0.5, p: r() * 6 });
  return { layers, stars };
}

// ---------------------------------------------------------------- static layers
// The camera never moves, so sky, skyline, level geometry and vignette are rendered once into
// offscreen canvases and blitted each frame (re-rendered on resize, new map or level changes).
let mapSerial = 0, levelVersion = 0;
const layers = { key: '', sky: null, city: null, level: null, levelKey: '', vignette: null };

function makeLayer(draw, pad = 100) {
  const c = document.createElement('canvas');
  c.width = Math.ceil((W + pad * 2) * dpr); c.height = Math.ceil((H + pad * 2) * dpr);
  const prev = ctx;
  ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);
  try { draw(); } finally { ctx = prev; }
  return c;
}
const blitLayer = (c, pad = 100) => ctx.drawImage(c, -pad, -pad, W + pad * 2, H + pad * 2);

function ensureLayers() {
  const key = `${mapSerial}|${W}|${H}|${dpr}`;
  if (layers.key !== key) {
    layers.key = key;
    // without twinkling stars sky and skyline can share one layer
    layers.sky = map.deco.stars.length ? makeLayer(drawSky) : makeLayer(() => { drawSky(); drawSkyline(); });
    layers.city = map.deco.stars.length ? makeLayer(drawSkyline) : null;
    layers.vignette = makeLayer(drawVignette, 0);
    layers.levelKey = '';
  }
  if (layers.levelKey !== key + '|' + levelVersion) {
    layers.levelKey = key + '|' + levelVersion;
    const statics = map.shapes.filter(sh => sh.k === 0).map(sh => ({ s: sh, x: sh.x, y: sh.y, a: sh.a }));
    layers.level = makeLayer(() => { drawBlockSides(statics); drawBlockFronts(statics, 0); });
  }
}

function drawSky() {
  const [top, bottom] = map.sky;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, top); g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(-100, -100, W + 200, H + 200);
}

function drawVignette() {
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
}

function drawBackground(time) {
  ensureLayers();
  blitLayer(layers.sky);
  if (map.deco.stars.length) {
    ctx.fillStyle = '#fff';
    for (const s of map.deco.stars) {
      ctx.globalAlpha = 0.4 + 0.4 * Math.sin(time + s.p);
      ctx.fillRect(s.x * W, s.y * H * 0.8, s.s, s.s);
    }
    ctx.globalAlpha = 1;
  }
  if (layers.city) blitLayer(layers.city);
}

function drawSkyline() {
  const bottom = map.sky[1];
  const far = map.dark ? '#000000' : '#1b1b1b';
  for (const layer of map.deco.layers) {
    const f = layer.depth;
    ctx.fillStyle = mix(bottom, far, map.dark ? 0.35 + f * 0.3 : 0.12 + f * 0.22);
    const scale = cam.s * (0.55 + f * 0.35);
    const ground = H / 2 - (0 - cam.cy) * cam.s * (0.3 + f * 0.5) + (1 - f) * H * 0.12;
    for (const s of layer.shapes) {
      const x = W / 2 + (s.x - map.W / 2 - (cam.cx - map.W / 2) * f) * scale;
      const w = s.w * scale, h = s.h * scale;
      ctx.fillRect(x - w / 2, ground - h, w, h + H);
      if (s.cap) ctx.fillRect(x - w * 0.15, ground - h - w * 0.5, w * 0.3, w * 0.5);
    }
  }
}

// ---------------------------------------------------------------- level geometry (fake 3D depth)
function rectCorners(s, x, y, a) {
  const c = Math.cos(a), sn = Math.sin(a), hw = s.w / 2, hh = s.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([px, py]) => [sx(x + px * c - py * sn), sy(y + px * sn + py * c)]);
}

const shadeCache = new Map();
function shadeC(base, amt) {
  const k = base + amt;
  let v = shadeCache.get(k);
  if (!v) { v = shade(base, amt); shadeCache.set(k, v); }
  return v;
}

function drawBlockSides(list) {
  const vx = W / 2, vy = H * 0.45, depth = 0.045;
  for (const { s, x, y, a } of list) {
    if (s.s !== 'b' || s.hz === 'lava') continue;
    const front = rectCorners(s, x, y, a);
    const back = front.map(([px, py]) => [px + (vx - px) * depth, py + (vy - py) * depth]);
    const base = s.c || (s.cr ? '#3a3029' : '#26272a');
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      ctx.fillStyle = shadeC(base, i === 2 ? 38 : i === 0 ? -8 : 18);
      ctx.beginPath();
      ctx.moveTo(front[i][0], front[i][1]); ctx.lineTo(front[j][0], front[j][1]);
      ctx.lineTo(back[j][0], back[j][1]); ctx.lineTo(back[i][0], back[i][1]);
      ctx.fill();
    }
  }
}

function drawBlockFronts(list, time) {
  for (const { s, x, y, a } of list) {
    if (s.hz === 'lava') continue;
    if (s.s === 'c') { drawCircleProp(s, x, y, a, time); continue; }
    const front = rectCorners(s, x, y, a);
    const base = s.c || (s.cr ? '#3a3029' : '#26272a');
    ctx.fillStyle = base;
    ctx.beginPath();
    front.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
    ctx.fill();
    if (s.cr) {
      ctx.strokeStyle = shadeC(base, 22);
      ctx.lineWidth = Math.max(1, 0.07 * cam.s);
      ctx.beginPath();
      const inset = front.map(([px, py]) => { const cxs = sx(x), cys = sy(y); return [cxs + (px - cxs) * 0.8, cys + (py - cys) * 0.8]; });
      inset.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
      ctx.closePath();
      ctx.moveTo(inset[0][0], inset[0][1]); ctx.lineTo(inset[2][0], inset[2][1]);
      ctx.stroke();
    }
    if (s.ice) {
      ctx.strokeStyle = 'rgba(210,240,255,0.55)';
      ctx.lineWidth = Math.max(1, 0.06 * cam.s);
      ctx.beginPath(); ctx.moveTo(front[3][0], front[3][1]); ctx.lineTo(front[2][0], front[2][1]); ctx.stroke();
    }
    if (s.hz === 'spike') {
      const n = Math.max(2, Math.round(s.w / 0.45));
      ctx.fillStyle = '#1c1c1c';
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x0 = x - s.w / 2 + (i / n) * s.w, x1 = x0 + s.w / n;
        ctx.moveTo(sx(x0), sy(y + s.h / 2)); ctx.lineTo(sx((x0 + x1) / 2), sy(y + s.h / 2 + 0.5)); ctx.lineTo(sx(x1), sy(y + s.h / 2));
      }
      ctx.fill();
    }
  }
}

function drawCircleProp(s, x, y, a, time) {
  const r = s.r * cam.s;
  ctx.save();
  ctx.translate(sx(x), sy(y));
  if (s.hz === 'saw') {
    ctx.rotate(time * 14);
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath();
    const teeth = 16;
    for (let i = 0; i <= teeth * 2; i++) {
      const ang = (i / (teeth * 2)) * Math.PI * 2, rr = i % 2 ? r * 0.8 : r;
      ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.6, 0, 7); ctx.stroke();
    ctx.fillStyle = '#555'; ctx.beginPath(); ctx.arc(0, 0, r * 0.15, 0, 7); ctx.fill();
  } else {
    ctx.rotate(-a);
    ctx.fillStyle = s.c || '#2a2a2a';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.arc(r * 0.3, r * 0.2, r * 0.22, 0, 7); ctx.arc(-r * 0.35, -r * 0.3, r * 0.14, 0, 7); ctx.fill();
  }
  ctx.restore();
}

function drawLava(s, x, y, time) {
  const top = sy(y + s.h / 2);
  const g = ctx.createLinearGradient(0, top - 40, 0, top + 200);
  g.addColorStop(0, 'rgba(255,120,30,0)'); g.addColorStop(0.2, 'rgba(255,120,30,0.35)'); g.addColorStop(0.21, '#ff7a1c'); g.addColorStop(1, '#b3290e');
  ctx.fillStyle = g;
  ctx.fillRect(sx(x - s.w / 2), top - 40, s.w * cam.s, H - top + 80);
  ctx.fillStyle = '#ffc043';
  ctx.beginPath();
  const x0 = Math.max(sx(x - s.w / 2), -10), x1 = Math.min(sx(x + s.w / 2), W + 10);
  ctx.moveTo(x0, top + 8);
  for (let px = x0; px <= x1; px += 12) ctx.lineTo(px, top + Math.sin(px * 0.03 + time * 3) * 3 + Math.sin(px * 0.011 - time * 2) * 3);
  ctx.lineTo(x1, top + 8);
  ctx.fill();
}

// ---------------------------------------------------------------- weapons & characters
function drawGun(type, S) {
  const g = (x, y, w, h) => ctx.fillRect(x * S, -(y + h) * S, w * S, h * S);
  ctx.fillStyle = '#121212';
  switch (type) {
    case 'pistol': g(-0.05, -0.02, 0.42, 0.13); g(-0.03, -0.18, 0.1, 0.18); break;
    case 'ar': g(-0.3, -0.05, 1.05, 0.13); g(0.1, -0.26, 0.09, 0.22); g(-0.45, -0.1, 0.18, 0.16); g(0.05, 0.08, 0.2, 0.05); break;
    case 'shotgun': g(-0.35, -0.04, 1.2, 0.12); g(0.25, -0.1, 0.35, 0.08); g(-0.5, -0.12, 0.2, 0.17); break;
    case 'sniper': g(-0.4, -0.04, 1.6, 0.09); g(-0.05, 0.05, 0.38, 0.1); g(-0.55, -0.12, 0.2, 0.17); g(0.1, -0.18, 0.08, 0.14); break;
    case 'rpg': g(-0.5, -0.1, 1.25, 0.2); ctx.beginPath(); ctx.moveTo(0.75 * S, 0.14 * S); ctx.lineTo(1.05 * S, 0); ctx.lineTo(0.75 * S, -0.14 * S); ctx.fill(); g(-0.02, -0.28, 0.1, 0.18); break;
    case 'minigun': g(-0.35, -0.14, 0.45, 0.3); g(0.1, -0.1, 0.95, 0.06); g(0.1, 0.02, 0.95, 0.06); g(0.02, -0.3, 0.1, 0.16); break;
    case 'grenade': ctx.beginPath(); ctx.arc(0.08 * S, 0, 0.15 * S, 0, 7); ctx.fill(); g(0.02, 0.12, 0.12, 0.07); break;
  }
}

const gunSprites = new Map();
function gunSprite(type) {
  const key = `${type}|${cam.s.toFixed(2)}|${dpr}`;
  let spr = gunSprites.get(key);
  if (spr) return spr;
  const S = cam.s, ox = 0.6 * S + 14, oy = 0.4 * S + 14, w = 1.8 * S + 28, h = 0.8 * S + 28;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr); c.height = Math.ceil(h * dpr);
  const prev = ctx;
  ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);
  ctx.shadowColor = 'rgba(255,255,255,0.9)'; ctx.shadowBlur = 10 * dpr;
  try { drawGun(type, S); } finally { ctx = prev; }
  spr = { c, ox, oy, w, h };
  if (gunSprites.size > 60) gunSprites.clear();
  gunSprites.set(key, spr);
  return spr;
}

function seg(x, y, a, hh) { const s = Math.sin(a), c = Math.cos(a); return [x - s * hh, y + c * hh, x + s * hh, y - c * hh]; }

function drawPlayer(p, time, dt) {
  const id = p[0], alive = p[1];
  const parts = [];
  for (let i = 0; i < 11; i++) parts.push([p[6 + i * 3] / 100, p[7 + i * 3] / 100, p[8 + i * 3] / 100]);
  let color = colorOf(id);
  let flash = hitFlash.get(id) || 0;
  if (flash > 0) { hitFlash.set(id, flash - dt); color = '#ffffff'; }
  const back = flash > 0 ? '#e6e6e6' : shade(color, -32);
  const S = cam.s;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = LW * S;

  const chain = (iu, il, col) => {
    const [ux, uy, ua] = parts[iu], [lx, ly, la] = parts[il];
    const u = seg(ux, uy, ua, HH[iu]), l = seg(lx, ly, la, HH[il]);
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(sx(u[0]), sy(u[1]));
    ctx.lineTo(sx((u[2] + l[0]) / 2), sy((u[3] + l[1]) / 2));
    ctx.lineTo(sx(l[2]), sy(l[3]));
    ctx.stroke();
  };
  chain(5, 6, back);
  chain(9, 10, back);
  // spine
  const hip = seg(...parts[0], HH[0]), ch = seg(...parts[1], HH[1]);
  ctx.strokeStyle = color;
  ctx.lineWidth = LW * 1.15 * S;
  ctx.beginPath();
  ctx.moveTo(sx(hip[2]), sy(hip[3]));
  ctx.lineTo(sx((hip[0] + ch[2]) / 2), sy((hip[1] + ch[3]) / 2));
  ctx.lineTo(sx(ch[0]), sy(ch[1]));
  ctx.stroke();
  ctx.lineWidth = LW * S;
  chain(7, 8, color);
  // head
  const [hx, hy] = parts[2];
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(sx(hx), sy(hy), HEAD_R * S, 0, 7); ctx.fill();
  // weapon + front arm
  const wIdx = p[3];
  if (wIdx >= 0 && alive) {
    let aim = p[2] / 100;
    if (id === myId) {
      const m = screenToWorld(mouseX, mouseY);
      aim = Math.atan2(m.y - (parts[1][1] + 0.15), m.x - parts[1][0]);
    }
    const [lx, ly, la] = parts[4];
    const hand = seg(lx, ly, la, HH[4]);
    ctx.save();
    ctx.translate(sx(hand[2]), sy(hand[3]));
    ctx.rotate(-aim);
    if (Math.cos(aim) < 0) ctx.scale(1, -1);
    drawGun(WEAPONS[wIdx], S);
    ctx.restore();
  }
  chain(3, 4, color);
  return { hx, hy };
}

// ---------------------------------------------------------------- main render
let lastFrame = performance.now();
const headPos = new Map();

const PERF = location.hash === '#perf';
let perfMs = 0, perfN = 0, perfEl = null;
function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now();
  if (PERF) {
    render(nowMs);
    perfMs += performance.now() - nowMs;
    if (++perfN === 60) {
      if (!perfEl) { perfEl = document.createElement('div'); perfEl.style.cssText = 'position:fixed;bottom:8px;right:12px;font:12px monospace;color:#fff;background:#000a;padding:2px 6px;z-index:9'; perfEl.id = 'perf'; document.body.appendChild(perfEl); }
      perfEl.textContent = (perfMs / 60).toFixed(2) + ' ms/frame';
      perfMs = 0; perfN = 0;
    }
  } else render(nowMs);
}

function render(nowMs) {
  const dt = Math.min(0.05, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  const time = nowMs / 1000;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!map) { drawMenuBg(time); return; }
  mapT += dt;
  const smp = sample();
  if (smp) processEvents(smp.rt);
  const A = smp && smp.a, B = smp && smp.b, k = smp ? smp.k : 0;

  // interpolate players
  const players = [];
  if (A) for (const pb of B.P.values()) {
    const pa = A.P.get(pb[0]);
    if (!pa) { players.push(pb); continue; }
    const out = pb.slice();
    out[2] = lerpA(pa[2] / 100, pb[2] / 100, k) * 100;
    for (let i = 0; i < 11; i++) {
      const o = 6 + i * 3;
      out[o] = lerp(pa[o], pb[o], k); out[o + 1] = lerp(pa[o + 1], pb[o + 1], k);
      out[o + 2] = lerpA(pa[o + 2] / 100, pb[o + 2] / 100, k) * 100;
    }
    players.push(out);
  }
  updateCam(dt);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(W / 2, H / 2);
  ctx.rotate(cam.rot * 0.2);
  ctx.translate(-W / 2 + cam.ox * cam.s, -H / 2 + cam.oy * cam.s);

  drawBackground(time);

  // props
  const list = [];
  for (const s of map.shapes) {
    if (s.k === 0) continue;
    let x = s.x, y = s.y, a = s.a;
    if (s.k !== 0 && A) {
      const oa = A.O.get(s.id), ob = B.O.get(s.id) || oa;
      if (oa) { x = lerp(oa[1], ob[1], k) / 100; y = lerp(oa[2], ob[2], k) / 100; a = lerpA(oa[3] / 100, ob[3] / 100, k); }
    }
    list.push({ s, x, y, a });
  }
  const byId = new Map(list.map(o => [o.s.id, o]));
  ctx.strokeStyle = '#1e1e1e'; ctx.lineWidth = Math.max(1.5, 0.06 * cam.s);
  for (const [ax, ay, id, lx, ly] of map.ropes) {
    const p = byId.get(id);
    if (!p) continue;
    const c = Math.cos(p.a), s = Math.sin(p.a);
    ctx.beginPath(); ctx.moveTo(sx(ax), sy(ay)); ctx.lineTo(sx(p.x + lx * c - ly * s), sy(p.y + lx * s + ly * c)); ctx.stroke();
  }
  drawBlockSides(list);
  blitLayer(layers.level);
  drawBlockFronts(list, time);

  if (A) {
    // items
    for (const [id, ib] of B.I) {
      const ia = A.I.get(id) || ib;
      const x = lerp(ia[2], ib[2], k) / 100, y = lerp(ia[3], ib[3], k) / 100, a = lerpA(ia[4] / 100, ib[4] / 100, k);
      if (ib[5] === 2 && Math.sin(time * 18) > 0) continue;
      ctx.save();
      ctx.translate(sx(x), sy(y)); ctx.rotate(-a);
      if (ib[5]) {
        const spr = gunSprite(WEAPONS[ib[1]]);
        ctx.drawImage(spr.c, -spr.ox, -spr.oy, spr.w, spr.h);
      } else {
        ctx.globalAlpha = 0.6;
        drawGun(WEAPONS[ib[1]], cam.s);
      }
      ctx.restore();
    }
    // rockets / grenades
    for (const [id, rb] of B.R) {
      const ra = A.R.get(id) || rb;
      const x = lerp(ra[2], rb[2], k) / 100, y = lerp(ra[3], rb[3], k) / 100, a = lerpA(ra[4] / 100, rb[4] / 100, k);
      ctx.save(); ctx.translate(sx(x), sy(y)); ctx.rotate(-a);
      ctx.fillStyle = '#141414';
      if (rb[1] === 0) {
        ctx.fillRect(-0.28 * cam.s, -0.08 * cam.s, 0.45 * cam.s, 0.16 * cam.s);
        ctx.beginPath(); ctx.moveTo(0.17 * cam.s, -0.08 * cam.s); ctx.lineTo(0.32 * cam.s, 0); ctx.lineTo(0.17 * cam.s, 0.08 * cam.s); ctx.fill();
        spawnParticles(x - Math.cos(a) * 0.35, y - Math.sin(a) * 0.35, 1, { dir: a + Math.PI, spread: 0.4, speed: 3, life: 0.45, size: 0.3, color: Math.random() > 0.4 ? 'rgba(60,60,60,0.4)' : '#ffb347', g: -0.1, drag: 3, kind: 'puff' });
      } else {
        ctx.beginPath(); ctx.arc(0, 0, 0.16 * cam.s, 0, 7); ctx.fill();
        if (Math.sin(time * 25) > 0) { ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(0, 0.1 * cam.s, 0.05 * cam.s, 0, 7); ctx.fill(); }
      }
      ctx.restore();
    }
    players.sort((a, b) => a[1] - b[1] || (a[0] === myId) - (b[0] === myId));
    for (const p of players) headPos.set(p[0], drawPlayer(p, time, dt));
  }

  for (const o of list) if (o.s.hz === 'lava') drawLava(o.s, o.x, o.y, time);

  // bullets (simulated locally from spawn events)
  ctx.globalCompositeOperation = 'lighter';
  for (const [id, b] of bullets) {
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0) { bullets.delete(id); continue; }
    const len = b.w === 'sniper' ? 0.06 : 0.035;
    ctx.strokeStyle = b.w === 'sniper' ? 'rgba(255,255,240,0.95)' : 'rgba(255,240,190,0.9)';
    ctx.lineWidth = Math.max(1.5, (b.w === 'sniper' ? 0.1 : 0.07) * cam.s);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx(b.x - b.vx * len), sy(b.y - b.vy * len)); ctx.lineTo(sx(b.x), sy(b.y)); ctx.stroke();
  }
  for (const f of flashes) {
    f.life -= dt;
    const al = Math.max(0, f.life / f.max);
    if (f.boom) {
      const r = f.size * cam.s * (1.2 - al * 0.5);
      const g = ctx.createRadialGradient(sx(f.x), sy(f.y), 0, sx(f.x), sy(f.y), r);
      g.addColorStop(0, `rgba(255,255,230,${al})`); g.addColorStop(0.4, `rgba(255,190,90,${al * 0.8})`); g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx(f.x), sy(f.y), r, 0, 7); ctx.fill();
    } else {
      ctx.save(); ctx.translate(sx(f.x), sy(f.y)); ctx.rotate(-f.a);
      ctx.fillStyle = `rgba(255,236,160,${al})`;
      const L = f.size * cam.s, T = f.size * 0.35 * cam.s;
      ctx.beginPath(); ctx.moveTo(-T * 0.3, 0); ctx.lineTo(L * 0.5, -T); ctx.lineTo(L, 0); ctx.lineTo(L * 0.5, T); ctx.fill();
      ctx.restore();
    }
  }
  flashes = flashes.filter(f => f.life > 0);
  ctx.globalCompositeOperation = 'source-over';

  for (const r of rings) {
    r.life -= dt; r.r += r.grow * dt;
    ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, r.life / r.max) * 0.8})`;
    ctx.lineWidth = r.w * cam.s * Math.max(0.1, r.life / r.max);
    ctx.beginPath(); ctx.arc(sx(r.x), sy(r.y), r.r * cam.s, 0, 7); ctx.stroke();
  }
  rings = rings.filter(r => r.life > 0);

  for (const p of particles) {
    p.life -= dt;
    p.vy -= 22 * p.g * dt;
    if (p.drag) { p.vx *= Math.max(0, 1 - p.drag * dt); p.vy *= Math.max(0, 1 - p.drag * dt); }
    p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    const al = Math.max(0, Math.min(1, p.life / p.max * 2));
    ctx.globalAlpha = al;
    ctx.fillStyle = p.color;
    const s = p.size * cam.s;
    if (p.kind === 'puff') { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), s * (1.6 - al * 0.6), 0, 7); ctx.fill(); }
    else if (p.kind === 'shell') { ctx.save(); ctx.translate(sx(p.x), sy(p.y)); ctx.rotate(p.rot); ctx.fillRect(-s, -s / 2.5, s * 2, s / 1.25); ctx.restore(); }
    else ctx.fillRect(sx(p.x) - s / 2, sy(p.y) - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  particles = particles.filter(p => p.life > 0);
  if (particles.length > 1200) particles.splice(0, particles.length - 1200);

  // wind streaks
  if (B && B.wd) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1.5;
    const dir = Math.sign(B.wd);
    for (let i = 0; i < 50; i++) {
      const y = ((i * 97) % H);
      const x = ((((i * 173 + time * 900 * dir) % (W + 200)) + W + 200) % (W + 200)) - 100;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dir * 60, y); ctx.stroke();
    }
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // vignette
  ctx.drawImage(layers.vignette, 0, 0, W, H);

  // names shortly after the round starts so everyone finds themselves
  if (mapT < 3.5) {
    ctx.globalAlpha = Math.min(1, (3.5 - mapT) * 2);
    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.max(11, Math.min(16, cam.s * 0.5))}px Arial, sans-serif`;
    for (const [id, h] of headPos) {
      const r = roster.get(id);
      if (!r) continue;
      const x = sx(h.hx), y = sy(h.hy + 0.6) + cam.oy * cam.s;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(r.name, x + 1, y + 1);
      ctx.fillStyle = '#fff'; ctx.fillText(r.name, x, y);
      if (id === myId) {
        ctx.fillStyle = r.color;
        ctx.beginPath(); ctx.moveTo(x - 7, y - 22); ctx.lineTo(x + 7, y - 22); ctx.lineTo(x, y - 13); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // round winner
  if (banner) {
    banner.t += dt;
    const inT = Math.min(1, banner.t * 5), out = banner.t > 2.2 ? Math.max(0, 1 - (banner.t - 2.2) * 5) : 1;
    ctx.globalAlpha = out;
    const bandH = Math.min(150, H * 0.2) * (1 - Math.pow(1 - inT, 3));
    ctx.fillStyle = 'rgba(10,10,10,0.8)';
    ctx.fillRect(0, H / 2 - bandH / 2, W, bandH);
    if (inT > 0.5) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const fs = Math.min(64, W / 14);
      ctx.font = `900 ${fs}px "Arial Black", Arial, sans-serif`;
      ctx.fillStyle = banner.color;
      ctx.fillText(banner.draw ? 'UNENTSCHIEDEN' : banner.name.toUpperCase(), W / 2, H / 2 - (banner.draw ? 0 : fs * 0.2));
      if (!banner.draw) {
        ctx.font = `700 ${fs * 0.28}px Arial, sans-serif`;
        ctx.fillStyle = '#bbb';
        ctx.fillText('G E W I N N T', W / 2, H / 2 + fs * 0.5);
      }
      ctx.textBaseline = 'alphabetic';
    }
    ctx.globalAlpha = 1;
    if (banner.t > 2.6) banner = null;
  }

  if (fade > 0) {
    fade = Math.max(0, fade - dt * 2.5);
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, W, H);
  }

  // crosshair + ammo
  if (myId) {
    const me = players.find(p => p[0] === myId);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.arc(mouseX, mouseY, 7, 0, 7); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.arc(mouseX, mouseY, 7, 0, 7); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillRect(mouseX - 1, mouseY - 1, 2, 2);
    if (me && me[1] && me[3] >= 0) {
      ctx.font = '700 12px Arial, sans-serif'; ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(me[4], mouseX + 13, mouseY + 17);
      ctx.fillStyle = '#fff'; ctx.fillText(me[4], mouseX + 12, mouseY + 16);
    }
  }
}

function drawMenuBg(time) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#2b2a28'); g.addColorStop(1, '#161616');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1d1d1d';
  for (let i = 0; i < 14; i++) {
    const w = 60 + ((i * 53) % 90), h = 120 + ((i * 97) % 260);
    const x = ((i * 157 + time * 8) % (W + 200)) - 100;
    ctx.fillRect(x, H - h, w, h);
  }
  ctx.fillStyle = '#101010'; ctx.fillRect(0, H - 40, W, 40);
}

requestAnimationFrame(frame);

// ---------------------------------------------------------------- audio (synthesized)
let AC = null, master = null, noiseBuf = null;
function audio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    const comp = AC.createDynamicsCompressor();
    comp.connect(AC.destination);
    master = AC.createGain(); master.gain.value = 0.55; master.connect(comp);
    noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { AC = null; }
}
function noise(dur, freq, q, vol, type = 'lowpass', sweep, attack = 0.002) {
  const t = AC.currentTime;
  const src = AC.createBufferSource(); src.buffer = noiseBuf;
  const f = AC.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
  const g = AC.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
}
function thump(f0, f1, dur, vol) {
  const t = AC.currentTime;
  const o = AC.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
}
const sfxLast = {};
function sfx(name) {
  if (!AC || muted) return;
  const now = performance.now();
  if (now - (sfxLast[name] || 0) < 30) return;
  sfxLast[name] = now;
  const R = () => 0.85 + Math.random() * 0.3;
  switch (name) {
    case 'pistol': noise(0.18, 2200 * R(), 0.7, 0.7, 'lowpass', 300); thump(160, 50, 0.1, 0.5); break;
    case 'ar': noise(0.12, 2600 * R(), 0.7, 0.5, 'lowpass', 400); thump(140, 50, 0.07, 0.35); break;
    case 'minigun': noise(0.07, 3000 * R(), 0.7, 0.35, 'lowpass', 600); break;
    case 'shotgun': noise(0.45, 1600, 0.6, 1, 'lowpass', 120); thump(110, 35, 0.25, 0.9); break;
    case 'sniper': noise(0.7, 4000, 0.5, 1, 'lowpass', 150); thump(180, 30, 0.35, 0.9); break;
    case 'rpg': noise(0.5, 700, 0.8, 0.6, 'lowpass', 2200, 0.03); thump(90, 40, 0.2, 0.5); break;
    case 'grenade': noise(0.12, 900, 1, 0.25, 'bandpass', 300); break;
    case 'boom': noise(1.4, 1200, 0.6, 1.3, 'lowpass', 40); thump(80, 22, 0.9, 1.1); break;
    case 'whoosh': noise(0.13, 500, 2, 0.22, 'bandpass', 1800, 0.03); break;
    case 'punchhit': noise(0.12, 900, 0.8, 0.9, 'lowpass', 150); thump(120 * R(), 40, 0.15, 0.9); break;
    case 'hit': noise(0.1, 1400 * R(), 1, 0.6, 'lowpass', 200); thump(100 * R(), 45, 0.1, 0.6); break;
    case 'ric': noise(0.08, 4000 * R(), 4, 0.15, 'bandpass', 2000); break;
    case 'thud': thump(90, 35, 0.2, 0.7); noise(0.12, 500, 1, 0.4); break;
    case 'pick': noise(0.05, 3000, 3, 0.35, 'bandpass'); setTimeout(() => AC && noise(0.05, 2200, 3, 0.3, 'bandpass'), 60); break;
    case 'die': thump(140, 30, 0.35, 0.9); noise(0.3, 700, 0.7, 0.5, 'lowpass', 80); break;
    case 'sizzle': noise(1, 5000, 0.5, 0.5, 'highpass', 1500, 0.05); break;
    case 'saw': noise(0.4, 3500, 6, 0.5, 'bandpass', 1500); break;
    case 'crack': noise(0.5, 600, 0.8, 1, 'lowpass', 80); thump(70, 30, 0.3, 0.6); break;
    case 'win': thump(220, 110, 0.6, 0.35); noise(0.8, 3000, 0.5, 0.15, 'highpass', 8000, 0.2); break;
  }
}
})();

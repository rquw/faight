(() => {
'use strict';
const WEAPONS = ['pistol', 'ar', 'shotgun', 'sniper', 'rpg', 'minigun', 'grenade'];
// half lengths per body: hip, chest, head, ua0, la0, ua1, la1, ul0, ll0, ul1, ll1
const HH = [0.17, 0.2, 0, 0.17, 0.16, 0.17, 0.16, 0.23, 0.23, 0.23, 0.23];
const HEAD_R = 0.27, LW = 0.2;
let INTERP = 0.1, snapGap = 1 / 30, lastSnapAt = 0, jitter = 0.02;
const KICK = { pistol: 2.2, ar: 1.1, shotgun: 6, sniper: 9, rpg: 6, minigun: 0.7, grenade: 0.5 };
// distance from the hand to the drawn barrel tip - shots, the laser and the grenade arc start there
const BARREL = { pistol: 0.4, ar: 0.82, shotgun: 0.86, sniper: 1.2, rpg: 1.08, minigun: 1.06, grenade: 0.2 };

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
const hpShow = new Map();
const protect = new Map();
const goneIds = new Set();
let hostId = 0, queuedMap = null, mapNames = [], mapCats = [], slowUntil = 0, suddenT = 0;
let muted = false;

// ---------------------------------------------------------------- menu
const nameIn = $('name'), codeIn = $('code');
try { nameIn.value = localStorage.getItem('faight-name') || ''; } catch {}
const urlCode = (new URLSearchParams(location.search).get('code') || '').replace(/\D/g, '').slice(0, 4);
if (urlCode) codeIn.value = urlCode;
codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.replace(/\D/g, '').slice(0, 4); });

let visibility = 'public';
function myName() { return nameIn.value.trim() || 'Stick' + Math.floor(Math.random() * 99); }
function go(kind) {
  const name = myName();
  try { localStorage.setItem('faight-name', name); } catch {}
  if (kind === 'join' && codeIn.value.length !== 4) { $('err').textContent = 'The code has 4 digits'; return; }
  audio();
  const msg = kind === 'create' ? { t: 'create', name, vis: visibility } : { t: 'join', name, code: codeIn.value };
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  else connect(() => ws.send(JSON.stringify(msg)));
}
for (const v of ['public', 'private']) {
  $('vis-' + v).onclick = () => {
    visibility = v;
    $('vis-public').className = v === 'public' ? 'on' : '';
    $('vis-private').className = v === 'private' ? 'on' : '';
  };
}
// joining through an invite link: just the name, one OK, straight into the game
const inviteName = $('invite-name');
function openInvite() {
  $('invite-code').textContent = urlCode;
  $('menu').hidden = true;
  $('invite').hidden = false;
  inviteName.value = nameIn.value;
  setTimeout(() => inviteName.focus(), 50);
}
function inviteGo() {
  nameIn.value = inviteName.value.trim();
  codeIn.value = urlCode;
  $('invite').hidden = true;
  $('menu').hidden = false;
  go('join');
}
$('invite-ok').onclick = inviteGo;
inviteName.addEventListener('keydown', (e) => { if (e.key === 'Enter') inviteGo(); });
$('invite-back').onclick = () => { $('invite').hidden = true; $('menu').hidden = false; };
if (urlCode.length === 4) openInvite();

fetch('version').then(r => r.text()).then(v => { $('version').textContent = 'v' + v.trim(); }).catch(() => {});

// lobby on the start screen: public rooms can be joined straight away, private ones need the host
let lobbyTimer = null;
function lobbyPoll() {
  clearInterval(lobbyTimer);
  const ask = () => {
    if (myId) return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'rooms' }));
  };
  if (ws && ws.readyState === 1) ask(); else connect(ask);
  lobbyTimer = setInterval(ask, 3000);
}
function renderLobby(list, max, cap) {
  const el = $('lobby');
  el.innerHTML = '';
  if (!list.length) { el.innerHTML = '<div class="lobby-empty">No open rooms - create one</div>'; return; }
  for (const r of list) {
    const card = document.createElement('div');
    card.className = 'lobby-card';
    const names = r.players.map(p => p[0]).join(', ');
    card.innerHTML = `<div class="lc"></div><div class="li"><b></b><span></span></div><button class="lj"></button>`;
    const code = card.querySelector('.lc');
    code.textContent = r.pub ? r.code : 'PRIVATE';
    if (!r.pub) code.className = 'lc priv';
    card.querySelector('b').textContent = names || '(empty)';
    card.querySelector('span').textContent = `${r.players.length}/${r.max} · ${r.map || 'starting…'}`;
    const btn = card.querySelector('.lj');
    btn.textContent = r.pub ? 'Join' : 'Ask to join';
    const act = () => {
      if (r.players.length >= r.max) { $('err').textContent = 'That room is full'; return; }
      if (r.pub) { codeIn.value = r.code; go('join'); }
      else {
        $('err').textContent = 'Asking the host…';
        const send = () => ws.send(JSON.stringify({ t: 'knock', rid: r.rid, name: myName() }));
        if (ws && ws.readyState === 1) send(); else connect(send);
      }
    };
    card.onclick = act;
    btn.onclick = (e) => { e.stopPropagation(); act(); };
    el.appendChild(card);
  }
}
lobbyPoll();

// how to play: hover the little i (tap toggles it on touch devices)
const howto = $('howto'), infoBtn = $('info');
infoBtn.addEventListener('mouseenter', () => howto.classList.add('show'));
infoBtn.addEventListener('mouseleave', () => howto.classList.remove('show'));
howto.addEventListener('mouseenter', () => howto.classList.add('show'));
howto.addEventListener('mouseleave', () => howto.classList.remove('show'));
infoBtn.addEventListener('click', (e) => { e.preventDefault(); howto.classList.toggle('show'); });

$('create').onclick = () => go('create');
$('join').onclick = () => go('join');
codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go('join'); });
nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') codeIn.value.length === 4 ? go('join') : go('create'); });
$('copy').onclick = () => {
  navigator.clipboard && navigator.clipboard.writeText(location.origin + location.pathname + '?code=' + roomCode);
  $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Link', 1200);
};
$('mute').onclick = () => { muted = !muted; $('mute').textContent = muted ? 'Sound off' : 'Sound on'; };

// chat: Enter opens the box, Enter sends, Esc cancels
const chatBar = $('chatbar'), chatIn = $('chatin');
const chatBubbles = new Map();
function openChat() {
  for (const k in keys) keys[k] = 0;
  sendInput();
  chatBar.hidden = false;
  chatIn.value = '';
  chatIn.focus();
}
function closeChat() { chatBar.hidden = true; chatIn.blur(); }
addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !myId || !chatBar.hidden || e.target.tagName === 'INPUT') return;
  e.preventDefault();
  openChat();
});
chatIn.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    e.preventDefault();
    const text = chatIn.value.trim();
    if (text && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'chat', text }));
    closeChat();
  } else if (e.key === 'Escape') closeChat();
});
function chatLog(id, text) {
  const r = roster.get(id);
  const row = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = r ? r.name + ':' : '?:';
  name.style.color = r ? r.color : '#ccc';
  row.append(name, text);
  $('chatlog').appendChild(row);
  while ($('chatlog').children.length > 5) $('chatlog').firstChild.remove();
  setTimeout(() => { row.style.opacity = '0'; }, 7000);
  setTimeout(() => row.remove(), 7700);
}

// host map picker: L (or the Maps button) queues the next map
function toggleMapPick() {
  if (!myId || hostId !== myId) return;
  const el = $('mappick');
  el.hidden = !el.hidden;
  if (!el.hidden) renderMapPick();
}
function renderMapPick() {
  const list = $('mappick-list');
  list.innerHTML = '';
  const button = (label, value, parent) => {
    const b = document.createElement('button');
    b.textContent = label;
    if ((queuedMap || null) === value) b.className = 'on';
    b.onclick = () => { ws.send(JSON.stringify({ t: 'queue', map: value })); $('mappick').hidden = true; };
    if (value && !value.startsWith('cat:')) {
      b.onmouseenter = () => showPreview(value);
      b.addEventListener('focus', () => showPreview(value));
    }
    parent.appendChild(b);
  };
  const any = document.createElement('div');
  any.className = 'cat-row';
  button('Fully random', null, any);
  list.appendChild(any);
  for (const cat of mapCats) {
    const row = document.createElement('div');
    row.className = 'cat-row';
    const h = document.createElement('div');
    h.className = 'cat-name';
    h.textContent = cat;
    row.appendChild(h);
    button('Random', 'cat:' + cat, row);
    for (const name of mapNames.filter(n => n.startsWith(cat + ' '))) button(name.slice(cat.length + 1), name, row);
    list.appendChild(row);
  }
}
// hovering a map in the picker shows what it looks like (built once per map on the server)
const previewCache = new Map();
function showPreview(name) {
  $('mapprev-name').textContent = name;
  const have = previewCache.get(name);
  if (have) return drawPreview(have);
  const c = $('mapprev'), g = c.getContext('2d');   // don't leave the previous map under a new name
  g.fillStyle = '#101010'; g.fillRect(0, 0, c.width, c.height);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'preview', map: name }));
}
function drawPreview(d) {
  if ($('mapprev-name').textContent !== d.name) return;
  const c = $('mapprev'), g = c.getContext('2d');
  const s = Math.min(c.width / (d.W + 2), c.height / (d.H + 2));
  const ox = (c.width - d.W * s) / 2, oy = (c.height - d.H * s) / 2;
  const px = (x) => ox + x * s, py = (y) => c.height - oy - y * s;
  const grd = g.createLinearGradient(0, 0, 0, c.height);
  grd.addColorStop(0, d.sky[0]); grd.addColorStop(1, d.sky[1]);
  g.fillStyle = grd; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(30,30,30,0.9)'; g.lineWidth = 1;
  const byId = new Map(d.shapes.map(sh => [sh.id, sh]));
  for (const [ax, ay, id, lx, ly] of d.ropes) {
    const sh = byId.get(id);
    if (!sh) continue;
    const ca = Math.cos(sh.a), sa = Math.sin(sh.a);
    g.beginPath(); g.moveTo(px(ax), py(ay)); g.lineTo(px(sh.x + lx * ca - ly * sa), py(sh.y + lx * sa + ly * ca)); g.stroke();
  }
  for (const sh of d.shapes) {
    g.fillStyle = sh.hz === 'lava' ? '#e2561f' : sh.hz ? '#8b2f2f' : sh.c || (sh.cr ? '#3a3029' : '#26272a');
    if (sh.s === 'c') { g.beginPath(); g.arc(px(sh.x), py(sh.y), sh.r * s, 0, 7); g.fill(); continue; }
    g.save();
    g.translate(px(sh.x), py(sh.y)); g.rotate(-sh.a);
    g.fillRect(-sh.w / 2 * s, -sh.h / 2 * s, sh.w * s, sh.h * s);
    g.restore();
  }
}

addEventListener('keydown', (e) => {
  if (e.code === 'KeyL' && !e.repeat && myId && e.target.tagName !== 'INPUT') toggleMapPick();
  if (e.code === 'Escape') $('mappick').hidden = true;
});
$('maps').onclick = toggleMapPick;
$('mappick-close').onclick = () => { $('mappick').hidden = true; };

// hidden room browser: press K five times on the start page
let kPresses = [], roomsTimer = null;
addEventListener('keydown', (e) => {
  if (myId || e.code !== 'KeyK' || e.target.tagName === 'INPUT') return;
  const now = performance.now();
  kPresses = kPresses.filter(t => now - t < 2000);
  kPresses.push(now);
  if (kPresses.length >= 5) { kPresses = []; openRooms(); }
});
function openRooms() {
  $('rooms').hidden = false;
  $('rooms-list').innerHTML = '<div class="rooms-empty">Loading…</div>';
  const ask = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'rooms' })); };
  if (ws && ws.readyState === 1) ask(); else connect(ask);
  clearInterval(roomsTimer);
  roomsTimer = setInterval(ask, 2000);
}
function closeRooms() { $('rooms').hidden = true; clearInterval(roomsTimer); }
$('rooms-close').onclick = closeRooms;
function renderRooms(list) {
  const el = $('rooms-list');
  if (!list.length) { el.innerHTML = '<div class="rooms-empty">No active rooms</div>'; return; }
  el.innerHTML = '';
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'room-row';
    row.innerHTML = `<div class="code"></div><div class="info"><span class="meta"></span><div class="names"></div></div><button>Join</button>`;
    row.querySelector('.code').textContent = r.code;
    row.querySelector('.meta').textContent = `${r.players.length} players · ${r.map}`;
    const names = row.querySelector('.names');
    for (const [name, color, score] of r.players) {
      const n = document.createElement('span');
      n.innerHTML = `<i style="background:${color}"></i>`;
      n.append(`${name} (${score})`);
      names.appendChild(n);
    }
    row.querySelector('button').onclick = () => { closeRooms(); codeIn.value = r.code; go('join'); };
    el.appendChild(row);
  }
}

let rtt = 0, pingTimer = null;
function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', c: performance.now() })); }, 1000);
}

function connect(onOpen, attempt = 0) {
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); }
  $('err').textContent = attempt ? `Server is starting… (${attempt * 3}s)` : '';
  const sock = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  let opened = false;
  sock.onopen = () => { opened = true; $('err').textContent = ''; onOpen(); };
  sock.onclose = () => {
    if (!opened) {
      if (attempt < 25) setTimeout(() => connect(onOpen, attempt + 1), 3000);
      else $('err').textContent = 'Server unreachable';
      return;
    }
    if (myId) { $('menu').hidden = false; $('hud').hidden = true; touchLayer.hidden = true; $('err').textContent = 'Connection lost'; myId = 0; map = null; $('knocks').innerHTML = ''; lobbyPoll(); }
  };
  sock.binaryType = 'arraybuffer';
  sock.onmessage = (ev) => {
    if (typeof ev.data === 'string') onMessage(JSON.parse(ev.data));
    else if (map) onSnap(faightProtocol.decode(ev.data));
  };
}

function onMessage(m) {
  switch (m.t) {
    case 'err': $('err').textContent = m.m; break;
    case 'pong': {
      const r = performance.now() - m.c;
      rtt = rtt ? rtt + (r - rtt) * 0.3 : r;
      $('ping').textContent = Math.round(rtt) + ' ms';
      $('ping').style.color = rtt < 70 ? '#8ce08c' : rtt < 150 ? '#e8d27a' : '#e8756a';
      break;
    }
    case 'rooms':
      if (!$('rooms').hidden) renderRooms(m.list);
      if (!myId) renderLobby(m.list, m.max, m.cap);
      break;
    case 'queue':
      $('err').textContent = `You're in the queue! Position: ${m.pos}/${m.of} (all ${m.rooms} rooms are busy)`;
      break;
    case 'queueReady':
      $('err').textContent = 'A room opened up - starting yours…';
      go('create');
      break;
    case 'knocked': $('err').textContent = 'Request sent - waiting for the host…'; break;
    case 'knockDenied': $('err').textContent = 'The host said no'; break;
    case 'invite': $('err').textContent = ''; codeIn.value = m.code; go('join'); break;
    case 'knock': addKnock(m.id, m.name); break;
    case 'preview': previewCache.set(m.data.name, m.data); drawPreview(m.data); break;
    case 'joined':
      myId = m.id; roomCode = m.code;
      mapNames = m.maps || [];
      mapCats = m.cats || [];
      $('roomcode').textContent = m.code;
      $('menu').hidden = true; $('hud').hidden = false;
      clearInterval(lobbyTimer);
      touchLayer.hidden = !touchMode;
      history.replaceState(null, '', '?code=' + m.code + location.hash);
      startPing();
      break;
    case 'roster':
      roster.clear();
      for (const [id, name, color, score] of m.list) { roster.set(id, { name, color, score }); colorCache.set(id, color); }
      renderScores();
      hostId = m.host;
      queuedMap = m.queued;
      $('maps').hidden = hostId !== myId;
      $('queued').textContent = !queuedMap ? '' : 'Next map: ' + (queuedMap.startsWith('cat:') ? queuedMap.slice(4) + ' (random)' : queuedMap);
      if (!$('mappick').hidden) renderMapPick();
      break;
    case 'map':
      map = m;
      map.deco = makeDeco(m);
      map.shapeById = new Map(m.shapes.map(sh => [sh.id, sh]));
      mapSerial++;
      mapT = 0;
      snaps = []; clockOffset = null; pendingEvents = []; particles = []; rings = []; flashes = []; bullets.clear(); protect.clear(); goneIds.clear();
      fade = 1;
      sfx('start');
      banner = null;
      break;
    case 'e': for (const e of m.e) pendingEvents.push({ t: m.tm / 1000, e }); break;
  }
}

// someone wants into your private room
function addKnock(id, name) {
  const el = document.createElement('div');
  el.className = 'knock';
  el.innerHTML = '<span><b></b> wants to join</span><button class="yes">Let in</button><button class="no">No</button>';
  el.querySelector('b').textContent = name;
  const answer = (ok) => { ws.send(JSON.stringify({ t: 'knockAnswer', id, ok })); el.remove(); };
  el.querySelector('.yes').onclick = () => answer(true);
  el.querySelector('.no').onclick = () => answer(false);
  $('knocks').appendChild(el);
  sfx('chat');
  setTimeout(() => el.remove(), 30000);
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
  if (lastSnapAt) {
    const gap = Math.min(0.5, now - lastSnapAt);
    snapGap += (gap - snapGap) * 0.08;
    // jitter reacts at once but is forgotten quickly - every millisecond of buffer is input delay
    jitter = Math.max(jitter * 0.93, Math.min(0.06, Math.abs(gap - snapGap)));
  }
  lastSnapAt = now;
  INTERP = Math.max(0.035, Math.min(0.1, snapGap * 1.15 + jitter));
  const t = s.tm / 1000;
  const off = t - now;
  // keep the newest offset (a late packet must not pull the render clock forward), drift back slowly
  if (clockOffset === null || !snaps.length || off > clockOffset) clockOffset = off;
  else clockOffset -= Math.min(0.0006, (clockOffset - off) * 0.05);
  const snap = { t, P: new Map(), O: new Map(), I: new Map(), R: new Map() };
  // players that did not move are left out of a snapshot: carry their last pose over
  const prev = snaps[snaps.length - 1];
  if (prev) for (const [id, row] of prev.P) { if (!goneIds.has(id) && roster.has(id)) snap.P.set(id, row); }
  for (const p of s.P) snap.P.set(p[0], p);
  for (const o of s.O) snap.O.set(o[0], o);
  for (const i of s.I) snap.I.set(i[0], i);
  for (const r of s.R) snap.R.set(r[0], r);
  snaps.push(snap);
  if (snaps.length > 30) snaps.shift();
  // sleeping props aren't resent every time: remember their last pose
  for (const o of s.O) { const sh = map.shapeById.get(o[0]); if (sh) { sh.x = o[1] / 100; sh.y = o[2] / 100; sh.a = o[3] / 100; } }
}

// Your own character is shown ahead of the interpolation buffer: the last known hip velocity is
// extrapolated over (age of the newest snapshot + half the round trip), so pressing A/D feels
// immediate instead of a full ping late. The correction is low-passed so it never snaps.
const predOff = { x: 0, y: 0 };
// small debug hook (used to measure input delay): faightDebug.pos / .rtt / .interp, .predict = false
const dbg = window.faightDebug = { pos: null, rtt: 0, interp: 0, predict: true };
function predictLocal(players, dt) {
  const row = players.find(p => p[0] === myId);
  if (!row || !row[1] || row[5] || snaps.length < 2 || !dbg.predict) { predOff.x = predOff.y = 0; return; }
  const N = snaps[snaps.length - 1], P = snaps[snaps.length - 2];
  const a = P.P.get(myId), b = N.P.get(myId);
  let tx = 0, ty = 0;
  if (a && b && N.t > P.t) {
    const step = N.t - P.t;
    const vx = (b[6] - a[6]) / 100 / step, vy = (b[7] - a[7]) / 100 / step;
    const lead = Math.max(0, Math.min(0.25, performance.now() / 1000 + clockOffset - N.t + rtt / 2000));
    tx = Math.max(-3, Math.min(3, vx * lead));
    ty = Math.max(-3, Math.min(3, vy * lead));
  }
  const k = Math.min(1, dt * 18);
  predOff.x += (tx - predOff.x) * k;
  predOff.y += (ty - predOff.y) * k;
  for (let i = 0; i < 11; i++) { row[6 + i * 3] += predOff.x * 100; row[7 + i * 3] += predOff.y * 100; }
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
  // if the newest snapshot is older than the render clock (a late packet), keep moving along the
  // last known direction for up to 0.15 s instead of freezing everything on screen
  if (a === b && snaps.length > 1 && rt > a.t) {
    a = snaps[snaps.length - 2]; b = snaps[snaps.length - 1];
  }
  let k = 0;
  if (b.t > a.t) {
    k = (rt - a.t) / (b.t - a.t);
    k = Math.max(0, Math.min(1 + 0.15 / (b.t - a.t), k));
  }
  return { a, b, k, rt };
}

// ---------------------------------------------------------------- input
const keys = { l: 0, r: 0, d: 0, j: 0, s: 0, th: 0 };
let mouseX = innerWidth / 2, mouseY = innerHeight / 2;
const KEYMAP = { KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r', KeyS: 'd', ArrowDown: 'd', Space: 'j', KeyW: 'j', ArrowUp: 'j', KeyQ: 'th', KeyF: 'th' };
addEventListener('keydown', (e) => {
  if (!myId || e.target.tagName === 'INPUT') return;
  if (e.code === 'KeyK' && !e.repeat && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'bot' }));
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
function aimPoint() {
  if (!touchMode) return screenToWorld(mouseX, mouseY);
  if (!myPos) return { x: map.W / 2, y: map.H / 2 };
  const d = touch.tapDir || touch.aimDir || { x: touch.face, y: 0 };
  return { x: myPos.x + d.x * 6, y: myPos.y + d.y * 6 };
}

function sendInput() {
  if (!ws || ws.readyState !== 1 || !myId || !map) return;
  const w = aimPoint();
  const str = JSON.stringify({ t: 'i', l: keys.l, r: keys.r, d: keys.d, j: keys.j, s: keys.s, th: keys.th, ax: Math.round(w.x * 100) / 100, ay: Math.round(w.y * 100) / 100 });
  if (str === lastSent) return;
  lastSent = str;
  ws.send(str);
}
setInterval(sendInput, 33);

// ---------------------------------------------------------------- touch controls (Brawl Stars style)
// left: floating move stick (down = duck / fast fall), right: attack stick (drag = aim + fire,
// back to center = cancel, quick tap = shoot at the nearest enemy), plus jump and drop buttons
let touchMode = false, myPos = null, livePlayers = [];
const touch = { move: null, attack: null, jump: null, drop: null, aimDir: null, tapDir: null, face: 1 };
const touchLayer = document.createElement('div');
touchLayer.id = 'touch';
touchLayer.hidden = true;
document.body.insertBefore(touchLayer, $('hud'));

function touchLayout() {
  const R = Math.max(48, Math.min(86, Math.min(W, H) * 0.14));
  const m = Math.max(18, R * 0.35);
  const attack = { x: W - m - R * 1.15, y: H - m - R * 1.15, r: R };
  return {
    R,
    attack,
    jump: { x: attack.x - R * 2.35, y: H - m - R * 0.7, r: R * 0.62 },
    drop: { x: attack.x + R * 0.1, y: attack.y - R * 2.2, r: R * 0.42 },
    moveHint: { x: m + R * 1.25, y: H - m - R * 1.15, r: R },
  };
}
const inCircle = (t, c, k = 1) => Math.hypot(t.clientX - c.x, t.clientY - c.y) <= c.r * k;

function enterTouchMode() {
  if (touchMode) return;
  touchMode = true;
  document.body.classList.add('touch');
  touchLayer.hidden = !myId;
}
addEventListener('touchstart', enterTouchMode, { passive: true });
if (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) enterTouchMode();

touchLayer.addEventListener('touchstart', (e) => {
  e.preventDefault();
  audio();
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {})).catch(() => {});
  const L = touchLayout();
  for (const t of e.changedTouches) {
    const p = { id: t.identifier, x: t.clientX, y: t.clientY, sx: t.clientX, sy: t.clientY, t0: performance.now() };
    if (!touch.jump && inCircle(t, L.jump, 1.3)) { touch.jump = p; keys.j = 1; }
    else if (!touch.drop && inCircle(t, L.drop, 1.35)) { touch.drop = p; keys.th = 1; }
    else if (!touch.attack && (inCircle(t, L.attack, 1.7) || (t.clientX > W * 0.6 && t.clientY > H * 0.35))) { p.sx = L.attack.x; p.sy = L.attack.y; touch.attack = p; }
    else if (!touch.move && t.clientX < W * 0.5) touch.move = p;
  }
  updateTouchKeys();
}, { passive: false });

touchLayer.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    for (const k of ['move', 'attack', 'jump', 'drop']) {
      if (touch[k] && touch[k].id === t.identifier) { touch[k].x = t.clientX; touch[k].y = t.clientY; }
    }
  }
  updateTouchKeys();
}, { passive: false });

function endTouch(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (touch.jump && touch.jump.id === t.identifier) { touch.jump = null; keys.j = 0; }
    if (touch.drop && touch.drop.id === t.identifier) { touch.drop = null; keys.th = 0; }
    if (touch.move && touch.move.id === t.identifier) touch.move = null;
    if (touch.attack && touch.attack.id === t.identifier) {
      const a = touch.attack, R = touchLayout().R;
      const quick = performance.now() - a.t0 < 250 && Math.hypot(a.x - a.sx, a.y - a.sy) < R * 0.35;
      touch.attack = null;
      touch.aimDir = null;
      if (quick) tapShoot();
    }
  }
  updateTouchKeys();
}
touchLayer.addEventListener('touchend', endTouch, { passive: false });
touchLayer.addEventListener('touchcancel', endTouch, { passive: false });

function tapShoot() {
  let best = null, bd = Infinity;
  if (myPos) for (const p of livePlayers) {
    if (p[0] === myId || !p[1]) continue;
    const d = Math.hypot(p[9] / 100 - myPos.x, p[10] / 100 - myPos.y);
    if (d < bd) { bd = d; best = p; }
  }
  if (best) {
    const dx = best[9] / 100 - myPos.x, dy = best[10] / 100 + 0.15 - myPos.y, l = Math.hypot(dx, dy) || 1;
    touch.tapDir = { x: dx / l, y: dy / l };
  } else touch.tapDir = { x: touch.face, y: 0 };
  keys.s = 1; sendInput();
  setTimeout(() => { keys.s = touch.attack ? keys.s : 0; touch.tapDir = null; sendInput(); }, 90);
}

function updateTouchKeys() {
  const R = touchLayout().R;
  keys.l = keys.r = keys.d = 0;
  if (touch.move) {
    const dx = (touch.move.x - touch.move.sx) / R, dy = (touch.move.y - touch.move.sy) / R;
    if (dx < -0.3) keys.l = 1;
    if (dx > 0.3) keys.r = 1;
    if (dy > 0.6) keys.d = 1;
    if (Math.abs(dx) > 0.3) touch.face = Math.sign(dx);
  }
  if (touch.attack) {
    const dx = touch.attack.x - touch.attack.sx, dy = touch.attack.y - touch.attack.sy, l = Math.hypot(dx, dy);
    if (l > R * 0.3) {
      touch.aimDir = { x: dx / l, y: -dy / l };
      touch.face = Math.sign(dx) || touch.face;
      keys.s = 1;
    } else { touch.aimDir = null; keys.s = 0; }
  } else if (!touch.tapDir) keys.s = 0;
  sendInput();
}

function drawTouchUI() {
  const L = touchLayout(), R = L.R;
  const ring = (x, y, r, fill, stroke) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 3; ctx.stroke(); }
  };
  const myColor = colorOf(myId);
  // aim guide from the player
  if (myPos && myPos.alive && touch.aimDir) {
    const px = sx(myPos.x), py = sy(myPos.y);
    ctx.save();
    ctx.setLineDash([10, 9]); ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.moveTo(px + touch.aimDir.x * cam.s, py - touch.aimDir.y * cam.s);
    ctx.lineTo(px + touch.aimDir.x * cam.s * 7, py - touch.aimDir.y * cam.s * 7); ctx.stroke();
    ctx.restore();
  }
  // move stick
  const mv = touch.move;
  const mb = mv ? { x: mv.sx, y: mv.sy } : L.moveHint;
  ring(mb.x, mb.y, R, 'rgba(0,0,0,0.22)', 'rgba(255,255,255,0.35)');
  let kx = mb.x, ky = mb.y;
  if (mv) { const dx = mv.x - mv.sx, dy = mv.y - mv.sy, l = Math.hypot(dx, dy), k = l > R ? R / l : 1; kx += dx * k; ky += dy * k; }
  ring(kx, ky, R * 0.45, 'rgba(255,255,255,0.55)');
  // attack stick
  const at = touch.attack;
  ring(L.attack.x, L.attack.y, R, at ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.22)', 'rgba(255,255,255,0.35)');
  let ax = L.attack.x, ay = L.attack.y;
  if (at) { const dx = at.x - at.sx, dy = at.y - at.sy, l = Math.hypot(dx, dy), k = l > R ? R / l : 1; ax += dx * k; ay += dy * k; }
  ring(ax, ay, R * 0.48, myColor, 'rgba(0,0,0,0.35)');
  if (myPos && myPos.armed) {
    ctx.fillStyle = '#111'; ctx.font = `900 ${Math.round(R * 0.32)}px Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(myPos.ammo, ax, ay);
    ctx.textBaseline = 'alphabetic';
  } else {
    // fist
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.arc(ax, ay, R * 0.16, 0, 7); ctx.fill();
  }
  // jump
  ring(L.jump.x, L.jump.y, L.jump.r, touch.jump ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.25)', 'rgba(255,255,255,0.5)');
  ctx.fillStyle = '#fff';
  const jr = L.jump.r * 0.42;
  ctx.beginPath(); ctx.moveTo(L.jump.x, L.jump.y - jr); ctx.lineTo(L.jump.x + jr, L.jump.y + jr * 0.5); ctx.lineTo(L.jump.x - jr, L.jump.y + jr * 0.5); ctx.fill();
  // drop / throw weapon
  const canDrop = myPos && myPos.armed;
  ctx.globalAlpha = canDrop ? 1 : 0.4;
  ring(L.drop.x, L.drop.y, L.drop.r, touch.drop ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.25)', 'rgba(255,255,255,0.5)');
  ctx.fillStyle = '#fff'; ctx.font = `800 ${Math.round(L.drop.r * 0.42)}px Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('DROP', L.drop.x, L.drop.y + 1);
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = 1;
  // portrait hint
  if (H > W) {
    ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '800 22px Arial, sans-serif';
    ctx.fillText('Hold your phone sideways', W / 2, H / 2);
  }
}

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
// drop dead entries without building a new array
function compact(arr) {
  let w = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i].life > 0) arr[w++] = arr[i];
  arr.length = w;
}

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

function handOf(id) {
  const p = livePlayers.find(r => r[0] === id);
  if (!p) return null;
  const lx = p[18] / 100, ly = p[19] / 100, la = p[20] / 100;
  return { x: lx + Math.sin(la) * HH[4], y: ly - Math.cos(la) * HH[4] };
}

function processEvents(rt) {
  while (pendingEvents.length && pendingEvents[0].t <= rt + 0.017) handleEvent(pendingEvents.shift().e, rt - pendingEvents.length * 0);
  if (pendingEvents.length > 600) pendingEvents.splice(0, pendingEvents.length - 600);
}

let lastPlayers = new Map();
let fireShift = null;
function handleEvent(e) {
  switch (e[0]) {
    case 'fire': {
      const [, id, w, ex, ey, a100] = e;
      const a = a100 / 100, type = WEAPONS[w];
      // start the flash at the barrel of the gun as it is drawn right now, not where the server
      // stood a few frames ago - otherwise the shot appears to come out behind the weapon
      const h = handOf(id);
      const x = h ? h.x + Math.cos(a) * BARREL[type] : ex;
      const y = h ? h.y + Math.sin(a) * BARREL[type] : ey;
      fireShift = { dx: x - ex, dy: y - ey, t: performance.now() };
      const big = type === 'shotgun' || type === 'sniper' || type === 'rpg';
      flashes.push({ x, y, a, life: 0.06, max: 0.06, size: big ? 1 : 0.6 });
      spawnParticles(x, y, big ? 8 : 3, { dir: a, spread: 0.5, speed: big ? 10 : 6, life: 0.12, size: 0.07, color: '#fff3c0', g: 0 });
      if (type !== 'rpg' && type !== 'grenade') {
        spawnParticles(x - Math.cos(a) * 0.5, y - Math.sin(a) * 0.5, 1, { dir: a + Math.PI / 2 * (Math.cos(a) > 0 ? 1 : -1) + Math.PI, spread: 0.6, speed: 4, life: 1.2, size: 0.08, color: '#b8913a', g: 1.2, kind: 'shell' });
      }
      kick(-Math.cos(a), Math.sin(a), KICK[type] * 0.02 * (id === myId ? 1.4 : 0.6));
      if (big) kickRot(type === 'sniper' ? 0.08 : 0.04);
      sfx(type, x);
      break;
    }
    case 'b': {
      const [, id, x, y, vx, vy, w, life] = e;
      const sh = fireShift && performance.now() - fireShift.t < 60 ? fireShift : null;
      bullets.set(id, { x: x + (sh ? sh.dx : 0), y: y + (sh ? sh.dy : 0), vx, vy, life, w: WEAPONS[w], trail: [] });
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
        sfx('hit', x);
      } else {
        spawnParticles(x, y, 5, { dir: dir + Math.PI, spread: 1.6, speed: 6, life: 0.2, size: 0.06, color: '#ffe9a8', g: 0.5 });
        spawnParticles(x, y, 3, { dir: dir + Math.PI, spread: 1.2, speed: 1.5, life: 0.6, size: 0.25, color: 'rgba(90,90,90,0.25)', g: -0.05, drag: 2, kind: 'puff' });
        sfx(victim === -2 ? 'woodhit' : victim === -3 ? 'metalhit' : 'ric', x);
      }
      break;
    }
    case 'punch': { const h = headPos.get(e[1]); sfx('whoosh', h && h.hx); break; }
    case 'ph': {
      const [, x, y, id, a100] = e;
      const a = a100 / 100;
      hitFlash.set(id, 0.1);
      rings.push({ x, y, r: 0.2, grow: 7, life: 0.18, max: 0.18, w: 0.12 });
      spawnParticles(x, y, 6, { dir: a, spread: 1, speed: 8, life: 0.2, size: 0.07, color: '#ffffff', g: 0 });
      kick(Math.cos(a), -Math.sin(a), 0.1);
      sfx('punchhit', x);
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
      sfx('boom', x);
      break;
    }
    case 'jump':
      spawnParticles(e[1], e[2], e[3] === 2 ? 8 : 4, { dir: Math.PI / 2, spread: e[3] === 2 ? 3.1 : 2.5, speed: e[3] === 2 ? 3 : 1.5, life: 0.35, size: 0.18, color: 'rgba(255,255,255,0.35)', g: 0, drag: 3, kind: 'puff' });
      if (e[3] === 2) rings.push({ x: e[1], y: e[2] + 0.1, r: 0.2, grow: 4.5, life: 0.25, max: 0.25, w: 0.1 });
      sfx(e[3] === 2 ? 'airjump' : e[3] ? 'walljump' : 'jump', e[1], null, 'jump' + Math.round(e[1]));
      break;
    case 'bounce': spawnParticles(e[1], e[2], 6, { dir: Math.PI / 2, spread: 2, speed: 5, life: 0.3, size: 0.1, color: '#ffffff', g: 0.5 }); sfx('bounce', e[1]); break;
    case 'thud': hitFlash.set(e[3], 0.08); spawnParticles(e[1], e[2], 6, { speed: 4, life: 0.4, size: 0.1, color: colorOf(e[3]) }); sfx('thud', e[1]); break;
    case 'pick': {
      // "tschk ... tschk" - the second one lands exactly when the gun can fire
      const [, id, w, rack] = e, type = WEAPONS[w], h = headPos.get(id), px = h && h.hx;
      sfx('rackA', px, type, 'rackA' + id);
      setTimeout(() => sfx('rackB', px, type, 'rackB' + id), rack * 1000 - 25);
      break;
    }
    case 'step': sfx('step', e[1], null, 'step' + Math.round(e[1] * 2)); break;
    case 'land':
      sfx('land', e[1], e[3], 'land' + Math.round(e[1]));
      spawnParticles(e[1], e[2], 3 + Math.round(e[3] * 6), { dir: Math.PI / 2, spread: 2.8, speed: 1 + e[3] * 3, life: 0.4, size: 0.2, color: 'rgba(40,40,40,0.22)', g: 0, drag: 3, kind: 'puff' });
      break;
    case 'thump': sfx('thump', e[1], e[3], 'thump' + Math.round(e[1])); break;
    case 'clunk': sfx('clunk', e[1], e[4] ? { stone: true } : e[3], 'clunk' + Math.round(e[1])); break;
    case 'clink': sfx('clink', e[1], e[3], 'clink' + Math.round(e[1])); break;
    case 'toss': sfx('toss', e[1]); break;
    case 'die': {
      const [, id, x, y] = e;
      spawnParticles(x, y, 18, { speed: 8, life: 0.8, size: 0.13, color: colorOf(id) });
      kick((Math.random() - 0.5), (Math.random() - 0.5), 0.35);
      sfx('die', x);
      break;
    }
    case 'hz':
      spawnParticles(e[2], e[3], 24, e[1] === 'lava'
        ? { dir: Math.PI / 2, spread: 1.5, speed: 7, life: 1.2, size: 0.5, color: 'rgba(60,60,60,0.5)', g: -0.3, drag: 2, kind: 'puff' }
        : { speed: 9, life: 0.4, size: 0.08, color: '#ffe38a', g: 0.8 });
      sfx(e[1] === 'lava' ? 'sizzle' : 'saw', e[2]);
      break;
    case 'crack': spawnParticles(e[1], e[2], 18, { speed: 6, life: 1, size: 0.18, color: '#4a3a2c', g: 1.2 }); kick(0, 1, 0.25); sfx('crack', e[1]); break;
    case 'add': if (map) { map.shapes.push(e[1]); map.shapeById.set(e[1].id, e[1]); if (e[1].k === 0) levelVersion++; } break;
    case 'rm': if (map) { if (map.shapes.some(s => s.id === e[1] && s.k === 0)) levelVersion++; map.shapes = map.shapes.filter(s => s.id !== e[1]); map.shapeById.delete(e[1]); } break;
    case 'cut': if (map) {
      map.ropes = map.ropes.filter(r => r[0] !== e[1]);
      spawnParticles(e[2], e[3], 8, { speed: 4, life: 0.5, size: 0.07, color: '#6b5a44', g: 1 });
      sfx('snap', e[2]);
    } break;
    case 'hp': hpShow.set(e[1], { hp: e[2], t: 1 }); break;
    case 'gone': goneIds.add(e[1]); for (const s of snaps) s.P.delete(e[1]); break;
    case 'spawn': {
      const [, id, x, y] = e;
      goneIds.delete(id);
      protect.set(id, 1.2);
      spawnParticles(x, y + 1, 14, { speed: 6, life: 0.5, size: 0.11, color: colorOf(id), g: 0.3 });
      rings.push({ x, y: y + 1, r: 0.3, grow: 7, life: 0.3, max: 0.3, w: 0.12 });
      sfx('spawn', x);
      break;
    }
    case 'slow': slowUntil = performance.now() + e[1] * 1000; break;
    case 'sudden': suddenT = 2.5; sfx('sudden'); kick(0, 1, 0.3); break;
    case 'chat':
      chatBubbles.set(e[1], { text: e[2], t: 5 });
      chatLog(e[1], e[2]);
      sfx('chat');
      break;
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

function makeLayer(draw, pad = 100, reuse = null) {
  const w = Math.ceil((W + pad * 2) * dpr), h = Math.ceil((H + pad * 2) * dpr);
  // reuse the canvas when the size fits: re-rendering the level must not allocate a new buffer
  const c = reuse && reuse.width === w && reuse.height === h ? reuse : document.createElement('canvas');
  if (c === reuse) c.getContext('2d').setTransform(1, 0, 0, 1, 0, 0), c.getContext('2d').clearRect(0, 0, w, h);
  else { c.width = w; c.height = h; }
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
    layers.level = makeLayer(() => { drawBlockSides(statics); drawBlockFronts(statics, 0); }, 100, layers.level);
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

// block sides are batched per colour (one fill per shade instead of four per block)
const sideBatches = new Map();
function drawBlockSides(list) {
  const vx = W / 2, vy = H * 0.45, depth = 0.045, S = cam.s;
  sideBatches.clear();
  const fx = new Float64Array(4), fy = new Float64Array(4);
  for (const { s, x, y, a } of list) {
    if (s.s !== 'b' || s.hz === 'lava') continue;
    const c = Math.cos(a), sn = Math.sin(a), hw = s.w / 2, hh = s.h / 2;
    const cx = sx(x), cy = sy(y);
    // corners in screen space: (-hw,-hh) (hw,-hh) (hw,hh) (-hw,hh)
    fx[0] = cx + (-hw * c + hh * sn) * S; fy[0] = cy - (-hw * sn - hh * c) * S;
    fx[1] = cx + (hw * c + hh * sn) * S;  fy[1] = cy - (hw * sn - hh * c) * S;
    fx[2] = cx + (hw * c - hh * sn) * S;  fy[2] = cy - (hw * sn + hh * c) * S;
    fx[3] = cx + (-hw * c - hh * sn) * S; fy[3] = cy - (-hw * sn + hh * c) * S;
    const base = s.c || (s.cr ? '#3a3029' : '#26272a');
    let b = sideBatches.get(base);
    if (!b) { b = [[], [], []]; sideBatches.set(base, b); }
    for (let i = 0; i < 4; i++) {
      const k = (i + 1) % 4;
      const bucket = b[i === 2 ? 2 : i === 0 ? 0 : 1];
      bucket.push(fx[i], fy[i], fx[k], fy[k], fx[k] + (vx - fx[k]) * depth, fy[k] + (vy - fy[k]) * depth, fx[i] + (vx - fx[i]) * depth, fy[i] + (vy - fy[i]) * depth);
    }
  }
  const shades = [-8, 18, 38];
  for (const [base, buckets] of sideBatches) {
    for (let k = 0; k < 3; k++) {
      const q = buckets[k];
      if (!q.length) continue;
      ctx.fillStyle = shadeC(base, shades[k]);
      ctx.beginPath();
      for (let i = 0; i < q.length; i += 8) {
        ctx.moveTo(q[i], q[i + 1]); ctx.lineTo(q[i + 2], q[i + 3]); ctx.lineTo(q[i + 4], q[i + 5]); ctx.lineTo(q[i + 6], q[i + 7]); ctx.closePath();
      }
      ctx.fill();
    }
  }
}

// crate faces (fill + inset frame + diagonal) are pre-rendered once per size/colour/zoom
const crateSprites = new Map();
function crateSprite(s) {
  const base = s.c || '#3a3029';
  const key = `${s.w}|${s.h}|${base}|${cam.s.toFixed(2)}|${dpr}`;
  let spr = crateSprites.get(key);
  if (spr) return spr;
  const w = s.w * cam.s, h = s.h * cam.s, pad = 2;
  const c = document.createElement('canvas');
  c.width = Math.ceil((w + pad * 2) * dpr); c.height = Math.ceil((h + pad * 2) * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, (pad + w / 2) * dpr, (pad + h / 2) * dpr);
  g.fillStyle = base;
  g.fillRect(-w / 2, -h / 2, w, h);
  g.strokeStyle = shadeC(base, 22);
  g.lineWidth = Math.max(1, 0.07 * cam.s);
  g.beginPath();
  g.rect(-w * 0.4, -h * 0.4, w * 0.8, h * 0.8);
  g.moveTo(-w * 0.4, h * 0.4); g.lineTo(w * 0.4, -h * 0.4);
  g.stroke();
  spr = { c, w: w + pad * 2, h: h + pad * 2 };
  if (crateSprites.size > 200) crateSprites.clear();
  crateSprites.set(key, spr);
  return spr;
}

function drawBlockFronts(list, time) {
  for (const { s, x, y, a } of list) {
    if (s.hz === 'lava') continue;
    if (s.s === 'c') { drawCircleProp(s, x, y, a, time); continue; }
    if (s.cr) {
      const spr = crateSprite(s);
      const px = sx(x), py = sy(y);
      if (a === 0) ctx.drawImage(spr.c, px - spr.w / 2, py - spr.h / 2, spr.w, spr.h);
      else { ctx.save(); ctx.translate(px, py); ctx.rotate(-a); ctx.drawImage(spr.c, -spr.w / 2, -spr.h / 2, spr.w, spr.h); ctx.restore(); }
      continue;
    }
    const front = rectCorners(s, x, y, a);
    const base = s.c || '#26272a';
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.moveTo(front[0][0], front[0][1]); ctx.lineTo(front[1][0], front[1][1]); ctx.lineTo(front[2][0], front[2][1]); ctx.lineTo(front[3][0], front[3][1]);
    ctx.fill();
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
  // every weapon gets its own silhouette and materials so you can tell them apart at a glance
  const g = (x, y, w, h) => ctx.fillRect(x * S, -(y + h) * S, w * S, h * S);
  const poly = (...pts) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i] * S, -pts[i + 1] * S);
    ctx.closePath(); ctx.fill();
  };
  const STEEL = '#1b1d20', DARK = '#0e0f10', WOOD = '#6a4726', GREY = '#3c4046';
  switch (type) {
    case 'pistol':
      ctx.fillStyle = STEEL; g(-0.08, -0.03, 0.46, 0.14);          // slide
      ctx.fillStyle = DARK; g(0.3, -0.015, 0.1, 0.05);             // muzzle
      ctx.fillStyle = '#2a2d31'; poly(-0.05, -0.03, 0.08, -0.03, 0.03, -0.24, -0.11, -0.24);  // grip
      ctx.fillStyle = DARK; g(-0.02, -0.1, 0.06, 0.07);            // trigger guard block
      break;
    case 'ar':
      ctx.fillStyle = STEEL; g(-0.3, -0.05, 1.0, 0.13);            // receiver + barrel
      ctx.fillStyle = DARK; g(0.62, -0.035, 0.18, 0.1);            // flash hider
      ctx.fillStyle = '#25282c'; g(-0.52, -0.09, 0.25, 0.19);      // stock
      ctx.fillStyle = '#25282c'; poly(0.0, -0.05, 0.16, -0.05, 0.22, -0.34, 0.06, -0.34);     // curved mag
      ctx.fillStyle = '#2a2d31'; poly(-0.16, -0.05, -0.04, -0.05, -0.09, -0.26, -0.22, -0.26); // grip
      ctx.fillStyle = DARK; g(0.16, 0.08, 0.3, 0.05); g(0.02, 0.08, 0.06, 0.07);              // rail + sight
      break;
    case 'shotgun':
      ctx.fillStyle = STEEL; g(-0.25, -0.02, 1.05, 0.12);          // barrel
      ctx.fillStyle = WOOD; g(0.2, -0.14, 0.34, 0.12);             // pump
      ctx.fillStyle = WOOD; poly(-0.25, 0.1, -0.25, -0.14, -0.6, -0.3, -0.6, -0.06);          // stock
      ctx.fillStyle = DARK; g(0.74, -0.01, 0.1, 0.1);
      break;
    case 'sniper':
      ctx.fillStyle = STEEL; g(-0.4, -0.03, 1.55, 0.09);           // long thin barrel
      ctx.fillStyle = DARK; g(1.05, -0.05, 0.14, 0.13);            // muzzle brake
      ctx.fillStyle = WOOD; poly(-0.4, 0.06, -0.4, -0.14, -0.72, -0.28, -0.72, -0.04);       // stock
      ctx.fillStyle = WOOD; g(-0.15, -0.16, 0.42, 0.13);           // fore grip
      ctx.fillStyle = GREY; g(-0.02, 0.06, 0.44, 0.1);             // scope tube
      ctx.fillStyle = DARK; g(-0.06, 0.04, 0.08, 0.14); g(0.38, 0.04, 0.08, 0.14);            // scope lenses
      ctx.fillStyle = GREY; g(0.05, 0.02, 0.05, 0.05); g(0.3, 0.02, 0.05, 0.05);              // mounts
      ctx.fillStyle = DARK; poly(0.48, -0.03, 0.56, -0.03, 0.68, -0.3, 0.62, -0.3);           // bipod
      ctx.fillStyle = DARK; poly(0.48, -0.03, 0.56, -0.03, 0.42, -0.3, 0.36, -0.3);
      break;
    case 'rpg':
      ctx.fillStyle = '#3f4a35'; g(-0.55, -0.11, 1.25, 0.22);      // tube
      ctx.fillStyle = DARK; g(-0.62, -0.16, 0.12, 0.32);           // back blast cone
      ctx.fillStyle = '#b8443a'; poly(0.7, 0.13, 1.06, 0.0, 0.7, -0.13);                      // warhead
      ctx.fillStyle = '#2a2d31'; poly(-0.06, -0.11, 0.08, -0.11, 0.03, -0.34, -0.11, -0.34);  // grip
      ctx.fillStyle = GREY; g(0.05, 0.11, 0.3, 0.06); g(0.3, 0.17, 0.05, 0.09);               // sight
      break;
    case 'minigun':
      ctx.fillStyle = GREY; g(-0.42, -0.17, 0.5, 0.36);            // housing
      ctx.fillStyle = STEEL;
      g(0.06, 0.05, 0.95, 0.06); g(0.06, -0.03, 0.95, 0.06); g(0.06, -0.11, 0.95, 0.06);      // barrel cluster
      ctx.fillStyle = DARK; g(0.98, -0.13, 0.07, 0.26);
      ctx.fillStyle = '#4a4034'; g(-0.36, -0.42, 0.36, 0.26);      // ammo drum
      ctx.fillStyle = '#2a2d31'; g(-0.05, -0.36, 0.11, 0.2);       // grip
      break;
    case 'grenade':
      ctx.fillStyle = '#41502f'; ctx.beginPath(); ctx.arc(0.06 * S, 0, 0.16 * S, 0, 7); ctx.fill();
      ctx.fillStyle = DARK; g(0.0, 0.12, 0.12, 0.07);              // fuse
      ctx.fillStyle = '#8a8a8a'; g(-0.08, 0.06, 0.2, 0.04);        // lever
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = Math.max(1, 0.03 * S);
      ctx.beginPath(); ctx.arc(0.06 * S, 0, 0.16 * S, 0.6, 2.2); ctx.stroke();
      break;
  }
}

const gunSprites = new Map();
function gunSprite(type) {
  const key = `${type}|${cam.s.toFixed(2)}|${dpr}`;
  let spr = gunSprites.get(key);
  if (spr) return spr;
  const S = cam.s, ox = 0.7 * S + 14, oy = 0.6 * S + 14, w = 2.0 * S + 28, h = 1.2 * S + 28;
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

// distance from a point along a direction to the first piece of level geometry (for the laser sight)
function rayLevel(ox, oy, dx, dy, maxLen) {
  let best = maxLen;
  for (const sh of map.shapes) {
    let x = sh.x, y = sh.y, a = sh.a;
    if (sh.k !== 0) { const o = frameById.get(sh.id); if (o) { x = o.x; y = o.y; a = o.a; } }
    const ca = Math.cos(a), sa = Math.sin(a);
    const rx = ox - x, ry = oy - y;
    const px = rx * ca + ry * sa, py = -rx * sa + ry * ca;
    const vx = dx * ca + dy * sa, vy = -dx * sa + dy * ca;
    let t;
    if (sh.s === 'c') {
      const b = px * vx + py * vy, c = px * px + py * py - sh.r * sh.r;
      const disc = b * b - c;
      if (disc < 0) continue;
      t = -b - Math.sqrt(disc);
    } else {
      const hw = sh.w / 2, hh = sh.h / 2;
      let t0 = 0, t1 = best, miss = false;
      if (Math.abs(vx) < 1e-6) { if (Math.abs(px) > hw) miss = true; }
      else { const a1 = (-hw - px) / vx, a2 = (hw - px) / vx; t0 = Math.max(t0, Math.min(a1, a2)); t1 = Math.min(t1, Math.max(a1, a2)); }
      if (Math.abs(vy) < 1e-6) { if (Math.abs(py) > hh) miss = true; }
      else { const a1 = (-hh - py) / vy, a2 = (hh - py) / vy; t0 = Math.max(t0, Math.min(a1, a2)); t1 = Math.min(t1, Math.max(a1, a2)); }
      if (miss || t1 < t0) continue;
      t = t0;
    }
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

// the sniper paints its line of fire red before the shot - everyone can see it
function drawLaser(p) {
  const lx = p[18] / 100, ly = p[19] / 100, la = p[20] / 100;
  const hx = lx + Math.sin(la) * HH[4], hy = ly - Math.cos(la) * HH[4];
  let aim = p[2] / 100;
  if (p[0] === myId) { const m = aimPoint(); aim = Math.atan2(m.y - (p[10] / 100 + 0.15), m.x - p[9] / 100); }
  const dx = Math.cos(aim), dy = Math.sin(aim);
  const x0 = hx + dx * BARREL.sniper, y0 = hy + dy * BARREL.sniper;
  const len = rayLevel(x0, y0, dx, dy, 70);
  const x1 = x0 + dx * len, y1 = y0 + dy * len;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,40,30,0.25)'; ctx.lineWidth = Math.max(3, 0.14 * cam.s);
  ctx.beginPath(); ctx.moveTo(sx(x0), sy(y0)); ctx.lineTo(sx(x1), sy(y1)); ctx.stroke();
  ctx.strokeStyle = 'rgba(230,25,20,0.9)'; ctx.lineWidth = Math.max(1.5, 0.045 * cam.s);
  ctx.beginPath(); ctx.moveTo(sx(x0), sy(y0)); ctx.lineTo(sx(x1), sy(y1)); ctx.stroke();
  ctx.fillStyle = 'rgba(255,60,45,0.95)';
  ctx.beginPath(); ctx.arc(sx(x1), sy(y1), Math.max(2.5, 0.11 * cam.s), 0, 7); ctx.fill();
  ctx.restore();
}

// where a thrown grenade would land: the same launch velocity the server uses, stopped at the
// first wall it would hit
function drawArc(p) {
  const lx = p[18] / 100, ly = p[19] / 100, la = p[20] / 100;
  const hx = lx + Math.sin(la) * HH[4], hy = ly - Math.cos(la) * HH[4];
  let aim = p[2] / 100;
  if (p[0] === myId) { const m = aimPoint(); aim = Math.atan2(m.y - (p[10] / 100 + 0.15), m.x - p[9] / 100); }
  let x = hx + Math.cos(aim) * BARREL.grenade, y = hy + Math.sin(aim) * BARREL.grenade;
  let vx = Math.cos(aim) * 15, vy = Math.sin(aim) * 15 + 2;
  const g = (map.g || -28), step = 1 / 16;
  const mine = p[0] === myId;
  ctx.save();
  for (let i = 0; i < 22; i++) {
    const nx = x + vx * step, ny = y + vy * step + 0.5 * g * step * step;
    const len = Math.hypot(nx - x, ny - y);
    const hit = rayLevel(x, y, (nx - x) / len, (ny - y) / len, len);
    const done = hit < len - 0.01;
    const ex = done ? x + (nx - x) * (hit / len) : nx, ey = done ? y + (ny - y) * (hit / len) : ny;
    const al = (mine ? 0.75 : 0.4) * (1 - i / 24);
    ctx.fillStyle = `rgba(255,255,255,${al})`;
    ctx.beginPath(); ctx.arc(sx(ex), sy(ey), Math.max(1.5, 0.05 * cam.s), 0, 7); ctx.fill();
    if (done) {
      ctx.strokeStyle = `rgba(255,120,60,${mine ? 0.9 : 0.5})`; ctx.lineWidth = Math.max(1.5, 0.04 * cam.s);
      ctx.beginPath(); ctx.arc(sx(ex), sy(ey), 0.45 * cam.s, 0, 7); ctx.stroke();
      break;
    }
    vy += g * step;
    x = nx; y = ny;
  }
  ctx.restore();
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
      const m = aimPoint();
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
const frameList = [], frameById = new Map();

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
  const edt = nowMs < slowUntil ? dt * 0.3 : dt;   // effects follow the server's slow motion
  const smp = sample();
  if (smp) processEvents(smp.rt);
  const A = smp && smp.a, B = smp && smp.b, k = smp ? smp.k : 0;

  // interpolate players
  const players = [];
  if (A) for (const pb of B.P.values()) {
    const pa = A.P.get(pb[0]);
    if (!pa) { players.push(pb.slice()); continue; }   // copy: prediction may shift the row
    const out = pb.slice();
    out[2] = lerpA(pa[2] / 100, pb[2] / 100, k) * 100;
    for (let i = 0; i < 11; i++) {
      const o = 6 + i * 3;
      out[o] = lerp(pa[o], pb[o], k); out[o + 1] = lerp(pa[o + 1], pb[o + 1], k);
      out[o + 2] = lerpA(pa[o + 2] / 100, pb[o + 2] / 100, k) * 100;
    }
    players.push(out);
  }
  predictLocal(players, dt);
  updateCam(dt);
  livePlayers = players;
  dbg.rtt = rtt; dbg.interp = INTERP;
  const meRow = players.find(p => p[0] === myId);
  myPos = meRow ? { x: meRow[9] / 100, y: meRow[10] / 100 + 0.15, alive: meRow[1], armed: meRow[3] >= 0, ammo: meRow[4] } : null;
  dbg.pos = myPos;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(W / 2, H / 2);
  ctx.rotate(cam.rot * 0.2);
  ctx.translate(-W / 2 + cam.ox * cam.s, -H / 2 + cam.oy * cam.s);

  drawBackground(time);

  // props (arrays reused every frame so the render loop allocates almost nothing)
  const list = frameList; list.length = 0;
  const byId = frameById; byId.clear();
  for (const s of map.shapes) {
    if (s.k === 0) continue;
    let x = s.x, y = s.y, a = s.a;
    if (s.k !== 0 && A) {
      const oa = A.O.get(s.id), ob = B.O.get(s.id) || oa;
      const pa = oa || ob, pb = ob || oa;
      if (pa) { x = lerp(pa[1], pb[1], k) / 100; y = lerp(pa[2], pb[2], k) / 100; a = lerpA(pa[3] / 100, pb[3] / 100, k); }
    }
    list.push({ s, x, y, a });
    byId.set(s.id, list[list.length - 1]);
  }
  ctx.strokeStyle = '#1e1e1e'; ctx.lineWidth = Math.max(1.5, 0.06 * cam.s);
  for (const [, ax, ay, id, lx, ly] of map.ropes) {
    const p = byId.get(id);
    if (!p) continue;
    const c = Math.cos(p.a), s = Math.sin(p.a);
    ctx.beginPath(); ctx.moveTo(sx(ax), sy(ay)); ctx.lineTo(sx(p.x + lx * c - ly * s), sy(p.y + lx * s + ly * c)); ctx.stroke();
  }
  ensureLayers();
  blitLayer(layers.level);
  drawBlockSides(list);
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
    for (const p of players) if (p[1]) { if (p[3] === 3) drawLaser(p); else if (p[3] === 6) drawArc(p); }
    for (const p of players) headPos.set(p[0], drawPlayer(p, time, dt));
    // freshly joined players are briefly protected - show it
    for (const p of players) {
      const pr = protect.get(p[0]);
      if (!pr) continue;
      protect.set(p[0], pr - dt);
      if (pr - dt <= 0 || !p[1]) { protect.delete(p[0]); continue; }
      ctx.globalAlpha = Math.min(0.5, pr * 0.5);
      ctx.strokeStyle = colorOf(p[0]); ctx.lineWidth = Math.max(1.5, 0.05 * cam.s);
      ctx.beginPath(); ctx.arc(sx(p[9] / 100), sy(p[10] / 100 - 0.1), 1.05 * cam.s, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const p of players) {
      const h = hpShow.get(p[0]);
      if (!h) continue;
      h.t -= dt;
      if (h.t <= 0 || !p[1]) { hpShow.delete(p[0]); continue; }
      const hp = headPos.get(p[0]);
      const al = Math.min(1, h.t / 0.3) * 0.85;
      const bw = 0.9 * cam.s, bh = Math.max(2, 0.07 * cam.s);
      const x = sx(hp.hx) - bw / 2, y = sy(hp.hy + 0.55);
      ctx.globalAlpha = al;
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(x - 1, y - 1, bw + 2, bh + 2);
      ctx.fillStyle = h.hp > 35 ? '#f2f2f2' : '#ff6b5e';
      ctx.fillRect(x, y, bw * Math.max(0, h.hp) / 100, bh);
      ctx.globalAlpha = 1;
    }
  }

  for (const o of list) if (o.s.hz === 'lava') drawLava(o.s, o.x, o.y, time);

  // bullets (simulated locally from spawn events)
  ctx.globalCompositeOperation = 'lighter';
  for (const [id, b] of bullets) {
    b.x += b.vx * edt; b.y += b.vy * edt; b.life -= edt;
    if (b.life <= 0) { bullets.delete(id); continue; }
    const len = b.w === 'sniper' ? 0.06 : 0.035;
    ctx.strokeStyle = b.w === 'sniper' ? 'rgba(255,255,240,0.95)' : 'rgba(255,240,190,0.9)';
    ctx.lineWidth = Math.max(1.5, (b.w === 'sniper' ? 0.1 : 0.07) * cam.s);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx(b.x - b.vx * len), sy(b.y - b.vy * len)); ctx.lineTo(sx(b.x), sy(b.y)); ctx.stroke();
  }
  for (const f of flashes) {
    f.life -= edt;
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
  compact(flashes);
  ctx.globalCompositeOperation = 'source-over';

  for (const r of rings) {
    r.life -= edt; r.r += r.grow * edt;
    ctx.strokeStyle = `rgba(255,255,255,${Math.max(0, r.life / r.max) * 0.8})`;
    ctx.lineWidth = r.w * cam.s * Math.max(0.1, r.life / r.max);
    ctx.beginPath(); ctx.arc(sx(r.x), sy(r.y), r.r * cam.s, 0, 7); ctx.stroke();
  }
  compact(rings);

  for (const p of particles) {
    p.life -= edt;
    p.vy -= 22 * p.g * edt;
    if (p.drag) { p.vx *= Math.max(0, 1 - p.drag * edt); p.vy *= Math.max(0, 1 - p.drag * edt); }
    p.x += p.vx * edt; p.y += p.vy * edt; p.rot += p.vr * edt;
    const al = Math.max(0, Math.min(1, p.life / p.max * 2));
    ctx.globalAlpha = al;
    ctx.fillStyle = p.color;
    const s = p.size * cam.s;
    if (p.kind === 'puff') { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), s * (1.6 - al * 0.6), 0, 7); ctx.fill(); }
    else if (p.kind === 'shell') { ctx.save(); ctx.translate(sx(p.x), sy(p.y)); ctx.rotate(p.rot); ctx.fillRect(-s, -s / 2.5, s * 2, s / 1.25); ctx.restore(); }
    else ctx.fillRect(sx(p.x) - s / 2, sy(p.y) - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  compact(particles);
  if (particles.length > 1200) particles.splice(0, particles.length - 1200);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // vignette
  ctx.drawImage(layers.vignette, 0, 0, W, H);

  // chat bubbles
  if (chatBubbles.size) {
    ctx.font = '700 13px Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [id, b] of chatBubbles) {
      b.t -= dt;
      const h = headPos.get(id);
      if (b.t <= 0 || !h) { if (b.t <= 0) chatBubbles.delete(id); continue; }
      // wrap into lines of at most ~200px
      if (!b.lines) {
        b.lines = [];
        let line = '';
        for (const word of b.text.split(' ')) {
          const test = line ? line + ' ' + word : word;
          if (ctx.measureText(test).width > 200 && line) { b.lines.push(line); line = word; } else line = test;
        }
        if (line) b.lines.push(line);
        b.w = Math.min(220, Math.max(...b.lines.map(l => ctx.measureText(l).width))) + 16;
      }
      const lh = 16, bh = b.lines.length * lh + 10;
      const x = sx(h.hx) + cam.ox * cam.s, bottom = sy(h.hy + 0.75) + cam.oy * cam.s;
      const top = bottom - bh;
      ctx.globalAlpha = Math.min(1, b.t / 0.4);
      ctx.fillStyle = 'rgba(250,250,250,0.95)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - b.w / 2, top, b.w, bh, 7); else ctx.rect(x - b.w / 2, top, b.w, bh);
      ctx.moveTo(x - 6, bottom); ctx.lineTo(x, bottom + 7); ctx.lineTo(x + 6, bottom);
      ctx.fill();
      ctx.fillStyle = '#151515';
      b.lines.forEach((l, i) => ctx.fillText(l, x, top + 5 + lh / 2 + i * lh));
      ctx.globalAlpha = 1;
    }
    ctx.textBaseline = 'alphabetic';
  }

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

  // sudden death notice
  if (suddenT > 0) {
    suddenT -= dt;
    ctx.globalAlpha = Math.min(1, suddenT * 2, (2.5 - suddenT) * 6);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fs = Math.min(46, W / 16);
    ctx.font = `900 ${fs}px "Arial Black", Arial, sans-serif`;
    ctx.fillStyle = 'rgba(10,10,10,0.7)'; ctx.fillRect(0, H * 0.18 - fs * 0.8, W, fs * 1.6);
    ctx.fillStyle = '#ff6b5e'; ctx.fillText('SUDDEN DEATH', W / 2, H * 0.18);
    ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;
  }

  // round winner
  if (banner) {
    banner.t += dt;
    const inT = Math.min(1, banner.t * 5), out = banner.t > 3.1 ? Math.max(0, 1 - (banner.t - 3.1) * 5) : 1;
    ctx.globalAlpha = out;
    const bandH = Math.min(150, H * 0.2) * (1 - Math.pow(1 - inT, 3));
    ctx.fillStyle = 'rgba(10,10,10,0.8)';
    ctx.fillRect(0, H / 2 - bandH / 2, W, bandH);
    if (inT > 0.5) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const fs = Math.min(64, W / 14);
      ctx.font = `900 ${fs}px "Arial Black", Arial, sans-serif`;
      ctx.fillStyle = banner.color;
      ctx.fillText(banner.draw ? 'DRAW' : banner.name.toUpperCase(), W / 2, H / 2 - (banner.draw ? 0 : fs * 0.2));
      if (!banner.draw) {
        ctx.font = `700 ${fs * 0.28}px Arial, sans-serif`;
        ctx.fillStyle = '#bbb';
        ctx.fillText('W I N S', W / 2, H / 2 + fs * 0.5);
      }
      ctx.textBaseline = 'alphabetic';
    }
    ctx.globalAlpha = 1;
    if (banner.t > 3.5) banner = null;
  }

  if (fade > 0) {
    fade = Math.max(0, fade - dt * 2.5);
    ctx.fillStyle = `rgba(0,0,0,${fade})`;
    ctx.fillRect(0, 0, W, H);
  }

  if (myId && touchMode) { drawTouchUI(); return; }
  // crosshair + ammo
  if (myId) {
    const me = players.find(p => p[0] === myId);
    const cross = () => {
      ctx.beginPath(); ctx.arc(mouseX, mouseY, 11, 0, 7);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(mouseX + dx * 6, mouseY + dy * 6); ctx.lineTo(mouseX + dx * 17, mouseY + dy * 17);
      }
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    ctx.lineWidth = 5.5; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; cross();
    ctx.lineWidth = 2.5; ctx.strokeStyle = '#ffffff'; cross();
    ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.beginPath(); ctx.arc(mouseX, mouseY, 3, 0, 7); ctx.fill();
    ctx.fillStyle = colorOf(myId); ctx.beginPath(); ctx.arc(mouseX, mouseY, 2, 0, 7); ctx.fill();
    if (me && me[1] && me[3] >= 0) {
      ctx.font = '800 13px Arial, sans-serif'; ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillText(me[4], mouseX + 17, mouseY + 23);
      ctx.fillStyle = '#fff'; ctx.fillText(me[4], mouseX + 16, mouseY + 22);
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
let sndPan = 0, sndDelay = 0;   // stereo position and start offset for the sound being built
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
function out() {
  if (!AC.createStereoPanner || !sndPan) return master;
  const p = AC.createStereoPanner();
  p.pan.value = sndPan;
  p.connect(master);
  return p;
}
function noise(dur, freq, q, vol, type = 'lowpass', sweep, attack = 0.002) {
  const t = AC.currentTime + sndDelay;
  const src = AC.createBufferSource(); src.buffer = noiseBuf;
  const f = AC.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
  const g = AC.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(out());
  src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.05);
}
function thump(f0, f1, dur, vol, type = 'sine') {
  const t = AC.currentTime + sndDelay;
  const o = AC.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = AC.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(out()); o.start(t); o.stop(t + dur + 0.05);
}
// tiny metallic click: very short resonant noise
const click = (freq, vol, dur = 0.018) => noise(dur, freq, 8, vol, 'bandpass', null, 0.001);
// hollow knock: resonant body + short noise
const knock = (freq, vol) => { thump(freq, freq * 0.6, 0.09, vol); noise(0.06, freq * 3, 2.5, vol * 0.6, 'bandpass'); };

// per weapon "tschk" pairs: part 0 on pickup, part 1 exactly when the gun is ready
const RACK = {
  pistol:  [() => { noise(0.05, 2200, 4, 0.35, 'bandpass', 1600); click(5200, 0.3); },
            () => { noise(0.04, 3000, 4, 0.4, 'bandpass', 2400); click(6400, 0.45); }],
  ar:      [() => { click(3400, 0.45, 0.03); thump(220, 120, 0.05, 0.25); noise(0.04, 1800, 3, 0.2, 'bandpass'); },
            () => { noise(0.07, 2500, 3, 0.45, 'bandpass', 1500); click(6000, 0.5); }],
  shotgun: [() => { noise(0.09, 1100, 3, 0.55, 'bandpass', 700); thump(150, 90, 0.07, 0.35); },
            () => { noise(0.06, 1800, 3, 0.55, 'bandpass', 2600); click(4200, 0.55, 0.025); thump(180, 110, 0.05, 0.3); }],
  sniper:  [() => { click(4200, 0.35); noise(0.1, 1500, 5, 0.4, 'bandpass', 1000); },
            () => { noise(0.08, 2300, 5, 0.45, 'bandpass', 3000); click(5200, 0.55, 0.025); }],
  rpg:     [() => { thump(130, 70, 0.14, 0.5); noise(0.1, 600, 2, 0.35, 'bandpass'); },
            () => { click(3000, 0.5, 0.03); thump(260, 160, 0.05, 0.25); }],
  minigun: [() => { thump(60, 320, 0.35, 0.12, 'sawtooth'); noise(0.35, 900, 2, 0.12, 'bandpass', 2400, 0.05); },
            () => { click(3600, 0.45, 0.03); thump(320, 280, 0.08, 0.08, 'sawtooth'); }],
  grenade: [() => { click(5200, 0.35); thump(2100, 1900, 0.05, 0.08, 'triangle'); },
            () => { thump(3200, 2600, 0.12, 0.1, 'triangle'); click(6000, 0.3); }],
};

const sfxLast = {};
let sfxWindow = 0, sfxCount = 0;
// x: world x for stereo panning, arg: sound specific (intensity, weapon...), key: throttle key
function sfx(name, x, arg, key = name) {
  if (!AC || muted) return;
  const now = performance.now();
  if (now - (sfxLast[key] || 0) < 25) return;
  // a hard cap on how many voices may start at once - big pile-ups used to hitch the frame
  if (now - sfxWindow > 120) { sfxWindow = now; sfxCount = 0; }
  if (++sfxCount > 14) return;
  sfxLast[key] = now;
  sndPan = map && x != null ? Math.max(-0.7, Math.min(0.7, (x / map.W - 0.5) * 1.4)) : 0;
  sndDelay = 0;
  const R = () => 0.85 + Math.random() * 0.3;
  const k = arg == null ? 1 : arg;
  switch (name) {
    // guns
    case 'pistol': noise(0.18, 2200 * R(), 0.7, 0.7, 'lowpass', 300); thump(160, 50, 0.1, 0.5); click(4200, 0.15); break;
    case 'ar': noise(0.12, 2600 * R(), 0.7, 0.5, 'lowpass', 400); thump(140, 50, 0.07, 0.35); break;
    case 'minigun': noise(0.07, 3000 * R(), 0.7, 0.35, 'lowpass', 600); break;
    case 'shotgun': noise(0.45, 1600, 0.6, 1, 'lowpass', 120); thump(110, 35, 0.25, 0.9); break;
    case 'sniper': noise(0.7, 4000, 0.5, 1, 'lowpass', 150); thump(180, 30, 0.35, 0.9); sndDelay = 0.25; noise(0.5, 900, 0.5, 0.25, 'lowpass', 120, 0.05); break;
    case 'rpg': noise(0.5, 700, 0.8, 0.6, 'lowpass', 2200, 0.03); thump(90, 40, 0.2, 0.5); break;
    case 'grenade': noise(0.12, 900, 1, 0.25, 'bandpass', 300); break;
    case 'rackA': RACK[k][0](); break;
    case 'rackB': RACK[k][1](); break;
    case 'boom': noise(1.4, 1200, 0.6, 1.3, 'lowpass', 40); thump(80, 22, 0.9, 1.1); sndDelay = 0.12; noise(1.2, 500, 0.5, 0.35, 'lowpass', 60, 0.1); break;
    // bodies
    case 'whoosh': noise(0.13, 500, 2, 0.22, 'bandpass', 1800, 0.03); break;
    case 'punchhit': noise(0.12, 900, 0.8, 0.9, 'lowpass', 150); thump(120 * R(), 40, 0.15, 0.9); break;
    case 'hit': noise(0.1, 1400 * R(), 1, 0.6, 'lowpass', 200); thump(100 * R(), 45, 0.1, 0.6); break;
    case 'thud': thump(90, 35, 0.2, 0.7); noise(0.12, 500, 1, 0.4); break;
    case 'die': thump(140, 30, 0.35, 0.9); noise(0.3, 700, 0.7, 0.5, 'lowpass', 80); break;
    case 'step': noise(0.05, 380 * R(), 1, 0.13, 'lowpass', 150); click(1800 * R(), 0.03, 0.012); break;
    case 'land': thump(95 * R(), 38, 0.16, 0.18 + 0.4 * k); noise(0.1, 450, 1, 0.12 + 0.3 * k, 'lowpass', 120); break;
    case 'thump': thump(130 * R(), 45, 0.12, 0.15 + 0.45 * k); noise(0.07, 800 * R(), 1, 0.1 + 0.3 * k, 'lowpass', 200); break;
    case 'jump': noise(0.1, 700, 1.5, 0.1, 'bandpass', 1400, 0.02); break;
    case 'walljump': noise(0.12, 1800, 1, 0.16, 'bandpass', 700); knock(160, 0.2); break;
    case 'airjump': noise(0.14, 900, 1.5, 0.14, 'bandpass', 2600, 0.02); thump(320, 720, 0.12, 0.12, 'triangle'); break;
    case 'toss': noise(0.18, 400, 2, 0.25, 'bandpass', 1600, 0.04); break;
    // world
    case 'ric': noise(0.07, 3800 * R(), 6, 0.18, 'bandpass', 1800); if (Math.random() < 0.35) { sndDelay = 0.01; thump(2600 * R(), 900, 0.18, 0.05, 'triangle'); } break;
    case 'woodhit': knock(240 * R(), 0.35); noise(0.05, 1800, 2, 0.15, 'bandpass'); break;
    case 'metalhit': thump(2400 * R(), 2200, 0.2, 0.18, 'triangle'); click(5200, 0.4, 0.03); break;
    case 'clunk': if (arg && arg.stone) { thump(80 * R(), 40, 0.14, 0.2 + 0.4 * k); noise(0.09, 1200, 1, 0.1 + 0.25 * k, 'lowpass'); } else knock((170 + Math.random() * 90), 0.12 + 0.4 * k); break;
    case 'clink': thump(2800 * R(), 2500, 0.1, 0.05 + 0.12 * k, 'triangle'); sndDelay = 0.03; thump(4100 * R(), 3900, 0.07, 0.03 + 0.08 * k, 'triangle'); break;
    case 'sizzle': noise(1, 5000, 0.5, 0.5, 'highpass', 1500, 0.05); break;
    case 'saw': noise(0.4, 3500, 6, 0.5, 'bandpass', 1500); break;
    case 'crack': noise(0.5, 600, 0.8, 1, 'lowpass', 80); thump(70, 30, 0.3, 0.6); knock(200, 0.3); break;
    case 'snap': noise(0.12, 2500, 3, 0.5, 'bandpass', 900); thump(900, 300, 0.08, 0.12, 'triangle'); break;
    case 'chat': thump(880, 860, 0.07, 0.06, 'triangle'); sndDelay = 0.07; thump(1320, 1300, 0.09, 0.05, 'triangle'); break;
    case 'bounce': thump(140, 60, 0.18, 0.4); break;
    case 'start': noise(0.9, 200, 0.7, 0.25, 'lowpass', 2000, 0.6); thump(55, 45, 0.9, 0.25); break;
    case 'sudden': thump(70, 40, 1.2, 0.5, 'sawtooth'); noise(1.2, 300, 0.7, 0.35, 'lowpass', 1500, 0.3); break;
    case 'spawn': thump(300, 900, 0.14, 0.2, 'triangle'); noise(0.12, 2000, 2, 0.14, 'bandpass', 4000, 0.02); break;
    case 'win': thump(220, 110, 0.6, 0.35); noise(0.8, 3000, 0.5, 0.15, 'highpass', 8000, 0.2); break;
  }
  sndPan = 0; sndDelay = 0;
}
})();

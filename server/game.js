const pl = require('planck');
const C = require('./constants');
const MAPS = require('./maps');
const { Character } = require('./character');
const { Bot } = require('./bot');
const protocol = require('../public/protocol');
const V = pl.Vec2;

const DT = 1 / 60;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (n) => Math.round(n * 100) / 100;

class Game {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.nextId = 1;
    this.world = null;
    this.chars = [];
    this.props = new Map();
    this.items = new Map();
    this.projs = new Map();
    this.bullets = [];
    this.events = [];
    this.tickN = 0;
    this.lastMap = -1;
    this.state = 'wait';
    this.emptySince = 0;
    this.hostId = 0;
    this.queuedMap = null;
    this.queuedCat = null;
    this.sleepCursor = 0;
  }

  // ---------- players
  addPlayer(ws, name) {
    const used = new Set([...this.players.values()].map(p => p.num));
    let num = 0;
    while (used.has(num)) num++;
    const p = {
      id: this.nextId++, num, name: String(name || 'Stick').slice(0, 14) || 'Stick',
      color: C.COLORS[num % C.COLORS.length], score: 0, ws,
      input: { l: 0, r: 0, d: 0, j: 0, s: 0, th: 0, ax: 0, ay: 0 }, char: null,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.send(p, { t: 'joined', id: p.id, code: this.code, maps: MAPS.map(m => m.name), cats: MAPS.CATEGORIES });
    this.broadcastRoster();
    if (this.state === 'wait') this.startRound();
    else {
      this.spawnLate(p);                 // straight into the running round, no waiting
      this.send(p, this.mapMessage());
    }
    return p;
  }

  // easter egg: "fabiolul" presses K -> a bot joins and drops straight into the round
  addBot() {
    const used = new Set([...this.players.values()].map(p => p.num));
    let num = 0;
    while (used.has(num)) num++;
    const n = [...this.players.values()].filter(p => p.bot).length + 1;
    const p = {
      id: this.nextId++, num, name: 'Bot ' + n, color: C.COLORS[num % C.COLORS.length], score: 0,
      ws: { readyState: 1, send() {} }, input: { l: 0, r: 0, d: 0, j: 0, s: 0, th: 0, ax: 0, ay: 0 }, char: null,
    };
    p.bot = new Bot(this, p);
    this.players.set(p.id, p);
    this.spawnLate(p);
    this.broadcastRoster();
  }

  // drop a player into a round that is already running: the spawn furthest from everyone alive
  spawnLate(p) {
    if (this.state !== 'play' || !this.world || this.ending || !this.spawns || !this.spawns.length) return;
    const alive = this.chars.filter(c => c.alive).map(c => c.hip.getPosition());
    let best = this.spawns[0], bd = -1;
    for (const s of this.spawns) {
      let d = Infinity;
      for (const a of alive) d = Math.min(d, Math.hypot(a.x - s.x, a.y - s.y));
      if (d > bd) { bd = d; best = s; }
    }
    p.char = new Character(this, p, best.x + (Math.random() - 0.5) * 0.6, best.y + 0.3);
    this.chars.push(p.char);
    this.participants++;
    this.event(['spawn', p.id, r2(best.x), r2(best.y)]);
  }

  removePlayer(p) {
    this.players.delete(p.id);
    if (p.char && p.char.alive) p.char.die(null);
    if (this.hostId === p.id) {
      const next = [...this.players.values()].find(o => !o.bot);
      this.hostId = next ? next.id : 0;
    }
    if (!p.bot && ![...this.players.values()].some(o => !o.bot)) {
      for (const b of [...this.players.values()]) { this.players.delete(b.id); if (b.char && b.char.alive) b.char.die(null); }
    }
    this.broadcastRoster();
    if (this.players.size === 0) { this.state = 'wait'; this.world = null; }
  }

  input(p, msg) {
    const i = p.input, c = p.char;
    if (c) {
      if (msg.j && !i.j) c.jumpPressed();
      if (msg.s && !i.s) c.shootQueued = true;
      if (msg.th && !i.th) c.throwQueued = true;
    }
    i.l = !!msg.l; i.r = !!msg.r; i.d = !!msg.d; i.j = !!msg.j; i.s = !!msg.s; i.th = !!msg.th;
    if (isFinite(msg.ax) && isFinite(msg.ay)) { i.ax = +msg.ax; i.ay = +msg.ay; }
  }

  send(p, obj) {
    if (p.ws.readyState === 1) p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) this.send(p, s);
  }

  broadcastRoster() {
    this.broadcast({
      t: 'roster', list: [...this.players.values()].map(p => [p.id, p.name, p.color, p.score]),
      host: this.hostId, queued: this.queuedMap != null ? MAPS[this.queuedMap].name : this.queuedCat ? 'cat:' + this.queuedCat : null,
    });
  }

  event(e) { this.events.push(e); }

  chat(p, text) {
    if (this.time - (p.lastChat || -9) < 0.8 && p.lastChatRound === this.mapDef) return;
    const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    if (!clean) return;
    p.lastChat = this.time;
    p.lastChatRound = this.mapDef;
    this.event(['chat', p.id, clean]);
  }

  queueMap(p, name) {
    if (p.id !== this.hostId) return;
    this.queuedCat = null;
    this.queuedMap = null;
    if (typeof name === 'string' && name.startsWith('cat:')) {
      const cat = name.slice(4);
      if (MAPS.some(m => m.cat === cat)) this.queuedCat = cat;
    } else {
      const i = MAPS.findIndex(m => m.name === name);
      if (i >= 0) this.queuedMap = i;
    }
    this.broadcastRoster();
  }

  // ---------- rounds / maps
  startRound() {
    const n = this.players.size;
    if (n === 0) { this.state = 'wait'; return; }
    this.state = 'play';
    this.W = Math.round(46 + 3 * Math.max(0, n - 4));
    this.H = Math.round(this.W * 0.56 * 10) / 10;
    let idx;
    do idx = Math.floor(Math.random() * MAPS.length); while (MAPS.length > 1 && idx === this.lastMap);
    if (this.queuedMap != null) { idx = this.queuedMap; this.queuedMap = null; }
    else if (this.queuedCat) {
      const pool = MAPS.map((m, i) => i).filter(i => MAPS[i].cat === this.queuedCat && i !== this.lastMap);
      idx = pool[Math.floor(Math.random() * pool.length)];
      this.queuedCat = null;
    }
    if (this.forceMap != null) idx = this.forceMap;
    this.lastMap = idx;
    const def = MAPS[idx];
    this.mapDef = def;

    this.world = new pl.World({ gravity: V(0, def.gravity || -28) });
    this.props = new Map(); this.items = new Map(); this.projs = new Map(); this.bullets = [];
    this.chars = []; this.ropes = []; this.links = []; this.debris = []; this.hazards = []; this.tickers = []; this.breaks = [];
    this.nextObj = 1;
    this.time = 0; this.freeze = 0.8; this.ending = null; this.sudden = false; this.suddenT = 0;
    this.dropTimer = 2;
    this.pending = [];
    this.pendingBreak = [];
    this.world.on('begin-contact', (c) => this.onContact(c));
    this.world.on('pre-solve', (c) => {
      const ua = c.getFixtureA().getUserData(), ub = c.getFixtureB().getUserData();
      if (ua && ua.belt) c.setTangentSpeed(ua.belt);
      else if (ub && ub.belt) c.setTangentSpeed(-ub.belt);
    });

    const spawns = [];
    def.build(this.mapContext(spawns, n));

    spawns.sort((a, b) => a.x - b.x);
    this.spawns = spawns;
    const players = [...this.players.values()].sort(() => Math.random() - 0.5);
    players.forEach((p, i) => {
      const s = spawns.length ? spawns[Math.floor(((i + 0.5) / players.length) * spawns.length)] : { x: this.W / 2, y: this.H / 2 };
      const off = spawns.length < players.length ? ((i % 3) - 1) * 0.8 : 0;
      p.char = new Character(this, p, s.x + off, s.y + 0.3);
      if (process.env.FAIGHT_DEV) { const t = process.env.FAIGHT_W === 'each' ? C.ORDER[p.num % C.ORDER.length] : process.env.FAIGHT_W || C.ORDER[Math.floor(Math.random() * C.ORDER.length)]; p.char.weapon = { type: t, ammo: C.WEAPONS[t].ammo, spin: 0 }; }
      this.chars.push(p.char);
    });
    this.participants = players.length;
    this.broadcast(this.mapMessage());
    this.broadcastRoster();
  }

  mapContext(spawns, n) {
    const game = this, W = this.W;
    const m = {
      W, H: this.H, n, world: this.world, X: (f) => f * W,
      rect(x, y, w, h, o = {}) { return game.addProp('b', x, y, { w, h }, o); },
      circle(x, y, r, o = {}) { return game.addProp('c', x, y, { r }, o); },
      block(x0, y0, x1, y1, o = {}) { return game.addProp('b', (x0 + x1) / 2, (y0 + y1) / 2, { w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }, o); },
      floor(x0, x1, y, th = 0.7, o = {}) { return m.block(x0, y - th, x1, y, o); },
      wall(x, y0, y1, th = 0.6, o = {}) { return m.block(x - th / 2, y0, x + th / 2, y1, o); },
      crate(x, y, s = 1, o = {}) {
        return game.addProp('b', x, y + s / 2, { w: s, h: s }, Object.assign({ dynamic: true, density: 1.1, crate: true, hp: 45 }, o));
      },
      crates(x, y, cols, rows, s = 1) {
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) m.crate(x + (c - (cols - 1) / 2) * s * 1.01, y + r * s * 1.01, s);
      },
      merlons(x0, x1, y, w = 0.8, h = 1.1, o = { hp: 80 }) {
        const cnt = Math.max(2, Math.floor((x1 - x0) / (w * 2.2)));
        for (let i = 0; i < cnt; i++) {
          const x = x0 + w / 2 + (i / (cnt - 1)) * (x1 - x0 - w);
          m.block(x - w / 2, y, x + w / 2, y + h, o);
        }
      },
      spawn(x, y) { spawns.push({ x, y }); },
      spawnRow(x0, x1, y) {
        const cnt = Math.max(1, Math.floor((x1 - x0) / 3));
        for (let i = 0; i < cnt; i++) spawns.push({ x: x0 + ((i + 0.5) / cnt) * (x1 - x0), y });
      },
      tick(fn) { game.tickers.push(fn); },
      // a real (slack-capable) rope from a fixed point to a body; can be shot through
      rope(x, y, body, lx, ly, slack = 1) {
        const anchor = game.world.createBody({ type: 'static', position: V(x, y) });
        const len = V.distance(V(x, y), body.getWorldPoint(V(lx, ly))) * slack;
        const joint = game.world.createJoint(pl.RopeJoint({ maxLength: len, localAnchorA: V(0, 0), localAnchorB: V(lx, ly) }, anchor, body));
        const rope = { id: game.nextObj++, joint, ax: x, ay: y, body, lx, ly };
        game.ropes.push(rope);
        return rope;
      },
      // plank bridge between two bodies; the hinges can be blown apart
      bridge(a, x0, y0, b, x1, y1, plankW = 1.5) {
        const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.ceil(len / plankW));
        const ang = Math.atan2(y1 - y0, x1 - x0), pw = len / n;
        let prev = a;
        for (let i = 0; i < n; i++) {
          const t0 = i / n, cx = x0 + (x1 - x0) * (t0 + 0.5 / n), cy = y0 + (y1 - y0) * (t0 + 0.5 / n);
          const plank = m.rect(cx, cy - 0.15, pw - 0.05, 0.3, { dynamic: true, density: 2.5, color: '#5a4636', angle: ang });
          m.link(prev, plank, x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0 - 0.1);
          prev = plank;
        }
        m.link(prev, b, x1, y1 - 0.1);
      },
      // a hinge between two bodies that explosions can blow apart
      link(a, b, x, y) {
        const joint = game.world.createJoint(pl.RevoluteJoint({}, a, b, V(x, y)));
        game.links.push({ joint, a, b, lx: a.getLocalPoint(V(x, y)) });
        return joint;
      },
    };
    return m;
  }

  addProp(shape, x, y, size, o) {
    const type = o.dynamic ? 'dynamic' : o.kinematic ? 'kinematic' : 'static';
    const body = this.world.createBody({ type, position: V(x, y), angle: o.angle || 0, angularDamping: o.angularDamping || 0.1 });
    const geo = shape === 'b' ? pl.Box(size.w / 2, size.h / 2) : pl.Circle(size.r);
    const fixture = body.createFixture(geo, {
      density: o.density || 1, friction: o.friction != null ? o.friction : o.ice ? 0.02 : 0.7,
      restitution: o.restitution || 0, isSensor: !!o.sensor,
      filterCategoryBits: type === 'static' ? C.CAT_WORLD : C.CAT_PROP,
      filterMaskBits: C.CAT_WORLD | C.CAT_PROP | C.CAT_BODY | C.CAT_ITEM | C.CAT_PROJ,
      userData: { hazard: o.hazard, bounce: o.bounce, ice: o.ice, belt: o.belt },
    });
    const id = this.nextObj++;
    const desc = { id, k: type === 'static' ? 0 : type === 'dynamic' ? 1 : 2, s: shape, x: r2(x), y: r2(y), a: o.angle || 0 };
    if (shape === 'b') { desc.w = size.w; desc.h = size.h; } else desc.r = size.r;
    if (o.color) desc.c = o.color;
    if (o.hazard) desc.hz = o.hazard;
    if (o.bounce) desc.bo = 1;
    if (o.ice) desc.ice = 1;
    if (o.crate) desc.cr = 1;
    body.setUserData({ kind: 'prop', id, desc, hp: o.hp || 0, size });
    this.props.set(id, body);
    if (o.hazard) this.hazards.push(fixture);
    if (o.breakAt) this.breaks.push({ body, at: o.breakAt });
    if (o.ttl) this.debris.push({ body, until: this.time + o.ttl });
    if (this.time > 0) this.event(['add', desc]);
    return body;
  }

  removeProp(body) {
    const u = body.getUserData();
    if (!this.props.has(u.id)) return;
    this.props.delete(u.id);
    this.hazards = this.hazards.filter(f => f.getBody() !== body);
    for (const r of this.ropes.filter(r => r.body === body)) this.cutRope(r, null, true);
    this.links = this.links.filter(l => l.a !== body && l.b !== body);
    this.world.destroyBody(body);
    this.event(['rm', u.id]);
  }

  cutRope(rope, at, bodyGone) {
    const i = this.ropes.indexOf(rope);
    if (i < 0) return;
    this.ropes.splice(i, 1);
    if (!bodyGone) this.world.destroyJoint(rope.joint);
    const p = at || rope.body.getWorldPoint(V(rope.lx, rope.ly));
    this.event(['cut', rope.id, r2(p.x), r2(p.y)]);
  }

  ropeEnds(r) {
    const b = r.body.getWorldPoint(V(r.lx, r.ly));
    return [r.ax, r.ay, b.x, b.y];
  }

  // damage a breakable piece of the level; at 0 hp it shatters into debris
  damageProp(body, amount, dx = 0, dy = 0) {
    const u = body.getUserData();
    if (!u || u.kind !== 'prop' || !(u.hp > 0) || !this.props.has(u.id)) return;
    u.hp -= amount;
    if (u.hp <= 0) this.pendingBreak.push({ body, dx, dy });
  }

  shatter(body, dx, dy) {
    const u = body.getUserData();
    if (!this.props.has(u.id) || u.desc.s !== 'b') return;
    const pos = body.getPosition(), ang = body.getAngle(), vel = body.getLinearVelocity();
    const { w, h } = u.size;
    const color = u.desc.c || (u.desc.cr ? '#3a3029' : '#26272a');
    this.removeProp(body);
    this.event(['crack', r2(pos.x), r2(pos.y)]);
    const nx = Math.max(1, Math.min(4, Math.round(w / 0.9))), ny = Math.max(1, Math.min(4, Math.round(h / 0.9)));
    const pw = w / nx, ph = h / ny, c = Math.cos(ang), sn = Math.sin(ang);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const lx = -w / 2 + pw * (i + 0.5), ly = -h / 2 + ph * (j + 0.5);
      const piece = this.addProp('b', pos.x + lx * c - ly * sn, pos.y + lx * sn + ly * c,
        { w: pw * 0.92, h: ph * 0.92 }, { dynamic: true, density: 1.2, color, angle: ang });
      piece.setLinearVelocity(V(vel.x + dx * 5 + (Math.random() - 0.5) * 4, vel.y + dy * 5 + Math.random() * 3));
      piece.setAngularVelocity((Math.random() - 0.5) * 8);
      this.debris.push({ body: piece, until: this.time + 6 + Math.random() * 4 });
    }
    while (this.debris.length > 140) this.removeProp(this.debris.shift().body);
  }

  mapMessage() {
    const shapes = [];
    for (const b of this.props.values()) {
      const u = b.getUserData(), p = b.getPosition();
      shapes.push(Object.assign({}, u.desc, { x: r2(p.x), y: r2(p.y), a: r2(b.getAngle()) }));
    }
    return {
      t: 'map', name: this.mapDef.name, sky: this.mapDef.sky, dark: !!this.mapDef.dark,
      W: this.W, H: this.H, shapes, playing: this.chars.map(c => c.player.id),
      ropes: this.ropes.map(r => [r.id, r2(r.ax), r2(r.ay), r.body.getUserData().id, r.lx, r.ly]),
    };
  }

  // ---------- contacts
  onContact(contact) {
    const fa = contact.getFixtureA(), fb = contact.getFixtureB();
    this.impactSound(fa, fb);
    this.contactPair(fa, fb);
    this.contactPair(fb, fa);
  }

  // thumps, clunks and clinks for things hitting things (throttled per body and per tick)
  impactSound(fa, fb) {
    if (this.soundBudget <= 0) return;
    const ba = fa.getBody(), bb = fb.getBody();
    const va = ba.getLinearVelocity(), vb = bb.getLinearVelocity();
    const rel = Math.hypot(va.x - vb.x, va.y - vb.y);
    if (rel < 4.5) return;
    const ua = ba.getUserData() || {}, ub = bb.getUserData() || {};
    const t = this.time;
    const pick = (u, b) => {
      if (u.kind === 'part') return (!u.char.alive || u.char.stun > 0) ? 'thump' : null;
      if (u.kind === 'prop' && b.getType() === 'dynamic') return 'clunk';
      if (u.kind === 'item' || (u.kind === 'proj' && u.proj.type === 'grenade')) return 'clink';
      return null;
    };
    for (const [u, b, other] of [[ua, ba, ub], [ub, bb, ua]]) {
      const kind = pick(u, b);
      if (!kind) continue;
      if (kind === 'thump' && other.kind === 'part' && other.char === u.char) continue;
      const owner = kind === 'thump' ? u.char : u;
      if (t - (owner.lastSound || -1) < 0.12) continue;
      owner.lastSound = t;
      const p = b.getPosition(), strength = Math.min(1, rel / 18);
      if (kind === 'clunk') this.event(['clunk', r2(p.x), r2(p.y), r2(strength), u.desc && u.desc.s === 'c' ? 1 : 0]);
      else this.event([kind, r2(p.x), r2(p.y), r2(strength)]);
      this.soundBudget--;
      return;
    }
  }

  contactPair(fa, fb) {
    const ua = fa.getBody().getUserData() || {};
    const ub = fb.getBody().getUserData() || {};
    if (ua.kind === 'proj' && ua.proj.type === 'rpg') this.pending.push(() => this.detonate(ua.proj));
    if (ub.kind !== 'part' || !ub.char.alive) return;
    const va = fa.getBody().getLinearVelocity(), vb = fb.getBody().getLinearVelocity();
    const rel = Math.hypot(va.x - vb.x, va.y - vb.y);
    const ch = ub.char;
    if (ua.kind === 'item' && ua.item.harm > 0 && ua.item.thrownBy !== ch && rel > 7) {
      const item = ua.item;
      item.harm = 0;
      this.pending.push(() => {
        ch.damage(15, item.thrownBy, 0.6);
        ch.kick(va.x * 0.3, 4);
        this.event(['thud', r2(fb.getBody().getPosition().x), r2(fb.getBody().getPosition().y), ch.player.id]);
      });
    }
    // only a prop that is itself flying fast hurts (falling crates), and only the upper body counts
    const pb = fa.getBody();
    const ps = Math.hypot(va.x, va.y);
    if (ua.kind === 'prop' && pb.getType() === 'dynamic' && pb.getMass() > 0.9 && ps > 12 && ps > Math.hypot(vb.x, vb.y) + 6
      && (ub.part === 'head' || ub.part === 'chest' || ub.part === 'hip')) {
      const p = fb.getBody().getPosition();
      const dmg = Math.min(30, (ps - 10) * 2.5 * Math.min(1.5, pb.getMass() / 1.5));
      this.pending.push(() => {
        ch.damage(dmg, null, 0.4);
        this.event(['thud', r2(p.x), r2(p.y), ch.player.id]);
      });
    }
  }

  // ---------- main tick
  tick() {
    if (this.state !== 'play' || !this.world) return;
    this.tickN++;
    this.time += DT;
    this.soundBudget = 10;
    this.slow = Math.max(0, (this.slow || 0) - DT);
    const dt = this.dt = this.slow > 0 ? DT * 0.3 : DT;
    this.freeze = Math.max(0, this.freeze - DT);

    for (const fn of this.tickers) fn(this.time, DT, this);
    for (const br of this.breaks) {
      if (!br.done && this.time > br.at) {
        br.done = true;
        this.event(['crack', r2(br.body.getPosition().x), r2(br.body.getPosition().y)]);
        this.removeProp(br.body);
      }
    }

    for (const p of this.players.values()) if (p.bot) this.input(p, p.bot.think());
    for (const c of this.chars) {
      if (!c.alive) continue;
      c.update(dt, c.player.input);
      if (this.freeze === 0 && c.stun <= 0) this.combat(c, c.player.input);
    }

    if (!this.sudden && this.time > 75 && !this.ending && this.participants >= 2) {
      this.sudden = true;
      this.event(['sudden']);
    }
    if (this.sudden && !this.ending) {
      this.suddenT = (this.suddenT || 0) - DT;
      if (this.suddenT <= 0) {
        this.suddenT = 0.7;
        const s = 0.8 + Math.random() * 0.6;
        const b = this.addProp('b', this.W * (0.05 + Math.random() * 0.9), this.H + 3, { w: s, h: s }, { dynamic: true, density: 1.4, crate: true, hp: 45 });
        b.setLinearVelocity(V(0, -10));
        this.debris.push({ body: b, until: this.time + 14 });
      }
    }

    this.updateBullets();
    this.updateProjectiles();
    this.updateItems();

    this.world.step(dt, 8, 3);
    const pend = this.pending; this.pending = [];
    for (const fn of pend) fn();
    const brk = this.pendingBreak; this.pendingBreak = [];
    for (const b of brk) this.shatter(b.body, b.dx, b.dy);
    if (this.tickN % 30 === 0 && this.debris.some(d => d.until < this.time)) {
      for (const d of this.debris.filter(d => d.until < this.time)) this.removeProp(d.body);
      this.debris = this.debris.filter(d => d.until >= this.time);
    }

    this.checkHazards();
    this.cleanup();
    this.roundLogic();

    // 30 snapshots per second is plenty with client interpolation and halves per-frame work on both sides
    if (this.tickN % (this.chars.length > 12 ? 3 : 2) === 0) this.sendSnapshot();
  }

  checkHazards() {
    for (const c of this.chars) {
      if (!c.alive) continue;
      const p = c.chest.getPosition();
      if (p.y < -8 || p.x < -15 || p.x > this.W + 15 || p.y > this.H + 40) { c.die(null); continue; }
      let hz = c.groundFixture && (c.groundFixture.getUserData() || {}).hazard;
      if (!hz) {
        outer: for (const f of this.hazards) {
          for (const pt of c.probePoints()) if (f.testPoint(pt)) { hz = (f.getUserData() || {}).hazard; break outer; }
        }
      }
      if (hz === 'lava') {
        if (this.time - (c.lastLava || -1) >= 0.3) {
          c.lastLava = this.time;
          this.event(['hz', hz, r2(p.x), r2(p.y)]);
          c.launch(27);
          c.damage(35, c.lastHitBy);
        }
      } else if (hz) {
        this.event(['hz', hz, r2(p.x), r2(p.y)]);
        c.die(null);
        for (const b of c.bodies) b.setLinearVelocity(V((Math.random() - 0.5) * 6, 8 + Math.random() * 4));
      }
    }
  }

  cleanup() {
    for (const c of this.chars) {
      if (!c.alive && !c.gone && c.chest.getPosition().y < -30) {
        c.gone = true;
        for (const b of c.bodies) this.world.destroyBody(b);
      }
    }
    for (const b of [...this.props.values()]) {
      if (b.getType() === 'dynamic' && b.getPosition().y < -20) this.removeProp(b);
    }
  }

  roundLogic() {
    const alive = this.chars.filter(c => c.alive);
    if (!this.ending) {
      if ((this.participants >= 2 && alive.length <= 1) || alive.length === 0) {
        // the moment the last opponent dies: winner right away + slow motion
        const w = alive[0];
        if (w && this.players.has(w.player.id)) {
          w.player.score++;
          this.event(['win', w.player.id]);
        } else this.event(['win', 0]);
        this.broadcastRoster();
        this.slow = 1.4;
        this.event(['slow', 1.4]);
        this.ending = { t: 3.6 };
      }
      return;
    }
    this.ending.t -= DT;
    if (this.ending.t <= 0) this.startRound();
  }

  // ---------- combat
  combat(c, input) {
    if (c.throwQueued) {
      c.throwQueued = false;
      if (c.weapon) { this.throwWeapon(c, 19); c.shootQueued = false; return; }
    }
    const w = c.weapon && C.WEAPONS[c.weapon.type];
    const queued = c.shootQueued;
    c.shootQueued = false;
    if (!w) {
      if ((queued || input.s) && c.cooldown <= 0) this.punch(c);
      return;
    }
    const held = input.s;
    if (w.spinup) c.weapon.spin = held ? Math.min(w.spinup, c.weapon.spin + this.dt) : Math.max(0, c.weapon.spin - this.dt * 2);
    if (!(w.auto ? held : queued) || c.cooldown > 0) return;
    if (w.spinup && c.weapon.spin < w.spinup) return;
    c.cooldown = w.cd;
    c.weapon.ammo--;
    this.fire(c, c.weapon.type, w);
    if (c.weapon.ammo <= 0) this.throwWeapon(c, 6);
  }

  muzzle(c, w) {
    const s = c.shoulder();
    const dir = V(Math.cos(c.aim), Math.sin(c.aim));
    const reach = 0.66 + w.len;
    let end = V(s.x + dir.x * reach, s.y + dir.y * reach);
    this.world.rayCast(s, end, (f, point, n, frac) => {
      const u = f.getBody().getUserData() || {};
      if (f.isSensor() || u.kind !== 'prop' || f.getBody().getType() === 'dynamic') return -1;
      end = V(point.x - dir.x * 0.05, point.y - dir.y * 0.05);
      return frac;
    });
    return { dir, end };
  }

  fire(c, type, w) {
    const { dir, end } = this.muzzle(c, w);
    const tIdx = C.ORDER.indexOf(type);
    c.kick(-dir.x * w.recoil, -dir.y * w.recoil * 0.6, false);
    this.event(['fire', c.player.id, tIdx, r2(end.x), r2(end.y), Math.round(c.aim * 100)]);
    if (type === 'rpg' || type === 'grenade') { this.spawnProj(c, type, end, dir); return; }
    for (let i = 0; i < w.pellets; i++) {
      const ang = c.aim + (Math.random() - 0.5) * 2 * w.spread;
      const sp = w.speed * (w.pellets > 1 ? 0.85 + Math.random() * 0.3 : 1);
      const b = { id: this.nextObj++, x: end.x, y: end.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: w.life, owner: c, w };
      this.bullets.push(b);
      this.event(['b', b.id, r2(b.x), r2(b.y), r2(b.vx), r2(b.vy), tIdx, w.life]);
    }
  }

  // does the segment a->b pass within r of the gun held by c?
  hitsGun(c, ax, ay, bx, by) {
    const w = C.WEAPONS[c.weapon.type], h = c.handPos(0);
    const gx = Math.cos(c.aim), gy = Math.sin(c.aim);
    const len = Math.max(0.35, w.len + 0.2);
    for (let t = 0; t <= 1; t += 0.25) {
      const px = h.x + gx * len * t, py = h.y + gy * len * t;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const k = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
      if (Math.hypot(ax + dx * k - px, ay + dy * k - py) < 0.13) return true;
    }
    return false;
  }

  updateBullets() {
    const keep = [];
    for (const b of this.bullets) {
      const nx = b.x + b.vx * this.dt, ny = b.y + b.vy * this.dt;
      const gunHit = this.chars.find(c => c.alive && c.weapon && c !== b.owner && this.hitsGun(c, b.x, b.y, nx, ny));
      if (gunHit) {
        const h = gunHit.handPos(0);
        this.event(['bh', b.id, r2(h.x), r2(h.y), -3]);
        this.throwWeapon(gunHit, 5);
        continue;
      }
      let best = null;
      this.world.rayCast(V(b.x, b.y), V(nx, ny), (f, point, normal, frac) => {
        if (f.isSensor()) return -1;
        const u = f.getBody().getUserData() || {};
        if (u.char === b.owner || u.kind === 'item' || u.kind === 'proj') return -1;
        best = { f, point: V(point.x, point.y), frac };
        return frac;
      });
      const hitFrac = best ? best.frac : 1;
      for (const r of [...this.ropes]) {
        const [x1, y1, x2, y2] = this.ropeEnds(r);
        const t = segHit(b.x, b.y, nx, ny, x1, y1, x2, y2);
        if (t != null && t <= hitFrac) this.cutRope(r, V(b.x + (nx - b.x) * t, b.y + (ny - b.y) * t));
      }
      if (!best) {
        b.x = nx; b.y = ny; b.life -= this.dt;
        if (b.life > 0 && ny > -20) keep.push(b);
        continue;
      }
      const body = best.f.getBody(), u = body.getUserData() || {};
      const sp = Math.hypot(b.vx, b.vy);
      const dx = b.vx / sp, dy = b.vy / sp, kb = b.w.kb;
      let victim = body.getType() === 'static' || body.getType() === 'kinematic' ? -1 : -2;
      if (u.kind === 'part') {
        const ch = u.char;
        victim = ch.player.id;
        if (ch.alive) ch.damage(b.w.dmg * (u.part === 'head' ? 1.5 : 1), b.owner);
        body.applyLinearImpulse(V(dx * kb * 0.3, dy * kb * 0.3), best.point, true);
        ch.kick(dx * kb, dy * kb + kb * 0.2);
      } else {
        if (body.getType() === 'dynamic') body.applyLinearImpulse(V(dx * kb * 0.5, dy * kb * 0.5), best.point, true);
        this.damageProp(body, b.w.dmg, dx, dy);
      }
      this.event(['bh', b.id, r2(best.point.x), r2(best.point.y), victim]);
    }
    this.bullets = keep;
  }

  punch(c) {
    c.cooldown = 0.3;
    c.punchT = 0.13;
    c.punchArm = 1 - c.punchArm;
    const s = c.shoulder();
    const dir = V(Math.cos(c.aim), Math.sin(c.aim));
    const center = V(s.x + dir.x * 0.75, s.y + dir.y * 0.75);
    const R = 0.6;
    this.event(['punch', c.player.id]);
    const hitChars = new Set(), hitBodies = new Set();
    this.world.queryAABB(pl.AABB(V(center.x - R, center.y - R), V(center.x + R, center.y + R)), (f) => {
      const b = f.getBody(), u = b.getUserData() || {};
      if (u.char === c || f.isSensor() || b.getType() !== 'dynamic') return true;
      if (u.kind === 'part') hitChars.add(u.char); else hitBodies.add(b);
      return true;
    });
    if (hitChars.size) c.kick(dir.x * 6, dir.y * 6, false);   // attacker lunges into the hit
    for (const ch of hitChars) {
      if (ch.alive) ch.damage(12, c);
      ch.kick(dir.x * 20, dir.y * 20 + 4);
      ch.airGravity = 0;                               // victims float for a moment
      ch.sinceGrounded = 0;
      this.event(['ph', r2(center.x), r2(center.y), ch.player.id, Math.round(c.aim * 100)]);
    }
    for (const b of hitBodies) {
      this.damageProp(b, 12, dir.x, dir.y);
      const m = Math.min(b.getMass(), 6);
      b.applyLinearImpulse(V(dir.x * 7 * m, dir.y * 7 * m + 2), b.getWorldCenter(), true);
    }
  }

  // ---------- rockets & grenades
  spawnProj(c, type, at, dir) {
    const id = this.nextObj++;
    const rocket = type === 'rpg';
    const body = this.world.createBody({ type: 'dynamic', position: at, bullet: true, gravityScale: rocket ? 0.1 : 1, angle: c.aim, angularDamping: rocket ? 5 : 0.3 });
    body.createFixture(rocket ? pl.Box(0.24, 0.08) : pl.Circle(0.15), {
      density: rocket ? 2 : 4, restitution: rocket ? 0 : 0.4, friction: 0.5,
      filterGroupIndex: c.group, filterCategoryBits: C.CAT_PROJ, filterMaskBits: C.CAT_WORLD | C.CAT_PROP | C.CAT_BODY,
    });
    const cv = c.chest.getLinearVelocity(), w = C.WEAPONS[type];
    body.setLinearVelocity(V(dir.x * w.speed + (rocket ? 0 : cv.x * 0.5), dir.y * w.speed + (rocket ? 0 : cv.y * 0.3 + 2)));
    if (!rocket) body.setAngularVelocity(-Math.cos(c.aim) * 12);
    const proj = { id, type, body, owner: c, life: w.life };
    body.setUserData({ kind: 'proj', proj });
    this.projs.set(id, proj);
  }

  updateProjectiles() {
    for (const p of this.projs.values()) {
      p.life -= this.dt;
      if (p.type === 'rpg') { const v = p.body.getLinearVelocity(); p.body.setAngle(Math.atan2(v.y, v.x)); }
      if (p.life <= 0 || p.body.getPosition().y < -15) this.detonate(p);
    }
  }

  detonate(p) {
    if (p.done) return;
    p.done = true;
    const { x, y } = p.body.getPosition();
    this.projs.delete(p.id);
    this.world.destroyBody(p.body);
    this.explode(x, y, p.type === 'rpg' ? 3.6 : 3.2, C.WEAPONS[p.type].dmg, p.owner);
  }

  explode(x, y, R, dmg, owner) {
    this.event(['boom', r2(x), r2(y), R]);
    for (const r of [...this.ropes]) {
      const [x1, y1, x2, y2] = this.ropeEnds(r);
      if (distToSeg(x, y, x1, y1, x2, y2) < R * 0.7) this.cutRope(r, V(x, y));
    }
    for (const l of [...this.links]) {
      const p = l.a.getWorldPoint(l.lx);
      if (Math.hypot(p.x - x, p.y - y) < R * 0.6) { this.world.destroyJoint(l.joint); this.links.splice(this.links.indexOf(l), 1); }
    }
    const seen = new Set();
    this.world.queryAABB(pl.AABB(V(x - R, y - R), V(x + R, y + R)), (f) => {
      const b = f.getBody(), u = b.getUserData() || {};
      if (b.getType() === 'dynamic') seen.add(b);
      else if (u.hp > 0) {
        const c = b.getPosition(), ext = Math.max(u.size.w || 0, u.size.h || 0) / 2;
        const d = Math.max(0, Math.hypot(c.x - x, c.y - y) - ext);
        if (d < R) this.damageProp(b, dmg * 2.5 * (1 - d / R), Math.sign(c.x - x), Math.sign(c.y - y));
      }
      return true;
    });
    const charsHit = new Map();
    for (const b of seen) {
      const c = b.getWorldCenter();
      let dx = c.x - x, dy = c.y - y;
      const d = Math.hypot(dx, dy) || 0.01;
      const f = 1 - d / R;
      if (f <= 0) continue;
      dx /= d; dy /= d;
      const u = b.getUserData() || {};
      const push = (u.kind === 'part' ? 24 : 16) * f;
      const v = b.getLinearVelocity();
      b.setLinearVelocity(V(v.x + dx * push, v.y + dy * push + 5 * f));
      b.setAngularVelocity(b.getAngularVelocity() + (Math.random() - 0.5) * 16 * f);
      if (u.kind === 'part') charsHit.set(u.char, Math.max(charsHit.get(u.char) || 0, f));
      else if (u.kind === 'prop') this.damageProp(b, dmg * 2.5 * f, dx, dy);
    }
    for (const [ch, f] of charsHit) {
      if (!ch.alive) continue;
      const k = clamp(f * 1.35, 0, 1);
      ch.damage(dmg * k * (ch === owner ? 0.6 : 1), owner, 1.6 * k);
    }
  }

  // ---------- items
  spawnItem(type, x, y, ammo, fromChar) {
    const id = this.nextObj++;
    const body = this.world.createBody({ type: 'dynamic', position: V(x, y), angularDamping: 0.6, bullet: !!fromChar });
    body.createFixture(pl.Box(0.42, 0.13), {
      density: 2, friction: 0.8, restitution: 0.2,
      filterCategoryBits: C.CAT_ITEM, filterMaskBits: C.CAT_WORLD | C.CAT_PROP, filterGroupIndex: fromChar ? fromChar.group : 0,
    });
    const item = { id, type, body, ammo, ttl: 40, noPick: 0, harm: 0, thrownBy: null };
    body.setUserData({ kind: 'item', item });
    this.items.set(id, item);
    return item;
  }

  throwWeapon(c, speed) {
    const hand = c.handPos(0);
    const dir = V(Math.cos(c.aim), Math.sin(c.aim));
    const item = this.spawnItem(c.weapon.type, hand.x, hand.y, c.weapon.ammo, c);
    const cv = c.chest.getLinearVelocity();
    item.body.setLinearVelocity(V(dir.x * speed + cv.x * 0.5, dir.y * speed + cv.y * 0.5 + 2));
    item.body.setAngularVelocity(-Math.sign(dir.x || 1) * (speed > 8 ? 14 : 6));
    item.body.setAngle(c.aim);
    item.noPick = speed > 8 ? 0.7 : 1.2;
    item.thrownBy = c;
    if (speed > 8) {
      item.harm = 0.9;
      for (let f = item.body.getFixtureList(); f; f = f.getNext()) f.setFilterData({ groupIndex: c.group, categoryBits: C.CAT_ITEM, maskBits: C.CAT_WORLD | C.CAT_PROP | C.CAT_BODY });
    }
    if (c.weapon.ammo <= 0) item.ttl = 2.5;
    this.event(['toss', r2(hand.x), r2(hand.y)]);
    c.weapon = null;
    c.pickupCd = 0.4;
  }

  updateItems() {
    const n = this.chars.length;
    const maxItems = 2 + Math.floor(n / 3);
    const live = [...this.items.values()].filter(i => i.ammo > 0).length;
    this.dropTimer -= DT;
    if (this.dropTimer <= 0 && this.freeze === 0) {
      this.dropTimer = (6 + Math.random() * 4) / Math.sqrt(Math.max(1, n / 2));
      if (live < maxItems) {
        const type = pickWeapon();
        const x = this.W * (0.12 + Math.random() * 0.76);
        const it = this.spawnItem(type, x, this.H + 3, C.WEAPONS[type].ammo, null);
        it.body.setAngularVelocity((Math.random() - 0.5) * 3);
      }
    }
    for (const it of [...this.items.values()]) {
      it.ttl -= this.dt;
      it.noPick = Math.max(0, it.noPick - this.dt);
      if (it.harm > 0) {
        it.harm -= this.dt;
        if (it.harm <= 0) for (let f = it.body.getFixtureList(); f; f = f.getNext()) f.setFilterData({ groupIndex: 0, categoryBits: C.CAT_ITEM, maskBits: C.CAT_WORLD | C.CAT_PROP });
      }
      const p = it.body.getPosition();
      if (it.ttl <= 0 || p.y < -15) { this.items.delete(it.id); this.world.destroyBody(it.body); continue; }
      if (it.ammo <= 0 || it.noPick > 0) continue;
      for (const c of this.chars) {
        if (!c.alive || c.stun > 0 || c.pickupCd > 0 || c.weapon) continue;
        const cp = c.chest.getPosition(), hp = c.hip.getPosition(), h = c.handPos(0);
        const near = (Math.abs(p.x - cp.x) < 0.7 && p.y < cp.y + 0.8 && p.y > hp.y - 1.2) || Math.hypot(p.x - h.x, p.y - h.y) < 0.7;
        if (!near) continue;
        c.weapon = { type: it.type, ammo: it.ammo, spin: 0 };
        c.cooldown = C.WEAPONS[it.type].rack;
        this.items.delete(it.id);
        this.world.destroyBody(it.body);
        this.event(['pick', c.player.id, C.ORDER.indexOf(it.type), C.WEAPONS[it.type].rack]);
        break;
      }
    }
  }

  onDeath(c) {
    const p = c.chest.getPosition();
    this.event(['die', c.player.id, r2(p.x), r2(p.y)]);
  }

  // ---------- snapshot
  sendSnapshot() {
    const players = [];
    for (const c of this.chars) {
      if (c.gone) continue;
      const hp = c.hip.getPosition();
      players.push({
        id: c.player.id, alive: c.alive, stun: c.stun > 0, aim: c.aim,
        wIdx: c.weapon ? C.ORDER.indexOf(c.weapon.type) : -1, ammo: c.weapon ? c.weapon.ammo : 0,
        hipX: hp.x, hipY: hp.y, angles: c.bodies.map(b => b.getAngle()),
      });
    }
    const props = [], sleepers = [];
    for (const [id, b] of this.props) {
      const t = b.getType();
      if (t === 'static') continue;
      if (t === 'dynamic' && !b.isAwake()) { sleepers.push(id); continue; }
      const q = b.getPosition();
      props.push([id, q.x, q.y, b.getAngle()]);
    }
    // sleeping props are refreshed a few at a time instead of all at once every second (no spikes)
    if (sleepers.length) {
      const n = Math.min(20, sleepers.length);
      for (let k = 0; k < n; k++) {
        const id = sleepers[(this.sleepCursor + k) % sleepers.length];
        const b = this.props.get(id), q = b.getPosition();
        props.push([id, q.x, q.y, b.getAngle()]);
      }
      this.sleepCursor = (this.sleepCursor + n) % sleepers.length;
    }
    const items = [];
    for (const it of this.items.values()) {
      const q = it.body.getPosition();
      items.push([it.id, C.ORDER.indexOf(it.type), q.x, q.y, it.body.getAngle(), it.ammo > 0 ? (it.ttl < 4 ? 2 : 1) : 0]);
    }
    const projs = [];
    for (const pr of this.projs.values()) {
      const q = pr.body.getPosition();
      projs.push([pr.id, pr.type === 'rpg' ? 0 : 1, q.x, q.y, pr.body.getAngle()]);
    }
    const tm = Math.round(this.time * 1000);
    if (this.events.length) { this.broadcast({ t: 'e', tm, e: this.events }); this.events = []; }
    const buf = Buffer.from(protocol.encode(tm, players, props, items, projs));
    for (const p of this.players.values()) if (p.ws.readyState === 1) p.ws.send(buf, { binary: true, compress: false });
  }

}

// where along a->b (0..1) the segment crosses c->d, or null
function segHit(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}

function pickWeapon() {
  const total = C.ORDER.reduce((s, k) => s + C.WEAPONS[k].weight, 0);
  let r = Math.random() * total;
  for (const k of C.ORDER) { r -= C.WEAPONS[k].weight; if (r <= 0) return k; }
  return 'pistol';
}

module.exports = { Game, DT };

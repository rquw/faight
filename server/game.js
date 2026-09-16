const pl = require('planck');
const C = require('./constants');
const MAPS = require('./maps');
const { Character } = require('./character');
const V = pl.Vec2;

const DT = 1 / 60;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (n) => Math.round(n * 100) / 100;
const i100 = (n) => Math.round(n * 100);

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
    this.send(p, { t: 'joined', id: p.id, code: this.code });
    this.broadcastRoster();
    if (this.state === 'wait') this.startRound();
    else {
      this.send(p, this.mapMessage());
      if (this.participants <= 1 && !this.ending) this.ending = { t: 0.5, winner: null, silent: true };
    }
    return p;
  }

  removePlayer(p) {
    this.players.delete(p.id);
    if (p.char && p.char.alive) p.char.die(null);
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
    this.broadcast({ t: 'roster', list: [...this.players.values()].map(p => [p.id, p.name, p.color, p.score]) });
  }

  event(e) { this.events.push(e); }

  // ---------- rounds / maps
  startRound() {
    const n = this.players.size;
    if (n === 0) { this.state = 'wait'; return; }
    this.state = 'play';
    this.W = Math.round(46 + 3 * Math.max(0, n - 4));
    this.H = Math.round(this.W * 0.56 * 10) / 10;
    let idx;
    do idx = Math.floor(Math.random() * MAPS.length); while (MAPS.length > 1 && idx === this.lastMap);
    if (this.forceMap != null) idx = this.forceMap;
    this.lastMap = idx;
    const def = MAPS[idx];
    this.mapDef = def;

    this.world = new pl.World({ gravity: V(0, def.gravity || -28) });
    this.props = new Map(); this.items = new Map(); this.projs = new Map(); this.bullets = [];
    this.chars = []; this.ropes = []; this.hazards = []; this.tickers = []; this.breaks = [];
    this.nextObj = 1;
    this.time = 0; this.freeze = 0.8; this.wind = 0; this.ending = null;
    this.dropTimer = 2;
    this.pending = [];
    this.world.on('begin-contact', (c) => this.onContact(c));

    const spawns = [];
    def.build(this.mapContext(spawns, n));

    spawns.sort((a, b) => a.x - b.x);
    const players = [...this.players.values()].sort(() => Math.random() - 0.5);
    players.forEach((p, i) => {
      const s = spawns.length ? spawns[Math.floor(((i + 0.5) / players.length) * spawns.length)] : { x: this.W / 2, y: this.H / 2 };
      const off = spawns.length < players.length ? ((i % 3) - 1) * 0.8 : 0;
      p.char = new Character(this, p, s.x + off, s.y + 0.3);
      if (process.env.FAIGHT_DEV) { const t = C.ORDER[Math.floor(Math.random() * C.ORDER.length)]; p.char.weapon = { type: t, ammo: C.WEAPONS[t].ammo, spin: 0 }; }
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
        return game.addProp('b', x, y + s / 2, { w: s, h: s }, Object.assign({ dynamic: true, density: 1.1, crate: true }, o));
      },
      crates(x, y, cols, rows, s = 1) {
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) m.crate(x + (c - (cols - 1) / 2) * s * 1.01, y + r * s * 1.01, s);
      },
      merlons(x0, x1, y, w = 0.8, h = 1.1) {
        const cnt = Math.max(2, Math.floor((x1 - x0) / (w * 2.2)));
        for (let i = 0; i < cnt; i++) {
          const x = x0 + w / 2 + (i / (cnt - 1)) * (x1 - x0 - w);
          m.block(x - w / 2, y, x + w / 2, y + h);
        }
      },
      spawn(x, y) { spawns.push({ x, y }); },
      spawnRow(x0, x1, y) {
        const cnt = Math.max(1, Math.floor((x1 - x0) / 3));
        for (let i = 0; i < cnt; i++) spawns.push({ x: x0 + ((i + 0.5) / cnt) * (x1 - x0), y });
      },
      tick(fn) { game.tickers.push(fn); },
      rope(x, y, body, lx, ly) { game.ropes.push([r2(x), r2(y), body.getUserData().id, lx, ly]); },
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
      filterCategoryBits: C.CAT_WORLD, filterMaskBits: C.CAT_WORLD | C.CAT_BODY | C.CAT_ITEM | C.CAT_PROJ,
      userData: { hazard: o.hazard, bounce: o.bounce, ice: o.ice },
    });
    const id = this.nextObj++;
    const desc = { id, k: type === 'static' ? 0 : type === 'dynamic' ? 1 : 2, s: shape, x: r2(x), y: r2(y), a: o.angle || 0 };
    if (shape === 'b') { desc.w = size.w; desc.h = size.h; } else desc.r = size.r;
    if (o.color) desc.c = o.color;
    if (o.hazard) desc.hz = o.hazard;
    if (o.bounce) desc.bo = 1;
    if (o.ice) desc.ice = 1;
    if (o.crate) desc.cr = 1;
    body.setUserData({ kind: 'prop', id, desc });
    this.props.set(id, body);
    if (o.hazard) this.hazards.push(fixture);
    if (o.breakAt) this.breaks.push({ body, at: o.breakAt });
    if (this.time > 0) this.event(['add', desc]);
    return body;
  }

  removeProp(body) {
    const u = body.getUserData();
    this.props.delete(u.id);
    this.hazards = this.hazards.filter(f => f.getBody() !== body);
    this.world.destroyBody(body);
    this.event(['rm', u.id]);
  }

  mapMessage() {
    const shapes = [];
    for (const b of this.props.values()) {
      const u = b.getUserData(), p = b.getPosition();
      shapes.push(Object.assign({}, u.desc, { x: r2(p.x), y: r2(p.y), a: r2(b.getAngle()) }));
    }
    return {
      t: 'map', name: this.mapDef.name, sky: this.mapDef.sky, dark: !!this.mapDef.dark,
      W: this.W, H: this.H, shapes, ropes: this.ropes, playing: this.chars.map(c => c.player.id),
    };
  }

  // ---------- contacts
  onContact(contact) {
    const fa = contact.getFixtureA(), fb = contact.getFixtureB();
    this.contactPair(fa, fb);
    this.contactPair(fb, fa);
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
        ch.push(va.x * 2, 8);
        this.event(['thud', r2(fb.getBody().getPosition().x), r2(fb.getBody().getPosition().y), ch.player.id]);
      });
    }
    if (ua.kind === 'prop' && fa.getBody().getType() === 'dynamic' && fa.getBody().getMass() > 0.9 && rel > 11) {
      const p = fb.getBody().getPosition();
      const dmg = Math.min(35, (rel - 9) * 3 * Math.min(1.5, fa.getBody().getMass() / 1.5));
      this.pending.push(() => {
        ch.damage(dmg, null, 0.6);
        this.event(['thud', r2(p.x), r2(p.y), ch.player.id]);
      });
    }
  }

  // ---------- main tick
  tick() {
    if (this.state !== 'play' || !this.world) return;
    this.tickN++;
    this.time += DT;
    this.freeze = Math.max(0, this.freeze - DT);

    for (const fn of this.tickers) fn(this.time, DT, this);
    for (const br of this.breaks) {
      if (!br.done && this.time > br.at) {
        br.done = true;
        this.event(['crack', r2(br.body.getPosition().x), r2(br.body.getPosition().y)]);
        this.removeProp(br.body);
      }
    }

    for (const c of this.chars) {
      if (!c.alive) continue;
      c.update(DT, c.player.input);
      if (this.freeze === 0 && c.stun <= 0) this.combat(c, c.player.input);
    }

    this.updateBullets();
    this.updateProjectiles();
    this.updateItems();

    this.world.step(DT, 8, 3);
    const pend = this.pending; this.pending = [];
    for (const fn of pend) fn();

    this.checkHazards();
    this.cleanup();
    this.roundLogic();

    if (this.tickN % (this.chars.length > 10 ? 3 : 2) === 0) this.sendSnapshot();
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
      if (hz) {
        this.event(['hz', hz, r2(p.x), r2(p.y)]);
        c.die(null);
        const up = hz === 'lava' ? 14 : 8;
        for (const b of c.bodies) b.setLinearVelocity(V((Math.random() - 0.5) * 6, up + Math.random() * 4));
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
      if ((this.participants >= 2 && alive.length <= 1) || alive.length === 0) this.ending = { t: 1.8, winner: alive[0] || null };
      return;
    }
    this.ending.t -= DT;
    if (this.ending.t > 0) return;
    if (!this.ending.announced) {
      this.ending.announced = true;
      if (this.ending.silent) return this.startRound();
      const w = this.ending.winner;
      if (w && w.alive && this.players.has(w.player.id)) {
        w.player.score++;
        this.event(['win', w.player.id]);
      } else this.event(['win', 0]);
      this.broadcastRoster();
      this.ending.t = 2.2;
      return;
    }
    this.startRound();
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
    if (w.spinup) c.weapon.spin = held ? Math.min(w.spinup, c.weapon.spin + DT) : Math.max(0, c.weapon.spin - DT * 2);
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
    c.push(-dir.x * w.recoil, -dir.y * w.recoil * 0.5);
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

  updateBullets() {
    const keep = [];
    for (const b of this.bullets) {
      const nx = b.x + b.vx * DT, ny = b.y + b.vy * DT;
      let best = null;
      this.world.rayCast(V(b.x, b.y), V(nx, ny), (f, point, normal, frac) => {
        if (f.isSensor()) return -1;
        const u = f.getBody().getUserData() || {};
        if (u.char === b.owner || u.kind === 'item' || u.kind === 'proj') return -1;
        best = { f, point: V(point.x, point.y), frac };
        return frac;
      });
      if (!best) {
        b.x = nx; b.y = ny; b.life -= DT;
        if (b.life > 0 && ny > -20) keep.push(b);
        continue;
      }
      const body = best.f.getBody(), u = body.getUserData() || {};
      const sp = Math.hypot(b.vx, b.vy);
      const dx = b.vx / sp, dy = b.vy / sp, kb = b.w.kb;
      let victim = -1;
      if (u.kind === 'part') {
        const ch = u.char;
        victim = ch.player.id;
        if (ch.alive) ch.damage(b.w.dmg * (u.part === 'head' ? 1.5 : 1), b.owner, b.w.stun || (b.w.pellets > 1 ? 0.15 : 0));
        body.applyLinearImpulse(V(dx * kb * 0.3, dy * kb * 0.3), best.point, true);
        ch.push(dx * kb, dy * kb + kb * 0.15);
      } else if (body.getType() === 'dynamic') {
        body.applyLinearImpulse(V(dx * kb * 0.5, dy * kb * 0.5), best.point, true);
      }
      this.event(['bh', b.id, r2(best.point.x), r2(best.point.y), victim]);
    }
    this.bullets = keep;
  }

  punch(c) {
    c.cooldown = 0.34;
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
    for (const ch of hitChars) {
      if (ch.alive) ch.damage(10, c, ch.stun > 0 ? 0.45 : 0.25);
      ch.push(dir.x * 38, dir.y * 38 + 10);
      this.event(['ph', r2(center.x), r2(center.y), ch.player.id, Math.round(c.aim * 100)]);
    }
    for (const b of hitBodies) {
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
      filterGroupIndex: c.group, filterCategoryBits: C.CAT_PROJ, filterMaskBits: C.CAT_WORLD | C.CAT_BODY,
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
      p.life -= DT;
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
    const seen = new Set();
    this.world.queryAABB(pl.AABB(V(x - R, y - R), V(x + R, y + R)), (f) => {
      if (f.getBody().getType() === 'dynamic') seen.add(f.getBody());
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
    }
    for (const [ch, f] of charsHit) {
      if (!ch.alive) continue;
      const k = clamp(f * 1.35, 0, 1);
      ch.damage(dmg * k * (ch === owner ? 0.6 : 1), owner, 0.6 + k);
    }
  }

  // ---------- items
  spawnItem(type, x, y, ammo, fromChar) {
    const id = this.nextObj++;
    const body = this.world.createBody({ type: 'dynamic', position: V(x, y), angularDamping: 0.6, bullet: !!fromChar });
    body.createFixture(pl.Box(0.42, 0.13), {
      density: 2, friction: 0.8, restitution: 0.2,
      filterCategoryBits: C.CAT_ITEM, filterMaskBits: C.CAT_WORLD, filterGroupIndex: fromChar ? fromChar.group : 0,
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
      for (let f = item.body.getFixtureList(); f; f = f.getNext()) f.setFilterData({ groupIndex: c.group, categoryBits: C.CAT_ITEM, maskBits: C.CAT_WORLD | C.CAT_BODY });
    }
    if (c.weapon.ammo <= 0) item.ttl = 2.5;
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
      it.ttl -= DT;
      it.noPick = Math.max(0, it.noPick - DT);
      if (it.harm > 0) {
        it.harm -= DT;
        if (it.harm <= 0) for (let f = it.body.getFixtureList(); f; f = f.getNext()) f.setFilterData({ groupIndex: 0, categoryBits: C.CAT_ITEM, maskBits: C.CAT_WORLD });
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
        c.cooldown = 0.15;
        this.items.delete(it.id);
        this.world.destroyBody(it.body);
        this.event(['pick', c.player.id]);
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
    const P = [];
    for (const c of this.chars) {
      if (c.gone) continue;
      const row = [c.player.id, c.alive ? 1 : 0, Math.round(c.aim * 100),
        c.weapon ? C.ORDER.indexOf(c.weapon.type) : -1, c.weapon ? c.weapon.ammo : 0, c.stun > 0 ? 1 : 0];
      for (const b of c.bodies) { const q = b.getPosition(); row.push(i100(q.x), i100(q.y), i100(b.getAngle())); }
      P.push(row);
    }
    const O = [];
    for (const [id, b] of this.props) {
      if (b.getType() === 'static') continue;
      const q = b.getPosition();
      O.push([id, i100(q.x), i100(q.y), i100(b.getAngle())]);
    }
    const I = [];
    for (const it of this.items.values()) {
      const q = it.body.getPosition();
      I.push([it.id, C.ORDER.indexOf(it.type), i100(q.x), i100(q.y), i100(it.body.getAngle()), it.ammo > 0 ? (it.ttl < 4 ? 2 : 1) : 0]);
    }
    const R = [];
    for (const pr of this.projs.values()) {
      const q = pr.body.getPosition();
      R.push([pr.id, pr.type === 'rpg' ? 0 : 1, i100(q.x), i100(q.y), i100(pr.body.getAngle())]);
    }
    const msg = { t: 's', tm: Math.round(this.time * 1000), P, O, I, R, e: this.events, wd: this.wind };
    this.events = [];
    this.broadcast(msg);
  }
}

function pickWeapon() {
  const total = C.ORDER.reduce((s, k) => s + C.WEAPONS[k].weight, 0);
  let r = Math.random() * total;
  for (const k of C.ORDER) { r -= C.WEAPONS[k].weight; if (r <= 0) return k; }
  return 'pistol';
}

module.exports = { Game, DT };

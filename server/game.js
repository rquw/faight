const pl = require('planck');
const C = require('./constants');
const MAPS = require('./maps');
const { Character, DIM } = require('./character');
const V = pl.Vec2;

const DT = 1 / 60;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (n) => Math.round(n * 100) / 100;
const i100 = (n) => Math.round(n * 100);

class Game {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // id -> {id, num, name, color, score, ws, input, prev, char}
    this.nextId = 1;
    this.world = null;
    this.chars = [];
    this.props = new Map();
    this.items = new Map();
    this.projs = new Map();
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
      // someone was playing alone: restart so the newcomer can join in
      if (this.participants <= 1 && !this.ending) this.ending = { t: 0.6, winner: null, silent: true };
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
    const i = p.input;
    const c = p.char;
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
    this.W = Math.round(26 + 3.8 * Math.max(0, n - 2));
    this.H = this.W * 0.5625;
    let idx;
    do idx = Math.floor(Math.random() * MAPS.length); while (MAPS.length > 1 && idx === this.lastMap);
    if (this.forceMap != null) idx = this.forceMap;
    this.lastMap = idx;
    const def = MAPS[idx];
    this.mapDef = def;

    this.world = new pl.World({ gravity: V(0, def.gravity || -30) });
    this.props = new Map(); this.items = new Map(); this.projs = new Map();
    this.chars = []; this.ropes = []; this.hazards = []; this.tickers = []; this.breaks = [];
    this.nextObj = 1;
    this.time = 0; this.freeze = 1.3; this.wind = 0; this.ending = null;
    this.dropTimer = 2.5;
    this.pending = [];
    this.world.on('begin-contact', (c) => this.onContact(c));

    const spawns = [];
    const m = this.mapContext(spawns, n);
    def.build(m);

    // pick spread-out spawns
    spawns.sort((a, b) => a.x - b.x);
    const players = [...this.players.values()].sort(() => Math.random() - 0.5);
    players.forEach((p, i) => {
      const s = spawns.length ? spawns[Math.floor(((i + 0.5) / players.length) * spawns.length)] : { x: this.W / 2, y: this.H / 2 };
      const off = spawns.length < players.length ? (i % 3 - 1) * 0.7 : 0;
      p.char = new Character(this, p, s.x + off, s.y + 0.05);
      if (process.env.FAIGHT_DEV) { const t = C.ORDER[Math.floor(Math.random() * C.ORDER.length)]; p.char.weapon = { type: t, ammo: C.WEAPONS[t].ammo, spin: 0 }; }
      this.chars.push(p.char);
    });
    this.participants = players.length;
    this.broadcast(this.mapMessage());
    this.broadcastRoster();
  }

  mapContext(spawns, n) {
    const game = this;
    const m = {
      W: this.W, H: this.H, n, world: this.world,
      rect(x, y, w, h, o = {}) { return game.addProp('b', x, y, { w, h }, o); },
      circle(x, y, r, o = {}) { return game.addProp('c', x, y, { r }, o); },
      crate(x, y, s, o = {}) { return game.addProp('b', x, y, { w: s, h: s }, Object.assign({ dynamic: true, density: 1.2, color: '#c08a45', crate: true }, o)); },
      spawn(x, y) { spawns.push({ x, y }); },
      spawnRow(x0, x1, y) {
        const cnt = Math.max(1, Math.floor((x1 - x0) / 2.5));
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
    const desc = {
      id, k: type === 'static' ? 0 : type === 'dynamic' ? 1 : 2, s: shape,
      x: r2(x), y: r2(y), a: o.angle || 0, c: o.color || (type === 'dynamic' ? '#c08a45' : '#3a3f4b'),
    };
    if (shape === 'b') { desc.w = size.w; desc.h = size.h; } else desc.r = size.r;
    if (o.hazard) desc.hz = o.hazard;
    if (o.bounce) desc.bo = 1;
    if (o.ice) desc.ice = 1;
    if (o.crate) desc.cr = 1;
    body.setUserData({ kind: 'prop', id, desc, temp: o.temp });
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
      t: 'map', name: this.mapDef.name, bg: this.mapDef.bg, dark: !!this.mapDef.dark,
      W: this.W, H: this.H, shapes, ropes: this.ropes,
      playing: this.chars.map(c => c.player.id),
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
    if (ua.kind === 'item' && ua.item.harm > 0 && ua.item.thrownBy !== ub.char && rel > 7) {
      const item = ua.item, ch = ub.char;
      item.harm = 0;
      this.pending.push(() => {
        ch.damage(16, item.thrownBy, 0.6);
        ch.torso.applyLinearImpulse(V(va.x * 1.5, 12), ch.torso.getWorldCenter(), true);
        this.event(['bonk', r2(fb.getBody().getPosition().x), r2(fb.getBody().getPosition().y), ch.player.id]);
      });
    }
    if (ua.kind === 'prop' && fa.getBody().getType() === 'dynamic' && fa.getBody().getMass() > 0.9 && rel > 11) {
      const ch = ub.char, p = fb.getBody().getPosition();
      const dmg = Math.min(35, (rel - 9) * 3 * Math.min(1.5, fa.getBody().getMass() / 1.5));
      this.pending.push(() => {
        ch.damage(dmg, null, 0.5);
        this.event(['bonk', r2(p.x), r2(p.y), ch.player.id]);
      });
    }
  }

  // ---------- main tick
  tick() {
    if (this.state !== 'play' || !this.world) return;
    this.tickN++;
    this.time += DT;
    this.freeze = Math.max(0, this.freeze - DT);
    if (this.freeze === 0 && !this.wentGo) { this.wentGo = true; }

    for (const fn of this.tickers) fn(this.time, DT, this);
    for (const br of this.breaks) {
      if (!br.done && this.time > br.at) { br.done = true; this.event(['crack', r2(br.body.getPosition().x), r2(br.body.getPosition().y)]); this.removeProp(br.body); }
    }

    for (const c of this.chars) {
      if (!c.alive) continue;
      c.update(DT, c.player.input);
      if (this.freeze === 0 && c.stun <= 0) this.combat(c, c.player.input);
    }

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
    const margin = 14;
    for (const c of this.chars) {
      if (!c.alive) continue;
      const p = c.torso.getPosition();
      if (p.y < -8 || p.x < -margin || p.x > this.W + margin || p.y > this.H + 40) {
        this.event(['fall', c.player.id, r2(clamp(p.x, 0, this.W)), r2(Math.max(p.y, -2))]);
        c.die(null);
        continue;
      }
      let hz = c.groundFixture && (c.groundFixture.getUserData() || {}).hazard;
      if (!hz) {
        outer: for (const f of this.hazards) {
          for (const pt of c.probePoints()) if (f.testPoint(pt)) { hz = (f.getUserData() || {}).hazard; break outer; }
        }
      }
      if (hz) {
        this.event(['hz', hz, r2(p.x), r2(p.y), c.player.id]);
        c.die(null);
        const up = hz === 'lava' ? 16 : 9;
        for (const b of c.bodies) b.setLinearVelocity(V((Math.random() - 0.5) * 8, up + Math.random() * 6));
      }
    }
  }

  cleanup() {
    for (const c of this.chars) {
      if (!c.alive && !c.gone && c.torso.getPosition().y < -30) {
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
        this.ending = { t: 1.6, winner: alive[0] || null };
      }
      return;
    }
    this.ending.t -= DT;
    if (this.ending.t <= 0 && !this.ending.announced) {
      this.ending.announced = true;
      if (this.ending.silent) { this.startRound(); return; }
      const w = this.ending.winner;
      if (w && w.alive && this.players.has(w.player.id)) {
        w.player.score++;
        this.event(['win', w.player.id]);
      } else this.event(['win', 0]);
      this.broadcastRoster();
      this.ending.t = 2.4;
      this.ending.next = true;
      return;
    }
    if (this.ending.announced && this.ending.t <= 0) this.startRound();
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
    const wants = w.auto ? held : queued;
    if (!wants || c.cooldown > 0) return;
    if (c.weapon.ammo <= 0) {
      if (queued) this.throwWeapon(c, 19);
      return;
    }
    if (w.spinup && c.weapon.spin < w.spinup) return;
    c.cooldown = w.cd;
    c.weapon.ammo--;
    this.fire(c, c.weapon.type, w);
  }

  muzzle(c) {
    const sh = c.shoulder();
    const dir = V(Math.cos(c.aim), Math.sin(c.aim));
    let end = V(sh.x + dir.x * 1.0, sh.y + dir.y * 1.0);
    this.world.rayCast(sh, end, (f, point, n, frac) => {
      const u = f.getBody().getUserData() || {};
      if (f.isSensor() || u.kind !== 'prop' || f.getBody().getType() === 'dynamic') return -1;
      end = V(point.x - dir.x * 0.05, point.y - dir.y * 0.05);
      return frac;
    });
    return { sh, dir, end };
  }

  fire(c, type, w) {
    const { dir, end } = this.muzzle(c);
    const tIdx = C.ORDER.indexOf(type);
    const cm = c.torso.getWorldCenter();
    c.torso.applyLinearImpulse(V(-dir.x * w.recoil, -dir.y * w.recoil * 0.6), cm, true);

    if (type === 'rpg' || type === 'grenade') {
      this.spawnProj(c, type, end, dir);
      this.event([type === 'rpg' ? 'rocket' : 'toss', r2(end.x), r2(end.y)]);
      return;
    }
    const hitCount = new Map();
    for (let i = 0; i < w.pellets; i++) {
      const ang = c.aim + (Math.random() - 0.5) * 2 * w.spread;
      const range = (w.range || 70) * (w.pellets > 1 ? 0.8 + Math.random() * 0.4 : 1);
      const hit = this.hitscan(c, end, ang, range);
      const d = V(Math.cos(ang), Math.sin(ang));
      const to = hit ? hit.point : V(end.x + d.x * range, end.y + d.y * range);
      this.event(['shot', r2(end.x), r2(end.y), r2(to.x), r2(to.y), tIdx]);
      if (!hit) continue;
      const body = hit.fixture.getBody();
      const u = body.getUserData() || {};
      const imp = V(d.x * w.kb, d.y * w.kb);
      if (u.kind === 'part') {
        const ch = u.char;
        if (ch.alive) {
          const dmg = w.dmg * (u.part === 'head' ? 1.4 : 1);
          hitCount.set(ch, (hitCount.get(ch) || 0) + 1);
          ch.damage(dmg, c, w.stun || 0);
          this.event(['hit', r2(hit.point.x), r2(hit.point.y), ch.player.id, u.part === 'head' ? 1 : 0]);
        } else {
          this.event(['hit', r2(hit.point.x), r2(hit.point.y), ch.player.id, 0]);
        }
        body.applyLinearImpulse(V(imp.x * 0.35, imp.y * 0.35), hit.point, true);
        ch.torso.applyLinearImpulse(imp, ch.torso.getWorldCenter(), true);
      } else if (u.kind === 'prop' || u.kind === 'item' || u.kind === 'proj') {
        if (body.getType() === 'dynamic') body.applyLinearImpulse(V(imp.x * 0.6, imp.y * 0.6), hit.point, true);
        this.event(['spark', r2(hit.point.x), r2(hit.point.y)]);
      }
    }
    for (const [ch, n] of hitCount) if (type === 'shotgun' && n >= 3) ch.stun = Math.max(ch.stun, 0.45);
  }

  hitscan(c, from, ang, range) {
    const to = V(from.x + Math.cos(ang) * range, from.y + Math.sin(ang) * range);
    let best = null;
    this.world.rayCast(from, to, (f, point, normal, frac) => {
      if (f.isSensor()) return -1;
      const u = f.getBody().getUserData() || {};
      if (u.char === c || u.kind === 'item') return -1;
      if (u.kind === 'proj' && u.proj.owner === c) return -1;
      best = { fixture: f, point: V(point.x, point.y), frac };
      return frac;
    });
    return best;
  }

  punch(c) {
    c.cooldown = 0.36;
    c.punchT = 0.16;
    c.punchArm = 1 - c.punchArm;
    const sh = c.shoulder();
    const dir = V(Math.cos(c.aim), Math.sin(c.aim));
    const center = V(sh.x + dir.x * 0.85, sh.y + dir.y * 0.85);
    const R = 0.62;
    const hand = c.arms[c.punchArm].l;
    hand.applyLinearImpulse(V(dir.x * 2.5, dir.y * 2.5), hand.getWorldCenter(), true);
    this.event(['punch', r2(center.x), r2(center.y)]);
    const hitChars = new Set(), hitBodies = new Set();
    this.world.queryAABB(pl.AABB(V(center.x - R, center.y - R), V(center.x + R, center.y + R)), (f) => {
      const b = f.getBody(), u = b.getUserData() || {};
      if (u.char === c || f.isSensor()) return true;
      if (b.getType() !== 'dynamic') return true;
      if (u.kind === 'part') hitChars.add(u.char); else hitBodies.add(b);
      return true;
    });
    for (const ch of hitChars) {
      const tp = ch.torso.getWorldCenter();
      const kb = V(dir.x * 26 + (tp.x > sh.x ? 3 : -3), dir.y * 26 + 9);
      if (ch.alive) {
        ch.damage(9, c, ch.stun > 0 ? 0.5 : 0.28);
        this.event(['hit', r2(center.x), r2(center.y), ch.player.id, 2]);
      }
      ch.torso.applyLinearImpulse(kb, tp, true);
      ch.head.applyLinearImpulse(V(dir.x * 3, dir.y * 3 + 1), ch.head.getWorldCenter(), true);
    }
    for (const b of hitBodies) {
      const m = Math.min(b.getMass(), 6);
      b.applyLinearImpulse(V(dir.x * 6 * m, dir.y * 6 * m + 2), b.getWorldCenter(), true);
    }
  }

  // ---------- projectiles
  spawnProj(c, type, at, dir) {
    const id = this.nextObj++;
    const rocket = type === 'rpg';
    const body = this.world.createBody({ type: 'dynamic', position: at, bullet: true, gravityScale: rocket ? 0.12 : 1, angle: c.aim, angularDamping: rocket ? 5 : 0.3 });
    body.createFixture(rocket ? pl.Box(0.22, 0.08) : pl.Circle(0.16), {
      density: rocket ? 2 : 4, restitution: rocket ? 0 : 0.45, friction: 0.5,
      filterGroupIndex: c.group, filterCategoryBits: C.CAT_PROJ, filterMaskBits: C.CAT_WORLD | C.CAT_BODY,
    });
    const cv = c.torso.getLinearVelocity();
    const speed = rocket ? 23 : 15;
    body.setLinearVelocity(V(dir.x * speed + (rocket ? 0 : cv.x * 0.5), dir.y * speed + (rocket ? 0 : cv.y * 0.3 + 2)));
    if (!rocket) body.setAngularVelocity(-Math.cos(c.aim) * 12);
    const proj = { id, type, body, owner: c, life: rocket ? 4 : 2.2 };
    body.setUserData({ kind: 'proj', proj });
    this.projs.set(id, proj);
  }

  updateProjectiles() {
    for (const p of this.projs.values()) {
      p.life -= DT;
      const pos = p.body.getPosition();
      if (p.type === 'rpg') {
        const v = p.body.getLinearVelocity();
        p.body.setAngle(Math.atan2(v.y, v.x));
      }
      if (p.life <= 0 || pos.y < -15) this.detonate(p);
    }
  }

  detonate(p) {
    if (p.done) return;
    p.done = true;
    const pos = p.body.getPosition();
    const x = pos.x, y = pos.y;
    this.projs.delete(p.id);
    this.world.destroyBody(p.body);
    const w = C.WEAPONS[p.type];
    this.explode(x, y, p.type === 'rpg' ? 3.4 : 3.0, w.dmg, p.owner);
  }

  explode(x, y, R, dmg, owner) {
    this.event(['boom', r2(x), r2(y), R]);
    const seen = new Set();
    this.world.queryAABB(pl.AABB(V(x - R, y - R), V(x + R, y + R)), (f) => {
      const b = f.getBody();
      if (b.getType() !== 'dynamic' || seen.has(b)) return true;
      seen.add(b);
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
      const push = (u.kind === 'part' ? 26 : 17) * f;
      const v = b.getLinearVelocity();
      b.setLinearVelocity(V(v.x + dx * push, v.y + dy * push + 5 * f));
      b.setAngularVelocity(b.getAngularVelocity() + (Math.random() - 0.5) * 20 * f);
      if (u.kind === 'part') charsHit.set(u.char, Math.max(charsHit.get(u.char) || 0, f));
    }
    for (const [ch, f] of charsHit) {
      if (!ch.alive) continue;
      const k = clamp(f * 1.35, 0, 1);
      ch.damage(dmg * k * (ch === owner ? 0.6 : 1), owner, 0.5 + k);
    }
  }

  // ---------- items
  spawnItem(type, x, y, ammo, fromChar) {
    const id = this.nextObj++;
    const body = this.world.createBody({ type: 'dynamic', position: V(x, y), angularDamping: 0.6, bullet: !!fromChar });
    body.createFixture(pl.Box(0.4, 0.14), {
      density: 2, friction: 0.8, restitution: 0.2,
      filterCategoryBits: C.CAT_ITEM, filterMaskBits: C.CAT_WORLD,
      filterGroupIndex: fromChar ? fromChar.group : 0,
    });
    const item = { id, type, body, ammo, ttl: 35, noPick: 0, harm: 0, thrownBy: null };
    body.setUserData({ kind: 'item', item });
    this.items.set(id, item);
    return item;
  }

  throwWeapon(c, speed) {
    const hand = c.handPos(0);
    const dir = V(Math.cos(c.aim), Math.sin(c.aim));
    const item = this.spawnItem(c.weapon.type, hand.x, hand.y, c.weapon.ammo, c);
    const cv = c.torso.getLinearVelocity();
    item.body.setLinearVelocity(V(dir.x * speed + cv.x * 0.5, dir.y * speed + cv.y * 0.5 + 2));
    item.body.setAngularVelocity(-Math.sign(dir.x || 1) * 14);
    item.body.setAngle(c.aim);
    item.noPick = speed > 8 ? 0.7 : 1.2;
    item.thrownBy = c;
    if (speed > 8) {
      item.harm = 0.9;
      for (let f = item.body.getFixtureList(); f; f = f.getNext()) {
        f.setFilterData({ groupIndex: c.group, categoryBits: C.CAT_ITEM, maskBits: C.CAT_WORLD | C.CAT_BODY });
      }
    }
    if (c.weapon.ammo <= 0) item.ttl = 2.5;
    c.weapon = null;
    c.pickupCd = 0.4;
    this.event(['throw', r2(hand.x), r2(hand.y)]);
  }

  updateItems() {
    const n = this.chars.length;
    const maxItems = 2 + Math.floor(n / 3);
    const live = [...this.items.values()].filter(i => i.ammo > 0).length;
    this.dropTimer -= DT;
    if (this.dropTimer <= 0 && this.freeze === 0) {
      this.dropTimer = (7 + Math.random() * 4) / Math.sqrt(Math.max(1, n / 2));
      if (live < maxItems) {
        const type = pickWeapon();
        const x = this.W * (0.15 + Math.random() * 0.7);
        const it = this.spawnItem(type, x, this.H + 2, C.WEAPONS[type].ammo, null);
        it.body.setAngularVelocity((Math.random() - 0.5) * 3);
        this.event(['drop', r2(x)]);
      }
    }
    for (const it of [...this.items.values()]) {
      it.ttl -= DT;
      it.noPick = Math.max(0, it.noPick - DT);
      if (it.harm > 0) {
        it.harm -= DT;
        if (it.harm <= 0) {
          for (let f = it.body.getFixtureList(); f; f = f.getNext()) f.setFilterData({ groupIndex: 0, categoryBits: C.CAT_ITEM, maskBits: C.CAT_WORLD });
        }
      }
      const p = it.body.getPosition();
      if (it.ttl <= 0 || p.y < -15) {
        this.items.delete(it.id);
        this.world.destroyBody(it.body);
        continue;
      }
      if (it.ammo <= 0 || it.noPick > 0) continue;
      for (const c of this.chars) {
        if (!c.alive || c.stun > 0 || c.pickupCd > 0) continue;
        if (c.weapon && c.weapon.ammo > 0) continue;
        const tp = c.torso.getPosition(), h = c.handPos(0);
        const near = (Math.abs(p.x - tp.x) < 0.75 && Math.abs(p.y - tp.y) < 1.45) || Math.hypot(p.x - h.x, p.y - h.y) < 0.65;
        if (!near) continue;
        if (c.weapon) this.throwWeapon(c, 3);
        c.weapon = { type: it.type, ammo: it.ammo, spin: 0 };
        c.cooldown = 0.2;
        c.pickupCd = 0.3;
        this.items.delete(it.id);
        this.world.destroyBody(it.body);
        this.event(['pick', c.player.id, C.ORDER.indexOf(it.type)]);
        break;
      }
    }
  }

  onDeath(c, killer) {
    const p = c.torso.getPosition();
    this.event(['die', c.player.id, killer ? killer.player.id : 0, r2(p.x), r2(p.y)]);
  }

  // ---------- network snapshot
  sendSnapshot() {
    const P = [];
    for (const c of this.chars) {
      if (c.gone) continue;
      const row = [c.player.id, c.alive ? 1 : 0, Math.max(0, Math.round(c.hp)), i100(c.aim),
        c.weapon ? C.ORDER.indexOf(c.weapon.type) : -1, c.weapon ? c.weapon.ammo : 0, c.stun > 0 ? 1 : 0,
        c.weapon && c.weapon.spin ? Math.round(c.weapon.spin * 100) : 0];
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
      I.push([it.id, C.ORDER.indexOf(it.type), i100(q.x), i100(q.y), i100(it.body.getAngle()), it.ammo > 0 ? (it.ttl < 5 ? 2 : 1) : 0]);
    }
    const R = [];
    for (const pr of this.projs.values()) {
      const q = pr.body.getPosition();
      R.push([pr.id, pr.type === 'rpg' ? 0 : 1, i100(q.x), i100(q.y), i100(pr.body.getAngle()), Math.round(pr.life * 10)]);
    }
    const msg = { t: 's', tm: Math.round(this.time * 1000), P, O, I, R, e: this.events, fz: this.freeze > 0 ? 1 : 0, wd: this.wind };
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

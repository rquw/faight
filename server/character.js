// Fully physical stick figure, Stick-Fight style: no animation, only forces.
// Alive: a support force lifts the hip, torques keep the spine upright, limbs are
// pulled toward loose target poses. Stunned / dead: forces off -> ragdoll.
const pl = require('planck');
const C = require('./constants');
const V = pl.Vec2;

const TAU = Math.PI * 2;
const wrap = (a) => a - TAU * Math.round(a / TAU);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// body order is shared with the client: hip, chest, head, ua0, la0, ua1, la1, ul0, ll0, ul1, ll1
const DIM = { hipHH: 0.17, chestHH: 0.2, headR: 0.24, uArmHH: 0.17, lArmHH: 0.16, uLegHH: 0.23, lLegHH: 0.23, w: 0.07 };
const REST = 1.08;         // hip-center height above ground
const CROUCH_REST = 0.78;
const SPEED = 8;
const JUMP = 14;

class Character {
  constructor(game, player, x, y) {
    this.game = game;
    this.player = player;
    this.world = game.world;
    this.alive = true;
    this.hp = 100;
    this.group = -(player.num + 1);
    this.stun = 0;
    this.jumpLock = 0;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.grounded = false;
    this.groundFixture = null;
    this.facing = 1;
    this.aim = 0;
    this.weapon = null;
    this.cooldown = 0;
    this.punchT = 0;
    this.punchArm = 0;
    this.pickupCd = 0;
    this.shootQueued = false;
    this.throwQueued = false;
    this.stepT = 0;
    this.stepLeg = 0;
    this.wallSide = 0;
    this.lastHitBy = null;
    this.build(x, y);
  }

  part(name, pos, shape, density, mask) {
    const b = this.world.createBody({ type: 'dynamic', position: pos, angularDamping: 1, linearDamping: 0.1 });
    b.createFixture(shape, {
      density, friction: name[1] === 'l' ? 0.25 : 0.4, restitution: 0,
      filterGroupIndex: this.group, filterCategoryBits: C.CAT_BODY, filterMaskBits: mask,
    });
    b.setUserData({ kind: 'part', char: this, part: name });
    return b;
  }

  build(x, y) {
    const full = C.CAT_WORLD | C.CAT_BODY | C.CAT_PROJ;
    const hy = y + REST + 0.05;
    this.hip = this.part('hip', V(x, hy), pl.Box(DIM.w + 0.01, DIM.hipHH), 12, full);
    const cy = hy + DIM.hipHH + DIM.chestHH;
    this.chest = this.part('chest', V(x, cy), pl.Box(DIM.w + 0.02, DIM.chestHH), 12, full);
    const headY = cy + DIM.chestHH + DIM.headR + 0.02;
    this.head = this.part('head', V(x, headY), pl.Circle(DIM.headR), 5, full);
    const J = (a, b, p, lo, hi) => this.world.createJoint(pl.RevoluteJoint({ enableLimit: lo != null, lowerAngle: lo || 0, upperAngle: hi || 0 }, a, b, p));
    J(this.hip, this.chest, V(x, hy + DIM.hipHH), -0.5, 0.5);
    J(this.chest, this.head, V(x, cy + DIM.chestHH + 0.02), -0.6, 0.6);

    const sh = V(x, cy + DIM.chestHH - 0.05);
    this.arms = [];
    for (let i = 0; i < 2; i++) {
      const u = this.part('ua', V(x, sh.y - DIM.uArmHH), pl.Box(DIM.w * 0.8, DIM.uArmHH), 5, C.CAT_WORLD);
      const l = this.part('la', V(x, sh.y - DIM.uArmHH * 2 - DIM.lArmHH), pl.Box(DIM.w * 0.8, DIM.lArmHH), 5, C.CAT_WORLD);
      J(this.chest, u, sh);
      J(u, l, V(x, sh.y - DIM.uArmHH * 2), -2.7, 2.7);
      this.arms.push({ u, l });
    }
    const hp = V(x, hy - DIM.hipHH);
    this.legs = [];
    for (let i = 0; i < 2; i++) {
      const u = this.part('ul', V(x, hp.y - DIM.uLegHH), pl.Box(DIM.w, DIM.uLegHH), 6, full);
      const l = this.part('ll', V(x, hp.y - DIM.uLegHH * 2 - DIM.lLegHH), pl.Box(DIM.w, DIM.lLegHH), 6, full);
      J(this.hip, u, hp, -2.2, 2.2);
      J(u, l, V(x, hp.y - DIM.uLegHH * 2), -2.6, 2.6);
      this.legs.push({ u, l });
    }
    this.bodies = [this.hip, this.chest, this.head, this.arms[0].u, this.arms[0].l, this.arms[1].u, this.arms[1].l,
      this.legs[0].u, this.legs[0].l, this.legs[1].u, this.legs[1].l];
    this.mass = this.bodies.reduce((s, b) => s + b.getMass(), 0);
  }

  get torso() { return this.chest; }

  shoulder() {
    const a = this.chest.getAngle(), p = this.chest.getPosition(), d = DIM.chestHH - 0.05;
    return V(p.x - Math.sin(a) * d, p.y + Math.cos(a) * d);
  }

  handPos(i = 0) {
    const b = this.arms[i].l, p = b.getPosition(), a = b.getAngle();
    return V(p.x + Math.sin(a) * DIM.lArmHH, p.y - Math.cos(a) * DIM.lArmHH);
  }

  footPos(i) {
    const b = this.legs[i].l, p = b.getPosition(), a = b.getAngle();
    return V(p.x + Math.sin(a) * DIM.lLegHH, p.y - Math.cos(a) * DIM.lLegHH);
  }

  probePoints() {
    return [this.chest.getPosition(), this.hip.getPosition(), this.head.getPosition(), this.footPos(0), this.footPos(1)];
  }

  castGround() {
    const p = this.hip.getPosition();
    const len = REST + 0.55;
    let best = null;
    for (const ox of [-0.18, 0, 0.18]) {
      this.world.rayCast(V(p.x + ox, p.y), V(p.x + ox, p.y - len), (f, point, normal, frac) => {
        if (f.isSensor()) return -1;
        const u = f.getBody().getUserData();
        if (u && (u.char === this || u.kind === 'item' || u.kind === 'proj')) return -1;
        if (u && u.kind === 'part' && (u.part === 'ua' || u.part === 'la')) return -1;
        const d = frac * len;
        if (!best || d < best.d) best = { d, point: V(point.x, point.y), fixture: f };
        return frac;
      });
    }
    return best;
  }

  castWall(dir) {
    const p = this.chest.getPosition();
    let hit = false;
    for (const oy of [0.1, -0.35]) {
      this.world.rayCast(V(p.x, p.y + oy), V(p.x + dir * 0.45, p.y + oy), (f) => {
        if (f.isSensor()) return -1;
        const b = f.getBody(), u = b.getUserData();
        if (u && (u.char || u.kind === 'item' || u.kind === 'proj')) return -1;
        if (b.getType() === 'dynamic' && b.getMass() < 4) return -1;
        hit = true;
        return 0;
      });
    }
    return hit;
  }

  jumpPressed() { this.jumpBuffer = 0.15; }

  // spring a body's center toward a target point that moves with the chest
  pullTo(b, tx, ty, w, maxA) {
    const p = b.getWorldCenter(), v = b.getLinearVelocity(), cv = this.chest.getLinearVelocity(), m = b.getMass();
    let ax = w * w * (tx - p.x) + 2 * w * (cv.x - v.x);
    let ay = w * w * (ty - p.y) + 2 * w * (cv.y - v.y);
    const mag = Math.hypot(ax, ay);
    if (mag > maxA) { ax *= maxA / mag; ay *= maxA / mag; }
    b.applyForceToCenter(V(ax * m, ay * m), true);
    this.chest.applyForceToCenter(V(-ax * m, -ay * m), true);
  }

  // rotate a body toward a world angle (limb angle 0 = pointing down).
  // rate: how fast the error closes (1/s), grip: 0..1 share of the needed torque per step
  turnTo(b, target, rate, grip, maxT = 300) {
    const want = rate * wrap(target - b.getAngle());
    const t = grip * b.getInertia() * (want - b.getAngularVelocity()) * 60;
    b.applyTorque(clamp(t, -maxT, maxT), true);
  }

  // place an arm exactly (no fighting springs -> no jitter)
  poseArm(i, s, angU, angL) {
    const { u, l } = this.arms[i];
    const ux = Math.sin(angU), uy = -Math.cos(angU), lx = Math.sin(angL), ly = -Math.cos(angL);
    const ex = s.x + ux * DIM.uArmHH * 2, ey = s.y + uy * DIM.uArmHH * 2;
    const vu = this.chest.getLinearVelocity();
    u.setTransform(V(s.x + ux * DIM.uArmHH, s.y + uy * DIM.uArmHH), angU);
    l.setTransform(V(ex + lx * DIM.lArmHH, ey + ly * DIM.lArmHH), angL);
    u.setLinearVelocity(vu); l.setLinearVelocity(vu);
    u.setAngularVelocity(0); l.setAngularVelocity(0);
  }

  update(dt, input) {
    if (!this.alive) return;
    const g = this.game;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.pickupCd = Math.max(0, this.pickupCd - dt);
    this.jumpLock = Math.max(0, this.jumpLock - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.stun = Math.max(0, this.stun - dt);
    this.punchT = Math.max(0, this.punchT - dt);
    const frozen = g.freeze > 0;
    const hip = this.hip, chest = this.chest;
    const v = chest.getLinearVelocity();
    const M = this.mass;
    const grav = -g.world.getGravity().y;

    const cp = chest.getPosition();
    const ax = input.ax - cp.x, ay = input.ay - (cp.y + 0.15);
    if (ax * ax + ay * ay > 0.04) this.aim = Math.atan2(ay, ax);
    this.facing = Math.cos(this.aim) >= 0 ? 1 : -1;

    const stunned = this.stun > 0;
    const crouch = !!input.d && !frozen;
    const move = frozen ? 0 : (input.r ? 1 : 0) - (input.l ? 1 : 0);

    // ---- support
    const hit = this.jumpLock > 0 ? null : this.castGround();
    const rest = crouch ? CROUCH_REST : REST;
    this.grounded = false;
    this.groundFixture = null;
    let gvx = 0, gvy = 0, ice = false;
    if (hit && hit.d < rest + 0.2) {
      const hu = hit.fixture.getUserData() || {};
      const gb = hit.fixture.getBody();
      if (hu.bounce && !stunned) {
        this.setAllVel(v.x, hu.bounce);
        this.jumpLock = 0.25;
        g.event(['bounce', r2(hit.point.x), r2(hit.point.y)]);
      } else {
        const gv = gb.getLinearVelocityFromWorldPoint(hit.point);
        gvx = gv.x; gvy = gv.y;
        ice = !!hu.ice;
        this.grounded = true;
        this.groundFixture = hit.fixture;
        if (!stunned) {
          const rel = hip.getLinearVelocity().y - gvy;
          const acc = clamp(220 * (rest - hit.d) - 24 * rel + grav, 0, 75);
          // lift from the neck: the body hangs below it like a puppet and self-rights
          const ca = chest.getAngle(), cpos = chest.getPosition();
          const neck = V(cpos.x - Math.sin(ca) * DIM.chestHH, cpos.y + Math.cos(ca) * DIM.chestHH);
          chest.applyForce(V(0, acc * M), neck, true);
          if (gb.getType() === 'dynamic') gb.applyForce(V(0, -Math.min(acc, grav * 1.5) * M), hit.point, true);
        }
      }
    }
    if (this.grounded) this.coyote = 0.1; else this.coyote = Math.max(0, this.coyote - dt);

    if (stunned) return;

    // ---- spine upright (lean into movement)
    const lean = clamp((v.x - gvx) * -0.025, -0.25, 0.25);
    this.turnTo(hip, lean * 0.5, 12, 0.8);
    this.turnTo(chest, lean, 12, 0.8);
    this.turnTo(this.head, 0, 6, 0.3);

    // ---- horizontal movement
    const speed = crouch && this.grounded ? SPEED * 0.45 : SPEED;
    const target = move * speed + (this.grounded ? gvx : 0);
    let accel;
    if (this.grounded) accel = clamp((target - v.x) * (ice ? 1.5 : 16), ice ? -7 : -60, ice ? 7 : 60);
    else accel = move ? clamp((target - v.x) * 9, -38, 38) : 0;
    hip.applyForceToCenter(V(accel * M * 0.5, 0), true);
    chest.applyForceToCenter(V(accel * M * 0.5, 0), true);
    if (g.wind) chest.applyForceToCenter(V(g.wind * M, 0), true);
    if (input.d && !this.grounded) hip.applyForceToCenter(V(0, -32 * M), true);

    // ---- walls
    this.wallSide = 0;
    if (!this.grounded) {
      if (this.castWall(1)) this.wallSide = 1;
      else if (this.castWall(-1)) this.wallSide = -1;
      if (this.wallSide && move === this.wallSide && v.y < -3) chest.applyForceToCenter(V(0, (-3 - v.y) * 10 * M), true);
    }

    // ---- jump
    if (this.jumpBuffer > 0 && !frozen) {
      if (this.coyote > 0) {
        this.setAllVel(v.x, JUMP + Math.max(0, gvy));
        if (hit && hit.fixture.getBody().getType() === 'dynamic') hit.fixture.getBody().applyLinearImpulse(V(0, -M * 4), hit.point, true);
        this.jumpBuffer = 0; this.coyote = 0; this.jumpLock = 0.22;
        g.event(['jump', r2(hip.getPosition().x), r2(hip.getPosition().y - REST)]);
      } else if (this.wallSide) {
        this.setAllVel(-this.wallSide * 9, JUMP * 0.95);
        this.jumpBuffer = 0; this.jumpLock = 0.2;
      }
    }

    this.legForces(dt, move, crouch);
    this.armForces();
  }

  legForces(dt, move, crouch) {
    const f = this.facing;
    let t0, t1, k0, k1, grip = 0.9;
    if (!this.grounded) {
      t0 = f * 0.45; t1 = -f * 0.2; k0 = -f * 0.2; k1 = -f * 0.55; grip = 0.35;
    } else if (crouch) {
      t0 = f * 1.1; t1 = f * 0.5; k0 = -f * 0.35; k1 = -f * 0.75;
    } else if (move) {
      // alternate which leg is thrown forward; the physics does the rest
      this.stepT -= dt;
      if (this.stepT <= 0) { this.stepT = 0.15; this.stepLeg = 1 - this.stepLeg; }
      const fwd = move * 0.75, back = -move * 0.5;
      const a = this.stepLeg === 0 ? fwd : back, b = this.stepLeg === 0 ? back : fwd;
      t0 = a; t1 = b; k0 = a - move * 0.45; k1 = b - move * 0.2;
    } else {
      t0 = -0.3 + f * 0.08; t1 = 0.3 + f * 0.08; k0 = -0.18 - f * 0.1; k1 = 0.18 - f * 0.1;
    }
    const pd = (b, target, kp, kd) => b.applyTorque(clamp(kp * wrap(target - b.getAngle()) - kd * b.getAngularVelocity(), -30, 30), true);
    pd(this.legs[0].u, t0, 14 * grip, 0.5); pd(this.legs[1].u, t1, 14 * grip, 0.5);
    pd(this.legs[0].l, k0, 7 * grip, 0.25); pd(this.legs[1].l, k1, 7 * grip, 0.25);
  }

  armForces() {
    const s = this.shoulder();
    const dx = Math.cos(this.aim), dy = Math.sin(this.aim);
    const armA = this.aim + Math.PI / 2;
    const f = this.facing;
    const w = this.weapon ? C.WEAPONS[this.weapon.type] : null;
    for (let i = 0; i < 2; i++) {
      const { u, l } = this.arms[i];
      if (this.punchT > 0 && this.punchArm === i) {
        this.pullTo(u, s.x + dx * 0.18, s.y + dy * 0.18, 40, 900);
        this.pullTo(l, s.x + dx * 0.52, s.y + dy * 0.52, 40, 900);
      } else if (w && i === 0) {
        this.poseArm(0, s, armA, armA);
      } else if (w && w.twoHand) {
        this.poseArm(1, s, armA - f * 0.55, armA + f * 0.25);
      } else {
        // loose guard toward the cursor
        const off = i === 0 ? 0 : -0.1;
        this.pullTo(u, s.x + dx * 0.1, s.y + dy * 0.1 - 0.12 + off, 8, 100);
        this.pullTo(l, s.x + dx * 0.3, s.y + dy * 0.3 - 0.08 + off, 8, 100);
      }
    }
  }

  setAllVel(vx, vy) {
    const cvx = this.chest.getLinearVelocity().x;
    for (const b of this.bodies) {
      const bv = b.getLinearVelocity();
      b.setLinearVelocity(V(vx + (bv.x - cvx) * 0.3, vy));
    }
  }

  push(ix, iy) {
    // spread an impulse over the core so the whole body reacts
    this.chest.applyLinearImpulse(V(ix * 0.45, iy * 0.45), this.chest.getWorldCenter(), true);
    this.hip.applyLinearImpulse(V(ix * 0.35, iy * 0.35), this.hip.getWorldCenter(), true);
    this.head.applyLinearImpulse(V(ix * 0.2, iy * 0.2), this.head.getWorldCenter(), true);
  }

  damage(amount, by, stun = 0) {
    if (!this.alive || this.game.freeze > 0) return;
    this.hp -= amount;
    if (by && by !== this) this.lastHitBy = by;
    this.stun = Math.max(this.stun, stun);
    if (this.hp <= 0) this.die(by);
  }

  die(by) {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    const mask = C.CAT_WORLD | C.CAT_BODY | C.CAT_PROJ;
    for (const b of this.bodies) {
      for (let f = b.getFixtureList(); f; f = f.getNext()) f.setFilterData({ groupIndex: this.group, categoryBits: C.CAT_BODY, maskBits: mask });
      b.setAngularDamping(0.4);
    }
    if (this.weapon) this.game.throwWeapon(this, 3);
    this.game.onDeath(this, by && by !== this ? by : this.lastHitBy);
  }
}

function r2(n) { return Math.round(n * 100) / 100; }

module.exports = { Character, DIM, wrap };

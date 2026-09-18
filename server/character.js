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

// Movement rules follow Stick Fight: The Game (Landfall): a flat acceleration is pushed into every
// body part while a key is held and drag limits the speed; a jump zeroes vertical velocity and adds a
// fixed velocity; while airborne an extra gravity grows with time in the air (starts at 0.25 s after a
// jump); fallen bodies lose their drag. SFTG's Unity values (jump 25, gravity ramp 4000 * fixedDt,
// drag ~8) are scaled so one SFTG unit = 2.17 m, giving the same timing: apex after ~0.22 s,
// ~0.62 s airtime, about two body heights high.
const U = 2.17;
const DRAG = 8;
const GRAVITY = 9.81 * U;          // base gravity for a standing character
const AIR_RAMP = 80 * U;           // extra m/s² per second spent in the air
const JUMP = 25 * U;
const RUN_ACCEL = 96;              // m/s² into every part -> 12 m/s top speed with DRAG
const WORLD_G = 28;
const COYOTE = 0.3;                // you may still jump this long after walking off a ledge

class Character {
  constructor(game, player, x, y) {
    this.game = game;
    this.player = player;
    this.world = game.world;
    this.alive = true;
    this.hp = 100;
    this.group = -(player.num + 1);
    this.stun = 0;
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
    this.drag = DRAG;
    this.airGravity = 0;
    this.sinceJumped = 1;
    this.sinceGrounded = 0;
    this.sinceWall = 1;
    this.sinceFallen = 1;
    this.lastWallSide = 0;
    this.wallSide = 0;
    this.lastHitBy = null;
    this.born = game.time || 0;
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
    const full = C.CAT_WORLD | C.CAT_PROP | C.CAT_BODY | C.CAT_PROJ;
    // legs only touch solid level geometry while alive so they never snag on loose crates
    const legMask = C.CAT_WORLD;
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
      const u = this.part('ul', V(x, hp.y - DIM.uLegHH), pl.Box(DIM.w, DIM.uLegHH), 6, legMask);
      const l = this.part('ll', V(x, hp.y - DIM.uLegHH * 2 - DIM.lLegHH), pl.Box(DIM.w, DIM.lLegHH), 6, legMask);
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

  castGround(move = 0) {
    const p = this.hip.getPosition();
    const len = REST + 0.55;
    let best = null;
    const probes = [[-0.18, 0], [0, 0], [0.18, 0]];
    // look ahead from higher up so low crates / steps are climbed instead of tripped over
    if (move) probes.push([move * 0.45, 0.35]);
    for (const [ox, oy] of probes) {
      this.world.rayCast(V(p.x + ox, p.y + oy), V(p.x + ox, p.y - len), (f, point, normal, frac) => {
        if (f.isSensor()) return -1;
        const u = f.getBody().getUserData();
        if (u && (u.char === this || u.kind === 'item' || u.kind === 'proj')) return -1;
        if (u && u.kind === 'part' && (u.part === 'ua' || u.part === 'la')) return -1;
        const d = frac * (len + oy) - oy;
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

  jumpPressed() { this.jumpBuffer = 0.18; }   // pressing jump just before landing still counts

  // SFTG CheckForGroundCollision: contact normal within 75° of up = ground, 75°-95° = wall
  touchContacts() {
    let ground = false, wall = 0;
    for (const b of this.bodies) {
      for (let ce = b.getContactList(); ce; ce = ce.next) {
        const c = ce.contact;
        if (!c.isTouching()) continue;
        const other = ce.other, u = other.getUserData() || {};
        if (u.char === this || u.kind === 'item' || u.kind === 'proj') continue;
        const wm = c.getWorldManifold(null);
        if (!wm) continue;
        let nx = wm.normal.x, ny = wm.normal.y;
        if (c.getFixtureA().getBody() === b) { nx = -nx; ny = -ny; }   // normal pointing at us
        const ang = Math.acos(Math.max(-1, Math.min(1, ny))) * 180 / Math.PI;
        if (ang > 95) continue;
        if (ang > 75) wall = nx > 0 ? -1 : 1;
        else ground = true;
      }
    }
    return { ground, wall };
  }

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
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.punchT = Math.max(0, this.punchT - dt);
    this.sinceJumped += dt;
    this.sinceGrounded += dt;
    this.sinceWall += dt;
    const wasStunned = this.stun > 0;
    this.stun = Math.max(0, this.stun - dt);
    if (wasStunned && this.stun === 0) this.sinceFallen = 0;
    this.sinceFallen += dt;
    const frozen = g.freeze > 0;
    const hip = this.hip, chest = this.chest;
    const v = chest.getLinearVelocity();
    const M = this.mass;
    const gScale = Math.abs(g.world.getGravity().y) / WORLD_G;   // moon maps scale everything

    const cp = chest.getPosition();
    const ax = input.ax - cp.x, ay = input.ay - (cp.y + 0.15);
    if (ax * ax + ay * ay > 0.04) this.aim = Math.atan2(ay, ax);
    this.facing = Math.cos(this.aim) >= 0 ? 1 : -1;

    const stunned = this.stun > 0;
    const crouch = !!input.d && !frozen;
    const move = frozen || stunned ? 0 : (input.r ? 1 : 0) - (input.l ? 1 : 0);

    // ---- drag & gravity like SFTG: fallen bodies go limp and drop with plain world gravity
    this.launchT = Math.max(0, (this.launchT || 0) - dt);
    const targetDrag = stunned ? 0 : this.launchT > 0 ? 0.6 : DRAG;
    this.drag += (targetDrag - this.drag) * Math.min(1, dt * (stunned ? 12 : 5));
    const gs = stunned ? 0.75 : GRAVITY / WORLD_G;
    for (const b of this.bodies) { b.setLinearDamping(this.drag); b.setGravityScale(gs); }

    // ---- ground
    const airTime = this.sinceGrounded;
    const fallSpeed = -hip.getLinearVelocity().y;
    const hit = this.sinceJumped < 0.2 ? null : this.castGround(stunned ? 0 : move);
    const rest = crouch ? CROUCH_REST : REST;
    this.grounded = false;
    this.groundFixture = null;
    let gvy = 0;
    const touch = this.sinceJumped > 0.2 ? this.touchContacts() : { ground: false, wall: 0 };
    if (touch.ground) this.sinceGrounded = 0;
    if (hit && hit.d < rest + 0.2) {
      const hu = hit.fixture.getUserData() || {};
      const gb = hit.fixture.getBody();
      this.grounded = true;
      this.groundFixture = hit.fixture;
      this.sinceGrounded = 0;
      if (hu.bounce && !stunned) {
        this.setAllVel(v.x, hu.bounce);
        this.sinceJumped = 0;
        g.event(['bounce', r2(hit.point.x), r2(hit.point.y)]);
      } else if (!stunned) {
        gvy = gb.getLinearVelocityFromWorldPoint(hit.point).y;
        if (hu.ice) for (const b of this.bodies) b.setLinearDamping(0.6);
        if (hu.belt) for (const b of this.bodies) b.applyForceToCenter(V(hu.belt * this.drag * b.getMass(), 0), true);
        // stand force, eased in after getting up (SFTG getUpCurve)
        const getUp = Math.min(1, this.sinceFallen * 2);
        const rel = hip.getLinearVelocity().y - gvy;
        const acc = clamp((220 * (rest - hit.d) - 18 * rel) * getUp + GRAVITY * gScale, 0, 90);
        const ca = chest.getAngle(), cpos = chest.getPosition();
        const neck = V(cpos.x - Math.sin(ca) * DIM.chestHH, cpos.y + Math.cos(ca) * DIM.chestHH);
        chest.applyForce(V(0, acc * M), neck, true);
        if (gb.getType() === 'dynamic') gb.applyForce(V(0, -Math.min(acc, GRAVITY * 1.5) * M), hit.point, true);
      }
    }

    if ((this.grounded || touch.ground) && airTime > 0.35 && !stunned) {
      const hp = hip.getPosition();
      g.event(['land', r2(hp.x), r2(hp.y - REST), r2(clamp(fallSpeed / 25, 0.2, 1))]);
    }

    // ---- air gravity ramp
    if (this.grounded || touch.ground) this.airGravity = 0;
    else this.airGravity += dt;
    if (!stunned && !this.grounded) {
      const extra = this.airGravity * AIR_RAMP * gScale;
      for (const b of this.bodies) b.applyForceToCenter(V(0, -extra * b.getMass()), true);
    }

    if (stunned) return;

    // ---- spine upright (lean into movement)
    const lean = clamp(v.x * -0.02, -0.25, 0.25);
    this.turnTo(hip, lean * 0.5, 12, 0.8);
    this.turnTo(chest, lean, 12, 0.8);
    this.turnTo(this.head, 0, 6, 0.3);

    // ---- run: same push on the ground and in the air, drag does the limiting
    if (move) for (const b of this.bodies) b.applyForceToCenter(V(move * RUN_ACCEL * b.getMass(), 0), true);
    if (input.d && !this.grounded) hip.applyForceToCenter(V(0, -90 * M), true);

    // ---- ledge assist: rising next to a ledge that's just above chest height -> pull up onto it
    if (!this.grounded && move && v.y > -2 && this.sinceJumped < 0.6) {
      const cp2 = chest.getPosition();
      const wallAhead = this.castWall(move);
      if (wallAhead) {
        let clearAbove = true;
        this.world.rayCast(V(cp2.x, cp2.y + 1.3), V(cp2.x + move * 0.8, cp2.y + 1.3), (f) => {
          const u = f.getBody().getUserData() || {};
          if (f.isSensor() || u.kind !== 'prop') return -1;
          clearAbove = false; return 0;
        });
        if (clearAbove) for (const b of this.bodies) { const bv = b.getLinearVelocity(); b.setLinearVelocity(V(bv.x, Math.max(bv.y, 9))); }
      }
    }

    // ---- walls
    this.wallSide = 0;
    if (!this.grounded) {
      this.wallSide = touch.wall || (this.castWall(1) ? 1 : this.castWall(-1) ? -1 : 0);
      if (this.wallSide) this.sinceWall = 0;
      this.lastWallSide = this.wallSide || this.lastWallSide;
    }

    // ---- jump: grounded or on a wall within the coyote window (0.3 s), at most every 0.3 s
    if (this.jumpBuffer > 0 && !frozen && this.sinceJumped > 0.3 && (this.sinceGrounded < COYOTE || this.sinceWall < COYOTE)) {
      const wall = this.sinceWall < this.sinceGrounded;
      for (const b of this.bodies) {
        const bv = b.getLinearVelocity();
        // off the wall only when steering away from it, otherwise climb straight up
        if (wall) b.setLinearVelocity(V(move === -this.lastWallSide ? bv.x - this.lastWallSide * JUMP * 0.75 : bv.x * 0.3 + this.lastWallSide * 1.5, JUMP * 0.85));
        else b.setLinearVelocity(V(bv.x, JUMP + Math.max(0, gvy)));
      }
      if (!wall && hit && hit.fixture.getBody().getType() === 'dynamic') hit.fixture.getBody().applyLinearImpulse(V(0, -M * 6), hit.point, true);
      this.airGravity = 0.25;
      this.jumpBuffer = 0; this.sinceJumped = 0; this.sinceGrounded = 1; this.sinceWall = 1;
      g.event(['jump', r2(hip.getPosition().x), r2(hip.getPosition().y - REST), wall ? 1 : 0]);
    }

    this.legForces(dt, move, crouch);
    this.armForces();
  }

  legForces(dt, move, crouch) {
    const f = this.facing;
    this.stepT += dt;
    let t0, t1, k0, k1, grip = 0.9;
    if (!this.grounded) {
      t0 = f * 0.45; t1 = -f * 0.2; k0 = -f * 0.2; k1 = -f * 0.55; grip = 0.35;
    } else if (crouch) {
      t0 = f * 1.1; t1 = f * 0.5; k0 = -f * 0.35; k1 = -f * 0.75;
    } else if (move) {
      // SFTG StepController: swap the forward leg once the legs are spread wide enough
      const spread = Math.abs(wrap(this.legs[0].u.getAngle() - this.legs[1].u.getAngle()));
      if (spread > 1.05 && this.stepT > 0.16) {
        this.stepT = 0; this.stepLeg = 1 - this.stepLeg;
        const f = this.footPos(this.stepLeg);
        this.game.event(['step', r2(f.x), r2(f.y)]);
      }
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

  // lava: fly really high (low drag and no air-gravity build-up for a moment)
  launch(vy) {
    this.launchT = 0.7;
    this.drag = 0.6;
    this.airGravity = -0.6;
    this.sinceJumped = 0;
    for (const b of this.bodies) { const v = b.getLinearVelocity(); b.setLinearVelocity(V(v.x * 0.5, vy)); }
  }

  // knock the whole body: core takes the full velocity change, limbs a bit less so it flops.
  // SFTG "weakness": the more damage taken, the further you fly
  kick(dvx, dvy, weak = true) {
    const w = !weak ? 1 : this.alive ? 1 + (100 - Math.max(0, this.hp)) / 100 : 0.5;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i], k = (i < 3 ? 1 : 0.75) * w, v = b.getLinearVelocity();
      b.setLinearVelocity(V(v.x + dvx * k, v.y + dvy * k));
    }
  }

  damage(amount, by, stun = 0) {
    // SFTG: 0.5 s spawn protection; players who drop into a running round get their own 1.2 s
    if (!this.alive || this.game.freeze > 0 || this.game.time < 1.3 || this.game.time - this.born < 1.2) return;
    this.hp -= amount;
    this.game.event(['hp', this.player.id, Math.max(0, Math.round(this.hp))]);
    if (by && by !== this) this.lastHitBy = by;
    this.stun = Math.max(this.stun, stun);
    if (this.hp <= 0) this.die(by);
  }

  die(by) {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    const mask = C.CAT_WORLD | C.CAT_PROP | C.CAT_BODY | C.CAT_PROJ;
    for (const b of this.bodies) {
      for (let f = b.getFixtureList(); f; f = f.getNext()) f.setFilterData({ groupIndex: this.group, categoryBits: C.CAT_BODY, maskBits: mask });
      b.setAngularDamping(0.4);
      b.setLinearDamping(0);
      b.setGravityScale(0.75);
    }
    if (this.weapon) this.game.throwWeapon(this, 3);
    this.game.onDeath(this, by && by !== this ? by : this.lastHitBy);
  }
}

function r2(n) { return Math.round(n * 100) / 100; }

module.exports = { Character, DIM, wrap };

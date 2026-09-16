// Active-ragdoll stick figure. Alive: a hover spring + upright torque keep it standing,
// joint motors animate limbs. Dead / stunned: pure floppy ragdoll.
const pl = require('planck');
const C = require('./constants');
const V = pl.Vec2;

const TAU = Math.PI * 2;
const wrap = (a) => a - TAU * Math.round(a / TAU);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// part order is shared with the client (see public/client.js PARTS)
const DIM = {
  torsoHH: 0.42, torsoHW: 0.13, headR: 0.25,
  uArmHH: 0.2, lArmHH: 0.19, uLegHH: 0.25, lLegHH: 0.25, limbHW: 0.06,
};
const REST = 1.28;        // torso-center height above ground when standing
const CROUCH_REST = 0.92;
const SPEED = 7.2;
const CROUCH_SPEED = 3.2;
const JUMP = 12.5;

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
    this.groundBody = null;
    this.phase = 0;
    this.facing = 1;
    this.aim = 0;
    this.weapon = null;       // {type, ammo, cd, spin}
    this.cooldown = 0;
    this.punchT = 0;
    this.punchArm = 0;
    this.punchHit = new Set();
    this.pickupCd = 0;
    this.shootQueued = false;
    this.throwQueued = false;
    this.groundFixture = null;
    this.wallSide = 0;
    this.lastHitBy = null;
    this.build(x, y);
  }

  part(name, def, shape, density) {
    const b = this.world.createBody(Object.assign({ type: 'dynamic', angularDamping: 0.5, linearDamping: 0.05 }, def));
    b.createFixture(shape, {
      density, friction: 0.6, restitution: 0.05,
      filterGroupIndex: this.group,
      filterCategoryBits: C.CAT_BODY,
      filterMaskBits: (name === 'torso' || name === 'head') ? C.CAT_WORLD | C.CAT_BODY | C.CAT_PROJ : 0,
    });
    b.setUserData({ kind: 'part', char: this, part: name });
    return b;
  }

  limb(name, parent, anchor, hh, lower, upper) {
    const b = this.part(name, { position: V(anchor.x, anchor.y - hh) }, pl.Box(DIM.limbHW, hh), 6);
    const j = this.world.createJoint(pl.RevoluteJoint({
      enableMotor: true, maxMotorTorque: 60, motorSpeed: 0,
      enableLimit: lower != null, lowerAngle: lower || 0, upperAngle: upper || 0,
    }, parent, b, anchor));
    return [b, j];
  }

  build(x, y) {
    const cy = y + REST;
    this.torso = this.part('torso', { position: V(x, cy) }, pl.Box(DIM.torsoHW, DIM.torsoHH), 22);
    this.head = this.part('head', { position: V(x, cy + DIM.torsoHH + DIM.headR + 0.04) }, pl.Circle(DIM.headR), 9);
    this.neck = this.world.createJoint(pl.RevoluteJoint({
      enableLimit: true, lowerAngle: -0.5, upperAngle: 0.5, enableMotor: true, maxMotorTorque: 8,
    }, this.torso, this.head, V(x, cy + DIM.torsoHH)));

    const sh = V(x, cy + DIM.torsoHH - 0.08);
    const hip = V(x, cy - DIM.torsoHH + 0.02);
    this.arms = [];
    this.legs = [];
    for (let i = 0; i < 2; i++) {
      const [ua, sj] = this.limb('uarm', this.torso, sh, DIM.uArmHH);
      const [la, ej] = this.limb('larm', ua, V(x, sh.y - DIM.uArmHH * 2), DIM.lArmHH, -2.6, 2.6);
      this.arms.push({ u: ua, l: la, sj, ej });
    }
    for (let i = 0; i < 2; i++) {
      const [ul, hj] = this.limb('uleg', this.torso, hip, DIM.uLegHH, -2.4, 2.4);
      const [ll, kj] = this.limb('lleg', ul, V(x, hip.y - DIM.uLegHH * 2), DIM.lLegHH, -2.6, 2.6);
      this.legs.push({ u: ul, l: ll, hj, kj });
    }
    this.bodies = [this.torso, this.head, this.arms[0].u, this.arms[0].l, this.arms[1].u, this.arms[1].l,
      this.legs[0].u, this.legs[0].l, this.legs[1].u, this.legs[1].l];
    this.joints = [this.neck, ...this.arms.flatMap(a => [a.sj, a.ej]), ...this.legs.flatMap(l => [l.hj, l.kj])];
    this.mass = this.bodies.reduce((s, b) => s + b.getMass(), 0);
  }

  pos() { return this.torso.getPosition(); }

  shoulder() {
    const a = this.torso.getAngle(), p = this.torso.getPosition(), d = DIM.torsoHH - 0.08;
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

  // points used for hazard checks
  probePoints() {
    return [this.torso.getPosition(), this.head.getPosition(), this.footPos(0), this.footPos(1), this.handPos(0), this.handPos(1)];
  }

  motor(j, target, gain, torque) {
    j.setMaxMotorTorque(torque);
    j.setMotorSpeed(clamp(gain * wrap(target - j.getJointAngle()), -40, 40));
  }

  ownFixture(f) {
    const u = f.getBody().getUserData();
    return u && u.char === this;
  }

  castGround() {
    const p = this.torso.getPosition();
    const len = REST + 0.5;
    let best = null;
    for (const ox of [-0.22, 0, 0.22]) {
      const from = V(p.x + ox, p.y), to = V(p.x + ox, p.y - len);
      this.world.rayCast(from, to, (f, point, normal, frac) => {
        if (f.isSensor() || f.getFilterMaskBits() === 0) return -1;
        const u = f.getBody().getUserData();
        if (u && (u.char === this || u.kind === 'item' || u.kind === 'proj')) return -1;
        const d = frac * len;
        if (!best || d < best.d) best = { d, point: V(point.x, point.y), normal: V(normal.x, normal.y), fixture: f };
        return frac;
      });
    }
    return best;
  }

  castWall(dir) {
    const p = this.torso.getPosition();
    let hit = false;
    for (const oy of [0.3, -0.3]) {
      this.world.rayCast(V(p.x, p.y + oy), V(p.x + dir * 0.42, p.y + oy), (f) => {
        if (f.isSensor() || f.getFilterMaskBits() === 0) return -1;
        const u = f.getBody().getUserData();
        if (u && (u.char || u.kind === 'item' || u.kind === 'proj')) return -1;
        if (f.getBody().getType() === 'dynamic' && f.getBody().getMass() < 3) return -1;
        hit = true;
        return 0;
      });
    }
    return hit;
  }

  jumpPressed() { this.jumpBuffer = 0.14; }

  update(dt, input) {
    if (!this.alive) return;
    const g = this.game;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.pickupCd = Math.max(0, this.pickupCd - dt);
    this.jumpLock = Math.max(0, this.jumpLock - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.stun = Math.max(0, this.stun - dt);
    const frozen = g.freeze > 0;
    const t = this.torso;
    const p = t.getPosition();
    const v = t.getLinearVelocity();
    const M = this.mass;
    const grav = -g.world.getGravity().y;

    const sh = this.shoulder();
    this.aim = Math.atan2(input.ay - sh.y, input.ax - sh.x);
    if (!isFinite(this.aim)) this.aim = 0;
    const aimFace = Math.cos(this.aim) >= 0 ? 1 : -1;

    const stunned = this.stun > 0;
    const crouch = input.d && !frozen;
    const move = frozen ? 0 : (input.r ? 1 : 0) - (input.l ? 1 : 0);
    this.facing = aimFace;

    // --- ground / hover
    const hit = this.jumpLock > 0 ? null : this.castGround();
    const rest = crouch ? CROUCH_REST : REST;
    this.grounded = false;
    this.groundFixture = null;
    let gvx = 0, gvy = 0, ice = false;
    if (hit) {
      const hu = hit.fixture.getUserData() || {};
      if (hu.bounce && !stunned && hit.d < rest + 0.1) {
        this.setAllVel(v.x, hu.bounce);
        this.jumpLock = 0.25;
        g.event(['bounce', r2(hit.point.x), r2(hit.point.y)]);
      } else if (hit.d < rest + 0.12) {
        const gb = hit.fixture.getBody();
        const gv = gb.getLinearVelocityFromWorldPoint(hit.point);
        gvx = gv.x; gvy = gv.y;
        ice = !!hu.ice;
        this.grounded = true;
        this.groundBody = gb;
        this.groundFixture = hit.fixture;
        if (!stunned) {
          const rel = v.y - gvy;
          let acc = 260 * (rest - hit.d) - 26 * rel + grav;
          acc = clamp(acc, 0, 90);
          const F = V(0, acc * M);
          t.applyForceToCenter(F, true);
          if (gb.getType() === 'dynamic') gb.applyForce(V(0, -Math.min(acc, grav * 1.6) * M), hit.point, true);
        }
      }
    }
    if (this.grounded) this.coyote = 0.1; else this.coyote = Math.max(0, this.coyote - dt);

    if (!stunned) {
      // upright
      const ang = wrap(t.getAngle());
      const lean = clamp(-(v.x - gvx) * 0.02, -0.15, 0.15);
      t.applyTorque(clamp(-(ang - lean) * 320 - t.getAngularVelocity() * 34, -400, 400), true);

      // walk
      const speed = crouch && this.grounded ? CROUCH_SPEED : SPEED;
      const target = move * speed + (this.grounded ? gvx : 0);
      const gain = this.grounded ? (ice ? 1.6 : 22) : 7;
      const maxA = this.grounded ? (ice ? 8 : 70) : 30;
      let ax = clamp((target - v.x) * gain, -maxA, maxA);
      if (!this.grounded && move === 0) ax *= 0.15;
      t.applyForceToCenter(V(ax * M, 0), true);

      // wind etc.
      if (g.wind) t.applyForceToCenter(V(g.wind * M, 0), true);

      // fast fall
      if (input.d && !this.grounded) t.applyForceToCenter(V(0, -35 * M), true);

      // walls
      this.wallSide = 0;
      if (!this.grounded) {
        if (this.castWall(1)) this.wallSide = 1;
        else if (this.castWall(-1)) this.wallSide = -1;
        if (this.wallSide && move === this.wallSide && v.y < -2.5) t.applyForceToCenter(V(0, (-2.5 - v.y) * 12 * M), true);
      }

      // jump
      if (this.jumpBuffer > 0 && !frozen) {
        if (this.coyote > 0) {
          this.setAllVel(v.x, JUMP + Math.max(0, gvy));
          if (this.groundBody && this.groundBody.getType() === 'dynamic' && hit) {
            this.groundBody.applyLinearImpulse(V(0, -M * 3), hit.point, true);
          }
          this.jumpBuffer = 0; this.coyote = 0; this.jumpLock = 0.2;
          g.event(['jump', r2(p.x), r2(p.y - 1.2)]);
        } else if (this.wallSide) {
          this.setAllVel(-this.wallSide * 8.5, JUMP * 0.92);
          this.jumpBuffer = 0; this.jumpLock = 0.18;
          g.event(['jump', r2(p.x + this.wallSide * 0.3), r2(p.y)]);
        }
      }
    }

    this.animate(dt, move, crouch, stunned, gvx);
  }

  setAllVel(vx, vy) {
    for (const b of this.bodies) {
      const bv = b.getLinearVelocity();
      b.setLinearVelocity(V(vx + (bv.x - this.torso.getLinearVelocity().x) * 0.3, vy));
    }
  }

  animate(dt, move, crouch, stunned, gvx) {
    const f = this.facing;
    const tA = this.torso.getAngle();
    const relVx = this.torso.getLinearVelocity().x - gvx;
    const torque = stunned ? 3 : 1;

    // legs
    let hips, knees;
    if (!this.grounded) {
      hips = [f * 0.7, f * -0.25];
      knees = [-f * 1.3, -f * 0.5];
    } else if (crouch) {
      hips = [f * 1.3, f * 0.5];
      knees = [-f * 2.1, -f * 1.6];
    } else {
      const amt = clamp(Math.abs(relVx) / SPEED, 0, 1);
      this.phase += relVx * f * dt * 3.3;
      const s = Math.sin(this.phase);
      hips = [f * (s * 0.85 * amt + 0.1), f * (-s * 0.85 * amt - 0.1)];
      knees = [-f * (0.25 + Math.max(0, -Math.cos(this.phase)) * 1.1 * amt), -f * (0.25 + Math.max(0, Math.cos(this.phase)) * 1.1 * amt)];
    }
    for (let i = 0; i < 2; i++) {
      if (stunned) {
        this.legs[i].hj.setMaxMotorTorque(torque); this.legs[i].hj.setMotorSpeed(0);
        this.legs[i].kj.setMaxMotorTorque(torque); this.legs[i].kj.setMotorSpeed(0);
      } else {
        this.motor(this.legs[i].hj, hips[i], 14, 90);
        this.motor(this.legs[i].kj, knees[i], 14, 60);
      }
    }

    // arms
    const aimRel = this.aim + Math.PI / 2 - tA;
    const w = this.weapon ? C.WEAPONS[this.weapon.type] : null;
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i];
      if (stunned) {
        arm.sj.setMaxMotorTorque(torque); arm.sj.setMotorSpeed(0);
        arm.ej.setMaxMotorTorque(torque); arm.ej.setMotorSpeed(0);
        continue;
      }
      const punching = this.punchT > 0 && this.punchArm === i;
      if (punching) {
        this.motor(arm.sj, aimRel, 40, 400);
        this.motor(arm.ej, 0, 40, 300);
      } else if (w && (i === 0 || w.twoHand)) {
        this.motor(arm.sj, aimRel + (i === 1 ? -0.12 * f : 0), 30, 160);
        this.motor(arm.ej, i === 1 ? f * 0.35 : 0, 25, 80);
      } else if (!w) {
        // fists up, boxer style, loosely toward aim
        this.motor(arm.sj, aimRel + f * (i === 0 ? -0.9 : -1.3), 12, 50);
        this.motor(arm.ej, f * (i === 0 ? 1.9 : 2.1), 12, 40);
      } else {
        const swing = this.grounded ? Math.cos(this.phase) * 0.5 * clamp(Math.abs(relVx) / SPEED, 0, 1) : -0.8;
        this.motor(arm.sj, -f * 0.15 + f * swing, 8, 30);
        this.motor(arm.ej, f * 0.4, 8, 20);
      }
    }
    this.neck.setMaxMotorTorque(stunned ? 0.5 : 8);
    this.neck.setMotorSpeed(stunned ? 0 : clamp(-this.neck.getJointAngle() * 8, -10, 10));
    this.punchT = Math.max(0, this.punchT - dt);
  }

  damage(amount, by, stun = 0) {
    if (!this.alive) return;
    if (this.game.freeze > 0) return;
    this.hp -= amount;
    if (by && by !== this) this.lastHitBy = by;
    this.stun = Math.max(this.stun, stun);
    if (this.hp <= 0) this.die(by);
  }

  die(by) {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    for (const b of this.bodies) {
      for (let f = b.getFixtureList(); f; f = f.getNext()) {
        f.setFilterData({ groupIndex: this.group, categoryBits: C.CAT_BODY, maskBits: C.CAT_WORLD | C.CAT_BODY | C.CAT_PROJ });
      }
      b.setAngularDamping(0.3);
    }
    for (const j of this.joints) { j.setMaxMotorTorque(1.2); j.setMotorSpeed(0); }
    // comedic death spin
    this.torso.applyAngularImpulse((Math.random() - 0.5) * 6, true);
    if (this.weapon) this.game.throwWeapon(this, 4);
    const killer = by && by !== this ? by : this.lastHitBy;
    this.game.onDeath(this, killer);
  }
}

function r2(n) { return Math.round(n * 100) / 100; }

module.exports = { Character, DIM, wrap };

// Server-side bot: produces the same input messages a real client would send.
const pl = require('planck');
const C = require('./constants');
const V = pl.Vec2;

class Bot {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this.msg = { l: 0, r: 0, d: 0, j: 0, s: 0, th: 0, ax: 0, ay: 0 };
    this.thinkIn = 0;
    this.stuckT = 0;
    this.lastX = 0;
    this.aimErr = 0;
    this.shootT = 0;
  }

  solidBelow(x, y, depth) {
    let hit = false;
    this.game.world.rayCast(V(x, y), V(x, y - depth), (f) => {
      const u = f.getBody().getUserData() || {};
      if (f.isSensor() || u.kind === 'part' || u.kind === 'item' || u.kind === 'proj' || (f.getUserData() || {}).hazard) return -1;
      hit = true;
      return 0;
    });
    return hit;
  }

  clearShot(from, to) {
    let blocked = false;
    this.game.world.rayCast(from, to, (f) => {
      const b = f.getBody(), u = b.getUserData() || {};
      if (f.isSensor() || u.kind !== 'prop' || b.getType() === 'dynamic') return -1;
      blocked = true;
      return 0;
    });
    return !blocked;
  }

  think() {
    const c = this.player.char, g = this.game, m = this.msg;
    if (!c || !c.alive || !g.world) { m.l = m.r = m.j = m.s = 0; return m; }
    const me = c.chest.getPosition();

    // re-plan a few times per second, keep aiming every tick
    if (--this.thinkIn <= 0) {
      this.thinkIn = 5 + Math.floor(Math.random() * 4);
      let target = null, td = Infinity;
      for (const o of g.chars) {
        if (o === c || !o.alive) continue;
        const p = o.chest.getPosition(), d = Math.hypot(p.x - me.x, p.y - me.y);
        if (d < td) { td = d; target = o; }
      }
      this.target = target;

      let goal = target ? target.chest.getPosition() : null;
      if (!c.weapon) {
        let item = null, id = 14;
        for (const it of g.items.values()) {
          if (it.ammo <= 0 || it.noPick > 0) continue;
          const p = it.body.getPosition(), d = Math.hypot(p.x - me.x, p.y - me.y);
          if (d < id) { id = d; item = it; }
        }
        if (item && id < td * 1.2) goal = item.body.getPosition();
      }

      m.l = m.r = m.d = 0;
      let want = 0;
      if (goal) {
        const dx = goal.x - me.x;
        const keep = c.weapon && goal === (target && target.chest.getPosition()) ? 7 : 0.6;
        if (Math.abs(dx) > keep) want = Math.sign(dx);
        else if (c.weapon && Math.abs(dx) < 2.5 && Math.random() < 0.5) want = -Math.sign(dx);
      }
      // don't walk off ledges unless the goal is below
      if (want && !this.solidBelow(me.x + want * 1.4, me.y, 14) && !(goal && goal.y < me.y - 3)) want = 0;
      if (want > 0) m.r = 1; else if (want < 0) m.l = 1;

      // jump when the goal is higher, when stuck, or at a wall
      const moved = Math.abs(me.x - this.lastX);
      this.stuckT = want && moved < 0.25 ? this.stuckT + 1 : 0;
      this.lastX = me.x;
      const jump = (goal && goal.y > me.y + 2 && Math.abs(goal.x - me.x) < 8) || this.stuckT > 1 || c.wallSide !== 0 || Math.random() < 0.04;
      m.j = jump ? 1 : 0;

      this.aimErr = (Math.random() - 0.5) * 1.2;
    } else if (m.j) {
      m.j = 0;   // release so the next press counts
    }

    const t = this.target;
    if (t) {
      const tp = t.chest.getPosition();
      m.ax = tp.x;
      m.ay = tp.y + this.aimErr;
      const d = Math.hypot(tp.x - me.x, tp.y - me.y);
      const w = c.weapon && C.WEAPONS[c.weapon.type];
      let fire = false;
      if (w) fire = d < 26 && this.clearShot(c.shoulder(), tp);
      else fire = d < 1.6;
      // semi-auto weapons and punches need fresh presses
      this.shootT--;
      if (fire && (w && w.auto ? true : this.shootT <= 0)) {
        m.s = w && w.auto ? 1 : (m.s ? 0 : 1);
        if (!(w && w.auto)) this.shootT = m.s ? 2 : 6 + Math.floor(Math.random() * 10);
      } else if (!fire) m.s = 0;
    } else m.s = 0;
    return m;
  }
}

module.exports = { Bot };

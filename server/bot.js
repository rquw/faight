// Server-side bot: produces the same input messages a real client would send.
// Moves along the navigation graph (walk / jump / wall climb), falls back to direct steering.
const pl = require('planck');
const C = require('./constants');
const nav = require('./nav');
const V = pl.Vec2;

class Bot {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this.msg = { l: 0, r: 0, d: 0, j: 0, s: 0, th: 0, ax: 0, ay: 0 };
    this.thinkIn = 0;
    this.path = null;
    this.pathAt = -1;
    this.goalKey = null;
    this.ignoreItems = new Map();   // item id -> time until which it counts as unreachable
    this.lastProgress = { x: 0, y: 0, t: 0 };
    this.jumpHeld = 0;
    this.aimErr = 0;
    this.shootT = 0;
    this.escape = 0;
  }

  graph() {
    const g = this.game;
    // rebuilding costs a few ms, so dynamic maps refresh a few times per round, not twice a second
    if (!g.nav || g.nav.world !== g.world || (g.nav.dynamic && g.time - g.nav.builtAt > 3.5)) {
      g.nav = nav.build(g);
      g.nav.world = g.world;
    }
    return g.nav;
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

  // is there safe ground below this x (within depth)? hazards count as no ground
  safeBelow(x, y, depth) {
    let safe = false, best = 1;
    this.game.world.rayCast(V(x, y), V(x, y - depth), (f, p, n, frac) => {
      const u = f.getBody().getUserData() || {};
      if (f.isSensor() || u.kind === 'part' || u.kind === 'item' || u.kind === 'proj') return -1;
      if (frac < best) { best = frac; safe = !(f.getUserData() || {}).hazard; }
      return frac;
    });
    return safe;
  }

  // a wall right in front at knee/chest height
  blocked(hip, dir) {
    let hit = false;
    for (const oy of [-0.5, 0.4]) {
      this.game.world.rayCast(V(hip.x, hip.y + oy), V(hip.x + dir * 0.9, hip.y + oy), (f) => {
        const b = f.getBody(), u = b.getUserData() || {};
        if (f.isSensor() || u.kind !== 'prop' || (b.getType() === 'dynamic' && b.getMass() < 3)) return -1;
        hit = true;
        return 0;
      });
    }
    return hit;
  }

  pressJump() { this.msg.j = 1; this.jumpHeld = 2; }

  think() {
    const c = this.player.char, g = this.game, m = this.msg;
    if (!c || !c.alive || !g.world) { m.l = m.r = m.j = m.s = 0; return m; }
    if (this.jumpHeld > 0 && --this.jumpHeld === 0) m.j = 0;   // release so the next press counts
    const me = c.chest.getPosition(), hip = c.hip.getPosition();
    const feetY = hip.y - 1.08;

    // ---- choose a goal a few times per second
    if (--this.thinkIn <= 0) {
      this.thinkIn = 6;
      let target = null, td = Infinity;
      for (const o of g.chars) {
        if (o === c || !o.alive) continue;
        const p = o.chest.getPosition(), d = Math.hypot(p.x - me.x, p.y - me.y);
        if (d < td) { td = d; target = o; }
      }
      this.target = target;
      let goal = target ? { x: target.chest.getPosition().x, y: target.hip.getPosition().y - 1.08, key: 'p' + target.player.id } : null;
      if (!c.weapon) {
        let best = null, bd = target ? Math.min(40, td * 1.5) : Infinity;
        for (const it of g.items.values()) {
          if (it.ammo <= 0 || it.noPick > 0 || (this.ignoreItems.get(it.id) || 0) > g.time) continue;
          const p = it.body.getPosition(), d = Math.hypot(p.x - me.x, p.y - me.y);
          if (d < bd) { bd = d; best = it; }
        }
        if (best) { const p = best.body.getPosition(); goal = { x: p.x, y: p.y - 0.2, key: 'i' + best.id, item: best }; }
      }
      this.goal = goal;

      // ---- (re)plan along the graph
      const graph = this.graph();
      if (goal && (goal.key !== this.goalKey || g.time - this.pathAt > 0.6)) {
        this.goalKey = goal.key;
        this.pathAt = g.time;
        let from = nav.nearestNode(graph, hip.x, feetY, 4, true);
        if (from < 0) from = nav.nearestNode(graph, hip.x, feetY, 7);   // standing on a crate or in the air
        const to = nav.nearestNode(graph, goal.x, goal.y, 5);
        this.path = nav.findPath(graph, from, to);
        this.pathGraph = graph;
        this.step = 1;
        if (!this.path && goal.item && from >= 0) this.ignoreItems.set(goal.item.id, g.time + 4);
      }

      // ---- stuck? try something else for a moment
      const moved = Math.hypot(me.x - this.lastProgress.x, me.y - this.lastProgress.y);
      if (moved > 1.2) this.lastProgress = { x: me.x, y: me.y, t: g.time };
      else if (g.time - this.lastProgress.t > 1.4) {
        this.escape = 0.6;
        this.escapeDir = Math.random() < 0.5 ? -1 : 1;
        this.lastProgress = { x: me.x, y: me.y, t: g.time };
        this.pathAt = -1;
        if (this.goal && this.goal.item) this.ignoreItems.set(this.goal.item.id, g.time + 3);
      }
      this.aimErr = (Math.random() - 0.5) * 1.2;
    }

    // ---- steering
    m.l = m.r = 0;
    let want = 0, jump = false;
    const graph = g.nav;
    if (this.path && this.pathGraph !== graph) { this.path = null; this.pathAt = -1; this.thinkIn = 0; }
    if (this.escape > 0) {
      this.escape -= 1 / 60;
      want = this.escapeDir;
      jump = true;
    } else if (this.path && graph && this.path.length > 1) {
      // advance past waypoints we've reached
      while (this.step < this.path.length) {
        const n = graph.nodes[this.path[this.step]];
        if (Math.abs(n.x - hip.x) < 0.7 && feetY > n.y - 0.6 && feetY < n.y + 1.5 && c.grounded) this.step++;
        else break;
      }
      if (this.step < this.path.length) {
        const n = graph.nodes[this.path[this.step]];
        const type = nav.edgeType(graph, this.path[this.step - 1], this.path[this.step]);
        const dx = n.x - hip.x, dy = n.y - feetY;
        if (Math.abs(dx) > 0.35) want = Math.sign(dx);
        if (type === 'climb') {
          // hug the wall and keep jumping
          jump = dy > 0.4;
          if (Math.abs(dx) <= 0.35) want = c.wallSide || Math.sign(dx) || 0;
        } else if (type === 'jump') {
          const gap = !this.solidBelow(hip.x + Math.sign(dx) * 0.9, hip.y, 3);
          jump = (dy > 0.5 && Math.abs(dx) < 3.2) || (gap && c.grounded) || (c.wallSide !== 0 && dy > 0);
        } else if (dy > 0.8 || c.wallSide !== 0 || (want !== 0 && this.blocked(hip, want))) {
          jump = true;
        }
      } else if (this.goal) {
        want = Math.abs(this.goal.x - hip.x) > 0.6 ? Math.sign(this.goal.x - hip.x) : 0;
      }
    } else if (this.goal) {
      // no graph path: steer directly, climb anything in the way, don't run off ledges
      const dx = this.goal.x - hip.x;
      if (Math.abs(dx) > 0.8) want = Math.sign(dx);
      if (want && !this.solidBelow(hip.x + want * 1.4, hip.y, 14) && this.goal.y > feetY - 3) want = 0;
      jump = this.goal.y > feetY + 1.5 || c.wallSide !== 0 || (want !== 0 && this.blocked(hip, want));
    }

    // never walk off into the void / hazards unless the path explicitly jumps or drops there
    this.edgeOk = false;
    if (this.path && graph && this.step < this.path.length && this.escape <= 0) {
      const n = graph.nodes[this.path[this.step]];
      const type = nav.edgeType(graph, this.path[this.step - 1], this.path[this.step]);
      this.edgeOk = (type === 'jump' || n.y < feetY - 0.5) && Math.sign(n.x - hip.x) === want;
    }
    if (want && !this.edgeOk && !this.safeBelow(hip.x + want * 1.2, hip.y, 26)) {
      if (c.grounded) want = 0;
      else if (this.safeBelow(hip.x - want * 1.5, hip.y, 26)) want = -want;   // steer back over ground
    }

    // keep some distance when armed and the target is right there
    const w = c.weapon && C.WEAPONS[c.weapon.type];
    const t = this.target;
    if (w && t && this.goal && this.goal.key === 'p' + t.player.id && this.escape <= 0) {
      const d = Math.abs(t.chest.getPosition().x - me.x);
      if (d < 7 && this.clearShot(c.shoulder(), t.chest.getPosition())) want = d < 3 ? -Math.sign(t.chest.getPosition().x - me.x) : 0;
    }
    if (want > 0) m.r = 1; else if (want < 0) m.l = 1;
    if (jump && !m.j && this.jumpHeld === 0 && c.sinceJumped > 0.32) this.pressJump();

    // ---- aim and fire
    if (t) {
      const tp = t.chest.getPosition();
      m.ax = tp.x;
      m.ay = tp.y + this.aimErr;
      const d = Math.hypot(tp.x - me.x, tp.y - me.y);
      const fire = w ? d < 26 && this.clearShot(c.shoulder(), tp) : d < 1.6;
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

// Navigation graph for bots: standable points on level surfaces, connected by walking,
// jumping/falling (clear arc) and wall climbing (a wall to climb along and room above it).
const pl = require('planck');
const V = pl.Vec2;

const MAX_JUMP_UP = 3.8, MAX_JUMP_DX = 7, MAX_CLIMB = 14, MAX_DROP = 20, BODY_H = 2.1;

function isSolid(f) {
  if (f.isSensor()) return false;
  const u = f.getBody().getUserData() || {};
  if (u.kind !== 'prop') return false;
  if ((f.getUserData() || {}).hazard) return false;
  const b = f.getBody();
  return !(b.getType() === 'dynamic' && b.getMass() < 6);   // loose crates don't block paths
}

function rayClear(world, x1, y1, x2, y2) {
  if (Math.abs(x1 - x2) < 1e-3 && Math.abs(y1 - y2) < 1e-3) return true;
  let clear = true;
  world.rayCast(V(x1, y1), V(x2, y2), (f) => { if (!isSolid(f)) return -1; clear = false; return 0; });
  return clear;
}

function boxFree(world, x0, y0, x1, y1) {
  let free = true;
  world.queryAABB(pl.AABB(V(x0, y0), V(x1, y1)), (f) => {
    if (!isSolid(f)) return true;
    // AABB overlap isn't exact for rotated shapes; confirm with a point test in the middle column
    for (let y = y0; y <= y1; y += 0.5) if (f.testPoint(V((x0 + x1) / 2, y))) { free = false; return false; }
    return true;
  });
  return free;
}

function build(game) {
  const world = game.world;
  const nodes = [];
  const surfaces = [];
  for (const b of game.props.values()) {
    const u = b.getUserData();
    if (!u || u.desc.s !== 'b' || u.desc.hz) continue;
    if (b.getType() === 'dynamic' && (u.size.w < 1.5 || b.getMass() < 3)) continue;
    const a = b.getAngle();
    if (Math.abs(Math.sin(a)) > 0.35) continue;
    const p = b.getPosition();
    const hw = Math.abs(u.size.w / 2 * Math.cos(a)) + Math.abs(u.size.h / 2 * Math.sin(a));
    const hh = Math.abs(u.size.w / 2 * Math.sin(a)) + Math.abs(u.size.h / 2 * Math.cos(a));
    surfaces.push({ x0: p.x - hw, x1: p.x + hw, y: p.y + hh, body: b });
  }
  for (const s of surfaces) {
    const width = s.x1 - s.x0;
    if (width < 0.6) continue;
    const count = Math.max(1, Math.ceil((width - 0.6) / 1.25));
    const idxs = [];
    for (let i = 0; i <= count; i++) {
      const x = count === 0 ? (s.x0 + s.x1) / 2 : s.x0 + 0.3 + (i / count) * (width - 0.6);
      if (!boxFree(world, x - 0.15, s.y + 0.15, x + 0.15, s.y + BODY_H)) continue;
      idxs.push(nodes.length);
      nodes.push({ x, y: s.y, surface: s, edges: [] });
    }
    for (let i = 1; i < idxs.length; i++) {
      const a = nodes[idxs[i - 1]], b = nodes[idxs[i]];
      if (!rayClear(world, a.x, a.y + 1, b.x, b.y + 1)) continue;
      const d = Math.abs(b.x - a.x);
      a.edges.push({ to: idxs[i], cost: d, type: 'walk' });
      b.edges.push({ to: idxs[i - 1], cost: d, type: 'walk' });
    }
  }
  // only node pairs that are close enough in x can ever be connected, so walk a sorted window
  // instead of testing every pair (the ray casts inside dominate the build cost)
  const connect = (i, j) => {
    const a = nodes[i], b = nodes[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    // same surface: only needed when something (a low wall) blocks walking between them
    if (a.surface === b.surface && (Math.abs(dx) > 4 || a.edges.some(e => e.to === j))) return;
    if (Math.abs(dx) > MAX_JUMP_DX || dy < -MAX_DROP || dy > MAX_CLIMB) return;
    if (dy <= MAX_JUMP_UP) {
      // try a few arc heights (low hop, full jump, over a parapet when dropping down)
      const base = Math.max(a.y, b.y);
      const peaks = dy > 0.3 ? [base + 2.3] : [base + 1.2, base + 2.3, a.y + 3.6];
      const arc = peaks.find(peak => peak <= a.y + 4.4 && rayClear(world, a.x, a.y + 1, a.x, peak) && rayClear(world, a.x, peak, b.x, peak) && rayClear(world, b.x, peak, b.x, b.y + 1));
      if (arc != null) {
        a.edges.push({ to: j, cost: Math.abs(dx) + Math.max(0, dy) * 1.5 + (arc > base + 1.5 ? 2.5 : 1.5), type: dy > 0.3 || Math.abs(dx) > 1.5 || arc > base + 1.5 ? 'jump' : 'walk' });
      } else if (dy < -0.5 && rayClear(world, a.x, a.y + 1, b.x, a.y + 1) && rayClear(world, b.x, a.y + 1, b.x, b.y + 1)) {
        a.edges.push({ to: j, cost: Math.abs(dx) + 1, type: 'walk' });
      }
    } else if (Math.abs(dx) <= 3.2) {
      // wall climb: something solid to cling to beside the climb column, clear column and room on top
      const side = Math.sign(dx) || 1;
      const midY = a.y + dy / 2;
      let wall = false;
      world.rayCast(V(a.x, midY), V(a.x + side * (Math.abs(dx) + 0.6), midY), (f) => { if (!isSolid(f)) return -1; wall = true; return 0; });
      if (wall && rayClear(world, a.x, a.y + 1, a.x, b.y + 2.3) && rayClear(world, a.x, b.y + 2.3, b.x, b.y + 2.3)) {
        a.edges.push({ to: j, cost: Math.abs(dx) + dy * 2.2 + 2, type: 'climb' });
      }
    }
  };
  const order = nodes.map((n, i) => i).sort((p, q) => nodes[p].x - nodes[q].x);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (nodes[j].x - nodes[i].x > MAX_JUMP_DX) break;
      connect(i, j);
      connect(j, i);
    }
  }
  return { nodes, dynamic: surfaces.some(s => s.body.getType() !== 'static'), builtAt: game.time };
}

function nearestNode(nav, x, y, maxDist, below = false) {
  let best = -1, bd = maxDist;
  for (let i = 0; i < nav.nodes.length; i++) {
    const n = nav.nodes[i];
    if (below && (n.y > y + 0.8 || n.y < y - 3)) continue;
    const d = Math.abs(n.x - x) + Math.abs(n.y - y) * 1.5;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Dijkstra; returns node indices from start to goal (inclusive) or null
function findPath(nav, from, to) {
  if (from < 0 || to < 0) return null;
  if (from === to) return [from];
  const n = nav.nodes.length;
  const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  dist[from] = 0;
  for (;;) {
    let u = -1, ud = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < ud) { ud = dist[i]; u = i; }
    if (u < 0) return null;
    if (u === to) break;
    done[u] = 1;
    for (const e of nav.nodes[u].edges) {
      const nd = ud + e.cost;
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; }
    }
  }
  const path = [];
  for (let v = to; v >= 0; v = prev[v]) path.push(v);
  return path.reverse();
}

function edgeType(nav, a, b) {
  const e = nav.nodes[a].edges.find(e => e.to === b);
  return e ? e.type : 'walk';
}

module.exports = { build, nearestNode, findPath, edgeType };

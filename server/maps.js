// Map builders. Each gets a context `m` (see Game.buildMap) with W/H scaled to player count.
// m.rect(cx, cy, w, h, opts) / m.circle(cx, cy, r, opts) create bodies,
// m.spawn(x, groundY) registers a spawn, m.tick(fn) adds per-tick logic.
const pl = require('planck');
const V = pl.Vec2;

const STONE = '#3a3f4b', WOOD = '#9a6a3c', CRATE = '#c08a45', METAL = '#6b7788';

const maps = [
  {
    name: 'Arena', bg: '#e9dcc3',
    build(m) {
      const { W, H } = m;
      m.rect(W / 2, H * 0.18, W * 0.62, 1.2);
      m.rect(W * 0.2, H * 0.44, W * 0.18, 0.6);
      m.rect(W * 0.8, H * 0.44, W * 0.18, 0.6);
      m.rect(W / 2, H * 0.64, W * 0.2, 0.6);
      m.rect(W / 2 - W * 0.31 + 0.4, H * 0.18 + 1.2, 0.8, 1.2);
      m.rect(W / 2 + W * 0.31 - 0.4, H * 0.18 + 1.2, 0.8, 1.2);
      for (let i = 0; i < Math.ceil(m.n / 2) + 2; i++) m.crate(W * 0.3 + Math.random() * W * 0.4, H * 0.18 + 1.5 + i * 1.1, 1);
      m.spawnRow(W / 2 - W * 0.28, W / 2 + W * 0.28, H * 0.18 + 0.6);
      m.spawnRow(W * 0.13, W * 0.27, H * 0.44 + 0.3);
      m.spawnRow(W * 0.73, W * 0.87, H * 0.44 + 0.3);
    },
  },
  {
    name: 'Kistenlager', bg: '#d7e3d0',
    build(m) {
      // pits filled with loose crates as floor – shoot them away and fall into spikes
      const { W, H } = m;
      const floorY = H * 0.3, s = 1.1;
      m.rect(W / 2, H * 0.06, W * 0.86, 0.6, { hazard: 'spike', color: '#555' });
      const segs = 5;
      const segW = (W * 0.86) / segs;
      for (let i = 0; i < segs; i++) {
        const x0 = W * 0.07 + i * segW;
        if (i % 2 === 0) {
          m.rect(x0 + segW / 2, floorY / 2 + H * 0.06, segW, floorY - H * 0.06 + 0.6, { color: STONE });
          m.spawnRow(x0 + 1, x0 + segW - 1, floorY + 0.3);
        } else {
          const cols = Math.floor(segW / s);
          for (let c = 0; c < cols; c++) for (let r = 0; r < 3; r++) {
            m.crate(x0 + s / 2 + c * (segW / cols), floorY + 0.3 - s / 2 - r * s, s * 0.98);
          }
          m.rect(x0 + segW / 2, floorY - 3 * s - 0.3, segW, 0.3, { color: WOOD, breakAt: 12 + Math.random() * 10 });
        }
      }
      m.rect(W * 0.3, H * 0.62, W * 0.12, 0.5);
      m.rect(W * 0.7, H * 0.62, W * 0.12, 0.5);
    },
  },
  {
    name: 'Wippe', bg: '#cfe0ef',
    build(m) {
      const { W, H } = m;
      const pivot = m.rect(W / 2, H * 0.28, 0.8, 0.8, { color: METAL });
      const plank = m.rect(W / 2, H * 0.28 + 0.7, W * 0.62, 0.5, { dynamic: true, density: 3, color: WOOD, angularDamping: 0.4 });
      m.world.createJoint(pl.RevoluteJoint({ enableLimit: true, lowerAngle: -0.45, upperAngle: 0.45 }, pivot, plank, V(W / 2, H * 0.28 + 0.7)));
      m.rect(W * 0.06, H * 0.5, W * 0.1, 0.5);
      m.rect(W * 0.94, H * 0.5, W * 0.1, 0.5);
      for (let i = 0; i < 3 + m.n; i++) m.crate(W * 0.25 + Math.random() * W * 0.5, H * 0.45 + i, 0.9);
      m.spawnRow(W * 0.25, W * 0.75, H * 0.28 + 1);
    },
  },
  {
    name: 'Lava', bg: '#3b1e22', dark: true,
    build(m) {
      const { W, H } = m;
      const lava = m.rect(W / 2, -H * 0.36, W * 2, H * 0.6, { kinematic: true, hazard: 'lava', color: '#ff5a1f' });
      m.tick((t) => lava.setLinearVelocity(V(0, t > 6 && lava.getPosition().y < H * 0.45 ? 0.45 : 0)));
      const rows = 6;
      for (let r = 0; r < rows; r++) {
        const y = H * 0.16 + r * H * 0.135;
        const cnt = r % 2 ? 3 : 4;
        for (let i = 0; i < cnt; i++) {
          const x = W * (0.12 + (0.76 * i) / (cnt - 1));
          m.rect(x, y, W * 0.11, 0.5, { color: '#2a2a2a' });
          if (r < 2) m.spawn(x, y + 0.25);
        }
      }
    },
  },
  {
    name: 'Mond', bg: '#1d2240', dark: true, gravity: -11,
    build(m) {
      const { W, H } = m;
      const isl = [[0.2, 0.2, 0.2], [0.5, 0.35, 0.16], [0.8, 0.2, 0.2], [0.35, 0.6, 0.12], [0.65, 0.6, 0.12], [0.5, 0.82, 0.1]];
      for (const [x, y, w] of isl) {
        m.rect(W * x, H * y, W * w, 0.7, { color: '#8a8fa8' });
        if (y < 0.5) m.spawnRow(W * (x - w / 2) + 0.8, W * (x + w / 2) - 0.8, H * y + 0.35);
      }
      for (let i = 0; i < 4; i++) m.circle(W * (0.2 + i * 0.2), H * 0.9, 0.7, { dynamic: true, density: 1, color: '#c9c9d9', restitution: 0.5 });
    },
  },
  {
    name: 'Aufzüge', bg: '#e4d6ea',
    build(m) {
      const { W, H } = m;
      m.rect(W * 0.07, H * 0.3, W * 0.12, 0.6);
      m.rect(W * 0.93, H * 0.3, W * 0.12, 0.6);
      m.spawnRow(W * 0.03, W * 0.11, H * 0.3 + 0.3);
      m.spawnRow(W * 0.89, W * 0.97, H * 0.3 + 0.3);
      const cnt = 3 + Math.floor(m.n / 3);
      for (let i = 0; i < cnt; i++) {
        const x = W * (0.22 + (0.56 * i) / Math.max(1, cnt - 1));
        const vertical = i % 2 === 0;
        const base = V(x, H * 0.4);
        const p = m.rect(x, base.y, 3.2, 0.5, { kinematic: true, color: METAL });
        const ph = Math.random() * 6;
        m.tick((t) => {
          const w = 0.7, a = vertical ? H * 0.28 : W * 0.06;
          const vel = Math.cos(t * w + ph) * a * w;
          p.setLinearVelocity(vertical ? V(0, vel) : V(vel, 0));
        });
        m.spawn(x, base.y + 0.25 + Math.sin(ph) * 0);
      }
      m.rect(W / 2, H * 0.85, W * 0.2, 0.5);
    },
  },
  {
    name: 'Windmühle', bg: '#d8ecd5',
    build(m) {
      const { W, H } = m;
      m.rect(W * 0.15, H * 0.2, W * 0.26, 1);
      m.rect(W * 0.85, H * 0.2, W * 0.26, 1);
      m.spawnRow(W * 0.05, W * 0.26, H * 0.2 + 0.5);
      m.spawnRow(W * 0.74, W * 0.95, H * 0.2 + 0.5);
      const cx = W / 2, cy = H * 0.45, L = Math.min(H * 0.7, W * 0.32);
      const hub = m.rect(cx, cy, L, 0.6, { kinematic: true, color: WOOD });
      const hub2 = m.rect(cx, cy, 0.6, L, { kinematic: true, color: WOOD });
      m.tick((t) => {
        const w = 0.55 + 0.35 * Math.sin(t * 0.15);
        hub.setAngularVelocity(w); hub2.setAngularVelocity(w);
      });
      m.rect(W * 0.15, H * 0.62, W * 0.12, 0.5);
      m.rect(W * 0.85, H * 0.62, W * 0.12, 0.5);
    },
  },
  {
    name: 'Eisbahn', bg: '#dff3ff',
    build(m) {
      const { W, H } = m;
      m.rect(W / 2, H * 0.2, W * 0.7, 0.8, { ice: true, color: '#8fd3ff' });
      m.rect(W * 0.25, H * 0.45, W * 0.2, 0.5, { ice: true, color: '#8fd3ff', angle: 0.12 });
      m.rect(W * 0.75, H * 0.45, W * 0.2, 0.5, { ice: true, color: '#8fd3ff', angle: -0.12 });
      m.rect(W / 2, H * 0.68, W * 0.16, 0.5, { color: STONE });
      for (let i = 0; i < 4; i++) m.rect(W * (0.3 + i * 0.13), H * 0.2 + 0.7, 0.9, 0.6, { dynamic: true, density: 2, friction: 0.02, color: '#bfe8ff' });
      m.spawnRow(W * 0.2, W * 0.8, H * 0.2 + 0.4);
    },
  },
  {
    name: 'Sturm', bg: '#9fb0b8',
    build(m) {
      const { W, H } = m;
      m.rect(W / 2, H * 0.22, W * 0.5, 1);
      m.rect(W * 0.14, H * 0.42, W * 0.1, 0.5);
      m.rect(W * 0.86, H * 0.42, W * 0.1, 0.5);
      m.rect(W / 2, H * 0.55, 0.6, H * 0.12, { color: STONE });
      for (let i = 0; i < 2 + m.n; i++) m.crate(W * 0.3 + Math.random() * W * 0.4, H * 0.3 + i, 0.8);
      m.spawnRow(W * 0.28, W * 0.72, H * 0.22 + 0.5);
      m.tick((t, dt, game) => {
        const cycle = t % 14;
        game.wind = cycle < 4 ? 0 : cycle < 9 ? 14 : -14;
        if (cycle < 4) game.wind = 0;
      });
    },
  },
  {
    name: 'Kistenregen', bg: '#f0e6d2',
    build(m) {
      const { W, H } = m;
      m.rect(W / 2, H * 0.2, W * 0.6, 1);
      m.rect(W * 0.18, H * 0.5, W * 0.14, 0.5);
      m.rect(W * 0.82, H * 0.5, W * 0.14, 0.5);
      m.spawnRow(W * 0.24, W * 0.76, H * 0.2 + 0.5);
      let next = 3;
      m.tick((t) => {
        if (t < next) return;
        next = t + 0.6 + Math.random() * 1.2;
        const s = 0.7 + Math.random() * 1.1;
        const b = m.crate(W * 0.15 + Math.random() * W * 0.7, H + 3, s, { temp: true });
        b.setAngularVelocity((Math.random() - 0.5) * 4);
        b.setLinearVelocity(V(0, -6));
      });
    },
  },
  {
    name: 'Hängebrücke', bg: '#e6d9c9',
    build(m) {
      const { W, H } = m;
      const y = H * 0.32;
      const cliffW = W * 0.16;
      const a = m.rect(cliffW / 2, y / 2, cliffW, y, { color: '#6d5a48' });
      const b = m.rect(W - cliffW / 2, y / 2, cliffW, y, { color: '#6d5a48' });
      m.rect(W / 2, 0.3, W * 0.6, 0.6, { hazard: 'spike', color: '#555' });
      const span = W - cliffW * 2, pw = 1.2;
      const count = Math.ceil(span / pw);
      let prev = a;
      for (let i = 0; i < count; i++) {
        const x = cliffW + pw / 2 + i * (span / count);
        const plank = m.rect(x, y - 0.15, span / count - 0.08, 0.3, { dynamic: true, density: 2, color: WOOD });
        m.world.createJoint(pl.RevoluteJoint({}, prev, plank, V(x - span / count / 2, y - 0.1)));
        prev = plank;
      }
      m.world.createJoint(pl.RevoluteJoint({}, prev, b, V(W - cliffW, y - 0.1)));
      m.spawnRow(0.8, cliffW - 0.8, y);
      m.spawnRow(W - cliffW + 0.8, W - 0.8, y);
      m.rect(W / 2, H * 0.62, W * 0.14, 0.5);
      m.crate(W / 2, H * 0.62 + 1, 1);
    },
  },
  {
    name: 'Trampolin', bg: '#ffe3ef',
    build(m) {
      const { W, H } = m;
      m.rect(W / 2, H * 0.12, W * 0.8, 0.8);
      const pads = 3 + Math.floor(m.n / 3);
      for (let i = 0; i < pads; i++) m.rect(W * (0.14 + (0.72 * i) / (pads - 1)), H * 0.12 + 0.55, 2, 0.3, { bounce: 21, color: '#ff4fa3' });
      m.rect(W * 0.3, H * 0.5, W * 0.1, 0.5);
      m.rect(W * 0.7, H * 0.5, W * 0.1, 0.5);
      m.rect(W / 2, H * 0.78, W * 0.12, 0.5);
      m.spawnRow(W * 0.12, W * 0.88, H * 0.12 + 0.4);
    },
  },
  {
    name: 'Schaukeln', bg: '#e9e2cf',
    build(m) {
      const { W, H } = m;
      m.rect(W * 0.06, H * 0.25, W * 0.1, 0.6);
      m.rect(W * 0.94, H * 0.25, W * 0.1, 0.6);
      m.spawnRow(W * 0.02, W * 0.1, H * 0.25 + 0.3);
      m.spawnRow(W * 0.9, W * 0.98, H * 0.25 + 0.3);
      const cnt = 3 + Math.floor(m.n / 2);
      for (let i = 0; i < cnt; i++) {
        const x = W * (0.2 + (0.6 * i) / (cnt - 1));
        const anchor = m.rect(x, H * 0.95, 0.4, 0.4, { color: METAL });
        const len = H * (0.45 + (i % 2) * 0.12);
        const plat = m.rect(x, H * 0.95 - len, 3.4, 0.4, { dynamic: true, density: 4, color: WOOD, angularDamping: 2 });
        m.world.createJoint(pl.DistanceJoint({}, anchor, plat, V(x, H * 0.95), V(x - 1.5, H * 0.95 - len)));
        m.world.createJoint(pl.DistanceJoint({}, anchor, plat, V(x, H * 0.95), V(x + 1.5, H * 0.95 - len)));
        m.rope(x, H * 0.95, plat, -1.5, 0.2);
        m.rope(x, H * 0.95, plat, 1.5, 0.2);
        plat.setLinearVelocity(V((Math.random() - 0.5) * 6, 0));
        m.spawn(x, H * 0.95 - len + 0.2);
      }
    },
  },
  {
    name: 'Sägewerk', bg: '#d9cbb8',
    build(m) {
      const { W, H } = m;
      m.rect(W / 2, H * 0.15, W * 0.8, 1, { color: '#5b4a3a' });
      m.rect(W * 0.25, H * 0.42, W * 0.14, 0.5);
      m.rect(W * 0.75, H * 0.42, W * 0.14, 0.5);
      m.rect(W / 2, H * 0.62, W * 0.12, 0.5);
      m.spawnRow(W * 0.15, W * 0.85, H * 0.15 + 0.5);
      m.spawnRow(W * 0.2, W * 0.3, H * 0.42 + 0.25);
      const saws = 1 + Math.floor(m.n / 4);
      for (let i = 0; i < saws; i++) {
        const saw = m.circle(W / 2, H * 0.15 + 0.5, 0.9, { kinematic: true, hazard: 'saw', color: '#c0c6cc', sensor: true });
        const ph = i * 2.1;
        m.tick((t) => {
          const on = t > 5;
          saw.setAngularVelocity(-12);
          const target = on ? W / 2 + Math.sin(t * 0.35 + ph) * W * 0.36 : W / 2 + (i - saws / 2) * 3;
          saw.setLinearVelocity(V((target - saw.getPosition().x) * 3, 0));
        });
      }
    },
  },
];

module.exports = maps;

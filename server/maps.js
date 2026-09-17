// Map builders. m.X(f) = fraction of map width; heights are absolute meters.
// m.floor(x0, x1, topY, thickness), m.wall(x, y0, y1, thickness), m.block(x0, y0, x1, y1),
// m.crate(x, bottomY, size), m.crates(x, bottomY, cols, rows, size), m.merlons(x0, x1, y)
const pl = require('planck');
const V = pl.Vec2;

const maps = [
  {
    name: 'Fabrik', sky: ['#b8b3a8', '#dcd7cc'],
    build(m) {
      const { X } = m;
      m.floor(X(0.05), X(0.95), 4, 4);
      m.wall(X(0.2), 4, 5.5, 0.5); m.wall(X(0.8), 4, 5.5, 0.5);
      // two-storey hall with windows
      m.floor(X(0.36), X(0.64), 10, 0.6);
      m.wall(X(0.36) + 0.3, 4, 5.4); m.wall(X(0.36) + 0.3, 7.8, 9.4);
      m.wall(X(0.64) - 0.3, 4, 5.4); m.wall(X(0.64) - 0.3, 7.8, 9.4);
      m.floor(X(0.42), X(0.58), 15.5, 0.6);
      m.wall(X(0.42) + 0.25, 15.5, 16.8, 0.5); m.wall(X(0.58) - 0.25, 15.5, 16.8, 0.5);
      // balconies
      m.floor(X(0.06), X(0.25), 11, 0.6); m.wall(X(0.25) - 0.25, 11, 12.4, 0.5);
      m.floor(X(0.75), X(0.94), 11, 0.6); m.wall(X(0.75) + 0.25, 11, 12.4, 0.5);
      m.floor(X(0.12), X(0.2), 17, 0.5); m.floor(X(0.8), X(0.88), 17, 0.5);
      m.crates(X(0.5), 4, 2, 2, 1.1);
      m.crates(X(0.12), 11, 1, 2, 1);
      m.crates(X(0.88), 11, 1, 2, 1);
      m.crates(X(0.29), 4, 2, 1, 1);
      m.crates(X(0.71), 4, 2, 1, 1);
      m.spawnRow(X(0.07), X(0.33), 4); m.spawnRow(X(0.67), X(0.93), 4);
      m.spawnRow(X(0.39), X(0.61), 10); m.spawnRow(X(0.07), X(0.22), 11); m.spawnRow(X(0.78), X(0.93), 11);
    },
  },
  {
    name: 'Lagerhalle', sky: ['#a9b4b6', '#d6dcd9'],
    build(m) {
      const { X } = m;
      m.floor(X(0.04), X(0.3), 4, 4); m.floor(X(0.42), X(0.58), 4, 4); m.floor(X(0.7), X(0.96), 4, 4);
      for (const [a, b] of [[0.3, 0.42], [0.58, 0.7]]) {
        m.floor(X(a), X(b), 0.8, 0.8, { hazard: 'spike' });
        m.floor(X(a), X(b), 1.3, 0.3, { breakAt: 14 + Math.random() * 12 });
        const w = X(b) - X(a), cols = Math.floor(w / 1.02);
        for (let r = 0; r < 3; r++) for (let c = 0; c < cols; c++) m.crate(X(a) + (c + 0.5) * (w / cols), 1.32 + r * 0.93, 0.92);
      }
      // shelves
      for (const [a, b] of [[0.05, 0.25], [0.75, 0.95]]) {
        m.floor(X(a), X(b), 9.5, 0.5); m.floor(X(a), X(b), 15, 0.5);
        m.crates(X((a + b) / 2) - 1.5, 9.5, 2, 2, 1); m.crates(X((a + b) / 2) + 2.5, 15, 1, 1, 1);
        m.spawnRow(X(a), X(b), 9.5);
      }
      m.crates(X(0.5), 4, 3, 3, 1.05);
      m.floor(X(0.44), X(0.56), 13, 0.5);
      m.floor(X(0.3), X(0.38), 19, 0.4); m.floor(X(0.62), X(0.7), 19, 0.4);
      m.wall(X(0.14), 4, 5.6, 0.5); m.wall(X(0.86), 4, 5.6, 0.5);
      m.spawnRow(X(0.05), X(0.28), 4); m.spawnRow(X(0.72), X(0.95), 4);
    },
  },
  {
    name: 'Burg', sky: ['#9fb1bd', '#d9dfdf'],
    build(m) {
      const { X } = m;
      const castles = [];
      for (const side of [0, 1]) {
        const x0 = side ? X(0.73) : X(0.03), x1 = side ? X(0.97) : X(0.27);
        const t0 = side ? X(0.89) : X(0.03), t1 = side ? X(0.97) : X(0.11);
        castles.push(m.block(x0, 0, x1, 9));
        m.merlons(side ? x0 + 0.5 : t1 + 0.8, side ? t0 - 0.8 : x1 - 0.5, 9);
        m.block(t0, 9, t1, 15);
        m.merlons(t0, t1, 15);
        m.spawnRow(side ? x0 + 1 : t1 + 1, side ? t0 - 1 : x1 - 1, 9);
      }
      m.floor(X(0.27), X(0.73), 0.8, 0.8, { hazard: 'spike' });
      const y = 9, x0 = X(0.27), x1 = X(0.73), span = x1 - x0, count = Math.ceil(span / 1.3), pw = span / count;
      let prev = castles[0];
      for (let i = 0; i < count; i++) {
        const x = x0 + (i + 0.5) * pw;
        const plank = m.rect(x, y - 0.2, pw - 0.06, 0.35, { dynamic: true, density: 2.5, color: '#5a4636' });
        m.world.createJoint(pl.RevoluteJoint({}, prev, plank, V(x - pw / 2, y - 0.1)));
        prev = plank;
      }
      m.world.createJoint(pl.RevoluteJoint({}, prev, castles[1], V(x1, y - 0.1)));
      m.floor(X(0.44), X(0.56), 15, 0.6);
      m.crates(X(0.5), 15, 2, 1, 1);
    },
  },
  {
    name: 'Lavahöhle', sky: ['#2a1614', '#5c2a1e'], dark: true,
    build(m) {
      const { X, H } = m;
      const lava = m.block(-20, -H, m.W + 20, 0, { kinematic: true, hazard: 'lava' });
      m.tick((t) => lava.setLinearVelocity(V(0, t > 8 && lava.getPosition().y + H / 2 < 12 ? 0.3 : 0)));
      m.floor(X(0.04), X(0.28), 6, 6); m.floor(X(0.72), X(0.96), 6, 6); m.floor(X(0.36), X(0.64), 3, 3);
      m.block(X(0.2), 6, X(0.2) + 1.3, 7.3); m.block(X(0.8) - 1.3, 6, X(0.8), 7.3);
      m.block(X(0.45), 3, X(0.45) + 1.2, 4.4); m.block(X(0.55) - 1.2, 3, X(0.55), 4.4);
      m.floor(X(0.13), X(0.32), 11, 0.7); m.floor(X(0.68), X(0.87), 11, 0.7);
      m.floor(X(0.42), X(0.58), 13.5, 0.7); m.wall(X(0.42) + 0.3, 13.5, 14.9); m.wall(X(0.58) - 0.3, 13.5, 14.9);
      m.floor(X(0.24), X(0.38), 18, 0.6); m.floor(X(0.62), X(0.76), 18, 0.6);
      m.block(X(0.44), H - 3.5, X(0.56), H + 3); m.block(X(0.02), H - 2, X(0.14), H + 3); m.block(X(0.86), H - 2, X(0.98), H + 3);
      m.spawnRow(X(0.05), X(0.27), 6); m.spawnRow(X(0.73), X(0.95), 6); m.spawnRow(X(0.37), X(0.63), 3);
      m.spawnRow(X(0.14), X(0.31), 11); m.spawnRow(X(0.69), X(0.86), 11);
    },
  },
  {
    name: 'Baustelle', sky: ['#c4b59b', '#e3d9c6'],
    build(m) {
      const { X, H, W } = m;
      m.floor(X(0.03), X(0.44), 3, 3); m.floor(X(0.56), X(0.97), 3, 3);
      m.block(X(0.18), 3, X(0.18) + 1.5, 4.6); m.block(X(0.82) - 1.5, 3, X(0.82), 4.6);
      const g = 0.35;
      m.floor(X(0.08), X(0.3), 8, g); m.floor(X(0.7), X(0.92), 8, g);
      m.wall(X(0.08) + 0.2, 3, 8 - g, 0.3); m.wall(X(0.92) - 0.2, 3, 8 - g, 0.3);
      m.floor(X(0.25), X(0.42), 13, g); m.floor(X(0.58), X(0.75), 13, g);
      m.floor(X(0.06), X(0.2), 17.5, g); m.floor(X(0.8), X(0.94), 17.5, g);
      // crane with hanging platform
      m.wall(X(0.5), H - 2.5, H + 2, 0.5);
      const arm = m.floor(X(0.36), X(0.64), H - 2.2, 0.5);
      const len = 8;
      const plat = m.rect(W / 2, H - 2.2 - len, 5, 0.45, { dynamic: true, density: 3, angularDamping: 2, color: '#3a3a3a' });
      m.world.createJoint(pl.DistanceJoint({}, arm, plat, V(W / 2 - 1, H - 2.7), V(W / 2 - 2.2, H - 2.2 - len)));
      m.world.createJoint(pl.DistanceJoint({}, arm, plat, V(W / 2 + 1, H - 2.7), V(W / 2 + 2.2, H - 2.2 - len)));
      m.rope(W / 2 - 1, H - 2.7, plat, -2.2, 0.22); m.rope(W / 2 + 1, H - 2.7, plat, 2.2, 0.22);
      plat.setLinearVelocity(V(5, 0));
      for (const x of [X(0.3), X(0.7)]) for (let i = 0; i < 3; i++) m.rect(x, 3.2 + i * 0.37, 3.4, 0.35, { dynamic: true, density: 2, color: '#6d5433' });
      m.spawnRow(X(0.04), X(0.43), 3); m.spawnRow(X(0.57), X(0.96), 3); m.spawn(W / 2, H - 2.2 - len + 0.3);
    },
  },
  {
    name: 'Wippe', sky: ['#b2bfc9', '#dfe3e2'],
    build(m) {
      const { X, W } = m;
      const pivot = m.block(W / 2 - 0.5, 0, W / 2 + 0.5, 5.5);
      const plank = m.rect(W / 2, 5.8, X(0.46), 0.5, { dynamic: true, density: 3, color: '#5a4636', angularDamping: 0.4 });
      m.world.createJoint(pl.RevoluteJoint({ enableLimit: true, lowerAngle: -0.35, upperAngle: 0.35 }, pivot, plank, V(W / 2, 5.8)));
      for (const side of [0, 1]) {
        const a = side ? X(0.8) : X(0.02), b = side ? X(0.98) : X(0.2);
        m.floor(a, b, 6, 6);
        m.floor(side ? X(0.84) : a, side ? b : X(0.16), 11.5, 0.6);
        m.wall(side ? b - 0.3 : a + 0.3, 6, 10.9);
        m.wall(side ? X(0.84) + 0.25 : X(0.16) - 0.25, 6, 7.5, 0.5);
        m.spawnRow(a + 1, b - 1, 6);
      }
      m.floor(X(0.4), X(0.6), 14, 0.5);
      m.floor(X(0.26), X(0.34), 10, 0.4); m.floor(X(0.66), X(0.74), 10, 0.4);
      for (let i = 0; i < 4; i++) m.crate(X(0.33 + i * 0.11), 6.2, 0.9);
      m.spawnRow(X(0.3), X(0.7), 6.1);
    },
  },
  {
    name: 'Dächer', sky: ['#d4a98a', '#efd8c2'],
    build(m) {
      const { X } = m;
      const b = [[0.02, 0.18, 7], [0.22, 0.38, 10.5], [0.42, 0.58, 5], [0.62, 0.78, 10.5], [0.82, 0.98, 7]];
      for (const [a, c, top] of b) {
        m.block(X(a), -2, X(c), top);
        m.spawnRow(X(a) + 0.5, X(c) - 0.5, top);
      }
      m.block(X(0.08), 7, X(0.08) + 1.4, 8.1); m.block(X(0.92) - 1.4, 7, X(0.92), 8.1);
      m.wall(X(0.34), 10.5, 12.6, 0.6); m.wall(X(0.66), 10.5, 12.6, 0.6);
      m.block(X(0.25), 10.5, X(0.25) + 1.5, 11.6); m.block(X(0.75) - 1.5, 10.5, X(0.75), 11.6);
      // water tower
      m.wall(X(0.45) + 0.2, 8.4, 11, 0.25); m.wall(X(0.55) - 0.2, 8.4, 11, 0.25);
      m.floor(X(0.44), X(0.56), 11.5, 0.5);
      m.block(X(0.46), 11.5, X(0.54), 14);
      m.crates(X(0.5), 5, 2, 1, 1);
      m.floor(X(0.18) + 0.2, X(0.22) - 0.2, 14, 0.3); m.floor(X(0.78) + 0.2, X(0.82) - 0.2, 14, 0.3);
    },
  },
  {
    name: 'Sägewerk', sky: ['#b9a88f', '#ddd0bb'],
    build(m) {
      const { X, W } = m;
      m.floor(X(0.03), X(0.97), 2, 2);
      m.block(X(0.03), 2, X(0.28), 5); m.block(X(0.72), 2, X(0.97), 5);
      m.floor(X(0.36), X(0.46), 9, 0.5); m.floor(X(0.54), X(0.64), 9, 0.5);
      m.floor(X(0.44), X(0.56), 14, 0.5);
      m.floor(X(0.06), X(0.2), 10.5, 0.5); m.floor(X(0.8), X(0.94), 10.5, 0.5);
      m.wall(X(0.2) - 0.25, 10.5, 11.8, 0.5); m.wall(X(0.8) + 0.25, 10.5, 11.8, 0.5);
      for (const x of [X(0.14), X(0.86)]) for (let i = 0; i < 3; i++) m.rect(x + (i % 2) * 0.4, 5.3 + i * 0.62, 2.6, 0.6, { dynamic: true, density: 2, color: '#6d5433' });
      m.spawnRow(X(0.04), X(0.27), 5); m.spawnRow(X(0.73), X(0.96), 5); m.spawnRow(X(0.37), X(0.63), 9);
      const saws = 2 + Math.floor(m.n / 4);
      for (let i = 0; i < saws; i++) {
        const saw = m.circle(W / 2, 2.4, 1.1, { kinematic: true, hazard: 'saw', sensor: true });
        const ph = (i / saws) * Math.PI * 2;
        m.tick((t) => {
          saw.setAngularVelocity(-14);
          const target = W / 2 + Math.sin(t * 0.45 + ph) * (X(0.72) - X(0.28) - 2.6) / 2;
          saw.setLinearVelocity(V((target - saw.getPosition().x) * 4, 0));
        });
      }
    },
  },
  {
    name: 'Mond', sky: ['#0d1020', '#252a44'], dark: true, gravity: -11,
    build(m) {
      const { X } = m;
      const rock = { color: '#4b4f63' };
      const isl = [[0.05, 0.25, 5], [0.75, 0.95, 5], [0.35, 0.65, 8], [0.13, 0.3, 13], [0.7, 0.87, 13], [0.42, 0.58, 17.5], [0.02, 0.12, 20], [0.88, 0.98, 20]];
      for (const [a, b, y] of isl) {
        m.floor(X(a), X(b), y, 1.2, rock);
        m.spawnRow(X(a) + 0.8, X(b) - 0.8, y);
      }
      m.block(X(0.46), 8, X(0.46) + 1.2, 9.3, rock); m.block(X(0.54) - 1.2, 8, X(0.54), 9.3, rock);
      m.block(X(0.2), 5, X(0.2) + 1, 6.2, rock); m.block(X(0.8) - 1, 5, X(0.8), 6.2, rock);
      for (let i = 0; i < 4; i++) m.circle(X(0.2 + i * 0.2), 22, 0.8, { dynamic: true, density: 1, restitution: 0.4, color: '#6b6f82' });
    },
  },
  {
    name: 'Eisberg', sky: ['#9cc3d6', '#e2eff4'],
    build(m) {
      const { X } = m;
      const ice = { ice: true, color: '#2f4552' };
      m.floor(X(0.05), X(0.95), 3, 3, ice);
      // igloo
      m.wall(X(0.44), 5.6, 5.8, 0.6, ice); m.wall(X(0.56), 5.6, 5.8, 0.6, ice);
      m.floor(X(0.43), X(0.57), 6.4, 0.6, ice);
      m.rect(X(0.24), 7, X(0.2), 0.6, Object.assign({ angle: 0.22 }, ice));
      m.rect(X(0.76), 7, X(0.2), 0.6, Object.assign({ angle: -0.22 }, ice));
      m.floor(X(0.04), X(0.13), 10, 0.6, ice); m.floor(X(0.87), X(0.96), 10, 0.6, ice);
      m.floor(X(0.38), X(0.62), 11.5, 0.6, ice);
      m.block(X(0.44), 11.5, X(0.44) + 1, 12.6, ice); m.block(X(0.56) - 1, 11.5, X(0.56), 12.6, ice);
      m.floor(X(0.2), X(0.3), 15, 0.5, ice); m.floor(X(0.7), X(0.8), 15, 0.5, ice);
      for (let i = 0; i < 4; i++) m.rect(X(0.2 + i * 0.2), 3.5, 1, 0.9, { dynamic: true, density: 2, friction: 0.02, color: '#56717f' });
      m.spawnRow(X(0.06), X(0.94), 3);
    },
  },
  {
    name: 'Laternen', sky: ['#7e8a92', '#b5bec2'],
    build(m) {
      const { X } = m;
      m.floor(X(0.12), X(0.88), 4, 4);
      m.wall(X(0.3), 4, 10, 0.35); m.floor(X(0.3) - 1.2, X(0.3) + 1.2, 10.3, 0.3);
      m.wall(X(0.7), 4, 10, 0.35); m.floor(X(0.7) - 1.2, X(0.7) + 1.2, 10.3, 0.3);
      m.crates(X(0.42), 4, 1, 3, 1); m.crates(X(0.58), 4, 1, 3, 1);
      m.floor(X(0.02), X(0.12), 8, 0.5); m.floor(X(0.88), X(0.98), 8, 0.5);
      m.floor(X(0.4), X(0.6), 13, 0.5); m.wall(X(0.4) + 0.25, 13, 14.3, 0.5); m.wall(X(0.6) - 0.25, 13, 14.3, 0.5);
      m.block(X(0.18), 4, X(0.18) + 1.4, 5.5); m.block(X(0.82) - 1.4, 4, X(0.82), 5.5);
      m.spawnRow(X(0.14), X(0.86), 4);
    },
  },
  {
    name: 'Kistenregen', sky: ['#aeaaa0', '#d8d4ca'],
    build(m) {
      const { X, H } = m;
      m.floor(X(0.06), X(0.94), 4, 4);
      for (const c of [0.2, 0.5, 0.8]) {
        m.floor(X(c - 0.08), X(c + 0.08), 9, 0.7);
        m.wall(X(c - 0.08) + 0.2, 7, 8.3, 0.35); m.wall(X(c + 0.08) - 0.2, 7, 8.3, 0.35);
        m.spawnRow(X(c - 0.07), X(c + 0.07), 4);
      }
      m.floor(X(0.01), X(0.08), 11, 0.5); m.floor(X(0.92), X(0.99), 11, 0.5);
      let next = 3;
      m.tick((t) => {
        if (t < next) return;
        next = t + 0.35 + Math.random() * 0.8;
        const s = 0.8 + Math.random() * 1.2;
        const b = m.crate(X(0.08) + Math.random() * X(0.84), H + 3, s);
        b.setAngularVelocity((Math.random() - 0.5) * 4);
        b.setLinearVelocity(V(0, -8));
      });
    },
  },
  {
    name: 'Schaukeln', sky: ['#bdb49e', '#e2dccb'],
    build(m) {
      const { X, H } = m;
      for (const side of [0, 1]) {
        const a = side ? X(0.88) : X(0.02), b = side ? X(0.98) : X(0.12);
        m.block(a, 0, b, 10);
        m.merlons(a, b, 10);
        m.spawnRow(a + 0.6, b - 0.6, 10);
      }
      const beam = m.floor(X(0.14), X(0.86), H - 0.5, 0.6);
      const cnt = 3 + Math.floor(m.n / 3);
      for (let i = 0; i < cnt; i++) {
        const x = X(0.2 + (0.6 * i) / (cnt - 1));
        const len = 9 + (i % 2) * 3;
        const top = H - 1.1, y = top - len;
        const plat = m.rect(x, y, 3.6, 0.4, { dynamic: true, density: 4, color: '#5a4636', angularDamping: 2 });
        m.world.createJoint(pl.DistanceJoint({}, beam, plat, V(x - 1, top), V(x - 1.6, y)));
        m.world.createJoint(pl.DistanceJoint({}, beam, plat, V(x + 1, top), V(x + 1.6, y)));
        m.rope(x - 1, top, plat, -1.6, 0.2); m.rope(x + 1, top, plat, 1.6, 0.2);
        plat.setLinearVelocity(V((Math.random() - 0.5) * 8, 0));
        m.spawn(x, y + 0.2);
      }
      m.floor(X(0.44), X(0.56), 4, 0.6);
    },
  },
  {
    name: 'Windmühle', sky: ['#a9bca3', '#dce5d6'],
    build(m) {
      const { X, W, H } = m;
      for (const side of [0, 1]) {
        const a = side ? X(0.75) : X(0.03), b = side ? X(0.97) : X(0.25);
        m.block(a, 0, b, 6);
        m.wall(side ? b - 0.3 : a + 0.3, 6, 10);
        m.wall(side ? a + 0.3 : b - 0.3, 8.8, 10);
        m.floor(a, b, 10.6, 0.6);
        m.block(side ? a + 2 : b - 3.2, 6, side ? a + 3.2 : b - 2, 7.2);
        m.floor(side ? X(0.8) : X(0.1), side ? X(0.92) : X(0.2), 15, 0.5);
        m.spawnRow(a + 1, b - 1, 6);
      }
      const cx = W / 2, cy = 11, L = Math.min(H * 0.8, W * 0.36);
      const b1 = m.rect(cx, cy, L, 0.7, { kinematic: true, color: '#4a3c30' });
      const b2 = m.rect(cx, cy, 0.7, L, { kinematic: true, color: '#4a3c30' });
      m.tick((t) => { const w = 0.5 + 0.3 * Math.sin(t * 0.2); b1.setAngularVelocity(w); b2.setAngularVelocity(w); });
      m.floor(X(0.44), X(0.56), 1.5, 0.6, { hazard: 'spike' });
    },
  },
];

module.exports = maps;

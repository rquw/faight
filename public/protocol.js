// Binary snapshot format shared by server (require) and browser (window.faightProtocol).
// A player is sent as hip position + the 11 body angles; the client rebuilds every limb
// position from the skeleton, which is exact because the parts are jointed.
(function (root) {
  const DIM = { hipHH: 0.17, chestHH: 0.2, headR: 0.24, uArmHH: 0.17, lArmHH: 0.16, uLegHH: 0.23, lLegHH: 0.23 };
  const clamp16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

  // players: [{ id, alive, stun, aim, wIdx, ammo, hipX, hipY, angles[11] }]
  // props: [[id, x, y, a]], items: [[id, type, x, y, a, state]], projs: [[id, type, x, y, a]]
  function encode(tm, players, props, items, projs) {
    const size = 1 + 4 + 2 + players.length * 33 + 2 + props.length * 8 + 2 + items.length * 10 + 2 + projs.length * 9;
    const buf = new ArrayBuffer(size), v = new DataView(buf);
    let o = 0;
    v.setUint8(o, 1); o += 1;
    v.setUint32(o, tm >>> 0); o += 4;
    v.setUint16(o, players.length); o += 2;
    for (const p of players) {
      v.setUint16(o, p.id); o += 2;
      v.setUint8(o, (p.alive ? 1 : 0) | (p.stun ? 2 : 0)); o += 1;
      v.setInt16(o, clamp16(p.aim * 1000)); o += 2;
      v.setInt8(o, p.wIdx); o += 1;
      v.setUint8(o, Math.min(255, p.ammo)); o += 1;
      v.setInt16(o, clamp16(p.hipX * 100)); o += 2;
      v.setInt16(o, clamp16(p.hipY * 100)); o += 2;
      for (let i = 0; i < 11; i++) { v.setInt16(o, clamp16(wrap(p.angles[i]) * 1000)); o += 2; }
    }
    v.setUint16(o, props.length); o += 2;
    for (const [id, x, y, a] of props) { v.setUint16(o, id); v.setInt16(o + 2, clamp16(x * 100)); v.setInt16(o + 4, clamp16(y * 100)); v.setInt16(o + 6, clamp16(wrap(a) * 1000)); o += 8; }
    v.setUint16(o, items.length); o += 2;
    for (const [id, t, x, y, a, st] of items) { v.setUint16(o, id); v.setUint8(o + 2, t); v.setInt16(o + 3, clamp16(x * 100)); v.setInt16(o + 5, clamp16(y * 100)); v.setInt16(o + 7, clamp16(wrap(a) * 1000)); v.setUint8(o + 9, st); o += 10; }
    v.setUint16(o, projs.length); o += 2;
    for (const [id, t, x, y, a] of projs) { v.setUint16(o, id); v.setUint8(o + 2, t); v.setInt16(o + 3, clamp16(x * 100)); v.setInt16(o + 5, clamp16(y * 100)); v.setInt16(o + 7, clamp16(wrap(a) * 1000)); o += 9; }
    return buf;
  }

  function wrap(a) { return a - Math.PI * 2 * Math.round(a / (Math.PI * 2)); }
  const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

  // rebuild the 11 body centers from hip position + angles
  // order: hip, chest, head, ua0, la0, ua1, la1, ul0, ll0, ul1, ll1
  function skeleton(hx, hy, A) {
    const out = new Array(11);
    out[0] = [hx, hy];
    let [dx, dy] = rot(0, DIM.hipHH, A[0]);
    const hipTop = [hx + dx, hy + dy];
    [dx, dy] = rot(0, DIM.chestHH, A[1]);
    const cx = hipTop[0] + dx, cy = hipTop[1] + dy;
    out[1] = [cx, cy];
    [dx, dy] = rot(0, DIM.chestHH + 0.02, A[1]);
    const neck = [cx + dx, cy + dy];
    [dx, dy] = rot(0, DIM.headR, A[2]);
    out[2] = [neck[0] + dx, neck[1] + dy];
    [dx, dy] = rot(0, DIM.chestHH - 0.05, A[1]);
    const sh = [cx + dx, cy + dy];
    for (let i = 0; i < 2; i++) {
      const au = A[3 + i * 2], al = A[4 + i * 2];
      [dx, dy] = rot(0, -DIM.uArmHH, au); out[3 + i * 2] = [sh[0] + dx, sh[1] + dy];
      [dx, dy] = rot(0, -DIM.uArmHH * 2, au); const el = [sh[0] + dx, sh[1] + dy];
      [dx, dy] = rot(0, -DIM.lArmHH, al); out[4 + i * 2] = [el[0] + dx, el[1] + dy];
    }
    [dx, dy] = rot(0, -DIM.hipHH, A[0]);
    const hb = [hx + dx, hy + dy];
    for (let i = 0; i < 2; i++) {
      const au = A[7 + i * 2], al = A[8 + i * 2];
      [dx, dy] = rot(0, -DIM.uLegHH, au); out[7 + i * 2] = [hb[0] + dx, hb[1] + dy];
      [dx, dy] = rot(0, -DIM.uLegHH * 2, au); const kn = [hb[0] + dx, hb[1] + dy];
      [dx, dy] = rot(0, -DIM.lLegHH, al); out[8 + i * 2] = [kn[0] + dx, kn[1] + dy];
    }
    return out;
  }

  // returns the same shape the client used before: P rows [id, alive, aim*100, wIdx, ammo, stun, x*100, y*100, a*100 ...]
  function decode(buf) {
    const v = new DataView(buf);
    let o = 1;
    const tm = v.getUint32(o); o += 4;
    const P = [], O = [], I = [], R = [];
    let n = v.getUint16(o); o += 2;
    for (let k = 0; k < n; k++) {
      const id = v.getUint16(o), flags = v.getUint8(o + 2), aim = v.getInt16(o + 3) / 1000;
      const wIdx = v.getInt8(o + 5), ammo = v.getUint8(o + 6);
      const hx = v.getInt16(o + 7) / 100, hy = v.getInt16(o + 9) / 100;
      o += 11;
      const A = new Array(11);
      for (let i = 0; i < 11; i++) { A[i] = v.getInt16(o) / 1000; o += 2; }
      const pos = skeleton(hx, hy, A);
      const row = [id, flags & 1, aim * 100, wIdx, ammo, (flags & 2) ? 1 : 0];
      for (let i = 0; i < 11; i++) row.push(pos[i][0] * 100, pos[i][1] * 100, A[i] * 100);
      P.push(row);
    }
    n = v.getUint16(o); o += 2;
    for (let k = 0; k < n; k++) { O.push([v.getUint16(o), v.getInt16(o + 2), v.getInt16(o + 4), v.getInt16(o + 6) / 10]); o += 8; }
    n = v.getUint16(o); o += 2;
    for (let k = 0; k < n; k++) { I.push([v.getUint16(o), v.getUint8(o + 2), v.getInt16(o + 3), v.getInt16(o + 5), v.getInt16(o + 7) / 10, v.getUint8(o + 9)]); o += 10; }
    n = v.getUint16(o); o += 2;
    for (let k = 0; k < n; k++) { R.push([v.getUint16(o), v.getUint8(o + 2), v.getInt16(o + 3), v.getInt16(o + 5), v.getInt16(o + 7) / 10]); o += 9; }
    return { tm, P, O, I, R };
  }

  const api = { encode, decode, skeleton, DIM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.faightProtocol = api;
})(this);

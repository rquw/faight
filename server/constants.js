module.exports = {
  CAT_WORLD: 0x0001,
  CAT_BODY: 0x0002,
  CAT_ITEM: 0x0004,
  CAT_PROJ: 0x0008,

  // index in ORDER is the id sent to clients
  ORDER: ['pistol', 'ar', 'shotgun', 'sniper', 'rpg', 'minigun', 'grenade'],
  WEAPONS: {
    pistol:  { ammo: 12, cd: 0.32, dmg: 21, kb: 4,   spread: 0.02, pellets: 1, recoil: 4,   auto: false, weight: 22 },
    ar:      { ammo: 30, cd: 0.1,  dmg: 10, kb: 2.5, spread: 0.05, pellets: 1, recoil: 3,   auto: true,  weight: 20, twoHand: true },
    shotgun: { ammo: 6,  cd: 0.85, dmg: 9,  kb: 5,   spread: 0.2,  pellets: 7, recoil: 32,  auto: false, weight: 18, twoHand: true, range: 16 },
    sniper:  { ammo: 4,  cd: 1.3,  dmg: 68, kb: 30,  spread: 0,    pellets: 1, recoil: 30,  auto: false, weight: 10, twoHand: true, stun: 0.7 },
    rpg:     { ammo: 2,  cd: 1.1,  dmg: 62, kb: 0,   spread: 0,    pellets: 0, recoil: 28,  auto: false, weight: 8,  twoHand: true },
    minigun: { ammo: 90, cd: 0.055,dmg: 5,  kb: 1.6, spread: 0.13, pellets: 1, recoil: 5.5, auto: true,  weight: 8,  twoHand: true, spinup: 0.45 },
    grenade: { ammo: 3,  cd: 0.7,  dmg: 55, kb: 0,   spread: 0,    pellets: 0, recoil: 0,   auto: false, weight: 13 },
  },

  COLORS: ['#f7c325', '#3d8bff', '#ff4b4b', '#39d05c', '#ff7ad9', '#ff9a2e', '#9b6bff', '#2ee6e6',
    '#f2f2f2', '#b07a4a', '#c6ff3d', '#1f9e8f', '#ff2e7e', '#7f8cff', '#e0b0ff', '#8a8a8a'],
};

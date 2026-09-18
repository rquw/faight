module.exports = {
  CAT_WORLD: 0x0001,
  CAT_BODY: 0x0002,
  CAT_ITEM: 0x0004,
  CAT_PROJ: 0x0008,
  CAT_PROP: 0x0010,   // dynamic / kinematic level pieces

  // index in ORDER is the id sent to clients
  ORDER: ['pistol', 'ar', 'shotgun', 'sniper', 'rpg', 'minigun', 'grenade'],
  // speed: bullet m/s, life: bullet seconds, len: muzzle distance from hand,
  // kb: velocity (m/s) given to the victim, recoil: velocity given to the shooter
  WEAPONS: {
    pistol:  { ammo: 12, cd: 0.28, dmg: 22, kb: 4.6, speed: 75,  life: 1.0, spread: 0.015, pellets: 1, recoil: 2.2, auto: false, weight: 22, len: 0.38, rack: 0.3 },
    ar:      { ammo: 30, cd: 0.1,  dmg: 8,  kb: 2.6, speed: 85,  life: 1.0, spread: 0.05,  pellets: 1, recoil: 1.2, auto: true,  weight: 20, len: 0.8, twoHand: true, rack: 0.42 },
    shotgun: { ammo: 6,  cd: 0.8,  dmg: 9,  kb: 3.8, speed: 60,  life: 0.32,spread: 0.2,   pellets: 7, recoil: 13, auto: false, weight: 18, len: 0.85, twoHand: true, rack: 0.55 },
    sniper:  { ammo: 4,  cd: 1.2,  dmg: 80, kb: 29,  speed: 170, life: 1.0, spread: 0,     pellets: 1, recoil: 14, auto: false, weight: 10, len: 1.15, twoHand: true, rack: 0.7 },
    rpg:     { ammo: 2,  cd: 1.1,  dmg: 70, kb: 0,   speed: 26,  life: 4,   spread: 0,     pellets: 0, recoil: 13, auto: false, weight: 8,  len: 1.0, twoHand: true, rack: 0.62 },
    minigun: { ammo: 80, cd: 0.055,dmg: 4,  kb: 1.7, speed: 80,  life: 1.0, spread: 0.12,  pellets: 1, recoil: 1.9, auto: true,  weight: 8,  len: 0.9, twoHand: true, spinup: 0.4, rack: 0.5 },
    grenade: { ammo: 3,  cd: 0.7,  dmg: 55, kb: 0,  speed: 15,  life: 2.2, spread: 0,     pellets: 0, recoil: 0,  auto: false, weight: 13, len: 0.15, rack: 0.25 },
  },

  COLORS: ['#f2c12e', '#3f7fd9', '#d9443b', '#5bb84a', '#e46fc0', '#ef8a2e', '#8a5fd6', '#39c1c9',
    '#e8e8e8', '#9c6b43', '#b5d63c', '#2f8f7f', '#e0457b', '#6b7bd9', '#c9a0e8', '#7d7d7d'],
};

# faight 🥊

Physics-based stick figure brawler for the classroom. Inspired by Stick Fight: The Game.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/rquw/faight)

## Spielen
1. Einer erstellt einen Raum → 4-stelliger Code
2. Alle anderen geben den Code ein (oder öffnen den Link)
3. Letzter Überlebender kriegt den Punkt

| Taste | Aktion |
|---|---|
| A / D | laufen |
| Space / W | springen (auch von Wänden) |
| S | ducken / schneller fallen |
| Maus | zielen |
| Klick | schießen / schlagen |
| Q / Rechtsklick | Waffe werfen |

**Waffen:** Pistole, Sturmgewehr, Schrotflinte, Sniper, Raketenwerfer, Minigun, Granaten – fallen regelmäßig vom Himmel.

**Maps:** Arena, Kistenlager, Wippe, Lava, Mond, Aufzüge, Windmühle, Eisbahn, Sturm, Kistenregen, Hängebrücke, Trampolin, Schaukeln, Sägewerk. Die Map wächst mit der Spielerzahl.

## Lokal
```
npm install
npm start
```
→ http://localhost:3000

Testbots: `node tools/bots.js <code> 3`

## Tech
Server-authoritative Physik mit [planck.js](https://github.com/piqnt/planck.js) (Box2D) und Active Ragdolls, WebSockets, Canvas-Client mit Interpolation.

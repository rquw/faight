# faight 🥊

Physics-based stick figure brawler for the classroom, modeled on Stick Fight: The Game.

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

Leere Waffen fliegen automatisch weg. Ohne Waffe wird geschlagen.

**Handy:** quer halten. Linker Stick laufen (nach unten = ducken), rechter Stick ziehen = zielen & schießen, kurz tippen = automatisch auf den nächsten Gegner, dazu Sprung- und Drop-Knopf.

**Waffen:** Pistole, Sturmgewehr, Schrotflinte, Sniper, Raketenwerfer, Minigun, Granaten – fallen regelmäßig vom Himmel.

**Maps:** Fabrik, Lagerhalle, Burg, Lavahöhle, Baustelle, Wippe, Dächer, Sägewerk, Mond, Eisberg, Laternen, Kistenregen, Schaukeln, Windmühle. Die Map wächst mit der Spielerzahl, die Kamera zeigt immer die ganze Map.

## Lokal
```
npm install
npm start
```
→ http://localhost:3000

Testbots: `node tools/bots.js <code> 3`

## Tech
Server-authoritative Physik mit [planck.js](https://github.com/piqnt/planck.js) (Box2D). Die Figuren sind reine Ragdolls, die über Kräfte aufrecht gehalten werden (keine Animationen). Projektile fliegen echt, WebSockets, Canvas-Client mit Interpolation.

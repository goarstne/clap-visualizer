# VJ-Steuerung: Schnittstelle Remote <-> Display

Ergänzt `docs/PROTOCOL.md`. Das Plugin bleibt unverändert: Es speichert
Nachrichten, die mit `{"type":"state"` beginnen, und reicht alle anderen
Textnachrichten an die übrigen Clients weiter. Verbindlich für alle Dateien
in `web/`. Änderungen nur über den koordinierenden Agenten.

Zielgerät der Fernbedienung: iPad 10 (Safari, 820×1180 CSS-Pixel hoch,
1180×820 quer, Touch, über http im LAN). Das Display kann ebenfalls auf einem
iPad laufen.

## Dateien und Zuständigkeit

| Datei | Inhalt |
|---|---|
| `web/ws.js` | WebSocket-Client, unverändert |
| `web/postfx.js` | WebGL2-Nachbearbeitung inkl. A/B-Mischung (`window.PostFX`) |
| `web/postfx-test.html` | eigenständige Testseite für `postfx.js` |
| `web/viz.js` | Shader-Engine (`window.ShaderViz`): benannte Visualisierungsarten, Spektrumanalyse |
| `web/engine.js` | Display-Logik (`window.VJEngine`): Decks, Hooks, Quantisierung, Szenen, Bild-Ebenen |
| `web/pictures/` | erzeugt von `make pictures`: Bilder plus `index.json` (sortierte Dateinamen) |
| `tools/webtest.js` | Node-Test für Spektrumanalyse und State-Normalisierung |
| `web/index.html` | Display-Seite, bindet `engine.js` und `postfx.js` ein |
| `web/controls.js` | Touch-Widgets (`window.VJControls`): Fader, XY-Pad, Tasten |
| `web/remote.html` | Fernbedienung |

## Nachrichten

Alle Nachrichten sind JSON-Text. JSON immer ohne Leerzeichen serialisieren
(`JSON.stringify`), `type` ist das erste Feld.

### 1. State (dauerhaft, wird im Plugin gespeichert)

Der Sender schickt immer den vollständigen State. Letzter Schreiber gewinnt.
Unbekannte Felder bleiben erhalten (`{...alt, ...neu}`), fehlende Felder
werden mit den Standardwerten gefüllt. Ein alter State ohne `v` (Felder
`preset`, `gain`, `brightness`) wird übernommen: `preset` -> `deckA`,
`gain` -> `fx.gain`, `brightness` -> `fx.bright`.

```json
{"type":"state","v":2,
 "deckA":"<Presetname>","deckB":"<Presetname>","xfade":0,
 "blend":2,"quant":"bar",
 "autoBars":8,"random":true,"locked":false,
 "fx":{"speed":1,"zoom":0,"rot":0,"warp":0,"dx":0,"dy":0,
       "hue":0,"sat":1,"bright":1,"contrast":1,
       "kaleido":0,"mirror":0,"trails":0,"rgb":0,
       "gain":1,"bass":1,"mid":1,"treb":1},
 "sync":{},
 "scenes":[null,null,null,null,null,null,null,null],
 "pool":"all","favs":[],
 "img":[{"src":"","on":false,"x":0,"y":0,"s":0.6,"r":0,"o":1,"m":0,
         "pulse":0,"spin":0,"top":false}, "... 5 Einträge"]}
```

| Feld | Bedeutung |
|---|---|
| `deckA`, `deckB` | Presetnamen der beiden Decks |
| `xfade` | 0 = nur A sichtbar, 1 = nur B |
| `blend` | Überblendzeit in Sekunden (0..10) für Deckwechsel und Preset-Laden |
| `quant` | Taktraster für `trig`: `"off"`, `"beat"`, `"bar"`, `"4bar"` |
| `autoBars` | automatischer Wechsel alle N Takte (0 = aus, 4, 8, 16, 32) |
| `random` | Auto-Wechsel wählt zufällig statt der Reihe nach |
| `locked` | Auto-Wechsel gesperrt |
| `fx` | Effektwerte, siehe Tabelle |
| `sync` | Beat-Kopplung je fx-Schlüssel, z. B. `{"zoom":"1","hue":"4"}`; Wert = Periode in Beats als Text (`"1/2"`, `"1"`, `"2"`, `"4"`, `"8"`), fehlend = aus |
| `scenes` | 8 Plätze; `null` oder Schnappschuss `{deckA,deckB,xfade,fx,sync,img}` (`img` optional) |
| `pool` | woraus Auto-Wechsel, `next`, `prev`, `random` wählen: `"all"`, `"milk"` (nur Milkdrop), `"viz"` (nur Shader-Arten), `"favs"`; leerer Pool = alle |
| `favs` | Presetnamen für `pool` `"favs"` (höchstens 200); die Remote schreibt ihre Favoriten hinein |
| `img` | 5 Bild-Ebenen, siehe Abschnitt "Bilder" |

Auto-Wechsel: Das Display lädt das neue Preset auf das gerade nicht sichtbare
Deck und blendet in `blend` Sekunden hinüber (wie `swap`).

### fx-Parameter

| Schlüssel | Bereich | Standard | Wirkung | Ort |
|---|---|---|---|---|
| `speed` | 0..3 | 1 | Zeitskala der Engine (0 = fast eingefroren) | engine |
| `zoom` | -1..1 | 0 | Zoom-Faktor `1 + 0.25*zoom` auf den Frame-Wert | engine |
| `rot` | -1..1 | 0 | Rotation `+ 0.5*rot` | engine |
| `warp` | -1..1 | 0 | Warp `* (1 + warp)` | engine |
| `dx`, `dy` | -1..1 | 0 | Verschiebung `+ 0.05*dx` bzw. `dy` | engine |
| `gain` | 0.2..3 | 1 | Audio-Empfindlichkeit gesamt | engine |
| `bass`, `mid`, `treb` | 0..3 | 1 | Empfindlichkeit je Band | engine |
| `hue` | 0..360 | 0 | Farbton-Drehung in Grad | postfx |
| `sat` | 0..2 | 1 | Sättigung | postfx |
| `bright` | 0..2 | 1 | Helligkeit | postfx |
| `contrast` | 0..2 | 1 | Kontrast | postfx |
| `kaleido` | 0..12 | 0 | Kaleidoskop-Segmente (0 und 1 = aus, ganzzahlig) | postfx |
| `mirror` | 0..3 | 0 | 0 aus, 1 horizontal, 2 vertikal, 3 beide | postfx |
| `trails` | 0..0.97 | 0 | Nachzieh-Effekt (Anteil des Vorbilds) | postfx |
| `rgb` | 0..1 | 0 | RGB-Versatz | postfx |

Beat-Kopplung (`sync`): Die Abweichung vom Standardwert wird mit einer
Hüllkurve multipliziert, die am Beatanfang 1 ist und bis zum Periodenende
linear auf 0 fällt (Phase aus `beat` des Hosts). Der Wert pulsiert also
zwischen Reglerstellung und Standardwert. Bei stehendem Transport wirkt der Wert
ungekoppelt.

### 2. ctl (flüchtig, nicht gespeichert)

Während ein Regler bewegt oder eine Momentan-Taste gehalten wird:

```json
{"type":"ctl","k":"fx.zoom","v":0.42}
```

- `k` für Regler: `fx.<Schlüssel>`, `xfade` oder `img.<i>.<Schlüssel>` (Bild
  `i` = 0..4, Schlüssel `x`, `y`, `s`, `r`, `o`, `pulse`, `spin`). Höchstens
  eine Nachricht je Schlüssel und Animations-Frame.
  Weitere Bild-Schlüssel: `tile`, `hue`, `wob`.
- `img.<i>.on` mit `v` 1/0: Bild nur solange gehalten zeigen (nicht gespeichert).
- `img.<i>.shot` mit `v` 1/0: Bild "reinschießen": sofort voll sichtbar mit
  Zoom-Stoß (Größe +90 %, klingt in ca. 0,1 s ab), beim Loslassen wieder weg.
- `tp.<n>` (n = 0..2): Finger-Licht. `v` ist `[x,y]` (-1..1, y nach oben)
  solange der Finger aufliegt, sonst `0`. Das Display verbiegt das Bild an der
  Stelle, legt ein Licht darüber und lässt es nach dem Loslassen ausklingen.
- Beim Loslassen schreibt die Remote den Wert in den State und sendet den
  vollständigen State. Rückfedernde Regler (XY-Pads) senden beim Loslassen
  `ctl` mit dem Ruhewert und danach den State.
- Das Display glättet eingehende Reglerwerte (Zeitkonstante ca. 60 ms).
- Andere Remotes übernehmen `ctl` in ihre Anzeige.

Momentan-Tasten, `v` ist 1 beim Drücken und 0 beim Loslassen:

| `k` | Wirkung |
|---|---|
| `m.flash` | weißer Blitz, klingt in 150 ms ab; höchstens 3 Blitze pro Sekunde, weitere werden verworfen |
| `m.black` | Blackout solange gehalten |
| `m.invert` | Farben invertiert solange gehalten |
| `m.freeze` | Zeitskala fast 0 solange gehalten |
| `m.kick` | Bass-Stoß: künstlicher Bass-Impuls beim Drücken |
| `m.mirror` | Spiegeln (beide Achsen) solange gehalten |
| `m.kaleido` | Kaleidoskop mit 6 Segmenten solange gehalten |
| `m.strobe` | Blitz im Beat-Raster (1/2 Beat), höchstens 3 pro Sekunde |
| `m.zoom`, `m.spin` | Zoom bzw. Rotation auf Maximum solange gehalten |
| `m.rgb`, `m.trails` | RGB-Versatz 1 bzw. Nachziehen 0.9 solange gehalten |
| `m.hue` | Farbton läuft einmal pro Sekunde durch |
| `m.mono` | Sättigung 0 |
| `m.shake` | zufälliges `dx`/`dy` in jedem Frame |
| `m.turbo` | Zeitskala 3 |

Sicherheitsnetz: Trennt sich die Verbindung des Displays, setzt es alle
Momentan-Zustände zurück. Die Remote sendet für jede gehaltene Taste auch bei
`pointercancel`, `blur` und `visibilitychange` den Wert 0.

### 3. trig (flüchtig, wird vom Display im Taktraster ausgeführt)

```json
{"type":"trig","k":"swap","q":"bar"}
{"type":"trig","k":"load","deck":"B","preset":"<Name>","q":"off"}
{"type":"trig","k":"scene","i":3,"q":"bar"}
{"type":"trig","k":"next","q":"bar"}
{"type":"trig","k":"prev","q":"bar"}
{"type":"trig","k":"random","q":"bar"}
{"type":"trig","k":"title","text":"...","q":"off"}
{"type":"trig","k":"show","preset":"<Name>","q":"bar"}
{"type":"trig","k":"img","i":2,"on":true,"q":"bar"}
```

| `k` | Wirkung |
|---|---|
| `swap` | blendet in `blend` Sekunden auf das andere Deck (xfade 0 <-> 1) |
| `load` | lädt `preset` auf Deck `A` oder `B`, ohne die Mischung zu ändern |
| `scene` | übernimmt Schnappschuss `scenes[i]` |
| `next`, `prev`, `random` | lädt das nächste/vorige/zufällige Preset auf das nicht sichtbare Deck und führt `swap` aus |
| `title` | Texteinblendung über `launchSongTitleAnim` |
| `show` | lädt `preset` auf das nicht sichtbare Deck und führt `swap` aus ("jetzt zeigen") |
| `img` | schaltet Bild `i` ein/aus (`on` fehlt = umschalten); wartet je Bild getrennt (`pending` mit `k` = `img<i>`) |

`q` ist das Raster dieser einen Aktion (die Remote setzt es aus `state.quant`):
`off` sofort, `beat` nächster Beat, `bar` nächster Taktanfang, `4bar` nächster
durch 4 teilbarer Takt. Bei stehendem Transport oder bpm 0 immer sofort.
Wartende Aktionen: höchstens eine je `k`, eine neue ersetzt die alte.

Nach dem Ausführen einer `trig`-Aktion sendet das Display den neuen
vollständigen State. Sind mehrere Displays verbunden, führt jedes die Aktion
aus (einfach halten).

Szene speichern macht die Remote selbst: Schnappschuss in `scenes[i]`
schreiben und State senden.

### 4. Display -> Remote (flüchtig)

```json
{"type":"thumb","preset":"<Name>","data":"data:image/jpeg;base64,..."}
{"type":"pending","k":"swap","beats":2.5}
```

- `thumb`: Vorschaubild 96×54 (JPEG, Qualität ca. 0.5, unter 6 KiB), sobald ein
  Preset 3 Sekunden sichtbar war; je Preset höchstens einmal pro Sitzung. Die
  Remote speichert sie in `localStorage` und zeigt sie auf den Kacheln.
- `pending`: optional, Rückmeldung für eine wartende Aktion (`beats` bis zur
  Ausführung), etwa 5-mal pro Sekunde; `beats` 0 = ausgeführt.

## Audio-Quellen (Stems)

Das Plugin liefert weiterhin nur die Stereosumme. Das Display teilt sie selbst
in drei Quellen und visualisiert nur die gewählten. Es ist eine Trennung nach
Frequenz und Anschlag, keine Instrumenten-Trennung.

State-Feld (dauerhaft), Standard alles an:

```json
"stems":{"drums":true,"bass":true,"melody":true}
```

| Quelle | Inhalt |
|---|---|
| `drums` | perkussive Anteile: Anschläge je Band (unter 180 Hz, 180 Hz bis 5 kHz) samt Ausklang von ca. 100 ms, dazu alles über ca. 5 kHz (Hi-Hats, Becken) |
| `bass` | gehaltene Anteile unter ca. 180 Hz |
| `melody` | gehaltene Anteile von ca. 180 Hz bis 5 kHz (Harmonie, Stimme, Leads) |

- Alle drei `true`: das unveränderte Signal (Bypass, bitgleich zum bisherigen
  Verhalten). Alle drei `false` ist erlaubt und bedeutet Stille.
- Die Auswahl wirkt auf alles, was auf Audio reagiert: butterchurn-Decks,
  Shader-Arten (Spektrum, Wellenform, Bänder) und Beat-Puls der Bilder.
- `fx.gain`, `fx.bass`, `fx.mid`, `fx.treb` wirken danach wie bisher.
- Nachmessen mit echter Musik: `tools/stemcheck.js` (Anteile je Quelle und
  Pegelanzeige der Remote); Touch-Test der Oberfläche: `tools/touchtest.js`.
- Fehlendes oder ungültiges Feld wird zu "alles an" normalisiert; Szenen
  speichern `stems` nicht.

Display -> Remote, flüchtig, etwa 10-mal pro Sekunde, unabhängig von der
Auswahl (damit die Remote Pegel auch stummer Quellen zeigt):

```json
{"type":"bands","drums":0.42,"bass":0.61,"melody":0.18}
```

Werte 0..1, geglättet (schneller Anstieg, Abfall ca. 0,3 s).

## Schuss-Routinen der Bilder

```json
{"type":"ctl","k":"img.2.shot","v":1,"r":"spin"}
{"type":"ctl","k":"img.2.shot","v":0}
```

`v` 1 startet die Routine `r` für Bild `i`, `v` 0 meldet das Loslassen. Fehlt
`r` oder ist es unbekannt, gilt `"zoom"`. Die Routine läuft immer bis zum Ende;
das Bild bleibt danach sichtbar, solange die Taste gehalten wird, und blendet
nach dem Loslassen aus. Ein kurzer Tipp zeigt also genau eine Routine.
Routinen ändern den gespeicherten State nicht (Lage, Größe, Drehung des Bildes
bleiben die Basis).

| `r` | Dauer | Wirkung |
|---|---|---|
| `zoom` | 0,35 s | sofort sichtbar, Größe startet bei +90 % und fällt auf die Basisgröße |
| `spin` | 0,6 s | dreht sich mit zwei Umdrehungen herein, Größe wächst von 0 auf die Basisgröße |
| `flash` | 0,5 s | sofort sichtbar mit weißem Blitz (wie `m.flash`), Deckkraft flackert dreimal |

## Aufbau der Remote (`web/remote.html`)

Eine Seite ohne Tabs. Kopfzeile: Transport, Pegel, Quellen-Tasten Alle / Drums /
Bass / Melodie (Tippen = an/aus, langes Halten = Solo, Hintergrund = Pegel aus
`bands`). Querformat (1180×820): vier Spalten, jede scrollt für sich:
Decks + Visualisierung + Preset-Browser | Bild-Schüsse + XY-Pads +
Momentan-Tasten | Bilder mit Bühne | Szenen + Effekte. Hochformat: dieselben
Spalten zweispaltig untereinander, die Seite scrollt.

## Shader-Engine (`web/viz.js`)

Zweite Engine neben butterchurn für klar benannte Visualisierungsarten. Jede
Art ist ein Fragment-Shader und erscheint als zusätzliches Preset mit dem
Präfix `◆ ` (`◆ Spektrum`, `◆ Oszilloskop`, `◆ Kreis`, `◆ Tunnel`, `◆ Plasma`,
`◆ Sterne`, `◆ Gitter`). Dadurch gelten Decks, `load`, `show`, Szenen,
Vorschaubilder und der Pool unverändert. Ohne PostFX gibt es keine Shader-Arten.

```js
ShaderViz.names                         // Presetnamen mit Präfix
const levels = ShaderViz.analyze(wave, dt, sampleRate);   // einmal pro Frame
const viz = ShaderViz.create();         // je Deck, eigenes Canvas; null ohne WebGL2
viz.resize(w, h); viz.render(name, levels, fx, dt); viz.canvas; viz.destroy();
```

- `analyze`: FFT über 1024 Samples; `levels.tex` ist eine 512×2-Textur (Zeile 0
  Spektrum logarithmisch 30 Hz..16 kHz, Zeile 1 Wellenform), dazu `bass`, `mid`,
  `treb`, `level` (0..1).
- `fx.zoom`, `rot`, `warp`, `dx`, `dy` wirken als Kamera; `dt` ist bereits mit
  `fx.speed` skaliert (0 beim Einfrieren).
- Neue Art: einen Eintrag in `TYPES` ergänzen, mehr nicht.

## Bilder

`make pictures` (Teil von `make install`) kopiert jpg/jpeg/png/webp aus
`PICTURES` (Standard `Pictues/`) nach `web/pictures/` und schreibt
`index.json`. Platz `i` zeigt `img[i].src`, sonst die i-te Datei der Liste.

| Feld | Bereich | Standard | Bedeutung |
|---|---|---|---|
| `src` | Dateiname | `""` | Datei in `pictures/`; leer = i-te Datei |
| `on` | bool | false | sichtbar (Ein-/Ausblenden ca. 0,1 s) |
| `x`, `y` | -1.5..1.5 | 0 | Mitte; ±1 = Bildschirmrand, y nach oben |
| `s` | 0.05..4 | 0.6 | Größe; 1 = ganzes Bild passt genau auf den Schirm |
| `r` | ±31.4 | 0 | Drehung in Radiant, im Uhrzeigersinn |
| `o` | 0..1 | 1 | Deckkraft |
| `m` | 0..5 | 0 | Mischmodus: Normal, Add, Screen, Multiply, Differenz, Luma-Key |
| `pulse` | 0..1 | 0 | Größe pulsiert mit dem Bass |
| `spin` | -2..2 | 0 | Dauerdrehung, 1 = halbe Umdrehung pro Sekunde |
| `tile` | 1..6 | 1 | Kacheln: Bild n×n-fach in seiner Fläche wiederholt |
| `hue` | 0..360 | 0 | Farbton-Drehung nur dieses Bildes |
| `wob` | 0..1 | 0 | Wabern (animierte Verzerrung) |
| `top` | bool | false | false: in der Effektkette (Spiegeln, Kaleidoskop, RGB, Farbe, Nachziehen wirken); true: unverändert darüber |

Die Remote hat vier XY-Pads für fx-Parameter (Achsen und Feder je Gerät in
`localStorage` `vstvis_pads`) und zwei Bild-Pads (Drehung/Größe,
Farbton/Wabern) für das gewählte Bild. Die Bühne der Remote nimmt 16:9 an; auf anderen Formaten stimmen Lage und
Größe relativ, nicht pixelgenau.

## PostFX-API (`web/postfx.js`)

```js
const fx = PostFX.create(canvas);      // null, wenn WebGL2 fehlt
fx.resize(width, height);              // Ausgabegröße in Gerätepixeln
fx.render(srcA, srcB, params);         // einmal pro Frame
fx.setImage(i, image);                 // Bild-Ebene 0..4, null leert sie
fx.destroy();
```

- `srcA`, `srcB`: `HTMLCanvasElement` (butterchurn rendert per WebGL direkt
  hinein). `srcB` darf `null` sein, dann gilt `mix` 0. Die Quellen werden im
  selben Frame direkt nach dem Rendern übergeben.
- `params` (fehlende Felder = Standard):

| Feld | Bereich | Standard |
|---|---|---|
| `mix` | 0..1 | 0 |
| `hue` | 0..360 | 0 |
| `sat`, `bright`, `contrast` | 0..2 | 1 |
| `invert` | 0..1 | 0 |
| `kaleido` | 0..12 | 0 |
| `mirror` | 0..3 | 0 |
| `trails` | 0..0.97 | 0 |
| `rgb` | 0..1 | 0 |
| `flash` | 0..1 | 0 (Weißanteil) |
| `black` | 0..1 | 0 (Schwarzanteil, nach allem anderen) |
| `layers` | 5 × `{x,y,s,r,o,m,top,tile,hue,wob}` | keine (Werte wie im Abschnitt "Bilder") |
| `touch` | 3 × `{x,y,a}` | keine (`a` = Stärke 0..1) |
| `time` | Sekunden | 0 (für die Wellen der Touch-Punkte) |

Reihenfolge: Touch-Verzerrung -> Spiegeln/Kaleidoskop (Koordinaten) -> A/B
mischen -> Bilder ohne `top` -> RGB-Versatz -> Farbe (hue, sat, bright,
contrast, invert) -> Nachziehen -> Bilder mit `top` -> Touch-Licht -> Blitz ->
Blackout. Mit Standardwerten ist die Ausgabe gleich Quelle A.

## Engine-Hooks (für `engine.js`)

Mit der eingebundenen butterchurn-Version geprüft:

- Frame-Werte: `visualizer.renderer.presetEquationRunner.runFrameEquations`
  umhüllen und danach `runner.mdVSFrame` ändern (`zoom`, `rot`, `warp`, `dx`,
  `dy`). Der Runner wird bei jedem `loadPreset` neu erzeugt, also nach jedem
  Laden neu umhüllen.
- Zeit: `visualizer.render({audioLevels, elapsedTime})`; `elapsedTime` in
  Sekunden, 0 gilt als "nicht gesetzt", zum Einfrieren einen sehr kleinen Wert
  verwenden.
- `invert` und `gammaadj` wirken in der Engine nicht zuverlässig; Farbe läuft
  über PostFX.
- butterchurn rendert direkt in das übergebene Canvas (WebGL). Die beiden
  Deck-Canvases sind unsichtbar; sichtbar ist nur das PostFX-Canvas.
- Deck B nur rendern, wenn `xfade` > 0 oder eine Überblendung läuft.

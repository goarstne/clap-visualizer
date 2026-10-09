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
| `web/engine.js` | Display-Logik (`window.VJEngine`): Decks, Hooks, Quantisierung, Szenen |
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
 "scenes":[null,null,null,null,null,null,null,null]}
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
| `scenes` | 8 Plätze; `null` oder Schnappschuss `{deckA,deckB,xfade,fx,sync}` |

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

- `k` für Regler: `fx.<Schlüssel>` oder `xfade`. Höchstens eine Nachricht je
  Schlüssel und Animations-Frame.
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
```

| `k` | Wirkung |
|---|---|
| `swap` | blendet in `blend` Sekunden auf das andere Deck (xfade 0 <-> 1) |
| `load` | lädt `preset` auf Deck `A` oder `B`, ohne die Mischung zu ändern |
| `scene` | übernimmt Schnappschuss `scenes[i]` |
| `next`, `prev`, `random` | lädt das nächste/vorige/zufällige Preset auf das nicht sichtbare Deck und führt `swap` aus |
| `title` | Texteinblendung über `launchSongTitleAnim` |

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

## PostFX-API (`web/postfx.js`)

```js
const fx = PostFX.create(canvas);      // null, wenn WebGL2 fehlt
fx.resize(width, height);              // Ausgabegröße in Gerätepixeln
fx.render(srcA, srcB, params);         // einmal pro Frame
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

Reihenfolge: A/B mischen -> Spiegeln/Kaleidoskop (Koordinaten) -> RGB-Versatz
-> Farbe (hue, sat, bright, contrast, invert) -> Nachziehen -> Blitz ->
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

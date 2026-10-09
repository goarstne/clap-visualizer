# Schnittstelle Plugin <-> Web

Verbindlich für `plugin/` (C++) und `web/` (Browser). Änderungen nur über den
koordinierenden Agenten.

## Überblick

- Das CLAP-Plugin sitzt auf dem REAPER-Masterbus, reicht Audio unverändert durch
  und betreibt einen HTTP+WebSocket-Server auf `0.0.0.0:8765`
  (überschreibbar mit Umgebungsvariable `VSTVIS_PORT`).
- Visuals werden im Browser gerendert (Display-Seite, butterchurn/WebGL).
  Die Remote-Seite auf Handy/Tablet steuert sie live.
- Der Server parst kein JSON. Er ist ein Relay plus Sender für Audio/Transport.

## HTTP

- `GET /` -> `index.html` (Display), `GET /remote.html` (Fernbedienung),
  sonst statische Dateien aus dem Web-Verzeichnis.
- Web-Verzeichnis: `VSTVIS_WEB_DIR`, sonst `vstvisualizer.web/` neben der
  geladenen `.clap`-Datei (per `dladdr`).
- Nur `GET`. Pfade mit `..` oder außerhalb des Web-Verzeichnisses -> 403/404.
- Content-Types mindestens: html, js, css, json, svg, png, ico, wasm.

## WebSocket `ws://<host>:8765/ws`

### Client -> Server (Text-Frames)

| Frame | Verhalten des Servers |
|---|---|
| exakt `hello display` | Client erhält ab jetzt binäre Audioframes |
| exakt `hello remote` | Client erhält keine Audioframes (Standard) |
| beginnt mit `{"type":"state"` | wird als aktueller State gespeichert (max. 64 KiB) und an alle **anderen** Clients gesendet |
| alles andere | wird unverändert an alle **anderen** Clients gesendet, nicht gespeichert (einmalige Aktionen) |

Direkt nach dem WS-Handshake sendet der Server den gespeicherten State (falls
vorhanden) als Text-Frame an den neuen Client. Der State wird zusätzlich über
die CLAP-State-Extension im REAPER-Projekt gespeichert/geladen.

### Server -> Client

**Transport** (Text, JSON, ~20 Hz, an alle Clients):

```json
{"type":"transport","bpm":120.0,"playing":true,"beat":17.25,
 "tsNum":4,"tsDen":4,"rms":0.21,"peak":0.63,"sampleRate":48000}
```

- `beat`: Songposition in Viertelnoten (aus dem Host-Transport, fortlaufend).
  Ohne Host-Transport: `bpm` 0, `playing` false, `beat` 0.
- `rms`/`peak`: linear 0..1 über das letzte Sendeintervall (Stereo-Maximum).

**Audio** (Binär, ~60 Hz, nur an `display`-Clients), little-endian:

| Offset | Typ | Inhalt |
|---|---|---|
| 0 | u8 | Frame-Typ = `1` |
| 1 | u8 | Flags, Bit 0 = playing |
| 2 | u16 | N = Samples pro Kanal (1024) |
| 4 | f32 | bpm |
| 8 | f64 | beat (Viertelnoten) |
| 16 | u8[N] | linker Kanal, jüngste N Samples, 128 = Null (`128 + s*127`, geclippt) |
| 16+N | u8[N] | rechter Kanal, gleiches Format |

Mono-Eingang: beide Kanäle identisch.

## State (Konvention der Web-Seite, für den Server opak)

```json
{"type":"state","preset":"<Name>","blend":2.0,"autoBars":8,
 "random":true,"locked":false}
```

Felder dürfen von `web/` erweitert werden. Der Sender schickt immer den
vollständigen State (letzter Schreiber gewinnt).

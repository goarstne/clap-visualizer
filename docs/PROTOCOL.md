# Plugin ↔ browser protocol

The Linux CLAP effect passes audio through unchanged and serves HTTP and WebSocket on `0.0.0.0:8765`. Override the port with `VSTVIS_PORT`. Visuals render in the browser; the tablet remote sends control messages. The server relays text without parsing JSON.

## HTTP

- `GET /`: `index.html` (display); `GET /remote.html`: controller; `GET /start.html`: lets a device choose between the remote and display + remote.
- Other GET paths serve files from `VSTVIS_WEB_DIR`, or the `clapvisualizer.web/` directory beside the loaded plugin, resolved using `dladdr`.
- Paths containing `..` or resolving outside the web directory are rejected. Only GET is supported.
- Supported MIME types include HTML, JavaScript, CSS, JSON, SVG, PNG, JPEG, WebP, ICO and WASM.

## WebSocket `/ws`

| Client text frame | Server action |
|---|---|
| Exact `hello display` | Enable binary audio frames for this client |
| Exact `hello remote` | Disable binary audio frames (also the default) |
| Exact `hello listen` / `hello mute` | Start / stop the playable audio stream for this client |
| Starts with `{"type":"state"` | Store as current state (maximum 64 KiB); relay to all other clients |
| Other text | Relay to all other clients without storing |

A handshake with an `Origin` header is refused with 403 unless the origin's host equals the `Host` header, so only pages served by the plugin can connect from a browser. After the handshake, a new client receives the stored state first, if present. The CLAP state extension saves and restores the same opaque string in the host project. All clients receive transport messages at approximately 20 Hz:

```json
{"type":"transport","bpm":120.0,"playing":true,"beat":17.25,"tsNum":4,"tsDen":4,"rms":0.21,"peak":0.63,"sampleRate":48000,"link":-1}
```

`beat` is host song position in quarter notes. With no host transport, BPM and beat are zero and playing is false. RMS/peak are linear levels over the last send interval, using the stereo maximum. `link` is -1 while Link is off, otherwise the number of other apps in the Ableton Link session. With Link on, at least one peer and the host stopped, `bpm`, `beat` (Link beat at quantum 4) and `playing` (true) come from Link, also in the binary frames; the time signature is then 4/4.

Display clients also receive binary audio at approximately 60 Hz, little-endian:

| Offset | Type | Meaning |
|---|---|---|
| 0 | u8 | Frame type 3 (type 1 had 8-bit samples and is no longer sent) |
| 1 | u8 | Flags; bit 0 means playing |
| 2 | u16 | Samples per channel N = 1024 |
| 4 | f32 | BPM |
| 8 | f64 | Beat position |
| 16 | i16[N] | Latest left samples: clipped `sample * 32767` |
| 16 + 2N | i16[N] | Latest right samples, same encoding |

Listening clients receive the complete signal for playback, about 40 ms per frame. A client more than half a second behind skips frames.

| Offset | Type | Meaning |
|---|---|---|
| 0 | u8 | Frame type 2 |
| 1 | u8 | Channels, always 2 |
| 2 | u16 | Reserved, 0 |
| 4 | u32 | Sample rate |
| 8 | i16[] | Interleaved left/right samples |

Mono input is duplicated. Text messages must be complete, masked, valid UTF-8 WebSocket frames; fragmented and oversized frames are rejected. Ping/Pong and Close are supported.

## State convention

State messages are compact JSON with `type` first (`JSON.stringify`). Send the complete state: the last writer wins. The server does not interpret the fields. Browser state version 2, controls and engine behavior are described in [CONTROL.md](CONTROL.md).

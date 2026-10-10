# Plugin ↔ browser protocol

The Linux CLAP effect passes audio through unchanged and serves HTTP and WebSocket on `0.0.0.0:8765`. Override the port with `VSTVIS_PORT`. Visuals render in the browser; the tablet remote sends control messages. The server relays text without parsing JSON.

## HTTP

- `GET /`: `index.html` (display); `GET /remote.html`: controller.
- Other GET paths serve files from `VSTVIS_WEB_DIR`, or the `clapvisualizer.web/` directory beside the loaded plugin, resolved using `dladdr`.
- Paths containing `..` or resolving outside the web directory are rejected. Only GET is supported.
- Supported MIME types include HTML, JavaScript, CSS, JSON, SVG, PNG, JPEG, WebP, ICO and WASM.

## WebSocket `/ws`

| Client text frame | Server action |
|---|---|
| Exact `hello display` | Enable binary audio frames for this client |
| Exact `hello remote` | Disable binary audio frames (also the default) |
| Starts with `{"type":"state"` | Store as current state (maximum 64 KiB); relay to all other clients |
| Other text | Relay to all other clients without storing |

After the handshake, a new client receives the stored state first, if present. The CLAP state extension saves and restores the same opaque string in the host project. All clients receive transport messages at approximately 20 Hz:

```json
{"type":"transport","bpm":120.0,"playing":true,"beat":17.25,"tsNum":4,"tsDen":4,"rms":0.21,"peak":0.63,"sampleRate":48000}
```

`beat` is host song position in quarter notes. With no host transport, BPM and beat are zero and playing is false. RMS/peak are linear levels over the last send interval, using the stereo maximum.

Display clients also receive binary audio at approximately 60 Hz, little-endian:

| Offset | Type | Meaning |
|---|---|---|
| 0 | u8 | Frame type 1 |
| 1 | u8 | Flags; bit 0 means playing |
| 2 | u16 | Samples per channel N = 1024 |
| 4 | f32 | BPM |
| 8 | f64 | Beat position |
| 16 | u8[N] | Latest left samples: clipped `128 + sample * 127` |
| 16 + N | u8[N] | Latest right samples, same encoding |

Mono input is duplicated. Text messages must be complete, masked, valid UTF-8 WebSocket frames; fragmented and oversized frames are rejected. Ping/Pong and Close are supported.

## State convention

State messages are compact JSON with `type` first (`JSON.stringify`). Send the complete state: the last writer wins. The server does not interpret the fields. Browser state version 2, controls and engine behavior are described in [CONTROL.md](CONTROL.md).

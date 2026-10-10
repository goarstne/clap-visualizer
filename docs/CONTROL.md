# Browser control protocol

Extends [PROTOCOL.md](PROTOCOL.md). Send compact JSON with `type` first. The iPad layout targets 1180×820 CSS pixels in landscape and 820×1180 in portrait.

## Persistent state

Send full state; last writer wins. Unknown fields survive normalization; missing fields use defaults. Legacy `preset`, `gain`, `brightness` map to `deckA`, `fx.gain`, `fx.bright`.

```json
{"type":"state","v":2,"deckA":"<preset>","deckB":"<preset>","xfade":0,"blend":2,"quant":"bar","autoBars":8,"random":true,"locked":false,"fx":{},"sync":{},"scenes":[null,null,null,null,null,null,null,null],"pool":"all","favs":[],"img":[],"stems":{"drums":true,"bass":true,"melody":true},"tag":{"pulse":false,"drip":false,"neon":false,"glitch":false,"rainbow":false,"zoom":false,"spin":false,"drift":false,"wave":false,"trail":false,"add":false,"diff":false,"melt":false}}
```

`xfade` ranges from 0 (A) to 1 (B). `blend` is transition time in seconds (0..10). `autoBars` is 0 (off) or 4/8/16/32; automatic changes load the less visible deck and swap. `locked` prevents auto changes. `pool` is `all`, `milk`, `viz` or `favs`; an empty pool falls back to all. `favs` holds up to 200 names. Eight scenes contain null or `{deckA,deckB,xfade,fx,sync,img}`; images are optional, stems are excluded.

| Effect key | Range | Default |
|---|---|---|
| `speed` | 0..3 | 1 |
| `zoom`, `rot`, `warp`, `dx`, `dy` | -1..1 | 0 |
| `gain` | 0.2..3 | 1 |
| `bass`, `mid`, `treb` | 0..3 | 1 |
| `hue` | 0..360 | 0 |
| `sat`, `bright`, `contrast` | 0..2 | 1 |
| `kaleido` | integer 0..12 | 0 |
| `mirror` | integer 0..3 | 0 |
| `trails` | 0..0.97 | 0 |
| `rgb` | 0..1 | 0 |

Zoom multiplies frame zoom by `1 + 0.25*zoom`; rotation adds `0.5*rot`; warp multiplies by `1 + warp`; displacement adds `0.05*value`. Mirror modes: off, horizontal, vertical, both. Kaleidoscope 0/1 disables. Speed zero nearly freezes.

`sync` maps effect keys to beat periods as strings (`1/2`, `1`, `2`, `4`, `8`); absent disables. The deviation from default is multiplied by an envelope decaying linearly from 1 to 0 over the host-beat period. Stopped transport uses values directly.

## Live controls

```json
{"type":"ctl","k":"fx.zoom","v":0.42}
{"type":"ctl","k":"img.2.shot","v":1,"r":"spin"}
{"type":"ctl","k":"img.2.shot","v":0}
```

Keys: `fx.<key>`, `xfade`, `img.<i>.<key>` (i = 0..4). Send at most once per key per animation frame. On release, persist values and send full state. Spring pads first send neutral. Displays smooth controls over about 60 ms; other remotes reflect them. `img.<i>.on` uses 1/0 for visibility while held.

Shots: `zoom` (default, 0.35 s, starts 90% larger), `spin` (0.6 s, grows from zero with two rotations), `flash` (0.5 s, white flash and three opacity pulses). A tap completes the routine; holding keeps the image visible afterward, release fades it out. Saved transforms remain unchanged.

`tp.<n>` (n = 0..2) uses `[x,y]` in -1..1, y upward, while held and 0 on release: fading light and distortion at the finger location.

Momentary keys use 1 on press, 0 on release:

| Key | Effect |
|---|---|
| `m.flash` | White flash, 150 ms decay, at most three per second |
| `m.black`, `m.invert`, `m.freeze` | Blackout, invert colors, near-zero time scale |
| `m.kick` | Artificial bass impulse on press |
| `m.mirror`, `m.kaleido` | Both-axis mirror, six-segment kaleidoscope |
| `m.strobe` | Half-beat flash, at most three per second |
| `m.zoom`, `m.spin` | Maximum zoom or rotation |
| `m.rgb`, `m.trails` | RGB split 1, trails 0.9 |
| `m.hue`, `m.mono` | Hue cycle once per second, saturation zero |
| `m.shake`, `m.turbo` | Random displacement each frame, time scale 3 |

Displays clear momentary states on disconnect. The remote releases on pointer cancellation, blur and visibility changes.

## Quantized triggers and feedback

```json
{"type":"trig","k":"load","deck":"B","preset":"<name>","q":"off"}
{"type":"trig","k":"scene","i":3,"q":"bar"}
{"type":"trig","k":"img","i":2,"on":true,"q":"bar"}
```

Actions: `swap` crossfades; `load` loads the named deck without changing mix; `scene` restores slot i; `next`/`prev`/`random` load a pool preset on the less visible deck and swap; `show` does the same with a specified preset; `title` animates `text`; `img` sets visibility to `on` or toggles if absent.

`q`: `off` immediate, `beat` next beat, `bar` next bar, `4bar` next bar divisible by four. Stopped transport or zero BPM executes immediately. One pending action per key; newer replaces older. Images use separate keys `img<i>`. Each display executes independently and sends state afterward. The remote saves scenes itself.

```json
{"type":"thumb","preset":"<name>","data":"data:image/jpeg;base64,..."}
{"type":"pending","k":"swap","beats":2.5}
{"type":"bands","drums":0.42,"bass":0.61,"melody":0.18}
```

Thumbnails: 96×54 JPEG, quality about 0.5, under 6 KiB, once per preset/session after three seconds visible; cached by the remote. Optional pending feedback: about 5 Hz; zero means complete. Bands: about 10 Hz even for disabled sources, 0..1, fast attack and about 0.3 s decay.

Audio bands use frequency/transient filtering: drums = transients below 180 Hz and 180 Hz..5 kHz with about 100 ms decay, plus content above 5 kHz; bass = sustained content below 180 Hz; melody = sustained content between 180 Hz and 5 kHz. All enabled bypasses exactly; all disabled is silence. Missing/invalid selection defaults to all. Selection affects both engines and image pulse; sensitivity applies afterward.

## Graffiti tags

The remote's canvas switch replaces the dashboard with a 16:9 wall. Strokes are drawn with the finger; the finish button sends the tag and clears the wall for the next one.

```json
{"type":"tag","strokes":[{"c":"#ffe600","w":0.018,"p":[200,700,300,250,400,700]}]}
{"type":"trig","k":"tag","fx":"burst","q":"bar"}
{"type":"tags","n":2}
```

`tag` is transient and not stored. `c` is `#rrggbb`, `w` the line width relative to the picture height (0.003..0.08), `p` a flat list of x,y pairs in 0..1000 with the origin at the top left. The remote keeps a tag under 4000 points and thins it out to stay below 60 kB; displays clamp everything and keep the six newest tags. Displays answer every change with `tags` (number on the wall).

Sixteen buttons sit above the wall in two rows. `write` replays the strokes over 1.4 s, `burst` scatters the points and reassembles them (0.9 s) and `wipe` fades all tags out (0.6 s) — these are quantized triggers with pending keys `tag<fx>`. Everything else is a boolean in `state.tag`; scenes do not include them.

| Mode | Effect |
|---|---|
| `pulse` | Scale on the host beat, bass level when stopped |
| `drip` | Paint runs grow over 3.5 s |
| `neon` | Glow with white core instead of black outline |
| `glitch` | Jumping cyan/magenta copies |
| `rainbow` | Cycling colours |
| `zoom` | Breathes in and out, one cycle per four beats |
| `spin` | Rotates around the tag's centre, one turn per eight beats, alternating direction per tag |
| `drift` | Wanders across the picture |
| `wave` | Bends the strokes |
| `trail` | The layer fades instead of clearing, so moving tags leave a tail |
| `add`, `diff`, `melt` | How the tag blends with the picture: add light, difference, or bend and tint the picture underneath. The remote keeps at most one enabled; `melt` wins over `diff` over `add` |

Movement runs on host beats while the transport plays and at 120 BPM otherwise.

## Images, layout and rendering

`make pictures` copies JPG/JPEG/PNG/WebP from `PICTURES` (default `Pictues/`) and generates sorted `index.json`. Layer i uses `src`, or the i-th filename if empty.

| Image field | Range | Default | Meaning |
|---|---|---|---|
| `src`, `on` | Filename, boolean | empty, false | Source and visibility (about 0.1 s fade) |
| `x`, `y` | -1.5..1.5 | 0 | Center; ±1 screen edge, y upward |
| `s` | 0.05..4 | 0.6 | Scale; 1 fits image |
| `r`, `o` | ±31.4 radians, 0..1 | 0, 1 | Clockwise rotation, opacity |
| `m` | 0..5 | 0 | Normal, Add, Screen, Multiply, Difference, Luma key |
| `pulse`, `spin` | 0..1, -2..2 | 0, 0 | Bass scale, rotation (1 = half turn/second) |
| `tile`, `hue`, `wob` | 1..6, 0..360, 0..1 | 1, 0, 0 | n×n tiles, hue, distortion |
| `top` | Boolean | false | Render above effects |

Landscape has four independently scrolling columns: decks/browser; performance/shots; image stage; scenes/effects. Portrait uses two columns and page scrolling. Four effect XY pads store assignments/spring mode in `vstvis_pads`; two image pads affect the selected image. Stage assumes 16:9; other ratios match relative positions, not exact pixels.

`ws.js` handles connectivity, `controls.js` touch widgets, `engine.js` decks/transitions/scenes, `viz.js` shaders/analysis, `tags.js` the graffiti layer, `postfx.js` WebGL2 compositing. `index.html` is the display; `remote.html` the controller. `postfx-test.html` provides pixel checks; `tools/webtest.js` checks analysis and state.

```js
const levels = ShaderViz.analyze(wave, dt, sampleRate);
const viz = ShaderViz.create(); // null without WebGL2
viz.resize(w, h); viz.render(name, levels, fx, dt);
viz.canvas; viz.destroy();
const fx = PostFX.create(canvas); // null without WebGL2
fx.resize(width, height); fx.render(srcA, srcB, params);
fx.setImage(i, image); // null clears layer
fx.destroy();
const tags = VJTags.create();
tags.add(strokes, now); tags.trigger('burst', now);
if (tags.render(now, state.tag, pulse, clock)) params.tag = tags.canvas; // 1280×720, transparent; clock in beats
params.tagBlend = 0; // 1 add, 2 difference, 3 melt
```

`ShaderViz.names` contains seven `◆ ` presets: Spektrum, Oszilloskop, Kreis, Tunnel, Plasma, Sterne, Gitter. A 1024-sample FFT provides a 512×2 texture (log spectrum 30 Hz..16 kHz, waveform). Camera controls use zoom/rotation/warp/displacement. dt is already speed-scaled.

PostFX params: `mix`, effect/color values, `invert`/`flash`/`black` (0..1), five `layers`, three touch points `{x,y,a}`, `time` seconds. Pipeline: touch distortion → mirror/kaleidoscope → A/B mix → normal images → graffiti tags (`tag`, a canvas with alpha, uploaded each frame while shown) → RGB split → color → trails → top images → touch light → flash → blackout. Defaults reproduce A; srcB may be null.

Butterchurn hooks wrap `presetEquationRunner.runFrameEquations` and modify `mdVSFrame`; reinstall after every load. `render({audioLevels, elapsedTime})` uses seconds; freeze with a tiny nonzero value because zero means unspecified. Color/inversion run through PostFX. Render hidden decks immediately before mixing.

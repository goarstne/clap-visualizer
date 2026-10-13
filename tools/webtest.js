// Checks the browser-side logic that needs no browser: spectrum analysis and state clamping.
const assert = require('assert');
const path = require('path');
const web = path.join(__dirname, '..', 'web');

const viz = require(path.join(web, 'viz.js'));
// 3 kHz sine at 48 kHz: the peak must land at 3 kHz on the 30 Hz..16 kHz log axis.
const wave = Uint8Array.from({ length: 1024 }, (_, i) => 128 + 100 * Math.sin(2 * Math.PI * 3000 * i / 48000));
const levels = viz.analyze(wave, 0.016, 48000);
const peak = levels.tex.subarray(0, 512).indexOf(Math.max(...levels.tex.subarray(0, 512)));
const expected = 511 * Math.log(3000 / 30) / Math.log(16000 / 30);
assert(Math.abs(peak - expected) < 8, `peak at ${peak}, expected ${expected}`);
assert(levels.mid + levels.treb > levels.bass * 5 && levels.tex[512] === wave[0]);
assert(viz.names.length === 7 && viz.names.every(name => name.startsWith('◆ ')));

// Clubber-style 4D vectors (energy, envelope, trigger, pitch) & musical note detection
const resA2 = viz.analyze(Uint8Array.from({ length: 1024 }, (_, i) => Math.round(128 + 100 * Math.sin(2 * Math.PI * 110 * i / 48000))), 0.016, 48000);
assert(resA2.bands && resA2.bands.bass && resA2.bands.bass.length === 4);
assert.strictEqual(resA2.notes.bass, 'A2');
for (const k of ['kick', 'bass', 'lead', 'hats']) {
  assert(resA2.bands[k].every(v => v >= 0 && v <= 1));
}
const resA4 = viz.analyze(Uint8Array.from({ length: 1024 }, (_, i) => Math.round(128 + 100 * Math.sin(2 * Math.PI * 440 * i / 48000))), 0.016, 48000);
assert.strictEqual(resA4.notes.lead, 'A4');
// Two seconds at 120 BPM over a noise floor: kicks on the beat, hats in between. Each band fires only
// for its own instrument, and the wide hats band stays clear of full scale.
{
  let seed = 1; const noise = () => ((seed = seed * 1664525 + 1013904223 >>> 0) / 2 ** 32) * 2 - 1;
  const song = Float32Array.from({ length: 96000 }, (_, i) => {
    const t = i / 48000, beat = t % 0.5, off = (t + 0.25) % 0.5;
    return 0.6 * Math.sin(2 * Math.PI * 55 * beat) * Math.exp(-beat * 18) + 0.25 * noise() * Math.exp(-off * 60) + 0.05 * noise();
  });
  const onsets = { kick: [], hats: [] }, was = {}; let top = 0;
  for (let frame = 20; frame < 120; frame++) {
    const end = frame * 800, res = viz.analyze(Uint8Array.from({ length: 1024 }, (_, i) => Math.round(128 + 127 * song[end - 1024 + i])), 1 / 60, 48000);
    // The first frames only settle the envelopes after the tones above.
    for (const key of ['kick', 'hats']) { if (frame > 24 && res.hits[key] && !was[key]) onsets[key].push(Math.round(frame / 15) / 4); was[key] = res.hits[key]; }
    top = Math.max(top, res.bands.hats[0]);
  }
  assert.deepStrictEqual(onsets, { kick: [0.5, 1, 1.5], hats: [0.75, 1.25, 1.75] });
  assert(top > 0.15 && top < 0.9, `hats energy ${top}`);
}
// At 96 kHz the kick band still holds a bin.
assert(viz.analyze(Uint8Array.from({ length: 1024 }, (_, i) => Math.round(128 + 100 * Math.sin(2 * Math.PI * 90 * i / 96000))), 0.016, 96000).bands.kick[0] > 0.3);

global.window = { location: { search: '' } };
require(path.join(web, 'engine.js'));
const { normalize, Engine } = global.window.VJEngine;
const state = normalize({ v: 2, pool: 'nope', favs: ['a', 3], img: [{ on: 1, s: 99, x: 'left', m: 9, src: 5 }, null] }, {}, ['a', 'b']);
assert.strictEqual(state.img.length, 5);
assert.deepStrictEqual(state.img[0], { src: '', on: true, x: 0, y: 0, s: 4, r: 0, o: 1, m: 0, pulse: 0, spin: 0, top: false, tile: 1, hue: 0, wob: 0, depth: 0 });
assert(state.pool === 'all' && state.favs.length === 1 && state.deckA === 'a' && state.scenes.length === 8);
// A later partial state keeps what was set before.
assert.strictEqual(normalize({ v: 2, img: [{ r: 1 }] }, state, ['a', 'b']).img[0].s, 4);
const all = { drums: true, bass: true, melody: true }, none = { drums: false, bass: false, melody: false };
assert.deepStrictEqual(state.stems, all);
for (const stems of [null, [], { drums: true }, { ...all, bass: 1 }]) {
  assert.deepStrictEqual(normalize({ v: 2, stems }).stems, all);
}
assert.deepStrictEqual(normalize({ v: 2, stems: none }).stems, none);
assert.deepStrictEqual(normalize({ v: 2, stems: { ...all, hats: false } }).stems, { ...all, hats: false });
assert.deepStrictEqual(normalize({ v: 2, stems: { ...none, hats: true } }).stems, { ...none, hats: true });
const sine = hz => Array.from({ length: 1024 }, (_, i) => 128 + 100 * Math.sin(2 * Math.PI * hz * i / 48000));
const low = viz.splitStems(sine(60), all, 48000), high = viz.splitStems(sine(1000), all, 48000);
assert(low.bass > 0.4 && low.bass > low.melody * 5 && low.drums < 0.01);
assert(high.melody > 0.4 && high.melody > high.bass * 10 && high.melody > high.drums * 5);
const clicks = Array.from({ length: 1024 }, (_, i) => i % 240 === 0 ? 255 : 128);
const hit = viz.splitStems(clicks, all, 48000);
assert(hit.drums > 10 * (hit.bass + hit.melody));
for (const selected of [all, none, { ...none, bass: true }, { ...none, melody: true }, { ...none, drums: true }]) {
  const quiet = viz.splitStems(Array(1024).fill(128), selected, 48000);
  assert(quiet.wave.every(value => value === 128) && quiet.drums + quiet.bass + quiet.melody === 0);
}
assert.strictEqual(viz.splitStems(wave, all, 48000).wave, wave);
assert(viz.splitStems(wave, none, 48000).wave.every(value => value === 128));
assert.deepStrictEqual(viz.splitStems(clicks, none, 48000).drums, hit.drums);
const selectedBass = viz.splitStems(sine(60), { ...none, bass: true }, 48000);
assert(selectedBass.wave.some(value => value !== 128));

// Repeated decaying kicks keep their body in drums; a sustained low tone stays bass.
const lowEnergy = burst => {
  const history = {}, energy = { drums: 0, bass: 0, melody: 0 };
  for (let pos = 0; pos < 48000 * 3; pos += 1024) {
    const block = Uint8Array.from({ length: 1024 }, (_, i) => {
      const t = (pos + i) / 48000, envelope = burst ? Math.exp(-(t % 0.5) / 0.035) : 1;
      return Math.round(128 + 100 * envelope * Math.sin(2 * Math.PI * 60 * t));
    });
    const split = viz.splitStems(block, all, 48000, history);
    assert.strictEqual(split.wave, block);
    for (const key of Object.keys(energy)) energy[key] += split[key] ** 2;
  }
  const quiet = viz.splitStems(Array(1024).fill(128), all, 48000, history);
  assert.strictEqual(quiet.drums + quiet.bass + quiet.melody, 0);
  return energy;
};
const kicks = lowEnergy(true), sustained = lowEnergy(false);
assert(kicks.drums > 2 * (kicks.bass + kicks.melody), JSON.stringify(kicks));
assert(sustained.bass > 10 * (sustained.drums + sustained.melody), JSON.stringify(sustained));
const history = {};
viz.splitStems(clicks, all, 48000, history);
const gate = history.midGate;
viz.splitStems(Array(1024).fill(128), all, 48000, history);
assert(gate > 0 && history.midGate > 0 && history.midGate < gate);
assert.deepStrictEqual(viz.splitStems(clicks, all, 48000), viz.splitStems(clicks, all, 48000, {}));
// The complementary low/high crossover preserves energy, with a phase shift.
const parts = ['drums', 'bass', 'melody'].map(key => viz.splitStems(wave, { ...none, [key]: true }, 48000).wave);
const inputEnergy = wave.reduce((sum, value) => sum + (value - 128) ** 2, 0);
const sumEnergy = wave.reduce((sum, _, i) => sum + parts.reduce((value, part) => value + part[i] - 128, 0) ** 2, 0);
assert(Math.abs(sumEnergy / inputEnergy - 1) < 0.05);

// Exercise the shared display path without constructing canvases or a WebSocket.
global.window.ShaderViz = viz;
const engine = Object.create(Engine.prototype), sent = [];
Object.assign(engine, {
  state: normalize({ v: 2, stems: all }), frameFX: { gain: 1.4, bass: 0.7, mid: 1.8, treb: 0.5 },
  transport: { sampleRate: 48000 }, rawL: wave, rawR: Uint8Array.from(sine(60)),
  levels: { timeByteArray: new Uint8Array(1024), timeByteArrayL: new Uint8Array(1024), timeByteArrayR: new Uint8Array(1024) },
  kickAt: -Infinity, lastAudio: 0, audioFrameAt: 0, lastBands: -Infinity,
  stemState: [{}, {}], bands: { drums: 0, bass: 0, melody: 0 }, socket: { send: message => sent.push(message) }
});
const legacy = raw => {
  let bass = 0, mid = 0;
  return Uint8Array.from(raw, byte => {
    const sample = (byte - 128) / 127, fx = engine.frameFX;
    bass += (1 - Math.exp(-2 * Math.PI * 200 / 48000)) * (sample - bass);
    mid += (1 - Math.exp(-2 * Math.PI * 2500 / 48000)) * (sample - mid);
    return Math.round(Math.max(0, Math.min(255, 128 + 127 * fx.gain * (bass * fx.bass + (mid - bass) * fx.mid + (sample - mid) * fx.treb))));
  });
};
engine.processAudio(16);
assert.notStrictEqual(engine.stemState[0], engine.stemState[1]);
assert.notStrictEqual(engine.stemState[0].lowSlow, engine.stemState[1].lowSlow);
assert.deepStrictEqual(engine.levels.timeByteArrayL, legacy(engine.rawL));
assert.deepStrictEqual(engine.levels.timeByteArrayR, legacy(engine.rawR));
engine.state.stems = none;
for (let time = 32; time <= 224; time += 16) engine.processAudio(time);
assert(engine.levels.timeByteArray.every(value => value === 128));
assert.strictEqual(sent.length, 2);
assert(sent.every(message => message.type === 'bands' && message.bass > 0 && Object.values(message).slice(1).every(value => value >= 0 && value <= 1)));
const beforeDecay = engine.bands.bass;
engine.processAudio(524);
assert(Math.abs(engine.bands.bass - beforeDecay * Math.exp(-1)) < 1e-10);
// A hit seen between two messages is reported once, with the next one.
engine.hit = { kick: 1, hats: 0 }; engine.processAudio(700); engine.processAudio(900);
assert.deepStrictEqual(sent.slice(-2).map(message => [message.kickHit, message.hatsHit]), [[1, 0], [0, 0]]);
// With a hats switch, each level meter measures what its switch selects.
{
  const four = { ...all, hats: true }, hit = viz.splitStems(clicks, four, 48000), old = viz.splitStems(clicks, all, 48000);
  assert(hit.hats > 5 * hit.drums && Math.abs(old.drums - hit.hats) < 0.05, JSON.stringify([hit.drums, hit.hats, old.drums]));
  const kickOnly = viz.splitStems(clicks, { ...none, drums: true, hats: false }, 48000).wave;
  assert(kickOnly.every(value => Math.abs(value - 128) < 127 * 0.2));
}

for (const routine of ['zoom', 'spin', 'flash', 'unknown']) {
  const test = Object.create(Engine.prototype);
  Object.assign(test, { state: normalize({ v: 2 }), imgHeld: [], spectrum: null,
    flashes: [], flashAt: -Infinity, layerNow: normalize({ v: 2 }).img.map(layer => ({ ...layer, gain: 0, angle: 0, shot: null })) });
  const stored = JSON.stringify(test.state);
  test.message({ type: 'ctl', k: 'img.0.shot', v: 1, r: routine });
  const shot = test.layerNow[0].shot, start = shot.start;
  assert.strictEqual(shot.routine, routine === 'unknown' ? 'zoom' : routine);
  const first = test.layers(0, start)[0];
  if (shot.routine === 'zoom') assert.strictEqual(first.s, 0.6 * 1.9);
  if (shot.routine === 'spin') {
    assert.strictEqual(first.s, 0);
    const half = test.layers(0, start + 300)[0];
    assert.strictEqual(half.s, 0.3); assert.strictEqual(half.r, 2 * Math.PI);
  }
  if (shot.routine === 'flash') {
    assert.strictEqual(test.flashAt, start);
    for (const phase of [1 / 6, 3 / 6, 5 / 6]) assert(Math.abs(test.layers(0, start + phase * 500)[0].o - 0.25) < 1e-10);
  }
  assert.strictEqual(test.layers(0.016, start + shot.duration)[0].o, 1); // held after routine
  test.message({ type: 'ctl', k: 'img.0.shot', v: 0 });
  assert(test.layers(0.1, start + shot.duration + 100)[0].o < 0.5);
  test.message({ type: 'ctl', k: 'img.0.shot', v: 1, r: routine });
  const tap = test.layerNow[0].shot;
  test.message({ type: 'ctl', k: 'img.0.shot', v: 0 });
  assert(test.layers(0.1, tap.start + tap.duration / 2)[0].o > 0);
  assert.strictEqual(test.layerNow[0].gain, 1); // release did not start the fade early
  test.layers(0.1, tap.start + tap.duration + 100);
  assert(test.layerNow[0].gain < 0.5 && !test.layerNow[0].shot);
  assert.strictEqual(JSON.stringify(test.state), stored);
}
console.log('Web: spectrum peak, shader type list, state clamping, stems, audio bypass/bands, shot routines OK');

// Graffiti tags: effect modes are plain booleans, and tag strokes from the wire are clamped.
const tagModes = ['pulse', 'drip', 'neon', 'glitch', 'rainbow', 'zoom', 'spin', 'drift', 'wave', 'trail', 'add', 'diff', 'melt'];
const tagState = on => Object.fromEntries(tagModes.map(key => [key, on.includes(key)]));
assert.deepStrictEqual(normalize({ v: 2 }).tag, tagState([]));
assert.deepStrictEqual(normalize({ v: 2, tag: { neon: true, spin: true, drip: 1, off: false } }).tag, tagState(['neon', 'spin']));
// A mode from a newer page survives a round trip through this one.
assert.deepStrictEqual(normalize({ v: 2, tag: { neon: true, future: true } }).tag, { ...tagState(['neon']), future: true });
assert.strictEqual(normalize({ v: 2 }, normalize({ v: 2, tag: { pulse: true } })).tag.pulse, true);
require(path.join(web, 'tags.js'));
const { parse } = global.window.VJTags;
assert.deepStrictEqual(global.window.VJTags.MODES, tagModes);
assert.strictEqual(parse(null), null);
assert.strictEqual(parse([{ p: [1] }, { c: '#fff' }]), null);
const tag = parse([{ c: '#ffe600', w: 0.02, p: [0, 0, 500, 0, 500, 1000] }, { c: 'url(x)', w: 99, p: [-50, 2000, 'x', 400] }]);
assert.strictEqual(tag.strokes.length, 2);
assert.deepStrictEqual(Array.from(tag.strokes[0].points), [0, 0, 0.5, 0, 0.5, 1]);
// 0.5 of the 1280 px width, then the full 720 px height.
assert.deepStrictEqual(Array.from(tag.strokes[0].length), [0, 640, 1360]);
assert.deepStrictEqual(Array.from(tag.strokes[1].points), [0, 1, 0, 0.4000000059604645]);
assert(tag.strokes[1].color === '#ffffff' && Math.abs(tag.strokes[1].width - 0.08 * 720) < 1e-9);
assert(tag.drips.length >= 2 && tag.path > 1360);
// A flood of points is cut off instead of stalling the display.
assert.strictEqual(parse([{ p: Array(20000).fill(5) }]).strokes[0].count, 4000);
console.log('Graffiti tags: state modes and stroke parsing OK');

// Shader types saved under their former German names still load.
assert.strictEqual(viz.rename('◆ Sterne'), '◆ Stars');
assert.strictEqual(viz.rename('Sterne'), 'Sterne');
const renamed = normalize({ v: 2, deckA: '◆ Gitter', favs: ['◆ Kreis', 'x'], scenes: [{ deckA: '◆ Spektrum', deckB: 'b' }] }, {}, viz.names);
assert(renamed.deckA === '◆ Grid' && renamed.favs[0] === '◆ Circle' && renamed.scenes[0].deckA === '◆ Spectrum' && renamed.scenes[0].deckB === 'b');
console.log('Legacy shader names: mapped to the English ones OK');

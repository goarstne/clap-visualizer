// Synthesises the demo track (no third-party material): 120 BPM, kick, snare, hats, bass, arpeggio.
// Usage: node tools/demo/music.js <out.f32> [seconds]   -> raw stereo float32 LE, 48 kHz
const fs = require('fs'), rate = 48000, seconds = Number(process.argv[3]) || 120, n = rate * seconds;
const left = new Float32Array(n), right = new Float32Array(n), TAU = 2 * Math.PI;
let seed = 1; const noise = () => ((seed = seed * 1664525 + 1013904223 >>> 0) / 2147483648 - 1);
const add = (at, length, voice, panL = 1, panR = 1) => { const start = Math.round(at * rate); for (let i = 0; i < length * rate && start + i < n; i++) { const v = voice(i / rate); left[start + i] += v * panL; right[start + i] += v * panR; } };
const chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [261.63, 329.63, 392], [196, 246.94, 293.66]], roots = [55, 43.65, 65.41, 49];
for (let beat = 0; beat * 0.5 < seconds; beat++) {
  const t = beat * 0.5, bar = Math.floor(beat / 4), chord = chords[bar % 4], drums = bar >= 2, full = bar >= 4;
  if (drums) add(t, 0.3, x => 0.85 * Math.exp(-x * 14) * Math.sin(TAU * (45 * x + 5 * (1 - Math.exp(-x * 28)))));
  if (drums) add(t + 0.25, 0.08, (() => { let prev = 0; return x => { const w = noise(), v = w - prev; prev = w; return 0.13 * v * Math.exp(-x * 55); }; })(), 0.8, 1);
  if (full && beat % 2 === 1) add(t, 0.22, x => 0.3 * Math.exp(-x * 16) * (noise() * 0.8 + Math.sin(TAU * 185 * x) * 0.6));
  if (full) for (const off of [0, 0.25]) add(t + off, 0.23, x => { const f = roots[bar % 4] * (off && beat % 4 === 3 ? 1.5 : 1), p = TAU * f * x;
    return 0.3 * Math.min(1, x * 200) * Math.exp(-x * 5) * (Math.sin(p) + 0.45 * Math.sin(2 * p) + 0.2 * Math.sin(3 * p)) * (off ? 1 : 0.55); });
  for (let step = 0; step < 4; step++) { const f = chord[(step + beat) % 3] * (step === 3 ? 2 : 1) * (bar % 8 >= 4 ? 2 : 1);
    add(t + step * 0.125, 0.3, x => 0.17 * Math.min(1, x * 400) * Math.exp(-x * 9) * (Math.sin(TAU * f * x) + 0.3 * Math.sin(TAU * 3 * f * x)), step % 2 ? 0.55 : 1, step % 2 ? 1 : 0.55); }
  if (beat % 4 === 0) for (const f of chord) add(t, 2, x => 0.035 * Math.min(1, x * 4) * Math.min(1, (2 - x) * 4) * Math.sin(TAU * f * 0.5 * x));
}
const out = new Float32Array(2 * n);
for (let i = 0; i < n; i++) { out[2 * i] = Math.tanh(left[i] * 1.1); out[2 * i + 1] = Math.tanh(right[i] * 1.1); }
fs.writeFileSync(process.argv[2], Buffer.from(out.buffer));

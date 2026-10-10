// Usage: node tools/stemcheck.js <repo> '[["name","file.f32",fromSec,toSec],...]'  (mono float32 LE, 48 kHz;
//   ffmpeg -i song.mp3 -ac 1 -ar 48000 -f f32le song.f32)
// Feeds real music through the same path as the display: 1024-sample 8-bit blocks at 60 Hz,
// stem split, band smoothing as in engine.js, meter mapping as in remote.html.
const fs = require('fs'), viz = require(process.argv[2] + '/web/viz.js');
const all = { drums: true, bass: true, melody: true }, keys = ['drums', 'bass', 'melody'];
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
for (const [name, file, from, to] of JSON.parse(process.argv[3])) {
  const pcm = new Float32Array(fs.readFileSync(file).buffer), hop = 800, dt = 1 / 60;
  const band = { drums: 0, bass: 0, melody: 0 }, fill = { drums: [], bass: [], melody: [] }, energy = { drums: 0, bass: 0, melody: 0 };
  const block = new Uint8Array(1024), state = {};
  for (let pos = Math.max(1024, from * 48000); pos < Math.min(pcm.length, to * 48000); pos += hop) {
    for (let i = 0; i < 1024; i++) block[i] = Math.max(0, Math.min(255, Math.round(128 + pcm[pos - 1024 + i] * 127)));
    const split = viz.splitStems(block, all, 48000, state);
    for (const k of keys) {
      band[k] += (split[k] - band[k]) * (1 - Math.exp(-dt / (split[k] > band[k] ? 0.02 : 0.3)));
      fill[k].push(Math.min(1, Math.sqrt(Math.max(0, band[k])) * 1.15)); energy[k] += split[k] ** 2;
    }
  }
  const total = keys.reduce((s, k) => s + energy[k], 0);
  console.log(name);
  for (const k of keys) {
    const a = fill[k].slice().sort((x, y) => x - y);
    console.log(`  ${k.padEnd(6)} Anteil ${(100 * energy[k] / total).toFixed(0).padStart(3)} %  Füllung: Median ${(100 * pct(a, 0.5)).toFixed(0)} %, 10.-90. Perzentil ${(100 * pct(a, 0.1)).toFixed(0)}-${(100 * pct(a, 0.9)).toFixed(0)} %, voll ${(100 * a.filter(v => v >= 0.999).length / a.length).toFixed(0)} % der Zeit`);
  }
}

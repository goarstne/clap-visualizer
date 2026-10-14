// Live mode without a DAW: build/clapvisualizer-live gets a sine on stdin, starts with Link on,
// starts in auto mode (VSTVIS_AUTO), follows a Link peer at 133 BPM and keeps the controller state in its config file.
// Run after `make all`: node tools/livetest.js
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const port = 18772, config = fs.mkdtempSync(path.join(os.tmpdir(), 'livetest-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const peer = spawn('tools/linkpeer', ['133', '60'], { stdio: ['ignore', 'pipe', 'inherit'] });
let peerLines = 0, live = null, last = null, sending = null, state = null;
peer.stdout.on('data', chunk => { peerLines += String(chunk).split('\n').length - 1; });
const done = code => { clearInterval(sending); if (live) live.kill(); peer.kill(); process.exit(code); };
setTimeout(() => { console.error('livetest: timeout'); done(1); }, 30000);

async function until(test, what) {
  for (let i = 0; i < 200; i++) { if (last && test(last)) return last; await sleep(50); }
  throw new Error('no transport with ' + what + ', last: ' + JSON.stringify(last));
}

(async () => {
  while (peerLines < 2) await sleep(50);
  live = spawn('build/clapvisualizer-live', ['build/clapvisualizer.clap'], {
    env: { ...process.env, VSTVIS_PORT: String(port), VSTVIS_WEB_DIR: process.cwd() + '/web', VSTVIS_NO_WINDOW: '1', VSTVIS_AUTO: '1', XDG_CONFIG_HOME: config },
    stdio: ['pipe', 'ignore', 'inherit']
  });
  // 10 ms of a 220 Hz sine at half scale every 10 ms, stereo float32 like pw-record.
  let frame = 0;
  sending = setInterval(() => {
    const block = new Float32Array(2 * 480);
    for (let i = 0; i < 480; i++, frame++) block[2 * i] = block[2 * i + 1] = 0.5 * Math.sin(2 * Math.PI * 220 * frame / 48000);
    live.stdin.write(Buffer.from(block.buffer));
  }, 10);

  let socket;
  for (let i = 0; i < 50 && !socket; i++) {
    await sleep(100);
    socket = await new Promise(resolve => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      s.onopen = () => resolve(s); s.onerror = () => resolve(null);
    });
  }
  socket.onmessage = event => { if (typeof event.data === 'string') { const m = JSON.parse(event.data); if (m.type === 'transport') last = m; if (m.type === 'state') state = m; } };
  const a = await until(t => t.link >= 1 && t.playing && t.rms > 0.2, 'Link and sound');
  assert(Math.abs(a.bpm - 133) < 0.01, 'tempo ' + a.bpm);
  assert(state && state.link === true && state.auto === true, 'Live + Auto DJ starts with Link and auto mode: ' + JSON.stringify(state));

  socket.send(JSON.stringify({ type: 'state', v: 2, link: true, xfade: 0.5 }));
  await sleep(1500);
  clearInterval(sending); live.kill('SIGTERM');
  await new Promise(resolve => live.on('exit', resolve)); live = null;
  const saved = JSON.parse(fs.readFileSync(path.join(config, 'clapvisualizer', 'live.json'), 'utf8'));
  assert(saved.xfade === 0.5 && saved.link === true, 'state saved: ' + JSON.stringify(saved));
  console.log('livetest: ok (' + a.bpm.toFixed(1) + ' BPM over Link, rms ' + a.rms.toFixed(2) + ', state saved)');
  done(0);
})().catch(error => { console.error('livetest:', error.message); done(1); });

// Ableton Link: a peer at 133 BPM drives the transport while the host is stopped, and only
// while the remote has Link switched on. Run after `make all`: node tools/linktest.js
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const port = 18771;
// A project saved with Link on still opens with Link off.
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'linktest-')), 'state.json');
fs.writeFileSync(stateFile, JSON.stringify({ type: 'state', v: 2, link: true }));

const host = spawn('tools/fakehost', ['0', 'build/clapvisualizer.clap'], {
  env: { ...process.env, VSTVIS_PORT: String(port), VSTVIS_WEB_DIR: process.cwd() + '/web', VSTVIS_FAKE_STOPPED: '1', VSTVIS_STATE_FILE: stateFile }, stdio: 'ignore'
});
const peer = spawn('tools/linkpeer', ['133', '60'], { stdio: ['ignore', 'pipe', 'inherit'] });
let peerLines = 0;
peer.stdout.on('data', chunk => { peerLines += String(chunk).split('\n').length - 1; });
const done = code => { host.kill('SIGINT'); peer.kill(); process.exit(code); };
setTimeout(() => { console.error('linktest: timeout'); done(1); }, 30000);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let last = null, state = null;
async function until(test, what) {
  for (let i = 0; i < 200; i++) { if (last && test(last)) return last; await sleep(50); }
  throw new Error('no transport with ' + what + ', last: ' + JSON.stringify(last));
}

(async () => {
  let socket;
  for (let i = 0; i < 50 && !socket; i++) {
    await sleep(100);
    socket = await new Promise(resolve => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      s.onopen = () => resolve(s); s.onerror = () => resolve(null);
    });
  }
  socket.onmessage = event => { if (typeof event.data === 'string') { const m = JSON.parse(event.data); if (m.type === 'transport') last = m; if (m.type === 'state') state = m; } };
  socket.send('hello remote');
  await until(t => t.link === -1 && !t.playing, 'Link off');
  assert(state && state.link === false, 'saved Link switch is cleared: ' + JSON.stringify(state));
  // Link keeps the older session; sessions less than 0.5 s apart are a coin toss. The DJ app
  // switches Link on first, so the peer gets a head start here.
  while (peerLines < 2) await sleep(50);
  socket.send(JSON.stringify({ type: 'state', v: 2, link: true }));
  const a = await until(t => t.link >= 1 && t.playing, 'Link peer');
  assert(Math.abs(a.bpm - 133) < 0.01, 'tempo ' + a.bpm);
  await sleep(500);
  assert(last.beat - a.beat > 0.5 && last.beat - a.beat < 2, 'beat runs at 133 BPM: ' + a.beat + ' -> ' + last.beat);
  socket.send(JSON.stringify({ type: 'state', v: 2, link: false }));
  const b = await until(t => t.link === -1, 'Link off again');
  assert(!b.playing && b.bpm === 120, 'host transport is back');
  console.log('linktest: ok (' + a.link + ' peer, ' + a.bpm + ' BPM)');
  done(0);
})().catch(error => { console.error('linktest:', error.message); done(1); });

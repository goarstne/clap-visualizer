// Records the demo video: display and remote on one page (tools/demo/demo.html), remote driven by touch input.
// Usage: PW=<dir with node_modules/playwright> node tools/demo/record.js <web dir> <music.f32> <out dir>
//   <web dir>: copy of web/ plus demo.html and a pictures/ folder that is safe to publish (see demo/CREDITS.md)
//   <music.f32>: output of tools/demo/music.js. Prints JSON with the video path and the audio offset for ffmpeg.
const assert = require('assert');
const { chromium } = require(process.env.PW + '/node_modules/playwright');
const { spawn } = require('child_process'), fs = require('fs'), path = require('path');
const [webDir, musicFile, outDir] = process.argv.slice(2).map(p => path.resolve(p)), port = 18780, root = path.join(__dirname, '..', '..');

(async () => {
  const stateFile = path.join(outDir, 'state.json'); fs.rmSync(stateFile, { force: true });
  const host = spawn(path.join(root, 'tools/fakehost'), ['0', path.join(root, 'build/clapvisualizer.clap')], {
    env: { ...process.env, VSTVIS_PORT: String(port), VSTVIS_WEB_DIR: webDir, VSTVIS_FAKE_AUDIO: musicFile, VSTVIS_STATE_FILE: stateFile }, stdio: ['ignore', 'ignore', 'pipe']
  });
  const audioAt = await new Promise((resolve, reject) => { host.stderr.on('data', d => { if (String(d).includes('audio running')) resolve(Date.now()); }); host.on('exit', () => reject(new Error('fakehost exited'))); });
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, hasTouch: true });
  const page = await context.newPage(), errors = [], pictures = new Set();
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/pictures/')) pictures.add(decodeURIComponent(r.url().split('/pictures/')[1])); });
  await page.goto(`http://localhost:${port}/demo.html`);
  const remote = page.frameLocator('#remote'), display = page.frames().find(f => f.url().includes('scale=')), remoteFrame = page.frames().find(f => f.url().includes('remote.html'));
  await display.waitForFunction(() => window.vj && vj.pictures.length > 0 && vj.socket.ws && vj.socket.ws.readyState === 1);
  const fps = () => display.evaluate(() => new Promise(done => { let n = 0; const t = performance.now(); const f = () => { n++; performance.now() - t < 1000 ? requestAnimationFrame(f) : done(n); }; requestAnimationFrame(f); }));
  await display.evaluate(() => {
    const pick = ['Flexi - mindblob mix', 'martin - castle in the air', 'Geiss - Cauldron - painterly 2 (saturation remix)'].find(n => vj.names.includes(n)) || vj.names[0];
    vj.applyState({ ...vj.state, autoBars: 0, quant: 'off', blend: 1, deckA: pick, deckB: pick, xfade: 0, stems: { drums: true, bass: true, melody: true }, img: [], scenes: [] });
    vj.mix = 0; vj.sendState();
  });

  const cdp = await context.newCDPSession(page), wait = ms => page.waitForTimeout(ms);
  // Screencast frames go straight into the system ffmpeg at a constant 30 fps (a late frame repeats the previous one).
  const videoFile = path.join(outDir, 'video.mp4'), rate = 30;
  const encoder = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(rate), '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(rate), videoFile], { stdio: ['pipe', 'inherit', 'inherit'] });
  let videoAt = 0, written = 0, last = null, frames = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const time = metadata.timestamp * 1000; if (!videoAt) videoAt = time;
    const due = Math.round((time - videoAt) / 1000 * rate);
    while (last && written < due) { encoder.stdin.write(last); written++; }
    last = Buffer.from(data, 'base64'); frames++;
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const touch = async (type, points) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) });
    await page.evaluate(p => showFingers(p), points);
  };
  const box = async sel => { const l = remote.locator(sel).first(); await l.scrollIntoViewIfNeeded(); return l.boundingBox(); };
  const at = (b, fx, fy) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });
  const press = async (sel, ms = 150, after = 150) => { const b = await box(sel); await touch('touchStart', [at(b, 0.5, 0.5)]); await wait(ms); await touch('touchEnd', []); await wait(after); };
  // paths: one function per finger, t in 0..1 -> [fx, fy] inside the element
  const drag = async (sel, paths, ms, after = 200) => {
    const b = await box(sel), points = t => paths.map(p => at(b, ...p(t))), steps = Math.max(2, Math.round(ms / 33));
    await touch('touchStart', points(0));
    for (let i = 1; i <= steps; i++) { await wait(28); await touch('touchMove', points(i / steps)); }
    await touch('touchEnd', []); await wait(after);
  };
  const line = (x0, y0, x1, y1) => t => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  const circle = (r, turns = 1, cx = 0.5, cy = 0.5) => t => [cx + r * Math.sin(t * turns * 2 * Math.PI) * Math.min(1, t * 6), cy - r * 0.9 * (Math.cos(t * turns * 2 * Math.PI) - 1) * Math.min(1, t * 6) / 2 - r * 0.45];
  const names = ['Visual types', 'Audio bands', 'Images & stage', 'Image shots', 'XY pads', 'Momentary effects', 'Effect faders', 'Touch light', 'Decks & presets', 'Scenes'];
  await page.evaluate(n => setSteps(n), names);
  const caption = (i, title, text) => page.evaluate(([i, title, text]) => caption(i, title, text), [i, title, text]);
  const viz = name => `.viz-btn[data-name="◆ ${name}"]`, mom = n => `#mom-grid .btn-mom:nth-child(${n})`, shot = (n, r) => `#img-shots .shot-tile:nth-child(${n}) [data-r="${r}"]`;
  const log = { fps: [] };

  await caption(-1, 'Live visuals from your DAW', 'A CLAP effect streams audio and transport to your browser. Display left, iPad controller right. This demo runs the real plugin in the test host.');
  await wait(5500); log.fps.push(await fps());

  await caption(0, 'Visual types', 'Seven shader types alongside bundled MilkDrop presets. Tap to crossfade into a new look.');
  for (const [name, ms] of [['Tunnel', 2600], ['Gitter', 2800], ['Kreis', 2600], ['Spektrum', 2200]]) { await press(viz(name)); await wait(ms); }

  await caption(1, 'Audio bands', 'Tap drums, bass or melody to toggle; hold to solo. Live level meters. Frequency and transient filtering, not instrument separation.');
  for (const stem of ['drums', 'bass', 'melody']) { await press(`[data-stem="${stem}"]`, 800); await wait(3000); }
  await press('#stem-all'); await wait(1500);

  await caption(2, 'Images & stage', 'Five image layers. Drag with one finger; pinch and rotate with two. Blend modes, tiles, hue and wobble.');
  await press(viz('Sterne')); await wait(600);
  await press('#img-slots .img-slot:nth-child(1)'); await wait(1400);
  await drag('#img-stage', [line(0.5, 0.5, 0.7, 0.35)], 1000);
  await drag('#img-stage', [line(0.62, 0.35, 0.5, 0.2), line(0.78, 0.35, 0.92, 0.55)], 1500, 900);
  await press('#img-modes button:nth-child(3)'); await wait(1300);
  await drag('#ipad-1', [line(0.05, 0.95, 0.75, 0.35)], 1600, 1200);
  await drag('#ih-tile', [line(0.1, 0.5, 0.5, 0.5)], 900, 1600);
  await press('#btn-i-reset'); await wait(700); await press('#btn-i-off'); await wait(500);

  await caption(3, 'Image shots', 'Spin, zoom or flash images into the mix. A tap completes the animation; holding keeps the image visible.');
  for (const [n, r, ms] of [[1, 'spin', 650], [2, 'zoom', 500], [3, 'flash', 550], [4, 'spin', 650], [5, 'zoom', 500], [2, 'flash', 400], [3, 'zoom', 400], [1, 'flash', 400], [5, 'spin', 900]]) await press(shot(n, r), ms, 330);
  await wait(600); log.fps.push(await fps());

  await caption(4, 'XY pads', 'Four XY pads with assignable effect axes. Spring mode returns to neutral when released.');
  await press(viz('Tunnel')); await wait(900);
  await drag('#perf-pad-0', [circle(0.4, 2)], 3200, 500);
  await drag('#perf-pad-1', [circle(0.35, 1)], 1800, 500);
  await drag('#perf-pad-3', [line(0.05, 0.95, 0.6, 0.45)], 1300, 1800);

  await caption(5, 'Momentary effects', 'Sixteen effects while held: kaleidoscope, invert, RGB split, mirror, strobe, shake, zoom and more.');
  for (const [n, ms] of [[7, 1500], [3, 800], [11, 1200], [6, 1200], [8, 1600], [15, 1000], [9, 1100]]) await press(mom(n), ms, 300);

  await caption(6, 'Effect faders', 'Movement, color and audio sensitivity. Link effects to the host beat: here the zoom pulses in time.');
  await press('#btn-fx-reset'); await wait(500);
  await drag('#fh-kaleido', [line(0.05, 0.5, 0.5, 0.5)], 1000, 1500);
  await drag('#fh-zoom', [line(0.5, 0.5, 0.95, 0.5)], 800, 300);
  await remoteFrame.evaluate(() => { const s = document.getElementById('fs-zoom'); s.scrollIntoView({ block: 'center' }); s.value = '1'; s.dispatchEvent(new Event('change')); });
  await wait(3500); await press('#btn-fx-reset'); await wait(500);

  await caption(7, 'Touch light', 'Up to three fingers paint light and ripples directly into the visuals.');
  await press(viz('Plasma')); await wait(500); await press('#btn-i-light'); await wait(300);
  await drag('#img-stage', [circle(0.35, 2)], 3200, 300);
  await drag('#img-stage', [line(0.2, 0.3, 0.45, 0.7), line(0.8, 0.7, 0.55, 0.3)], 2000, 600);
  await press('#btn-i-light'); await wait(300);

  await caption(8, 'Decks & presets', 'Two decks and a crossfader. Search presets, filter groups and save favorites. Tap a name to show its preset.');
  await press('#p-search'); await page.keyboard.type('flexi', { delay: 90 }); await wait(500);
  await press('#p-list .p-row:nth-child(2) .p-name'); await wait(3000);
  await press('#p-list .p-row:nth-child(4) .p-name'); await wait(2600);
  await drag('#xfade-host', [t => [0.5 + 0.4 * Math.sin(t * 2 * Math.PI) * (t < 0.5 ? -1 : -1), 0.5]], 2200, 300);
  await press('#btn-swap'); await wait(1800); log.fps.push(await fps());

  await caption(9, 'Scenes', 'Eight scenes store decks, effects and image settings. Hold to save; tap to recall, optionally on the beat.');
  await press('#scenes-grid .sc-slot:nth-child(1)', 800); await wait(900);
  await press(viz('Gitter')); await wait(2200);
  await press('#scenes-grid .sc-slot:nth-child(1)'); await wait(2800);

  await caption(10, 'Runs locally', 'Plugin-served pages on your LAN. Original synthesized music. Public-domain images from Wikimedia Commons. CLAP Visualizer for Linux ARM64.');
  await wait(4500);

  log.state = await display.evaluate(() => ({ images: vj.images, pictures: vj.pictures }));
  await cdp.send('Page.stopScreencast'); if (last) { encoder.stdin.write(last); written++; }
  encoder.stdin.end(); await new Promise(done => encoder.on('exit', done));
  await context.close(); await browser.close(); host.kill('SIGINT');
  assert.deepStrictEqual(errors, [], 'browser errors during recording');
  assert(written > rate * 60, 'incomplete demo recording');
  console.log(JSON.stringify({ video: videoFile, audioOffset: (videoAt - audioAt) / 1000, seconds: written / rate, capturedFrames: frames, picturesRequested: [...pictures].sort(), errors, ...log }, null, 1));
})().catch(e => { console.error('FAILED', e); process.exit(1); });

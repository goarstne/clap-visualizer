// Performance pads test: the pad grid of the remote in an iPad 12.9" emulation with trusted touch input,
// plus the eight effects that only the pads use (glitch, stutter, tunnel, neon edges, pixel, vortex, thermal, shockwave).
// Needs a running server and Playwright with a Chromium binary:
//   VSTVIS_PORT=18770 VSTVIS_WEB_DIR=$PWD/web tools/fakehost 0 build/clapvisualizer.clap &
//   PW=<dir containing node_modules/playwright> node tools/perftest.js [screenshot dir]
const assert = require('assert');
const { chromium } = require(process.env.PW + '/node_modules/playwright');
const out = process.argv[2], url = 'http://localhost:18770';
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const display = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  display.on('pageerror', e => errors.push('display: ' + e.message));
  display.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('display console: ' + m.text()); });
  await display.goto(url + '/?scale=0.5'); await wait(1500);
  await display.evaluate(() => { vj.applyState({ ...vj.state, autoBars: 8, quant: 'off', blend: 0, deckA: '◆ Spectrum', deckB: '◆ Grid', xfade: 0, pool: 'viz', img: [], tag: {} }); vj.sendState(); });

  // Each effect changes a test picture; stutter repeats the last frame.
  const shader = await display.evaluate(() => {
    const canvas = document.createElement('canvas'), fx = PostFX.create(canvas); fx.resize(96, 96);
    const source = Object.assign(document.createElement('canvas'), { width: 96, height: 96 }), c = source.getContext('2d');
    const paint = hue => { for (let i = 0; i < 36; i++) { c.fillStyle = `hsl(${hue + i * 37}, 90%, ${25 + i % 3 * 25}%)`; c.fillRect(i % 6 * 16, Math.floor(i / 6) * 16, 16, 16); } };
    const shot = params => { fx.render(source, null, params); const px = new Uint8Array(96 * 96 * 4); fx.gl.readPixels(0, 0, 96, 96, fx.gl.RGBA, fx.gl.UNSIGNED_BYTE, px); return px; };
    const differ = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++; return +(n / (a.length / 4)).toFixed(2); };
    paint(0); const plain = shot({});
    const result = { glitch: differ(plain, shot({ glitch: 3 })), glitchSeed: differ(shot({ glitch: 3 }), shot({ glitch: 4 })), edges: differ(plain, shot({ edges: 1 })),
      pixel: differ(plain, shot({ pixel: 3 })), vortex: differ(plain, shot({ vortex: 3 })), thermal: differ(plain, shot({ thermal: 1 })), shock: differ(plain, shot({ shock: 0.3 })) };
    shot({ tunnel: 1 }); shot({ tunnel: 1 }); result.tunnel = differ(plain, shot({ tunnel: 1 }));
    const held = shot({ tunnel: 1 }); paint(180);
    result.hold = differ(held, shot({ hold: 1 })); result.release = differ(held, shot({}));
    fx.destroy(); return result;
  });
  console.log('shader', JSON.stringify(shader));
  assert(shader.glitch > 0.15 && shader.glitchSeed > 0.1 && shader.edges > 0.5 && shader.tunnel > 0.15, 'effects change the picture');
  assert(shader.pixel > 0.15 && shader.vortex > 0.15 && shader.thermal > 0.5 && shader.shock > 0.05, 'second set of effects changes the picture');
  assert(shader.hold < 0.01 && shader.release > 0.5, 'stutter holds the last frame');

  const context = await browser.newContext({ viewport: { width: 1366, height: 1024 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
  await context.addInitScript(() => localStorage.setItem('vstvis_favs', JSON.stringify(['◆ Spectrum', '◆ Plasma', '◆ Stars'])));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push('remote: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('remote console: ' + m.text()); });
  await page.goto(url + '/remote.html'); await wait(1500);
  const cdp = await context.newCDPSession(page);
  const at = async name => { const b = await page.locator(`[data-pad="${name}"]`).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) });
  const tap = async name => { await touch('touchStart', [await at(name)]); await wait(60); await touch('touchEnd', []); await wait(250); };
  const lock = async name => { const l = await at('lock'); await touch('touchStart', [l]); await wait(60); await touch('touchStart', [l, await at(name)]); await wait(60); await touch('touchEnd', [l]); await wait(60); await touch('touchEnd', []); await wait(250); };
  const held = () => display.evaluate(() => Object.keys(vj.held).filter(k => vj.held[k]).sort());
  // The display renders in software here and can lag behind by a few frames.
  const expectHeld = async (keys, text) => { let now; for (let i = 0; i < 30; i++) { now = await held(); if (JSON.stringify(now) === JSON.stringify(keys)) return; await wait(100); } assert.deepStrictEqual(now, keys, text); };
  const cls = name => page.locator(`[data-pad="${name}"]`).evaluate(e => e.className);

  await page.touchscreen.tap(...Object.values(await page.locator('#sw-perform').boundingBox().then(b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })))); await wait(400);
  const grid = await page.evaluate(() => { const pads = [...document.querySelectorAll('.pad')].map(e => e.getBoundingClientRect());
    return { n: pads.length, min: Math.round(Math.min(...pads.map(b => Math.min(b.width, b.height)))), bottom: Math.round(Math.max(...pads.map(b => b.bottom))), scroll: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight, main: getComputedStyle(document.querySelector('main')).display }; });
  console.log('grid', JSON.stringify(grid));
  assert(grid.n === 96 && grid.min >= 90 && grid.bottom <= 1024 && !grid.scroll && grid.main === 'none', 'the grid fills the screen');
  // The software-rendered display may take a moment to apply the remote's state.
  let autoBars; for (let i = 0; i < 30 && autoBars !== 0; i++) { autoBars = await display.evaluate(() => vj.state.autoBars); if (autoBars) await wait(100); }
  assert.strictEqual(autoBars, 0, 'automatic switching is off');
  if (out) await page.screenshot({ path: out + '/perform.png' });

  // Hold = effect while pressed.
  await touch('touchStart', [await at('mom-glitch')]); await wait(250);
  await expectHeld(['glitch']); assert((await cls('mom-glitch')).includes('on'));
  if (out) await display.screenshot({ path: out + '/display-glitch.png' });
  // A long press shows the tooltip and leaves the effect running.
  await wait(600);
  assert.strictEqual(await page.locator('#pad-tip').evaluate(e => e.style.display + '|' + e.firstChild.textContent), 'block|GLITCH');
  await expectHeld(['glitch']);
  if (out) await page.screenshot({ path: out + '/perform-tip.png' });
  await touch('touchEnd', []); await wait(250);
  await expectHeld([]); assert.strictEqual(await page.locator('#pad-tip').evaluate(e => e.style.display), 'none');

  // LOCK + pad keeps it on, the next tap releases it, a double tap on LOCK releases all.
  await lock('mom-tunnel'); await lock('mom-edges');
  await expectHeld(['edges', 'tunnel']); assert((await cls('mom-tunnel')).includes('locked'));
  if (out) { await wait(400); await display.screenshot({ path: out + '/display-tunnel-edges.png' }); await page.screenshot({ path: out + '/perform-locked.png' }); }
  await tap('mom-tunnel'); await expectHeld(['edges']);
  await lock('mom-stutter'); await expectHeld(['edges', 'stutter']);
  { const l = await at('lock'); for (let i = 0; i < 2; i++) { await touch('touchStart', [l]); await wait(50); await touch('touchEnd', []); await wait(80); } }
  await expectHeld([], 'double tap on LOCK releases all');
  // Flash cannot be locked.
  await lock('mom-flash'); await expectHeld([]);

  // Presets come from the favourites; nothing else switches.
  const shown = () => display.evaluate(() => vj.state.xfade < 0.5 ? vj.state.deckA : vj.state.deckB);
  await tap('preset-1'); await wait(300); assert.strictEqual(await shown(), '◆ Plasma'); assert((await cls('preset-1')).includes('on'));
  await tap('step-next'); await wait(300); assert.strictEqual(await shown(), '◆ Stars');
  await tap('step-prev'); await wait(300); assert.strictEqual(await shown(), '◆ Plasma');
  await tap('random'); await wait(300); assert.notStrictEqual(await shown(), '◆ Plasma');
  assert((await cls('preset-5')).includes('empty'));

  // Images, shots and tag looks.
  await tap('img-1'); assert.strictEqual(await display.evaluate(() => vj.state.img[1].on), true);
  await touch('touchStart', [await at('shot-spin')]); await wait(150);
  assert.strictEqual(await display.evaluate(() => vj.layerNow[1].shot && vj.layerNow[1].shot.routine), 'spin');
  await touch('touchEnd', []); await wait(200);
  await tap('img-1'); assert.strictEqual(await display.evaluate(() => vj.state.img[1].on), false);
  await tap('tagmode-neon'); assert.strictEqual(await display.evaluate(() => vj.state.tag.neon), true); assert((await cls('tagmode-neon')).includes('on'));
  await tap('tagmode-neon'); assert.strictEqual(await display.evaluate(() => vj.state.tag.neon), false);
  // Pads that set a value: shader visual, snap, kaleidoscope shape, blend mode and modifiers of the last tapped image.
  await tap('show-4'); await wait(300); assert.strictEqual(await shown(), '◆ Plasma'); assert((await cls('show-4')).includes('on'));
  await tap('quant-beat'); assert.strictEqual(await display.evaluate(() => vj.state.quant), 'beat'); await tap('quant-off');
  await tap('fx-kaleido-8'); assert.strictEqual(await display.evaluate(() => vj.state.fx.kaleido), 8); assert((await cls('fx-kaleido-8')).includes('on'));
  await tap('fx-kaleido-8'); assert.strictEqual(await display.evaluate(() => vj.state.fx.kaleido), 0);
  await tap('blend-2'); await tap('imgval-tile'); await tap('imgtop');
  assert.deepStrictEqual(await display.evaluate(() => { const l = vj.state.img[1]; return [l.m, l.tile, l.top]; }), [2, 3, true]);
  await tap('blend-0'); await tap('imgval-tile'); await tap('imgtop'); await tap('img-0'); await tap('press-alloff');
  assert.deepStrictEqual(await display.evaluate(() => { const l = vj.state.img[1]; return [l.m, l.tile, l.top, vj.state.img[0].on]; }), [0, 1, false, false]);
  await touch('touchStart', [await at('mom-vortex')]); await expectHeld(['vortex']); await touch('touchEnd', []); await expectHeld([]);
  // Depth toggles the camera slot's cut.
  await display.evaluate(() => { vj.applyState({ ...vj.state, img: [null, null, { src: '@cam', on: true }] }); vj.sendState(); }); await wait(300);
  assert((await cls('cam')).includes('on'));
  await tap('depth'); assert.strictEqual(await display.evaluate(() => vj.state.img[2].depth), 0.5);
  await tap('depth'); assert.strictEqual(await display.evaluate(() => vj.state.img[2].depth), 0);
  await tap('cam'); assert.strictEqual(await display.evaluate(() => vj.state.img[2].on), false);

  // Leaving the pads lets go of a locked effect.
  await lock('mom-mono'); await expectHeld(['mono']);
  await page.touchscreen.tap(...Object.values(await page.locator('#sw-perform').boundingBox().then(b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })))); await wait(300);
  await expectHeld([]); assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('main')).display), 'grid');
  await display.evaluate(() => { vj.applyState({ ...vj.state, img: [null, null, { src: '', on: false }] }); vj.sendState(); });
  assert.deepStrictEqual(errors, []);
  await browser.close(); console.log('perftest ok');
})().catch(error => { console.error(error); process.exit(1); });

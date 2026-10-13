// Depth test: the display computes depth maps of Chromium's fake webcam and cuts a camera layer with them.
// Needs `make depth`, a running server and Playwright with a Chromium binary:
//   VSTVIS_PORT=18770 VSTVIS_WEB_DIR=$PWD/web tools/fakehost 0 build/clapvisualizer.clap &
//   PW=<dir containing node_modules/playwright> node tools/depthtest.js
const assert = require('assert');
const { chromium } = require(process.env.PW + '/node_modules/playwright');
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const page = await (await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['camera'] })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'warning' && m.text().includes('Depth')) errors.push(m.text()); });
  await page.goto('http://localhost:18770/?scale=0.5'); await wait(1500);
  assert(await page.evaluate(() => crossOriginIsolated), 'plugin sends the isolation headers');

  // The shader keeps the near half of a white layer and drops the far half.
  const cut = await page.evaluate(() => {
    const canvas = document.createElement('canvas'), fx = PostFX.create(canvas); fx.resize(64, 64);
    const black = Object.assign(document.createElement('canvas'), { width: 4, height: 4 });
    black.getContext('2d').fillRect(0, 0, 4, 4);
    const white = Object.assign(document.createElement('canvas'), { width: 4, height: 4 }), c = white.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, 4, 4); fx.setImage(0, white);
    fx.setDepth(Uint8Array.from({ length: 16 }, (_, i) => i % 4 < 2 ? 0 : 255), 4);
    const shot = depth => {
      fx.render(black, null, { layers: [{ x: 0, y: 0, s: 1, r: 0, o: 1, m: 0, top: true, depth }] });
      const px = new Uint8Array(64 * 4); fx.gl.readPixels(0, 32, 64, 1, fx.gl.RGBA, fx.gl.UNSIGNED_BYTE, px);
      return [px[4 * 4], px[60 * 4]];
    };
    return { flat: shot(0), cut: shot(0.5) };
  });
  assert.deepStrictEqual(cut, { flat: [255, 255], cut: [0, 255] });

  // Live: slot 2 shows the webcam with a depth cut; the maps arrive and are not flat.
  await page.evaluate(() => {
    window.maps = [];
    const set = vj.fx.setDepth.bind(vj.fx);
    vj.fx.setDepth = (map, size) => { maps.push({ at: performance.now(), size, min: Math.min(...map), max: Math.max(...map) }); set(map, size); };
    vj.applyState({ ...vj.state, autoBars: 0, quant: 'off', img: [null, { src: '@cam', on: true, depth: 0.5 }] }); vj.sendState();
  });
  await wait(16000);
  const maps = await page.evaluate(() => maps);
  assert.deepStrictEqual(errors, []);
  assert(maps.length >= 4, `only ${maps.length} depth maps`);
  const last = maps[maps.length - 1];
  assert(last.size === 252 && last.min < 40 && last.max > 215, 'depth map uses the range: ' + JSON.stringify(last));
  console.log(`depth maps: ${maps.length}, ${Math.round((last.at - maps[0].at) / (maps.length - 1))} ms apart`);
  // Without a depth cut the model rests.
  await page.evaluate(() => { vj.applyState({ ...vj.state, img: [null, { src: '', on: false, depth: 0 }] }); vj.sendState(); }); await wait(1500);
  const before = await page.evaluate(() => maps.length); await wait(1500);
  assert.strictEqual(await page.evaluate(() => maps.length), before, 'model rests');
  await browser.close(); console.log('depthtest ok');
})().catch(error => { console.error(error); process.exit(1); });

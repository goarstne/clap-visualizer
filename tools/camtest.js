// Camera test: a remote sends Chromium's fake camera to two displays over WebRTC.
// Needs a running server and Playwright with a Chromium binary:
//   VSTVIS_PORT=18770 VSTVIS_WEB_DIR=$PWD/web tools/fakehost 0 build/clapvisualizer.clap &
//   PW=<dir containing node_modules/playwright> node tools/camtest.js
const assert = require('assert');
const { chromium } = require(process.env.PW + '/node_modules/playwright');
const url = 'http://localhost:18770';
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const errors = [];
  const open = async (name, path, camera) => {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: camera ? ['camera'] : [] });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(name + ': ' + e.message));
    await page.goto(url + path); return page;
  };
  const displays = [await open('display1', '/?scale=0.5'), await open('display2', '/?scale=0.5')];
  const remote = await open('remote', '/remote.html', true);
  await wait(1500);
  await displays[0].evaluate(() => { vj.applyState({ ...vj.state, autoBars: 0, quant: 'off', img: [] }); vj.sendState(); });
  await wait(300);
  const look = () => Promise.all(displays.map(d => d.evaluate(() => {
    const video = vj.camVideo, canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
    let lit = 0;
    if (video.videoWidth) { const c = canvas.getContext('2d'); c.drawImage(video, 0, 0, 8, 8); lit = c.getImageData(0, 0, 8, 8).data.reduce((a, b) => a + b, 0); }
    return { src: vj.state.img[1].src, remote: !!vj.camRemote, local: !!vj.camLocal, width: video.videoWidth, height: video.videoHeight, time: video.currentTime, lit, aspect: vj.fx.imgAspect[1] };
  })));

  await remote.locator('.img-slot').nth(1).click(); await wait(300);   // selects slot 2 and switches it on
  await remote.locator('#btn-i-cam').click(); await wait(5000);
  const first = await look(); await wait(500); const second = await look();
  console.log(JSON.stringify(first));
  first.forEach((d, i) => {
    assert.strictEqual(d.src, '@cam'); assert(d.remote && !d.local, 'stream comes from the remote');
    assert(d.width > 0 && d.lit > 8 * 8 * 255, 'video has a picture'); assert(second[i].time > d.time, 'video runs');
    assert(Math.abs(d.aspect - d.width / d.height) < 1e-6, 'slot got the camera aspect');
  });
  assert(await remote.evaluate(() => document.getElementById('btn-i-cam').classList.contains('active')));

  // A display that joins later gets the picture too.
  displays.push(await open('display3', '/?scale=0.5')); await wait(6000);
  const late = (await look())[2]; console.log(JSON.stringify(late));
  assert(late.remote && late.width > 0, 'late display has the picture');

  await remote.locator('#btn-i-cam').click(); await wait(800);
  for (const d of await look()) { assert(!d.remote, 'stream dropped'); assert.strictEqual(d.aspect, 0, 'slot cleared'); }
  // Without a phone the display falls back to its own webcam, and lets go of it when the slot changes.
  await wait(7000);
  for (const d of await look()) assert(d.local && d.width > 0 && d.aspect > 0, 'local webcam shown');
  await displays[0].evaluate(() => { vj.applyState({ ...vj.state, img: [] }); vj.state.img[1].src = ''; vj.syncImages(); vj.sendState(); });
  await wait(500);
  for (const d of await look()) assert(!d.local, 'webcam released');
  assert.deepStrictEqual(errors, []);
  await browser.close(); console.log('camtest ok');
})().catch(error => { console.error(error); process.exit(1); });

// Touch test of display + remote in an iPad 10 emulation (both orientations), with trusted touch input.
// Needs a running server and Playwright with a Chromium binary:
//   VSTVIS_PORT=18770 VSTVIS_WEB_DIR=$PWD/web tools/fakehost 0 build/vstvisualizer.clap &
//   PW=<dir containing node_modules/playwright> node tools/touchtest.js <screenshot dir>
const { chromium } = require(process.env.PW + '/node_modules/playwright');
const out = process.argv[2], url = 'http://localhost:18770';
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const display = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  display.on('pageerror', e => errors.push('display: ' + e.message));
  await display.goto(url + '/?scale=0.5'); await wait(1500);
  await display.evaluate(() => { vj.applyState({ ...vj.state, autoBars: 0, quant: 'off', deckA: '◆ Spektrum', xfade: 0, stems: { drums: true, bass: true, melody: true }, img: [] }); vj.sendState(); });
  const ua = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const result = {};
  for (const [name, width, height] of [['quer', 1180, 820], ['hoch', 820, 1180]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, userAgent: ua });
    const page = await context.newPage(); const r = result[name] = {};
    page.on('pageerror', e => errors.push(name + ': ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(name + ' console: ' + m.text()); });
    await page.goto(url + '/remote.html'); await wait(1500);
    const cdp = await context.newCDPSession(page);
    const box = async sel => { const b = await page.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; };
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) });
    const hold = async (sel, ms, during) => { await page.locator(sel).first().scrollIntoViewIfNeeded(); const b = await box(sel); await touch('touchStart', [b]); await wait(ms); const v = during ? await during() : null; await touch('touchEnd', []); return v; };
    const dstate = fn => display.evaluate(fn);

    r.touchPoints = await page.evaluate(() => navigator.maxTouchPoints);
    r.hscroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    // Everything tappable must be at least 40 px in one direction and not tiny in the other.
    r.small = await page.evaluate(() => [...document.querySelectorAll('button, select, input, .sc-slot, .img-slot')].filter(e => e.offsetParent).map(e => { const b = e.getBoundingClientRect(); return { t: (e.id || e.className || e.tagName) + ':' + e.textContent.trim().slice(0, 12), w: Math.round(b.width), h: Math.round(b.height) }; }).filter(e => Math.max(e.w, e.h) < 40 || Math.min(e.w, e.h) < 28));
    r.controls = await page.evaluate(() => document.querySelectorAll('button, select, input, .sc-slot, .vj-fader, .vj-xypad-surface').length);
    await page.screenshot({ path: `${out}/remote-${name}.png` });
    // Level meters with running audio: three screenshots of the header, plus the measured fill heights.
    r.meters = [];
    for (let i = 0; i < 3; i++) { await wait(350); r.meters.push(await page.evaluate(() => ['drums', 'bass', 'melody'].map(s => Math.round(document.getElementById('m-' + s).getBoundingClientRect().height)))); }
    await page.screenshot({ path: `${out}/meter-${name}.png`, clip: { x: 0, y: 0, width, height: 60 } });

    // Audio sources: tap = toggle, long press = solo, "Alle" = all on.
    await page.touchscreen.tap(...Object.values(await box('[data-stem="drums"]')).slice(0, 2)); await wait(300);
    r.tapDrums = await dstate(() => vj.state.stems);
    await hold('[data-stem="bass"]', 800); await wait(300);
    r.soloBass = await dstate(() => vj.state.stems);
    await wait(600); r.spectrumSolo = await dstate(() => ({ bass: +vj.spectrum.bass.toFixed(3), mid: +vj.spectrum.mid.toFixed(3), treb: +vj.spectrum.treb.toFixed(3) }));
    await page.touchscreen.tap(...Object.values(await box('#stem-all')).slice(0, 2)); await wait(700);
    r.all = await dstate(() => vj.state.stems);
    r.spectrumAll = await dstate(() => ({ bass: +vj.spectrum.bass.toFixed(3), mid: +vj.spectrum.mid.toFixed(3), treb: +vj.spectrum.treb.toFixed(3) }));

    // Quick shots: the three small buttons on image tile 3, held with a real finger.
    r.shots = {};
    for (const routine of ['spin', 'zoom', 'flash']) {
      const sel = `#img-shots .shot-tile:nth-child(3) [data-r="${routine}"]`;
      r.shots[routine] = await hold(sel, 180, async () => {
        const mid = await dstate(() => { const l = vj.layers(0.001, performance.now())[2], s = vj.layerNow[2].shot; return { routine: s && s.routine, held: !!vj.imgHeld[2], o: +l.o.toFixed(2), s: +l.s.toFixed(2), r: +l.r.toFixed(2) }; });
        if (name === 'quer') await display.screenshot({ path: `${out}/display-shot-${routine}.png` });
        return { size: await box(sel).then(b => [Math.round(b.w), Math.round(b.h)]), pressed: await page.locator(sel).evaluate(e => e.classList.contains('is-pressed')), mid };
      });
      await wait(1100);
      r.shots[routine].after = await dstate(() => ({ held: !!vj.imgHeld[2], o: +vj.layers(0.001, performance.now())[2].o.toFixed(3) }));
    }

    // Image slot tap, then two real fingers on the stage: pinch out and rotate.
    await page.locator('#img-slots .img-slot').nth(1).scrollIntoViewIfNeeded();
    await page.touchscreen.tap(...Object.values(await box('#img-slots .img-slot:nth-child(2)')).slice(0, 2)); await wait(400);
    r.imgOn = await dstate(() => vj.state.img[1].on);
    await page.locator('#img-stage').scrollIntoViewIfNeeded(); const st = await box('#img-stage');
    await touch('touchStart', [{ x: st.x - 30, y: st.y }, { x: st.x + 30, y: st.y }]); await wait(60);
    for (let i = 1; i <= 6; i++) { await touch('touchMove', [{ x: st.x - 30 - i * 5, y: st.y - i * 4 }, { x: st.x + 30 + i * 5, y: st.y + i * 4 }]); await wait(30); }
    await touch('touchEnd', []); await wait(400);
    r.pinch = await dstate(() => ({ s: +vj.state.img[1].s.toFixed(2), r: +vj.state.img[1].r.toFixed(2) }));
    await touch('touchStart', [st]); await wait(40); for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ x: st.x + i * 12, y: st.y - i * 6 }]); await wait(30); } await touch('touchEnd', []); await wait(400);
    r.drag = await dstate(() => ({ x: +vj.state.img[1].x.toFixed(2), y: +vj.state.img[1].y.toFixed(2) }));
    if (name === 'quer') await display.screenshot({ path: `${out}/display-image.png` });

    // XY pad 1 (rotation / zoom, spring) and an effect fader with a finger.
    await page.locator('#perf-pad-0').scrollIntoViewIfNeeded(); const pad = await box('#perf-pad-0');
    await touch('touchStart', [pad]); await wait(40); await touch('touchMove', [{ x: pad.x + pad.w / 4, y: pad.y - pad.h / 4 }]); await wait(250);
    r.padHeld = await dstate(() => ({ rot: +vj.target.rot.toFixed(2), zoom: +vj.target.zoom.toFixed(2) }));
    await touch('touchEnd', []); await wait(300);
    r.padReleased = await dstate(() => ({ rot: +vj.target.rot.toFixed(2), zoom: +vj.target.zoom.toFixed(2) }));
    await page.locator('#fh-hue').scrollIntoViewIfNeeded(); const fader = await box('#fh-hue');
    await touch('touchStart', [fader]); await wait(40); await touch('touchMove', [{ x: fader.x + fader.w / 4, y: fader.y }]); await wait(60); await touch('touchEnd', []); await wait(300);
    r.faderHue = await dstate(() => Math.round(vj.state.fx.hue));
    // Momentary button with the finger, then clean up for the next orientation.
    r.momentary = await hold('.btn-mom.invert', 150, () => dstate(() => !!vj.held.invert));
    await wait(200); r.momentaryAfter = await dstate(() => !!vj.held.invert);
    await page.locator('#btn-fx-reset').scrollIntoViewIfNeeded(); await page.touchscreen.tap(...Object.values(await box('#btn-fx-reset')).slice(0, 2));
    await page.locator('#btn-i-reset').scrollIntoViewIfNeeded(); await page.touchscreen.tap(...Object.values(await box('#btn-i-reset')).slice(0, 2));
    await page.touchscreen.tap(...Object.values(await box('#btn-i-off')).slice(0, 2)); await wait(300);
    await context.close();
  }
  result.errors = errors;
  console.log(JSON.stringify(result, null, 1));
  await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });

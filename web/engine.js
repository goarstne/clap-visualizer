(function (root) {
  'use strict';

  const ranges = {
    speed: [0, 3, 1], zoom: [-1, 1, 0], rot: [-1, 1, 0], warp: [-1, 1, 0],
    dx: [-1, 1, 0], dy: [-1, 1, 0], hue: [0, 360, 0], sat: [0, 2, 1],
    bright: [0, 2, 1], contrast: [0, 2, 1], kaleido: [0, 12, 0], mirror: [0, 3, 0],
    trails: [0, 0.97, 0], rgb: [0, 1, 0], gain: [0.2, 3, 1],
    bass: [0, 3, 1], mid: [0, 3, 1], treb: [0, 3, 1]
  };
  const periods = { '1/2': 0.5, '1': 1, '2': 2, '4': 4, '8': 8 };
  const moments = ['flash', 'black', 'invert', 'freeze', 'kick', 'mirror', 'kaleido', 'strobe',
    'zoom', 'spin', 'rgb', 'trails', 'hue', 'mono', 'shake', 'turbo'];
  const imgRanges = {
    x: [-1.5, 1.5, 0], y: [-1.5, 1.5, 0], s: [0.05, 4, 0.6], r: [-31.4, 31.4, 0],
    o: [0, 1, 1], pulse: [0, 1, 0], spin: [-2, 2, 0], tile: [1, 6, 1], hue: [0, 360, 0], wob: [0, 1, 0]
  };
  const tagModes = ['pulse', 'drip', 'neon', 'glitch', 'rainbow', 'zoom', 'spin', 'drift', 'wave', 'trail', 'add', 'diff', 'melt'];
  const imgDefault = () => ({
    src: '', on: false, x: 0, y: 0, s: 0.6, r: 0, o: 1, m: 0, pulse: 0, spin: 0, top: false, tile: 1, hue: 0, wob: 0
  });
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const CAM = '@cam';
  const clamp = (value, min, max, fallback) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const defaults = () => Object.fromEntries(Object.entries(ranges).map(([key, range]) => [key, range[2]]));

  function normalize(incoming, previous = {}, names = []) {
    const raw = object(incoming);
    const fx = { ...defaults(), ...object(previous.fx), ...object(raw.fx) };
    if (!raw.v) {
      if (Number.isFinite(raw.gain)) fx.gain = raw.gain;
      if (Number.isFinite(raw.brightness)) fx.bright = raw.brightness;
    }
    for (const [key, range] of Object.entries(ranges)) fx[key] = clamp(fx[key], range[0], range[1], range[2]);
    const state = {
      type: 'state', v: 2, deckA: names[0] || '', deckB: names[1] || names[0] || '',
      xfade: 0, blend: 2, quant: 'bar', autoBars: 8, random: true, locked: false,
      ...previous, ...raw, fx, sync: { ...object(previous.sync), ...object(raw.sync) }
    };
    // A complete incoming sync map can also remove a previously enabled coupling.
    if (raw.sync && typeof raw.sync === 'object') state.sync = { ...object(raw.sync) };
    state.type = 'state'; state.v = 2;
    // Shader types were renamed when the interface was translated.
    const rename = root.ShaderViz && root.ShaderViz.rename ? root.ShaderViz.rename : name => name;
    state.deckA = rename(state.deckA); state.deckB = rename(state.deckB);
    const stems = object(raw.stems);
    state.stems = ['drums', 'bass', 'melody'].every(key => typeof stems[key] === 'boolean')
      ? { drums: stems.drums, bass: stems.bass, melody: stems.melody, ...(typeof stems.hats === 'boolean' ? { hats: stems.hats } : {}) }
      : { drums: true, bass: true, melody: true, ...(typeof stems.hats === 'boolean' ? { hats: stems.hats } : {}) };
    if (!raw.v && typeof raw.preset === 'string') state.deckA = raw.preset;
    state.xfade = clamp(state.xfade, 0, 1, 0);
    state.blend = clamp(state.blend, 0, 10, 2);
    if (!['off', 'beat', 'bar', '4bar'].includes(state.quant)) state.quant = 'bar';
    if (![0, 4, 8, 16, 32].includes(state.autoBars)) state.autoBars = 8;
    state.random = !!state.random; state.locked = !!state.locked;
    const scenes = Array.isArray(raw.scenes) ? raw.scenes : previous.scenes || [];
    state.scenes = Array.from({ length: 8 }, (_, i) => scenes[i] && typeof scenes[i] === 'object'
      ? { ...scenes[i], deckA: rename(scenes[i].deckA), deckB: rename(scenes[i].deckB) } : null);
    if (!['all', 'milk', 'viz', 'favs'].includes(state.pool)) state.pool = 'all';
    state.favs = Array.isArray(state.favs) ? state.favs.filter(name => typeof name === 'string').map(rename).slice(0, 200) : [];
    const tag = { ...object(previous.tag), ...object(raw.tag) };
    // Enabled modes this version does not know stay in the state for pages that do.
    state.tag = Object.fromEntries([...tagModes, ...Object.keys(tag).filter(key => tag[key] === true)].map(key => [key, tag[key] === true]));
    const img = Array.isArray(raw.img) ? raw.img : [], oldImg = Array.isArray(previous.img) ? previous.img : [];
    state.img = Array.from({ length: 5 }, (_, i) => {
      const layer = { ...imgDefault(), ...object(oldImg[i]), ...object(img[i]) };
      for (const [key, range] of Object.entries(imgRanges)) layer[key] = clamp(layer[key], range[0], range[1], range[2]);
      layer.src = typeof layer.src === 'string' ? layer.src : '';
      layer.on = !!layer.on; layer.top = !!layer.top;
      layer.m = [0, 1, 2, 3, 4, 5].includes(layer.m) ? layer.m : 0;
      return layer;
    });
    return state;
  }

  function nextBoundary(beat, quant, numerator, denominator) {
    const bar = Math.max(1, numerator || 4) * 4 / Math.max(1, denominator || 4);
    const step = quant === 'beat' ? 1 : quant === 'bar' ? bar : quant === '4bar' ? 4 * bar : 0;
    return step ? (Math.floor(beat / step) + 1) * step : beat;
  }

  class Engine {
    constructor(canvas, statusBadge, errorOverlay) {
      this.canvas = canvas; this.statusBadge = statusBadge; this.errorOverlay = errorOverlay;
      this.presets = {};
      for (const library of [root.butterchurnPresets, root.butterchurnPresetsExtra]) {
        const source = library && (library.default || library);
        if (source && source.getPresets) Object.assign(this.presets, source.getPresets());
      }
      this.fx = root.PostFX && root.PostFX.create ? root.PostFX.create(canvas) : null;
      // Shader types need the PostFX canvas as their only visible output.
      this.vizNames = this.fx && root.ShaderViz ? root.ShaderViz.names : [];
      this.names = [...Object.keys(this.presets), ...this.vizNames];
      this.state = normalize({}, {}, this.names);
      this.target = { ...this.state.fx }; this.current = { ...this.target };
      this.mix = this.targetMix = this.state.xfade;
      this.transport = { bpm: 0, beat: 0, playing: false, tsNum: 4, tsDen: 4, sampleRate: 48000 };
      this.transportAt = performance.now(); this.lastAudio = -Infinity;
      this.rawL = new Uint8Array(1024).fill(128); this.rawR = new Uint8Array(1024).fill(128);
      this.levels = {
        timeByteArray: new Uint8Array(1024), timeByteArrayL: new Uint8Array(1024),
        timeByteArrayR: new Uint8Array(1024)
      };
      this.pending = new Map(); this.thumbs = new Set(); this.held = {};
      this.pictures = []; this.images = ['', '', '', '', '']; this.imgHeld = [];
      this.layerNow = this.state.img.map(layer => ({ ...layer, gain: 0, angle: 0, shot: null }));
      this.touch = [0, 1, 2].map(() => ({ x: 0, y: 0, on: false, a: 0 }));
      // Live camera for image slots set to '@cam': a phone's stream (cam.js), else a webcam on this computer.
      this.camVideo = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
      // Safari only decodes a video that is part of the page.
      this.camVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
      canvas.parentNode.appendChild(this.camVideo);
      this.camRemote = this.camLocal = null; this.camAsked = -Infinity; this.camTried = 0;
      this.cam = root.VJCam && root.VJCam.supported
        ? root.VJCam.receiver(message => this.socket.send(message), stream => { this.camRemote = stream; this.camSource(); }) : null;
      // Graffiti tags are mixed in by PostFX, so they need its canvas.
      this.tags = this.fx && root.VJTags ? root.VJTags.create() : null;
      this.spectrum = null; this.bands = { drums: 0, bass: 0, melody: 0 }; this.hit = { kick: 0, hats: 0 };
      this.stemState = [{}, {}];
      this.lastBands = -Infinity; this.audioFrameAt = performance.now();
      this.flashes = []; this.flashAt = this.kickAt = -Infinity; this.strobeStep = null;
      this.transition = null; this.lastFrame = performance.now(); this.lastPending = 0;
      this.lastAutoBar = null; this.lastSwitch = this.lastFrame; this.hasState = false;
      const scale = Number(new URLSearchParams(root.location.search).get('scale'));
      this.scale = Number.isFinite(scale) && scale > 0 ? Math.min(scale, 1) : 1;
      this.ratio = Math.min(root.devicePixelRatio || 1, 2);
      const butterchurn = root.butterchurn && (root.butterchurn.default || root.butterchurn);
      if (!butterchurn || !this.names.length) throw new Error('Butterchurn or presets are missing.');
      this.decks = ['A', 'B'].map(letter => {
        const source = document.createElement('canvas');
        source.className = 'deck-canvas'; source.hidden = true; canvas.parentNode.insertBefore(source, canvas);
        const visualizer = butterchurn.createVisualizer(null, source, {
          // Butterchurn draws into width × height canvas pixels, so the pixel ratio is applied here, not passed on.
          width: Math.max(1, Math.round(root.innerWidth * this.scale * this.ratio)),
          height: Math.max(1, Math.round(root.innerHeight * this.scale * this.ratio)), pixelRatio: 1
        });
        return { letter, canvas: source, visualizer, name: '', visibleSince: null, viz: null, type: null };
      });
      this.frameFX = { ...this.current };
      this.load(0, this.state.deckA, 0); this.load(1, this.state.deckB, 0);
      this.useFallback(); this.resize();
      root.fetch('pictures/index.json').then(response => response.ok ? response.json() : [])
        .then(list => { this.pictures = Array.isArray(list) ? list.filter(name => typeof name === 'string') : []; this.syncImages(); })
        .catch(() => {});
      this.onResize = () => this.resize(); root.addEventListener('resize', this.onResize);
      this.socket = new root.VisualizerSocket({
        role: 'display', onState: state => { this.hasState = true; this.applyState(state); },
        onMessage: message => this.message(message), onTransport: data => this.setTransport(data),
        onAudio: data => this.audio(data), onStatus: status => this.status(status)
      });
      this.frame = now => {
        try { this.tick(now); this.animation = root.requestAnimationFrame(this.frame); }
        catch (error) { this.showError(error); }
      };
      this.animation = root.requestAnimationFrame(this.frame);
    }

    useFallback() {
      this.canvas.hidden = !this.fx;
      this.decks[0].canvas.hidden = !!this.fx;
    }

    showError(error) {
      this.errorOverlay.style.display = 'flex';
      this.errorOverlay.querySelector('p').textContent = error.message || String(error);
    }

    resize() {
      const width = Math.max(1, Math.round(root.innerWidth * this.scale));
      const height = Math.max(1, Math.round(root.innerHeight * this.scale));
      const pixelsW = Math.max(1, Math.round(width * this.ratio));
      const pixelsH = Math.max(1, Math.round(height * this.ratio));
      for (const deck of this.decks) {
        deck.canvas.width = pixelsW; deck.canvas.height = pixelsH;
        deck.visualizer.setRendererSize(pixelsW, pixelsH, { pixelRatio: 1 });
        if (deck.viz) deck.viz.resize(pixelsW, pixelsH);
      }
      if (this.fx) this.fx.resize(pixelsW, pixelsH);
    }

    hook(deck) {
      const runner = deck.visualizer.renderer.presetEquationRunner;
      const original = runner.runFrameEquations;
      const engine = this;
      runner.runFrameEquations = function (...args) {
        const result = original.apply(this, args), value = this.mdVSFrame, fx = engine.frameFX;
        value.zoom *= 1 + 0.25 * fx.zoom;
        value.rot += 0.5 * fx.rot; value.warp *= 1 + fx.warp;
        value.dx += 0.05 * fx.dx; value.dy += 0.05 * fx.dy;
        return result;
      };
    }

    load(index, name, blend = this.state.blend) {
      const deck = this.decks[index];
      const selected = this.names.includes(name) ? name : this.names[0];
      if (!selected) return false;
      try {
        if (this.vizNames.includes(selected)) {
          if (!deck.viz) {
            deck.viz = root.ShaderViz.create();
            if (!deck.viz) throw new Error('Shader engine not available.');
            deck.viz.resize(deck.canvas.width, deck.canvas.height);
          }
          deck.type = selected;
        } else {
          deck.visualizer.loadPreset(this.presets[selected], blend);
          this.hook(deck); deck.type = null;
        }
        deck.name = selected; deck.visibleSince = null;
        this.state['deck' + deck.letter] = selected;
        return true;
      } catch (error) { this.showError(error); return false; }
    }

    applyState(incoming) {
      this.state = normalize(incoming, this.state, this.names);
      for (let i = 0; i < 2; i++) {
        const name = this.state['deck' + this.decks[i].letter];
        if (name !== this.decks[i].name) this.load(i, name);
      }
      this.target = { ...this.state.fx }; this.targetMix = this.state.xfade;
      this.syncImages();
      this.transition = null; this.lastSwitch = performance.now();
      this.lastAutoBar = Math.floor(this.beatNow() / this.beatsPerBar());
    }

    // Slot i shows its stored file, or by default the i-th file of pictures/index.json.
    syncImages() {
      this.state.img.forEach((layer, i) => {
        const src = layer.src || this.pictures[i] || '';
        if (src === this.images[i] || !this.fx) return;
        this.images[i] = src;
        // The camera picture is uploaded every frame by camera().
        if (!src || src === CAM) { this.fx.setImage(i, null); return; }
        // ponytail: full-size upload, images beyond the GPU texture limit (4096+) stay blank; downscale via canvas if needed.
        const image = new Image();
        image.onload = () => { if (this.images[i] === src) this.fx.setImage(i, image); };
        image.src = 'pictures/' + encodeURIComponent(src);
      });
    }

    camSource() {
      const stream = this.camRemote || this.camLocal;
      if (this.camVideo.srcObject === stream) return;
      this.camVideo.srcObject = stream;
      if (stream) this.camVideo.play().catch(() => {});
      else this.images.forEach((src, i) => { if (src === CAM && this.fx) this.fx.setImage(i, null); });
    }

    camera(now) {
      if (!this.fx) return;
      const used = this.images.includes(CAM);
      if (!used || this.camRemote) {
        // No slot shows the camera, or a phone has taken over: switch the webcam off.
        if (this.camLocal) { for (const track of this.camLocal.getTracks()) track.stop(); this.camLocal = null; this.camSource(); }
        this.camTried = 0;
        if (!used) return;
      }
      const video = this.camVideo, live = video.srcObject && video.readyState >= 2 && video.videoWidth > 0;
      if (now - this.camAsked >= 3000) {
        this.camAsked = now;
        // Remotes draw the camera box in the shape of the picture.
        if (live || (this.cam && !this.camRemote)) this.socket.send({
          type: 'cam', ...(this.cam && !this.camRemote ? { want: this.cam.id } : {}), ...(live ? { aspect: video.videoWidth / video.videoHeight } : {})
        });
        // A phone gets one round to answer before this computer asks for its own webcam.
        if (!this.camRemote && !this.camLocal && navigator.mediaDevices && ++this.camTried === 2) {
          navigator.mediaDevices.getUserMedia({ video: true }).then(stream => { this.camLocal = stream; this.camSource(); }).catch(() => {});
        }
      }
      if (live) this.images.forEach((src, i) => { if (src === CAM) this.fx.setImage(i, video); });
    }

    sendState() { this.socket.send({ type: 'state', ...this.state }); }

    status(status) {
      this.statusBadge.style.display = status === 'connected' ? 'none' : 'flex';
      clearTimeout(this.initialStateTimer);
      if (status === 'connected') {
        this.hasState = false;
        this.initialStateTimer = setTimeout(() => { if (!this.hasState) this.sendState(); }, 600);
      } else {
        this.held = {}; this.flashAt = this.kickAt = -Infinity; this.strobeStep = null;
        this.imgHeld = []; for (const layer of this.layerNow) layer.shot = null;
        for (const point of this.touch) point.on = false;
        this.pending.clear(); this.transport.playing = false; this.lastAudio = -Infinity;
        if (this.cam) this.cam.drop();
      }
    }

    setTransport(data) {
      for (const key of ['bpm', 'beat', 'tsNum', 'tsDen', 'sampleRate']) {
        if (Number.isFinite(data[key])) this.transport[key] = data[key];
      }
      if (typeof data.playing === 'boolean') this.transport.playing = data.playing;
      this.transportAt = performance.now();
    }

    beatNow(now = performance.now()) {
      return this.transport.beat + (this.transport.playing && this.transport.bpm > 0
        ? Math.min(0.25, Math.max(0, now - this.transportAt) / 1000) * this.transport.bpm / 60 : 0);
    }

    beatsPerBar() { return Math.max(1, this.transport.tsNum) * 4 / Math.max(1, this.transport.tsDen); }

    audio(data) {
      this.lastAudio = performance.now(); this.setTransport(data);
      this.rawL.fill(128); this.rawR.fill(128);
      this.rawL.set(data.left.subarray(0, 1024)); this.rawR.set(data.right.subarray(0, 1024));
    }

    flash(now) {
      this.flashes = this.flashes.filter(time => now - time < 1000);
      if (this.flashes.length >= 3) return;
      this.flashes.push(now); this.flashAt = now;
    }

    message(message) {
      if (!message || typeof message !== 'object') return;
      const now = performance.now();
      if (message.type === 'ctl') {
        if (message.k === 'xfade') {
          this.targetMix = clamp(message.v, 0, 1, this.targetMix); this.transition = null;
        } else if (typeof message.k === 'string' && message.k.startsWith('fx.')) {
          const key = message.k.slice(3), range = ranges[key];
          if (range) this.target[key] = clamp(message.v, range[0], range[1], this.target[key]);
        } else if (typeof message.k === 'string' && message.k.startsWith('m.')) {
          const key = message.k.slice(2);
          if (!moments.includes(key)) return;
          const pressed = message.v === 1;
          if (pressed && !this.held[key]) {
            if (key === 'flash') this.flash(now);
            if (key === 'kick') this.kickAt = now;
            if (key === 'strobe') this.strobeStep = Math.floor(this.beatNow(now) * 2);
          }
          this.held[key] = pressed;
        } else if (typeof message.k === 'string' && message.k.startsWith('img.')) {
          const [, slot, key] = message.k.split('.'), layer = this.state.img[Number(slot)];
          if (!layer) return;
          if (key === 'on') this.imgHeld[Number(slot)] = message.v === 1;
          else if (key === 'shot') {
            const current = this.layerNow[Number(slot)];
            if (message.v === 1 && !current.shot) {
              const routine = ['zoom', 'spin', 'flash'].includes(message.r) ? message.r : 'zoom';
              current.shot = { routine, start: now, duration: { zoom: 350, spin: 600, flash: 500 }[routine] };
              current.gain = 1;
              if (routine === 'flash') this.flash(now);
            }
            this.imgHeld[Number(slot)] = message.v === 1;
          }
          else if (imgRanges[key]) layer[key] = clamp(message.v, imgRanges[key][0], imgRanges[key][1], layer[key]);
        } else if (typeof message.k === 'string' && message.k.startsWith('tp.')) {
          const point = this.touch[Number(message.k.slice(3))];
          if (!point) return;
          point.on = Array.isArray(message.v);
          if (point.on) { point.x = clamp(message.v[0], -1, 1, 0); point.y = clamp(message.v[1], -1, 1, 0); }
        }
      } else if (message.type === 'cam') {
        // A camera that has just started is asked for its picture right away.
        if (message.on === true) this.camAsked = -Infinity;
        if (this.cam) this.cam.message(message).catch(() => {});
      } else if (message.type === 'tag') {
        if (this.tags && this.tags.add(message.strokes, now)) this.socket.send({ type: 'tags', n: this.tags.count() });
      } else if (message.type === 'trig' && ['swap', 'load', 'scene', 'next', 'prev', 'random', 'title', 'show', 'img', 'tag'].includes(message.k)) {
        const quant = message.q || this.state.quant;
        const key = message.k === 'img' ? 'img' + message.i : message.k === 'tag' ? 'tag' + message.fx : message.k;
        if (quant === 'off' || !this.transport.playing || this.transport.bpm <= 0) {
          this.pending.delete(key); this.execute(message, now);
        } else {
          this.pending.set(key, {
            message, beat: nextBoundary(this.beatNow(now), quant, this.transport.tsNum, this.transport.tsDen)
          });
        }
      }
    }

    swap(now, destination = this.mix < 0.5 ? 1 : 0) {
      this.state.xfade = this.targetMix = destination;
      this.transition = this.state.blend > 0 ? {
        from: this.mix, to: destination, start: now, duration: this.state.blend * 1000
      } : null;
      if (!this.transition) this.mix = destination;
    }

    // Presets the automatic and next/prev/random changes may pick from.
    pool() {
      const kind = this.state.pool;
      const list = kind === 'viz' ? this.vizNames
        : kind === 'milk' ? this.names.filter(name => !this.vizNames.includes(name))
        : kind === 'favs' ? this.state.favs.filter(name => this.names.includes(name)) : this.names;
      return list.length ? list : this.names;
    }

    choose(kind) {
      const names = this.pool(), visible = this.decks[this.mix < 0.5 ? 0 : 1].name;
      const index = names.indexOf(visible);
      if (kind === 'random' && names.length > 1) {
        const others = names.filter(name => name !== visible);
        return others[Math.floor(Math.random() * others.length)];
      }
      return names[(index + (kind === 'prev' ? names.length - 1 : 1) + names.length) % names.length];
    }

    // Loads the preset on the hidden deck and blends over to it.
    show(name, now) {
      if (!this.fx) {
        this.load(0, name);
        this.state.xfade = this.targetMix = this.mix = 0; this.transition = null;
        return;
      }
      const hidden = this.mix < 0.5 ? 1 : 0;
      if (this.load(hidden, name, 0)) this.swap(now, hidden);
    }

    execute(message, now) {
      switch (message.k) {
        case 'swap': this.swap(now); break;
        case 'load':
          if (!['A', 'B'].includes(message.deck) || !this.names.includes(message.preset)) return;
          this.load(message.deck === 'B' ? 1 : 0, message.preset); break;
        case 'scene': {
          const scene = Number.isInteger(message.i) && this.state.scenes[message.i];
          if (!scene) return;
          const previousMix = this.mix;
          this.applyState({ ...this.state, ...scene, type: 'state', v: 2 });
          this.mix = previousMix; this.swap(now, this.state.xfade); break;
        }
        case 'next': case 'prev': case 'random': this.show(this.choose(message.k), now); break;
        case 'show':
          if (!this.names.includes(message.preset)) return;
          this.show(message.preset, now); break;
        case 'img': {
          const layer = this.state.img[message.i];
          if (!Number.isInteger(message.i) || !layer) return;
          layer.on = typeof message.on === 'boolean' ? message.on : !layer.on;
          this.sendState(); this.socket.send({ type: 'pending', k: 'img' + message.i, beats: 0 });
          return;
        }
        case 'tag':
          if (!this.tags || !this.tags.trigger(message.fx, now)) return;
          this.socket.send({ type: 'pending', k: 'tag' + message.fx, beats: 0 });
          // A wipe empties the wall once its fade has run.
          if (message.fx === 'wipe') this.socket.send({ type: 'tags', n: 0 });
          return;
        case 'title':
          if (typeof message.text !== 'string') return;
          for (const deck of this.decks) deck.visualizer.launchSongTitleAnim(message.text); break;
      }
      this.lastSwitch = now; this.lastAutoBar = Math.floor(this.beatNow(now) / this.beatsPerBar());
      this.sendState(); this.socket.send({ type: 'pending', k: message.k, beats: 0 });
    }

    actions(now, beat) {
      for (const [key, action] of this.pending) {
        if (!this.transport.playing || this.transport.bpm <= 0 || beat >= action.beat) {
          this.pending.delete(key); this.execute(action.message, now);
        } else if (now - this.lastPending >= 200) {
          this.socket.send({ type: 'pending', k: key, beats: Math.max(0, action.beat - beat) });
        }
      }
      if (now - this.lastPending >= 200) this.lastPending = now;
      if (!this.state.autoBars || this.state.locked || this.transition) return;
      const bar = Math.floor(beat / this.beatsPerBar());
      if (this.transport.playing && this.transport.bpm > 0) {
        if (this.lastAutoBar !== null && bar !== this.lastAutoBar && bar % this.state.autoBars === 0) {
          this.execute({ k: this.state.random ? 'random' : 'next' }, now);
        }
        this.lastAutoBar = bar;
      } else if (now - this.lastSwitch >= this.state.autoBars * this.beatsPerBar() * 60000 / (this.transport.bpm || 120)) {
        this.execute({ k: this.state.random ? 'random' : 'next' }, now);
      }
    }

    effects(dt, beat) {
      const amount = 1 - Math.exp(-dt / 0.06);
      for (const key of Object.keys(ranges)) {
        this.current[key] += (this.target[key] - this.current[key]) * amount;
        const period = periods[this.state.sync[key]];
        const envelope = period && this.transport.playing && this.transport.bpm > 0
          ? 1 - ((beat % period + period) % period) / period : 1;
        this.frameFX[key] = ranges[key][2] + (this.current[key] - ranges[key][2]) * envelope;
      }
      // Momentary overrides while held.
      const fx = this.frameFX, held = this.held;
      if (held.zoom) fx.zoom = 1;
      if (held.spin) fx.rot = 1;
      if (held.rgb) fx.rgb = 1;
      if (held.trails) fx.trails = 0.9;
      if (held.hue) fx.hue = (fx.hue + performance.now() * 0.36) % 360;
      if (held.mono) fx.sat = 0;
      if (held.shake) { fx.dx = Math.random() * 2 - 1; fx.dy = Math.random() * 2 - 1; }
      if (held.turbo) fx.speed = 3;
    }

    // Smoothed image layers for this frame, in the units PostFX expects.
    layers(dt, time = performance.now()) {
      const amount = 1 - Math.exp(-dt / 0.06), fade = 1 - Math.exp(-dt / 0.12);
      const bass = this.spectrum ? this.spectrum.bass : 0;
      return this.state.img.map((layer, i) => {
        const now = this.layerNow[i], shot = now.shot;
        const progress = shot ? Math.max(0, Math.min(1, (time - shot.start) / shot.duration)) : 1;
        const active = shot && progress < 1;
        const shown = layer.on || this.imgHeld[i] || active ? 1 : 0;
        let scale = 1, rotation = 0, opacity = 1;
        if (active) {
          if (shot.routine === 'zoom') scale = 1 + 0.9 * (1 - progress) ** 3;
          if (shot.routine === 'spin') { scale = progress; rotation = 4 * Math.PI * progress; }
          if (shot.routine === 'flash') opacity = 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(progress * 6 * Math.PI));
        } else now.shot = null;
        for (const key of ['x', 'y', 's', 'r', 'o', 'hue', 'wob']) now[key] += (layer[key] - now[key]) * amount;
        now.gain += (shown - now.gain) * fade;
        if (!shown && now.gain < 0.004) now.gain = 0;
        // spin 1 = half a turn per second; without spin the extra angle unwinds.
        now.angle = layer.spin ? now.angle + layer.spin * dt * Math.PI : now.angle % (2 * Math.PI) * (1 - amount);
        return {
          x: now.x, y: now.y, s: now.s * (1 + layer.pulse * bass) * scale, r: now.r + now.angle + rotation,
          o: now.o * now.gain * opacity, m: layer.m, top: layer.top, tile: layer.tile, hue: now.hue, wob: now.wob
        };
      });
    }

    processAudio(now) {
      const fx = this.frameFX, rate = Math.max(1, this.transport.sampleRate);
      const bassAlpha = 1 - Math.exp(-2 * Math.PI * 200 / rate);
      const midAlpha = 1 - Math.exp(-2 * Math.PI * 2500 / rate);
      const kickTime = (now - this.kickAt) / 1000;
      const kick = kickTime >= 0 && kickTime < 0.18 ? 0.85 * Math.exp(-kickTime * 25) : 0;
      const fresh = now - this.lastAudio < 250;
      const dt = Math.max(0, (now - this.audioFrameAt) / 1000); this.audioFrameAt = now;
      const bands = { drums: 0, bass: 0, melody: 0 };
      if (this.bands.hats !== undefined || (this.state.stems && typeof this.state.stems.hats === 'boolean')) bands.hats = 0;
      for (const [raw, processed, state] of [[this.rawL, this.levels.timeByteArrayL, this.stemState[0]], [this.rawR, this.levels.timeByteArrayR, this.stemState[1]]]) {
        const split = fresh && root.ShaderViz ? root.ShaderViz.splitStems(raw, this.state.stems, rate, state) : null;
        for (const key of Object.keys(bands)) bands[key] = Math.max(bands[key], split ? (split[key] || 0) : 0);
        const selected = split ? split.wave : raw;
        let bass = 0, lowMid = 0;
        for (let i = 0; i < 1024; i++) {
          const sample = fresh ? (selected[i] - 128) / 127 : 0;
          bass += bassAlpha * (sample - bass); lowMid += midAlpha * (sample - lowMid);
          const impulse = kick ? kick * Math.sin(2 * Math.PI * 65 * (kickTime + i / rate)) : 0;
          const value = fx.gain * (bass * fx.bass + (lowMid - bass) * fx.mid + (sample - lowMid) * fx.treb + impulse * fx.bass);
          processed[i] = Math.round(Math.max(0, Math.min(255, 128 + value * 127)));
        }
      }
      for (let i = 0; i < 1024; i++) this.levels.timeByteArray[i] = (this.levels.timeByteArrayL[i] + this.levels.timeByteArrayR[i]) >> 1;
      for (const key of Object.keys(bands)) {
        if (this.bands[key] === undefined) this.bands[key] = 0;
        const amount = 1 - Math.exp(-dt / (bands[key] > this.bands[key] ? 0.02 : 0.3));
        this.bands[key] += (bands[key] - this.bands[key]) * amount;
      }
      if (now - this.lastBands >= 100) {
        const spec = this.spectrum;
        const msg = { type: 'bands', ...this.bands };
        // Hits last a few frames only, so they are kept until the next message.
        if (this.hit) { msg.kickHit = this.hit.kick; msg.hatsHit = this.hit.hats; this.hit.kick = this.hit.hats = 0; }
        if (spec && spec.notes) {
          msg.bassNote = spec.notes.bass || '';
          msg.leadNote = spec.notes.lead || '';
        }
        this.socket.send(msg);
        this.lastBands = now;
      }
      return this.levels;
    }

    thumbnail(deck, visible, now) {
      if (!visible) { deck.visibleSince = null; return; }
      if (deck.visibleSince === null) deck.visibleSince = now;
      if (this.thumbs.has(deck.name) || now - deck.visibleSince < 3000) return;
      if (!this.thumbCanvas) { this.thumbCanvas = document.createElement('canvas'); this.thumbCanvas.width = 96; this.thumbCanvas.height = 54; }
      try {
        this.thumbCanvas.getContext('2d').drawImage(deck.type ? deck.viz.canvas : deck.canvas, 0, 0, 96, 54);
        let data = this.thumbCanvas.toDataURL('image/jpeg', 0.5);
        if (data.length >= 6144) data = this.thumbCanvas.toDataURL('image/jpeg', 0.3);
        if (data.length < 6144 && this.socket.send({ type: 'thumb', preset: deck.name, data })) this.thumbs.add(deck.name);
        else deck.visibleSince = now;
      } catch (_) { deck.visibleSince = now; }
    }

    tick(now) {
      const dt = Math.max(0.001, Math.min(0.1, (now - this.lastFrame) / 1000)); this.lastFrame = now;
      const beat = this.beatNow(now); this.actions(now, beat); this.effects(dt, beat);
      if (this.transition) {
        const progress = Math.max(0, Math.min(1, (now - this.transition.start) / this.transition.duration));
        this.mix = this.transition.from + (this.transition.to - this.transition.from) * progress;
        if (progress === 1) this.transition = null;
      } else this.mix += (this.targetMix - this.mix) * (1 - Math.exp(-dt / 0.06));
      if (Math.abs(this.mix - this.targetMix) < 0.0001) this.mix = this.targetMix;
      if (this.held.strobe && this.transport.playing && this.transport.bpm > 0) {
        const step = Math.floor(beat * 2);
        if (step !== this.strobeStep) { this.flash(now); this.strobeStep = step; }
      }
      const options = { audioLevels: this.processAudio(now), elapsedTime: Math.max(0.000001, dt * (this.held.freeze ? 0 : this.frameFX.speed)) };
      if (root.ShaderViz) {
        this.spectrum = root.ShaderViz.analyze(this.levels.timeByteArray, dt, this.transport.sampleRate);
        if (this.spectrum.hits.kick) this.hit.kick = 1;
        if (this.spectrum.hits.hats) this.hit.hats = 1;
      }
      const draw = deck => {
        if (!deck.type) { deck.visualizer.render(options); return deck.canvas; }
        deck.viz.render(deck.type, this.spectrum, this.frameFX, options.elapsedTime, this.state.stems);
        return deck.viz.canvas;
      };
      const sourceA = draw(this.decks[0]);
      const renderB = !!this.fx && (this.mix > 0 || !!this.transition);
      const sourceB = renderB ? draw(this.decks[1]) : null;
      for (const point of this.touch) point.a += ((point.on ? 1 : 0) - point.a) * (1 - Math.exp(-dt / (point.on ? 0.05 : 0.4)));
      // Pulse follows the beat while the host plays, otherwise the bass level.
      const pulse = this.transport.playing && this.transport.bpm > 0 ? (1 - (beat % 1 + 1) % 1) ** 2 : this.spectrum ? this.spectrum.bass : 0;
      // Tag movement runs on host beats while playing and at 120 BPM otherwise.
      const clock = this.transport.playing && this.transport.bpm > 0 ? beat : now / 500;
      const tagCanvas = this.tags && this.tags.render(now, this.state.tag, pulse, clock) ? this.tags.canvas : null;
      const tagBlend = this.state.tag.melt ? 3 : this.state.tag.diff ? 2 : this.state.tag.add ? 1 : 0;
      this.camera(now);
      if (this.fx) {
        this.fx.render(sourceA, sourceB, {
          ...this.frameFX, mix: this.mix, tag: tagCanvas, tagBlend, layers: this.layers(dt, now), touch: this.touch, time: now / 1000 % 3600, kaleido: this.held.kaleido ? 6 : Math.round(this.frameFX.kaleido),
          mirror: this.held.mirror ? 3 : Math.round(this.frameFX.mirror),
          invert: this.held.invert ? 1 : 0, black: this.held.black ? 1 : 0,
          flash: Math.max(0, 1 - (now - this.flashAt) / 150)
        });
      }
      this.thumbnail(this.decks[0], !this.fx || this.mix < 0.99, now);
      this.thumbnail(this.decks[1], renderB && this.mix > 0.01, now);
    }

    destroy() {
      root.cancelAnimationFrame(this.animation); clearTimeout(this.initialStateTimer);
      root.removeEventListener('resize', this.onResize); this.socket.destroy();
      if (this.cam) this.cam.drop();
      if (this.camLocal) for (const track of this.camLocal.getTracks()) track.stop();
      this.camVideo.remove();
      if (this.fx) this.fx.destroy();
      for (const deck of this.decks) if (deck.viz) deck.viz.destroy();
    }
  }

  function start() {
    const canvas = document.getElementById('visualizer-canvas');
    const status = document.getElementById('status-badge'), error = document.getElementById('error-overlay');
    let engine;
    try { engine = new Engine(canvas, status, error); }
    catch (failure) { error.style.display = 'flex'; error.querySelector('p').textContent = failure.message; return null; }
    function fullscreen() {
      const doc = document;
      const promise = doc.fullscreenElement || doc.webkitFullscreenElement
        ? (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen && doc.webkitExitFullscreen())
        : (doc.documentElement.requestFullscreen ? doc.documentElement.requestFullscreen()
          : doc.documentElement.webkitRequestFullscreen && doc.documentElement.webkitRequestFullscreen());
      if (promise && promise.catch) promise.catch(() => {});
    }
    canvas.parentNode.addEventListener('click', fullscreen);
    root.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'f') { event.preventDefault(); fullscreen(); } });
    let cursorTimer;
    function pointer() {
      document.body.style.cursor = 'default'; clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => { document.body.style.cursor = 'none'; }, 2500);
    }
    root.addEventListener('pointermove', pointer); root.addEventListener('pointerdown', pointer); pointer();
    return engine;
  }
  root.VJEngine = { start, Engine, normalize, nextBoundary };
})(window);

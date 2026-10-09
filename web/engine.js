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
  const moments = ['flash', 'black', 'invert', 'freeze', 'kick', 'mirror', 'kaleido', 'strobe'];
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
    if (!raw.v && typeof raw.preset === 'string') state.deckA = raw.preset;
    state.xfade = clamp(state.xfade, 0, 1, 0);
    state.blend = clamp(state.blend, 0, 10, 2);
    if (!['off', 'beat', 'bar', '4bar'].includes(state.quant)) state.quant = 'bar';
    if (![0, 4, 8, 16, 32].includes(state.autoBars)) state.autoBars = 8;
    state.random = !!state.random; state.locked = !!state.locked;
    const scenes = Array.isArray(raw.scenes) ? raw.scenes : previous.scenes || [];
    state.scenes = Array.from({ length: 8 }, (_, i) => scenes[i] && typeof scenes[i] === 'object' ? scenes[i] : null);
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
      this.names = Object.keys(this.presets);
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
      this.flashes = []; this.flashAt = this.kickAt = -Infinity; this.strobeStep = null;
      this.transition = null; this.lastFrame = performance.now(); this.lastPending = 0;
      this.lastAutoBar = null; this.lastSwitch = this.lastFrame; this.hasState = false;
      const scale = Number(new URLSearchParams(root.location.search).get('scale'));
      this.scale = Number.isFinite(scale) && scale > 0 ? Math.min(scale, 1) : 1;
      this.ratio = Math.min(root.devicePixelRatio || 1, 2);
      this.fx = root.PostFX && root.PostFX.create ? root.PostFX.create(canvas) : null;
      const butterchurn = root.butterchurn && (root.butterchurn.default || root.butterchurn);
      if (!butterchurn || !this.names.length) throw new Error('Butterchurn oder Presets fehlen.');
      this.decks = ['A', 'B'].map(letter => {
        const source = document.createElement('canvas');
        source.className = 'deck-canvas'; source.hidden = true; canvas.parentNode.insertBefore(source, canvas);
        const visualizer = butterchurn.createVisualizer(null, source, {
          width: Math.max(1, Math.round(root.innerWidth * this.scale)),
          height: Math.max(1, Math.round(root.innerHeight * this.scale)), pixelRatio: this.ratio
        });
        return { letter, canvas: source, visualizer, name: '', visibleSince: null };
      });
      this.frameFX = { ...this.current };
      this.load(0, this.state.deckA, 0); this.load(1, this.state.deckB, 0);
      this.useFallback(); this.resize();
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
        deck.visualizer.setRendererSize(width, height, { pixelRatio: this.ratio });
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
      const selected = Object.prototype.hasOwnProperty.call(this.presets, name) ? name : this.names[0];
      if (!selected) return false;
      try {
        deck.visualizer.loadPreset(this.presets[selected], blend);
        this.hook(deck); deck.name = selected; deck.visibleSince = null;
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
      this.transition = null; this.lastSwitch = performance.now();
      this.lastAutoBar = Math.floor(this.beatNow() / this.beatsPerBar());
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
        this.pending.clear(); this.transport.playing = false; this.lastAudio = -Infinity;
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
        }
      } else if (message.type === 'trig' && ['swap', 'load', 'scene', 'next', 'prev', 'random', 'title'].includes(message.k)) {
        const quant = message.q || this.state.quant;
        if (quant === 'off' || !this.transport.playing || this.transport.bpm <= 0) {
          this.pending.delete(message.k); this.execute(message, now);
        } else {
          this.pending.set(message.k, {
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

    choose(kind) {
      const visible = this.decks[this.mix < 0.5 ? 0 : 1].name;
      const index = Math.max(0, this.names.indexOf(visible));
      if (kind === 'random' && this.names.length > 1) {
        return this.names[(index + 1 + Math.floor(Math.random() * (this.names.length - 1))) % this.names.length];
      }
      return this.names[(index + (kind === 'prev' ? this.names.length - 1 : 1)) % this.names.length];
    }

    change(kind, now) {
      if (!this.fx) {
        this.load(0, this.choose(kind));
        this.state.xfade = this.targetMix = this.mix = 0; this.transition = null;
        return;
      }
      const hidden = this.mix < 0.5 ? 1 : 0;
      if (this.load(hidden, this.choose(kind), 0)) this.swap(now, hidden);
    }

    execute(message, now) {
      switch (message.k) {
        case 'swap': this.swap(now); break;
        case 'load':
          if (!['A', 'B'].includes(message.deck) || !Object.prototype.hasOwnProperty.call(this.presets, message.preset)) return;
          this.load(message.deck === 'B' ? 1 : 0, message.preset); break;
        case 'scene': {
          const scene = Number.isInteger(message.i) && this.state.scenes[message.i];
          if (!scene) return;
          const previousMix = this.mix;
          this.applyState({ ...this.state, ...scene, type: 'state', v: 2 });
          this.mix = previousMix; this.swap(now, this.state.xfade); break;
        }
        case 'next': case 'prev': case 'random': this.change(message.k, now); break;
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
    }

    processAudio(now) {
      const fx = this.frameFX, rate = Math.max(1, this.transport.sampleRate);
      const bassAlpha = 1 - Math.exp(-2 * Math.PI * 200 / rate);
      const midAlpha = 1 - Math.exp(-2 * Math.PI * 2500 / rate);
      const kickTime = (now - this.kickAt) / 1000;
      const kick = kickTime >= 0 && kickTime < 0.18 ? 0.85 * Math.exp(-kickTime * 25) : 0;
      const fresh = now - this.lastAudio < 250;
      for (const [raw, processed] of [[this.rawL, this.levels.timeByteArrayL], [this.rawR, this.levels.timeByteArrayR]]) {
        let bass = 0, lowMid = 0;
        for (let i = 0; i < 1024; i++) {
          const sample = fresh ? (raw[i] - 128) / 127 : 0;
          bass += bassAlpha * (sample - bass); lowMid += midAlpha * (sample - lowMid);
          const impulse = kick ? kick * Math.sin(2 * Math.PI * 65 * (kickTime + i / rate)) : 0;
          const value = fx.gain * (bass * fx.bass + (lowMid - bass) * fx.mid + (sample - lowMid) * fx.treb + impulse * fx.bass);
          processed[i] = Math.round(Math.max(0, Math.min(255, 128 + value * 127)));
        }
      }
      for (let i = 0; i < 1024; i++) this.levels.timeByteArray[i] = (this.levels.timeByteArrayL[i] + this.levels.timeByteArrayR[i]) >> 1;
      return this.levels;
    }

    thumbnail(deck, visible, now) {
      if (!visible) { deck.visibleSince = null; return; }
      if (deck.visibleSince === null) deck.visibleSince = now;
      if (this.thumbs.has(deck.name) || now - deck.visibleSince < 3000) return;
      if (!this.thumbCanvas) { this.thumbCanvas = document.createElement('canvas'); this.thumbCanvas.width = 96; this.thumbCanvas.height = 54; }
      try {
        this.thumbCanvas.getContext('2d').drawImage(deck.canvas, 0, 0, 96, 54);
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
      this.decks[0].visualizer.render(options);
      const renderB = !!this.fx && (this.mix > 0 || !!this.transition);
      if (renderB) this.decks[1].visualizer.render(options);
      if (this.fx) {
        this.fx.render(this.decks[0].canvas, renderB ? this.decks[1].canvas : null, {
          ...this.frameFX, mix: this.mix, kaleido: this.held.kaleido ? 6 : Math.round(this.frameFX.kaleido),
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
      if (this.fx) this.fx.destroy();
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

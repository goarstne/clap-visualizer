/**
 * Shared WebSocket client for CLAP Visualizer (display and remote)
 * Protocol: docs/PROTOCOL.md
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VisualizerSocket = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A page that stays open across an update keeps running old code and would send old state.
  // Every page hashes the served files when it loads and announces the hash on connect; a page
  // that hears a different hash checks the server again and reloads itself if it is the stale one.
  const FILES = ['index.html', 'remote.html', 'ws.js', 'controls.js', 'cam.js', 'engine.js', 'postfx.js', 'tags.js', 'viz.js'];
  async function signature() {
    let hash = 0;
    for (const file of FILES) {
      const text = await (await fetch(file, { cache: 'no-store' })).text();
      for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    return hash;
  }

  class VisualizerSocket {
    constructor(options = {}) {
      this.role = options.role === 'display' ? 'display' : 'remote';
      this.onState = typeof options.onState === 'function' ? options.onState : () => {};
      this.onTransport = typeof options.onTransport === 'function' ? options.onTransport : () => {};
      this.onAudio = typeof options.onAudio === 'function' ? options.onAudio : () => {};
      this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {};
      this.onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};

      this.customUrl = options.url || null;
      this.reconnectInterval = options.reconnectInterval || 1500;
      this.ws = null;
      this.reconnectTimer = null;
      this.destroyed = false;
      this.build = null;
      if (typeof fetch === 'function' && typeof location !== 'undefined') {
        signature().then(build => { this.build = build; this.send({ type: 'build', sig: build }); }).catch(() => {});
      }

      this.connect();
    }

    // Another page runs different files: reload if the server no longer serves what this page loaded.
    checkBuild(other) {
      if (this.build === null || other === this.build) return;
      signature().then(current => {
        if (current === this.build) return;
        // One reload per served version, so a broken update cannot loop.
        try {
          if (sessionStorage.getItem('vstvis_reload') === String(current)) return;
          sessionStorage.setItem('vstvis_reload', String(current));
        } catch (e) {}
        location.reload();
      }).catch(() => {});
    }

    resolveUrl() {
      if (this.customUrl) {
        return this.customUrl;
      }

      if (typeof window !== 'undefined' && window.location) {
        const params = new URLSearchParams(window.location.search);
        const queryWs = params.get('ws');
        if (queryWs) {
          return queryWs;
        }

        const isSecure = window.location.protocol === 'https:';
        const proto = isSecure ? 'wss:' : 'ws:';
        const host = window.location.host || 'localhost:8765';
        return `${proto}//${host}/ws`;
      }

      return 'ws://localhost:8765/ws';
    }

    connect() {
      if (this.destroyed) return;

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      const url = this.resolveUrl();
      this.onStatus('connecting');

      try {
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          this.onStatus('connected');
          // Protocol handshake
          const hello = this.role === 'display' ? 'hello display' : 'hello remote';
          this.ws.send(hello);
          if (this.build !== null) this.send({ type: 'build', sig: this.build });
          if (this.listening) this.ws.send('hello listen');
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = () => {
          // onerror is typically followed immediately by onclose
        };

        this.ws.onclose = () => {
          this.ws = null;
          this.onStatus('disconnected');
          this.scheduleReconnect();
        };
      } catch (err) {
        this.onStatus('disconnected');
        this.scheduleReconnect();
      }
    }

    scheduleReconnect() {
      if (this.destroyed || this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectInterval);
    }

    handleMessage(data) {
      if (typeof data === 'string') {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch (e) {
          this.onMessage(data);
          return;
        }

        if (parsed && typeof parsed === 'object') {
          if (parsed.type === 'build') {
            this.checkBuild(parsed.sig);
          } else if (parsed.type === 'state') {
            this.onState(parsed);
          } else if (parsed.type === 'transport') {
            this.sampleRate = parsed.sampleRate;
            this.onTransport(parsed);
          } else {
            this.onMessage(parsed);
          }
        } else {
          this.onMessage(data);
        }
      } else if (data instanceof ArrayBuffer) {
        // Binary audio frame from server:
        // Offset 0: u8 frameType (3)
        // Offset 1: u8 flags (bit 0 = playing)
        // Offset 2: u16 N (little-endian)
        // Offset 4: f32 bpm (little-endian)
        // Offset 8: f64 beat (little-endian)
        // Offset 16: i16[N] left channel
        // Offset 16+2N: i16[N] right channel
        if (data.byteLength < 16) return;

        const view = new DataView(data);
        const frameType = view.getUint8(0);
        if (frameType === 2) { this.playPcm(view); return; }
        if (frameType !== 3) return;

        const flags = view.getUint8(1);
        const playing = (flags & 1) === 1;
        const N = view.getUint16(2, true);
        const bpm = view.getFloat32(4, true);
        const beat = view.getFloat64(8, true);

        const expectedLength = 16 + 4 * N;
        if (data.byteLength < expectedLength) return;

        const left = new Float32Array(N), right = new Float32Array(N);
        for (let i = 0; i < N; i++) { left[i] = view.getInt16(16 + 2 * i, true) / 32767; right[i] = view.getInt16(16 + 2 * (N + i), true) / 32767; }

        this.onAudio({
          flags,
          playing,
          N,
          bpm,
          beat,
          left,
          right
        });
      }
    }

    // Plays the host audio on this device. Call it from a tap, or the browser keeps the sound muted.
    listen(on) {
      this.listening = !!on;
      // iOS plays Web Audio as "ambient" sound, which silent mode mutes; music playback is not.
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      if (on && !this.audioContext) {
        const Context = window.AudioContext || window.webkitAudioContext;
        try { this.audioContext = new Context({ sampleRate: this.sampleRate || 48000 }); }
        catch (e) { this.audioContext = new Context(); }
      }
      if (this.audioContext) this.audioContext[on ? 'resume' : 'suspend']();
      this.send(on ? 'hello listen' : 'hello mute');
      return this.listening;
    }

    // Frame type 2: u8 type, u8 channels (2), u16 reserved, u32 sample rate, then interleaved 16-bit samples.
    playPcm(view) {
      const context = this.audioContext, frames = (view.byteLength - 8) >> 2;
      if (!this.listening || !context || frames < 1) return;
      const buffer = context.createBuffer(2, frames, view.getUint32(4, true));
      for (let channel = 0; channel < 2; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) samples[i] = view.getInt16(8 + i * 4 + channel * 2, true) / 32768;
      }
      const source = context.createBufferSource();
      source.buffer = buffer; source.connect(context.destination);
      // ponytail: fixed 150 ms buffer, restarted after a gap or pile-up; a resampling worklet would hide clock drift.
      const now = context.currentTime;
      if (!(this.playAt > now + 0.02 && this.playAt < now + 1)) this.playAt = now + 0.15;
      source.start(this.playAt); this.playAt += buffer.duration;
    }

    sendState(state) {
      if (!state || typeof state !== 'object') return false;
      const fullState = {
        ...state,
        type: 'state'
      };
      return this.send(JSON.stringify(fullState));
    }

    send(data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          const payload = typeof data === 'string' ? data : JSON.stringify(data);
          this.ws.send(payload);
          return true;
        } catch (err) {
          return false;
        }
      }
      return false;
    }

    destroy() {
      this.destroyed = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
        this.ws = null;
      }
      this.onStatus('disconnected');
    }
  }

  return VisualizerSocket;
});

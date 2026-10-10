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

      this.connect();
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
          if (parsed.type === 'state') {
            this.onState(parsed);
          } else if (parsed.type === 'transport') {
            this.onTransport(parsed);
          } else {
            this.onMessage(parsed);
          }
        } else {
          this.onMessage(data);
        }
      } else if (data instanceof ArrayBuffer) {
        // Binary audio frame from server:
        // Offset 0: u8 frameType (1)
        // Offset 1: u8 flags (bit 0 = playing)
        // Offset 2: u16 N (little-endian)
        // Offset 4: f32 bpm (little-endian)
        // Offset 8: f64 beat (little-endian)
        // Offset 16: u8[N] left channel
        // Offset 16+N: u8[N] right channel
        if (data.byteLength < 16) return;

        const view = new DataView(data);
        const frameType = view.getUint8(0);
        if (frameType !== 1) return;

        const flags = view.getUint8(1);
        const playing = (flags & 1) === 1;
        const N = view.getUint16(2, true);
        const bpm = view.getFloat32(4, true);
        const beat = view.getFloat64(8, true);

        const expectedLength = 16 + 2 * N;
        if (data.byteLength < expectedLength) return;

        const left = new Uint8Array(data, 16, N);
        const right = new Uint8Array(data, 16 + N, N);

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

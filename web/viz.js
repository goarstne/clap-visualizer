/**
 * Shader visualisations for CLAP Visualizer: a second, small engine next to butterchurn.
 * API: window.ShaderViz = { names, analyze(wave, dt, rate), create() }
 * Spec: docs/CONTROL.md, section "Shader-Engine".
 *
 * Every type is one fragment shader fed by a 512x2 audio texture (row 0 spectrum
 * on a logarithmic 30 Hz..16 kHz axis, row 1 waveform) and the band levels.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ShaderViz = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const N = 1024, BINS = 512, PREFIX = '◆ ';

  const re = new Float32Array(N), im = new Float32Array(N), smooth = new Float32Array(BINS);
  const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const cosT = Float32Array.from({ length: N / 2 }, (_, i) => Math.cos(2 * Math.PI * i / N));
  const sinT = Float32Array.from({ length: N / 2 }, (_, i) => -Math.sin(2 * Math.PI * i / N));
  const rev = Uint16Array.from({ length: N }, (_, i) => {
    let r = 0;
    for (let b = 0; b < 10; b++) r |= (i >> b & 1) << (9 - b);
    return r;
  });
  const audio = { tex: new Uint8Array(BINS * 2), bass: 0, mid: 0, treb: 0, level: 0 };

  // Unsigned samples, 128 = silence; optional channel state keeps onset envelopes across frames.
  function splitStems(wave, stems, rate = 48000, state = {}) {
    rate = Number.isFinite(rate) && rate > 0 ? rate : 48000;
    const bypass = stems.drums && stems.bass && stems.melody;
    const selected = bypass ? wave : new Float32Array(wave.length);
    const k = Math.tan(Math.PI * Math.min(180 / rate, 0.45)), norm = 1 / (1 + Math.SQRT2 * k + k * k);
    const b0 = k * k * norm, a1 = 2 * (k * k - 1) * norm, a2 = (1 - Math.SQRT2 * k + k * k) * norm;
    const h0 = norm, hi = 1 - Math.exp(-2 * Math.PI * 5000 / rate);
    const attack = 1 - Math.exp(-1 / (rate * 0.001)), follow = 1 - Math.exp(-1 / (rate * 0.08));
    const release = Math.exp(-1 / (rate * 0.1));
    let mean = 0;
    for (let i = 0; i < wave.length; i++) mean += ((wave[i] - 128) / 127) ** 2;
    mean /= wave.length || 1;
    let lowFast = state.lowFast ?? mean, lowSlow = state.lowSlow ?? mean, lowGate = state.lowGate || 0;
    let midFast = state.midFast ?? mean, midSlow = state.midSlow ?? mean, midGate = state.midGate || 0;
    let x1 = 0, x2 = 0, l1 = 0, l2 = 0, h1 = 0, h2 = 0, top = 0;
    let drums = 0, bass = 0, melody = 0;
    for (let i = 0; i < wave.length; i++) {
      const x = (wave[i] - 128) / 127;
      const low = b0 * (x + 2 * x1 + x2) - a1 * l1 - a2 * l2;
      const high = h0 * (x - 2 * x1 + x2) - a1 * h1 - a2 * h2;
      x2 = x1; x1 = x; l2 = l1; l1 = low; h2 = h1; h1 = high;
      top += hi * (high - top);
      const lowPower = low * low, midPower = top * top;
      lowFast += attack * (lowPower - lowFast); lowSlow += follow * (lowPower - lowSlow);
      midFast += attack * (midPower - midFast); midSlow += follow * (midPower - midSlow);
      lowGate = (lowFast > Math.max(1e-6, lowSlow * 6) || lowPower > Math.max(1e-6, lowSlow * 30)) ? 1 : lowGate * release;
      midGate = (midFast > Math.max(1e-6, midSlow * 6) || midPower > Math.max(1e-6, midSlow * 30)) ? 1 : midGate * release;
      const d = low * lowGate + top * midGate + (high - top), b = low * (1 - lowGate), m = top * (1 - midGate);
      drums += d * d; bass += b * b; melody += m * m;
      if (!bypass) selected[i] = 128 + 127 * ((stems.drums ? d : 0) + (stems.bass ? b : 0) + (stems.melody ? m : 0));
    }
    Object.assign(state, { lowFast, lowSlow, lowGate, midFast, midSlow, midGate });
    const rms = sum => Math.min(1, Math.sqrt(sum / (wave.length || 1)));
    return { wave: selected, drums: rms(drums), bass: rms(bass), melody: rms(melody) };
  }

  // wave: 1024 unsigned bytes, 128 = silence. Returns the shared audio object.
  function analyze(wave, dt, rate) {
    // Remove the mean: 8-bit rounding leaves a small offset that would read as constant bass.
    let mean = 0;
    for (let i = 0; i < N; i++) mean += wave[i];
    mean /= N;
    for (let i = 0; i < N; i++) { re[rev[i]] = (wave[i] - mean) / 127 * hann[i]; im[i] = 0; }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, stride = N / size;
      for (let start = 0; start < N; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cosT[k * stride], wi = sinT[k * stride], a = start + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    const perBin = (rate || 48000) / N, fall = dt * 1.8;
    let bass = 0, mid = 0, treb = 0;
    for (let x = 0; x < BINS; x++) {
      const pos = Math.min(BINS - 2, 30 * Math.pow(16000 / 30, x / (BINS - 1)) / perBin);
      const k = Math.floor(pos), f = pos - k;
      const mag = (Math.hypot(re[k], im[k]) * (1 - f) + Math.hypot(re[k + 1], im[k + 1]) * f) / (N / 4);
      // Square root compresses the range, the tilt lifts the quieter highs.
      smooth[x] = Math.max(Math.min(1, Math.sqrt(mag) * (1 + 2 * x / BINS)), smooth[x] - fall);
      audio.tex[x] = smooth[x] * 255;
      audio.tex[BINS + x] = wave[x * 2];
      if (x < 128) bass += smooth[x]; else if (x < 358) mid += smooth[x]; else treb += smooth[x];
    }
    audio.bass = bass / 128; audio.mid = mid / 230; audio.treb = treb / 154;
    audio.level = (bass + mid + treb) / BINS;
    return audio;
  }

  const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  const HEAD = `#version 300 es
precision highp float;
uniform sampler2D uAudio;
uniform vec2 uRes;
uniform vec4 uXf;
uniform float uTime, uAngle, uBass, uMid, uTreb, uLevel;
in vec2 vUv;
out vec4 outColor;
const float PI = 3.14159265, TAU = 6.2831853;
float spec(float x) { return texture(uAudio, vec2(clamp(x, 0.0, 1.0), 0.25)).r; }
float wave(float x) { return texture(uAudio, vec2(clamp(x, 0.0, 1.0), 0.75)).r * 2.0 - 1.0; }
vec3 pal(float t) { return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67))); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float aspect() { return uRes.x / uRes.y; }
// Centred, y up, height = 1. uXf = zoom, warp, dx, dy from the shared fx values.
vec2 view() {
  vec2 p = (vUv - 0.5) * vec2(aspect(), 1.0) - uXf.zw * 0.5;
  float c = cos(uAngle), s = sin(uAngle);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c) / (1.0 + 0.6 * uXf.x);
  return p + uXf.y * 0.06 * vec2(sin(p.y * 7.0 + uTime), cos(p.x * 7.0 + uTime));
}
`;

  const TYPES = {
    Spektrum: `void main() {
  vec2 p = view();
  float x = abs(p.x) / (aspect() * 0.5), y = abs(p.y) * 2.0, n = 40.0;
  float id = floor(x * n), fx = fract(x * n), h = spec((id + 0.5) / n) * 0.9;
  float inBar = step(0.14, fx) * step(fx, 0.86) * step(x, 1.0);
  vec3 tint = pal(id / n * 0.7 + uTime * 0.03);
  vec3 col = tint * inBar * step(y, h) * (0.35 + 0.65 * step(0.3, fract(y * 28.0)));
  col += tint * inBar * 0.35 * exp(-max(y - h, 0.0) * 14.0);
  col += vec3(0.02, 0.03, 0.07) * (1.0 - min(y, 1.0));
  outColor = vec4(col, 1.0);
}`,
    Oszilloskop: `void main() {
  vec2 p = view();
  float x = p.x / aspect() + 0.5, edge = smoothstep(0.0, 0.06, x) * smoothstep(0.0, 0.06, 1.0 - x);
  vec3 col = vec3(0.01, 0.02, 0.04);
  for (int i = 0; i < 3; i++) {
    float f = float(i);
    float d = abs(p.y - wave(x) * (0.38 - 0.1 * f) * (1.0 + uBass) - (f - 1.0) * 0.24);
    col += pal(0.55 + f * 0.13 + uTime * 0.04 + x * 0.25) * min(2.0, 0.005 / (d + 0.0015)) * edge;
  }
  outColor = vec4(col, 1.0);
}`,
    Kreis: `void main() {
  vec2 p = view();
  float r = length(p), a = atan(p.x, p.y), x = abs(a) / PI, n = 56.0;
  float id = floor(x * n), fx = fract(x * n), base = 0.17 + 0.07 * uBass, h = spec((id + 0.5) / n) * 0.3;
  vec3 tint = pal(x * 0.8 + uTime * 0.05);
  vec3 col = tint * step(0.16, fx) * step(fx, 0.84) * step(base, r) * step(r, base + h);
  col += tint * 0.006 / (abs(r - base) + 0.006) * (0.5 + uBass);
  float inner = base * 0.62 + wave(fract(a / TAU + 0.5)) * 0.05;
  col += vec3(0.9, 0.95, 1.0) * 0.003 / (abs(r - inner) + 0.003);
  col += pal(uTime * 0.03 + 0.4) * 0.25 * uLevel * exp(-r * 3.0);
  outColor = vec4(col, 1.0);
}`,
    Tunnel: `void main() {
  vec2 p = view();
  float r = length(p) + 0.0001, u = atan(p.y, p.x) / TAU + 0.5, z = 0.3 / r + uTime * 0.7;
  float s = spec(abs(fract(u * 2.0) - 0.5) * 2.0);
  float rings = smoothstep(0.3, 0.5, abs(fract(z * 2.0) - 0.5));
  float cells = smoothstep(0.35, 0.5, abs(fract(u * 16.0) - 0.5));
  vec3 col = pal(z * 0.12 + u + uTime * 0.02) * (0.2 + 1.6 * s) * (0.3 + 0.7 * rings) * (0.55 + 0.45 * cells);
  outColor = vec4(col * smoothstep(0.0, 0.3, r) * (0.7 + uBass), 1.0);
}`,
    Plasma: `void main() {
  vec2 p = view() * 3.0;
  float t = uTime * 0.5;
  float v = sin(p.x + t) + sin(p.y * 1.3 - t * 1.2) + sin((p.x + p.y) * 0.8 + t * 0.7)
    + sin(length(p + 1.5 * vec2(sin(t * 0.6), cos(t * 0.4))) * 2.0 - t * 2.0 - uBass * 3.0);
  vec3 col = pal(v * 0.25 + uTime * 0.03 + uMid * 0.5) * (0.55 + 0.45 * cos(v * 3.0 + uTreb * 5.0));
  outColor = vec4(col * (0.6 + uLevel), 1.0);
}`,
    Sterne: `void main() {
  vec2 p = view();
  vec3 col = vec3(0.0, 0.0, 0.02);
  for (int i = 0; i < 5; i++) {
    float f = float(i), depth = fract(f * 0.2 + uTime * 0.12), fade = depth * (1.0 - depth) * 4.0;
    vec2 q = p * mix(22.0, 0.8, depth) + f * 41.0;
    float h = hash(floor(q) + f);
    vec2 o = fract(q) - 0.5 - (vec2(h, fract(h * 57.3)) - 0.5) * 0.7;
    float star = 1.0 - smoothstep(0.0, 0.09 + 0.12 * uBass, length(o));
    col += pal(h + uTime * 0.02) * star * step(0.4, h) * fade * (1.2 + 3.0 * spec(fract(h * 13.7)));
  }
  outColor = vec4(col, 1.0);
}`,
    Gitter: `void main() {
  vec2 p = view();
  float y = p.y - 0.04;
  vec3 col;
  if (y < 0.0) {
    float z = 0.35 / (0.02 - y);
    vec2 l = abs(fract(vec2(p.x * z * 1.6, z + uTime * 1.5)) - 0.5);
    vec3 line = pal(0.82 + uTime * 0.02) * (0.7 + 1.5 * uBass);
    col = mix(vec3(0.03, 0.0, 0.08), line, smoothstep(0.44, 0.5, max(l.x, l.y))) * min(1.0, 3.0 / z);
  } else {
    float d = length(vec2(p.x, y - 0.2)) - 0.03 * uBass;
    float sun = (1.0 - smoothstep(0.2, 0.205, d)) * step(0.35, fract(y * 20.0 - uTime * 0.4) + y * 3.0);
    col = mix(vec3(0.25, 0.0, 0.3), vec3(0.02, 0.0, 0.08), min(1.0, y * 2.2));
    col = mix(col, mix(vec3(1.0, 0.15, 0.5), vec3(1.0, 0.85, 0.2), min(1.0, y * 2.6)), sun);
    float ridge = spec(abs(p.x) / (aspect() * 0.5)) * 0.3;
    col += vec3(0.1, 0.9, 1.0) * 0.004 / (abs(y - ridge) + 0.004) * (0.4 + uLevel);
  }
  outColor = vec4(col, 1.0);
}`
  };

  const names = Object.keys(TYPES).map(name => PREFIX + name);
  const UNIFORMS = ['uAudio', 'uRes', 'uXf', 'uTime', 'uAngle', 'uBass', 'uMid', 'uTreb', 'uLevel'];

  // One instance per deck: own canvas and WebGL2 context, programs compiled on first use.
  function create() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance'
    });
    if (!gl) return null;
    let programs, time = 0, angle = 0;

    function init() {
      programs = {};
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    function program(name) {
      if (programs[name]) return programs[name];
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(name + ': ' + gl.getShaderInfoLog(shader));
        return shader;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, HEAD + TYPES[name.slice(PREFIX.length)]));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ': ' + gl.getProgramInfoLog(p));
      const u = {};
      for (const key of UNIFORMS) u[key] = gl.getUniformLocation(p, key);
      return programs[name] = { p, u };
    }

    // fx: shared effect values (zoom, rot, warp, dx, dy); dt: seconds already scaled by fx.speed.
    function render(name, levels, fx, dt) {
      if (gl.isContextLost()) return;
      const { p, u } = program(name);
      time += dt; angle += (fx.rot || 0) * dt * 2;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(p);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, BINS, 2, 0, gl.RED, gl.UNSIGNED_BYTE, levels.tex);
      gl.uniform1i(u.uAudio, 0);
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      gl.uniform4f(u.uXf, fx.zoom || 0, fx.warp || 0, fx.dx || 0, fx.dy || 0);
      gl.uniform1f(u.uTime, time); gl.uniform1f(u.uAngle, angle);
      gl.uniform1f(u.uBass, levels.bass); gl.uniform1f(u.uMid, levels.mid);
      gl.uniform1f(u.uTreb, levels.treb); gl.uniform1f(u.uLevel, levels.level);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    canvas.addEventListener('webglcontextlost', event => event.preventDefault());
    canvas.addEventListener('webglcontextrestored', init);
    init();
    return {
      canvas, render,
      resize(width, height) { canvas.width = width; canvas.height = height; },
      destroy() { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
    };
  }

  return { names, analyze, splitStems, create };
});

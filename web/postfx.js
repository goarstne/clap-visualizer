/**
 * WebGL2 post-processing for CLAP Visualizer.
 * API: window.PostFX.create(canvas) -> {resize, render, destroy} | null
 * Spec: docs/CONTROL.md, section "PostFX-API".
 *
 * One fragment-shader pass does A/B mix, mirror/kaleido (coordinates), RGB
 * shift, colour (hue/sat/bright/contrast/invert), trails (feedback), flash and
 * blackout. Trails uses two ping-pong framebuffers and a blit pass; with
 * trails = 0 no framebuffer is used and rendering goes straight to the canvas.
 *
 * Up to five image layers (setImage + params.layers) are composited either
 * inside the chain (they get mirrored, shifted and coloured with the visuals)
 * or on top of it. Touch points bend the picture and add a glow.
 *
 * params.tag (a canvas with alpha, see tags.js) is mixed in right after the
 * in-chain images, so graffiti tags run through all following effects.
 * params.tagBlend: 0 paint over, 1 add light, 2 difference, 3 melt (the tag
 * bends and tints the picture underneath instead of covering it).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PostFX = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CTX_OPTS = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance'
  };

  var VERT = '#version 300 es\n' +
    'layout(location=0) in vec2 aPos;\n' +
    'layout(location=1) in vec2 aUv;\n' +
    'out vec2 vUv;\n' +
    'void main() { vUv = aUv; gl_Position = vec4(aPos, 0.0, 1.0); }\n';

  var FRAG = '#version 300 es\n' +
    'precision highp float;\n' +
    'precision highp sampler2D;\n' +
    'uniform sampler2D uSrcA;\n' +
    'uniform sampler2D uSrcB;\n' +
    'uniform sampler2D uPrev;\n' +
    'uniform float uMix;\n' +
    'uniform float uHue;\n' +
    'uniform float uSat;\n' +
    'uniform float uBright;\n' +
    'uniform float uContrast;\n' +
    'uniform float uInvert;\n' +
    'uniform float uKaleido;\n' +
    'uniform float uMirror;\n' +
    'uniform float uTrails;\n' +
    'uniform float uRgb;\n' +
    'uniform float uFlash;\n' +
    'uniform float uBlack;\n' +
    'uniform float uAspect;\n' +
    'uniform float uTime;\n' +
    'uniform sampler2D uImg0;\n' +
    'uniform sampler2D uImg1;\n' +
    'uniform sampler2D uImg2;\n' +
    'uniform sampler2D uImg3;\n' +
    'uniform sampler2D uImg4;\n' +
    'uniform vec4 uLayA[5];\n' +  // centre x, centre y (uv), width, height (screen heights)
    'uniform vec4 uLayB[5];\n' +  // rotation, opacity, blend mode, 1 = on top of the chain
    'uniform vec4 uLayC[5];\n' +  // tiles, hue shift (degrees), wobble, depth cut
    'uniform vec3 uTouch[3];\n' + // x, y (uv), strength
    'uniform sampler2D uTag;\n' +
    'uniform float uTagOn;\n' +
    'uniform sampler2D uDepth;\n' +
    'in vec2 vUv;\n' +
    'out vec4 outColor;\n' +
    'const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);\n' +
    'const float PI = 3.14159265;\n' +
    'const float TAU = 6.2831853;\n' +
    'vec3 hueRotate(vec3 c, float deg) {\n' +
    '  float a = radians(deg);\n' +
    '  float cs = cos(a);\n' +
    '  float sn = sin(a);\n' +
    '  vec3 k = vec3(0.57735);\n' +
    '  return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);\n' +
    '}\n' +
    'vec3 layer(vec3 c, sampler2D img, vec4 a, vec4 b, vec4 e, vec2 uv) {\n' +
    '  if (b.y <= 0.0) return c;\n' +
    '  vec2 q = (uv - a.xy) * vec2(uAspect, 1.0);\n' +
    '  float cs = cos(b.x);\n' +
    '  float sn = sin(b.x);\n' +
    '  q = vec2(q.x * cs + q.y * sn, q.y * cs - q.x * sn) / a.zw + vec2(0.5);\n' +
    '  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) return c;\n' +
    '  q += e.z * 0.04 * vec2(sin(q.y * 12.0 + uTime * 3.0), cos(q.x * 12.0 + uTime * 2.6));\n' +
    '  if (e.x > 1.5 || e.z > 0.0) q = fract(q * e.x);\n' +
    '  vec3 t = texture(img, q).rgb;\n' +
    '  if (e.y > 0.5) t = hueRotate(t, e.y);\n' +
    '  if (e.w > 0.0) b.y *= smoothstep(e.w - 0.12, e.w + 0.12, texture(uDepth, q).r);\n' + // near stays, far goes
    '  if (b.z < 0.5) return mix(c, t, b.y);\n' +                             // normal
    '  if (b.z < 1.5) return c + t * b.y;\n' +                                // add
    '  if (b.z < 2.5) return mix(c, vec3(1.0) - (vec3(1.0) - c) * (vec3(1.0) - t), b.y);\n' + // screen
    '  if (b.z < 3.5) return mix(c, c * t, b.y);\n' +                         // multiply
    '  if (b.z < 4.5) return mix(c, abs(c - t), b.y);\n' +                    // difference
    '  return mix(c, t, b.y * smoothstep(0.08, 0.45, dot(t, LUMA)));\n' +     // luma key
    '}\n' +
    'vec3 layers(vec3 c, vec2 uv, float top) {\n' +
    '  if (uLayB[0].w == top) c = layer(c, uImg0, uLayA[0], uLayB[0], uLayC[0], uv);\n' +
    '  if (uLayB[1].w == top) c = layer(c, uImg1, uLayA[1], uLayB[1], uLayC[1], uv);\n' +
    '  if (uLayB[2].w == top) c = layer(c, uImg2, uLayA[2], uLayB[2], uLayC[2], uv);\n' +
    '  if (uLayB[3].w == top) c = layer(c, uImg3, uLayA[3], uLayB[3], uLayC[3], uv);\n' +
    '  if (uLayB[4].w == top) c = layer(c, uImg4, uLayA[4], uLayB[4], uLayC[4], uv);\n' +
    '  return c;\n' +
    '}\n' +
    'vec2 coord(vec2 uv) {\n' +
    '  vec2 c = uv;\n' +
    '  for (int i = 0; i < 3; i++) {\n' +
    '    vec3 t = uTouch[i];\n' +
    '    if (t.z <= 0.0) continue;\n' +
    '    vec2 d = c - t.xy;\n' +
    '    float r = length(d * vec2(uAspect, 1.0));\n' +
    '    c -= d * 0.5 * t.z * exp(-r * r * 30.0);\n' +
    '    c += d / max(r, 0.0001) * sin(r * 45.0 - uTime * 9.0) * 0.012 * t.z * exp(-r * 5.0);\n' +
    '  }\n' +
    '  float n = floor(uKaleido + 0.5);\n' +
    '  if (n >= 2.0) {\n' +
    '    vec2 p = c - vec2(0.5);\n' +
    '    float r = length(p);\n' +
    '    float a = atan(p.y, p.x) + PI;\n' +
    '    float seg = TAU / n;\n' +
    '    a = mod(a, seg);\n' +
    '    a = min(a, seg - a);\n' +
    '    c = vec2(0.5) + r * vec2(cos(a), sin(a));\n' +
    '  }\n' +
    '  float m = floor(uMirror + 0.5);\n' +
    '  if (m == 1.0 || m == 3.0) c.x = 1.0 - c.x;\n' +
    '  if (m == 2.0 || m == 3.0) c.y = 1.0 - c.y;\n' +
    '  return c;\n' +
    '}\n' +
    'vec3 sampleAB(vec2 uv) {\n' +
    '  vec3 a = texture(uSrcA, uv).rgb;\n' +
    '  vec3 b = texture(uSrcB, uv).rgb;\n' +
    '  vec3 c = layers(mix(a, b, uMix), uv, 0.0);\n' +
    '  if (uTagOn > 0.0) {\n' +
    '    vec4 t = texture(uTag, uv);\n' +
    '    if (uTagOn > 3.5) {\n' +
    '      vec2 e = vec2(0.004 / uAspect, 0.004);\n' +
    '      vec2 slope = vec2(texture(uTag, uv + vec2(e.x, 0.0)).a - texture(uTag, uv - vec2(e.x, 0.0)).a,\n' +
    '                        texture(uTag, uv + vec2(0.0, e.y)).a - texture(uTag, uv - vec2(0.0, e.y)).a);\n' +
    '      vec2 o = uv + slope * 0.05 + t.a * 0.025 * vec2(sin(uTime * 2.0 + uv.y * 30.0), cos(uTime * 1.7 + uv.x * 30.0));\n' +
    '      vec3 under = layers(mix(texture(uSrcA, o).rgb, texture(uSrcB, o).rgb, uMix), o, 0.0);\n' +
    '      c = mix(c, under * (0.55 + 1.3 * t.rgb) + t.rgb * (0.22 + 0.6 * length(slope)), t.a);\n' +
    '    } else if (uTagOn > 2.5) c = mix(c, abs(c - t.rgb), t.a);\n' +
    '    else if (uTagOn > 1.5) c += t.rgb * t.a;\n' +
    '    else c = mix(c, t.rgb, t.a);\n' +
    '  }\n' +
    '  return c;\n' +
    '}\n' +
    'void main() {\n' +
    '  vec2 tc = coord(vUv);\n' +
    '  vec3 c;\n' +
    '  if (uRgb <= 0.0) {\n' +
    '    c = sampleAB(tc);\n' +
    '  } else {\n' +
    '    vec2 d = tc - vec2(0.5);\n' +
    '    float off = uRgb * 0.03;\n' +
    '    c.r = sampleAB(tc + d * off).r;\n' +
    '    c.g = sampleAB(tc).g;\n' +
    '    c.b = sampleAB(tc - d * off).b;\n' +
    '  }\n' +
    '  c = hueRotate(c, uHue);\n' +
    '  float l = dot(c, LUMA);\n' +
    '  c = mix(vec3(l), c, uSat);\n' +
    '  c *= uBright;\n' +
    '  c = (c - vec3(0.5)) * uContrast + vec3(0.5);\n' +
    '  c = mix(c, vec3(1.0) - c, uInvert);\n' +
    '  if (uTrails > 0.0) c = mix(c, texture(uPrev, vec2(vUv.x, 1.0 - vUv.y)).rgb, uTrails);\n' +
    '  c = layers(c, vUv, 1.0);\n' +
    '  for (int i = 0; i < 3; i++) {\n' +
    '    vec3 t = uTouch[i];\n' +
    '    float r = length((vUv - t.xy) * vec2(uAspect, 1.0));\n' +
    '    c += hueRotate(vec3(1.0, 0.45, 0.15), uHue + float(i) * 120.0) * t.z * exp(-r * r * 90.0);\n' +
    '  }\n' +
    '  c = mix(c, vec3(1.0), uFlash);\n' +
    '  c = mix(c, vec3(0.0), uBlack);\n' +
    '  outColor = vec4(c, 1.0);\n' +
    '}\n';

  var BLIT_FRAG = '#version 300 es\n' +
    'precision highp float;\n' +
    'precision highp sampler2D;\n' +
    'uniform sampler2D uTex;\n' +
    'in vec2 vUv;\n' +
    'out vec4 outColor;\n' +
    'void main() { outColor = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)); }\n';

  // Full-screen triangle strip with uv (0,0) at the top-left of the source.
  // Framebuffer textures are stored bottom-up, so they are sampled with y flipped.
  var QUAD = new Float32Array([
    -1, -1, 0, 1,
    -1,  1, 0, 0,
     1, -1, 1, 1,
     1,  1, 1, 0
  ]);

  var UNIFORMS = ['uSrcA', 'uSrcB', 'uPrev', 'uMix', 'uHue', 'uSat', 'uBright',
    'uContrast', 'uInvert', 'uKaleido', 'uMirror', 'uTrails', 'uRgb', 'uFlash',
    'uBlack', 'uAspect', 'uTime', 'uLayA', 'uLayB', 'uLayC', 'uTouch', 'uTagOn'];

  var LAYERS = 5, TOUCHES = 3, IMAGE_UNIT = 3, TAG_UNIT = IMAGE_UNIT + LAYERS, DEPTH_UNIT = TAG_UNIT + 1;

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function val(p, k, d) { var v = p[k]; return typeof v === 'number' ? v : d; }

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var info = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('Shader compile: ' + info);
    }
    return s;
  }

  function link(gl, vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var info = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('Program link: ' + info);
    }
    return p;
  }

  function makeTexture(gl) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function PostFX(gl, canvas) {
    this.gl = gl;
    this.canvas = canvas;
    this.width = 0;
    this.height = 0;
    this.lost = false;
    this.destroyed = false;
    this.program = null;
    this.blitProgram = null;
    this.vao = null;
    this.srcATex = null;
    this.srcBTex = null;
    this.dummyTex = null;
    this.imgTex = [];
    this.imgSource = [];
    this.imgAspect = [];
    this.layA = new Float32Array(LAYERS * 4);
    this.layB = new Float32Array(LAYERS * 4);
    this.layC = new Float32Array(LAYERS * 4);
    this.touch = new Float32Array(TOUCHES * 3);
    this.fb = [null, null];
    this.fbTex = [null, null];
    this.fbSize = [0, 0];
    this.write = 0;
    this.read = 1;
    this.u = {};
    this.uBlit = {};

    var self = this;
    this.onLost = function (e) {
      e.preventDefault();
      self.lost = true;
    };
    this.onRestored = function () {
      self.lost = false;
      self.fb = [null, null];
      self.fbTex = [null, null];
      self.fbSize = [0, 0];
      self.init();
      for (var i = 0; i < LAYERS; i++) self.setImage(i, self.imgSource[i]);
      if (self.width > 0) self.resize(self.width, self.height);
    };
    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);

    this.init();
  }

  PostFX.prototype.init = function () {
    var gl = this.gl;
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    this.program = link(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    var bvs = compile(gl, gl.VERTEX_SHADER, VERT);
    var bfs = compile(gl, gl.FRAGMENT_SHADER, BLIT_FRAG);
    this.blitProgram = link(gl, bvs, bfs);
    gl.deleteShader(bvs);
    gl.deleteShader(bfs);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    this.srcATex = makeTexture(gl);
    this.srcBTex = makeTexture(gl);

    this.dummyTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.useProgram(this.program);
    var u = {};
    for (var i = 0; i < UNIFORMS.length; i++) {
      u[UNIFORMS[i]] = gl.getUniformLocation(this.program, UNIFORMS[i]);
    }
    gl.uniform1i(u.uSrcA, 0);
    gl.uniform1i(u.uSrcB, 1);
    gl.uniform1i(u.uPrev, 2);
    this.u = u;

    // Image textures stay bound to their own units; nothing else uses units >= 3.
    for (var k = 0; k < LAYERS; k++) {
      gl.activeTexture(gl.TEXTURE0 + IMAGE_UNIT + k);
      this.imgTex[k] = makeTexture(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]));
      gl.uniform1i(gl.getUniformLocation(this.program, 'uImg' + k), IMAGE_UNIT + k);
    }
    gl.activeTexture(gl.TEXTURE0 + TAG_UNIT);
    this.tagTex = makeTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
    gl.uniform1i(gl.getUniformLocation(this.program, 'uTag'), TAG_UNIT);
    // Until the first depth map arrives everything counts as near.
    this.depthTex = makeTexture(gl);
    this.setDepth(new Uint8Array([255]), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uDepth'), DEPTH_UNIT);
    gl.activeTexture(gl.TEXTURE0);

    gl.useProgram(this.blitProgram);
    this.uBlit.uTex = gl.getUniformLocation(this.blitProgram, 'uTex');
    gl.uniform1i(this.uBlit.uTex, 0);
  };

  PostFX.prototype.resize = function (w, h) {
    w = Math.max(1, Math.floor(w) || 1);
    h = Math.max(1, Math.floor(h) || 1);
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.fb[0] && (this.fbSize[0] !== w || this.fbSize[1] !== h)) {
      this.allocFb(w, h);
    }
  };

  // source: loaded HTMLImageElement / canvas / playing video, or null to clear the layer.
  PostFX.prototype.setImage = function (index, source) {
    if (this.destroyed || index < 0 || index >= LAYERS) return;
    this.imgSource[index] = source || null;
    this.imgAspect[index] = source
      ? (source.naturalWidth || source.videoWidth || source.width || 1) / (source.naturalHeight || source.videoHeight || source.height || 1) : 0;
    if (this.lost || !source) return;
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + IMAGE_UNIT + index);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex[index]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.activeTexture(gl.TEXTURE0);
  };

  // Depth map of the camera picture (depth.js): size*size bytes, row 0 at the top, 255 = nearest.
  PostFX.prototype.setDepth = function (data, size) {
    if (this.destroyed || this.lost) return;
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + DEPTH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.activeTexture(gl.TEXTURE0);
  };

  PostFX.prototype.freeFb = function () {
    var gl = this.gl;
    for (var i = 0; i < 2; i++) {
      if (this.fb[i]) gl.deleteFramebuffer(this.fb[i]);
      if (this.fbTex[i]) gl.deleteTexture(this.fbTex[i]);
      this.fb[i] = null;
      this.fbTex[i] = null;
    }
    this.fbSize = [0, 0];
  };

  PostFX.prototype.allocFb = function (w, h) {
    var gl = this.gl;
    this.freeFb();
    for (var i = 0; i < 2; i++) {
      var tex = makeTexture(gl);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.fbTex[i] = tex;
      this.fb[i] = fbo;
    }
    this.fbSize = [w, h];
    this.write = 0;
    this.read = 1;
    // Clear both so trails starts from black instead of garbage.
    gl.clearColor(0, 0, 0, 1);
    for (var j = 0; j < 2; j++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[j]);
      gl.viewport(0, 0, w, h);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  PostFX.prototype.render = function (srcA, srcB, params) {
    if (this.lost || this.destroyed || !srcA) return;
    var gl = this.gl;
    var p = params || {};

    var mix = srcB ? clamp01(val(p, 'mix', 0)) : 0;
    var hue = val(p, 'hue', 0);
    var sat = val(p, 'sat', 1);
    var bright = val(p, 'bright', 1);
    var contrast = val(p, 'contrast', 1);
    var invert = clamp01(val(p, 'invert', 0));
    var kaleido = clamp(val(p, 'kaleido', 0), 0, 12);
    var mirror = clamp(val(p, 'mirror', 0), 0, 3);
    var trails = clamp(val(p, 'trails', 0), 0, 0.97);
    var rgb = clamp01(val(p, 'rgb', 0));
    var flash = clamp01(val(p, 'flash', 0));
    var black = clamp01(val(p, 'black', 0));

    var w = this.width, h = this.height;
    if (w <= 0 || h <= 0) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcATex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, srcA);

    gl.activeTexture(gl.TEXTURE1);
    if (srcB) {
      gl.bindTexture(gl.TEXTURE_2D, this.srcBTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, srcB);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    }

    gl.useProgram(this.program);
    var u = this.u;
    gl.uniform1f(u.uMix, mix);
    gl.uniform1f(u.uHue, hue);
    gl.uniform1f(u.uSat, sat);
    gl.uniform1f(u.uBright, bright);
    gl.uniform1f(u.uContrast, contrast);
    gl.uniform1f(u.uInvert, invert);
    gl.uniform1f(u.uKaleido, kaleido);
    gl.uniform1f(u.uMirror, mirror);
    gl.uniform1f(u.uRgb, rgb);
    gl.uniform1f(u.uFlash, flash);
    gl.uniform1f(u.uBlack, black);
    gl.uniform1f(u.uAspect, w / h);
    gl.uniform1f(u.uTime, val(p, 'time', 0));
    gl.uniform1f(u.uTagOn, p.tag ? 1 + clamp(Math.round(val(p, 'tagBlend', 0)), 0, 3) : 0);
    if (p.tag) {
      // The tag canvas animates, so it is uploaded every frame it is shown.
      gl.activeTexture(gl.TEXTURE0 + TAG_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.tagTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, p.tag);
      gl.activeTexture(gl.TEXTURE0);
    }

    // s = 1 fits the whole image on screen; x, y in -1..1 with y up.
    var layers = p.layers || [], touch = p.touch || [];
    for (var i = 0; i < LAYERS; i++) {
      var l = layers[i], aspect = this.imgAspect[i];
      var shown = l && aspect > 0 && l.o > 0;
      var height = shown ? Math.max(0.001, l.s * Math.min(1, w / h / aspect)) : 1;
      this.layA.set([shown ? 0.5 + l.x * 0.5 : 0, shown ? 0.5 - l.y * 0.5 : 0,
        shown ? height * aspect : 1, height], i * 4);
      this.layB.set([shown ? l.r : 0, shown ? clamp01(l.o) : 0, shown ? l.m : 0,
        shown && l.top ? 1 : 0], i * 4);
      this.layC.set([shown ? Math.max(1, Math.round(l.tile || 1)) : 1, shown ? l.hue || 0 : 0,
        shown ? l.wob || 0 : 0, shown ? l.depth || 0 : 0], i * 4);
    }
    for (var j = 0; j < TOUCHES; j++) {
      var t = touch[j];
      this.touch.set(t && t.a > 0 ? [0.5 + t.x * 0.5, 0.5 - t.y * 0.5, clamp01(t.a)] : [0, 0, 0], j * 3);
    }
    gl.uniform4fv(u.uLayA, this.layA);
    gl.uniform4fv(u.uLayB, this.layB);
    gl.uniform4fv(u.uLayC, this.layC);
    gl.uniform3fv(u.uTouch, this.touch);

    if (trails > 0) {
      if (!this.fb[0] || this.fbSize[0] !== w || this.fbSize[1] !== h) {
        this.allocFb(w, h);
      }
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.fbTex[this.read]);
      gl.uniform1f(u.uTrails, trails);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[this.write]);
      gl.viewport(0, 0, w, h);
      this.draw();

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.blitProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fbTex[this.write]);
      gl.uniform1i(this.uBlit.uTex, 0);
      this.draw();
      gl.useProgram(this.program);

      var t = this.write; this.write = this.read; this.read = t;
    } else {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
      gl.uniform1f(u.uTrails, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      this.draw();
    }
  };

  PostFX.prototype.draw = function () {
    var gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  };

  PostFX.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    var gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this.onLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored, false);
    try {
      this.freeFb();
      if (this.srcATex) gl.deleteTexture(this.srcATex);
      if (this.srcBTex) gl.deleteTexture(this.srcBTex);
      if (this.dummyTex) gl.deleteTexture(this.dummyTex);
      if (this.depthTex) gl.deleteTexture(this.depthTex);
      for (var i = 0; i < this.imgTex.length; i++) gl.deleteTexture(this.imgTex[i]);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.program) gl.deleteProgram(this.program);
      if (this.blitProgram) gl.deleteProgram(this.blitProgram);
    } catch (e) { /* context already lost */ }
    this.gl = null;
    this.canvas = null;
  };

  function create(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    var gl = null;
    try {
      gl = canvas.getContext('webgl2', CTX_OPTS);
    } catch (e) {
      gl = null;
    }
    if (!gl) return null;
    try {
      return new PostFX(gl, canvas);
    } catch (e) {
      return null;
    }
  }

  return { create: create };
});

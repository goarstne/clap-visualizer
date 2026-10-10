/**
 * Graffiti tags for CLAP Visualizer.
 * API: window.VJTags.create() -> {canvas, add, trigger, render, count}
 * Spec: docs/CONTROL.md, section "Graffiti tags".
 *
 * Tags are drawn on a transparent 2D canvas that PostFX mixes into the picture
 * before mirror, kaleidoscope, colour and trails, so they run through the effects.
 */
(function (root) {
  'use strict';

  const WIDTH = 1280, HEIGHT = 720, MAX_TAGS = 6, MAX_POINTS = 4000;
  const WRITE_MS = 1400, BURST_MS = 900, WIPE_MS = 600;
  // zoom, spin, drift and wave move the tags; trail leaves fading copies behind.
  // add, diff and melt only choose how PostFX blends the layer with the picture.
  const MODES = ['pulse', 'drip', 'neon', 'glitch', 'rainbow', 'zoom', 'spin', 'drift', 'wave', 'trail', 'add', 'diff', 'melt'];
  const SHOTS = ['write', 'burst', 'wipe'];

  // Deterministic per-point noise, so a burst flies apart the same way every frame.
  const noise = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

  // Accepts the wire format {c, w, p:[x0,y0,x1,y1,...]} with p in 0..1000; returns null if nothing usable.
  function parse(strokes) {
    if (!Array.isArray(strokes)) return null;
    const out = []; let total = 0;
    for (const stroke of strokes.slice(0, 64)) {
      if (!stroke || !Array.isArray(stroke.p) || stroke.p.length < 2) continue;
      const count = Math.min(stroke.p.length >> 1, MAX_POINTS - total);
      if (count < 1) break;
      const points = new Float32Array(count * 2);
      for (let i = 0; i < count * 2; i++) {
        const value = Number(stroke.p[i]);
        points[i] = Number.isFinite(value) ? Math.max(0, Math.min(1000, value)) / 1000 : 0;
      }
      // Cumulative length drives the write animation.
      const length = new Float32Array(count);
      for (let i = 1; i < count; i++) {
        length[i] = length[i - 1] + Math.hypot((points[i * 2] - points[i * 2 - 2]) * WIDTH, (points[i * 2 + 1] - points[i * 2 - 1]) * HEIGHT);
      }
      const width = Number.isFinite(stroke.w) ? Math.max(0.003, Math.min(0.08, stroke.w)) : 0.016;
      const color = typeof stroke.c === 'string' && /^#[0-9a-f]{6}$/i.test(stroke.c) ? stroke.c : '#ffffff';
      out.push({ points, length, count, width: width * HEIGHT, color });
      total += count;
    }
    if (!out.length) return null;
    let sumX = 0, sumY = 0, n = 0, path = 0;
    const drips = [];
    out.forEach((stroke, s) => {
      for (let i = 0; i < stroke.count; i++) { sumX += stroke.points[i * 2]; sumY += stroke.points[i * 2 + 1]; n++; }
      stroke.offset = path; path += stroke.length[stroke.count - 1] + 1;
      // Paint runs from a few fixed points of every stroke.
      const runs = Math.min(4, Math.max(1, Math.round(stroke.length[stroke.count - 1] / 220)));
      for (let k = 0; k < runs; k++) {
        const i = Math.floor(noise(s * 17 + k * 5 + stroke.count) * stroke.count);
        drips.push({ x: stroke.points[i * 2] * WIDTH, y: stroke.points[i * 2 + 1] * HEIGHT, length: (0.08 + 0.22 * noise(i + k)) * HEIGHT, width: stroke.width * 0.45, stroke: s });
      }
    });
    return { strokes: out, drips, path, cx: sumX / n * WIDTH, cy: sumY / n * HEIGHT };
  }

  function create() {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH; canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let tags = [], dripAt = null, blank = true;

    function add(strokes, now) {
      const tag = parse(strokes);
      if (!tag) return false;
      tag.writeAt = now; tag.burstAt = tag.wipeAt = null;
      tags.push(tag);
      if (tags.length > MAX_TAGS) tags.shift();
      return true;
    }

    function trigger(shot, now) {
      if (!SHOTS.includes(shot)) return false;
      for (const tag of tags) tag[shot + 'At'] = now;
      return true;
    }

    // Traces the first `shown` pixels of the tag's path; `spread` > 0 scatters the points, `wave` >= 0 bends them.
    function trace(tag, stroke, s, shown, spread, shiftX, wave) {
      const p = stroke.points, visible = shown - stroke.offset;
      if (visible <= 0) return false;
      ctx.beginPath();
      for (let i = 0; i < stroke.count; i++) {
        if (stroke.length[i] > visible) break;
        let x = p[i * 2] * WIDTH + shiftX, y = p[i * 2 + 1] * HEIGHT;
        if (wave >= 0) {
          const bendX = Math.sin(y * 0.018 + wave * 5) * 14, bendY = Math.cos(x * 0.014 + wave * 4) * 18;
          x += bendX; y += bendY;
        }
        if (spread > 0) {
          const angle = Math.atan2(y - tag.cy, x - tag.cx) + (noise(s * 31 + i) - 0.5) * 2.4;
          const distance = spread * (0.35 + noise(i * 7 + s)) * HEIGHT;
          x += Math.cos(angle) * distance; y += Math.sin(angle) * distance;
        }
        // A burst draws separate dabs instead of one connected line.
        if (i === 0 || spread > 0) { ctx.moveTo(x, y); ctx.lineTo(x + 0.01, y); } else ctx.lineTo(x, y);
      }
      return true;
    }

    function paint(tag, index, now, modes, shown, spread, alpha, wave) {
      const glitch = modes.glitch && noise(Math.floor(now / 70) + index) > 0.45;
      tag.strokes.forEach((stroke, s) => {
        const color = modes.rainbow ? 'hsl(' + ((now * 0.12 + s * 47 + index * 80) % 360) + ',100%,60%)' : stroke.color;
        const passes = modes.neon
          ? [[color, stroke.width * 3.2, 0.22], [color, stroke.width * 1.9, 0.5], ['#ffffff', stroke.width * 0.55, 1]]
          : [['#000000', stroke.width * 1.7, 0.9], [color, stroke.width, 1]];
        if (glitch) {
          const jump = (noise(Math.floor(now / 70) * 3 + s) - 0.5) * 0.08 * WIDTH;
          passes.unshift(['#00ffff', stroke.width, 0.8, jump], ['#ff00ff', stroke.width, 0.8, -jump]);
        }
        for (const [style, width, opacity, shift] of passes) {
          if (!trace(tag, stroke, s, shown, spread, shift || 0, wave)) continue;
          ctx.globalAlpha = alpha * opacity; ctx.strokeStyle = style; ctx.lineWidth = width; ctx.stroke();
        }
      });
    }

    // Draws all tags for this frame. Returns true while the canvas shows anything.
    // `clock` drives the movement: host beats while playing, so motion follows the tempo.
    function render(now, modes, pulse, clock) {
      modes = modes || {};
      if (!Number.isFinite(clock)) clock = now / 500;
      tags = tags.filter(tag => tag.wipeAt === null || now - tag.wipeAt < WIPE_MS);
      if (!tags.length) {
        if (!blank) { ctx.clearRect(0, 0, WIDTH, HEIGHT); blank = true; }
        dripAt = null;
        return false;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (modes.trail) {
        // Fading instead of clearing leaves a tail behind everything that moves.
        ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(0,0,0,0.07)'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.globalCompositeOperation = 'source-over';
      } else ctx.clearRect(0, 0, WIDTH, HEIGHT);
      blank = false;
      if (modes.drip) { if (dripAt === null) dripAt = now; } else dripAt = null;
      tags.forEach((tag, index) => {
        const written = Math.min(1, (now - tag.writeAt) / WRITE_MS);
        const burst = tag.burstAt === null ? 1 : Math.min(1, (now - tag.burstAt) / BURST_MS);
        if (burst >= 1) tag.burstAt = null;
        const alpha = tag.wipeAt === null ? 1 : 1 - (now - tag.wipeAt) / WIPE_MS;
        // One zoom breath per four beats, one turn per eight; tags alternate direction and phase.
        let scale = modes.pulse ? 1 + 0.14 * Math.max(0, Math.min(1, pulse || 0)) : 1;
        if (modes.zoom) scale *= 1 + 0.38 * Math.sin(clock * Math.PI / 2 + index * 1.3);
        const angle = modes.spin ? clock * Math.PI / 4 * (index % 2 ? -1 : 1) : 0;
        const moveX = modes.drift ? Math.sin(clock * 0.55 + index * 2.1) * 0.11 * WIDTH : 0;
        const moveY = modes.drift ? Math.cos(clock * 0.37 + index * 1.7) * 0.13 * HEIGHT : 0;
        const cos = Math.cos(angle) * scale, sin = Math.sin(angle) * scale;
        // Scale and rotate around the tag's own centre, then move it.
        ctx.setTransform(cos, sin, -sin, cos, tag.cx - cos * tag.cx + sin * tag.cy + moveX, tag.cy - sin * tag.cx - cos * tag.cy + moveY);
        if (dripAt !== null && written >= 1) {
          const grown = Math.min(1, (now - dripAt) / 3500);
          for (const drip of tag.drips) {
            const stroke = tag.strokes[drip.stroke];
            ctx.globalAlpha = alpha; ctx.lineWidth = drip.width;
            ctx.strokeStyle = modes.rainbow ? 'hsl(' + ((now * 0.12 + drip.stroke * 47 + index * 80) % 360) + ',100%,60%)' : stroke.color;
            ctx.beginPath(); ctx.moveTo(drip.x, drip.y); ctx.lineTo(drip.x, drip.y + drip.length * grown); ctx.stroke();
          }
        }
        paint(tag, index, now, modes, written * tag.path, burst < 1 ? 0.4 * Math.sin(Math.PI * burst) : 0, alpha, modes.wave ? clock + index : -1);
      });
      ctx.globalAlpha = 1;
      return true;
    }

    return { canvas, add, trigger, render, count: () => tags.length };
  }

  root.VJTags = { create, parse, MODES, SHOTS, WIDTH, HEIGHT };
})(typeof window !== 'undefined' ? window : globalThis);

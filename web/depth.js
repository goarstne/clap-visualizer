/**
 * Live depth for the camera layer: Depth Anything V2 Small (ONNX, Apache-2.0) turns the camera
 * picture into a depth map a few times per second. It runs on the CPU in onnxruntime's own
 * worker, so the display keeps its frame rate. The runtime and the model are not part of the
 * repository; `make depth` fetches them into vendor/depth/. Without them the camera stays flat.
 *
 * API: VJDepth.create(onDepth) -> {feed(video)}; onDepth(map, size) gets size*size bytes,
 * row 0 at the top, 255 = nearest.
 */
(function (root) {
  'use strict';

  const DIR = new URL('vendor/depth/', root.location.href).href;
  // Multiple of the model's 14 px patches. Measured on an M2 Pro: about 200 ms per map.
  const SIZE = 252;
  // More than four threads were not faster and take cores from the audio host. Threads need the
  // cross-origin isolation headers the plugin sends; without them one thread manages about 1.5 maps/s.
  const THREADS = 4;
  const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

  const script = src => new Promise((resolve, reject) => {
    const tag = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error('missing ' + src)) });
    document.head.appendChild(tag);
  });

  function create(onDepth) {
    const canvas = Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = SIZE * SIZE, map = new Uint8Array(pixels);
    let session = null, busy = false, failed = false, low = 0, high = 1, first = true;

    async function run(video) {
      if (!session) {
        await script(DIR + 'ort.wasm.min.js');
        Object.assign(root.ort.env.wasm, { wasmPaths: DIR, proxy: true, numThreads: root.crossOriginIsolated ? THREADS : 1 });
        session = await root.ort.InferenceSession.create(DIR + 'model_quantized.onnx', { executionProviders: ['wasm'] });
      }
      // The picture is squeezed into a square; the map is stretched back by the shader.
      context.drawImage(video, 0, 0, SIZE, SIZE);
      const rgba = context.getImageData(0, 0, SIZE, SIZE).data;
      // A fresh buffer per run: the worker takes ownership of it.
      const input = new Float32Array(3 * pixels);
      for (let i = 0; i < pixels; i++) for (let c = 0; c < 3; c++) input[c * pixels + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
      const output = await session.run({ [session.inputNames[0]]: new root.ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
      const depth = output[session.outputNames[0]].data;
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < pixels; i++) { if (depth[i] < min) min = depth[i]; if (depth[i] > max) max = depth[i]; }
      // The model gives relative depth, so every map is stretched to 0..1. Range and map are
      // smoothed over time, otherwise the picture flickers at a few maps per second.
      const blend = first ? 1 : 0.5; first = false;
      low += (min - low) * blend; high += (max - high) * blend;
      const scale = 255 / Math.max(1e-6, high - low);
      for (let i = 0; i < pixels; i++) map[i] += (Math.max(0, Math.min(255, (depth[i] - low) * scale)) - map[i]) * blend;
      onDepth(map, SIZE);
    }

    return {
      get failed() { return failed; },
      // Call every frame the depth is needed; frames arriving during a run are skipped.
      feed(video) {
        if (busy || failed) return;
        busy = true;
        run(video).catch(error => { failed = true; console.warn('Depth is off (run "make depth"?):', error); }).finally(() => { busy = false; });
      }
    };
  }

  root.VJDepth = { create, SIZE };
})(window);

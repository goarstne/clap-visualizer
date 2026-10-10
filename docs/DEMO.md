# Recording the demo

The release video runs the real CLAP plugin in `tools/fakehost` with an original synthesized 120 BPM track. It shows the browser display and touch-operated controller with English captions. The interface itself currently uses German labels.

Requirements: build dependencies, Node.js, Python 3, FFmpeg, Chromium at `/usr/bin/chromium`, and an existing Playwright installation. Set `PW` to a directory containing `node_modules/playwright`. Recording uses an isolated browser context.

```bash
make
export PW=/path/to/playwright-installation
DEMO_WORK=$(mktemp -d)
mkdir -p "$DEMO_WORK/web" "$DEMO_WORK/out"
# Copy only web code and bundled libraries, excluding generated personal images:
python3 - "$DEMO_WORK/web" <<'PY'
from pathlib import Path
import shutil, sys
out = Path(sys.argv[1])
for p in Path('web').iterdir():
    if p.name == 'pictures':
        continue
    if p.is_dir():
        shutil.copytree(p, out / p.name)
    else:
        shutil.copy2(p, out / p.name)
shutil.copytree('demo/pictures', out / 'pictures')
shutil.copy2('tools/demo/demo.html', out / 'demo.html')
shutil.copy2('tools/demo/mockup.html', out / 'mockup.html')
PY
node tools/demo/music.js "$DEMO_WORK/music.f32" 180
node tools/demo/record.js "$DEMO_WORK/web" "$DEMO_WORK/music.f32" "$DEMO_WORK/out" > "$DEMO_WORK/out/result.json"
```

The recorder prints measured `audioOffset`, `seconds`, browser errors, requested images and frame-rate samples. Mux the synthesized audio at that offset (use the numeric value from `result.json`):

```bash
ffmpeg -i "$DEMO_WORK/out/video.mp4" -ss AUDIO_OFFSET_SECONDS \
  -f f32le -ar 48000 -ac 2 -i "$DEMO_WORK/music.f32" \
  -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest \
  -movflags +faststart "$DEMO_WORK/clap-visualizer-demo.mp4"
```

The final MP4 is a GitHub release asset and is excluded from Git. Check the entire requested-image list against `demo/pictures/index.json` and review the video before publishing. Image sources and licenses: [CREDITS.md](../demo/CREDITS.md).

For the iPad mockup, serve the same sanitized web folder with `VSTVIS_WEB_DIR` and load `/mockup.html`; capture a 1560×1120 viewport with Playwright. Its iframe is the actual controller at 1180×820, inside a CSS tablet frame. The checked-in render is [`ipad-control.png`](ipad-control.png).

For touch verification, run a separate test host on port 18770 and `PW=... node tools/touchtest.js /your/output/directory`. Inspect its JSON for both orientations: no page errors/horizontal overflow, valid tap/solo controls, pinch/drag, spring return, released momentary controls and completed image routines. This emulates Chromium touch input; it does not verify real iPad Safari.

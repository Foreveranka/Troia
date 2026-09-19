# Troia installation guide

A 40-second, silent, illustrated desktop Chrome walkthrough. The download, ZIP extraction,
Developer mode and folder-picker scenes are instructional recreations, not a live screen recording.
The final scene contains the actual packaged extension popup. English and Turkish WebVTT captions
are included. The media player is lazy-loaded and supports native controls/fullscreen.

Regenerate with Node.js, Playwright Chromium and ffmpeg installed:

```sh
node scripts/tutorial/render-install-guide.cjs
```

If Playwright is supplied outside this repository, set `TROIA_PLAYWRIGHT` to its module path.
`PLAYWRIGHT_BROWSERS_PATH` may be set for an external browser installation. The script writes
reproducible public media into `app/storefront/public/media` and temporary stills to
`.deploy/tutorial-frames`. No existing personal browser profile is opened.

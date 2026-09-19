# Troia installation guide

A 26.25-second silent motion edit made from authentic Chrome screenshots. Six short chapters
show the project website, Developer mode, Load unpacked, folder selection, the installed
extension and its popup. Camera moves ease in and out; chapters use 350 ms dissolves. Thin
brass outlines indicate real controls. No browser UI, clicks, download success or transactions
are fabricated. The first chapter explains download/extraction; these actions were not recorded.

Typography is rendered separately by Pillow; screenshot pixels are handled only by ffmpeg's
video crop, zoom and compositing filters. Small English/Turkish captions are switchable WebVTT.
Personal browser tabs and unrelated filenames are excluded. Private source screenshots are
not checked into the repository or deployed. The popup is a Chrome capture of the built UI.

Requirements: Node.js, ffmpeg, Python with Pillow, macOS Arial/Georgia fonts.

```sh
TROIA_VIDEO_PYTHON=/path/to/python node scripts/tutorial/render-install-guide.cjs /private/screenshots
```

Sources: `website.png` (actual website), `extensions.png`, `folder.png`, `installed.png`
(2940 × 1912) and `popup-current.png` (384 × 603). Final media goes to
`app/storefront/public/media`; intermediate clips and typography go to `.deploy/tutorial-motion`.
The renderer never opens or controls Chrome.

# Troia installation guide

A 40-second silent walkthrough assembled from real Chrome screenshots supplied by the user.
It shows Developer mode, the folder picker, the installed extension and its popup. It is a
screenshot sequence, not a continuous screen recording. No browser UI or clicks are recreated.
The last scene is a fresh Chrome capture of the built popup HTML with the updated Turkish labels.
It previews the real component; it does not assert any payment or wallet state.

Browser tabs are cropped from the video. Unrelated filenames in the folder picker are covered.
Original screenshots remain outside the repository and are never shipped with the website.
English and Turkish WebVTT tracks provide small, switchable captions. ZIP download/extraction
is a captioned prerequisite; it is not presented as a captured action.

Regenerate with Node.js and ffmpeg:

```sh
node scripts/tutorial/render-install-guide.cjs /path/to/screenshots
```

The input directory must contain `extensions.png`, `folder.png`, `installed.png`, at 2940 × 1912, plus `popup-current.png` at 384 × 603. The script writes media to `app/storefront/public/media` and temporary clips
to `.deploy/tutorial-real`. It does not access or control Chrome.

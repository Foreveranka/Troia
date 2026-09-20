// Render a guided motion edit from authentic screenshots; never recreate browser UI.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const source = process.argv[2];
if (!source) throw new Error('Pass the private screenshot directory.');
const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'app/storefront/public/media');
const work = path.join(root, '.deploy/tutorial-motion');
fs.mkdirSync(work, { recursive: true });
const python =
  process.env.TROIA_VIDEO_PYTHON ||
  '/Users/mete/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
execFileSync(python, [path.join(import.meta.dirname, 'render-overlays.py'), work], {
  stdio: 'inherit',
});
const scenes = [
  // file, preparation, duration, starting zoom, ending zoom, focal x/y
  ['website.png', 'null', 4, 1, 1.08, 0, 0.8],
  [
    'extensions.png',
    'crop=2940:1660:0:242,drawbox=x=2635:y=15:w=290:h=82:color=0xc7a468:t=5',
    5,
    1.1,
    2.6,
    1,
    0,
  ],
  [
    'extensions.png',
    'crop=1500:925:0:242,drawbox=x=44:y=122:w=395:h=80:color=0xc7a468:t=4',
    4,
    1.05,
    1.6,
    0,
    0,
  ],
  [
    'folder.png',
    'drawbox=x=940:y=815:w=440:h=148:color=0x1d2020:t=fill,drawbox=x=940:y=1020:w=440:h=370:color=0x1d2020:t=fill,crop=1420:895:930:628,drawbox=x=1224:y=802:w=157:h=51:color=0xc7a468:t=4',
    6,
    1,
    1.035,
    0.75,
    0.6,
  ],
  ['installed.png', 'crop=804:436:774:646', 4, 1, 1.06, 0.9, 0.7],
  ['popup-current.png', 'null', 5, 1, 1.015, 0.5, 0.5],
];
const fps = 30,
  fade = 0.35;
const run = (args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
scenes.forEach(([file, pre, duration, z0, z1, fx, fy], i) => {
  const frames = duration * fps;
  // Smooth ease-in/ease-out camera movement. Its focal point follows real UI controls.
  const ease = `(0.5-0.5*cos(PI*min(on/${frames - 1},1)))`;
  const vf = `${pre},scale=2052:1264:force_original_aspect_ratio=decrease,pad=2052:1264:(ow-iw)/2:(oh-ih)/2:color=0x0c1b30,zoompan=z='${z0}+(${z1}-${z0})*${ease}':x='(iw-iw/zoom)*${fx}':y='(ih-ih/zoom)*${fy}':d=${frames}:s=1026x632:fps=${fps},pad=1600:900:510:154:color=0xf4efe4,setsar=1`;
  run([
    '-i',
    path.join(source, file),
    '-loop',
    '1',
    '-framerate',
    String(fps),
    '-i',
    path.join(work, `overlay-${i}.png`),
    '-filter_complex',
    `[0:v]${vf}[screen];[screen][1:v]overlay=0:0:shortest=1,format=yuv420p[v]`,
    '-map',
    '[v]',
    '-t',
    String(duration),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '18',
    path.join(work, `${i}.mp4`),
  ]);
  console.log(`Rendered chapter ${i + 1}/6`);
});
const inputs = scenes.flatMap((_, i) => ['-i', path.join(work, `${i}.mp4`)]);
let filter = '',
  duration = scenes[0][2];
for (let i = 1; i < scenes.length; i++) {
  const offset = duration - fade;
  filter += `${i === 1 ? '[0:v]' : `[x${i - 1}]`}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[x${i}];`;
  duration += scenes[i][2] - fade;
}
run([
  ...inputs,
  '-filter_complex_threads',
  '1',
  '-filter_complex',
  filter.slice(0, -1),
  '-map',
  '[x5]',
  '-an',
  '-c:v',
  'libx264',
  '-preset',
  'fast',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  path.join(out, 'troia-install.mp4'),
]);
run([
  '-ss',
  '0.5',
  '-i',
  path.join(out, 'troia-install.mp4'),
  '-frames:v',
  '1',
  '-q:v',
  '2',
  path.join(out, 'install-poster.jpg'),
]);
const en = [
  'Download the ZIP and extract it.',
  'Open chrome://extensions. Enable Developer mode.',
  'Click Load unpacked.',
  'Select the troia-testnet folder, then click Select.',
  'Troia is installed. Keep it enabled.',
  'Open Troia from the extensions menu.',
];
const tr = [
  'ZIP dosyasını indirip klasöre çıkar.',
  'chrome://extensions adresinde Geliştirici modunu aç.',
  'Paketlenmemiş öğe yükle’ye tıkla.',
  'troia-testnet klasörünü seç, ardından Seç’e tıkla.',
  'Troia yüklendi. Açık bırak.',
  'Uzantılar menüsünden Troia’yı aç.',
];
const stamp = (n) => `00:00:${n.toFixed(3).padStart(6, '0')}`;
for (const [lang, lines] of [
  ['en', en],
  ['tr', tr],
]) {
  let start = 0;
  const cues = scenes.map((s, i) => {
    const end = start + s[2] - (i === scenes.length - 1 ? 0 : fade);
    const cue = `${i + 1}\n${stamp(start)} --> ${stamp(end)} line:91% size:88% align:center\n${lines[i]}\n`;
    start = end;
    return cue;
  });
  fs.writeFileSync(path.join(out, `install-${lang}.vtt`), 'WEBVTT\n\n' + cues.join('\n'));
}
console.log(`Finished ${duration.toFixed(2)}s motion guide`);

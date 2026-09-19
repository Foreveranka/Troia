// Assemble a walkthrough from user-supplied, real Chrome screenshots.
// Sources stay outside the repository; no recreated browser UI or simulated clicks.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const source = process.argv[2];
if (!source)
  throw new Error('Usage: node scripts/tutorial/render-install-guide.cjs /path/to/screenshots');
const out = path.resolve(__dirname, '../../app/storefront/public/media');
const work = path.resolve(__dirname, '../../.deploy/tutorial-real');
fs.mkdirSync(work, { recursive: true });
const scenes = [
  ['extensions.png', 'crop=2940:1000:0:148'],
  // Conceal unrelated filenames. Keep the selected folder, its contents and Select button.
  [
    'folder.png',
    'drawbox=x=940:y=815:w=440:h=148:color=0x1d2020:t=fill,drawbox=x=940:y=1020:w=440:h=370:color=0x1d2020:t=fill,crop=1420:895:930:628',
  ],
  ['installed.png', 'crop=1620:850:0:242'],
  ['popup-current.png', 'null'],
];
scenes.forEach(([file, filter], index) => {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loop',
      '1',
      '-framerate',
      '25',
      '-i',
      path.join(source, file),
      '-vf',
      `${filter},scale=1600:820:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1600:900:(ow-iw)/2:(820-ih)/2:color=0x0c1b30,setsar=1,format=yuv420p`,
      '-t',
      '10',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      path.join(work, `${index}.mp4`),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
});
fs.writeFileSync(path.join(work, 'concat.txt'), scenes.map((_, i) => `file '${i}.mp4'`).join('\n'));
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    path.join(work, 'concat.txt'),
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    path.join(out, 'troia-install.mp4'),
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-ss',
    '30',
    '-i',
    path.join(out, 'troia-install.mp4'),
    '-frames:v',
    '1',
    '-q:v',
    '2',
    path.join(out, 'install-poster.jpg'),
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const cues = [
  [
    0,
    5,
    'First, download the Troia ZIP and extract it.',
    'Önce Troia ZIP dosyasını indirip klasöre çıkar.',
  ],
  [
    5,
    10,
    'Enable Developer mode. Click Load unpacked.',
    'Geliştirici modunu aç. Paketlenmemiş öğe yükle’ye tıkla.',
  ],
  [
    10,
    20,
    'Select the troia-testnet folder, then click Select.',
    'troia-testnet klasörünü seç, ardından Seç’e tıkla.',
  ],
  [
    20,
    30,
    'Troia now appears in your extensions. Keep it enabled.',
    'Troia artık uzantılarında görünüyor. Açık bırak.',
  ],
  [
    30,
    40,
    'Open Troia from the extensions menu. You are ready.',
    'Uzantılar menüsünden Troia’yı aç. Kurulum tamam.',
  ],
];
const stamp = (n) => `00:00:${String(n).padStart(2, '0')}.000`;
for (const [lang, col] of [
  ['en', 2],
  ['tr', 3],
]) {
  fs.writeFileSync(
    path.join(out, `install-${lang}.vtt`),
    'WEBVTT\n\n' +
      cues
        .map(
          (c, i) =>
            `${i + 1}\n${stamp(c[0])} --> ${stamp(c[1])} line:94% size:96% align:center\n${c[col]}\n`,
        )
        .join('\n'),
  );
}
console.log('Created 40-second walkthrough from original Chrome screenshots.');

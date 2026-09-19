// Generates an illustrated installation walkthrough. No personal browser profile is used.
// Usage: PLAYWRIGHT_BROWSERS_PATH=... TROIA_PLAYWRIGHT=... node scripts/tutorial/render-install-guide.cjs
const { chromium } = require(process.env.TROIA_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'app/storefront/public/media');
const frames = path.join(root, '.deploy/tutorial-frames');
fs.mkdirSync(frames, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const data = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
const logo = data(path.join(root, 'app/extension/src/popup/assets/logo.png'));
const popup = data(path.join(out, 'extension-popup.png'));
const browserbar = (url) =>
  `<div class="browserbar"><span>● ● ●</span><div>⌕ &nbsp; ${url}</div><span>⋮</span></div>`;
const cursor =
  '<svg class="cursor" viewBox="0 0 24 30" width="40" height="50"><path d="M2 1L21 19L13 20L9 28L2 1" fill="#0c1b30" stroke="#fff" stroke-width="2"/></svg>';
const scenes = [
  {
    title: 'Download Troia.',
    sub: 'Get the preview from the official project page.',
    note: '01 / DOWNLOAD THE ZIP',
    html: `${browserbar('troia-extension.vercel.app/#install')}<div class="download"><img src="${logo}"/><small>TROIA / CHROME EXTENSION</small><h2>Start with the extension.</h2><div class="downloadbtn">Download Troia ZIP &nbsp; ↓ ${cursor}</div><div class="download-file">↓ &nbsp; troia-testnet.zip <span>Download complete ✓</span></div></div>`,
    en: 'Download the Troia ZIP.',
    tr: 'Troia ZIP dosyasını indir.',
  },
  {
    title: 'Extract the ZIP.',
    sub: 'Chrome needs the folder inside, not the archive.',
    note: '02 / UNZIP BEFORE YOU CONTINUE',
    html: `<div class="folder-scene"><div class="file-icon">ZIP</div><div class="arrow">→</div><div class="folder-icon">▰</div><div class="file-label">troia-testnet.zip</div><div></div><div class="file-label">troia-testnet/</div></div><div class="os"><div><b>macOS</b><span>Double-click the ZIP</span></div><div><b>Windows</b><span>Right-click → Extract All</span></div></div><div class="keep">Keep the extracted folder. Troia will load from here.</div>`,
    en: 'Extract the ZIP into a folder.',
    tr: 'ZIP dosyasını bir klasöre çıkar.',
  },
  {
    title: 'Enable Developer mode.',
    sub: 'Open Chrome’s Extensions page in the address bar.',
    note: '03 / OPEN CHROME://EXTENSIONS',
    html: `${browserbar('chrome://extensions')}<div class="chrome-head"><b>Extensions</b><div class="highlight">Developer mode <span class="toggle"><i></i></span>${cursor}</div></div><div class="chrome-body"><aside>My extensions<br/><br/>Keyboard shortcuts</aside><div class="chrome-empty"><div class="chrome-buttons">Load unpacked &nbsp;&nbsp;&nbsp; Pack extension &nbsp;&nbsp;&nbsp; Update</div><h3>Your extensions appear here.</h3><p>Turn on Developer mode at the top right.</p></div></div>`,
    en: 'Open chrome://extensions. Enable Developer mode.',
    tr: 'chrome://extensions adresinde Geliştirici modunu aç.',
  },
  {
    title: 'Choose the Troia folder.',
    sub: 'Load unpacked → troia-testnet → Select Folder.',
    note: '04 / SELECT THE FOLDER, NOT THE ZIP',
    html: `${browserbar('chrome://extensions')}<div class="chrome-head"><b>Extensions</b><div>Developer mode <span class="toggle"><i></i></span></div></div><div class="load-button">Load unpacked ${cursor}</div><div class="picker"><div class="picker-title">Select extension directory <span>Folder selection illustrated</span></div><div class="folder-path">Downloads / <b>troia-testnet</b></div><div class="filelist"><div>▣ &nbsp; manifest.json <span>CHECK THIS FILE IS INSIDE</span></div><div>▰ &nbsp; assets</div><div>▰ &nbsp; icons</div><div>▰ &nbsp; src</div></div><div class="picker-foot"><span>Choose the folder containing manifest.json.</span><b>Select Folder ✓</b></div></div>`,
    en: 'Load unpacked → select the troia-testnet folder.',
    tr: 'Paketlenmemiş öğe yükle → troia-testnet klasörünü seç.',
  },
  {
    title: 'Troia is ready.',
    sub: 'Open the demo store. Add an item. Choose Stellar at checkout.',
    note: '05 / YOUR FIRST TEST CHECKOUT',
    html: `<div class="ready"><div><img src="${logo}" class="ready-logo"/><small>INSTALLED IN CHROME</small><h2>Your card.<br/>Your browser.<br/><em>Your Troia.</em></h2><div class="ready-link">troia-demo-store.vercel.app ↗</div><p>Pay with crypto → Stellar → Troia</p><span class="ready-fine">Use the sandbox test card shown at checkout.</span></div><img src="${popup}" class="ready-popup"/></div>`,
    en: 'Open the demo store. Choose Stellar at checkout.',
    tr: 'Demo mağazasında ödeme ağı olarak Stellar’ı seç.',
  },
];
const css = `*{box-sizing:border-box}body{margin:0;background:#0c1b30;color:#f4efe4;font-family:Arial,sans-serif}.slide{width:1280px;height:720px;padding:38px 48px}.top{display:flex;align-items:center;justify-content:space-between;font-size:12px;letter-spacing:3px;color:#c9ad7c}.top span:last-child{font-size:10px;letter-spacing:1px;color:#a8b2c1}.title{font:42px Georgia,serif;margin:21px 0 9px;letter-spacing:-1px}.subtitle{font-size:16px;color:#b8c1ce;margin-bottom:22px}.screen{position:relative;width:1184px;height:424px;background:#faf7f0;color:#0c1b30;border:1px solid #bdab8c;overflow:hidden}.progress{margin-top:19px;display:flex;gap:8px}.progress span{height:3px;flex:1;background:#354257}.progress .active{background:#c7a468}.note{font-size:11px;letter-spacing:2px;margin-top:15px;color:#c9ad7c}.browserbar{background:#e9e5dd;height:45px;display:flex;align-items:center;padding:0 20px;gap:26px;font-size:14px}.browserbar>span{color:#998e7c;font-size:10px;letter-spacing:3px}.browserbar>div{flex:1;background:#fff;padding:7px 18px;border-radius:20px;font-size:14px}.download{display:flex;align-items:center;flex-direction:column;padding:25px}.download img{width:48px;height:48px;margin-bottom:12px}.download small{font-size:10px;letter-spacing:2px;color:#8c6a38}.download h2{font:30px Georgia;margin:16px 0 22px}.downloadbtn{background:#0c1b30;color:#fff;padding:16px 45px;font-size:16px;position:relative}.cursor{position:absolute;right:8px;bottom:-25px;z-index:2;filter:drop-shadow(2px 2px 2px #0003)}.download-file{margin-top:25px;border:1px solid #d1c6b2;background:#efeadf;padding:12px 20px;font-size:14px}.download-file span{margin-left:55px;color:#617650;font-size:12px}.folder-scene{display:grid;grid-template-columns:300px 110px 300px;align-items:center;justify-content:center;text-align:center;gap:12px 20px;padding-top:48px}.file-icon{border:2px solid #b99965;width:95px;height:115px;background:#f1e6d3;margin:auto;display:grid;place-items:center;font-size:25px;letter-spacing:3px}.folder-icon{background:#c7a468;width:145px;height:96px;margin:auto;border-radius:5px;position:relative;font-size:0}.folder-icon:before{content:'';position:absolute;top:-12px;left:0;width:65px;height:18px;background:#c7a468;border-radius:5px}.arrow{font-size:40px;color:#ad8a51}.file-label{font:18px monospace;padding-top:10px}.os{display:flex;justify-content:center;gap:90px;margin-top:28px;font-size:13px}.os>div{display:grid;gap:8px}.os b{font-weight:500;color:#8c6a38}.keep{font-size:13px;text-align:center;margin-top:26px;color:#687484}.chrome-head{height:65px;border-bottom:1px solid #e2dfd6;padding:17px 24px;display:flex;align-items:center;justify-content:space-between}.chrome-head>b{font-size:23px;font-weight:500}.chrome-head>div{font-size:14px;display:flex;align-items:center;gap:14px}.toggle{display:inline-block;width:42px;height:22px;border-radius:20px;background:#395b82;position:relative}.toggle i{position:absolute;right:3px;top:3px;width:16px;height:16px;background:#fff;border-radius:50%}.highlight{padding:12px;border:2px solid #a77d43;position:relative;background:#ede3ce}.chrome-body{display:flex}.chrome-body aside{width:230px;border-right:1px solid #e2dfd6;padding:30px 24px;font-size:13px;color:#617895;min-height:320px}.chrome-empty{padding:25px 30px;flex:1}.chrome-buttons{font-size:13px;color:#426183;padding:10px 0}.chrome-empty h3{font:24px Georgia;margin-top:40px}.chrome-empty p{color:#7e8693;font-size:14px}.load-button{display:inline-block;margin:16px 24px;border:2px solid #b08a50;padding:9px 18px;font-size:13px;position:relative;background:#ede3ce}.picker{position:absolute;width:700px;right:42px;top:92px;background:white;border:1px solid #c7bcaa;box-shadow:0 10px 35px #0c1b3020}.picker-title{display:flex;align-items:center;justify-content:space-between;background:#e9e5dd;padding:13px 18px;font-size:14px}.picker-title span{font-size:9px;color:#82817e}.folder-path{padding:14px 18px;border-bottom:1px solid #e3ddd3;font-size:13px}.filelist{font-size:13px;padding:7px 18px}.filelist>div{padding:8px 4px}.filelist>div:first-child{background:#f2ecdf}.filelist span{font-size:8px;color:#9b753d;margin-left:130px}.picker-foot{display:flex;justify-content:space-between;align-items:center;padding:13px 18px;border-top:1px solid #eee;font-size:10px;color:#667282}.picker-foot b{font-weight:400;background:#0c1b30;color:#fff;padding:12px 20px;font-size:13px}.ready{display:flex;justify-content:space-between;align-items:center;padding:28px 90px;gap:50px;height:100%;background:#eee6d8}.ready-logo{width:46px;height:46px;vertical-align:middle;margin-right:16px}.ready small{font-size:10px;letter-spacing:2px;color:#8b6b39}.ready h2{font:45px/1.07 Georgia;margin:22px 0}.ready h2 em{color:#9b763e;font-weight:400}.ready-link{border-bottom:1px solid #bca987;padding-bottom:10px;font-size:18px}.ready p{font-size:13px;margin-top:16px}.ready-fine{font-size:10px;color:#77808c}.ready-popup{height:374px;width:auto;box-shadow:0 10px 25px #0002;border:1px solid #c6baa4}`;
(async () => {
  const b = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      await page.setContent(
        `<style>${css}</style><div class="slide"><div class="top">TROIA<span>INSTALLATION GUIDE · DESKTOP CHROME</span></div><h1 class="title">${s.title}</h1><div class="subtitle">${s.sub}</div><div class="screen">${s.html}</div><div class="progress">${scenes.map((_, j) => `<span class="${j <= i ? 'active' : ''}"></span>`).join('')}</div><div class="note">${s.note}</div></div>`,
      );
      await page.screenshot({ path: path.join(frames, `${i}.png`) });
    }
    await page.goto('file://' + path.join(frames, '0.png'));
  } finally {
    await b.close();
  }
  const args = ['-y'];
  for (let i = 0; i < 5; i++)
    args.push('-loop', '1', '-t', '8', '-i', path.join(frames, `${i}.png`));
  const filters =
    scenes
      .map(
        (_, i) =>
          `[${i}:v]fps=25,format=yuv420p,fade=t=in:st=0:d=0.2,fade=t=out:st=7.8:d=0.2,setsar=1[v${i}]`,
      )
      .join(';') +
    ';' +
    scenes.map((_, i) => `[v${i}]`).join('') +
    'concat=n=5:v=1:a=0[out]';
  args.push(
    '-filter_complex',
    filters,
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '21',
    '-movflags',
    '+faststart',
    path.join(out, 'troia-install.mp4'),
  );
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
  execFileSync(
    'ffmpeg',
    ['-y', '-i', path.join(frames, '0.png'), '-q:v', '3', path.join(out, 'install-poster.jpg')],
    { stdio: 'ignore' },
  );
  const stamp = (n) =>
    `00:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000`;
  for (const lang of ['en', 'tr'])
    fs.writeFileSync(
      path.join(out, `install-${lang}.vtt`),
      'WEBVTT\n\n' +
        scenes
          .map(
            (s, i) =>
              `${i + 1}\n${stamp(i * 8)} --> ${stamp((i + 1) * 8)} line:92% size:92% align:center\n${s[lang]}\n`,
          )
          .join('\n'),
    );
  console.log('Rendered 40-second install guide, poster and EN/TR captions');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

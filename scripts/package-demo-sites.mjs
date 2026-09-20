// Build apps first. Stage only public artifacts, never the repository or environment files.
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const upstream = new URL(process.env.TROIA_API_UPSTREAM || 'http://127.0.0.1:3001');
if (
  upstream.username ||
  upstream.password ||
  upstream.search ||
  upstream.hash ||
  upstream.pathname !== '/'
)
  throw new Error('TROIA_API_UPSTREAM must be a plain backend origin without credentials');
if (upstream.protocol !== 'https:' && upstream.hostname !== '127.0.0.1')
  throw new Error('Public API upstream requires HTTPS');
const ext = resolve(root, 'app/extension/dist');
if (!existsSync(resolve(ext, 'manifest.json'))) throw new Error('Build the extension first');
const zipRoot = resolve(root, '.deploy/package');
rmSync(zipRoot, { recursive: true, force: true });
mkdirSync(zipRoot, { recursive: true });
cpSync(ext, resolve(zipRoot, 'troia-testnet'), { recursive: true });
const downloads = resolve(root, 'app/storefront/public/downloads');
mkdirSync(downloads, { recursive: true });
const archive = resolve(downloads, 'troia-testnet.zip');
rmSync(archive, { force: true });
execFileSync('zip', ['-qr', archive, 'troia-testnet'], { cwd: zipRoot });
for (const [app, name, paths] of [
  ['storefront', 'intro', ['/wallet', '/store']],
  ['gamestore', 'demo', ['/shop']],
]) {
  const target = resolve(root, '.deploy', name);
  mkdirSync(target, { recursive: true });
  rmSync(resolve(target, 'assets'), { recursive: true, force: true });
  cpSync(resolve(root, 'app', app, 'dist'), target, { recursive: true });
  writeFileSync(resolve(target, '.vercelignore'), '.env*\n.vercel\n.git\nnode_modules\n');
  const rewrites = paths.map((source) => ({ source, destination: '/index.html' }));
  if (name === 'intro') {
    cpSync(downloads, resolve(target, 'downloads'), { recursive: true });
    // Metrics stay on the private backend listener. Only customer API routes are proxied.
    for (const path of [
      'healthz',
      'session',
      'intent',
      'quote/:amount',
      'status/:order',
      'receipt/:order',
      'return',
      'webhook',
    ])
      rewrites.unshift({ source: `/api/${path}`, destination: `${upstream.origin}/${path}` });
  }
  writeFileSync(
    resolve(target, 'vercel.json'),
    JSON.stringify(
      {
        framework: null,
        buildCommand: null,
        installCommand: null,
        outputDirectory: '.',
        rewrites,
        headers: [
          {
            source: '/(.*)',
            headers: [
              { key: 'X-Content-Type-Options', value: 'nosniff' },
              { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
              { key: 'X-Frame-Options', value: 'DENY' },
            ],
          },
          { source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
          { source: '/downloads/:path*', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
        ],
      },
      null,
      2,
    ) + '\n',
  );
}
console.log(
  'Staged public sites in .deploy/intro and .deploy/demo. ZIP rebuilt. No deployment performed.',
);

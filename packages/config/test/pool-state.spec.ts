import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// `scripts/pool-state.mjs` is the gate that stops `just bootstrap` from ever deploying a SECOND TroyPool. It must
// distinguish two facts a deploy script may never confuse:
//
//   absent  — the network answered, and the contract is not on it. A testnet reset. Replacing the pool is correct.
//   unknown — we could not see the network. Nothing follows. Refuse.
//
// The reason this needs a test rather than a careful reading: `stellar network health` prints "❌ Unhealthy" and
// **exits 0**. A gate built on its exit code would silently decide "the pool is gone" every time the RPC blinked,
// and deploy over a live pool holding real balance. So the script parses the JSON and never consults the exit
// code, and the case below pins exactly that.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const SCRIPT = join(repoRoot, 'scripts', 'pool-state.mjs');

let binDir: string;

/** A fake `stellar` on PATH. It mimics the real CLI's contract: health ALWAYS exits 0, whatever it prints. */
function installFakeStellar(health: string, poolExit: 0 | 1): void {
  writeFileSync(
    join(binDir, 'stellar'),
    [
      '#!/usr/bin/env bash',
      'for a in "$@"; do',
      '  if [ "$a" = "health" ]; then',
      `    cat <<'EOF'`,
      health,
      'EOF',
      '    exit 0', // the real CLI exits 0 even when it prints "Unhealthy"
      '  fi',
      'done',
      `touch "${join('$TMPDIR_MARKER', 'pool-probed')}"`.replace('$TMPDIR_MARKER', binDir),
      `exit ${poolExit}`,
    ].join('\n'),
  );
  chmodSync(join(binDir, 'stellar'), 0o755);
}

function runPoolState(withStellar = true): string {
  const path = withStellar ? `${binDir}:${process.env.PATH ?? ''}` : '/usr/bin:/bin';
  const env = { ...process.env, PATH: path };
  delete env.STELLAR_RPC_URL; // keep the script on its `--network` path
  return execFileSync(process.execPath, [SCRIPT, 'testnet'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  }).trim();
}

const HEALTHY = '{"status":"healthy","latestLedger":1,"oldestLedger":1,"ledgerRetentionWindow":1}';

describe('pool-state — a second TroyPool must never be deployed on a guess', () => {
  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'troia-fakebin-'));
  });
  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it('live — the network answers and the pool responds', () => {
    installFakeStellar(HEALTHY, 0);
    expect(runPoolState()).toBe('live');
  });

  it('absent — the network answers and the pool does not. Only this may replace a pool', () => {
    installFakeStellar(HEALTHY, 1);
    expect(runPoolState()).toBe('absent');
  });

  it('unknown — the RPC reports itself unhealthy', () => {
    installFakeStellar('{"status":"unhealthy"}', 1);
    expect(runPoolState()).toBe('unknown');
  });

  // The regression that matters. Trusting the exit code here would report `absent` for a pool that is very
  // much alive, and `just bootstrap` would deploy over it.
  it('unknown — the CLI prints “Unhealthy” and still exits 0; the exit code is never consulted', () => {
    installFakeStellar('❌ Unhealthy\n❌ failed to fetch network health: connection refused', 1);
    expect(runPoolState()).toBe('unknown');
  });

  it('never even asks about the pool when it cannot see the network', () => {
    installFakeStellar('❌ Unhealthy', 0);
    expect(runPoolState()).toBe('unknown');
    expect(existsSync(join(binDir, 'pool-probed'))).toBe(false);
  });

  it('unknown — the stellar CLI is not installed', () => {
    expect(runPoolState(false)).toBe('unknown');
  });

  // A record that cannot be read says nothing about the pool it was supposed to name. `bootstrap` checks the file
  // EXISTS but not that it parses, so a truncated or half-written record must never be read as "the pool is gone".
  it.each([
    ['corrupt JSON', 'not json at all'],
    ['valid JSON, wrong shape', '{"hello":"world"}'],
  ])('unknown — the deployment record is %s', (_label, contents) => {
    installFakeStellar(HEALTHY, 1); // the network is fine and the pool would look absent
    const record = join(binDir, 'deployment.json');
    writeFileSync(record, contents);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TROIA_DEPLOYMENT_PATH: record,
    };
    delete env.STELLAR_RPC_URL;
    const out = execFileSync(process.execPath, [SCRIPT, 'testnet'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    }).trim();
    expect(out).toBe('unknown');
  });

  it('unknown — the deployment record does not exist', () => {
    installFakeStellar(HEALTHY, 1);
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TROIA_DEPLOYMENT_PATH: join(binDir, 'nope.json'),
    };
    delete env.STELLAR_RPC_URL;
    const out = execFileSync(process.execPath, [SCRIPT, 'testnet'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    }).trim();
    expect(out).toBe('unknown');
  });
});

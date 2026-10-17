// Linux service startup only: the caller must hold ops/start-backend.sh's kernel flock for the entire process.
// Never use this to force-unlock an active writer. Corrupt records and permission failures stay fail-closed.
import { readFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function recoverDeadWriterLock(dataDir, { probe = (pid) => process.kill(pid, 0) } = {}) {
  const path = join(resolve(dataDir), 'writer.lock');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const owner = JSON.parse(raw);
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 1 ||
    !Number.isFinite(Date.parse(owner.startedAt))
  )
    throw new Error('Invalid writer lock; inspect it manually');
  try {
    probe(owner.pid);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    unlinkSync(path);
    return true;
  }
  throw new Error('Writer PID is still running; refusing a second settlement writer');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'linux' || process.env.TROIA_SERVICE_LOCK_HELD !== '1')
    throw new Error('Run through the Linux service wrapper with its exclusive kernel lock');
  if (!process.argv[2]) throw new Error('Missing pool data directory');
  if (recoverDeadWriterLock(process.argv[2]))
    console.log('Recovered dead writer lock under exclusive service flock');
}

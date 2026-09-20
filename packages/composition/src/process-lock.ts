import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One writer per pool. Crash leftovers fail closed; an operator checks the PID before removing one. */
export function acquireProcessLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'writer.lock');
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    throw new Error(
      `Pool writer lock exists: ${path}. Stop the other process first. After a crash, verify its PID is no longer running before removing this lock.`,
    );
  }
  writeFileSync(
    fd,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n',
  );
  closeSync(fd);
  let released = false;
  return () => {
    if (!released) {
      unlinkSync(path);
      released = true;
    }
  };
}

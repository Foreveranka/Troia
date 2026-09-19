import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { acquireProcessLock } from '../src/process-lock.js';
it('refuses a concurrent journal writer and releases exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'troia-lock-'));
  try {
    const release = acquireProcessLock(dir);
    expect(() => acquireProcessLock(dir)).toThrow('writer lock exists');
    release();
    release();
    const release2 = acquireProcessLock(dir);
    release2();
  } finally {
    rmSync(dir, { recursive: true });
  }
});

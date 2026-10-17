import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recoverDeadWriterLock } from '../../../scripts/recover-writer-lock.mjs';

describe('Linux service dead-writer recovery under flock', () => {
  function withLock(test: (dir: string, path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'troia-service-lock-'));
    const path = join(dir, 'writer.lock');
    try {
      test(dir, path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it('does not delete a live writer even on restart', () =>
    withLock((dir, path) => {
      writeFileSync(
        path,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
      expect(() => recoverDeadWriterLock(dir)).toThrow('still running');
      expect(existsSync(path)).toBe(true);
    }));
  it('only recovers a positively dead PID', () =>
    withLock((dir, path) => {
      writeFileSync(path, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString() }));
      expect(
        recoverDeadWriterLock(dir, {
          probe: () => {
            throw Object.assign(new Error('dead'), { code: 'ESRCH' });
          },
        }),
      ).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(recoverDeadWriterLock(dir)).toBe(false);
    }));
  it('keeps an owner whose liveness cannot be determined', () =>
    withLock((dir, path) => {
      writeFileSync(path, JSON.stringify({ pid: 12345, startedAt: new Date().toISOString() }));
      expect(() =>
        recoverDeadWriterLock(dir, {
          probe: () => {
            throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
          },
        }),
      ).toThrow('permission');
      expect(existsSync(path)).toBe(true);
    }));
  it('never guesses the owner of a malformed lock', () =>
    withLock((dir, path) => {
      writeFileSync(path, '{"pid":0}');
      expect(() => recoverDeadWriterLock(dir)).toThrow('Invalid writer');
      expect(existsSync(path)).toBe(true);
    }));
});

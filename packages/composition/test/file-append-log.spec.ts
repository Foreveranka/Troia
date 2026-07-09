import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDurableLogFailure } from '@troia/backend';
import { DurableLogCorruption, FileAppendLog, assertWritableDir } from '../src/file-append-log.js';

// The only place in the system that touches the filesystem. What is pinned here is the crash contract:
//   * a record is framed with its byte length AND a CRC, so a corrupted-but-newline-terminated record
//     (the power-loss zero-fill case) cannot be silently accepted the way newline-only framing would;
//   * a torn TAIL — an append that never finished — is dropped, healed, and REPORTED;
//   * a corrupt MIDDLE is fatal, because skipping it would renumber every later ledger entry;
//   * the first write failure poisons the log, which is what confines any partial write to the tail.

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'troia-log-'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FileAppendLog — round trip and durability', () => {
  it('replays exactly what was appended, in order, across a reopen', () => {
    const dir = tmp();
    const a = new FileAppendLog(dir, 'x.log');
    a.append('{"one":1}');
    a.append('{"two":2}');
    a.close();

    const b = new FileAppendLog(dir, 'x.log');
    expect(b.replay()).toEqual({ payloads: ['{"one":1}', '{"two":2}'], recovered: null });
  });

  it('a payload whose crc32 hex is shorter than 8 chars still verifies (the hex is zero-padded)', () => {
    // zlib.crc32('hello world') === 0xd4a1185 -> 7 hex chars. Unpadded, write and read would disagree.
    const dir = tmp();
    const log = new FileAppendLog(dir, 'x.log');
    log.append('hello world');
    expect(readFileSync(join(dir, 'x.log'), 'utf8')).toContain('0d4a1185|');
    expect(log.replay().payloads).toEqual(['hello world']);
  });

  it('a missing file replays as empty, without creating a phantom record', () => {
    const log = new FileAppendLog(tmp(), 'fresh.log');
    expect(log.replay()).toEqual({ payloads: [], recovered: null });
  });

  it('writes the whole record even when writeSync short-writes one byte at a time', () => {
    const dir = tmp();
    const real = fs.writeSync.bind(fs) as typeof fs.writeSync;
    const spy = vi
      .spyOn(fs, 'writeSync')
      .mockImplementation(((fd: number, buf: NodeJS.ArrayBufferView, off: number, _len: number) =>
        real(fd, buf, off, 1)) as unknown as typeof fs.writeSync);

    const log = new FileAppendLog(dir, 'x.log');
    log.append('{"a":1}');
    expect(spy.mock.calls.length).toBeGreaterThan(1); // it genuinely looped
    spy.mockRestore();

    expect(new FileAppendLog(dir, 'x.log').replay().payloads).toEqual(['{"a":1}']);
  });

  it('the first write failure poisons the log — no later append can put bytes after a partial one', () => {
    const dir = tmp();
    const log = new FileAppendLog(dir, 'x.log');
    log.append('{"good":1}');

    vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    expect(() => log.append('{"bad":1}')).toThrow('no space left');
    vi.restoreAllMocks();

    // even with a healthy disk again, the poisoned log refuses to write
    expect(() => log.append('{"after":1}')).toThrow(/poisoned/i);
    expect(readFileSync(join(dir, 'x.log'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('every write failure is recognisable to the pure packages as a durable-log failure', () => {
    // @troia/backend cannot import this module, so it identifies the failure by `code`. If that contract
    // silently drifts, a poisoned log stops being fail-stop and the workers retry into it forever.
    const dir = tmp();
    const log = new FileAppendLog(dir, 'x.log');

    vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    const first = (() => {
      try {
        log.append('{"a":1}');
      } catch (e) {
        return e;
      }
    })();
    vi.restoreAllMocks();
    const second = (() => {
      try {
        log.append('{"b":1}');
      } catch (e) {
        return e;
      }
    })();

    expect(isDurableLogFailure(first)).toBe(true); // the raw fs error is wrapped, not passed through
    expect(isDurableLogFailure(second)).toBe(true); // and so is the poisoned-log refusal
    expect((first as Error).cause).toBeDefined(); // the original ENOSPC/EIO is preserved for the operator
  });
});

describe('FileAppendLog — torn tail vs corrupt middle', () => {
  it('drops ONLY an unterminated torn tail, heals the file, and reports the loss', () => {
    const dir = tmp();
    const path = join(dir, 'x.log');
    const log = new FileAppendLog(dir, 'x.log');
    log.append('{"one":1}');
    log.append('{"two":2}');
    log.close();

    const whole = readFileSync(path);
    // simulate a crash mid-append: a strict prefix of a third record, never terminated
    writeFileSync(path, Buffer.concat([whole, Buffer.from('L9,deadbeef|{"thr')]));

    const reopened = new FileAppendLog(dir, 'x.log');
    const out = reopened.replay();
    expect(out.payloads).toEqual(['{"one":1}', '{"two":2}']);
    expect(out.recovered).toEqual({ droppedBytes: 17, atOffset: whole.length });
    // the file was healed, so the next append lands on a clean boundary
    reopened.append('{"three":3}');
    expect(new FileAppendLog(dir, 'x.log').replay()).toEqual({
      payloads: ['{"one":1}', '{"two":2}', '{"three":3}'],
      recovered: null,
    });
  });

  it('a newline-terminated record whose payload was corrupted is FATAL — never silently accepted', () => {
    const dir = tmp();
    const path = join(dir, 'x.log');
    const log = new FileAppendLog(dir, 'x.log');
    log.append('{"amount":"1000"}');
    log.append('{"amount":"2000"}');
    log.close();

    // flip a digit inside the FIRST record's payload. Same byte length, still valid JSON, newline intact —
    // exactly what newline-only framing would wave through. Only the CRC catches it.
    const buf = readFileSync(path);
    const at = buf.indexOf(Buffer.from('1000'));
    expect(at).toBeGreaterThan(0);
    buf[at] = '9'.charCodeAt(0);
    writeFileSync(path, buf);

    expect(() => new FileAppendLog(dir, 'x.log').replay()).toThrow(DurableLogCorruption);
    // and it did NOT truncate: a corrupt middle is a human's problem, not the log's to erase
    expect(readFileSync(path).length).toBe(buf.length);
  });

  it('flipping ONLY the last record terminator is fatal — a completed append is not a torn tail', () => {
    // The subtle one. The terminator is the one byte the payload CRC does not cover, so a discriminator that
    // asks "is there a newline after this point?" would see none, call it a crashed append, and TRUNCATE a
    // record that was fully written and fdatasync'd. That silently lowers the ledger's expected pool balance.
    const dir = tmp();
    const path = join(dir, 'x.log');
    const log = new FileAppendLog(dir, 'x.log');
    log.append('{"amount":"1000"}');
    log.append('{"amount":"2000"}');
    log.close();

    const buf = readFileSync(path);
    expect(buf[buf.length - 1]).toBe(0x0a);
    buf[buf.length - 1] = 'X'.charCodeAt(0);
    writeFileSync(path, buf);

    expect(() => new FileAppendLog(dir, 'x.log').replay()).toThrow(DurableLogCorruption);
    expect(readFileSync(path).length).toBe(buf.length); // and nothing was erased
  });

  it('a genuinely torn last record — payload complete, terminator never written — still heals', () => {
    const dir = tmp();
    const path = join(dir, 'x.log');
    const log = new FileAppendLog(dir, 'x.log');
    log.append('{"one":1}');
    log.close();
    const whole = readFileSync(path);

    // the crash landed exactly between the payload's last byte and its newline
    const frame = whole.subarray(0, whole.length); // a full record
    const tornPayloadOnly = frame.subarray(0, frame.length - 1); // same record, no LF
    writeFileSync(path, Buffer.concat([whole, tornPayloadOnly]));

    const out = new FileAppendLog(dir, 'x.log').replay();
    expect(out.payloads).toEqual(['{"one":1}']);
    expect(out.recovered).toEqual({ droppedBytes: tornPayloadOnly.length, atOffset: whole.length });
  });

  it('a payload containing a raw newline is rejected — the terminator must stay a true separator', () => {
    const log = new FileAppendLog(tmp(), 'x.log');
    expect(() => log.append('{"a":"line1\nline2"}')).toThrow(/newline/i);
  });

  it('a corrupt record with good records AFTER it is fatal even if it is the last written one', () => {
    const dir = tmp();
    const path = join(dir, 'x.log');
    const log = new FileAppendLog(dir, 'x.log');
    log.append('{"a":1}');
    log.close();
    // a fully terminated record whose CRC does not match: a completed append cannot be a torn tail
    const buf = readFileSync(path);
    const at = buf.indexOf(Buffer.from('{"a":1}'));
    buf[at + 5] = '9'.charCodeAt(0);
    writeFileSync(path, buf);
    expect(() => new FileAppendLog(dir, 'x.log').replay()).toThrow(DurableLogCorruption);
  });
});

describe('assertWritableDir — fail at boot, never on the first payout', () => {
  it('creates the dir 0o700 and leaves no probe file behind', () => {
    const dir = join(tmp(), 'nested', 'data');
    assertWritableDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('throws on an unwritable dir', () => {
    const dir = tmp();
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => assertWritableDir(join(dir, 'sub'))).toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('log files are created 0o600 — they carry signed envelopes and destinations', () => {
    const dir = tmp();
    new FileAppendLog(dir, 'x.log').append('{"a":1}');
    expect(statSync(join(dir, 'x.log')).mode & 0o777).toBe(0o600);
  });
});

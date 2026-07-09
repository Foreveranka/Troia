// The ONLY filesystem in the system. Everything upstream (@troia/ledger, @troia/backend) stays pure and takes a
// synchronous `append(payload)` port; this is the file behind it.
//
// FRAME:  L<payloadByteLen>,<crc32 as 8 lowercase hex>|<payload bytes>\n
//
// Why not plain JSON lines. The obvious replay rule — "if the file ends with a newline, every record is complete"
// — is WRONG. On a power cut, a filesystem can persist a record's size and its trailing newline while an interior
// data block is still zero-filled or stale. That yields a newline-terminated record that still parses as JSON, so
// a byte-flip inside an amount would be read back as a real number and silently poison the ledger's expected pool
// balance — the exact silent divergence the drift alarm exists to catch. The per-record CRC closes that hole; the
// length prefix lets the reader walk by offset instead of guessing at newlines.
//
// TORN TAIL vs CORRUPT MIDDLE. Every append writes its frame as one sequential buffer and fdatasyncs before
// returning, and a failed write POISONS the log so nothing is ever written after a partial record. So a crashed
// append can only ever leave a STRICT PREFIX of one frame at the physical end of the file.
//
// That gives the discriminator, and it must be stated carefully. It is NOT "is there a newline after this point?"
// — the terminator is the one byte the payload CRC does not cover, so flipping it on the LAST record would look
// exactly like a crash and a naive reader would truncate a fully-committed entry. Instead: a bad record is a torn
// tail only if its frame RUNS PAST END-OF-FILE (its header is itself incomplete, or the declared payload does not
// fit). If the frame fits — meaning the terminator's byte slot exists — the append finished, so anything wrong
// with it is corruption. Anything with a newline after it is corruption too, since a later append completed.
// Corruption is FATAL: skipping a middle record would renumber every later ledger entry into a different ledger.
// For the newline scan to mean what it says, a payload may not contain a raw newline; append() enforces that.
//
// DURABILITY, stated honestly. After append() returns, the record survives any process death — uncaught throw,
// exit(1), kill -9 — because the bytes are in the kernel's page cache, which outlives the process. The
// fdatasyncSync additionally pushes them toward stable media, so on Linux with a barrier-honouring device it also
// survives an OS crash or power loss. On macOS it does NOT: fsync/fdatasync there do not flush the drive's
// volatile write cache (only F_FULLFSYNC does, and Node ships no binding). The process-restart guarantee this
// step exists for holds on both.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { join } from 'node:path';

const LF = 0x0a;
const HEADER_START = 0x4c; // 'L'
const CRC_HEX_LEN = 8;
const PROBE_FILE = '.troia-write-probe';
/** fs.readFileSync hard-fails at 2 GiB. Stop a byte short of the cliff, with an explanation. */
const MAX_LOG_BYTES = 2 ** 31;

/** `code` is how the pure packages recognise a durable-log failure without importing this module: a write that
 *  fails means nothing downstream can be booked, so callers must fail fast rather than retry into a poisoned log. */
export const DURABLE_LOG_FAILURE = 'DurableLogFailure';

export class DurableLogError extends Error {
  readonly code: string = DURABLE_LOG_FAILURE;
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'DurableLogError';
  }
}

/** A record whose bytes are intact enough to be terminated, but which does not verify. Never auto-healed. */
export class DurableLogCorruption extends DurableLogError {
  override readonly code = 'DurableLogCorruption';
  constructor(
    readonly path: string,
    readonly atOffset: number,
    reason: string,
  ) {
    super(`${path}: corrupt record at byte ${atOffset} (${reason}) — refusing to start`);
    this.name = 'DurableLogCorruption';
  }
}

/** `zlib.crc32` returns a NUMBER whose hex is unpadded (crc32('hello world') -> 'd4a1185', 7 chars). Both sides
 *  must pad, or a perfectly good record reads as corrupt. */
function crcHex(body: Buffer): string {
  return zlib.crc32(body).toString(16).padStart(CRC_HEX_LEN, '0');
}

export interface ReplayResult {
  readonly payloads: readonly string[];
  /** Non-null when a crashed, unterminated append was found and healed. The caller MUST surface it. */
  readonly recovered: { readonly droppedBytes: number; readonly atOffset: number } | null;
}

/**
 * Prove at BOOT that the data directory is usable. Without this, the first failure surfaces inside the
 * `handToReconciler` effect — i.e. after the USDC has already left the pool — which is the worst possible moment
 * to discover a read-only disk. Creates the directory (0o700) and round-trips a probe file through fdatasync.
 */
export function assertWritableDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const probe = join(dir, PROBE_FILE);
  try {
    const fd = fs.openSync(probe, 'w', 0o600);
    try {
      const sentinel = Buffer.from('troia\n');
      let off = 0;
      while (off < sentinel.length) off += fs.writeSync(fd, sentinel, off, sentinel.length - off);
      fs.fdatasyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.readFileSync(probe).toString('utf8') !== 'troia\n') {
      throw new DurableLogError(`${dir}: write probe did not round-trip`);
    }
  } finally {
    // The probe exists to exercise the ENOSPC/EIO path, so its cleanup has to survive that path too.
    try {
      fs.unlinkSync(probe);
    } catch {
      // never created, or already gone
    }
  }
}

export class FileAppendLog {
  readonly path: string;
  private readonly fd: number;
  private poisoned = false;
  private closed = false;

  constructor(dir: string, filename: string) {
    // Flag 'a' does NOT create parent directories: it fails ENOENT. Create first.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, filename);
    const preexisted = fs.existsSync(this.path);
    this.fd = fs.openSync(this.path, 'a', 0o600); // O_WRONLY|O_APPEND|O_CREAT
    fs.chmodSync(this.path, 0o600); // umask masks the create mode; these bytes hold signed envelopes
    if (!preexisted) {
      // Make the new directory entry itself durable. Later appends only grow the file, which fdatasync covers.
      try {
        const dfd = fs.openSync(dir, 'r');
        fs.fsyncSync(dfd);
        fs.closeSync(dfd);
      } catch {
        // some platforms refuse to fsync a directory handle; the file sync below is still the load-bearing one
      }
    }
  }

  /** Durable on normal return. Throws — and poisons the log forever — on any I/O failure. */
  append(payload: string): void {
    if (this.poisoned) {
      throw new DurableLogError(`${this.path}: log is poisoned by an earlier write failure`);
    }
    if (this.closed) throw new DurableLogError(`${this.path}: log is closed`);
    // The terminator has to remain a true record separator: replay's torn-tail scan asks whether any newline
    // follows a bad record, and a payload carrying one would make a crashed append look like corruption.
    // Both producers encode with JSON.stringify, which escapes newlines, so this only catches a programming error.
    if (payload.includes('\n')) {
      throw new DurableLogError(`${this.path}: a payload may not contain a raw newline`);
    }
    const body = Buffer.from(payload, 'utf8');
    const line = Buffer.concat([
      Buffer.from(`L${body.length},${crcHex(body)}|`, 'utf8'),
      body,
      Buffer.from([LF]),
    ]);
    try {
      // `fs.writeSync` issues ONE write(2) and returns a byte count — it does not loop. A short write (possible
      // under ENOSPC or on a signal) would silently truncate the record, so loop until the buffer is out.
      let off = 0;
      while (off < line.length) off += fs.writeSync(this.fd, line, off, line.length - off);
      // fdatasync, not fsync: an append changes data + file size, and that is exactly what fdatasync flushes.
      fs.fdatasyncSync(this.fd);
    } catch (e) {
      // A failed write may have persisted a prefix. Poisoning guarantees nothing is ever appended after it, so
      // the damage stays the physical tail — which replay can safely drop. Without this, the next retry would
      // write a good record after the partial one, manufacturing a corrupt MIDDLE that bricks the next boot.
      // Rethrow as a DurableLogError so callers can recognise "nothing can be booked any more" without importing
      // this module, and fail fast instead of retrying forever into a log that will never accept another byte.
      this.poisoned = true;
      const reason = e instanceof Error ? e.message : String(e);
      throw new DurableLogError(`${this.path}: durable append failed: ${reason}`, { cause: e });
    }
  }

  /** Read the whole log. Heals a torn tail (reporting it); throws on anything else. */
  replay(): ReplayResult {
    // `fs.readFileSync` refuses anything at or above 2 GiB, and nothing here rotates or compacts (a stated
    // non-goal). Say so out loud rather than letting the boot die on a cryptic ERR_FS_FILE_TOO_LARGE: at the
    // record sizes involved this is millions of payouts away, but a silent cliff is not a limit, it is a trap.
    let size = 0;
    try {
      size = fs.statSync(this.path).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { payloads: [], recovered: null };
      throw e;
    }
    if (size >= MAX_LOG_BYTES) {
      throw new DurableLogError(
        `${this.path}: ${size} bytes exceeds the ${MAX_LOG_BYTES}-byte whole-file replay limit — the log needs ` +
          `compaction before this process can start (there is no rotation yet)`,
      );
    }

    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { payloads: [], recovered: null };
      throw e;
    }

    const payloads: string[] = [];
    let cursor = 0;
    while (cursor < buf.length) {
      const parsed = this.readRecord(buf, cursor);
      if (parsed === null) return this.handleBadRecord(buf, cursor, payloads);
      payloads.push(parsed.payload);
      cursor = parsed.next;
    }
    return { payloads, recovered: null };
  }

  /** The frame header at `start`, or null when the header itself is incomplete or malformed. Parsing the header
   *  says nothing about whether the payload or the terminator made it to disk — only where they would be. */
  private parseHeader(
    buf: Buffer,
    start: number,
  ): { payloadStart: number; payloadEnd: number; crc: string } | null {
    if (buf[start] !== HEADER_START) return null;
    const comma = buf.indexOf(0x2c, start + 1); // ','
    const bar = buf.indexOf(0x7c, start + 1); // '|'
    if (comma === -1 || bar === -1 || comma >= bar) return null;
    const lenText = buf.subarray(start + 1, comma).toString('utf8');
    if (!/^[0-9]+$/.test(lenText)) return null;
    if (bar - comma - 1 !== CRC_HEX_LEN) return null;
    const crc = buf.subarray(comma + 1, bar).toString('utf8');
    if (!/^[0-9a-f]{8}$/.test(crc)) return null;
    const payloadStart = bar + 1;
    return { payloadStart, payloadEnd: payloadStart + Number(lenText), crc };
  }

  /** One framed record at `start`, or null if it is malformed/incomplete for any reason. */
  private readRecord(buf: Buffer, start: number): { payload: string; next: number } | null {
    const h = this.parseHeader(buf, start);
    if (h === null) return null;
    if (h.payloadEnd >= buf.length) return null; // truncated mid-payload, or no room for the terminator
    if (buf[h.payloadEnd] !== LF) return null;
    const body = buf.subarray(h.payloadStart, h.payloadEnd);
    if (crcHex(body) !== h.crc) return null;
    return { payload: body.toString('utf8'), next: h.payloadEnd + 1 };
  }

  /**
   * The discriminator, stated so it is sound. A crashed append leaves a strict PREFIX of one frame at the end of
   * the file, so a torn tail must (a) have nothing after it — no append completed later — and (b) declare a frame
   * that runs past end-of-file, either because its own header is truncated or because the payload plus its
   * terminator do not fit. If the frame fits, the terminator's byte slot exists, which means the append finished:
   * whatever is wrong with the record happened afterwards. That is corruption, and truncating it would silently
   * erase a committed entry — precisely the byte the CRC cannot protect, since the CRC covers only the payload.
   */
  private handleBadRecord(buf: Buffer, badStart: number, payloads: string[]): ReplayResult {
    if (buf.indexOf(LF, badStart) !== -1) {
      throw new DurableLogCorruption(
        this.path,
        badStart,
        'a later record completed after this one',
      );
    }
    const h = this.parseHeader(buf, badStart);
    if (h !== null && h.payloadEnd < buf.length) {
      throw new DurableLogCorruption(
        this.path,
        badStart,
        'the frame fits in the file, so the append completed — this record was corrupted after it was written',
      );
    }
    const droppedBytes = buf.length - badStart;
    fs.ftruncateSync(this.fd, badStart);
    fs.fdatasyncSync(this.fd);
    return { payloads, recovered: { droppedBytes, atOffset: badStart } };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
  }
}

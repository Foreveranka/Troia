import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A structural guard: EVERY network call in the dirty adapters must be bounded by withTimeout, so a hung RPC /
// Horizon socket can never wedge the poll loop (net-timeout.ts). The adapters are network:true and not exercised
// by the offline suite, so this source-level invariant is the offline proof that the wiring is present and stays
// present (a future bare `this.server.foo()` regresses this test). Comments are stripped so prose mentioning a
// call can't satisfy or break the count, and whitespace is collapsed so the guard tracks the CODE, not the
// formatter — a line-wrap inside `withTimeout(...)` must not read as an unwrapped call.

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
const read = (f: string): string => readFileSync(join(srcDir, f), 'utf8');
const collapse = (src: string): string => stripComments(src).replace(/\s+/g, '');
const count = (s: string, sub: string): number => s.split(sub).length - 1;

describe('adapter network reads are bounded by withTimeout (no unwedgeable hang)', () => {
  for (const f of ['rpc-adapter.ts', 'horizon-adapter.ts']) {
    it(`${f} wraps EVERY this.server.<call> in withTimeout`, () => {
      expect(read(f), `${f} must import withTimeout`).toContain("from './net-timeout.js'");
      const src = collapse(read(f));
      // `this.server.` (trailing dot) matches only METHOD accesses; the constructor assignment is `this.server =`.
      const calls = count(src, 'this.server.');
      expect(calls, `${f} should make at least one server call`).toBeGreaterThan(0);
      expect(count(src, 'withTimeout(this.server.'), `${f} has an unwrapped server call`).toBe(
        calls,
      );
    });
  }
});

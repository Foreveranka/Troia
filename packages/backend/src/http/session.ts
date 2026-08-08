// C-13: the /intent session gate. POST /session mints a short-lived HMAC-signed token; POST /intent requires
// one and counts accepted orders against a PER-SESSION budget — so the reservation-exhaustion cost is keyed on
// something the server issued, not on the caller's self-chosen IP (per-IP caps stay as the outer layer, but an
// XFF-spoofing or rotating-IP caller can no longer rotate the only key that matters).
//
// Stateless verification, stateful budget. The token carries {sid, exp} and proves itself by HMAC — no session
// store to fill, and a restart invalidates nothing durable (clients just re-fetch on 401; the secret may even
// be per-boot random). The budget is in-memory and process-local ON PURPOSE: it guards AVAILABILITY, not money
// — every money decision stays with reserve()/PayoutIntent.build — so losing counts on restart is acceptable,
// and a durable count would only add a write to the hot path for an availability heuristic.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Default session lifetime. Long enough for a human checkout with retries; short enough that a leaked token
 *  is a small prize. */
export const DEFAULT_SESSION_TTL_SECS = 900;
/** Default accepted-order budget per session. An honest checkout starts ONE order (plus the odd retry with a
 *  fresh orderId after a decline); a script farming reservations burns a session every few orders. */
export const DEFAULT_SESSION_MAX_INTENTS = 5;

export interface SessionClaims {
  readonly sid: string;
  readonly expUnix: number;
}

function hmac(secret: string, payloadB64: string): Buffer {
  return createHmac('sha256', secret).update(payloadB64).digest();
}

/** Mint a token: base64url(payload).base64url(hmac). The payload is public; the HMAC is the proof. */
export function mintSessionToken(
  secret: string,
  nowUnix: number,
  ttlSecs: number,
): { token: string; claims: SessionClaims } {
  const claims: SessionClaims = {
    sid: randomBytes(16).toString('hex'),
    expUnix: nowUnix + ttlSecs,
  };
  const payloadB64 = Buffer.from(JSON.stringify({ sid: claims.sid, exp: claims.expUnix })).toString(
    'base64url',
  );
  const sigB64 = hmac(secret, payloadB64).toString('base64url');
  return { token: `${payloadB64}.${sigB64}`, claims };
}

/** Verify fail-closed: null on ANY defect (shape, signature, expiry) — the caller answers one uniform 401 and
 *  never learns which check failed. Signature first, via timingSafeEqual. */
export function verifySessionToken(
  secret: string,
  token: string,
  nowUnix: number,
): SessionClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return null;
  const payloadB64 = token.slice(0, dot);
  const expected = hmac(secret, payloadB64);
  let provided: Buffer;
  try {
    provided = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { sid, exp } = raw as Record<string, unknown>;
  if (typeof sid !== 'string' || sid.length === 0 || !Number.isSafeInteger(exp)) return null;
  if ((exp as number) <= nowUnix) return null; // expired — a fresh /session is one round-trip away
  return { sid, expUnix: exp as number };
}

/**
 * The per-session accepted-order counter. `take` consumes one unit and reports whether the session still had
 * budget; the map self-prunes expired sessions opportunistically so an attacker minting sessions cannot grow
 * it without bound past the TTL horizon.
 */
export class SessionBudget {
  private readonly counts = new Map<string, { used: number; expUnix: number }>();

  constructor(private readonly maxIntents: number) {}

  take(claims: SessionClaims, nowUnix: number): boolean {
    this.prune(nowUnix);
    const row = this.counts.get(claims.sid) ?? { used: 0, expUnix: claims.expUnix };
    if (row.used >= this.maxIntents) return false;
    row.used += 1;
    this.counts.set(claims.sid, row);
    return true;
  }

  private prune(nowUnix: number): void {
    for (const [sid, row] of this.counts) {
      if (row.expUnix <= nowUnix) this.counts.delete(sid);
    }
  }
}

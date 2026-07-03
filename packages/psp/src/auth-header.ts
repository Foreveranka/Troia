// PURE reimplementation of iyzico's IYZWSv2 request authentication (verified byte-for-byte against
// iyzipay@2.0.69 utils.generateHashV2/generateAuthorizationHeaderV2). Reimplemented — not delegated to the
// SDK — so the exact prod signer is the one we unit-test, with zero prod/test divergence and no runtime SDK
// dependency. randomKey is INJECTED (the adapter supplies crypto.randomBytes), keeping this deterministic
// and offline-testable.
//
// signature = HMAC_SHA256(secretKey, randomKey + uriPath + requestBodyString) as lowercase hex.
// header    = 'IYZWSv2 ' + base64('apiKey:'+apiKey + '&randomKey:'+randomKey + '&signature:'+signature).
//
// HARD INVARIANT (sign-the-sent-string): requestBodyString MUST be byte-identical to the JSON actually sent
// as the HTTP body. The request builders emit the object AND its canonical JSON string exactly once; the
// adapter signs that string and sends that string. Never re-stringify a re-ordered object — the HMAC would
// silently mismatch and iyzico returns a generic failure.

import { createHmac } from 'node:crypto';

export const IYZWS_HEADER_SCHEME = 'IYZWSv2';
const SEPARATOR = ':';
/** Sent as x-iyzi-client-version alongside the Authorization header (matches the pinned SDK contract). */
export const IYZICO_CLIENT_VERSION = 'iyzipay-node-2.0.69';

export interface AuthHeaderInput {
  readonly apiKey: string;
  readonly secretKey: string;
  /** request PATH only — e.g. /payment/preauth. No base URL, no query string. */
  readonly uriPath: string;
  /** the EXACT JSON string sent as the HTTP body. */
  readonly requestBodyString: string;
  /** injected per-request entropy (adapter: crypto.randomBytes hex). */
  readonly randomKey: string;
}

export interface AuthHeaders {
  readonly authorization: string;
  readonly xIyziRnd: string;
  readonly xIyziClientVersion: string;
}

export function computeAuthorizationHeader(input: AuthHeaderInput): AuthHeaders {
  const signature = createHmac('sha256', input.secretKey)
    .update(input.randomKey + input.uriPath + input.requestBodyString)
    .digest('hex');

  const authParams = [
    'apiKey' + SEPARATOR + input.apiKey,
    'randomKey' + SEPARATOR + input.randomKey,
    'signature' + SEPARATOR + signature,
  ].join('&');

  return {
    authorization: IYZWS_HEADER_SCHEME + ' ' + Buffer.from(authParams).toString('base64'),
    xIyziRnd: input.randomKey,
    xIyziClientVersion: IYZICO_CLIENT_VERSION,
  };
}

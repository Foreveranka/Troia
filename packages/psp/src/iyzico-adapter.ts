// DIRTY concrete PaymentProvider over raw HTTPS (global fetch) + our PURE IYZWSv2 signer. The unit-tested
// signer IS the prod signer (zero prod/test divergence); we don't depend on the iyzipay SDK client at
// runtime. This is the SOLE holder of the credentials and the SOLE source of per-request entropy (randomKey).
// It NEVER returns a success-looking value on failure: a transport error / non-2xx / unparseable body maps
// to { kind:'timeout' } / { kind:'malformed' }, which classify reads as UNKNOWN. Zero money-branching here.
// network:true — excluded from the offline suite; type-checked now, live-smoked once creds exist (Phase 4.5).

import { randomBytes } from 'node:crypto';
import { computeAuthorizationHeader } from './auth-header.js';
import type { RawIyzicoResult } from './outcomes.js';
import type { PaymentProvider, PspNetworkConfig, PspSecrets } from './ports.js';
import {
  buildCancelRequest,
  buildInitializeCheckoutFormRequest,
  buildPostAuthRequest,
  buildPreAuthRequest,
  buildRefundRequest,
  buildRetrieveCheckoutFormRequest,
} from './request-builders.js';
import type { BuiltRequest } from './request-builders.js';
import type {
  CancelParams,
  InitializeCheckoutFormParams,
  PostAuthParams,
  PreAuthParams,
  RefundParams,
  RetrieveCheckoutFormParams,
} from './request-builders.js';

export class IyzicoSandboxProvider implements PaymentProvider {
  constructor(
    private readonly config: PspNetworkConfig,
    private readonly secrets: PspSecrets,
  ) {}

  private async post(req: BuiltRequest): Promise<RawIyzicoResult> {
    const randomKey = randomBytes(16).toString('hex');
    const auth = computeAuthorizationHeader({
      apiKey: this.secrets.apiKey,
      secretKey: this.secrets.secretKey,
      uriPath: req.path,
      requestBodyString: req.json, // sign-the-sent-string: hash and send the SAME string
      randomKey,
    });

    let res: Response;
    try {
      res = await fetch(this.config.baseUrl + req.path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: auth.authorization,
          'x-iyzi-rnd': auth.xIyziRnd,
          'x-iyzi-client-version': auth.xIyziClientVersion,
        },
        body: req.json,
      });
    } catch {
      return { kind: 'timeout' }; // DNS / connection reset / network failure -> UNKNOWN downstream
    }

    if (!res.ok) return { kind: 'malformed', reason: `http ${res.status}` };

    let text: string;
    try {
      text = await res.text();
    } catch {
      return { kind: 'timeout' };
    }

    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object') {
        return { kind: 'malformed', reason: 'response body is not a JSON object' };
      }
      return { kind: 'body', body: parsed as Readonly<Record<string, unknown>> };
    } catch {
      return { kind: 'malformed', reason: 'unparseable JSON body' };
    }
  }

  initializeCheckoutForm(p: InitializeCheckoutFormParams): Promise<RawIyzicoResult> {
    return this.post(buildInitializeCheckoutFormRequest(p));
  }
  retrieveCheckoutFormResult(p: RetrieveCheckoutFormParams): Promise<RawIyzicoResult> {
    return this.post(buildRetrieveCheckoutFormRequest(p));
  }
  createPreAuth(p: PreAuthParams): Promise<RawIyzicoResult> {
    return this.post(buildPreAuthRequest(p));
  }
  createPostAuth(p: PostAuthParams): Promise<RawIyzicoResult> {
    return this.post(buildPostAuthRequest(p));
  }
  refund(p: RefundParams): Promise<RawIyzicoResult> {
    return this.post(buildRefundRequest(p));
  }
  cancel(p: CancelParams): Promise<RawIyzicoResult> {
    return this.post(buildCancelRequest(p));
  }
}

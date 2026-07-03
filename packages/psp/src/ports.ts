// The PaymentProvider port + the (secret-free) network config and the injected secrets. Every method
// returns a RawIyzicoResult (a parsed body or a transport marker) — NEVER a pre-judged success — so all
// money classification runs in the pure core (classify.ts), never in the adapter. Mirrors stellar-client's
// ports.ts (interfaces only; the concrete IyzicoSandboxProvider is the dirty seam).

import type { RawIyzicoResult } from './outcomes.js';
import type {
  CancelParams,
  InitializeCheckoutFormParams,
  PostAuthParams,
  PreAuthParams,
  RefundParams,
  RetrieveCheckoutFormParams,
} from './request-builders.js';

/** Non-secret, from NetworkConfig.psp (baseUrl only). */
export interface PspNetworkConfig {
  readonly baseUrl: string;
}

/** Injected at the composition root from env — NEVER from NetworkConfig. The account secretKey is both the
 *  request-auth HMAC key and the webhook-signature key; webhookSigningSecret defaults to it (Phase 4.5
 *  confirms whether activation issues a distinct key). */
export interface PspSecrets {
  readonly apiKey: string;
  readonly secretKey: string;
  readonly webhookSigningSecret: string;
}

export interface PaymentProvider {
  initializeCheckoutForm(p: InitializeCheckoutFormParams): Promise<RawIyzicoResult>;
  retrieveCheckoutFormResult(p: RetrieveCheckoutFormParams): Promise<RawIyzicoResult>;
  createPreAuth(p: PreAuthParams): Promise<RawIyzicoResult>;
  createPostAuth(p: PostAuthParams): Promise<RawIyzicoResult>;
  refund(p: RefundParams): Promise<RawIyzicoResult>;
  cancel(p: CancelParams): Promise<RawIyzicoResult>;
}

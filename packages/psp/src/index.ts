// Public surface of @troia/psp. Exports the pure core (money-safety classifier, webhook verifier, IYZWSv2
// signer, request builders, response projectors, port + config types) + the createPaymentProvider factory.
// The concrete IyzicoSandboxProvider is NOT re-exported (it holds creds + fetch) — the backend constructs it
// via createPaymentProvider at the composition root, so no secret-bearing class crosses this surface.

export { classifyIyzicoResult, TERMINAL_DECLINE_WHITELIST, preauthEvent, captureEvent, voidEvent } from './classify.js';
export type { PreauthEvent, CaptureEvent, VoidEvent } from './classify.js';

export { verifyWebhookSignature } from './verify-webhook.js';
export type { WebhookEvent, VerifyWebhookInput } from './verify-webhook.js';

export { computeAuthorizationHeader, IYZWS_HEADER_SCHEME, IYZICO_CLIENT_VERSION } from './auth-header.js';
export type { AuthHeaderInput, AuthHeaders } from './auth-header.js';

export {
  formatPrice,
  buildInitializeCheckoutFormRequest,
  buildRetrieveCheckoutFormRequest,
  buildPreAuthRequest,
  buildPostAuthRequest,
  buildRefundRequest,
  buildCancelRequest,
} from './request-builders.js';
export type {
  BuiltRequest,
  InitializeCheckoutFormParams,
  RetrieveCheckoutFormParams,
  PreAuthParams,
  PostAuthParams,
  RefundParams,
  CancelParams,
} from './request-builders.js';

export {
  projectCheckoutFormInit,
  projectCheckoutFormResult,
  projectPayment,
} from './response-projectors.js';

export type {
  IyzicoClass,
  PspOp,
  RawIyzicoResult,
  Projection,
  CheckoutFormInitFields,
  CheckoutFormResultFields,
  PaymentFields,
} from './outcomes.js';

export type { Locale, Buyer, Address, BasketItem, PaymentCard } from './types.js';
export type { PaymentProvider, PspNetworkConfig, PspSecrets } from './ports.js';

export { PspBuildError, IyzicoResponseParseError, WebhookVerificationError } from './errors.js';

export { createPaymentProvider } from './factory.js';

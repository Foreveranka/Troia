// The 3-valued money-safety vocabulary + the raw-result ADT the adapter projects. The whole package is
// built around IyzicoClass: never assert SUCCESS on ambiguity (would send USDC for an uncaptured charge)
// and never assert FAILURE on a payment we cannot prove failed (would void a possibly-live TRY hold).

/** The single money-safety verdict. UNKNOWN is the safe default — it drives observe/retry/reconcile,
 *  NEVER an irreversible action. */
export type IyzicoClass = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

/** Which operation a result belongs to — the SUCCESS/FAILURE shape differs per op. 'sale' is the money-first
 *  direct charge (immediate capture, no preauth); 'preauth'/'capture' are retained for the legacy shapes. */
export type PspOp = 'preauth' | 'capture' | 'void' | 'refund' | 'checkout' | 'sale';

/** What the adapter hands the pure core: a parsed iyzico JSON body, or a transport-level failure marker.
 *  A timeout / non-2xx / DNS failure / unparseable body is NEVER a success-looking value — it is a marker
 *  that classify reads as UNKNOWN. The adapter does no money-branching; all classification is pure. */
export type RawIyzicoResult =
  | { readonly kind: 'body'; readonly body: Readonly<Record<string, unknown>> }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'malformed'; readonly reason: string };

/** Projected happy-path fields for the NEXT step (adapter success path). A projector returns `malformed`
 *  rather than fabricating a field, so a missing/mistyped value can never masquerade as a real one. */
export type Projection<T> = ({ readonly kind: 'ok' } & T) | { readonly kind: 'malformed'; readonly reason: string };

export interface CheckoutFormInitFields {
  readonly token: string;
  readonly checkoutFormContent: string;
  readonly conversationId: string;
}
export interface CheckoutFormResultFields {
  readonly token: string;
  readonly paymentId: string;
  readonly paymentStatus: string;
  readonly conversationId: string;
}
export interface PaymentFields {
  readonly paymentId: string;
  readonly conversationId: string;
}

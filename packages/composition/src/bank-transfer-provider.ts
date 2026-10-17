import type {
  BankTransferProvider,
  BankTransferInstructions,
  BankTransferRequest,
  BankTransferObservation,
} from '@troia/backend';
import { parseBankInstructions } from '@troia/backend';

export interface BankApiConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly providerId: string;
}

/** Troia's private bridge protocol, not a claimed Onramp/BiLira API.
 * The eventual provider adapter implements this contract; credentials never reach the extension. */
export class HttpBankTransferProvider implements BankTransferProvider {
  private readonly baseUrl: string;
  constructor(
    private readonly config: BankApiConfig,
    private readonly doFetch: typeof fetch = fetch,
  ) {
    const url = new URL(config.baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      config.apiKey.trim().length === 0 ||
      config.providerId.trim().length === 0
    )
      throw new Error('Invalid bank transfer API configuration');
    this.baseUrl = url.href.replace(/\/$/, '');
  }

  private async request(
    path: string,
    method: string,
    body?: unknown,
    key?: string,
  ): Promise<unknown> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error('Bank provider unavailable');
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('Bank provider returned no body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 64 * 1024) throw new Error('Bank provider response too large');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  async create(input: BankTransferRequest): Promise<BankTransferInstructions> {
    const result = parseBankInstructions(
      await this.request('/transfers', 'POST', input, input.idempotencyKey),
    );
    if (result.providerId !== this.config.providerId) throw new Error('Bank provider mismatch');
    return result;
  }

  async retrieve(expected: BankTransferInstructions): Promise<BankTransferObservation> {
    if (expected.providerId !== this.config.providerId) throw new Error('Bank provider mismatch');
    const result = await this.request(
      `/transfers/${encodeURIComponent(expected.transferId)}`,
      'GET',
    );
    if (typeof result !== 'object' || result === null) throw new Error('Invalid bank observation');
    // The backend's exact matcher is the payout gate, including missing/unknown fields.
    return result as BankTransferObservation;
  }

  async refund(expected: BankTransferInstructions): Promise<'refunded' | 'pending'> {
    if (expected.providerId !== this.config.providerId) return 'pending';
    const raw = await this.request(
      `/transfers/${encodeURIComponent(expected.transferId)}/refund`,
      'POST',
      { orderId: expected.orderId, amountTry: expected.amountTry, currency: 'TRY' },
      `refund:${expected.transferId}`,
    );
    if (typeof raw !== 'object' || raw === null) return 'pending';
    const o = raw as Record<string, unknown>;
    return o.status === 'refunded' &&
      o.providerId === expected.providerId &&
      o.transferId === expected.transferId &&
      o.orderId === expected.orderId &&
      o.amountTry === expected.amountTry &&
      o.currency === 'TRY'
      ? 'refunded'
      : 'pending';
  }
}

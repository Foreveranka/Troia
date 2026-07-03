// Typed error taxonomy. No error here carries a secret or raw card data. Mirrors stellar-client/errors.ts.

export class PspBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PspBuildError';
  }
}

export class IyzicoResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IyzicoResponseParseError';
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

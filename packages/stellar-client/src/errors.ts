// Typed error taxonomy so every caller fails closed. The reconciler owns evidence errors; the
// stellar-client owns the build/simulate/submit/deadness path. No error here carries a secret.

export class BuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildError';
  }
}

export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationError';
  }
}

export class SubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmitError';
  }
}

/** Raised only when deadness cannot be decided from authoritative reads — the caller must fail closed
 *  (hand to human review / reconciler), never a blind resubmit. */
export class DeadnessIndeterminate extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadnessIndeterminate';
  }
}

// A dead-letter marker: an unmapped (state,event) pair reached the driver, or an effect ran with a required
// ctx field absent (a broken flow, never a normal outcome). It is thrown, not returned — the driver never
// swallows it, so a structural bug surfaces loudly instead of silently moving (or not moving) money.
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

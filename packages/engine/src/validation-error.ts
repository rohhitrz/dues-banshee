/** Thrown when a public engine function receives invalid input. */
export class ValidationError extends Error {
  readonly field: string;
  readonly reason: string;
  readonly value?: unknown;

  constructor(field: string, reason: string, value?: unknown) {
    super(`${field}: ${reason}`);
    this.name = "ValidationError";
    this.field = field;
    this.reason = reason;
    if (value !== undefined) {
      this.value = value;
    }
  }
}

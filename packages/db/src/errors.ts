/** Thrown by `getSupplier` when no supplier has the requested id. */
export class SupplierNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupplierNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown by `getBankRate` when no bank-rate row is effective on or before the requested date. */
export class BankRateNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankRateNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

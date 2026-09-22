export class PiContextCompatibilityError extends Error {
  readonly kind = "PiContextCompatibilityError";

  constructor(message: string) {
    super(message);
    this.name = "PiContextCompatibilityError";
  }
}

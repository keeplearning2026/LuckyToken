export class InvalidRequest extends Error {
  readonly kind = "InvalidRequest";

  constructor(message: string) {
    super(message);
    this.name = "InvalidRequest";
  }
}

export class UnsupportedFeature extends Error {
  readonly kind = "UnsupportedFeature";

  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFeature";
  }
}

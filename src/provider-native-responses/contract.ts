import type { AuthResult, FetchFunction, Model } from "@earendil-works/pi-ai";

export type ProviderResponsesOperation = "responses" | "compact";

export class ProviderResponsesNetworkError extends Error {
  constructor(cause: unknown) {
    super("Provider native fetch failed", { cause });
    this.name = "ProviderResponsesNetworkError";
  }
}

export type ProviderResponsesLaneInput = {
  readonly model: Model<string>;
  readonly rawBody: string;
  readonly signal: AbortSignal;
} & (
  | {
      readonly operation: "responses";
      readonly sessionId: string;
    }
  | {
      readonly operation: "compact";
    }
);

export interface ProviderResponsesLane {
  claims(model: Model<string>, operation: ProviderResponsesOperation): boolean;
  execute(input: ProviderResponsesLaneInput): Promise<Response>;
}

export interface ProviderResponsesSender {
  readonly supportsNativeCompact: boolean;
  send(
    operation: ProviderResponsesOperation,
    rawBody: string,
    signal: AbortSignal,
  ): Promise<Response>;
}

export interface CreateProviderResponsesSenderOptions {
  readonly model: Model<string>;
  readonly auth: AuthResult;
  readonly fetch: FetchFunction;
  readonly sessionId?: string;
}

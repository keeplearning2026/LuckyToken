import type { AuthResult, FetchFunction, Model } from "@earendil-works/pi-ai";

export type ProviderResponsesOperation = "responses" | "compact";

export interface ProviderResponsesLane {
  claims(model: Model<string>, operation: ProviderResponsesOperation): boolean;
  execute(input: {
    readonly model: Model<string>;
    readonly rawBody: string;
    readonly request: Request;
    readonly operation: ProviderResponsesOperation;
  }): Promise<Response>;
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
  readonly forwardedHeaders?: Readonly<Record<string, string>>;
}
